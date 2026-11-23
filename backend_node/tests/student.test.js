const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const TEST_ENV = {
  JWT_SECRET: 'test-only-secret-for-smart-campus-students',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function makeUser(role, studentId, assignedSubjectCodes = []) {
  return {
    _id: new ObjectId(),
    name: `Test ${role}`,
    email: `${role}@example.edu`,
    role,
    ...(studentId ? { student_id: studentId } : {}),
    ...(role === 'faculty' ? { assigned_subject_codes: assignedSubjectCodes } : {}),
  };
}

function matches(document, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every((part) => matches(document, part));
    if (key === '$or') return value.some((part) => matches(document, part));
    const actual = document[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$ne' in value) return actual !== value.$ne;
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$in' in value) return value.$in.includes(actual);
      return false;
    }
    return actual === value;
  });
}

function createCollections(users, students, timetableEntries = []) {
  return {
    users: {
      async findOne(query) {
        return users.find((user) => user._id.equals(query._id)) || null;
      },
    },
    students: {
      async findOne(query, options) {
        assert.deepEqual(options, { projection: { _id: 0 } });
        const student = students.find(
          (record) => record.student_id === query.student_id,
        );
        if (!student) return null;
        const { _id, ...profile } = student;
        return profile;
      },
      find(query, options) {
        assert.deepEqual(options, { projection: { _id: 0 } });
        return {
          async toArray() {
            return students
              .filter((student) => matches(student, query))
              .map(({ _id, ...student }) => student);
          },
        };
      },
    },
    timetable: {
      find(query, options) {
        assert.equal(options.projection._id, 0);
        return {
          async toArray() {
            return timetableEntries.filter((entry) => matches(entry, query));
          },
        };
      },
    },
  };
}

function createRecordCollection(records) {
  return {
    find(query) {
      let matched = records.filter((record) => matches(record, query));
      const cursor = {
        sort(sortSpec) {
          const [field, direction] = Object.entries(sortSpec)[0];
          matched = matched.slice().sort((left, right) =>
            String(left[field] || '').localeCompare(String(right[field] || '')) * direction);
          return cursor;
        },
        limit(count) {
          matched = matched.slice(0, count);
          return cursor;
        },
        async toArray() {
          return matched;
        },
      };
      return cursor;
    },
  };
}

function tokenFor(user) {
  return jwt.sign(
    {},
    TEST_ENV.JWT_SECRET,
    {
      algorithm: 'HS256',
      subject: user._id.toHexString(),
      expiresIn: '1h',
    },
  );
}

function createTestApp(users, students, options = {}) {
  const collections = createCollections(users, students);
  return createApp({
    env: TEST_ENV,
    getUsersCollection: options.getUsersCollection || (() => collections.users),
    getStudentsCollection: options.getStudentsCollection || (() => collections.students),
    getTimetableCollection: options.getTimetableCollection || (() => collections.timetable),
    getAttendanceCollection: options.getAttendanceCollection || (() =>
      createRecordCollection(options.attendanceRecords || [])),
    getAttendanceEntriesCollection: options.getAttendanceEntriesCollection || (() =>
      createRecordCollection(options.attendanceEntryRecords || [])),
    getAssignmentsCollection: options.getAssignmentsCollection || (() =>
      createRecordCollection(options.assignmentRecords || [])),
    getMarksCollection: options.getMarksCollection || (() =>
      createRecordCollection(options.markRecords || [])),
    getNotificationsCollection: options.getNotificationsCollection || (() =>
      createRecordCollection(options.notificationRecords || [])),
  });
}

function asUser(app, user, path) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
}

const studentProfile = {
  student_id: 'MCA001',
  name: 'Alex Student',
  department: 'MCA',
  semester: 1,
};

