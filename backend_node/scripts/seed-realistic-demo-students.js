'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { hashPassword } = require('../src/auth/passwords');

const DATABASE_NAME = 'smart_campus_test';
const LOCAL_MONGO_URI = 'mongodb://127.0.0.1:27017';
const SEED_MARKER = 'smart-campus-realistic-students-v1';
const CREDENTIAL_FILE = path.resolve(__dirname, '..', '..', 'backend', 'realistic-demo-credentials.local.json');

const DEMO_STUDENT_ROWS = Object.freeze([
  { name: 'Aarav Sharma', roll: '20252MCA0275', semester: 1, section: 'A', course: 'MCA', department: 'MCA' },
  { name: 'Diya Nair', roll: '20252MCA0276', semester: 1, section: 'A', course: 'MCA', department: 'MCA' },
  { name: 'Rohan Patel', roll: '20252MCA0277', semester: 1, section: 'A', course: 'MCA', department: 'MCA' },
  { name: 'Meera Iyer', roll: '20252MCA0278', semester: 1, section: 'B', course: 'MCA', department: 'MCA' },
  { name: 'Aditya Rao', roll: '20252MCA0279', semester: 1, section: 'B', course: 'MCA', department: 'MCA' },
  { name: 'Ananya Gupta', roll: '20252MCA0280', semester: 1, section: 'B', course: 'MCA', department: 'MCA' },
  { name: 'Kabir Khan', roll: '20252MCA0281', semester: 2, section: 'A', course: 'MCA', department: 'MCA' },
  { name: 'Saanvi Reddy', roll: '20252MCA0282', semester: 2, section: 'A', course: 'MCA', department: 'MCA' },
  { name: 'Vihaan Joshi', roll: '20252MCA0283', semester: 2, section: 'A', course: 'MCA', department: 'MCA' },
  { name: 'Isha Shetty', roll: '20252MCA0284', semester: 2, section: 'B', course: 'MCA', department: 'MCA' },
  { name: 'Neel Kapoor', roll: '20252MCA0285', semester: 2, section: 'B', course: 'MCA', department: 'MCA' },
  { name: 'Navya Menon', roll: '20252MCA0286', semester: 2, section: 'B', course: 'MCA', department: 'MCA' },
]);

const DEMO_STUDENTS = Object.freeze(DEMO_STUDENT_ROWS.map((student) => {
  const firstName = student.name.split(' ')[0];
  const emailName = student.name.toLowerCase().replace(/\s+/g, '.');
  return {
    ...student,
    email: `${emailName}${student.roll.toLowerCase()}@smartcampus.test`,
    password: `${firstName}@${student.roll}`,
  };
}));

const SUBJECTS = [
  { code: 'MCA101', name: 'Programming in C', semester: 1 },
  { code: 'MCA102', name: 'Mathematical Foundations', semester: 1 },
  { code: 'MCA103', name: 'Computer Organization', semester: 1 },
  { code: 'MCA104', name: 'Database Management Systems', semester: 1 },
  { code: 'MCA105', name: 'Communication Skills', semester: 1 },
  { code: 'MCA201', name: 'Data Structures', semester: 2 },
  { code: 'MCA202', name: 'Operating Systems', semester: 2 },
  { code: 'MCA203', name: 'Object-Oriented Programming', semester: 2 },
  { code: 'MCA204', name: 'Computer Networks', semester: 2 },
  { code: 'MCA205', name: 'Software Engineering', semester: 2 },
];

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function studentCredentials() {
  return {
    environment: 'development',
    database: DATABASE_NAME,
    accounts: DEMO_STUDENTS.map((student) => ({
      name: student.name,
      roll_number: student.roll,
      email: student.email,
      password: student.password,
      role: 'student',
    })),
  };
}

