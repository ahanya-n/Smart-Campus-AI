'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DATABASE_NAME,
  DEMO_STUDENTS,
  SEED_MARKER,
  seedRealisticDemoStudents,
} = require('../scripts/seed-realistic-demo-students');

function createDatabase() {
  const collections = new Map();
  const db = {
    databaseName: DATABASE_NAME,
    collection(name) {
      if (!collections.has(name)) collections.set(name, []);
      const records = collections.get(name);
      return {
        async findOne(query) {
          return records.find((record) =>
            Object.entries(query).every(([key, value]) => record[key] === value),
          ) || null;
        },
        find(query = {}) {
          const found = records.filter((record) =>
            Object.entries(query).every(([key, value]) => record[key] === value),
          );
          return {
            sort() { return this; },
            limit() { return this; },
            async toArray() { return found; },
          };
        },
        async insertOne(document) {
          const record = { ...document, _id: `id-${records.length + 1}` };
          records.push(record);
          return { acknowledged: true, insertedId: record._id };
        },
        async updateOne(query, update, options = {}) {
          let record = records.find((item) =>
            Object.entries(query).every(([key, value]) => item[key] === value),
          );
          if (!record && options.upsert) {
            record = { ...update.$setOnInsert, _id: `id-${records.length + 1}` };
            records.push(record);
          } else if (record) {
            Object.assign(record, update.$set || {});
          }
          return { matchedCount: record ? 1 : 0, modifiedCount: record ? 1 : 0 };
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

test('realistic demo seeder creates unique credentials and idempotent seed markers', async () => {
  const database = createDatabase();
  const result = await seedRealisticDemoStudents({
    db: database.db,
    hash: async (password) => `hashed:${password}`,
  });

  assert.equal(result.created, DEMO_STUDENTS.length);
  assert.equal(result.existing, 0);
  assert.equal(database.records('users').length, DEMO_STUDENTS.length);
  assert.equal(database.records('students').length, DEMO_STUDENTS.length);

  const emails = new Set();
  for (const student of DEMO_STUDENTS) {
    assert.equal(student.email, `${student.name.toLowerCase().replace(/\s+/g, '.')}${student.roll.toLowerCase()}@smartcampus.test`);
    assert.equal(student.password, `${student.name.split(' ')[0]}@${student.roll}`);
    emails.add(student.email);
  }
  assert.equal(emails.size, DEMO_STUDENTS.length);
  assert.ok(database.records('users').every((user) => user.demo_seed_key === SEED_MARKER));
});

test('realistic demo seeder rerun preserves existing accounts and passwords', async () => {
  const database = createDatabase();
  await seedRealisticDemoStudents({
    db: database.db,
    hash: async (password) => `hashed:${password}`,
  });

  const result = await seedRealisticDemoStudents({
    db: database.db,
    hash: async () => {
      throw new Error('Existing passwords must not be rehashed');
    },
  });
  assert.equal(result.created, 0);
  assert.equal(result.existing, DEMO_STUDENTS.length);
  assert.equal(database.records('users').length, DEMO_STUDENTS.length);
});