test('GET /api/students/me returns the authenticated student linked profile', async () => {
  const user = makeUser('student', 'MCA001');
  const app = createTestApp([user], [{ _id: new ObjectId(), ...studentProfile }]);

  const response = await asUser(app, user, '/api/students/me');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, studentProfile);
  assert.equal(Object.hasOwn(response.body, '_id'), false);
});

test('GET /api/students/me reports an unlinked or missing profile as not found', async () => {
  const unlinked = makeUser('student');
  const linked = makeUser('student', 'MCA999');
  const app = createTestApp([unlinked, linked], [studentProfile]);

  const unlinkedResponse = await asUser(app, unlinked, '/api/students/me');
  const missingResponse = await asUser(app, linked, '/api/students/me');

  assert.equal(unlinkedResponse.status, 404);
  assert.deepEqual(unlinkedResponse.body, { detail: 'Student profile not found' });
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(missingResponse.body, { detail: 'Student profile not found' });
});

test('student dashboards return only that account non-synthetic academic records', async () => {
  const firstUser = makeUser('student', 'MCA001');
  const secondUser = makeUser('student', 'MCA002');
  const students = [
    { _id: new ObjectId(), ...studentProfile },
    {
      _id: new ObjectId(),
      student_id: 'MCA002',
      name: 'Another Student',
      department: 'MCA',
      semester: 1,
      section: 'A',
    },
  ];
  const app = createTestApp([firstUser, secondUser], students, {
    attendanceRecords: [
      { student_id: 'MCA001', subject_code: 'MCA101', present_classes: 4, total_classes: 5, is_demo: false, synthetic_demo: false },
      { student_id: 'MCA001', subject_code: 'MCA102', present_classes: 100, total_classes: 100, is_demo: true, synthetic_demo: true },
      { student_id: 'MCA002', subject_code: 'MCA101', present_classes: 1, total_classes: 2, is_demo: false, synthetic_demo: false },
    ],
    markRecords: [
      { student_id: 'MCA001', subject_code: 'MCA101', score: 80, max_score: 100, is_demo: false, synthetic_demo: false },
      { student_id: 'MCA001', subject_code: 'MCA102', score: 100, max_score: 100, is_demo: false, synthetic_demo: true },
      { student_id: 'MCA002', subject_code: 'MCA101', score: 50, max_score: 100, is_demo: false, synthetic_demo: false },
    ],
    assignmentRecords: [
      { student_id: 'MCA001', title: 'Official', status: 'pending', is_demo: false, synthetic_demo: false },
      { student_id: 'MCA001', title: 'Synthetic', status: 'pending', is_demo: false, synthetic_demo: true },
      { student_id: 'MCA002', title: 'Other student', status: 'pending', is_demo: false, synthetic_demo: false },
    ],
  });

  const first = await asUser(app, firstUser, '/api/students/dashboard/me');
  const second = await asUser(app, secondUser, '/api/students/dashboard/me');

  assert.equal(first.status, 200);
  assert.deepEqual(first.body.attendance.records.map((record) => record.student_id), ['MCA001']);
  assert.deepEqual(first.body.marks.map((record) => record.student_id), ['MCA001']);
  assert.deepEqual(first.body.assignments.upcoming.map((record) => record.title), ['Official']);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.attendance.records.map((record) => record.student_id), ['MCA002']);
  assert.deepEqual(second.body.marks.map((record) => record.student_id), ['MCA002']);
  assert.deepEqual(second.body.assignments.upcoming.map((record) => record.title), ['Other student']);
});

test('GET /api/students requires authentication', async () => {
  const app = createTestApp([], [studentProfile]);

  const response = await request(app).get('/api/students');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { detail: 'Not authenticated' });
});

test('student list is restricted to the authenticated linked record', async () => {
  const user = makeUser('student', 'MCA001');
  const app = createTestApp([user], [
    { _id: new ObjectId(), ...studentProfile },
    { _id: new ObjectId(), student_id: 'MCA002', name: 'Other Student' },
  ]);

  const response = await asUser(app, user, '/api/students?student_id=MCA002');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [studentProfile]);
});

