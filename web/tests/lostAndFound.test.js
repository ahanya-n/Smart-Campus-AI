import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOST_FOUND_CATEGORIES,
  areReportsEligibleToMatch,
  canRequestLostFoundMatch,
  reportTimestamp,
  validateLostFoundImage,
  validateLostFoundReport,
} from '../src/lostAndFound.js'

const validReport = {
  itemName: 'Black backpack',
  description: 'A black laptop backpack with a blue zip pouch.',
  category: 'Bag',
  colour: 'Black',
  date: '2026-11-21',
  time: '10:00',
  location: 'Central Library',
  identifyingDetails: 'Red pen in the front pocket.',
  image: null,
}

test('lost and found report validation accepts a complete record', () => {
  assert.equal(validateLostFoundReport(validReport), '')
  assert.ok(LOST_FOUND_CATEGORIES.includes('Bag'))
})

test('lost and found report validation rejects missing and invalid fields', () => {
  assert.match(validateLostFoundReport({ ...validReport, itemName: '  ' }), /Item name is required/)
  assert.match(validateLostFoundReport({ ...validReport, category: 'Unknown' }), /Category/)
  assert.match(validateLostFoundReport({ ...validReport, time: '25:70' }), /Approximate time/)
  assert.match(validateLostFoundReport({ ...validReport, identifyingDetails: 'x'.repeat(1001) }), /1000 characters/)
  assert.match(validateLostFoundReport({ ...validReport, brand: 'x'.repeat(81) }), /Brand/)
})

test('lost and found image validation accepts supported images and rejects unsafe sizes and types', () => {
  assert.equal(validateLostFoundImage({ type: 'image/jpeg', size: 1024 }), '')
  assert.match(validateLostFoundImage({ type: 'application/pdf', size: 1024 }), /JPG, PNG, or WebP/)
  assert.match(validateLostFoundImage({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }), /5 MB/)
})

test('matching is restricted to opposite types within 24 hours', () => {
  const lost = { ...validReport, type: 'lost' }
  const found = {
    ...validReport,
    type: 'found',
    date: '2026-11-22',
    time: '09:00',
  }

  assert.equal(areReportsEligibleToMatch(lost, found), true)
  assert.equal(areReportsEligibleToMatch(lost, { ...found, time: '11:00' }), false)
  assert.equal(areReportsEligibleToMatch(lost, { ...lost }), false)
  assert.equal(areReportsEligibleToMatch(
    { ...lost, date: '2026-11-21', time: '10:00' },
    { ...found, date: '2026-11-22', time: '10:00' },
  ), true)
  assert.equal(areReportsEligibleToMatch(
    { ...lost, date: '2026-11-21', time: '10:00' },
    { ...found, date: '2026-11-22', time: '10:00:01' },
  ), false)
  assert.equal(reportTimestamp('2026-11-21', '10:00') !== null, true)
})

test('only a lost-report owner can request a match to a found report', () => {
  assert.equal(canRequestLostFoundMatch('lost', 'found'), true)
  assert.equal(canRequestLostFoundMatch('found', 'lost'), false)
  assert.equal(canRequestLostFoundMatch('lost', 'lost'), false)
})
