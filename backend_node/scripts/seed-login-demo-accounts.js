'use strict';

const { MongoClient } = require('mongodb');
const { normalizeEmail } = require('../src/auth/users');
const { hashPassword } = require('../src/auth/passwords');
const { promptHidden } = require('./provision-admin');

const LOCAL_MONGO_URI = 'mongodb://127.0.0.1:27017';
const DATABASE_NAME = 'smart_campus_test';
const SEED_MARKER = 'smart-campus-login-demo-v1';
const STUDENT_ID = 'DEMO-LOGIN-2026-001';

const DEMO_ACCOUNTS = Object.freeze([
  {
    name: 'Demo Administrator',
    email: 'admin.login@smartcampus.test',
    role: 'admin',
  },
  {
    name: 'Demo Faculty',
    email: 'faculty.login@smartcampus.test',
    role: 'faculty',
    assigned_subject_codes: [],
  },
  {
    name: 'Demo Student',
    email: 'student.login@smartcampus.test',
    role: 'student',
    student_id: STUDENT_ID,
    registration_number: STUDENT_ID,
  },
]);

const STUDENT_PROFILE = Object.freeze({
  student_id: STUDENT_ID,
  registration_number: STUDENT_ID,
  name: 'Demo Student',
  email: 'student.login@smartcampus.test',
  department: 'DEMO',
  course: 'DEMO',
  semester: 1,
  section: 'A',
  is_demo: true,
  synthetic_demo: true,
  local_demo_seed: SEED_MARKER,
});

const PASSWORD_ENV = Object.freeze({
  admin: 'DEMO_ADMIN_PASSWORD',
  faculty: 'DEMO_FACULTY_PASSWORD',
  student: 'DEMO_STUDENT_PASSWORD',
});

function findEmailQuery(email) {
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { email: { $regex: `^${escapedEmail}$`, $options: 'i' } };
}

function assertVerifiedDemoAccount(user, account) {
  if (
    normalizeEmail(user.email || '') !== account.email ||
    user.role !== account.role ||
    user.is_demo !== true ||
    user.synthetic_demo !== true ||
    user.local_demo_seed !== SEED_MARKER ||
    (account.student_id && user.student_id !== account.student_id) ||
    (account.role === 'faculty' && !Array.isArray(user.assigned_subject_codes))
  ) {
    throw new Error(
      `Account conflict for ${account.email}: existing account is not a verified demo account; no existing accounts were changed.`,
    );
  }
}

function assertVerifiedStudentProfile(profile, studentUser) {
  if (
    profile.local_demo_seed !== SEED_MARKER ||
    profile.is_demo !== true ||
    profile.synthetic_demo !== true ||
    profile.student_id !== STUDENT_ID ||
    normalizeEmail(profile.email || '') !== STUDENT_PROFILE.email ||
    (profile.user_id &&
      studentUser?._id &&
      profile.user_id !== String(studentUser._id))
  ) {
    throw new Error(
      `Student profile conflict for ${STUDENT_ID}; no existing accounts were changed.`,
    );
  }
}

function validatePasswords(passwords) {
  for (const account of DEMO_ACCOUNTS) {
    const password = passwords?.[account.role];
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new Error(
        `A password for the ${account.role} demo account must contain 8 to 128 characters.`,
      );
    }
  }
}

