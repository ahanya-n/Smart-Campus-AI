import assert from 'node:assert/strict'
import test from 'node:test'

import { canBorrowLibraryBook, MAX_ACTIVE_LIBRARY_LOANS, validateBookForm } from '../src/library.js'

const validBook = {
  title: 'The Pragmatic Programmer',
  author: 'Andrew Hunt',
  isbn: '9780135957059',
  category: 'Software',
  total_copies: '3',
}

test('book form accepts a complete record with valid inventory', () => {
  assert.equal(validateBookForm(validBook), '')
})

test('book form rejects blank fields, long fields, and invalid inventory', () => {
  assert.match(validateBookForm({ ...validBook, title: '  ' }), /Title is required/)
  assert.match(validateBookForm({ ...validBook, author: 'a'.repeat(121) }), /Author is required/)
  assert.match(validateBookForm({ ...validBook, total_copies: '1.5' }), /whole number/)
  assert.match(validateBookForm({ ...validBook, total_copies: '0' }), /whole number/)
})

test('borrow action respects stock and the active-loan limit', () => {
  assert.equal(MAX_ACTIVE_LIBRARY_LOANS, 5)
  assert.equal(canBorrowLibraryBook({ available_copies: 1 }, 4), true)
  assert.equal(canBorrowLibraryBook({ available_copies: 0 }, 0), false)
  assert.equal(canBorrowLibraryBook({ available_copies: 1 }, 5), false)
})
