export const MAX_ACTIVE_LIBRARY_LOANS = 5

export function validateBookForm(book) {
  for (const [field, max] of [
    ['title', 160],
    ['author', 120],
    ['isbn', 30],
    ['category', 60],
  ]) {
    if (typeof book[field] !== 'string' || !book[field].trim() || book[field].length > max) {
      return `${field[0].toUpperCase()}${field.slice(1)} is required (maximum ${max} characters).`
    }
  }
  const totalCopies = Number(book.total_copies)
  if (!Number.isInteger(totalCopies) || totalCopies < 1 || totalCopies > 10000) {
    return 'Total copies must be a whole number from 1 to 10000.'
  }
  return ''
}

export function canBorrowLibraryBook(book, activeLoanCount) {
  return book.available_copies > 0 && activeLoanCount < MAX_ACTIVE_LIBRARY_LOANS
}
