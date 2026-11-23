const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');
const { currentWeekId } = require('../src/routes/notificationRoutes');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-notifications',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function user(role, studentId) {
  return {
    _id: new ObjectId(),
    name: `Test ${role}`,
    role,
    ...(studentId ? { student_id: studentId } : {}),
  };
}

function matches(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((condition) => matches(document, condition));
    const value = document[key];
    if (expected instanceof ObjectId) return value instanceof ObjectId && value.equals(expected);
    if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$ne')) {
      return value !== expected.$ne;
    }
    if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$in')) {
      return expected.$in.includes(value);
    }
    return value === expected;
  });
}

function makeCollection(initial = []) {
  const documents = [...initial];
  return {
    documents,
    async findOne(query) {
      return documents.find((document) => matches(document, query)) || null;
    },
    find(query = {}) {
      let items = documents.filter((document) => matches(document, query));
      const cursor = {
        sort(fields) {
          const [[field, direction]] = Object.entries(fields);
          items = [...items].sort((a, b) => (a[field] < b[field] ? direction : a[field] > b[field] ? -direction : 0));
          return cursor;
        },
        limit(count) {
          items = items.slice(0, count);
          return cursor;
        },
        async toArray() {
          return [...items];
        },
      };
      return cursor;
    },
    async insertOne(document) {
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const document = documents.find((item) => matches(item, query));
      if (!document) return { matchedCount: 0, modifiedCount: 0 };
      const changed = Object.entries(update.$set || {}).some(([key, value]) => document[key] !== value);
      Object.assign(document, update.$set || {});
      return { matchedCount: 1, modifiedCount: changed ? 1 : 0 };
    },
  };
}

function setup({ users = [], students = [], attendance = [], notifications = [], fail = false } = {}) {
  const userCollection = makeCollection(users);
  const studentCollection = makeCollection(students);
  const attendanceCollection = makeCollection(attendance);
  const notificationCollection = makeCollection(notifications);
  return {
    app: createApp({
      env: ENV,
      getUsersCollection: async () => userCollection,
      getStudentsCollection: async () => {
        if (fail) throw unavailable();
        return studentCollection;
      },
      getAttendanceCollection: async () => {
        if (fail) throw unavailable();
        return attendanceCollection;
      },
      getNotificationsCollection: async () => {
        if (fail) throw unavailable();
        return notificationCollection;
      },
    }),
    notificationCollection,
  };
}

function unavailable() {
  const error = new Error('private database details');
  error.statusCode = 503;
  error.code = 'MONGODB_UNAVAILABLE';
  return error;
}

function asUser(app, account, method, path) {
  const token = jwt.sign({}, ENV.JWT_SECRET, {
    algorithm: 'HS256',
    subject: account._id.toHexString(),
    expiresIn: '1h',
  });
  return request(app)[method](path).set('Authorization', `Bearer ${token}`);
}

const linkedRecord = { student_id: 'MCA001', name: 'Student', department: 'MCA', semester: '1' };

test('notification list is limited to the authenticated linked student', async () => {
  const student = user('student', 'MCA001');
  const item = {
    _id: new ObjectId(),
    student_id: 'MCA001',
    subject_code: 'MCA401',
    subject_name: 'Algorithms',
    attendance_percentage: 60,
    threshold: 75,
    week_id: '2026-W43',
    warning_type: 'low_attendance',
    title: 'Low attendance',
    message: 'Attendance is low.',
    reporting_date: '2026-10-26',
    created_at: new Date('2026-10-26T10:00:00Z'),
    is_read: false,
  };
  const { app } = setup({
    users: [student],
    students: [linkedRecord],
    notifications: [item, { ...item, _id: new ObjectId(), student_id: 'MCA002' }],
  });

  const response = await asUser(app, student, 'get', '/api/notifications');

  assert.equal(response.status, 200);
  assert.equal(response.body.linked, true);
  assert.equal(response.body.student_id, 'MCA001');
  assert.equal(response.body.unread_count, 1);
  assert.equal(response.body.notifications.length, 1);
  assert.equal(response.body.notifications[0].created_at, item.created_at.toISOString());
});

test('unlinked notification requests return an empty response and mark-read is forbidden', async () => {
  const student = user('student');
  const { app } = setup({ users: [student] });
  const list = await asUser(app, student, 'get', '/api/notifications');
  const mark = await asUser(app, student, 'patch', `/api/notifications/${new ObjectId()}/read`);
  assert.deepEqual(list.body, {
    linked: false,
    student_id: null,
    unread_count: 0,
    notifications: [],
  });
  assert.equal(mark.status, 403);
});

