const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/auth/passwords');
const { createAuthMiddleware } = require('../src/middleware/auth');

const TEST_ENV = {
  JWT_SECRET: 'test-only-secret-for-smart-campus-auth',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};
const PYTHON_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$LW6tMLj0smIX0JuzPMDhvA$ohG+jAKl6MoalS7L4Rootr93i/yMW8TE1lJqC8JvJ24';
const COMPATIBILITY_PASSWORD = 'phase2b-compatibility-check';

function createUserCollection(initialUsers = []) {
  const users = [...initialUsers];

  return {
    users,
    async findOne(query) {
      if (query._id) {
        const id = query._id.toHexString();
        return users.find((user) => user._id.toHexString() === id) || null;
      }

      const emails = query.email?.$in || [];
      return users.find((user) => emails.includes(user.email)) || null;
    },
    async insertOne(document) {
      if (users.some((user) => user.email === document.email)) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      const user = { ...document, _id: new ObjectId() };
      users.push(user);
      return { acknowledged: true, insertedId: user._id };
    },
  };
}

function createTestApp(collection = createUserCollection(), env = TEST_ENV) {
  return createApp({ env, getUsersCollection: () => collection });
}

function tokenFor(userId, overrides = {}) {
  return jwt.sign(
    { ...overrides },
    TEST_ENV.JWT_SECRET,
    { algorithm: 'HS256', subject: userId, expiresIn: '1h' },
  );
}

test('verifies a hash created by the existing FastAPI pwdlib Argon2id defaults', async () => {
  assert.equal(
    await verifyPassword(COMPATIBILITY_PASSWORD, PYTHON_ARGON2_HASH),
    true,
  );
  assert.equal(await verifyPassword('wrong-password', PYTHON_ARGON2_HASH), false);
});

test('registration hashes the password and always creates a student account', async () => {
  const collection = createUserCollection();
  const app = createTestApp(collection);
  const response = await request(app).post('/api/auth/register').send({
    name: '  Alex Student  ',
    email: ' Alex@Example.edu ',
    password: 'StrongPassword123',
    role: 'admin',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: 'User registered successfully' });
  assert.equal(collection.users.length, 1);
  assert.equal(collection.users[0].name, 'Alex Student');
  assert.equal(collection.users[0].email, 'alex@example.edu');
  assert.equal(collection.users[0].role, 'student');
  assert.notEqual(collection.users[0].password, 'StrongPassword123');
  assert.equal(
    await verifyPassword('StrongPassword123', collection.users[0].password),
    true,
  );
});

test('registration rejects invalid input and duplicate email', async () => {
  const collection = createUserCollection();
  const app = createTestApp(collection);
  const invalid = await request(app).post('/api/auth/register').send({
    name: 'No',
    email: 'not-an-email',
    password: 'short',
  });
  assert.equal(invalid.status, 422);

  const body = {
    name: 'Student',
    email: 'student@example.edu',
    password: 'StrongPassword123',
  };
  assert.equal((await request(app).post('/api/auth/register').send(body)).status, 200);
  const duplicate = await request(app)
    .post('/api/auth/register')
    .send({ ...body, email: 'STUDENT@example.edu' });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.detail, 'Email already registered');
  assert.equal(collection.users.length, 1);
});

test('registration safely handles a duplicate-key race', async () => {
  const collection = {
    async findOne() {
      return null;
    },
    async insertOne() {
      const error = new Error('duplicate key details must not be exposed');
      error.code = 11000;
      throw error;
    },
  };

  const response = await request(createTestApp(collection))
    .post('/api/auth/register')
    .send({
      name: 'Student',
      email: 'student@example.edu',
      password: 'StrongPassword123',
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { detail: 'Email already registered' });
});

test('login returns a compatible HS256 token for valid credentials', async () => {
  const collection = createUserCollection();
  const password = 'StrongPassword123';
  const user = {
    _id: new ObjectId(),
    name: 'Morgan Faculty',
    email: 'morgan@example.edu',
    password: await hashPassword(password),
    role: 'faculty',
    assigned_subject_codes: ['MCA401'],
  };
  collection.users.push(user);

  const response = await request(createTestApp(collection))
    .post('/api/auth/login')
    .send({ email: 'MORGAN@example.edu', password });

  assert.equal(response.status, 200);
  assert.equal(response.body.token_type, 'bearer');
  const payload = jwt.verify(response.body.access_token, TEST_ENV.JWT_SECRET, {
    algorithms: ['HS256'],
  });
  assert.equal(payload.sub, user._id.toHexString());
  assert.equal(typeof payload.iat, 'number');
  assert.equal(typeof payload.exp, 'number');
});

test('login rejects wrong passwords and unknown accounts uniformly', async () => {
  const collection = createUserCollection([{
    _id: new ObjectId(),
    name: 'Student',
    email: 'student@example.edu',
    password: await hashPassword('StrongPassword123'),
    role: 'student',
  }]);
  const app = createTestApp(collection);

  const wrongPassword = await request(app)
    .post('/api/auth/login')
    .send({ email: 'student@example.edu', password: 'WrongPassword123' });
  const unknownUser = await request(app)
    .post('/api/auth/login')
    .send({ email: 'unknown@example.edu', password: 'WrongPassword123' });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.deepEqual(wrongPassword.body, unknownUser.body);
  assert.equal(wrongPassword.body.detail, 'Incorrect email or password');
});

test('current-user endpoint requires a valid token and never exposes the hash', async () => {
  const user = {
    _id: new ObjectId(),
    name: 'Student',
    email: 'student@example.edu',
    password: await hashPassword('StrongPassword123'),
    role: 'student',
    student_id: 'MCA001',
  };
  const app = createTestApp(createUserCollection([user]));
  const token = tokenFor(user._id.toHexString());

  const unauthenticated = await request(app).get('/api/auth/me');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.detail, 'Not authenticated');

  const profile = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(profile.status, 200);
  assert.deepEqual(profile.body, {
    name: 'Student',
    email: 'student@example.edu',
    role: 'student',
    student_id: 'MCA001',
    assigned_subject_codes: [],
  });
  assert.equal(JSON.stringify(profile.body).includes(user.password), false);
});

