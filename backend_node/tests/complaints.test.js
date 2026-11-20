const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-complaints-secret',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function getPath(document, path) {
  return path.split('.').reduce((value, part) => value?.[part], document);
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((condition) => matches(document, condition));
    const actual = getPath(document, key);
    if (expected instanceof ObjectId) {
      return actual instanceof ObjectId && actual.equals(expected);
    }
    if (expected && typeof expected === 'object') {
      if (Object.hasOwn(expected, '$in')) {
        return expected.$in.includes(actual);
      }
      if (Object.hasOwn(expected, '$regex')) {
        return new RegExp(expected.$regex, expected.$options).test(String(actual || ''));
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
    async createIndex() {},
    async findOne(query) {
      return documents.find((document) => matches(document, query)) || null;
    },
    find(query = {}) {
      let found = documents.filter((document) => matches(document, query));
      const cursor = {
        sort(order) {
          const [[field, direction]] = Object.entries(order);
          found.sort((left, right) =>
            String(left[field] ?? '').localeCompare(String(right[field] ?? '')) * direction);
          return cursor;
        },
        skip(count) {
          found = found.slice(count);
          return cursor;
        },
        limit(count) {
          found = found.slice(0, count);
          return cursor;
        },
        async toArray() { return found; },
      };
      return cursor;
    },
    async countDocuments(query) {
      return documents.filter((document) => matches(document, query)).length;
    },
    async insertOne(document) {
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const saved = documents.find((document) => matches(document, query));
      if (!saved) return { matchedCount: 0 };
      Object.assign(saved, update.$set || {});
      for (const [field, value] of Object.entries(update.$push || {})) {
        saved[field] = [...(saved[field] || []), value];
      }
      return { matchedCount: 1 };
    },
  };
}

function user(role, values = {}) {
  return {
    _id: new ObjectId(),
    name: `Synthetic ${role}`,
    email: `${role}@complaints.test`,
    role,
    ...values,
  };
}

function complaint(owner, overrides = {}) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    user_id: owner._id,
    student_id: owner.student_id || null,
    student_name: owner.name,
    student_email: owner.email,
    category: 'facilities',
    title: 'Broken classroom projector',
    description: 'The projector in room A101 does not turn on.',
    status: 'pending',
    assigned_to: null,
    assigned_staff_name: null,
    resolution_notes: null,
    responses: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function setup(users, complaints = []) {
  const userCollection = collection(users);
  const complaintCollection = collection(complaints);
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => userCollection,
    getComplaintsCollection: async () => complaintCollection,
  });
  return { app, complaintCollection };
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

const input = {
  category: 'facilities',
  title: 'Broken classroom projector',
  description: 'The projector in room A101 does not turn on.',
};

test('student can submit and view only their own complaints', async () => {
  const student = user('student', { student_id: 'SYN-COMPLAINT-1' });
  const other = user('student', { student_id: 'SYN-COMPLAINT-2' });
  const otherComplaint = complaint(other, { title: 'Other student issue' });
  const { app, complaintCollection } = setup([student, other], [otherComplaint]);

  const created = await asUser(app, student, 'post', '/api/complaints', input);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.student_id, student.student_id);
  assert.equal(complaintCollection.documents.length, 2);

  const listed = await asUser(app, student, 'get', '/api/complaints');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.items[0].id, created.body.id);
  const privateDetail = await asUser(
    app, student, 'get', `/api/complaints/${otherComplaint._id}`,
  );
  assert.equal(privateDetail.status, 404);
});

test('admin can search, filter, assign, change status and respond', async () => {
  const admin = user('admin');
  const student = user('student');
  const faculty = user('faculty');
  const saved = complaint(student);
  const { app, complaintCollection } = setup([admin, faculty], [saved]);

  const filtered = await asUser(
    app, admin, 'get', '/api/complaints?search=PROJECTOR&category=facilities',
  );
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.deepEqual((await asUser(app, admin, 'get', '/api/complaints/stats')).body, {
    total: 1, pending: 1, in_progress: 0, resolved: 0, rejected: 0,
  });

  const id = saved._id.toHexString();
  const updated = await asUser(app, admin, 'patch', `/api/complaints/${id}`, {
    assigned_to: faculty._id.toHexString(),
    status: 'in_progress',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.assigned_staff_name, faculty.name);
  assert.equal(updated.body.status, 'in_progress');

  const posted = await asUser(app, admin, 'post', `/api/complaints/${id}/responses`, {
    message: 'A technician has been notified.',
    resolution_notes: 'Replacement approved.',
  });
  assert.equal(posted.status, 201);
  const detail = await asUser(app, admin, 'get', `/api/complaints/${id}`);
  assert.equal(detail.body.responses[0].message, 'A technician has been notified.');
  assert.equal(detail.body.resolution_notes, 'Replacement approved.');
  assert.equal(complaintCollection.documents[0].status, 'in_progress');
});

test('complaints enforce role permissions and validate input and updates', async () => {
  const student = user('student');
  const faculty = user('faculty');
  const admin = user('admin');
  const saved = complaint(student);
  const { app } = setup([student, faculty, admin], [saved]);

  assert.equal((await asUser(app, student, 'post', '/api/complaints', {
    ...input, title: ' ',
  })).status, 422);
  assert.equal((await asUser(app, student, 'post', '/api/complaints', {
    ...input, category: 'unknown',
  })).status, 422);
  assert.equal((await asUser(app, faculty, 'get', '/api/complaints')).status, 403);
  assert.equal((await asUser(app, faculty, 'post', '/api/complaints', input)).status, 403);
  assert.equal((await asUser(
    app, student, 'patch', `/api/complaints/${saved._id}`, { status: 'resolved' },
  )).status, 403);
  assert.equal((await asUser(
    app, admin, 'patch', `/api/complaints/${saved._id}`, { status: 'invalid' },
  )).status, 422);
  assert.equal((await asUser(
    app, admin, 'patch', `/api/complaints/${saved._id}`, { assigned_to: 'bad-id' },
  )).status, 422);
});
