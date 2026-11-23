'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DATABASE_NAME,
  DEMO_ACCOUNTS,
  SEED_MARKER,
  STUDENT_ID,
  seedLoginDemoAccounts,
} = require('../scripts/seed-login-demo-accounts');

const PASSWORDS = Object.freeze({
  admin: 'test-admin-password',
  faculty: 'test-faculty-password',
  student: 'test-student-password',
});

function matches(record, query) {
  return Object.entries(query).every(([key, value]) => {
    if (value && value.$regex) {
      return new RegExp(value.$regex, value.$options).test(record[key] || '');
    }
    return record[key] === value;
  });
}

function createDatabase() {
  const collections = new Map();
  let nextId = 0;
  const db = {
    databaseName: DATABASE_NAME,
    collection(name) {
      if (!collections.has(name)) collections.set(name, []);
      const records = collections.get(name);
      return {
        async findOne(query) {
          return records.find((record) => matches(record, query)) || null;
        },
        async insertOne(document) {
          const record = { ...document, _id: `test-id-${++nextId}` };
          records.push(record);
          return { acknowledged: true, insertedId: record._id };
        },
      };
    },
  };
  return {
    db,
    records(name) {
      return collections.get(name) || [];
    },
  };
}

test('creates marked accounts with hashed passwords and a linked student profile', async () => {
  const database = createDatabase();
  const hashCalls = [];
  const result = await seedLoginDemoAccounts({
    db: database.db,
    passwords: PASSWORDS,
    hash: async (password) => {
      hashCalls.push(password);
      return `hashed:${password}`;
    },
  });

  assert.deepEqual(result.createdEmails, DEMO_ACCOUNTS.map((account) => account.email));
  assert.deepEqual(result.existingEmails, []);
  assert.equal(result.studentProfileCreated, true);
  assert.equal(hashCalls.length, 3);

  for (const account of DEMO_ACCOUNTS) {
    const user = database.records('users').find((record) => record.email === account.email);
    assert.equal(user.role, account.role);
    assert.equal(user.is_demo, true);
    assert.equal(user.synthetic_demo, true);
    assert.equal(user.local_demo_seed, SEED_MARKER);
    assert.equal(user.password, `hashed:${PASSWORDS[account.role]}`);
    assert.notEqual(user.password, PASSWORDS[account.role]);
  }

  const student = database.records('users').find((record) => record.role === 'student');
  const profile = database.records('students')[0];
  assert.equal(student.student_id, STUDENT_ID);
  assert.equal(profile.student_id, STUDENT_ID);
  assert.equal(profile.user_id, student._id);
  assert.equal(profile.email, student.email);
});

test('is idempotent and never rehashes existing passwords', async () => {
  const database = createDatabase();
  const options = {
    db: database.db,
    passwords: PASSWORDS,
    hash: async (password) => `hashed:${password}`,
  };
  await seedLoginDemoAccounts(options);
  const originalHashes = database.records('users').map((user) => user.password);

  const result = await seedLoginDemoAccounts({
    ...options,
    hash: async () => {
      throw new Error('An existing password must not be rehashed.');
    },
  });

  assert.deepEqual(result.createdEmails, []);
  assert.equal(result.existingEmails.length, 3);
  assert.equal(result.studentProfileCreated, false);
  assert.deepEqual(database.records('users').map((user) => user.password), originalHashes);
  assert.equal(database.records('users').length, 3);
  assert.equal(database.records('students').length, 1);
});

test('preflights all emails and refuses an unverified account without partial inserts', async () => {
  const database = createDatabase();
  await database.db.collection('users').insertOne({
    email: DEMO_ACCOUNTS[2].email.toUpperCase(),
    role: 'student',
    password: 'untouched',
  });

  await assert.rejects(
    seedLoginDemoAccounts({
      db: database.db,
      passwords: PASSWORDS,
      hash: async (password) => `hashed:${password}`,
    }),
    /not a verified demo account; no existing accounts were changed/,
  );
  assert.equal(database.records('users').length, 1);
  assert.equal(database.records('users')[0].password, 'untouched');
  assert.equal(database.records('students').length, 0);
});

test('refuses an unrelated student profile ID before creating any users', async () => {
  const database = createDatabase();
  await database.db.collection('students').insertOne({
    student_id: STUDENT_ID,
    email: 'someone.else@smartcampus.test',
  });

  await assert.rejects(
    seedLoginDemoAccounts({
      db: database.db,
      passwords: PASSWORDS,
      hash: async (password) => `hashed:${password}`,
    }),
    /Student profile conflict/,
  );
  assert.equal(database.records('users').length, 0);
  assert.equal(database.records('students').length, 1);
});

test('rejects a database other than smart_campus_test before requesting collections', async () => {
  let collectionRequested = false;
  await assert.rejects(
    seedLoginDemoAccounts({
      db: {
        databaseName: 'smart_campus',
        collection() {
          collectionRequested = true;
        },
      },
      passwords: PASSWORDS,
    }),
    /allowed only for smart_campus_test/,
  );
  assert.equal(collectionRequested, false);
});

test('refuses demo seeding in production environments', async () => {
  let collectionRequested = false;
  await assert.rejects(
    seedLoginDemoAccounts({
      db: {
        databaseName: DATABASE_NAME,
        collection() {
          collectionRequested = true;
        },
      },
      passwords: PASSWORDS,
      env: { NODE_ENV: 'production' },
    }),
    /disabled in production/,
  );
  assert.equal(collectionRequested, false);
});
