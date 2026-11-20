const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-timetable-secret',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function user(role, values = {}) {
  return { _id: new ObjectId(), name: `Test ${role}`, role, ...values };
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((condition) => matches(document, condition));
    const actual = document[key];
    if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected);
    if (expected && typeof expected === 'object') {
      if (Object.hasOwn(expected, '$ne')) {
        if (actual === expected.$ne) return false;
      }
      if (Object.hasOwn(expected, '$in')) {
        if (!expected.$in.includes(actual)) return false;
      }
      if (Object.hasOwn(expected, '$lt')) {
        if (!(actual < expected.$lt)) return false;
      }
      if (Object.hasOwn(expected, '$gt')) {
        if (!(actual > expected.$gt)) return false;
      }
      return true;
    }
    return actual === expected;
  });
}

function collection(initial = []) {
  const documents = [...initial];
  return {
    documents,
    async findOne(query) {
      return documents.find((document) => matches(document, query)) || null;
    },
    find(query) {
      return { toArray: async () => documents.filter((document) => matches(document, query)) };
    },
    async insertOne(document) {
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const existing = documents.find((document) => matches(document, query));
      if (existing) Object.assign(existing, update.$set);
    },
    async deleteOne(query) {
      const index = documents.findIndex((document) => matches(document, query));
      if (index >= 0) documents.splice(index, 1);
    },
  };
}

function setup(accounts = [], students = [], timetable = []) {
  const users = collection(accounts);
  const studentCollection = collection(students);
  const timetableCollection = collection(timetable);
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => users,
    getStudentsCollection: async () => studentCollection,
    getTimetableCollection: async () => timetableCollection,
  });
  return { app, timetableCollection };
}

function asUser(app, account, method, path, body) {
  const token = jwt.sign({}, ENV.JWT_SECRET, {
    algorithm: 'HS256',
    subject: account._id.toHexString(),
    expiresIn: '1h',
  });
  const call = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body === undefined ? call : call.send(body);
}

function input(overrides = {}) {
  return {
    department: 'MCA',
    semester: 1,
    day_of_week: 'Monday',
    subject_code: 'MCA401',
    subject_name: 'Algorithms',
    start_time: '09:00',
    end_time: '10:00',
    faculty_name: 'Dr Turing',
    room_number: 'A101',
    ...overrides,
  };
}

test('student timetable is scoped to the linked class group and omits demo records', async () => {
  const student = user('student', { student_id: 'MCA001' });
  const entries = [
    { _id: new ObjectId(), ...input(), is_demo: false },
    { _id: new ObjectId(), ...input({ department: 'BCA' }), is_demo: false },
    { _id: new ObjectId(), ...input({ subject_code: 'DEMO101' }), is_demo: true },
  ];
  const { app } = setup([student], [{
    student_id: 'MCA001', department: 'MCA', semester: '1', name: 'Student One',
  }], entries);

  const response = await asUser(app, student, 'get', '/api/timetable?day=Monday');

  assert.equal(response.status, 200);
  assert.equal(response.body.scope, 'student');
  assert.equal(response.body.entries.length, 1);
  assert.equal(response.body.entries[0].subject_code, 'MCA401');
});

test('seeded demo accounts see only their assigned synthetic timetable', async () => {
  const marker = 'smart-campus-local-demo-v1';
  const student = user('student', {
    student_id: 'DEMO-STUDENT-1',
    local_demo_seed: marker,
  });
  const faculty = user('faculty', {
    assigned_subject_codes: ['DEMO101'],
    local_demo_seed: marker,
  });
  const studentProfile = {
    student_id: student.student_id,
    name: 'Demo Student',
    department: 'DEMO',
    semester: 1,
    local_demo_seed: marker,
    is_demo: true,
    synthetic_demo: true,
  };
  const entries = [
    {
      _id: new ObjectId(),
      ...input({ department: 'DEMO', subject_code: 'DEMO101' }),
      faculty_user_id: String(faculty._id),
      is_demo: true,
      synthetic_demo: true,
    },
    {
      _id: new ObjectId(),
      ...input({ department: 'DEMO', subject_code: 'DEMO102' }),
      faculty_user_id: 'other-faculty',
      is_demo: true,
      synthetic_demo: true,
    },
    { _id: new ObjectId(), ...input({ department: 'DEMO' }), is_demo: false },
  ];
  const { app } = setup([student, faculty], [studentProfile], entries);

  const studentResponse = await asUser(app, student, 'get', '/api/timetable?day=Monday');
  const facultyResponse = await asUser(app, faculty, 'get', '/api/timetable?day=Monday');

  assert.equal(studentResponse.status, 200);
  assert.equal(studentResponse.body.is_demo, true);
  assert.deepEqual(studentResponse.body.entries.map((entry) => entry.subject_code), ['DEMO101', 'DEMO102']);
  assert.equal(facultyResponse.status, 200);
  assert.equal(facultyResponse.body.is_demo, true);
  assert.deepEqual(facultyResponse.body.entries.map((entry) => entry.subject_code), ['DEMO101']);
});

