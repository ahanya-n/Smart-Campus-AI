import assert from 'node:assert/strict'
import test from 'node:test'

import {
  availableAssistantModes,
  calculateStudyStreak,
  MAX_ASSISTANT_FILE_BYTES,
  safeAssistantSourceUrl,
  validateAssistantFile,
} from '../src/assistant.js'

test('Assistant modes are role-scoped', () => {
  assert.deepEqual(availableAssistantModes('student').map(({ id }) => id), [
    'general',
    'placement',
    'study',
    'mood',
  ])
  assert.deepEqual(availableAssistantModes('faculty').map(({ id }) => id), ['general'])
})

test('Assistant document uploads accept only bounded PDF, DOCX, and TXT files', () => {
  assert.equal(validateAssistantFile({ name: 'notes.PDF', size: MAX_ASSISTANT_FILE_BYTES }), '')
  assert.match(validateAssistantFile({ name: 'notes.exe', size: 100 }), /PDF, DOCX, or TXT/)
  assert.match(validateAssistantFile({ name: 'notes.txt', size: MAX_ASSISTANT_FILE_BYTES + 1 }), /5 MB/)
})

test('Assistant citations allow only HTTP(S) destinations', () => {
  assert.equal(safeAssistantSourceUrl('https://example.test/article'), 'https://example.test/article')
  assert.equal(safeAssistantSourceUrl('javascript:alert(1)'), '')
  assert.equal(safeAssistantSourceUrl('not a url'), '')
})

test('study streak counts consecutive days ending today or yesterday', () => {
  const today = new Date('2026-03-16T12:00:00Z')
  assert.equal(calculateStudyStreak([
    { created_at: '2026-03-16T08:00:00Z' },
    { created_at: '2026-03-15T08:00:00Z' },
    { created_at: '2026-03-14T08:00:00Z' },
    { created_at: 'not-a-date' },
  ], today), 3)
  assert.equal(calculateStudyStreak([{ created_at: '2026-03-14T08:00:00Z' }], today), 0)
})
