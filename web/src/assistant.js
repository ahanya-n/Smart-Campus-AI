export const ASSISTANT_MODES = [
  { id: 'general', label: 'General Campus Assistant' },
  { id: 'placement', label: 'Placement Assistant' },
  { id: 'study', label: 'Study Buddy' },
  { id: 'mood', label: 'Mood Detector' },
]

const ASSISTANT_FILE_TYPES = new Set(['.pdf', '.docx', '.txt'])
export const MAX_ASSISTANT_FILE_BYTES = 5 * 1024 * 1024

export function availableAssistantModes(role) {
  return role === 'student'
    ? ASSISTANT_MODES
    : ASSISTANT_MODES.filter((mode) => mode.id === 'general')
}

export function validateAssistantFile(file) {
  if (!file) return 'Choose a file to upload.'
  const extension = file.name?.slice(file.name.lastIndexOf('.')).toLowerCase()
  if (!ASSISTANT_FILE_TYPES.has(extension)) return 'Upload a PDF, DOCX, or TXT file.'
  if (file.size > MAX_ASSISTANT_FILE_BYTES) return 'Files must be 5 MB or smaller.'
  return ''
}

export function safeAssistantSourceUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

export function calculateStudyStreak(sessions, today = new Date()) {
  const activeDays = new Set(
    sessions.map((session) => {
      const date = new Date(session.created_at)
      return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 10)
    }).filter(Boolean),
  )
  let date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  let day = date.toISOString().slice(0, 10)
  if (!activeDays.has(day)) {
    date.setUTCDate(date.getUTCDate() - 1)
    day = date.toISOString().slice(0, 10)
    if (!activeDays.has(day)) return 0
  }
  let streak = 0
  while (activeDays.has(day)) {
    streak += 1
    date.setUTCDate(date.getUTCDate() - 1)
    day = date.toISOString().slice(0, 10)
  }
  return streak
}
