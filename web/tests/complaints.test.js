import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_STATUSES,
  validateComplaintForm,
  validateComplaintResponse,
} from '../src/complaints.js'

const validComplaint = {
  category: 'facilities',
  title: 'Broken classroom projector',
  description: 'The projector in room A101 does not turn on.',
}

test('complaint form accepts normalized student content and expected categories', () => {
  assert.equal(validateComplaintForm(validComplaint), '')
  assert.deepEqual(COMPLAINT_CATEGORIES.map(([value]) => value), [
    'academic', 'facilities', 'transport', 'library', 'safety', 'other',
  ])
})

test('complaint form rejects invalid categories and out-of-range text', () => {
  assert.match(validateComplaintForm({ ...validComplaint, category: 'unknown' }), /category/)
  assert.match(validateComplaintForm({ ...validComplaint, title: 'x' }), /Title/)
  assert.match(validateComplaintForm({ ...validComplaint, description: 'short' }), /Description/)
})

test('admin complaint status and response validation match supported values', () => {
  assert.deepEqual(COMPLAINT_STATUSES.map(([value]) => value), [
    'pending', 'in_progress', 'resolved', 'rejected',
  ])
  assert.equal(validateComplaintResponse('Technician assigned', 'Replacement approved'), '')
  assert.match(validateComplaintResponse('  '), /Response/)
  assert.match(validateComplaintResponse('Valid update', 'x'.repeat(3001)), /Resolution/)
})
