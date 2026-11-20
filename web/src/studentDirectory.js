export function filterStudentRecords(records, filters = {}) {
  const query = String(filters.search || '').trim().toLowerCase()
  const department = filters.department || ''
  const semester = filters.semester || ''

  return (Array.isArray(records) ? records : []).filter((student) => {
    const matchesSearch = !query || [
      student.name,
      student.student_id,
      student.registration_number,
      student.email,
    ]
      .some((value) => String(value || '').toLowerCase().includes(query))
    const matchesDepartment = !department || student.department === department
    const matchesSemester = !semester || String(student.semester) === String(semester)
    return matchesSearch && matchesDepartment && matchesSemester
  })
}

export function paginateStudentRecords(records, requestedPage, pageSize = 25) {
  const totalCount = records.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const page = Math.min(Math.max(1, requestedPage), totalPages)

  return {
    page,
    totalPages,
    totalCount,
    rows: records.slice((page - 1) * pageSize, page * pageSize),
  }
}
