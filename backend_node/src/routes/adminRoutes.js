const crypto = require('node:crypto');
const express = require('express');
const { ObjectId } = require('mongodb');
const { hashPassword } = require('../auth/passwords');
const { EMAIL_PATTERN, ROLES, normalizeEmail } = require('../auth/users');

const CODE_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LINK_CODE_LENGTH = 10;
const CODE_VALID_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINK_CODE_ATTEMPTS = 5;

function idString(value) {
  return String(value);
}

function adminUser(document) {
  return {
    id: idString(document._id),
    name: document.name || '',
    email: document.email || '',
    role: ROLES.includes(document.role) ? document.role : 'student',
    student_id: document.student_id ?? null,
    registration_number: document.registration_number ?? null,
    faculty_id: document.faculty_id ?? null,
    department: document.department ?? null,
    designation: document.designation ?? null,
    assigned_subject_codes: Array.isArray(document.assigned_subject_codes)
      ? document.assigned_subject_codes
      : [],
    assigned_class_ids: Array.isArray(document.assigned_class_ids)
      ? document.assigned_class_ids
      : [],
  };
}

function validateCreateUser(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 100 || !body.name.trim()) {
    return 'name must be between 1 and 100 characters';
  }
  if (
    typeof body.email !== 'string' ||
    body.email.length < 3 ||
    body.email.length > 254 ||
    !EMAIL_PATTERN.test(normalizeEmail(body.email))
  ) {
    return 'Please enter a valid email';
  }
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
    return 'Password must be 8-128 characters long';
  }
  if (!ROLES.includes(body.role)) return `Role must be one of: ${ROLES.join(', ')}`;
  return null;
}

