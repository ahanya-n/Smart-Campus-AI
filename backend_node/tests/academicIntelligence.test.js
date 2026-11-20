const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const ENV = {
  JWT_SECRET: 'test-only-academic-intelligence',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
  FASTAPI_BASE_URL: 'http://fastapi.test',
};

function setup(fetchAcademicIntelligence) {
  const account = {
    _id: new ObjectId(),
    name: 'Synthetic Student',
    role: 'student',
    student_id: 'DEMO-ACADEMIC-1',
  };
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => ({
      findOne: async (query) => query._id.equals(account._id) ? account : null,
    }),
    fetchAcademicIntelligence,
  });
  const token = jwt.sign({}, ENV.JWT_SECRET, {
    algorithm: 'HS256',
    subject: account._id.toHexString(),
    expiresIn: '1h',
  });
  return { app, token };
}

function upstream(status, payload) {
  return {
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
  };
}

test('authenticated academic API requests proxy to FastAPI without duplicating data logic', async () => {
  let forwarded;
  const { app, token } = setup(async (url, options) => {
    forwarded = { url: String(url), options };
    return upstream(200, { risk_level: 'medium' });
  });

  const response = await request(app)
    .post('/api/academic-intelligence/mentor?source=student')
    .set('Authorization', `Bearer ${token}`)
    .send({ message: 'Create a 7-day study plan' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { risk_level: 'medium' });
  assert.equal(
    forwarded.url,
    'http://fastapi.test/academic-intelligence/mentor?source=student',
  );
  assert.equal(forwarded.options.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(forwarded.options.body), { message: 'Create a 7-day study plan' });
});

test('academic proxy requires authentication and reports unavailable upstream explicitly', async () => {
  let called = false;
  const { app, token } = setup(async () => {
    called = true;
    throw new Error('upstream unavailable');
  });

  const unauthenticated = await request(app).get('/api/academic-intelligence/overview');
  const unavailable = await request(app)
    .get('/api/academic-intelligence/overview')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(unauthenticated.status, 401);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.detail, 'Academic intelligence service is unavailable.');
  assert.equal(called, true);
});

test('academic proxy preserves FastAPI validation and authorization responses', async () => {
  const { app, token } = setup(async () => upstream(422, { detail: 'message is required' }));

  const response = await request(app)
    .post('/api/academic-intelligence/mentor')
    .set('Authorization', `Bearer ${token}`)
    .send({});

  assert.equal(response.status, 422);
  assert.deepEqual(response.body, { detail: 'message is required' });
});
