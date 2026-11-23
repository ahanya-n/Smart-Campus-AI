const express = require('express');
const { ObjectId } = require('mongodb');
const { ROLES } = require('../auth/users');
const {
  isTrustedDemoAccount,
  isTrustedDemoStudent,
  trustedDemoFilter,
} = require('../dataFilters');

const DAYS = Object.freeze([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);
const CODE_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function entryOutput(document) {
  return {
    id: String(document._id || ''),
    department: String(document.department || ''),
    semester: String(document.semester ?? ''),
    day_of_week: String(document.day_of_week || ''),
    subject_code: String(document.subject_code || ''),
    subject_name: String(document.subject_name || ''),
    start_time: String(document.start_time || ''),
    end_time: String(document.end_time || ''),
    faculty_name: String(document.faculty_name || ''),
    faculty_user_id: document.faculty_user_id || null,
    room_number: String(document.room_number || ''),
    is_demo: Boolean(document.is_demo),
  };
}

function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  if (typeof body.department !== 'string' || body.department.length < 1 || body.department.length > 50) {
    return 'department must be between 1 and 50 characters';
  }
  if (!Number.isInteger(body.semester) || body.semester < 1 || body.semester > 12) {
    return 'semester must be an integer between 1 and 12';
  }
  if (!DAYS.includes(body.day_of_week)) return 'day_of_week is invalid';
  if (typeof body.subject_code !== 'string' || !CODE_PATTERN.test(body.subject_code)) {
    return 'subject_code must contain 1-20 letters, digits, or dashes';
  }
  if (typeof body.subject_name !== 'string' || body.subject_name.length < 1 || body.subject_name.length > 120) {
    return 'subject_name must be between 1 and 120 characters';
  }
  if (typeof body.start_time !== 'string' || !TIME_PATTERN.test(body.start_time)) {
    return 'start_time must use 24-hour HH:MM format';
  }
  if (typeof body.end_time !== 'string' || !TIME_PATTERN.test(body.end_time)) {
    return 'end_time must use 24-hour HH:MM format';
  }
  if (body.end_time <= body.start_time) return 'end_time must be after start_time';
  if (body.faculty_name !== undefined && body.faculty_name !== null &&
      (typeof body.faculty_name !== 'string' || body.faculty_name.length > 100)) {
    return 'faculty_name cannot exceed 100 characters';
  }
  if (
    body.faculty_user_id !== undefined &&
    body.faculty_user_id !== null &&
    (typeof body.faculty_user_id !== 'string' || !/^[a-f\d]{24}$/i.test(body.faculty_user_id))
  ) {
    return 'faculty_user_id must be a valid account identifier';
  }
  if (typeof body.room_number !== 'string' || body.room_number.length < 1 || body.room_number.length > 30) {
    return 'room_number must be between 1 and 30 characters';
  }
  return null;
}

function semesterValue(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : String(value);
}

