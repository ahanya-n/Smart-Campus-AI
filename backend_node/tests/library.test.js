const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-library-secret',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function user(role) {
  return { _id: new ObjectId(), name: `Library ${role}`, email: `${role}@test.local`, role };
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((condition) => matches(document, condition));
    if (key === '$expr') {
      const [left, right] = expected.$lt;
      return document[left.slice(1)] < document[right.slice(1)];
    }
    const actual = document[key];
    if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected);
    if (expected instanceof RegExp) return expected.test(actual);
    if (expected && typeof expected === 'object') {
      if (Object.hasOwn(expected, '$regex')) {
        return new RegExp(expected.$regex, expected.$options).test(actual || '');
      }
      if (Object.hasOwn(expected, '$gt') && !(actual > expected.$gt)) return false;
      if (Object.hasOwn(expected, '$type') && typeof actual !== 'number') return false;
      return true;
    }
    return actual === expected;
  });
}

function collection(initial = []) {
  const documents = [...initial];
  return {
    documents,
    async createIndex() {},
    async findOne(query) {
      return documents.find((document) => matches(document, query)) || null;
    },
    find(query = {}) {
      let found = documents.filter((document) => matches(document, query));
      const cursor = {
        sort(order) {
          const [[field, direction]] = Object.entries(order);
          found = found.sort((left, right) => (
            String(left[field] ?? '').localeCompare(String(right[field] ?? '')) * direction
          ));
          return cursor;
        },
        async toArray() { return found; },
      };
      return cursor;
    },
    async countDocuments(query) {
      return documents.filter((document) => matches(document, query)).length;
    },
    async insertOne(document) {
      if (
        document.isbn &&
        documents.some((saved) => saved.isbn === document.isbn)
      ) {
        const duplicate = new Error('duplicate ISBN');
        duplicate.code = 11000;
        throw duplicate;
      }
      if (
        document.borrowing_slot !== null &&
        documents.some((saved) =>
          saved.user_id?.equals(document.user_id) &&
          saved.borrowing_slot === document.borrowing_slot &&
          saved.status === 'borrowed')
      ) {
        const duplicate = new Error('duplicate key');
        duplicate.code = 11000;
        throw duplicate;
      }
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const existing = documents.find((document) => matches(document, query));
      if (!existing) return { matchedCount: 0 };
      Object.assign(existing, update.$set);
      for (const [field, amount] of Object.entries(update.$inc || {})) {
        existing[field] += amount;
      }
      for (const field of Object.keys(update.$unset || {})) delete existing[field];
      return { matchedCount: 1 };
    },
  };
}

function setup(users, books = [], loans = []) {
  const userCollection = collection(users);
  const bookCollection = collection(books);
  const loanCollection = collection(loans);
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => userCollection,
    getBooksCollection: async () => bookCollection,
    getBookLoansCollection: async () => loanCollection,
  });
  return { app, bookCollection, loanCollection };
}

function asUser(app, account, method, path, body) {
  const token = jwt.sign({}, ENV.JWT_SECRET, {
    algorithm: 'HS256',
    subject: account._id.toHexString(),
    expiresIn: '1h',
  });
  const call = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body === undefined ? call : call.send(body);
}

function book(overrides = {}) {
  return {
    _id: new ObjectId(),
    title: 'The Pragmatic Programmer',
    author: 'Andrew Hunt',
    isbn: '9780135957059',
    category: 'Software',
    total_copies: 2,
    available_copies: 2,
    ...overrides,
  };
}

const input = {
  title: 'Clean Code',
  author: 'Robert C. Martin',
  isbn: '9780132350884',
  category: 'Software',
  total_copies: 3,
};

test('library book listing requires auth and supports safe search', async () => {
  const student = user('student');
  const { app } = setup([student], [
    book(),
    book({ title: 'A Book About .*', isbn: 'safe-search-isbn' }),
  ]);
  assert.equal((await request(app).get('/api/library/books')).status, 401);
  const response = await asUser(app, student, 'get', '/api/library/books?search=pragmatic');
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].available_copies, 2);
});

test('only admins may add catalog books and invalid inventory is rejected', async () => {
  const admin = user('admin');
  const faculty = user('faculty');
  const { app, bookCollection } = setup([admin, faculty]);
  assert.equal((await asUser(app, faculty, 'post', '/api/library/books', input)).status, 403);
  assert.equal((await asUser(app, admin, 'post', '/api/library/books', {
    ...input,
    total_copies: 0,
  })).status, 422);
  const created = await asUser(app, admin, 'post', '/api/library/books', input);
  assert.equal(created.status, 201);
  assert.equal(created.body.total_copies, 3);
  assert.equal(created.body.available_copies, 3);
  assert.equal(bookCollection.documents.length, 1);
  const duplicate = await asUser(app, admin, 'post', '/api/library/books', input);
  assert.equal(duplicate.status, 409);
});

