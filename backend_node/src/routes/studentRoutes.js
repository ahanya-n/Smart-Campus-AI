const express = require('express');
const { ROLES } = require('../auth/users');
const {
  isTrustedDemoAccount,
  isTrustedDemoStudent,
  isTrustedDemoPair,
  trustedDemoFilter,
} = require('../dataFilters');

function createStudentRouter({
  authenticate,
  requireRoles,
  getStudentsCollection,
  getTimetableCollection,
  getAttendanceCollection,
  getAttendanceEntriesCollection,
  getAssignmentsCollection,
  getMarksCollection,
  getNotificationsCollection,
}) {
  const router = express.Router();

  router.get('/assignments/me', authenticate, requireRoles('student'), async (request, response, next) => {
    const studentId = typeof request.user.student_id === 'string'
      ? request.user.student_id.trim()
      : '';
    if (!studentId) {
      return response.status(404).json({ detail: 'Student profile not found' });
    }
    try {
      const assignments = await getAssignmentsCollection();
      const items = await assignments.find(
        {
          student_id: studentId,
          ...trustedDemoFilter(request.user),
        },
        { projection: { _id: 0 } },
      ).sort({ due_date: 1 }).toArray();
      return response.json({
        total: items.length,
        pending: items.filter((item) => item.status !== 'submitted').length,
        submitted: items.filter((item) => item.status === 'submitted').length,
        items,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/dashboard/me', authenticate, requireRoles('student'), async (request, response, next) => {
    const studentId = typeof request.user.student_id === 'string'
      ? request.user.student_id.trim()
      : '';
    if (!studentId) {
      return response.status(404).json({ detail: 'Student profile not found' });
    }
    try {
      const students = await getStudentsCollection();
      const profile = await students.findOne(
        { student_id: studentId },
        { projection: { _id: 0 } },
      );
      if (!profile) {
        return response.status(404).json({ detail: 'Student profile not found' });
      }
      if (
        (isTrustedDemoAccount(request.user) || isTrustedDemoStudent(profile))
        &&
        !isTrustedDemoPair(request.user, profile)
      ) {
        return response.status(409).json({
          detail: 'The authenticated account and linked student profile have mismatched demo ownership.',
        });
      }

      const academicVisibility = trustedDemoFilter(request.user);
      const [attendanceRecords, timetableRecords, marksRecords, assignmentRecords, notificationRecords] =
        await Promise.all([
          (await getAttendanceCollection()).find(
            { student_id: studentId, ...academicVisibility },
            { projection: { _id: 0 } },
          ).toArray(),
          (await getTimetableCollection()).find(
            {
              department: profile.department,
              semester: profile.semester,
              $or: [
                { section: profile.section },
                { section: { $exists: false } },
              ],
              ...academicVisibility,
            },
            { projection: { _id: 0 } },
          ).toArray(),
          (await getMarksCollection()).find(
            { student_id: studentId, ...academicVisibility },
            { projection: { _id: 0 } },
          ).toArray(),
          getAssignmentsCollection
            ? (await getAssignmentsCollection()).find(
              { student_id: studentId, ...academicVisibility },
              { projection: { _id: 0 } },
            ).toArray()
            : [],
          (await getNotificationsCollection()).find(
            { student_id: studentId, ...academicVisibility },
            { projection: { _id: 0 } },
          ).sort({ created_at: -1 }).limit(10).toArray(),
        ]);

      const totalClasses = attendanceRecords.reduce((sum, record) =>
        sum + (Number(record.total_classes) || 0), 0);
      const presentClasses = attendanceRecords.reduce((sum, record) =>
        sum + (Number(record.present_classes) || 0), 0);
      const attendancePercentage = totalClasses > 0
        ? Math.round((presentClasses / totalClasses) * 10000) / 100
        : null;

      const subjectMarks = new Map();
      for (const mark of marksRecords) {
        const code = String(mark.subject_code || '');
        const score = Number(mark.score);
        const maximum = Number(mark.max_score);
        if (!code || !Number.isFinite(score) || !Number.isFinite(maximum) || maximum <= 0) continue;
        if (!subjectMarks.has(code)) subjectMarks.set(code, []);
        subjectMarks.get(code).push((score / maximum) * 100);
      }
      const subjectPercentages = [...subjectMarks.values()].map((scores) =>
        scores.reduce((sum, score) => sum + score, 0) / scores.length);
      const cgpa = subjectPercentages.length
        ? Math.round((subjectPercentages.reduce((sum, score) => sum + score, 0) /
          subjectPercentages.length / 10) * 100) / 100
        : null;

      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const today = weekdays[new Date().getDay()];
      const todayTimetable = timetableRecords
        .filter((entry) => entry.day_of_week === today)
        .sort((left, right) => String(left.start_time).localeCompare(String(right.start_time)));
      const now = new Date();
      const upcomingAssignments = assignmentRecords
        .map((assignment) => ({
          ...assignment,
          due_date: assignment.due_date instanceof Date
            ? assignment.due_date.toISOString()
            : String(assignment.due_date || ''),
        }))
        .filter((assignment) => assignment.status !== 'submitted')
        .sort((left, right) => String(left.due_date).localeCompare(String(right.due_date)))
        .slice(0, 6);
      const submittedAssignments = assignmentRecords.filter((assignment) =>
        assignment.status === 'submitted').length;
      const pendingAssignments = assignmentRecords.filter((assignment) =>
        assignment.status !== 'submitted').length;

      let studyStreak = 0;
      if (getAttendanceEntriesCollection) {
        const entries = await (await getAttendanceEntriesCollection()).find(
          { student_id: studentId, status: 'present', ...academicVisibility },
          { projection: { _id: 0, session_date: 1 } },
        ).sort({ session_date: -1 }).limit(30).toArray();
        const dates = [...new Set(entries.map((entry) => String(entry.session_date || '').slice(0, 10)))];
        const cursor = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
        while (dates.includes(cursor.toISOString().slice(0, 10))) {
          studyStreak += 1;
          cursor.setUTCDate(cursor.getUTCDate() - 1);
        }
      }

      return response.json({
        profile: {
          name: profile.name || '',
          email: profile.email || '',
          student_id: profile.student_id,
          roll_number: profile.registration_number || profile.roll_number || profile.student_id,
          department: profile.department || '',
          course: profile.course || profile.department || '',
          semester: profile.semester,
          section: profile.section || '',
          avatar_url: profile.avatar_url || null,
        },
        attendance: {
          percentage: attendancePercentage,
          present_classes: presentClasses,
          total_classes: totalClasses,
          subject_count: attendanceRecords.length,
          records: attendanceRecords,
        },
        cgpa,
        study_streak: studyStreak,
        timetable: {
          today,
          entries: todayTimetable,
        },
        marks: marksRecords,
        assignments: {
          total: assignmentRecords.length,
          pending: pendingAssignments,
          submitted: submittedAssignments,
          upcoming: upcomingAssignments,
        },
        notifications: notificationRecords,
        is_demo: Boolean(profile.is_demo || profile.synthetic_demo),
      });
    } catch (error) {
      return next(error);
    }
  });

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
        isTrustedDemoAccount(request.user);
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
            ? trustedDemoFilter(request.user)
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
