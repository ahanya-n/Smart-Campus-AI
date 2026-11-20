export const COMPLAINT_CATEGORIES = [
  ['academic', 'Academic'],
  ['facilities', 'Facilities'],
  ['transport', 'Transport'],
  ['library', 'Library'],
  ['safety', 'Safety'],
  ['other', 'Other'],
]

export const COMPLAINT_STATUSES = [
  ['pending', 'Pending'],
  ['in_progress', 'In Progress'],
  ['resolved', 'Resolved'],
  ['rejected', 'Rejected'],
]

export function validateComplaintForm({ category, title, description }) {
  if (!COMPLAINT_CATEGORIES.some(([value]) => value === category)) {
    return 'Choose a valid complaint category.'
  }
  const cleanTitle = typeof title === 'string' ? title.trim() : ''
  if (cleanTitle.length < 3 || cleanTitle.length > 120) {
    return 'Title must be between 3 and 120 characters.'
  }
  const cleanDescription = typeof description === 'string' ? description.trim() : ''
  if (cleanDescription.length < 10 || cleanDescription.length > 5000) {
    return 'Description must be between 10 and 5000 characters.'
  }
  return ''
}

export function validateComplaintResponse(message, notes = '') {
  const cleanMessage = typeof message === 'string' ? message.trim() : ''
  if (cleanMessage.length < 1 || cleanMessage.length > 3000) {
    return 'Response must be between 1 and 3000 characters.'
  }
  const cleanNotes = typeof notes === 'string' ? notes.trim() : ''
  if (cleanNotes.length > 3000) {
    return 'Resolution notes cannot exceed 3000 characters.'
  }
  return ''
}
