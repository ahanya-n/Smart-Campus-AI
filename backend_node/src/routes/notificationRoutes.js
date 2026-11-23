const express = require('express');
const { ObjectId } = require('mongodb');

const DEFAULT_ATTENDANCE_THRESHOLD = 75;
const WEEK_PATTERN = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

function currentWeekId() {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNumber = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function createNotificationRouter({
  authenticate,
  requireRoles,
  getStudentsCollection,
  getAttendanceCollection,
  getNotificationsCollection,
}) {
  const router = express.Router();
  const staffOnly = requireRoles('faculty', 'admin');

  router.get('/', authenticate, async (request, response, next) => {
    try {
      const studentId = request.user.student_id;
      const student = typeof studentId === 'string' && studentId
        ? await (await getStudentsCollection()).findOne(
          { student_id: studentId },
          { projection: { _id: 0 } },
        )
        : null;
      const collection = await getNotificationsCollection();
      const ownerFilters = [];
      if (typeof studentId === 'string' && studentId) ownerFilters.push({ student_id: studentId });
      if (request.user._id) ownerFilters.push({ recipient_user_id: request.user._id });
      const ownershipQuery = ownerFilters.length > 1
        ? { $or: ownerFilters }
        : ownerFilters[0] || { _id: null };
      const notifications = await collection
        .find(ownershipQuery)
        .sort({ created_at: -1 })
        .limit(100)
        .toArray();
      const items = notifications.map((document) => ({
        id: String(document._id),
        student_id: document.student_id,
        subject_code: document.subject_code || '',
        subject_name: document.subject_name || '',
        attendance_percentage: document.attendance_percentage || 0,
        threshold: document.threshold || DEFAULT_ATTENDANCE_THRESHOLD,
        week_id: document.week_id || '',
        warning_type: document.warning_type || 'low_attendance',
        title: document.title || 'Attendance Alert',
        message: document.message || '',
        reporting_date: document.reporting_date || '',
        action_type: document.action_type === 'lost_found_claim' ||
          document.warning_type === 'lost_found_match'
          ? 'lost_found_claim'
          : '',
        claim_id: document.claim_id ? String(document.claim_id) : '',
        match_id: document.match_id ? String(document.match_id) : '',
        lost_report_id: document.lost_report_id ? String(document.lost_report_id) : '',
        found_report_id: document.found_report_id ? String(document.found_report_id) : '',
        created_at: document.created_at instanceof Date
          ? document.created_at.toISOString()
          : null,
        is_read: Boolean(document.is_read),
      }));
      return response.json({
        linked: Boolean(student),
        student_id: student ? studentId : null,
        unread_count: items.filter((item) => !item.is_read).length,
        notifications: items,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/check-weekly', authenticate, staffOnly, async (request, response, next) => {
    const thresholdRaw = request.query.threshold;
    const threshold = thresholdRaw === undefined ? DEFAULT_ATTENDANCE_THRESHOLD : Number(thresholdRaw);
    const weekId = request.query.week_id;
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
      return response.status(422).json({ detail: 'threshold must be between 1 and 100' });
    }
    if (weekId !== undefined && (typeof weekId !== 'string' || !WEEK_PATTERN.test(weekId))) {
      return response.status(422).json({ detail: 'week_id must use YYYY-Www format' });
    }

    try {
      const [attendance, students, notifications] = await Promise.all([
        getAttendanceCollection(),
        getStudentsCollection(),
        getNotificationsCollection(),
      ]);
      const records = await attendance.find({ is_demo: { $ne: true } }).toArray();
      const studentIds = [...new Set(records.map((record) => record.student_id).filter(Boolean))];
      const studentDocuments = studentIds.length
        ? await students.find(
          { student_id: { $in: studentIds } },
          { projection: { student_id: 1, name: 1 } },
        ).toArray()
        : [];
      const studentNames = Object.fromEntries(
        studentDocuments.map((student) => [student.student_id, student.name || student.student_id]),
      );
      const reportingWeek = weekId || currentWeekId();
      const reportingDate = new Date().toISOString().slice(0, 10);
      let scanned = 0;
      let generated = 0;
      let duplicates = 0;
      let healthy = 0;
      let insufficient = 0;

      for (const record of records) {
        const studentId = record.student_id;
        const subjectCode = record.subject_code;
        const subjectName = record.subject_name || subjectCode;
        const total = Number.parseInt(record.total_classes, 10) || 0;
        const present = Number.parseInt(record.present_classes, 10) || 0;
        if (!studentId || !subjectCode) continue;
        scanned += 1;
        if (total <= 0) {
          insufficient += 1;
          continue;
        }
        const percentage = Math.round((present / total) * 10000) / 100;
        if (percentage >= threshold) {
          healthy += 1;
          continue;
        }
        const key = {
          student_id: studentId,
          subject_code: subjectCode,
          week_id: reportingWeek,
        };
        if (await notifications.findOne(key)) {
          duplicates += 1;
          continue;
        }
        const name = studentNames[studentId] || studentId;
        try {
          await notifications.insertOne({
            ...key,
            student_name: name,
            subject_name: subjectName,
            attendance_percentage: percentage,
            threshold,
            total_classes: total,
            present_classes: present,
            warning_type: 'low_attendance',
            title: `Low Attendance Warning: ${subjectCode}`,
            message: `Your attendance in ${subjectName} (${subjectCode}) is ${percentage}%, which is below the college minimum requirement of ${threshold}%.`,
            reporting_date: reportingDate,
            created_at: new Date(),
            is_read: false,
          });
          generated += 1;
        } catch (error) {
          if (error.code !== 11000) throw error;
          duplicates += 1;
        }
      }

      return response.json({
        week_id: reportingWeek,
        scanned_records: scanned,
        generated_warnings: generated,
        duplicates_skipped: duplicates,
        healthy_records: healthy,
        insufficient_data_skipped: insufficient,
        threshold,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:notification_id/read', authenticate, async (request, response, next) => {
    const studentId = request.user.student_id;
    if (!/^[a-f\d]{24}$/i.test(request.params.notification_id)) {
      return response.status(404).json({ detail: 'Notification not found' });
    }
    try {
      const student = typeof studentId === 'string' && studentId
        ? await (await getStudentsCollection()).findOne(
          { student_id: studentId },
          { projection: { _id: 0 } },
        )
        : null;
      const notifications = await getNotificationsCollection();
      const notificationId = new ObjectId(request.params.notification_id);
      if (!student && !await notifications.findOne({
        _id: notificationId,
        recipient_user_id: request.user._id,
      })) {
        return response.status(403).json({ detail: 'Account is not linked to a student record' });
      }
      const ownerFilters = [];
      if (student) ownerFilters.push({ student_id: studentId });
      if (request.user._id) ownerFilters.push({ recipient_user_id: request.user._id });
      const ownershipQuery = ownerFilters.length > 1
        ? { $or: ownerFilters }
        : ownerFilters[0] || { _id: null };
      const result = await notifications.updateOne(
        {
          _id: notificationId,
          ...ownershipQuery,
        },
        { $set: { is_read: true } },
      );
      if (!result.modifiedCount) {
        return response.status(404).json({ detail: 'Notification not found' });
      }
      return response.json({
        message: 'Notification marked as read',
        id: request.params.notification_id,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createNotificationRouter, currentWeekId };