test('faculty sees no students when no authorized class is assigned', async () => {
  const faculty = makeUser('faculty');
  const app = createTestApp([faculty], [
    { _id: new ObjectId(), ...studentProfile },
    { _id: new ObjectId(), student_id: 'MCA002', name: 'Another Student' },
  ]);

  const response = await asUser(app, faculty, '/api/students');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});

test('faculty sees only students in assigned class groups; admins retain directory access', async () => {
  const faculty = makeUser('faculty', undefined, ['MCA101']);
  const admin = makeUser('admin');
  const profiles = [
    { _id: new ObjectId(), ...studentProfile },
    { _id: new ObjectId(), student_id: 'MCA002', name: 'Another Student' },
    {
      _id: new ObjectId(),
      student_id: 'MBA001',
      name: 'Other Department Student',
      department: 'MBA',
      semester: 1,
    },
    {
      _id: new ObjectId(),
      student_id: 'MCA003',
      name: 'Synthetic Student',
      department: 'MCA',
      semester: 1,
      synthetic_demo: true,
    },
  ];
  const classes = [
    { department: 'MCA', semester: 1, subject_code: 'MCA101', is_demo: false },
  ];
  const app = createTestApp([faculty, admin], profiles, {
    getTimetableCollection: () => createCollections([], [], classes).timetable,
  });

  const facultyResponse = await asUser(app, faculty, '/api/students');
  const adminResponse = await asUser(app, admin, '/api/students');

  assert.equal(facultyResponse.status, 200);
  assert.deepEqual(
    facultyResponse.body.map((student) => student.student_id),
    ['MCA001'],
  );
  assert.equal(Object.hasOwn(facultyResponse.body[0], '_id'), false);
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.body.length, profiles.length);
});

test('seeded demo Faculty sees only marked students in the assigned synthetic class', async () => {
  const marker = 'smart-campus-local-demo-v1';
  const faculty = makeUser('faculty', undefined, ['DEMO101']);
  faculty.local_demo_seed = marker;
  const demoStudent = {
    ...studentProfile,
    student_id: 'DEMO-STUDENT-1',
    department: 'DEMO',
    local_demo_seed: marker,
    is_demo: true,
    synthetic_demo: true,
  };
  const unrelatedStudent = {
    student_id: 'OTHER-STUDENT',
    name: 'Unrelated',
    department: 'DEMO',
    semester: 1,
  };
  const demoClass = {
    department: 'DEMO',
    semester: 1,
    subject_code: 'DEMO101',
    faculty_user_id: String(faculty._id),
    is_demo: true,
    synthetic_demo: true,
  };
  const app = createTestApp([faculty], [demoStudent, unrelatedStudent], {
    getTimetableCollection: () => createCollections([], [], [demoClass]).timetable,
  });

  const response = await asUser(app, faculty, '/api/students');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((student) => student.student_id), ['DEMO-STUDENT-1']);
});

test('student profile endpoint rejects non-student roles', async () => {
  const faculty = makeUser('faculty');
  const app = createTestApp([faculty], [studentProfile]);

  const response = await asUser(app, faculty, '/api/students/me');

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, {
    detail: 'This action requires the student role.',
  });
});

test('student endpoints return safe service errors on database failures', async () => {
  const user = makeUser('student', 'MCA001');
  const unavailable = new Error('private database details');
  unavailable.statusCode = 503;
  unavailable.code = 'MONGODB_UNAVAILABLE';
  const app = createTestApp([user], [], {
    getStudentsCollection: async () => {
      throw unavailable;
    },
  });

  const profile = await asUser(app, user, '/api/students/me');
  const list = await asUser(app, user, '/api/students');

  for (const response of [profile, list]) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { detail: 'Database is unavailable' });
    assert.equal(JSON.stringify(response.body).includes('private database details'), false);
  }
});
