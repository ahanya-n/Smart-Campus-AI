const express = require('express');
const { ROLES } = require('../auth/users');

const LOCAL_DEMO_SEED_MARKER = 'smart-campus-local-demo-v1';

function createStudentRouter({
  authenticate,
  requireRoles,
  getStudentsCollection,
  getTimetableCollection,
}) {
  const router = express.Router();

  router.get('/me', authenticate, requireRoles('student'), async (request, response, next) => {
    const studentId = request.user.student_id;
    if (typeof studentId !== 'string' || !studentId.trim()) {
      return response.status(404).json({ detail: 'Student profile not found' });
    }

    try {
      const collection = await getStudentsCollection();
      const student = await collection.findOne(
        { student_id: studentId },
        { projection: { _id: 0 } },
      );
      if (!student) {
        return response.status(404).json({ detail: 'Student profile not found' });
      }
      return response.json(student);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', authenticate, async (request, response, next) => {
    const role = ROLES.includes(request.user.role) ? request.user.role : 'student';
    if (
      role === 'student' &&
      (typeof request.user.student_id !== 'string' || !request.user.student_id.trim())
    ) {
      return response.json([]);
    }
    let filter = role === 'student'
      ? { student_id: request.user.student_id }
      : {};
    if (role === 'faculty') {
      const seededDemo =
        request.user.local_demo_seed === LOCAL_DEMO_SEED_MARKER;
      const subjects = Array.isArray(request.user.assigned_subject_codes)
        ? request.user.assigned_subject_codes.map((code) => String(code).trim().toUpperCase()).filter(Boolean)
        : [];
      const classes = await (await getTimetableCollection()).find({
        ...(seededDemo
          ? { is_demo: true, synthetic_demo: true }
          : { is_demo: { $ne: true }, synthetic_demo: { $ne: true } }),
        $or: [
          { faculty_user_id: String(request.user._id) },
          {
            $and: [
              {
                $or: [
                  { faculty_user_id: null },
                  { faculty_user_id: { $exists: false } },
                ],
              },
              { subject_code: { $in: subjects } },
            ],
          },
        ],
      }, { projection: { _id: 0, department: 1, semester: 1 } }).toArray();
      const groups = new Map();
      for (const entry of classes) {
        const department = entry.department;
        const semester = entry.semester;
        if (
          typeof department !== 'string' ||
          !department.trim() ||
          semester === null ||
          semester === undefined ||
          typeof semester === 'boolean'
        ) {
          continue;
        }
        const semesterText = String(semester).trim();
        if (!semesterText) continue;
        const numericSemester = /^\d+$/.test(semesterText)
          ? Number(semesterText)
          : null;
        groups.set(`${department}\u0000${semesterText}`, {
          department,
          semester: numericSemester === null
            ? semester
            : { $in: [numericSemester, semesterText] },
        });
      }

      if (groups.size === 0) return response.json([]);
      filter = {
        $and: [
          { $or: [...groups.values()] },
          seededDemo
            ? { local_demo_seed: LOCAL_DEMO_SEED_MARKER }
            : { is_demo: { $ne: true }, synthetic_demo: { $ne: true } },
        ],
      };
    }

    try {
      const collection = await getStudentsCollection();
      const students = await collection
        .find(filter, { projection: { _id: 0 } })
        .toArray();
      return response.json(students);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createStudentRouter };
