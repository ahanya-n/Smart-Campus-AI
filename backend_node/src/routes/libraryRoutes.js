const express = require('express');
const { ObjectId } = require('mongodb');

const MAX_ACTIVE_LOANS = 5;
const LOAN_PERIOD_DAYS = 14;
const BOOK_ID_PATTERN = /^[a-f\d]{24}$/i;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bookOutput(book) {
  return {
    id: String(book._id),
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    category: book.category,
    total_copies: book.total_copies,
    available_copies: book.available_copies,
  };
}

function loanOutput(loan) {
  return {
    id: String(loan._id),
    book_id: String(loan.book_id),
    book_title: loan.book_title,
    book_isbn: loan.book_isbn,
    status: loan.status,
    borrowed_at: loan.borrowed_at,
    due_at: loan.due_at,
    returned_at: loan.returned_at || null,
  };
}

function validateBook(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  for (const [field, max] of [['title', 160], ['author', 120], ['isbn', 30], ['category', 60]]) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > max) {
      return `${field} is required and must be no more than ${max} characters`;
    }
  }
  if (!Number.isInteger(body.total_copies) || body.total_copies < 1 || body.total_copies > 10000) {
    return 'total_copies must be an integer between 1 and 10000';
  }
  return null;
}

function createLibraryRouter({
  authenticate,
  requireRoles,
  getBooksCollection,
  getBookLoansCollection,
}) {
  const router = express.Router();
  const adminOnly = requireRoles('admin');
  let indexesReady;

  async function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = (async () => {
        const books = await getBooksCollection();
        const loans = await getBookLoansCollection();
        await Promise.all([
          books.createIndex(
            { isbn: 1 },
            { name: 'isbn_unique', unique: true, partialFilterExpression: { isbn: { $type: 'string' } } },
          ),
          loans.createIndex(
            { user_id: 1, borrowing_slot: 1 },
            { name: 'library_active_borrowing_slot_unique', unique: true, partialFilterExpression: { status: 'borrowed', borrowing_slot: { $type: 'int' } } },
          ),
          loans.createIndex({ user_id: 1, borrowed_at: -1 }, { name: 'library_user_history' }),
        ]);
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    await indexesReady;
  }

  async function restoreCopy(books, bookId) {
    const restored = await books.updateOne(
      { _id: bookId, $expr: { $lt: ['$available_copies', '$total_copies'] } },
      { $inc: { available_copies: 1 } },
    );
    if (restored.matchedCount !== 1) {
      throw new Error('Could not restore the reserved library copy.');
    }
  }

  router.get('/books', authenticate, async (request, response, next) => {
    const search = request.query.search;
    if (search !== undefined && (typeof search !== 'string' || search.length > 100)) {
      return response.status(422).json({ detail: 'search must be no more than 100 characters' });
    }
    try {
      await ensureIndexes();
      const query = search?.trim()
        ? { $or: ['title', 'author', 'isbn', 'category'].map((field) => ({
          [field]: { $regex: escapeRegex(search.trim()), $options: 'i' },
        })) }
        : {};
      const books = await (await getBooksCollection())
        .find(query)
        .sort({ title: 1 })
        .toArray();
      return response.json(books.map(bookOutput));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/books', authenticate, adminOnly, async (request, response, next) => {
    const validationError = validateBook(request.body);
    if (validationError) return response.status(422).json({ detail: validationError });
    try {
      await ensureIndexes();
      const collection = await getBooksCollection();
      const document = {
        title: request.body.title.trim(),
        author: request.body.author.trim(),
        isbn: request.body.isbn.trim(),
        category: request.body.category.trim(),
        total_copies: request.body.total_copies,
        available_copies: request.body.total_copies,
        created_at: new Date(),
        updated_at: new Date(),
      };
      const result = await collection.insertOne(document);
      return response.status(201).json(bookOutput({ ...document, _id: result.insertedId }));
    } catch (error) {
      if (error.code === 11000) return response.status(409).json({ detail: 'A book with this ISBN already exists' });
      return next(error);
    }
  });

  router.patch('/books/:book_id', authenticate, adminOnly, async (request, response, next) => {
    const { total_copies: totalCopies } = request.body || {};
    if (!Number.isInteger(totalCopies) || totalCopies < 1 || totalCopies > 10000) {
      return response.status(422).json({ detail: 'total_copies must be an integer between 1 and 10000' });
    }
    if (!BOOK_ID_PATTERN.test(request.params.book_id)) {
      return response.status(404).json({ detail: 'Book not found' });
    }
    try {
      await ensureIndexes();
      const books = await getBooksCollection();
      const bookId = new ObjectId(request.params.book_id);
      const loans = await getBookLoansCollection();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const book = await books.findOne({ _id: bookId });
        if (!book) return response.status(404).json({ detail: 'Book not found' });
        const activeLoans = await loans.countDocuments({
          book_id: bookId,
          status: 'borrowed',
        });
        const availableCopies =
          book.available_copies + totalCopies - book.total_copies;
        if (totalCopies < activeLoans || availableCopies < 0) {
          return response.status(409).json({
            detail: 'total_copies cannot be less than active loans',
          });
        }
        const updatedAt = new Date();
        const result = await books.updateOne(
          {
            _id: bookId,
            total_copies: book.total_copies,
            available_copies: book.available_copies,
          },
          {
            $set: {
              total_copies: totalCopies,
              available_copies: availableCopies,
              updated_at: updatedAt,
            },
          },
        );
        if (result.matchedCount === 1) {
          return response.json(bookOutput({
            ...book,
            total_copies: totalCopies,
            available_copies: availableCopies,
          }));
        }
      }
      return response.status(409).json({ detail: 'Inventory changed during the update. Please retry.' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/loans', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const loans = await (await getBookLoansCollection())
        .find({ user_id: request.user._id })
        .sort({ borrowed_at: -1 })
        .toArray();
      return response.json(loans.map(loanOutput));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/books/:book_id/borrow', authenticate, async (request, response, next) => {
    if (!BOOK_ID_PATTERN.test(request.params.book_id)) {
      return response.status(404).json({ detail: 'Book not found' });
    }
    try {
      await ensureIndexes();
      const books = await getBooksCollection();
      const loans = await getBookLoansCollection();
      const bookId = new ObjectId(request.params.book_id);
      const book = await books.findOne({ _id: bookId });
      if (!book) return response.status(404).json({ detail: 'Book not found' });

      const active = await loans.find({
        user_id: request.user._id,
        status: 'borrowed',
      }).toArray();
      if (active.length >= MAX_ACTIVE_LOANS) {
        return response.status(409).json({ detail: `You may borrow at most ${MAX_ACTIVE_LOANS} books at a time` });
      }

      const reserved = await books.updateOne(
        { _id: bookId, available_copies: { $gt: 0 } },
        { $inc: { available_copies: -1 }, $set: { updated_at: new Date() } },
      );
      if (reserved.matchedCount !== 1) {
        return response.status(409).json({ detail: 'This book is currently unavailable' });
      }

      const usedSlots = new Set(active.map((loan) => loan.borrowing_slot).filter(Number.isInteger));
      const now = new Date();
      const loan = {
        book_id: bookId,
        user_id: request.user._id,
        book_title: book.title,
        book_isbn: book.isbn,
        status: 'borrowed',
        borrowing_slot: null,
        borrowed_at: now,
        due_at: new Date(now.getTime() + LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000),
        returned_at: null,
      };
      let saved;
      try {
        for (let slot = 0; slot < MAX_ACTIVE_LOANS; slot += 1) {
          if (usedSlots.has(slot)) continue;
          loan.borrowing_slot = slot;
          try {
            saved = await loans.insertOne(loan);
            break;
          } catch (error) {
            if (error.code !== 11000) throw error;
            usedSlots.add(slot);
          }
        }
      } catch (error) {
        await restoreCopy(books, bookId);
        return next(error);
      }

      if (!saved) {
        await restoreCopy(books, bookId);
        return response.status(409).json({ detail: `You may borrow at most ${MAX_ACTIVE_LOANS} books at a time` });
      }
      return response.status(201).json(loanOutput({ ...loan, _id: saved.insertedId }));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/loans/:loan_id/return', authenticate, async (request, response, next) => {
    if (!BOOK_ID_PATTERN.test(request.params.loan_id)) {
      return response.status(404).json({ detail: 'Active loan not found' });
    }
    try {
      await ensureIndexes();
      const loans = await getBookLoansCollection();
      const books = await getBooksCollection();
      const loanId = new ObjectId(request.params.loan_id);
      const isAdmin = request.user.role === 'admin';
      const filter = { _id: loanId, status: 'borrowed' };
      if (!isAdmin) filter.user_id = request.user._id;
      const loan = await loans.findOne(filter);
      if (!loan) return response.status(404).json({ detail: 'Active loan not found' });

      const returnedAt = new Date();
      const result = await loans.updateOne(
        filter,
        { $set: { status: 'returned', returned_at: returnedAt } },
      );
      if (result.matchedCount !== 1) {
        return response.status(409).json({ detail: 'This book has already been returned' });
      }
      try {
        const restored = await books.updateOne(
          { _id: loan.book_id, $expr: { $lt: ['$available_copies', '$total_copies'] } },
          { $inc: { available_copies: 1 }, $set: { updated_at: returnedAt } },
        );
        if (restored.matchedCount !== 1) {
          throw new Error('Could not restore returned library inventory.');
        }
      } catch (error) {
        await loans.updateOne(
          { _id: loanId, status: 'returned' },
          { $set: { status: 'borrowed' }, $unset: { returned_at: '' } },
        );
        return next(error);
      }
      return response.json(loanOutput({ ...loan, status: 'returned', returned_at: returnedAt }));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createLibraryRouter, validateBook };