test('authentication rejects expired tokens and missing users', async () => {
  const collection = createUserCollection();
  const app = createTestApp(collection);
  const expiredToken = jwt.sign(
    { sub: new ObjectId().toHexString(), iat: 1, exp: 2 },
    TEST_ENV.JWT_SECRET,
    { algorithm: 'HS256' },
  );
  const expired = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${expiredToken}`);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.detail, 'Token has expired');

  const missing = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${tokenFor(new ObjectId().toHexString())}`);
  assert.equal(missing.status, 401);
  assert.equal(missing.body.detail, 'User not found');
});

test('role middleware permits allowed roles and rejects disallowed roles', async () => {
  const collection = createUserCollection();
  const student = { _id: new ObjectId(), role: 'student' };
  const faculty = { _id: new ObjectId(), role: 'faculty' };
  const admin = { _id: new ObjectId(), role: 'admin' };
  collection.users.push(student, faculty, admin);

  const app = createTestApp(collection);
  const { authenticate, requireRoles } = createAuthMiddleware({
    env: TEST_ENV,
    getUsersCollection: () => collection,
  });
  app.get('/test/student', authenticate, requireRoles('student'), (_req, res) => {
    res.json({ allowed: true });
  });
  app.get('/test/faculty', authenticate, requireRoles('faculty', 'admin'), (_req, res) => {
    res.json({ allowed: true });
  });
  app.get('/test/admin', authenticate, requireRoles('admin'), (_req, res) => {
    res.json({ allowed: true });
  });

  const callWith = (path, user) =>
    request(app)
      .get(path)
      .set('Authorization', `Bearer ${tokenFor(user._id.toHexString())}`);

  assert.equal((await callWith('/test/student', student)).status, 200);
  assert.equal((await callWith('/test/student', faculty)).status, 403);
  assert.equal((await callWith('/test/faculty', faculty)).status, 200);
  assert.equal((await callWith('/test/faculty', admin)).status, 200);
  assert.equal((await callWith('/test/admin', student)).status, 403);
  assert.equal((await callWith('/test/admin', student)).body.detail, 'This action requires the admin role.');
  assert.equal((await callWith('/test/admin', admin)).status, 200);
});

test('JWT configuration fails closed when unset or unsupported', async () => {
  const collection = createUserCollection();
  const unset = await request(createTestApp(collection, {}))
    .post('/api/auth/login')
    .send({ email: 'student@example.edu', password: 'StrongPassword123' });
  assert.equal(unset.status, 500);
  assert.equal(unset.body.detail, 'JWT_SECRET is not configured');

  const unsupported = await request(createTestApp(collection, {
    ...TEST_ENV,
    JWT_ALGORITHM: 'none',
  }))
    .post('/api/auth/login')
    .send({ email: 'student@example.edu', password: 'StrongPassword123' });
  assert.equal(unsupported.status, 500);
  assert.equal(unsupported.body.detail, 'JWT_ALGORITHM must be HS256');
});

test('health check remains database independent', async () => {
  const response = await request(createTestApp(createUserCollection())).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('authentication returns a safe service error when MongoDB is unavailable', async () => {
  const connectionFailure = new Error('private connection details');
  connectionFailure.statusCode = 503;
  connectionFailure.code = 'MONGODB_UNAVAILABLE';
  const app = createApp({
    env: TEST_ENV,
    getUsersCollection: async () => {
      throw connectionFailure;
    },
  });

  const registration = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Student',
      email: 'student@example.edu',
      password: 'StrongPassword123',
    });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'student@example.edu', password: 'StrongPassword123' });
  const profile = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${tokenFor(new ObjectId().toHexString())}`);

  for (const response of [registration, login, profile]) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { detail: 'Database is unavailable' });
    assert.equal(JSON.stringify(response.body).includes('private connection details'), false);
  }
});

test('registration reports missing MongoDB configuration without exposing internals', async () => {
  const app = createApp({ env: TEST_ENV });
  const response = await request(app)
    .post('/api/auth/register')
    .send({
      name: 'Student',
      email: 'student@example.edu',
      password: 'StrongPassword123',
    });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    detail: 'Database is not configured. Set MONGO_URI and MONGO_DB_NAME in backend_node/.env.',
  });
});