async function seedLoginDemoAccounts({ db, passwords, hash = hashPassword, env = process.env }) {
  if (env.NODE_ENV === 'production') {
    throw new Error('Demo account seeding is disabled in production environments.');
  }
  if (db?.databaseName !== DATABASE_NAME) {
    throw new Error(`Demo account seeding is allowed only for ${DATABASE_NAME}.`);
  }
  validatePasswords(passwords);

  const users = db.collection('users');
  const students = db.collection('students');
  const existingUsers = new Map();

  for (const account of DEMO_ACCOUNTS) {
    const existing = await users.findOne(findEmailQuery(account.email));
    if (existing) assertVerifiedDemoAccount(existing, account);
    existingUsers.set(account.email, existing);
  }

  const linkedUser = await users.findOne({ student_id: STUDENT_ID });
  if (
    linkedUser &&
    normalizeEmail(linkedUser.email || '') !== STUDENT_PROFILE.email
  ) {
    throw new Error(
      `Student ID conflict for ${STUDENT_ID}; no existing accounts were changed.`,
    );
  }

  const existingProfile = await students.findOne({ student_id: STUDENT_ID });
  const existingStudentUser = existingUsers.get(STUDENT_PROFILE.email);
  if (existingProfile) {
    assertVerifiedStudentProfile(existingProfile, existingStudentUser);
  }

  const createdEmails = [];
  const userIds = new Map();
  for (const account of DEMO_ACCOUNTS) {
    const existing = existingUsers.get(account.email);
    if (existing) {
      userIds.set(account.email, existing._id);
      continue;
    }

    const document = {
      name: account.name,
      email: account.email,
      password: await hash(passwords[account.role]),
      role: account.role,
      is_demo: true,
      synthetic_demo: true,
      local_demo_seed: SEED_MARKER,
    };
    if (account.assigned_subject_codes) {
      document.assigned_subject_codes = [...account.assigned_subject_codes];
    }
    if (account.student_id) {
      document.student_id = account.student_id;
      document.registration_number = account.registration_number;
    }

    try {
      const result = await users.insertOne(document);
      if (!result.acknowledged) {
        throw new Error(`MongoDB did not confirm creation of ${account.email}.`);
      }
      createdEmails.push(account.email);
      userIds.set(account.email, result.insertedId);
    } catch (error) {
      if (error.code === 11000) {
        throw new Error(
          `Account conflict for ${account.email}: another record was inserted during seeding. No existing passwords were changed; rerun after inspecting the local database.`,
        );
      }
      throw error;
    }
  }

  let studentProfileCreated = false;
  if (!existingProfile) {
    const userId = userIds.get(STUDENT_PROFILE.email);
    if (!userId) {
      throw new Error('Student account ID is unavailable; student profile was not created.');
    }
    const profile = {
      ...STUDENT_PROFILE,
      user_id: String(userId),
    };
    try {
      const result = await students.insertOne(profile);
      if (!result.acknowledged) {
        throw new Error('MongoDB did not confirm creation of the student profile.');
      }
      studentProfileCreated = true;
    } catch (error) {
      if (error.code === 11000) {
        throw new Error(
          `Student profile conflict for ${STUDENT_ID}; no existing accounts were changed.`,
        );
      }
      throw error;
    }
  }

  return {
    createdEmails,
    existingEmails: [...existingUsers.entries()]
      .filter(([, user]) => user)
      .map(([email]) => email),
    studentProfileCreated,
  };
}

async function readPasswords(env = process.env) {
  const passwords = {};
  for (const account of DEMO_ACCOUNTS) {
    const key = PASSWORD_ENV[account.role];
    passwords[account.role] = env[key] || await promptHidden(
      `${account.role[0].toUpperCase()}${account.role.slice(1)} demo password (input hidden): `,
    );
  }
  validatePasswords(passwords);
  return passwords;
}

async function main() {
  const passwords = await readPasswords();
  const client = new MongoClient(LOCAL_MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    appName: 'smart-campus-login-demo-seed',
  });

  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    if (db.databaseName !== DATABASE_NAME) {
      throw new Error(`Refusing to seed a database other than ${DATABASE_NAME}.`);
    }

    const result = await seedLoginDemoAccounts({ db, passwords });
    console.log(`Database: 127.0.0.1/${db.databaseName}`);
    console.log(`New accounts: ${result.createdEmails.length}`);
    console.log(`Already verified accounts: ${result.existingEmails.length}`);
    console.log(`Student profile created: ${result.studentProfileCreated ? 'yes' : 'no'}`);
    for (const email of result.createdEmails) console.log(`Created ${email}`);
    console.log('Passwords were not printed or stored by the seed script.');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Login demo seeding failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DATABASE_NAME,
  DEMO_ACCOUNTS,
  LOCAL_MONGO_URI,
  PASSWORD_ENV,
  SEED_MARKER,
  STUDENT_ID,
  seedLoginDemoAccounts,
  validatePasswords,
};