function createAdminRouter({
  authenticate,
  requireRoles,
  getUsersCollection,
  getStudentsCollection,
  getSubjectsCollection,
  getClassesCollection,
  getLinkCodesCollection,
  getAttendanceEntriesCollection,
  getTimetableCollection,
  getBooksCollection,
  getComplaintsCollection,
}) {
  const router = express.Router();
  const adminOnly = requireRoles('admin');

  async function findUser(id) {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    return (await getUsersCollection()).findOne({ _id: new ObjectId(id) });
  }

  async function updateUser(id, update, response) {
    const user = await findUser(id);
    if (!user) {
      response.status(404).json({ detail: 'User not found' });
      return null;
    }
    await (await getUsersCollection()).updateOne({ _id: user._id }, update);
    const updated = await findUser(id);
    return adminUser(updated);
  }

  router.get('/users', authenticate, adminOnly, async (_request, response, next) => {
    try {
      const users = await (await getUsersCollection())
        .find({}, { projection: { password: 0 } })
        .sort({ name: 1 })
        .toArray();
      return response.json(users.map(adminUser));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/users', authenticate, adminOnly, async (request, response, next) => {
    const validationError = validateCreateUser(request.body);
    if (validationError) return response.status(422).json({ detail: validationError });
    try {
      const collection = await getUsersCollection();
      const email = normalizeEmail(request.body.email);
      const existing = await collection.findOne({
        email: { $in: [...new Set([request.body.email.trim(), email])] },
      });
      if (existing) return response.status(400).json({ detail: 'Email already registered' });
      const document = {
        name: request.body.name.trim(),
        email,
        password: await hashPassword(request.body.password),
        role: request.body.role,
      };
      if (document.role === 'faculty') document.assigned_subject_codes = [];
      const result = await collection.insertOne(document);
      return response.status(201).json(adminUser({ ...document, _id: result.insertedId }));
    } catch (error) {
      if (error.code === 11000) return response.status(400).json({ detail: 'Email already registered' });
      return next(error);
    }
  });

  router.patch('/users/:user_id/role', authenticate, adminOnly, async (request, response, next) => {
    const role = request.body?.role;
    if (!ROLES.includes(role)) {
      return response.status(422).json({ detail: `Role must be one of: ${ROLES.join(', ')}` });
    }
    try {
      const user = await findUser(request.params.user_id);
      if (!user) return response.status(404).json({ detail: 'User not found' });
      if (user.role === 'admin' && role !== 'admin') {
        if (String(user._id) === String(request.user._id)) {
          return response.status(409).json({ detail: 'You cannot remove your own admin role' });
        }
        const adminCount = await (await getUsersCollection()).countDocuments({ role: 'admin' });
        if (adminCount <= 1) {
          return response.status(409).json({ detail: 'Cannot remove the last admin' });
        }
      }
      const update = { $set: { role } };
      if (role === 'faculty' && !Array.isArray(user.assigned_subject_codes)) {
        update.$set.assigned_subject_codes = [];
      }
      const result = await updateUser(request.params.user_id, update, response);
      return result ? response.json(result) : undefined;
    } catch (error) {
      return next(error);
    }
  });

  router.put('/users/:user_id/subjects', authenticate, adminOnly, async (request, response, next) => {
    const codes = request.body?.subject_codes;
    if (!Array.isArray(codes) || codes.length > 50) {
      return response.status(422).json({ detail: 'subject_codes must contain no more than 50 codes' });
    }
    const normalized = [];
    for (const rawCode of codes) {
      if (typeof rawCode !== 'string' || !CODE_PATTERN.test(rawCode.trim())) {
        return response.status(422).json({ detail: `Invalid subject code: ${typeof rawCode === 'string' ? rawCode.trim() || '(empty)' : '(empty)'}` });
      }
      const code = rawCode.trim().toUpperCase();
      if (!normalized.includes(code)) normalized.push(code);
    }
    try {
      const user = await findUser(request.params.user_id);
      if (!user) return response.status(404).json({ detail: 'User not found' });
      if (user.role !== 'faculty') {
        return response.status(409).json({ detail: 'Subjects can only be assigned to faculty accounts' });
      }
      const result = await updateUser(
        request.params.user_id,
        { $set: { assigned_subject_codes: normalized } },
        response,
      );
      return result ? response.json(result) : undefined;
    } catch (error) {
      return next(error);
    }
  });

  router.put('/users/:user_id/student-link', authenticate, adminOnly, async (request, response, next) => {
    const studentId = request.body?.student_id ?? null;
    if (studentId !== null && (
      typeof studentId !== 'string' ||
      studentId.length > 50
    )) {
      return response.status(422).json({ detail: 'student_id cannot exceed 50 characters' });
    }
    try {
      const user = await findUser(request.params.user_id);
      if (!user) return response.status(404).json({ detail: 'User not found' });
      if (studentId === null) {
        const result = await updateUser(
          request.params.user_id,
          { $unset: { student_id: '' } },
          response,
        );
        return result ? response.json(result) : undefined;
      }
      const normalizedStudentId = studentId.trim();
      if (!normalizedStudentId) return response.status(422).json({ detail: 'student_id cannot be empty' });
      if (user.role !== 'student') {
        return response.status(409).json({ detail: 'Only student accounts can be linked to a student record' });
      }
      if (!await (await getStudentsCollection()).findOne({ student_id: normalizedStudentId }, { projection: { _id: 1 } })) {
        return response.status(404).json({ detail: `Student ${normalizedStudentId} not found` });
      }
      const other = await (await getUsersCollection()).findOne({
        student_id: normalizedStudentId,
        _id: { $ne: user._id },
      }, { projection: { _id: 1 } });
      if (other) {
        return response.status(409).json({ detail: `Student ${normalizedStudentId} is already linked to another account` });
      }
      try {
        const result = await updateUser(
          request.params.user_id,
          { $set: { student_id: normalizedStudentId } },
          response,
        );
        return result ? response.json(result) : undefined;
      } catch (error) {
        if (error.code === 11000) {
          return response.status(409).json({ detail: `Student ${normalizedStudentId} is already linked to another account` });
        }
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  router.post('/students/:student_id/link-code', authenticate, adminOnly, async (request, response, next) => {
    const studentId = request.params.student_id;
    if (!studentId || studentId.length > 50) {
      return response.status(422).json({ detail: 'student_id must be between 1 and 50 characters' });
    }
    try {
      const students = await getStudentsCollection();
      if (!await students.findOne({ student_id: studentId }, { projection: { _id: 1 } })) {
        return response.status(404).json({ detail: `Student ${studentId} not found` });
      }
      const code = Array.from({ length: LINK_CODE_LENGTH }, () =>
        ALPHABET[crypto.randomInt(ALPHABET.length)],
      ).join('');
      const expiresAt = new Date(Date.now() + CODE_VALID_MS);
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      await (await getLinkCodesCollection()).updateOne(
        { student_id: studentId },
        {
          $set: {
            code_hash: codeHash,
            expires_at: expiresAt,
            attempts: 0,
            issued_by: String(request.user._id),
          },
        },
        { upsert: true },
      );
      return response.status(201).json({
        student_id: studentId,
        link_code: code,
        expires_at: expiresAt,
        note: 'Give this code only to the student in person. It is shown once.',
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/stats', authenticate, adminOnly, async (_request, response, next) => {
    try {
      const [
        users,
        students,
        subjects,
        classes,
        attendanceEntries,
        timetable,
        books,
        complaints,
      ] = await Promise.all([
        getUsersCollection(),
        getStudentsCollection(),
        getSubjectsCollection(),
        getClassesCollection(),
        getAttendanceEntriesCollection(),
        getTimetableCollection(),
        getBooksCollection(),
        getComplaintsCollection(),
      ]);
      const [
        totalFaculty,
        totalUsers,
        totalStudents,
        totalSubjects,
        totalClasses,
        totalAttendanceSessions,
        totalClassesScheduled,
        totalBooks,
        pendingComplaints,
      ] = await Promise.all([
        users.countDocuments({ role: 'faculty' }),
        users.countDocuments({}),
        students.countDocuments({}),
        subjects.countDocuments({}),
        classes.countDocuments({}),
        attendanceEntries.countDocuments({}),
        timetable.countDocuments({ is_demo: { $ne: true } }),
        books.countDocuments({}),
        complaints.countDocuments({ status: 'pending' }),
      ]);
      return response.json({
        total_students: totalStudents,
        total_faculty: totalFaculty,
        total_users: totalUsers,
        total_subjects: totalSubjects,
        total_classes: totalClasses,
        total_attendance_sessions: totalAttendanceSessions,
        total_classes_scheduled: totalClassesScheduled,
        total_books: totalBooks,
        pending_complaints: pendingComplaints,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { adminUser, createAdminRouter, validateCreateUser };
