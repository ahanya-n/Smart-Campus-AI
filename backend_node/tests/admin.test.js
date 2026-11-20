const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');
const { verifyPassword } = require('../src/auth/passwords');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-admin-secret',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = document[key];
    if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected);
    if (expected && typeof expected === 'object') {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$ne') return actual !== value;
        if (operator === '$in') {
          return value.includes(actual) || (actual === undefined && value.includes(null));
        }
        if (operator === '$gt') return actual > value;
        if (operator === '$lt') return actual < value;
        if (operator === '$gte') return actual >= value;
        if (operator === '$exists') return Object.hasOwn(document, key) === value;
        return true;
      });
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
    find(query = {}) {
      let found = documents.filter((document) => matches(document, query));
      const cursor = {
        sort(fields) {
          const [[field, direction]] = Object.entries(fields);
          found = [...found].sort((a, b) => a[field].localeCompare(b[field]) * direction);
          return cursor;
        },
        async toArray() {
          return found.map(({ password, ...document }) => document);
        },
      };
      return cursor;
    },
    async insertOne(document) {
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id, acknowledged: true };
    },
    async updateOne(query, update) {
      let doc = documents.find((item) => matches(item, query));
      if (!doc && update.$set && arguments[2]?.upsert) {
        doc = { ...query, _id: new ObjectId() };
        documents.push(doc);
      }
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set || {});
      for (const [key, value] of Object.entries(update.$inc || {})) {
        doc[key] = (Number(doc[key]) || 0) + value;
      }
      for (const key of Object.keys(update.$unset || {})) delete doc[key];
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(query) {
      const index = documents.findIndex((doc) => matches(doc, query));
      if (index < 0) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
    async countDocuments(query = {}) {
      return documents.filter((doc) => matches(doc, query)).length;
    },
  };
}

function setup({
  users = [],
  students = [],
  subjects = [],
  classes = [],
  linkCodes = [],
  attendanceEntries = [],
  timetable = [],
  books = [],
  complaints = [],
  fail = false,
} = {}) {
  const userCollection = collection(users);
  const studentCollection = collection(students);
  const subjectCollection = collection(subjects);
  const classCollection = collection(classes);
  const linkCodeCollection = collection(linkCodes);
  const attendanceCollection = collection(attendanceEntries);
  const timetableCollection = collection(timetable);
  const bookCollection = collection(books);
  const complaintCollection = collection(complaints);
  const options = {
    env: ENV,
    getUsersCollection: async () => {
      if (fail) throw databaseFailure();
      return userCollection;
    },
    getStudentsCollection: async () => {
      if (fail) throw databaseFailure();
      return studentCollection;
    },
    getSubjectsCollection: async () => {
      if (fail) throw databaseFailure();
      return subjectCollection;
    },
    getClassesCollection: async () => {
      if (fail) throw databaseFailure();
      return classCollection;
    },
    getLinkCodesCollection: async () => {
      if (fail) throw databaseFailure();
      return linkCodeCollection;
    },
    getAttendanceEntriesCollection: async () => {
      if (fail) throw databaseFailure();
      return attendanceCollection;
    },
    getTimetableCollection: async () => {
      if (fail) throw databaseFailure();
      return timetableCollection;
    },
    getBooksCollection: async () => {
      if (fail) throw databaseFailure();
      return bookCollection;
    },
    getComplaintsCollection: async () => {
      if (fail) throw databaseFailure();
      return complaintCollection;
    },
  };
  return { app: createApp(options), userCollection, studentCollection, linkCodeCollection };
}

function databaseFailure() {
  const error = new Error('private database details');
  error.code = 'MONGODB_UNAVAILABLE';
  error.statusCode = 503;
  return error;
}

function account(role) {
  return {
    _id: new ObjectId(),
    name: `Test ${role}`,
    email: `${role}-${new ObjectId().toHexString()}@example.edu`,
    password: 'existing-hash',
    role,
  };
}

function callAs(app, user, method, path, body) {
  const token = jwt.sign({}, ENV.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user._id.toHexString(),
    expiresIn: '1h',
  });
  const call = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body === undefined ? call : call.send(body);
}

test('admin users list excludes password data and rejects non-admin roles', async () => {
  const admin = account('admin');
  const student = account('student');
  const faculty = {
    ...account('faculty'),
    faculty_id: 'DEMO-MCA-FAC-0001',
    department: 'MCA',
    designation: 'Assistant Professor',
    assigned_class_ids: ['DEMO-MCA-S1-A'],
  };
  const { app } = setup({ users: [admin, student, faculty] });

  const list = await callAs(app, admin, 'get', '/api/admin/users');
  const denied = await callAs(app, student, 'get', '/api/admin/users');

  assert.equal(list.status, 200);
  assert.equal(list.body.length, 3);
  const returnedFaculty = list.body.find((user) => user.role === 'faculty');
  assert.equal(Object.hasOwn(returnedFaculty, 'password'), false);
  assert.equal(returnedFaculty.faculty_id, faculty.faculty_id);
  assert.equal(returnedFaculty.department, faculty.department);
  assert.deepEqual(returnedFaculty.assigned_class_ids, faculty.assigned_class_ids);
  assert.equal(denied.status, 403);
});