test('borrowing decrements stock, enforces availability and limits, and records history', async () => {
  const student = user('student');
  const other = user('student');
  const stocked = book({ available_copies: 1 });
  const unavailable = book({ isbn: 'out-of-stock', available_copies: 0 });
  const otherAvailable = book({ isbn: 'other-available' });
  const fiveLoans = Array.from({ length: 5 }, (_, borrowing_slot) => ({
    _id: new ObjectId(),
    user_id: other._id,
    book_id: new ObjectId(),
    status: 'borrowed',
    borrowing_slot,
  }));
  const { app, bookCollection } = setup([student, other], [stocked, unavailable, otherAvailable], fiveLoans);

  assert.equal((await asUser(app, student, 'post', '/api/library/books/not-an-id/borrow')).status, 404);
  assert.equal((await asUser(app, student, 'post', `/api/library/books/${unavailable._id}/borrow`)).status, 409);

  const borrowed = await asUser(app, student, 'post', `/api/library/books/${stocked._id}/borrow`);
  assert.equal(borrowed.status, 201);
  assert.equal(bookCollection.documents[0].available_copies, 0);
  assert.equal(new Date(borrowed.body.due_at).getTime() - new Date(borrowed.body.borrowed_at).getTime(), 14 * 86400000);
  const atLimit = await asUser(app, other, 'post', `/api/library/books/${otherAvailable._id}/borrow`);
  assert.equal(atLimit.status, 409);
  assert.match(atLimit.body.detail, /at most 5/);

  const history = await asUser(app, student, 'get', '/api/library/loans');
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].status, 'borrowed');
});

test('returns are restricted to the borrower and restore exactly one available copy', async () => {
  const student = user('student');
  const other = user('student');
  const stocked = book({ available_copies: 1 });
  const loan = {
    _id: new ObjectId(),
    book_id: stocked._id,
    user_id: student._id,
    book_title: stocked.title,
    book_isbn: stocked.isbn,
    status: 'borrowed',
    borrowing_slot: 0,
    borrowed_at: new Date(),
    due_at: new Date(Date.now() + 14 * 86400000),
    returned_at: null,
  };
  const { app, bookCollection } = setup([student, other], [stocked], [loan]);

  assert.equal((await asUser(app, other, 'post', `/api/library/loans/${loan._id}/return`)).status, 404);
  const returned = await asUser(app, student, 'post', `/api/library/loans/${loan._id}/return`);
  assert.equal(returned.status, 200);
  assert.equal(returned.body.status, 'returned');
  assert.equal(bookCollection.documents[0].available_copies, 2);
  assert.equal((await asUser(app, student, 'post', `/api/library/loans/${loan._id}/return`)).status, 404);
});

test('inventory cannot be reduced below active loans', async () => {
  const admin = user('admin');
  const stocked = book({ total_copies: 2, available_copies: 1 });
  const loans = [
    { _id: new ObjectId(), book_id: stocked._id, status: 'borrowed' },
    { _id: new ObjectId(), book_id: stocked._id, status: 'borrowed' },
  ];
  const { app } = setup([admin], [stocked], loans);
  const invalid = await asUser(app, admin, 'patch', `/api/library/books/${stocked._id}`, {
    total_copies: 0,
  });
  const belowLoans = await asUser(app, admin, 'patch', `/api/library/books/${stocked._id}`, {
    total_copies: 1,
  });
  assert.equal(invalid.status, 422);
  assert.equal(belowLoans.status, 409);
});

test('administrator inventory updates preserve available-copy counts', async () => {
  const admin = user('admin');
  const stocked = book({ total_copies: 2, available_copies: 1 });
  const loan = {
    _id: new ObjectId(),
    book_id: stocked._id,
    status: 'borrowed',
  };
  const { app, bookCollection } = setup([admin], [stocked], [loan]);

  const response = await asUser(app, admin, 'patch', `/api/library/books/${stocked._id}`, {
    total_copies: 4,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.total_copies, 4);
  assert.equal(response.body.available_copies, 3);
  assert.equal(bookCollection.documents[0].available_copies, 3);
});
