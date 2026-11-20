const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-assistant',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
  FASTAPI_BASE_URL: 'http://fastapi.test',
};

function setup(fetchAssistant) {
  const account = {
    _id: new ObjectId(),
    name: 'Synthetic Student',
    role: 'student',
    student_id: 'TEST-STUDENT',
  };
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => ({
      findOne: async (query) => query._id.equals(account._id) ? account : null,
    }),
    fetchAssistant,
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

test('assistant requests proxy to FastAPI with the authenticated context', async () => {
  let forwarded;
  const { app, token } = setup(async (url, options) => {
    forwarded = { url: String(url), options };
    return upstream(200, {
      reply: 'Your verified attendance is 80%.',
      provider: 'grounded_rule_engine',
    });
  });

  const response = await request(app)
    .post('/api/assistant/chat?demo=false')
    .set('Authorization', `Bearer ${token}`)
    .send({ message: 'What is my attendance?' });

  assert.equal(response.status, 200);
  assert.equal(response.body.provider, 'grounded_rule_engine');
  assert.equal(forwarded.url, 'http://fastapi.test/assistant/chat?demo=false');
  assert.equal(forwarded.options.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(forwarded.options.body), { message: 'What is my attendance?' });
});

test('assistant proxy preserves upstream validation and handles unavailable service', async () => {
  const { app, token } = setup(async () => upstream(422, { detail: 'message is required' }));
  const invalid = await request(app)
    .post('/api/assistant/chat')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { detail: 'message is required' });

  const unavailableApp = setup(async () => {
    throw new Error('test upstream failure');
  });
  const unavailable = await request(unavailableApp.app)
    .get('/api/assistant/free-time')
    .set('Authorization', `Bearer ${unavailableApp.token}`);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.detail, 'Assistant service is unavailable.');
});

test('assistant proxy requires authentication', async () => {
  let called = false;
  const { app } = setup(async () => {
    called = true;
    return upstream(200, {});
  });
  const response = await request(app).get('/api/assistant/free-time');
  assert.equal(response.status, 401);
  assert.equal(called, false);
});