test('admin creates an account with a compatible Argon2 hash and validates input', async () => {
  const admin = account('admin');
  const { app, userCollection } = setup({ users: [admin] });
  const body = {
    name: '  Faculty Member ',
    email: ' FACULTY@example.edu ',
    password: 'StrongPassword123',
    role: 'faculty',
  };
  const created = await callAs(app, admin, 'post', '/api/admin/users', body);
  const invalid = await callAs(app, admin, 'post', '/api/admin/users', {
    ...body,
    role: 'owner',
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.email, 'faculty@example.edu');
  assert.equal(created.body.name, 'Faculty Member');
  assert.deepEqual(created.body.assigned_subject_codes, []);
  assert.equal(await verifyPassword(body.password, userCollection.documents[1].password), true);
  assert.equal(invalid.status, 422);
});

test('admin updates roles and assigned subjects with safeguards', async () => {
  const admin = account('admin');
  const anotherAdmin = account('admin');
  const faculty = { ...account('faculty'), assigned_subject_codes: ['OLD101'] };
  const { app } = setup({ users: [admin, anotherAdmin, faculty] });

  const selfDemotion = await callAs(
    app,
    admin,
    'patch',
    `/api/admin/users/${admin._id}/role`,
    { role: 'student' },
  );
  const subjects = await callAs(
    app,
    admin,
    'put',
    `/api/admin/users/${faculty._id}/subjects`,
    { subject_codes: ['mca401', 'MCA401', 'CS-02'] },
  );
  const invalidSubject = await callAs(
    app,
    admin,
    'put',
    `/api/admin/users/${faculty._id}/subjects`,
    { subject_codes: ['bad code'] },
  );

  assert.equal(selfDemotion.status, 409);
  assert.deepEqual(subjects.body.assigned_subject_codes, ['MCA401', 'CS-02']);
  assert.equal(invalidSubject.status, 422);
});

test('admin linking/unlinking checks roles, student existence and uniqueness', async () => {
  const admin = account('admin');
  const student = account('student');
  const other = { ...account('student'), student_id: 'MCA001' };
  const faculty = account('faculty');
  const { app } = setup({
    users: [admin, student, other, faculty],
    students: [{ student_id: 'MCA001' }],
  });

  const duplicate = await callAs(app, admin, 'put', `/api/admin/users/${student._id}/student-link`, {
    student_id: 'MCA001',
  });
  const linked = await callAs(app, admin, 'put', `/api/admin/users/${student._id}/student-link`, {
    student_id: 'MCA002',
  });
  const unlinked = await callAs(app, admin, 'put', `/api/admin/users/${student._id}/student-link`, {
    student_id: null,
  });
  const invalidRole = await callAs(app, admin, 'put', `/api/admin/users/${faculty._id}/student-link`, {
    student_id: 'MCA001',
  });
  assert.equal(duplicate.status, 409);
  assert.equal(linked.status, 404);
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.student_id, null);
  assert.equal(invalidRole.status, 409);
});

test('admin issues one-time student link codes without storing plaintext', async () => {
  const admin = account('admin');
  const { app, linkCodeCollection } = setup({
    users: [admin],
    students: [{ student_id: 'MCA001' }],
  });

  const response = await callAs(app, admin, 'post', '/api/admin/students/MCA001/link-code');

  assert.equal(response.status, 201);
  assert.match(response.body.link_code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(response.body.expires_at !== undefined, true);
  assert.equal(linkCodeCollection.documents[0].code_hash, crypto
    .createHash('sha256')
    .update(response.body.link_code)
    .digest('hex'));
  assert.equal(Object.hasOwn(linkCodeCollection.documents[0], 'link_code'), false);
});

test('student redeems one-time code, wrong attempts are counted, and code is consumed', async () => {
  const student = account('student');
  const code = 'ABC234DEFG';
  const expiresAt = new Date(Date.now() + 60_000);
  const linkCode = {
    _id: new ObjectId(),
    student_id: 'MCA001',
    code_hash: crypto.createHash('sha256').update(code).digest('hex'),
    expires_at: expiresAt,
    attempts: 0,
  };
  const { app, userCollection, linkCodeCollection } = setup({
    users: [student],
    students: [{ student_id: 'MCA001' }],
    linkCodes: [linkCode],
  });
  const wrong = await callAs(app, student, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA001',
    link_code: 'WRONG12345',
  });
  assert.equal(wrong.status, 400);
  assert.equal(linkCodeCollection.documents[0].attempts, 1);
  const linked = await callAs(app, student, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA001',
    link_code: ` ${code.toLowerCase()} `,
  });

  assert.equal(linked.status, 200);
  assert.equal(linked.body.student_id, 'MCA001');
  assert.equal(linkCodeCollection.documents.length, 0);
  assert.equal(userCollection.documents[0].student_id, 'MCA001');
  assert.equal(userCollection.documents[0].name, student.name);
  assert.equal(userCollection.documents[0].email, student.email);
  assert.equal(userCollection.documents[0].password, student.password);
  const anotherStudent = account('student');
  userCollection.documents.push(anotherStudent);
  const reused = await callAs(app, anotherStudent, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA001',
    link_code: code,
  });
  assert.equal(reused.status, 400);
});

