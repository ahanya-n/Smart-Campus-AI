const express = require('express');
const { ObjectId } = require('mongodb');
const { ROLES } = require('../auth/users');

const CODE_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = Object.freeze(['present', 'absent']);
const DEMO_STUDENT_ID = 'MCA001';
const LOCAL_DEMO_SEED_MARKER = 'smart-campus-local-demo-v1';
const LOW_ATTENDANCE_THRESHOLD = 75;
const NOT_LINKED_MESSAGE =
  'Your account is not linked to a student record yet. Ask the college admin for a link code, or view the demo data instead.';

function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function percentage(present, total) {
  return total > 0 ? Math.round((present / total) * 10000) / 100 : 0;
}

function studentInfo(student) {
  if (!student) return null;
  return {
    student_id: String(student.student_id || ''),
    name: String(student.name || ''),
    department: String(student.department || ''),
    semester: String(student.semester || ''),
  };
}

function attendanceRecord(document, studentName) {
  const total = Math.max(Number.parseInt(document.total_classes, 10) || 0, 0);
  const present = Math.min(
    Math.max(Number.parseInt(document.present_classes, 10) || 0, 0),
    total,
  );
  const pct = percentage(present, total);
  const record = {
    student_id: String(document.student_id || ''),
    subject_code: String(document.subject_code || ''),
    subject_name: String(document.subject_name || ''),
    total_classes: total,
    present_classes: present,
    absent_classes: total - present,
    attendance_percentage: pct,
    low_attendance: pct < LOW_ATTENDANCE_THRESHOLD,
    is_demo: Boolean(document.is_demo),
    updated_at: document.updated_at || null,
  };
  if (studentName !== undefined) record.student_name = studentName;
  return record;
}

function attendanceSummary(records) {
  const total = records.reduce((sum, record) => sum + record.total_classes, 0);
  const present = records.reduce((sum, record) => sum + record.present_classes, 0);
  return {
    total_classes: total,
    present_classes: present,
    absent_classes: total - present,
    attendance_percentage: percentage(present, total),
    subject_count: records.length,
    low_attendance_subjects: records
      .filter((record) => record.low_attendance)
      .map((record) => record.subject_name),
    threshold: LOW_ATTENDANCE_THRESHOLD,
  };
}

function studentContextQuery(studentId, demo, seededDemo = false) {
  if (!studentId) return null;
  return {
    student_id: studentId,
    is_demo: demo || seededDemo ? true : { $ne: true },
    ...(seededDemo ? { synthetic_demo: true } : {}),
  };
}

function isLocalDemoAccount(user) {
  return user?.local_demo_seed === LOCAL_DEMO_SEED_MARKER;
}

async function buildReport({
  student,
  query,
  linked,
  demo,
  getAttendanceCollection,
}) {
  let documents = [];
  if (query) {
    const collection = await getAttendanceCollection();
    documents = await collection
      .find(query, { projection: { _id: 0 } })
      .sort({ subject_code: 1 })
      .toArray();
  }
  const records = documents.map((document) => attendanceRecord(document));
  const isDemo = demo || records.some((record) => record.is_demo);
  let message = null;
  if (!query) {
    message = demo ? 'Demo data is not available.' : NOT_LINKED_MESSAGE;
  } else if (records.length === 0) {
    message = 'No official attendance has been recorded yet.';
  } else if (isDemo) {
    message = 'DEMO DATA: sample records for demonstration, not official attendance.';
  }
  return {
    linked,
    is_demo: isDemo,
    message,
    student: studentInfo(student),
    summary: attendanceSummary(records),
    records,
  };
}

function validateSessionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  if (typeof body.subject_code !== 'string' || !CODE_PATTERN.test(body.subject_code)) {
    return 'subject_code must contain 1-20 letters, digits, or dashes';
  }
  if (
    typeof body.subject_name !== 'string' ||
    body.subject_name.length < 1 ||
    body.subject_name.length > 120
  ) {
    return 'subject_name must be between 1 and 120 characters';
  }
  if (!isDateString(body.session_date)) return 'session_date must be a valid date';
  const sessionDay = new Date(`${body.session_date}T00:00:00.000Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const earliest = new Date(today);
  earliest.setUTCDate(earliest.getUTCDate() - 366);
  if (sessionDay > today) return 'session_date cannot be in the future';
  if (sessionDay < earliest) return 'session_date cannot be more than a year ago';
  if (typeof body.start_time !== 'string' || !TIME_PATTERN.test(body.start_time)) {
    return 'start_time must use 24-hour HH:MM format';
  }
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 500) {
    return 'records must contain between 1 and 500 attendance marks';
  }
  const studentIds = new Set();
  for (const record of body.records) {
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.student_id !== 'string' ||
      record.student_id.length < 1 ||
      record.student_id.length > 50
    ) {
      return 'Each record must have a student_id between 1 and 50 characters';
    }
    if (!STATUSES.includes(record.status)) {
      return 'status must be present or absent';
    }
    if (studentIds.has(record.student_id)) {
      return 'Each student can only appear once per session';
    }
    studentIds.add(record.student_id);
  }
  return null;
}

function ensureCanManageSubject(user, subjectCode, response) {
  if (user.role === 'admin') return true;
  const assigned = Array.isArray(user.assigned_subject_codes)
    ? user.assigned_subject_codes.map(String)
    : [];
  if (assigned.includes(subjectCode.toUpperCase())) return true;
  response.status(403).json({
    detail: `You are not assigned to subject ${subjectCode}. Ask an admin to assign it.`,
  });
  return false;
}

async function studentNames(getStudentsCollection, ids) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};
  const collection = await getStudentsCollection();
  const documents = await collection
    .find(
      { student_id: { $in: uniqueIds } },
      { projection: { student_id: 1, name: 1 } },
    )
    .toArray();
  return Object.fromEntries(
    documents.map((document) => [document.student_id, String(document.name || '')]),
  );
}

function toEntry(document, names) {
  return {
    id: String(document._id),
    student_id: document.student_id,
    student_name: names[document.student_id] || '',
    subject_code: document.subject_code,
    subject_name: document.subject_name || '',
    session_date: document.session_date,
    start_time: document.start_time,
    status: document.status,
    recorded_by_name: document.recorded_by_name || '',
    updated_at: document.updated_at || null,
  };
}

function createAttendanceRouter({
  authenticate,
  requireRoles,
  getStudentsCollection,
  getAttendanceCollection,
  getAttendanceEntriesCollection,
}) {
  const router = express.Router();
  const staffOnly = requireRoles('faculty', 'admin');

  async function getStudentContext(user, demo) {
    const studentId = demo ? DEMO_STUDENT_ID : user.student_id;
    if (!studentId) return { student: null, demo };
    const collection = await getStudentsCollection();
    const student = await collection.findOne(
      { student_id: studentId },
      { projection: { _id: 0 } },
    );
    return { student, demo };
  }

  router.get('/me', authenticate, async (request, response, next) => {
    const demo = parseBoolean(request.query.demo);
    if (demo === null) {
      return response.status(422).json({ detail: 'demo must be a boolean' });
    }
    try {
      const context = await getStudentContext(request.user, demo);
      const seededDemo =
        isLocalDemoAccount(request.user) &&
        context.student?.local_demo_seed === LOCAL_DEMO_SEED_MARKER;
      const query = studentContextQuery(context.student?.student_id, demo, seededDemo);
      return response.json(await buildReport({
        ...context,
        query,
        linked: Boolean(context.student) && !demo,
        getAttendanceCollection,
      }));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/summary', authenticate, async (request, response, next) => {
    const demo = parseBoolean(request.query.demo);
    if (demo === null) {
      return response.status(422).json({ detail: 'demo must be a boolean' });
    }
    try {
      const context = await getStudentContext(request.user, demo);
      const seededDemo =
        isLocalDemoAccount(request.user) &&
        context.student?.local_demo_seed === LOCAL_DEMO_SEED_MARKER;
      const query = studentContextQuery(context.student?.student_id, demo, seededDemo);
      const report = await buildReport({
        ...context,
        query,
        linked: Boolean(context.student) && !demo,
        getAttendanceCollection,
      });
      const { records, ...summary } = report;
      return response.json(summary);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/sessions', authenticate, staffOnly, async (request, response, next) => {
    const validationError = validateSessionBody(request.body);
    if (validationError) return response.status(422).json({ detail: validationError });

    const subjectCode = request.body.subject_code.toUpperCase();
    if (!ensureCanManageSubject(request.user, subjectCode, response)) return;

    try {
      const ids = request.body.records.map((record) => record.student_id);
      const names = await studentNames(getStudentsCollection, ids);
      const unknown = ids.filter((id) => !Object.hasOwn(names, id));
      if (unknown.length) {
        return response.status(422).json({ detail: `Unknown student IDs: ${unknown.join(', ')}` });
      }

      const collection = await getAttendanceEntriesCollection();
      const aggregateCollection = await getAttendanceCollection();
      const now = new Date();
      let created = 0;
      let updated = 0;
      let unchanged = 0;

      for (const mark of request.body.records) {
        const key = {
          student_id: mark.student_id,
          subject_code: subjectCode,
          session_date: request.body.session_date,
          start_time: request.body.start_time,
        };
        const existing = await collection.findOne(key, { projection: { status: 1 } });
        if (existing && existing.status === mark.status) {
          unchanged += 1;
          continue;
        }
        await collection.updateOne(
          key,
          {
            $set: {
              status: mark.status,
              subject_name: request.body.subject_name,
              updated_at: now,
              recorded_by: String(request.user._id),
              recorded_by_name: request.user.name || '',
            },
            $setOnInsert: { created_at: now },
          },
          { upsert: true },
        );
        if (existing) updated += 1;
        else created += 1;

        const base = { student_id: mark.student_id, subject_code: subjectCode };
        const total = await collection.countDocuments(base);
        const present = await collection.countDocuments({ ...base, status: 'present' });
        if (total > 0) {
          await aggregateCollection.updateOne(
            { ...base, is_demo: false },
            {
              $set: {
                subject_name: request.body.subject_name,
                total_classes: total,
                present_classes: present,
                absent_classes: total - present,
                attendance_percentage: percentage(present, total),
                updated_at: now,
                is_demo: false,
              },
            },
            { upsert: true },
          );
        }
      }

      return response.json({
        subject_code: subjectCode,
        session_date: request.body.session_date,
        start_time: request.body.start_time,
        created,
        updated,
        unchanged,
      });
    } catch (error) {
      if (error.code === 11000) {
        return response.status(409).json({ detail: 'Attendance entry already exists' });
      }
      return next(error);
    }
  });

  router.get('/sessions', authenticate, staffOnly, async (request, response, next) => {
    const { subject_code: subjectCode, session_date: sessionDate } = request.query;
    const startTime = request.query.start_time;
    if (typeof subjectCode !== 'string' || !CODE_PATTERN.test(subjectCode)) {
      return response.status(422).json({ detail: 'subject_code must contain 1-20 letters, digits, or dashes' });
    }
    if (!isDateString(sessionDate)) {
      return response.status(422).json({ detail: 'session_date must be a valid date' });
    }
    if (startTime !== undefined && (typeof startTime !== 'string' || !TIME_PATTERN.test(startTime))) {
      return response.status(422).json({ detail: 'start_time must use 24-hour HH:MM format' });
    }
    const normalizedCode = subjectCode.toUpperCase();
    if (!ensureCanManageSubject(request.user, normalizedCode, response)) return;

    try {
      const query = { subject_code: normalizedCode, session_date: sessionDate };
      if (startTime) query.start_time = startTime;
      const collection = await getAttendanceEntriesCollection();
      const documents = await collection
        .find(query)
        .sort({ start_time: 1, student_id: 1 })
        .toArray();
      const names = await studentNames(
        getStudentsCollection,
        documents.map((document) => document.student_id),
      );
      return response.json(documents.map((document) => toEntry(document, names)));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/entries/:entry_id', authenticate, staffOnly, async (request, response, next) => {
    const entryId = request.params.entry_id;
    if (!/^[a-f\d]{24}$/i.test(entryId)) {
      return response.status(404).json({ detail: 'Attendance entry not found' });
    }
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      !STATUSES.includes(request.body.status)
    ) {
      return response.status(422).json({ detail: 'status must be present or absent' });
    }
    try {
      const collection = await getAttendanceEntriesCollection();
      const objectId = new ObjectId(entryId);
      const entry = await collection.findOne({ _id: objectId });
      if (!entry) return response.status(404).json({ detail: 'Attendance entry not found' });
      if (!ensureCanManageSubject(request.user, entry.subject_code, response)) return;
      const now = new Date();
      await collection.updateOne(
        { _id: objectId },
        {
          $set: {
            status: request.body.status,
            updated_at: now,
            recorded_by: String(request.user._id),
            recorded_by_name: request.user.name || '',
          },
        },
      );
      const base = { student_id: entry.student_id, subject_code: entry.subject_code };
      const total = await collection.countDocuments(base);
      const present = await collection.countDocuments({ ...base, status: 'present' });
      if (total > 0) {
        await (await getAttendanceCollection()).updateOne(
          { ...base, is_demo: false },
          {
            $set: {
              subject_name: entry.subject_name || '',
              total_classes: total,
              present_classes: present,
              absent_classes: total - present,
              attendance_percentage: percentage(present, total),
              updated_at: now,
              is_demo: false,
            },
          },
          { upsert: true },
        );
      }
      const updatedEntry = await collection.findOne({ _id: objectId });
      const names = await studentNames(getStudentsCollection, [updatedEntry.student_id]);
      return response.json(toEntry(updatedEntry, names));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/records', authenticate, staffOnly, async (request, response, next) => {
    const subjectCode = request.query.subject_code;
    const studentId = request.query.student_id;
    const includeDemo = parseBoolean(request.query.include_demo);
    if (includeDemo === null) {
      return response.status(422).json({ detail: 'include_demo must be a boolean' });
    }
    if (
      subjectCode !== undefined &&
      (typeof subjectCode !== 'string' || !CODE_PATTERN.test(subjectCode))
    ) {
      return response.status(422).json({ detail: 'subject_code must contain 1-20 letters, digits, or dashes' });
    }
    if (studentId !== undefined && (typeof studentId !== 'string' || studentId.length > 50)) {
      return response.status(422).json({ detail: 'student_id cannot exceed 50 characters' });
    }

    const query = {};
    if (isLocalDemoAccount(request.user)) {
      query.is_demo = true;
      query.synthetic_demo = true;
    } else if (!includeDemo) {
      query.is_demo = { $ne: true };
    }
    if (subjectCode) {
      const normalizedCode = subjectCode.toUpperCase();
      if (!ensureCanManageSubject(request.user, normalizedCode, response)) return;
      query.subject_code = normalizedCode;
    } else if (request.user.role !== 'admin') {
      query.subject_code = { $in: Array.isArray(request.user.assigned_subject_codes)
        ? request.user.assigned_subject_codes.map(String)
        : [] };
    }
    if (studentId) query.student_id = studentId;

    try {
      const collection = await getAttendanceCollection();
      const documents = await collection
        .find(query, { projection: { _id: 0 } })
        .sort({ subject_code: 1, student_id: 1 })
        .limit(1000)
        .toArray();
      const names = await studentNames(
        getStudentsCollection,
        documents.map((document) => document.student_id),
      );
      return response.json(documents.map((document) =>
        attendanceRecord(document, names[document.student_id] || ''),
      ));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/students/:student_id', authenticate, staffOnly, async (request, response, next) => {
    const studentId = request.params.student_id;
    try {
      const students = await getStudentsCollection();
      const student = await students.findOne(
        { student_id: studentId },
        { projection: { _id: 0 } },
      );
      if (!student) {
        return response.status(404).json({ detail: `Student ${studentId} not found` });
      }
      const seededDemo =
        isLocalDemoAccount(request.user) &&
        student.local_demo_seed === LOCAL_DEMO_SEED_MARKER;
      const query = {
        student_id: studentId,
        is_demo: seededDemo ? true : { $ne: true },
        ...(seededDemo ? { synthetic_demo: true } : {}),
      };
      if (request.user.role !== 'admin') {
        query.subject_code = { $in: Array.isArray(request.user.assigned_subject_codes)
          ? request.user.assigned_subject_codes.map(String)
          : [] };
      }
      return response.json(await buildReport({
        student,
        query,
        linked: true,
        demo: false,
        getAttendanceCollection,
      }));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAttendanceRouter, validateSessionBody };
