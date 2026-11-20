export function parseTransportPoints(value) {
  const points = value.split(',').map((point) => point.trim()).filter(Boolean)
  if (points.length < 1 || points.length > 30) return null
  if (points.some((point) => point.length > 100)) return null
  if (new Set(points.map((point) => point.toLowerCase())).size !== points.length) return null
  return points
}

export function validateTransportRoute(route) {
  if (!/^[A-Za-z0-9-]{1,20}$/.test(String(route.route_number || '').trim())) {
    return 'Route number must contain 1-20 letters, digits, or hyphens.'
  }
  for (const [field, label] of [
    ['bus_number', 'Bus number'],
    ['registration_number', 'Registration number'],
    ['driver_name', 'Driver name'],
  ]) {
    const value = String(route[field] || '').trim()
    const max = field === 'driver_name' ? 100 : 20
    if (!value || value.length > max) return `${label} is required (maximum ${max} characters).`
  }
  const phone = String(route.driver_phone || '').trim()
  const digits = (phone.match(/\d/g) || []).length
  if (!/^[+0-9() -]{7,24}$/.test(phone) || digits < 7 || digits > 15) {
    return 'Driver phone must contain 7-15 digits and valid phone characters.'
  }
  if (!Number.isInteger(Number(route.capacity)) || Number(route.capacity) < 1 || Number(route.capacity) > 100) {
    return 'Capacity must be a whole number from 1 to 100.'
  }
  if (!parseTransportPoints(String(route.pickup_points || ''))) {
    return 'Enter 1-30 unique pickup points, separated by commas.'
  }
  if (!parseTransportPoints(String(route.drop_points || ''))) {
    return 'Enter 1-30 unique drop points, separated by commas.'
  }
  return ''
}

export function validateTransportAssignment(assignment) {
  if (!/^[A-Za-z0-9-]{1,50}$/.test(String(assignment.student_id || '').trim())) {
    return 'Enter a valid student ID.'
  }
  if (!String(assignment.pickup_point || '').trim()) return 'Choose a pickup point.'
  if (!String(assignment.drop_point || '').trim()) return 'Choose a drop point.'
  return ''
}

export function availableTransportSeats(route) {
  return Math.max(0, Number(route.capacity) - Number(route.assigned_seats))
}
