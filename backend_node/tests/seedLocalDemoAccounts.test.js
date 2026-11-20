'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEMO_ACCOUNTS,
  SEED_MARKER,
  STUDENT_ID,
  seedDemoAccounts,
} = require('../scripts/seed-local-demo-accounts');

function createDatabase() {
  const collections = new Map();
  const db = {
    collection(name) {
      if (!collections.has(name)) collections.set(name, []);
      const records = collections.get(name);
      return {
        async findOne(query) {
          return records.find((record) =>
            Object.entries(query).every(([key, value]) => record[key] === value),
          ) || null;
        },
        async insertOne(document) {
          records.push({ ...document });
          return { acknowledged: true };
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

test('creates only marked demo accounts and one synthetic student profile', async () => {
  const database = createDatabase();
  let nextPassword = 0;
  const result = await seedDemoAccounts({
    db: database.db,
    hash: async (password) => `hashed:${password}`,
    makePassword: () => `DemoPassword-${++nextPassword}-long`,
  });

  assert.equal(result.createdEmails.length, 3);
  assert.equal(result.studentRecordCreated, true);
  assert.equal(database.records('users').length, 3);
  assert.equal(database.records('students').length, 1);
  assert.equal(
    database.records('students')[0].student_id,
    STUDENT_ID,
  );
  assert.equal(database.records('students')[0].synthetic_demo, true);
  for (const account of DEMO_ACCOUNTS) {
    const record = database.records('users').find(
      (user) => user.email === account.email,
    );
    assert.equal(record.role, account.role);
    assert.equal(record.is_demo, true);
    assert.equal(record.synthetic_demo, true);
    assert.equal(record.local_demo_seed, SEED_MARKER);
    assert.match(record.password, /^hashed:/);
    assert.equal(result.credentials[account.email].length >= 16, true);
  }
});

test('is idempotent and does not rotate existing passwords', async () => {
  const database = createDatabase();
  const options = {
    db: database.db,
    hash: async (password) => `hashed:${password}`,
    makePassword: (() => {
      let nextPassword = 0;
      return () => `DemoPassword-${++nextPassword}-long`;
    })(),
  };

  await seedDemoAccounts(options);
  const passwordHashes = database.records('users').map((user) => user.password);
  const secondRun = await seedDemoAccounts({
    ...options,
    hash: async () => {
      throw new Error('Existing passwords must not be rehashed.');
    },
    makePassword: () => {
      throw new Error('Existing passwords must not be regenerated.');
    },
  });

  assert.deepEqual(secondRun.createdEmails, []);
  assert.equal(secondRun.studentRecordCreated, false);
  assert.deepEqual(
    database.records('users').map((user) => user.password),
    passwordHashes,
  );
  assert.equal(database.records('users').length, 3);
  assert.equal(database.records('students').length, 1);
});

test('refuses to overwrite a pre-existing account with a target email', async () => {
  const database = createDatabase();
  await database.db.collection('users').insertOne({
    email: DEMO_ACCOUNTS[0].email,
    role: 'admin',
    password: 'untouched',
  });

  await assert.rejects(
    seedDemoAccounts({
      db: database.db,
      hash: async (password) => `hashed:${password}`,
      makePassword: () => 'DemoPassword-long-enough',
    }),
    /Refusing to modify existing account/,
  );
  assert.equal(database.records('users').length, 1);
  assert.equal(database.records('users')[0].password, 'untouched');
  assert.equal(database.records('students').length, 0);
});
