export const LOST_FOUND_CATEGORIES = [
  'Bag',
  'Book',
  'Clothing',
  'Electronic device',
  'ID card',
  'Keys',
  'Bottle',
  'Other',
]

export const LOST_FOUND_STATUSES = [
  'Active',
  'Match requested',
  'Resolved',
  'Closed',
]

export const INITIAL_LOST_FOUND_REPORT = {
  itemName: '',
  brand: '',
  description: '',
  category: '',
  colour: '',
  date: '',
  time: '',
  location: '',
  identifyingDetails: '',
  image: null,
  imageName: '',
  imagePreview: '',
}

export function canRequestLostFoundMatch(reportType, candidateType) {
  return reportType === 'lost' && candidateType === 'found'
}

export function validateLostFoundReport(report) {
  const requiredText = [
    ['itemName', 'Item name', 120],
    ['description', 'Description', 1000],
    ['category', 'Category', 60],
    ['colour', 'Colour', 60],
    ['date', 'Date', 20],
    ['time', 'Approximate time', 20],
    ['location', 'Location', 200],
  ]

  for (const [field, label, max] of requiredText) {
    const value = typeof report[field] === 'string' ? report[field].trim() : ''
    if (!value) return `${label} is required.`
    if (value.length > max) return `${label} cannot exceed ${max} characters.`
  }

  if (!LOST_FOUND_CATEGORIES.includes(report.category)) {
    return 'Category must be one of the available item categories.'
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date)) {
    return 'Enter a valid date.'
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(report.time)) {
    return 'Approximate time must use valid HH:MM format.'
  }

  const identifyingDetails = typeof report.identifyingDetails === 'string'
    ? report.identifyingDetails.trim()
    : ''
  if (identifyingDetails.length > 1000) {
    return 'Additional identifying details cannot exceed 1000 characters.'
  }

  const brand = typeof report.brand === 'string' ? report.brand.trim() : ''
  if (brand.length > 80) {
    return 'Brand cannot exceed 80 characters.'
  }

  return ''
}

export function validateLostFoundImage(file) {
  if (!file) return ''
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return 'Choose a JPG, PNG, or WebP image.'
  }
  if (file.size > 5 * 1024 * 1024) {
    return 'The selected image must be 5 MB or smaller.'
  }
  return ''
}

export function reportTimestamp(date, time) {
  if (
    typeof date !== 'string'
    || typeof time !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    return null
  }
  const timestamp = new Date(`${date}T${time}:00`)
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.valueOf()
}

export function areReportsEligibleToMatch(left, right) {
  if (!left || !right || left.type === right.type) return false
  if (!['lost', 'found'].includes(left.type) || !['lost', 'found'].includes(right.type)) {
    return false
  }
  const leftTimestamp = reportTimestamp(left.date, left.time)
  const rightTimestamp = reportTimestamp(right.date, right.time)
  if (leftTimestamp === null || rightTimestamp === null) return false
  return Math.abs(leftTimestamp - rightTimestamp) <= 24 * 60 * 60 * 1000
}

export function formatReportDateTime(date, time) {
  if (!date) return 'Date not set'
  const dateTime = reportTimestamp(date, time)
  if (dateTime === null) return date
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(dateTime))
}