test('link-code redemption rejects expired, exhausted, used, and already-linked attempts', async () => {
  const student = account('student');
  const exhaustedCode = {
    _id: new ObjectId(),
    student_id: 'MCA001',
    code_hash: 'not-a-matching-hash',
    expires_at: new Date(Date.now() + 60_000),
    attempts: 4,
  };
  const { app, linkCodeCollection } = setup({
    users: [student],
    students: [{ student_id: 'MCA001' }],
    linkCodes: [exhaustedCode],
  });
  const exhausted = await callAs(app, student, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA001',
    link_code: 'WRONG12345',
  });
  assert.equal(exhausted.status, 400);
  assert.equal(linkCodeCollection.documents.length, 0);

  const expiredCode = {
    _id: new ObjectId(),
    student_id: 'MCA001',
    code_hash: crypto.createHash('sha256').update('ABC234DEFG').digest('hex'),
    expires_at: new Date(Date.now() - 60_000),
    attempts: 0,
  };
  const expiredApp = setup({
    users: [student],
    students: [{ student_id: 'MCA001' }],
    linkCodes: [expiredCode],
  }).app;
  const expired = await callAs(expiredApp, student, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA001',
    link_code: 'ABC234DEFG',
  });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.detail, 'Invalid or expired link code');

  const linkedStudent = { ...student, student_id: 'MCA001' };
  const linkedApp = setup({ users: [linkedStudent] }).app;
  const alreadyLinked = await callAs(linkedApp, linkedStudent, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA001',
    link_code: 'ABC234DEFG',
  });
  assert.equal(alreadyLinked.status, 409);
});

test('student link code must match its issued student and requests require authentication', async () => {
  const student = account('student');
  const code = 'ABC234DEFG';
  const linkCodes = [{
    _id: new ObjectId(),
    student_id: 'MCA001',
    code_hash: crypto.createHash('sha256').update(code).digest('hex'),
    expires_at: new Date(Date.now() + 60_000),
    attempts: 0,
  }];
  const { app, userCollection } = setup({
    users: [student],
    students: [{ student_id: 'MCA001' }, { student_id: 'MCA002' }],
    linkCodes,
  });
  const unauthenticated = await request(app)
    .post('/api/auth/me/link-student')
    .send({ student_id: 'MCA001', link_code: code });
  const mismatched = await callAs(app, student, 'post', '/api/auth/me/link-student', {
    student_id: 'MCA002',
    link_code: code,
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(mismatched.status, 400);
  assert.equal(userCollection.documents[0].student_id, undefined);
});

test('admin stats aggregate existing module collections and protect access', async () => {
  const admin = account('admin');
  const student = account('student');
  const { app } = setup({
    users: [admin, student, account('faculty')],
    students: [{ student_id: 'MCA001' }],
    subjects: [{ subject_code: 'MCA101' }],
    classes: [{ class_id: 'MCA-S1-A' }],
    attendanceEntries: [{ student_id: 'MCA001' }, { student_id: 'MCA001' }],
    timetable: [{ is_demo: false }],
    books: [{ isbn: 'book-1' }],
    complaints: [{ status: 'pending' }],
  });
  const stats = await callAs(app, admin, 'get', '/api/admin/stats');
  const denied = await callAs(app, student, 'get', '/api/admin/stats');
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body, {
    total_students: 1,
    total_faculty: 1,
    total_users: 3,
    total_subjects: 1,
    total_classes: 1,
    total_attendance_sessions: 2,
    total_classes_scheduled: 1,
    total_books: 1,
    pending_complaints: 1,
  });
  assert.equal(denied.status, 403);
});

test('admin and link-code routes hide database errors', async () => {
  const admin = account('admin');
  const { app } = setup({ users: [admin], fail: true });
  const response = await callAs(app, admin, 'get', '/api/admin/users');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { detail: 'Database is unavailable' });
  assert.equal(JSON.stringify(response.body).includes('private database details'), false);
});
