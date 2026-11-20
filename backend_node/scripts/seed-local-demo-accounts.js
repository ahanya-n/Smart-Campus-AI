'use strict';

const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { hashPassword } = require('../src/auth/passwords');

const LOCAL_MONGO_URI = 'mongodb://127.0.0.1:27017';
const DATABASE_NAME = 'smart_campus_test';
const SEED_MARKER = 'smart-campus-local-demo-v1';
const STUDENT_ID = 'DEMO-LOCAL-2026-001';

const DEMO_ACCOUNTS = Object.freeze([
  {
    name: 'Demo Administrator',
    email: 'admin.demo@smartcampus.test',
    role: 'admin',
    is_demo: true,
    synthetic_demo: true,
  },
  {
    name: 'Demo Faculty',
    email: 'faculty.demo@smartcampus.test',
    role: 'faculty',
    assigned_subject_codes: [],
    is_demo: true,
    synthetic_demo: true,
  },
  {
    name: 'Demo Student',
    email: 'student.demo@smartcampus.test',
    role: 'student',
    student_id: STUDENT_ID,
    is_demo: true,
    synthetic_demo: true,
  },
]);

const DEMO_STUDENT = Object.freeze({
  student_id: STUDENT_ID,
  name: 'Demo Student',
  email: 'student.demo@smartcampus.test',
  department: 'DEMO',
  semester: 1,
  is_demo: true,
  synthetic_demo: true,
  local_demo_seed: SEED_MARKER,
});

function generatePassword() {
  return crypto.randomBytes(24).toString('base64url');
}

function assertSeededRecord(record, expectedRole, email) {
  if (
    record.local_demo_seed !== SEED_MARKER ||
    record.role !== expectedRole ||
    record.email !== email
  ) {
    throw new Error(
      `Refusing to modify existing account ${email}; it was not created by this seed.`,
    );
  }
}

async function seedDemoAccounts({
  db,
  hash = hashPassword,
  makePassword = generatePassword,
}) {
  const users = db.collection('users');
  const students = db.collection('students');
  const existingUsers = new Map();

  for (const account of DEMO_ACCOUNTS) {
    const existing = await users.findOne({ email: account.email });
    if (existing) {
      assertSeededRecord(existing, account.role, account.email);
      if (account.student_id && existing.student_id !== account.student_id) {
        throw new Error(`Refusing to relink existing account ${account.email}.`);
      }
    }
    existingUsers.set(account.email, existing);
  }

  const existingStudent = await students.findOne({ student_id: STUDENT_ID });
  if (
    existingStudent &&
    existingStudent.local_demo_seed !== SEED_MARKER
  ) {
    throw new Error(
      `Refusing to modify existing student record ${STUDENT_ID}; it was not created by this seed.`,
    );
  }

  const linkedUser = await users.findOne({ student_id: STUDENT_ID });
  if (linkedUser && linkedUser.email !== 'student.demo@smartcampus.test') {
    throw new Error(`Student record ${STUDENT_ID} is linked to another account.`);
  }

  const inserts = [];
  const credentials = {};
  for (const account of DEMO_ACCOUNTS) {
    if (existingUsers.get(account.email)) continue;

    const password = makePassword();
    if (typeof password !== 'string' || password.length < 16 || password.length > 128) {
      throw new Error('Generated demo password did not meet the length requirements.');
    }

    credentials[account.email] = password;
    inserts.push({
      ...account,
      password: await hash(password),
      local_demo_seed: SEED_MARKER,
    });
  }

  let studentRecordCreated = false;
  if (!existingStudent) {
    await students.insertOne({ ...DEMO_STUDENT });
    studentRecordCreated = true;
  }

  for (const document of inserts) {
    await users.insertOne(document);
  }

  for (const account of DEMO_ACCOUNTS) {
    const stored = await users.findOne({ email: account.email });
    if (!stored || stored.role !== account.role || stored.local_demo_seed !== SEED_MARKER) {
      throw new Error(`Verification failed for ${account.email}.`);
    }
  }

  const storedStudent = await students.findOne({ student_id: STUDENT_ID });
  if (!storedStudent || storedStudent.local_demo_seed !== SEED_MARKER) {
    throw new Error(`Verification failed for student record ${STUDENT_ID}.`);
  }

  return {
    createdEmails: inserts.map((document) => document.email),
    credentials,
    studentRecordCreated,
  };
}

async function main() {
  const client = new MongoClient(LOCAL_MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    appName: 'smart-campus-local-demo-seed',
  });

  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    if (db.databaseName !== 'smart_campus_test') {
      throw new Error('Refusing to seed a database other than smart_campus_test.');
    }

    const result = await seedDemoAccounts({ db });
    console.log('Database: localhost smart_campus_test');
    console.log(`New accounts: ${result.createdEmails.length}`);
    console.log(`Student profile created: ${result.studentRecordCreated ? 'yes' : 'no'}`);
    if (result.createdEmails.length) {
      console.log('Save these generated credentials; passwords cannot be recovered:');
      for (const email of result.createdEmails) {
        console.log(`${email}  ${result.credentials[email]}`);
      }
    } else {
      console.log('All seeded accounts already exist; no records or passwords changed.');
    }
    console.log('No attendance, marks, timetable, or existing user records were changed.');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Local demo seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DATABASE_NAME,
  DEMO_ACCOUNTS,
  DEMO_STUDENT,
  LOCAL_MONGO_URI,
  SEED_MARKER,
  STUDENT_ID,
  seedDemoAccounts,
};