test('Sunday timetable query returns an empty schedule rather than a validation error', async () => {
  const admin = user('admin');
  const { app } = setup([admin]);

  const response = await asUser(app, admin, 'get', '/api/timetable?day=Sunday');

  assert.equal(response.status, 200);
  assert.equal(response.body.day, 'Sunday');
  assert.deepEqual(response.body.entries, []);
});

test('admin can create, retrieve, update and delete official timetable entries', async () => {
  const admin = user('admin');
  const { app, timetableCollection } = setup([admin]);

  const created = await asUser(app, admin, 'post', '/api/timetable', input());
  assert.equal(created.status, 201);
  assert.equal(created.body.subject_code, 'MCA401');
  const id = created.body.id;

  const retrieved = await asUser(app, admin, 'get', '/api/timetable?day=Monday&department=MCA&semester=1');
  assert.equal(retrieved.status, 200);
  assert.equal(retrieved.body.entries[0].id, id);

  const updated = await asUser(app, admin, 'put', `/api/timetable/${id}`, input({
    room_number: 'B203',
  }));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.room_number, 'B203');

  const deleted = await asUser(app, admin, 'delete', `/api/timetable/${id}`);
  assert.equal(deleted.status, 204);
  assert.equal(timetableCollection.documents.length, 0);
});

test('faculty timetable is limited to taught or assigned subject entries', async () => {
  const faculty = user('faculty', { assigned_subject_codes: ['MCA401'] });
  const own = { _id: new ObjectId(), ...input(), faculty_user_id: String(faculty._id), is_demo: false };
  const unrelated = { _id: new ObjectId(), ...input({ subject_code: 'MCA402' }), faculty_user_id: 'other', is_demo: false };
  const { app } = setup([faculty], [], [own, unrelated]);

  const response = await asUser(app, faculty, 'get', '/api/timetable');

  assert.equal(response.status, 200);
  assert.equal(response.body.entries.length, 1);
  assert.equal(response.body.entries[0].subject_code, 'MCA401');
});

test('students cannot create timetable entries and missing auth is rejected', async () => {
  const student = user('student');
  const { app } = setup([student]);
  const noAuth = await request(app).get('/api/timetable');
  const denied = await asUser(app, student, 'post', '/api/timetable', input());
  assert.equal(noAuth.status, 401);
  assert.equal(denied.status, 403);
});

test('timetable input validation rejects invalid times and semester', async () => {
  const admin = user('admin');
  const { app } = setup([admin]);
  const badTime = await asUser(app, admin, 'post', '/api/timetable', input({
    start_time: '10:00',
    end_time: '09:00',
  }));
  const badSemester = await asUser(app, admin, 'post', '/api/timetable', input({
    semester: 13,
  }));
  assert.equal(badTime.status, 422);
  assert.equal(badSemester.status, 422);
});

test('timetable rejects overlapping classes and prevents editing demo entries', async () => {
  const admin = user('admin');
  const existing = { _id: new ObjectId(), ...input(), is_demo: false };
  const demo = { _id: new ObjectId(), ...input({ subject_code: 'DEMO101' }), is_demo: true };
  const { app } = setup([admin], [], [existing, demo]);
  const conflict = await asUser(app, admin, 'post', '/api/timetable', input({
    start_time: '09:30',
    end_time: '10:30',
    room_number: 'A101',
    department: 'BCA',
  }));
  const readonly = await asUser(app, admin, 'delete', `/api/timetable/${demo._id}`);
  assert.equal(conflict.status, 409);
  assert.equal(readonly.status, 409);
});

test('timetable routes return safe database failures', async () => {
  const student = user('student', { student_id: 'MCA001' });
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => collection([student]),
    getStudentsCollection: async () => collection([
      { student_id: 'MCA001', department: 'MCA', semester: '1' },
    ]),
    getTimetableCollection: async () => {
      const error = new Error('private database details');
      error.code = 'MONGODB_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    },
  });
  const response = await asUser(app, student, 'get', '/api/timetable');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { detail: 'Database is unavailable' });
});
