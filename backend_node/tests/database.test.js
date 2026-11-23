const assert = require('node:assert/strict');
const test = require('node:test');

const { readMongoConfig } = require('../src/config/database');
const { COLLECTIONS, connectMongo, getDatabase } = require('../src/config/mongo');

const isolatedConfig = {
  MONGO_URI: 'mongodb://127.0.0.1:27017',
  MONGO_DB_NAME: 'smart_campus_test',
  NODE_ENV: 'test',
};

test('accepts an isolated test database configuration without connecting', () => {
  const config = readMongoConfig(isolatedConfig);

  assert.equal(config.databaseName, 'smart_campus_test');
  assert.equal(config.serverSelectionTimeoutMS, 5000);
  assert.throws(() => getDatabase(), /Call connectMongo\(\) explicitly first/);
});

test('requires a MongoDB URI and database name', () => {
  assert.throws(() => readMongoConfig({}), /MONGO_URI is required/);
  assert.throws(
    () => readMongoConfig({ MONGO_URI: isolatedConfig.MONGO_URI }),
    /MONGO_DB_NAME is required/,
  );
});

test('rejects the existing database without explicit production approval', () => {
  assert.throws(
    () =>
      readMongoConfig({
        ...isolatedConfig,
        MONGO_DB_NAME: 'smart_campus',
      }),
    /Refusing to use the existing production database/,
  );
});

test('lists the existing collection names without accessing MongoDB', () => {
  assert.deepEqual(Object.values(COLLECTIONS), [
    'users',
    'students',
    'subjects',
    'classes',
    'attendance',
    'attendance_entries',
    'timetable',
    'student_link_codes',
    'books',
    'book_loans',
    'complaints',
    'events',
    'transport_routes',
    'notifications',
    'lost_found_items',
    'lost_found_matches',
    'lost_found_claims',
    'assignments',
  ]);
});

test('wraps MongoDB connection failures without leaking driver details', async () => {
  let closeCalled = false;
  class FailingMongoClient {
    constructor(uri, options) {
      assert.equal(uri, isolatedConfig.MONGO_URI);
      assert.equal(options.serverSelectionTimeoutMS, 5000);
    }

    async connect() {
      throw new Error('private server details');
    }

    async close() {
      closeCalled = true;
    }
  }

  await assert.rejects(
    connectMongo(isolatedConfig, FailingMongoClient),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'MONGODB_UNAVAILABLE');
      assert.equal(error.message, 'MongoDB connection failed.');
      assert.equal(error.cause.message, 'private server details');
      return true;
    },
  );
  assert.equal(closeCalled, true);
  assert.throws(() => getDatabase(), /Call connectMongo\(\) explicitly first/);
});
