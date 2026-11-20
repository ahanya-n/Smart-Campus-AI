import assert from 'node:assert/strict'
import test from 'node:test'

import { filterStudentRecords, paginateStudentRecords } from '../src/studentDirectory.js'

const students = Array.from({ length: 900 }, (_, index) => {
  const department = ['MCA', 'MBA', 'B.Tech'][Math.floor(index / 300)]
  const departmentIndex = index % 300
  return {
    student_id: `${department.replace('.', '')}${String(departmentIndex + 1).padStart(3, '0')}`,
    name: `Student ${department} ${departmentIndex + 1}`,
    email: `student${index + 1}@demo.test`,
    department,
    semester: departmentIndex % 3 + 1,
  }
})

test('department and semester filters return the expected records', () => {
  for (const department of ['MCA', 'MBA', 'B.Tech']) {
    for (const semester of ['1', '2', '3']) {
      const result = filterStudentRecords(students, { department, semester })
      assert.equal(result.length, 100)
      assert.ok(result.every((student) =>
        student.department === department && String(student.semester) === semester))
    }
  }
})

test('search finds case-insensitive name, student ID, and email matches', () => {
  assert.equal(filterStudentRecords(students, { search: 'STUDENT MCA 300' }).length, 1)
  assert.equal(filterStudentRecords(students, { search: 'mca002' })[0].student_id, 'MCA002')
  assert.equal(filterStudentRecords(students, { search: 'STUDENT2@DEMO.TEST' })[0].email, 'student2@demo.test')
})

test('search finds registration numbers', () => {
  const student = { ...students[0], registration_number: '20260MCA0021' }
  assert.deepEqual(filterStudentRecords([student], { search: '20260mca0021' }), [student])
})

test('search and department filters combine', () => {
  const result = filterStudentRecords(students, {
    search: 'student mba 299',
    department: 'MBA',
  })

  assert.equal(result.length, 1)
  assert.equal(result[0].department, 'MBA')
  assert.equal(result[0].name, 'Student MBA 299')
})

test('pagination returns 25 records and clamps out-of-range pages', () => {
  const first = paginateStudentRecords(students, 1)
  const second = paginateStudentRecords(students, 2)
  const final = paginateStudentRecords(students, 99)

  assert.equal(first.rows.length, 25)
  assert.equal(first.page, 1)
  assert.equal(first.totalPages, 36)
  assert.equal(first.totalCount, 900)
  assert.equal(second.rows[0].student_id, 'MCA026')
  assert.equal(final.page, 36)
  assert.equal(final.rows.length, 25)
})

test('empty filtering returns no rows and retains a single empty page', () => {
  assert.deepEqual(filterStudentRecords(students, { search: 'not-found' }), [])
  assert.deepEqual(paginateStudentRecords([], 5), {
    page: 1,
    totalPages: 1,
    totalCount: 0,
    rows: [],
  })
})
