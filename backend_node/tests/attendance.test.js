const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const TEST_ENV = {
  JWT_SECRET: 'test-only-secret-for-smart-campus-attendance',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function makeUser(role, options = {}) {
  return {
    _id: new ObjectId(),
    name: `Test ${role}`,
    email: `${role}-${new ObjectId().toHexString()}@example.edu`,
    role,
    ...options,
  };
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    const value = document[key];
    if (expected instanceof ObjectId) return value instanceof ObjectId && value.equals(expected);
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, '$ne')) return value !== expected.$ne;
      if (Object.hasOwn(expected, '$in')) return expected.$in.includes(value);
      return false;
    }
    return value === expected;
  });
}

function clone(document) {
  return document ? { ...document } : document;
}

function makeCollection(initial = []) {
  const documents = [...initial];
  return {
    documents,
    async findOne(query) {
      return clone(documents.find((document) => matches(document, query)) || null);
    },
    find(query = {}) {
      let result = documents.filter((document) => matches(document, query));
      const cursor = {
        sort(sortFields) {
          const fields = Array.isArray(sortFields)
            ? sortFields
            : Object.entries(sortFields);
          result = [...result].sort((left, right) => {
            for (const [field, direction] of fields) {
              if (left[field] < right[field]) return -direction;
              if (left[field] > right[field]) return direction;
            }
            return 0;
          });
          return cursor;
        },
        limit(count) {
          result = result.slice(0, count);
          return cursor;
        },
        async toArray() {
          return result.map(clone);
        },
      };
      return cursor;
    },
    async countDocuments(query = {}) {
      return documents.filter((document) => matches(document, query)).length;
    },
    async updateOne(query, update, options = {}) {
      let document = documents.find((item) => matches(item, query));
      if (!document && options.upsert) {
        document = { ...query, _id: new ObjectId() };
        documents.push(document);
      }
      if (!document) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(document, update.$set || {});
      if (options.upsert && update.$setOnInsert && !document.created_at) {
        Object.assign(document, update.$setOnInsert);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

function setup({
  users = [],
  students = [],
  records = [],
  entries = [],
  failCollection,
} = {}) {
  const usersCollection = makeCollection(users);
  const studentsCollection = makeCollection(students);
  const attendanceCollection = makeCollection(records);
  const entriesCollection = makeCollection(entries);
  const dependencies = {
    getUsersCollection: async () => usersCollection,
    getStudentsCollection: async () => {
      if (failCollection === 'students') throw databaseFailure();
      return studentsCollection;
    },
    getAttendanceCollection: async () => {
      if (failCollection === 'attendance') throw databaseFailure();
      return attendanceCollection;
    },
    getAttendanceEntriesCollection: async () => {
      if (failCollection === 'entries') throw databaseFailure();
      return entriesCollection;
    },
  };
  return {
    app: createApp({ env: TEST_ENV, ...dependencies }),
    studentsCollection,
    attendanceCollection,
    entriesCollection,
  };
}

function databaseFailure() {
  const error = new Error('private database details');
  error.statusCode = 503;
  error.code = 'MONGODB_UNAVAILABLE';
  return error;
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

function asUser(app, user, method, path, body) {
  const call = request(app)[method](path)
    .set('Authorization', `Bearer ${tokenFor(user)}`);
  return body === undefined ? call : call.send(body);
}

const studentOne = {
  student_id: 'MCA001',
  name: 'Alex Student',
  department: 'MCA',
  semester: '1',
};
const studentTwo = {
  student_id: 'MCA002',
  name: 'Blair Student',
  department: 'MCA',
  semester: '2',
};
const today = new Date().toISOString().slice(0, 10);

function sessionBody(overrides = {}) {
  return {
    subject_code: 'mca401',
    subject_name: 'Algorithms',
    session_date: today,
    start_time: '09:00',
    records: [{ student_id: 'MCA001', status: 'present' }],
    ...overrides,
  };
}

test('student report and summary contain calculated official attendance', async () => {
  const user = makeUser('student', { student_id: 'MCA001' });
  const records = [
    {
      student_id: 'MCA001',
      subject_code: 'MCA401',
      subject_name: 'Algorithms',
      total_classes: 4,
      present_classes: 1,
      is_demo: false,
      updated_at: new Date('2026-10-26T10:00:00Z'),
    },
    {
      student_id: 'MCA002',
      subject_code: 'MCA402',
      subject_name: 'Other',
      total_classes: 1,
      present_classes: 1,
      is_demo: false,
    },
  ];
  const { app } = setup({ users: [user], students: [studentOne], records });

  const report = await asUser(app, user, 'get', '/api/attendance/me');
  const summary = await asUser(app, user, 'get', '/api/attendance/summary');

  assert.equal(report.status, 200);
  assert.equal(report.body.linked, true);
  assert.equal(report.body.records.length, 1);
  assert.deepEqual(report.body.records[0], {
    student_id: 'MCA001',
    subject_code: 'MCA401',
    subject_name: 'Algorithms',
    total_classes: 4,
    present_classes: 1,
    absent_classes: 3,
    attendance_percentage: 25,
    low_attendance: true,
    is_demo: false,
    updated_at: records[0].updated_at.toISOString(),
  });
  assert.deepEqual(report.body.summary, {
    total_classes: 4,
    present_classes: 1,
    absent_classes: 3,
    attendance_percentage: 25,
    subject_count: 1,
    low_attendance_subjects: ['Algorithms'],
    threshold: 75,
  });
  assert.equal(summary.status, 200);
  assert.equal(Object.hasOwn(summary.body, 'records'), false);
});

test('student report respects linked identity, handles unlinked accounts and demo mode', async () => {
  const student = makeUser('student', { student_id: 'MCA001' });
  const unlinked = makeUser('student');
  const demoRecord = {
    student_id: 'MCA001',
    subject_code: 'DEMO101',
    subject_name: 'Demonstration',
    total_classes: 1,
    present_classes: 1,
    is_demo: true,
  };
  const { app } = setup({
    users: [student, unlinked],
    students: [studentOne],
    records: [demoRecord],
  });

  const self = await asUser(app, student, 'get', '/api/attendance/me');
  const ownDemo = await asUser(app, student, 'get', '/api/attendance/me?demo=true');
  const notLinked = await asUser(app, unlinked, 'get', '/api/attendance/me');
  const malformedDemo = await asUser(app, student, 'get', '/api/attendance/me?demo=perhaps');

  assert.equal(self.status, 200);
  assert.deepEqual(self.body.records, []);
  assert.equal(self.body.linked, true);
  assert.equal(ownDemo.body.is_demo, true);
  assert.equal(ownDemo.body.records.length, 1);
  assert.equal(notLinked.body.linked, false);
  assert.deepEqual(notLinked.body.records, []);
  assert.equal(malformedDemo.status, 422);
});

test('seeded demo Student sees only linked synthetic attendance without a query flag', async () => {
  const marker = 'smart-campus-local-demo-v1';
  const student = makeUser('student', {
    student_id: 'DEMO-STUDENT-1',
    local_demo_seed: marker,
  });
  const profile = {
    ...studentOne,
    student_id: student.student_id,
    local_demo_seed: marker,
    is_demo: true,
    synthetic_demo: true,
  };
  const records = [
    {
      student_id: student.student_id,
      subject_code: 'DEMO101',
      subject_name: 'Programming',
      total_classes: 8,
      present_classes: 7,
      is_demo: true,
      synthetic_demo: true,
    },
    {
      student_id: student.student_id,
      subject_code: 'DEMO102',
      subject_name: 'Official-looking data',
      total_classes: 8,
      present_classes: 8,
      is_demo: false,
    },
  ];
  const { app } = setup({ users: [student], students: [profile], records });

  const response = await asUser(app, student, 'get', '/api/attendance/me');

  assert.equal(response.status, 200);
  assert.equal(response.body.linked, true);
  assert.equal(response.body.is_demo, true);
  assert.deepEqual(response.body.records.map((record) => record.subject_code), ['DEMO101']);
  assert.equal(response.body.summary.attendance_percentage, 87.5);
});

test('attendance endpoints require authentication and write endpoints reject students', async () => {
  const student = makeUser('student');
  const { app } = setup({ users: [student] });
  const missing = await request(app).get('/api/attendance/me');
  const denied = await asUser(
    app,
    student,
    'post',
    '/api/attendance/sessions',
    sessionBody(),
  );

  assert.equal(missing.status, 401);
  assert.equal(denied.status, 403);
});

test('faculty can record assigned sessions and resubmission updates without duplicates', async () => {
  const faculty = makeUser('faculty', {
    assigned_subject_codes: ['MCA401'],
  });
  const { app, entriesCollection, attendanceCollection } = setup({
    users: [faculty],
    students: [studentOne, studentTwo],
  });
  const firstBody = sessionBody({
    records: [
      { student_id: 'MCA001', status: 'present' },
      { student_id: 'MCA002', status: 'absent' },
    ],
  });

  const first = await asUser(app, faculty, 'post', '/api/attendance/sessions', firstBody);
  const second = await asUser(app, faculty, 'post', '/api/attendance/sessions', {
    ...firstBody,
    records: [
      { student_id: 'MCA001', status: 'present' },
      { student_id: 'MCA002', status: 'present' },
    ],
  });

  assert.equal(first.status, 200);
  assert.deepEqual(
    { created: first.body.created, updated: first.body.updated, unchanged: first.body.unchanged },
    { created: 2, updated: 0, unchanged: 0 },
  );
  assert.deepEqual(
    { created: second.body.created, updated: second.body.updated, unchanged: second.body.unchanged },
    { created: 0, updated: 1, unchanged: 1 },
  );
  assert.equal(entriesCollection.documents.length, 2);
  assert.equal(attendanceCollection.documents.find((record) =>
    record.student_id === 'MCA002').present_classes, 1);
});

test('session creation validates body, future dates, duplicates and student IDs', async () => {
  const admin = makeUser('admin');
  const { app } = setup({ users: [admin], students: [studentOne] });
  const duplicate = sessionBody({
    records: [
      { student_id: 'MCA001', status: 'present' },
      { student_id: 'MCA001', status: 'absent' },
    ],
  });
  const future = new Date();
  future.setDate(future.getDate() + 1);

  const invalid = await asUser(app, admin, 'post', '/api/attendance/sessions', {
    ...sessionBody(),
    start_time: '25:00',
  });
  const duplicateResponse = await asUser(app, admin, 'post', '/api/attendance/sessions', duplicate);
  const futureResponse = await asUser(app, admin, 'post', '/api/attendance/sessions', {
    ...sessionBody(),
    session_date: future.toISOString().slice(0, 10),
  });
  const unknown = await asUser(app, admin, 'post', '/api/attendance/sessions', {
    ...sessionBody(),
    records: [{ student_id: 'MCA404', status: 'present' }],
  });

  assert.equal(invalid.status, 422);
  assert.equal(duplicateResponse.status, 422);
  assert.equal(futureResponse.status, 422);
  assert.equal(unknown.status, 422);
});

test('faculty cannot read or modify unassigned subjects; admin can manage them', async () => {
  const faculty = makeUser('faculty', { assigned_subject_codes: ['MCA401'] });
  const admin = makeUser('admin');
  const { app } = setup({
    users: [faculty, admin],
    students: [studentOne],
  });
  const body = sessionBody({ subject_code: 'MCA402' });
  const deniedPost = await asUser(app, faculty, 'post', '/api/attendance/sessions', body);
  const deniedGet = await asUser(
    app,
    faculty,
    'get',
    `/api/attendance/sessions?subject_code=MCA402&session_date=${today}`,
  );
  const allowedAdmin = await asUser(app, admin, 'post', '/api/attendance/sessions', body);

  assert.equal(deniedPost.status, 403);
  assert.match(deniedPost.body.detail, /not assigned to subject/);
  assert.equal(deniedGet.status, 403);
  assert.equal(allowedAdmin.status, 200);
});

test('session list and status update expose existing entry schema and recompute totals', async () => {
  const faculty = makeUser('faculty', { assigned_subject_codes: ['MCA401'] });
  const entry = {
    _id: new ObjectId(),
    student_id: 'MCA001',
    subject_code: 'MCA401',
    subject_name: 'Algorithms',
    session_date: today,
    start_time: '09:00',
    status: 'absent',
    recorded_by: String(faculty._id),
    recorded_by_name: faculty.name,
    updated_at: new Date(),
  };
  const { app, attendanceCollection } = setup({
    users: [faculty],
    students: [studentOne],
    entries: [entry],
  });

  const session = await asUser(
    app,
    faculty,
    'get',
    `/api/attendance/sessions?subject_code=mca401&session_date=${today}`,
  );
  const update = await asUser(
    app,
    faculty,
    'patch',
    `/api/attendance/entries/${entry._id}`,
    { status: 'present' },
  );

  assert.equal(session.status, 200);
  assert.equal(session.body[0].student_name, 'Alex Student');
  assert.equal(session.body[0].id, String(entry._id));
  assert.equal(update.status, 200);
  assert.equal(update.body.status, 'present');
  assert.equal(attendanceCollection.documents[0].present_classes, 1);
});

test('entry update validates identifier and status, and reports missing entry', async () => {
  const admin = makeUser('admin');
  const { app } = setup({ users: [admin] });
  const invalidId = await asUser(
    app,
    admin,
    'patch',
    '/api/attendance/entries/not-an-object-id',
    { status: 'present' },
  );
  const invalidStatus = await asUser(
    app,
    admin,
    'patch',
    `/api/attendance/entries/${new ObjectId()}`,
    { status: 'late' },
  );
  const missing = await asUser(
    app,
    admin,
    'patch',
    `/api/attendance/entries/${new ObjectId()}`,
    { status: 'present' },
  );

  assert.equal(invalidId.status, 404);
  assert.equal(invalidStatus.status, 422);
  assert.equal(missing.status, 404);
});

test('staff attendance records and per-student report enforce role and subject filters', async () => {
  const faculty = makeUser('faculty', { assigned_subject_codes: ['MCA401'] });
  const student = makeUser('student', { student_id: 'MCA001' });
  const { app } = setup({
    users: [faculty, student],
    students: [studentOne],
    records: [
      { student_id: 'MCA001', subject_code: 'MCA401', subject_name: 'Assigned', total_classes: 2, present_classes: 1, is_demo: false },
      { student_id: 'MCA001', subject_code: 'MCA402', subject_name: 'Other', total_classes: 2, present_classes: 2, is_demo: false },
      { student_id: 'MCA001', subject_code: 'DEMO01', subject_name: 'Demo', total_classes: 1, present_classes: 1, is_demo: true },
    ],
  });

  const records = await asUser(app, faculty, 'get', '/api/attendance/records');
  const denied = await asUser(app, faculty, 'get', '/api/attendance/records?subject_code=MCA402');
  const report = await asUser(app, faculty, 'get', '/api/attendance/students/MCA001');
  const missing = await asUser(app, faculty, 'get', '/api/attendance/students/MCA999');
  const studentDenied = await asUser(app, student, 'get', '/api/attendance/records');

  assert.equal(records.status, 200);
  assert.equal(records.body.length, 1);
  assert.equal(records.body[0].student_name, 'Alex Student');
  assert.equal(denied.status, 403);
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.records.map((record) => record.subject_code), ['MCA401']);
  assert.equal(missing.status, 404);
  assert.equal(studentDenied.status, 403);
});

test('attendance endpoints return safe database errors and health does not connect', async () => {
  const student = makeUser('student', { student_id: 'MCA001' });
  const staff = makeUser('admin');
  const { app } = setup({
    users: [student, staff],
    students: [studentOne],
    failCollection: 'attendance',
  });

  const report = await asUser(app, student, 'get', '/api/attendance/me');
  const health = await request(app).get('/api/health');

  assert.equal(report.status, 503);
  assert.deepEqual(report.body, { detail: 'Database is unavailable' });
  assert.equal(JSON.stringify(report.body).includes('private database details'), false);
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
});