test('lost and found actions are visible and markable for their recipient user without a linked student profile', async () => {
  const student = user('student');
  const claimId = new ObjectId();
  const item = {
    _id: new ObjectId(),
    recipient_user_id: student._id,
    action_type: 'lost_found_claim',
    claim_id: claimId,
    match_id: new ObjectId(),
    lost_report_id: new ObjectId(),
    found_report_id: new ObjectId(),
    title: 'Lost and Found match request',
    message: 'Review a potential match.',
    created_at: new Date('2026-11-21T12:00:00Z'),
    is_read: false,
  };
  const { app, notificationCollection } = setup({
    users: [student],
    notifications: [item],
  });

  const listed = await asUser(app, student, 'get', '/api/notifications');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.linked, false);
  assert.equal(listed.body.notifications.length, 1);
  assert.equal(listed.body.notifications[0].action_type, 'lost_found_claim');
  assert.equal(listed.body.notifications[0].claim_id, String(claimId));
  assert.equal(listed.body.notifications[0].lost_report_id, String(item.lost_report_id));

  const marked = await asUser(app, student, 'patch', `/api/notifications/${item._id}/read`);
  assert.equal(marked.status, 200);
  assert.equal(notificationCollection.documents[0].is_read, true);
});

test('legacy Lost and Found notifications retain a route to incoming requests', async () => {
  const student = user('student');
  const item = {
    _id: new ObjectId(),
    recipient_user_id: student._id,
    warning_type: 'lost_found_match',
    title: 'Lost and Found match request',
    message: 'Review a potential match.',
    created_at: new Date('2026-11-21T12:00:00Z'),
    is_read: false,
  };
  const { app } = setup({
    users: [student],
    notifications: [item],
  });

  const listed = await asUser(app, student, 'get', '/api/notifications');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.notifications[0].action_type, 'lost_found_claim');
  assert.equal(listed.body.notifications[0].claim_id, '');
});

test('mark-read only updates a notification belonging to the signed-in student', async () => {
  const student = user('student', 'MCA001');
  const own = { _id: new ObjectId(), student_id: 'MCA001', is_read: false };
  const other = { _id: new ObjectId(), student_id: 'MCA002', is_read: false };
  const { app, notificationCollection } = setup({
    users: [student],
    students: [linkedRecord],
    notifications: [own, other],
  });
  const success = await asUser(app, student, 'patch', `/api/notifications/${own._id}/read`);
  const forbidden = await asUser(app, student, 'patch', `/api/notifications/${other._id}/read`);

  assert.equal(success.status, 200);
  assert.equal(notificationCollection.documents[0].is_read, true);
  assert.equal(forbidden.status, 404);
});

test('weekly attendance check creates warnings once and ignores demo records', async () => {
  const admin = user('admin');
  const records = [
    { student_id: 'MCA001', subject_code: 'MCA401', subject_name: 'Algorithms', total_classes: 4, present_classes: 1, is_demo: false },
    { student_id: 'MCA001', subject_code: 'DEMO1', total_classes: 1, present_classes: 0, is_demo: true },
    { student_id: 'MCA001', subject_code: 'MCA402', total_classes: 4, present_classes: 4, is_demo: false },
  ];
  const { app, notificationCollection } = setup({
    users: [admin],
    students: [linkedRecord],
    attendance: records,
  });

  const first = await asUser(app, admin, 'post', '/api/notifications/check-weekly?week_id=2026-W43');
  const second = await asUser(app, admin, 'post', '/api/notifications/check-weekly?week_id=2026-W43');

  assert.equal(first.status, 200);
  assert.equal(first.body.scanned_records, 2);
  assert.equal(first.body.generated_warnings, 1);
  assert.equal(second.body.generated_warnings, 0);
  assert.equal(second.body.duplicates_skipped, 1);
  assert.equal(notificationCollection.documents.length, 1);
  assert.equal(notificationCollection.documents[0].threshold, 75);
});

test('weekly check validates query and requires staff authentication', async () => {
  const student = user('student');
  const { app } = setup({ users: [student] });
  const noAuth = await request(app).post('/api/notifications/check-weekly');
  const denied = await asUser(app, student, 'post', '/api/notifications/check-weekly');
  const badThreshold = await asUser(app, student, 'post', '/api/notifications/check-weekly?threshold=101');
  assert.equal(noAuth.status, 401);
  assert.equal(denied.status, 403);
  assert.equal(badThreshold.status, 403);
});

test('weekly check rejects invalid query for admin and reports safe database failures', async () => {
  const admin = user('admin');
  const { app: validApp } = setup({ users: [admin] });
  const badQuery = await asUser(
    validApp,
    admin,
    'post',
    '/api/notifications/check-weekly?threshold=101&week_id=bad',
  );
  const { app: failingApp } = setup({ users: [admin], fail: true });
  const failure = await asUser(failingApp, admin, 'post', '/api/notifications/check-weekly');
  assert.equal(badQuery.status, 422);
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { detail: 'Database is unavailable' });
  assert.equal(currentWeekId(), /^\d{4}-W\d{2}$/.test(currentWeekId()) ? currentWeekId() : '');
});