function createTimetableRouter({
  authenticate,
  requireRoles,
  getStudentsCollection,
  getTimetableCollection,
  getUsersCollection,
}) {
  const router = express.Router();
  const staffOnly = requireRoles('faculty', 'admin');

  async function getContext(user, demo) {
    const studentId = demo ? 'MCA001' : user.student_id;
    if (!studentId) return null;
    return (await getStudentsCollection()).findOne(
      { student_id: studentId },
      { projection: { _id: 0 } },
    );
  }

  async function ensureSubjectAllowed(user, subjectCode, response) {
    if (user.role === 'admin') return true;
    const assigned = Array.isArray(user.assigned_subject_codes)
      ? user.assigned_subject_codes.map(String)
      : [];
    if (assigned.includes(subjectCode)) return true;
    response.status(403).json({
      detail: `You are not assigned to subject ${subjectCode}. Ask an admin to assign it.`,
    });
    return false;
  }

  async function prepareDocument(body, user, response) {
    const subjectCode = body.subject_code.toUpperCase();
    if (!await ensureSubjectAllowed(user, subjectCode, response)) return null;
    const document = {
      department: body.department,
      semester: body.semester,
      day_of_week: body.day_of_week,
      subject_code: subjectCode,
      subject_name: body.subject_name,
      start_time: body.start_time,
      end_time: body.end_time,
      faculty_name: body.faculty_name || '',
      faculty_user_id: body.faculty_user_id || null,
      room_number: body.room_number,
      is_demo: false,
      updated_at: new Date(),
    };
    if (user.role === 'faculty') {
      document.faculty_user_id = String(user._id);
      document.faculty_name = user.name || '';
    } else if (body.faculty_user_id) {
      const faculty = await (await getUsersCollection()).findOne(
        { _id: new ObjectId(body.faculty_user_id), role: 'faculty' },
        { projection: { name: 1 } },
      );
      if (!faculty) {
        response.status(422).json({ detail: 'faculty_user_id is not a faculty account' });
        return null;
      }
      document.faculty_name = body.faculty_name || faculty.name || '';
    } else if (!body.faculty_name) {
      response.status(422).json({ detail: 'faculty_name is required' });
      return null;
    }
    return document;
  }

  async function findEntry(id, response) {
    if (!/^[a-f\d]{24}$/i.test(id)) {
      response.status(404).json({ detail: 'Timetable entry not found' });
      return null;
    }
    const entry = await (await getTimetableCollection()).findOne({ _id: new ObjectId(id) });
    if (!entry) {
      response.status(404).json({ detail: 'Timetable entry not found' });
      return null;
    }
    if (entry.is_demo) {
      response.status(409).json({ detail: 'Demo timetable entries are read-only' });
      return null;
    }
    return entry;
  }

  async function checkConflicts(document, excludeId) {
    const clashes = [
      { department: document.department, semester: document.semester },
      { room_number: document.room_number },
    ];
    if (document.faculty_user_id) clashes.push({ faculty_user_id: document.faculty_user_id });
    const query = {
      is_demo: { $ne: true },
      day_of_week: document.day_of_week,
      start_time: { $lt: document.end_time },
      end_time: { $gt: document.start_time },
      $or: clashes,
    };
    if (excludeId) query._id = { $ne: excludeId };
    return (await getTimetableCollection()).findOne(query);
  }

  router.get('/today', authenticate, async (request, response, next) => {
    try {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'Asia/Kolkata',
      });
      return await getTimetable({
        ...request,
        query: { ...request.query, day: today },
      }, response, next);
    } catch (error) {
      return next(error);
    }
  });

  async function getTimetable(request, response, next) {
    const day = request.query.day;
    const department = request.query.department;
    const semester = request.query.semester;
    const demo = request.query.demo === undefined ? false : request.query.demo === 'true';
    if (request.query.demo !== undefined && !['true', 'false'].includes(request.query.demo)) {
      return response.status(422).json({ detail: 'demo must be a boolean' });
    }
    if (day !== undefined && !DAYS.includes(day) && day !== 'Sunday') {
      return response.status(422).json({ detail: 'day is invalid' });
    }
    if (department !== undefined && (typeof department !== 'string' || department.length > 50)) {
      return response.status(422).json({ detail: 'department cannot exceed 50 characters' });
    }
    if (semester !== undefined && (!/^\d+$/.test(semester) || Number(semester) < 1 || Number(semester) > 12)) {
      return response.status(422).json({ detail: 'semester must be between 1 and 12' });
    }
    try {
      const user = request.user;
      const role = ROLES.includes(user.role) ? user.role : 'student';
      const student = await getContext(user, demo);
      let query;
      let scope;
      let linked;
      if (demo) {
        scope = 'demo';
        linked = false;
        if (!student) {
          return response.json({
            linked: false,
            is_demo: true,
            scope,
            message: 'Demo data is not available.',
            student: null,
            day: day || null,
            entries: [],
          });
        }
        query = {
          department: student.department,
          semester: semesterValue(student.semester),
          is_demo: true,
        };
      } else if (role === 'student') {
        scope = 'student';
        linked = Boolean(student);
        if (!student) {
          return response.json({
            linked: false,
            is_demo: false,
            scope,
            message: 'Your account is not linked to a student record yet. Ask the college admin for a link code, or view the demo data instead.',
            student: null,
            day: day || null,
            entries: [],
          });
        }
        query = {
          department: student.department,
          semester: semesterValue(student.semester),
          ...(isTrustedDemoAccount(user) && isTrustedDemoStudent(student)
            ? trustedDemoFilter(user)
            : { is_demo: { $ne: true }, synthetic_demo: { $ne: true } }),
        };
      } else {
        scope = role;
        linked = true;
        const seededDemo = isTrustedDemoAccount(user);
        query = seededDemo
          ? { is_demo: true, synthetic_demo: true }
          : { is_demo: { $ne: true } };
        if (role === 'faculty') {
          query.$or = [
            { faculty_user_id: String(user._id) },
            { subject_code: { $in: Array.isArray(user.assigned_subject_codes)
              ? user.assigned_subject_codes.map(String)
              : [] } },
          ];
        }
        if (department) query.department = department;
        if (semester !== undefined) query.semester = Number(semester);
      }
      if (day) query.day_of_week = day;
      const documents = await (await getTimetableCollection()).find(query).toArray();
      documents.sort((left, right) =>
        DAYS.indexOf(left.day_of_week) - DAYS.indexOf(right.day_of_week) ||
        String(left.start_time).localeCompare(String(right.start_time)),
      );
      const entries = documents.map(entryOutput);
      const isDemo = demo || entries.some((entry) => entry.is_demo);
      let message = null;
      if (!entries.length) {
        message = day
          ? `No classes on ${day}.`
          : scope === 'student'
            ? 'No official timetable has been published yet.'
            : 'No timetable entries yet.';
      } else if (isDemo) {
        message = 'DEMO DATA: sample timetable for demonstration, not the official schedule.';
      }
      return response.json({
        linked,
        is_demo: isDemo,
        scope,
        message,
        student: scope === 'student' || scope === 'demo'
          ? studentInfo(student)
          : null,
        day: day || null,
        entries,
      });
    } catch (error) {
      return next(error);
    }
  }

  router.get('/', authenticate, getTimetable);

  router.post('/', authenticate, staffOnly, async (request, response, next) => {
    const validationError = validateInput(request.body);
    if (validationError) return response.status(422).json({ detail: validationError });
    try {
      const document = await prepareDocument(request.body, request.user, response);
      if (!document) return;
      const conflict = await checkConflicts(document);
      if (conflict) {
        return response.status(409).json({
          detail: `Schedule conflict with ${conflict.subject_code} (${conflict.start_time}-${conflict.end_time}, room ${conflict.room_number}, ${conflict.department} sem ${conflict.semester}) on ${document.day_of_week}`,
        });
      }
      const result = await (await getTimetableCollection()).insertOne(document);
      return response.status(201).json(entryOutput({ ...document, _id: result.insertedId }));
    } catch (error) {
      if (error.code === 11000) {
        return response.status(409).json({ detail: 'A class already starts at this time for this group' });
      }
      return next(error);
    }
  });

  router.put('/:entry_id', authenticate, staffOnly, async (request, response, next) => {
    const validationError = validateInput(request.body);
    if (validationError) return response.status(422).json({ detail: validationError });
    try {
      const existing = await findEntry(request.params.entry_id, response);
      if (!existing) return;
      if (!await ensureSubjectAllowed(request.user, existing.subject_code, response)) return;
      const document = await prepareDocument(request.body, request.user, response);
      if (!document) return;
      const conflict = await checkConflicts(document, existing._id);
      if (conflict) {
        return response.status(409).json({
          detail: `Schedule conflict with ${conflict.subject_code} (${conflict.start_time}-${conflict.end_time}, room ${conflict.room_number}, ${conflict.department} sem ${conflict.semester}) on ${document.day_of_week}`,
        });
      }
      await (await getTimetableCollection()).updateOne(
        { _id: existing._id },
        { $set: document },
      );
      return response.json(entryOutput({ ...document, _id: existing._id }));
    } catch (error) {
      if (error.code === 11000) {
        return response.status(409).json({ detail: 'A class already starts at this time for this group' });
      }
      return next(error);
    }
  });

  router.delete('/:entry_id', authenticate, staffOnly, async (request, response, next) => {
    try {
      const existing = await findEntry(request.params.entry_id, response);
      if (!existing) return;
      if (!await ensureSubjectAllowed(request.user, existing.subject_code, response)) return;
      await (await getTimetableCollection()).deleteOne({ _id: existing._id });
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
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

module.exports = { createTimetableRouter, validateInput };