async function seedRealisticDemoStudents({ db, hash = hashPassword }) {
  if (db.databaseName !== DATABASE_NAME) {
    throw new Error(`Demo seeding is allowed only for ${DATABASE_NAME}.`);
  }

  const users = db.collection('users');
  const students = db.collection('students');
  const timetable = db.collection('timetable');
  const attendance = db.collection('attendance');
  const entries = db.collection('attendance_entries');
  const marks = db.collection('marks');
  const assignments = db.collection('assignments');
  const notifications = db.collection('notifications');
  const books = db.collection('books');
  const loans = db.collection('book_loans');

  for (const semester of [1, 2]) {
    for (const section of ['A', 'B']) {
      const semesterSubjects = SUBJECTS.filter((subject) => subject.semester === semester);
      for (let subjectIndex = 0; subjectIndex < semesterSubjects.length; subjectIndex += 1) {
        const subject = semesterSubjects[subjectIndex];
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
        const day = dayNames[(subjectIndex + (section === 'B' ? 1 : 0)) % dayNames.length];
        const startHour = 9 + subjectIndex;
        const startTime = `${String(startHour).padStart(2, '0')}:00`;
        const endTime = `${String(startHour + 1).padStart(2, '0')}:00`;
        const key = {
          department: 'MCA',
          semester,
          day_of_week: day,
          start_time: startTime,
          is_demo: true,
        };
        await timetable.updateOne(
          key,
          {
            $setOnInsert: {
              ...key,
              section,
              subject_code: subject.code,
              subject_name: subject.name,
              end_time: endTime,
              faculty_name: ['Dr. Nandini Hegde', 'Prof. Raghavendra Bhat', 'Dr. Shilpa Shetty'][subjectIndex % 3],
              room_number: subjectIndex % 2 === 0
                ? `MCA-Lab-${subjectIndex + 1}`
                : `MCA-${201 + subjectIndex}`,
              synthetic_demo: true,
              demo_seed_key: SEED_MARKER,
            },
          },
          { upsert: true },
        );
      }
    }
  }

  const created = [];
  const existing = [];

  for (const [index, student] of DEMO_STUDENTS.entries()) {
    const email = normalizeEmail(student.email);
    let user = await users.findOne({ email });
    if (user) {
      if (
        user.role !== 'student'
        || (user.student_id && user.student_id !== student.roll)
      ) {
        throw new Error(`Account conflict for ${email}; no existing accounts were changed.`);
      }
      existing.push(email);
    } else {
      const result = await users.insertOne({
        name: student.name,
        email,
        password: await hash(student.password),
        role: 'student',
        student_id: student.roll,
        registration_number: student.roll,
        department: student.department,
        course: student.course,
        semester: student.semester,
        section: student.section,
        avatar_url: null,
        is_demo: true,
        synthetic_demo: true,
        demo_seed_key: SEED_MARKER,
      });
      user = await users.findOne({ _id: result.insertedId });
      created.push(email);
    }

    await students.updateOne(
      { student_id: student.roll },
      {
        $setOnInsert: {
          student_id: student.roll,
          registration_number: student.roll,
          name: student.name,
          email,
          department: student.department,
          course: student.course,
          semester: student.semester,
          section: student.section,
          avatar_url: null,
          is_demo: true,
          synthetic_demo: true,
          demo_seed_key: SEED_MARKER,
        },
      },
      { upsert: true },
    );

    const semesterSubjects = SUBJECTS.filter((subject) => subject.semester === student.semester);
    for (let subjectIndex = 0; subjectIndex < semesterSubjects.length; subjectIndex += 1) {
      const subject = semesterSubjects[subjectIndex];
      const total = 24 + ((subjectIndex + index) % 6);
      const present = total - ((index + subjectIndex) % 5);
      await attendance.updateOne(
        {
          student_id: student.roll,
          subject_code: subject.code,
          is_demo: true,
        },
        {
          $set: {
            student_id: student.roll,
            student_name: student.name,
            subject_code: subject.code,
            subject_name: subject.name,
            total_classes: total,
            present_classes: present,
            absent_classes: total - present,
            attendance_percentage: Math.round((present / total) * 10000) / 100,
            is_demo: true,
            synthetic_demo: true,
            demo_seed_key: SEED_MARKER,
            updated_at: new Date(),
          },
        },
        { upsert: true },
      );

      for (let assessmentIndex = 0; assessmentIndex < 3; assessmentIndex += 1) {
        const maximum = assessmentIndex === 2 ? 100 : 50;
        const score = Math.min(maximum, 24 + ((index * 7 + subjectIndex * 5 + assessmentIndex * 8) % 25));
        await marks.updateOne(
          {
            student_id: student.roll,
            subject_code: subject.code,
            assessment_id: `${subject.code}-A${assessmentIndex + 1}`,
          },
          {
            $set: {
              student_id: student.roll,
              student_name: student.name,
              subject_code: subject.code,
              subject_name: subject.name,
              assessment_id: `${subject.code}-A${assessmentIndex + 1}`,
              assessment_name: ['Unit Test', 'Mid-Term', 'Final Internal'][assessmentIndex],
              score,
              max_score: maximum,
              assessment_date: new Date(2026, 10 - assessmentIndex, 5 + ((index + subjectIndex) % 20)).toISOString(),
              is_demo: true,
              synthetic_demo: true,
              demo_seed_key: SEED_MARKER,
              created_at: new Date(),
            },
          },
          { upsert: true },
        );
      }

      const assignmentStatus = (subjectIndex + index) % 3 === 0 ? 'submitted' : 'pending';
      await assignments.updateOne(
        {
          student_id: student.roll,
          subject_code: subject.code,
          demo_seed_key: SEED_MARKER,
        },
        {
          $set: {
            student_id: student.roll,
            student_name: student.name,
            subject_code: subject.code,
            subject_name: subject.name,
            title: `${subject.name} ${assignmentStatus === 'submitted' ? 'Submission' : 'Practice Task'}`,
            description: `${assignmentStatus === 'submitted' ? 'Submit and review' : 'Complete'} the ${subject.name} task.`,
            status: assignmentStatus,
            due_date: new Date(2026, 10, 10 + ((subjectIndex + index) % 18)).toISOString(),
            marks: assignmentStatus === 'submitted' ? 70 + ((index + subjectIndex) % 25) : null,
            is_demo: true,
            synthetic_demo: true,
            demo_seed_key: SEED_MARKER,
            updated_at: new Date(),
          },
        },
        { upsert: true },
      );
    }

    await notifications.updateOne(
      {
        student_id: student.roll,
        week_id: `REALISTIC-${student.roll}`,
        demo_seed_key: SEED_MARKER,
      },
      {
        $set: {
          student_id: student.roll,
          subject_code: 'CAMPUS',
          subject_name: 'Campus Notice',
          attendance_percentage: 0,
          threshold: 0,
          week_id: `REALISTIC-${student.roll}`,
          warning_type: 'student_notice',
          title: 'Welcome to the new student dashboard',
          message: `Your timetable, attendance, marks and assignments are ready for ${student.name}.`,
          reporting_date: new Date().toISOString().slice(0, 10),
          created_at: new Date(),
          is_read: false,
          is_demo: true,
          synthetic_demo: true,
          demo_seed_key: SEED_MARKER,
        },
      },
      { upsert: true },
    );

    const bookTitle = `MCA Study Guide ${index + 1}`;
    const bookKey = { isbn: `DEMO-MCA-${String(index + 1).padStart(4, '0')}` };
    await books.updateOne(
      bookKey,
      {
        $setOnInsert: {
          ...bookKey,
          title: bookTitle,
          author: ['Campus Learning Team', 'Smart Campus Faculty'][index % 2],
          category: 'Academic',
          total_copies: 3,
          available_copies: 2,
          is_demo: true,
          synthetic_demo: true,
          demo_seed_key: SEED_MARKER,
        },
      },
      { upsert: true },
    );
    const book = await books.findOne(bookKey);
    if (book) {
      const borrowedAt = new Date(2026, 10, 8);
      const dueAt = new Date(2026, 10, 22);
      await loans.updateOne(
        {
          user_id: user._id,
          book_id: book._id,
          status: 'borrowed',
          demo_seed_key: SEED_MARKER,
        },
        {
          $setOnInsert: {
            user_id: user._id,
            student_id: student.roll,
            book_id: book._id,
            book_title: book.title,
            book_isbn: book.isbn,
            borrowing_slot: index % 5,
            status: 'borrowed',
            borrowed_at: borrowedAt,
            due_at: dueAt,
            returned_at: null,
            is_demo: true,
            synthetic_demo: true,
            demo_seed_key: SEED_MARKER,
          },
        },
        { upsert: true },
      );
    }
  }

  await fs.writeFile(CREDENTIAL_FILE, JSON.stringify(studentCredentials(), null, 2) + '\n', { mode: 0o600 });

  return {
    created: created.length,
    existing: existing.length,
  };
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Realistic demo seeding is disabled in production.');
  }
  const client = new MongoClient(LOCAL_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(DATABASE_NAME);
    if (db.databaseName !== DATABASE_NAME) {
      throw new Error(`Refusing to seed a database other than ${DATABASE_NAME}.`);
    }
    const result = await seedRealisticDemoStudents({ db });
    console.log(`Database: localhost/${DATABASE_NAME}`);
    console.log(`Created accounts: ${result.created}`);
    console.log(`Existing accounts preserved: ${result.existing}`);
    console.log('Password credentials: stored only in the ignored local credential file.');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Realistic demo seeding failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DATABASE_NAME,
  DEMO_STUDENTS,
  SEED_MARKER,
  seedRealisticDemoStudents,
};
