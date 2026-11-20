const express = require('express');
const { ObjectId } = require('mongodb');

const CATEGORIES = Object.freeze([
  'academic',
  'facilities',
  'transport',
  'library',
  'safety',
  'other',
]);
const STATUSES = Object.freeze(['pending', 'in_progress', 'resolved', 'rejected']);
const ID_PATTERN = /^[a-f\d]{24}$/i;

function cleanText(value, field, min, max) {
  if (typeof value !== 'string') {
    return { error: `${field} must be text` };
  }
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) {
    return { error: `${field} must be between ${min} and ${max} characters` };
  }
  return { value: cleaned };
}

function validateCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  if (!CATEGORIES.includes(body.category)) {
    return { error: 'category is invalid' };
  }
  const title = cleanText(body.title, 'title', 3, 120);
  if (title.error) return title;
  const description = cleanText(body.description, 'description', 10, 5000);
  if (description.error) return description;
  return {
    value: {
      category: body.category,
      title: title.value,
      description: description.value,
    },
  };
}

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function responseOutput(item) {
  return {
    id: String(item._id || ''),
    author_name: item.author_name || '',
    author_role: item.author_role || '',
    message: item.message || '',
    resolution_notes: item.resolution_notes ?? null,
    created_at: iso(item.created_at),
  };
}

function complaintOutput(item) {
  return {
    id: String(item._id),
    user_id: String(item.user_id),
    student_id: item.student_id ?? null,
    student_name: item.student_name || '',
    student_email: item.student_email || '',
    category: item.category,
    title: item.title,
    description: item.description,
    status: item.status,
    assigned_to: item.assigned_to ? String(item.assigned_to) : null,
    assigned_staff_name: item.assigned_staff_name ?? null,
    resolution_notes: item.resolution_notes ?? null,
    responses: (item.responses || []).map(responseOutput),
    created_at: iso(item.created_at),
    updated_at: iso(item.updated_at),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createComplaintRouter({
  authenticate,
  requireRoles,
  getComplaintsCollection,
  getUsersCollection,
}) {
  const router = express.Router();
  const adminOnly = requireRoles('admin');
  const studentOnly = requireRoles('student');
  let indexesReady;

  async function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = (async () => {
        const complaints = await getComplaintsCollection();
        await Promise.all([
          complaints.createIndex({ user_id: 1 }, { name: 'complaint_user' }),
          complaints.createIndex({ status: 1 }, { name: 'complaint_status' }),
        ]);
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    await indexesReady;
  }

  async function findComplaint(rawId) {
    if (!ID_PATTERN.test(rawId)) return null;
    return (await getComplaintsCollection()).findOne({ _id: new ObjectId(rawId) });
  }

  router.get('/stats', authenticate, adminOnly, async (_request, response, next) => {
    try {
      await ensureIndexes();
      const complaints = await getComplaintsCollection();
      const [total, pending, inProgress, resolved, rejected] = await Promise.all([
        complaints.countDocuments({}),
        complaints.countDocuments({ status: 'pending' }),
        complaints.countDocuments({ status: 'in_progress' }),
        complaints.countDocuments({ status: 'resolved' }),
        complaints.countDocuments({ status: 'rejected' }),
      ]);
      return response.json({
        total,
        pending,
        in_progress: inProgress,
        resolved,
        rejected,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', authenticate, async (request, response, next) => {
    const role = request.user.role;
    if (role !== 'student' && role !== 'admin') {
      return response.status(403).json({ detail: 'Students and admins can view complaints.' });
    }
    const { status, category } = request.query;
    if (status !== undefined && !STATUSES.includes(status)) {
      return response.status(422).json({ detail: 'status is invalid' });
    }
    if (category !== undefined && !CATEGORIES.includes(category)) {
      return response.status(422).json({ detail: 'category is invalid' });
    }
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
    if (search.length > 100) {
      return response.status(422).json({ detail: 'search cannot exceed 100 characters' });
    }
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      return response.status(422).json({ detail: 'limit or offset is invalid' });
    }

    const query = {};
    if (role === 'student') query.user_id = request.user._id;
    if (status) query.status = status;
    if (category) query.category = category;
    if (search) {
      const expression = escapeRegex(search);
      const fields = ['title', 'description'];
      if (role === 'admin') {
        fields.push('student_name', 'student_email', 'assigned_staff_name');
      }
      query.$or = fields.map((field) => ({
        [field]: { $regex: expression, $options: 'i' },
      }));
    }
    try {
      await ensureIndexes();
      const complaints = await getComplaintsCollection();
      const items = await complaints.find(query)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      const total = await complaints.countDocuments(query);
      return response.json({
        items: items.map(complaintOutput),
        total,
        limit,
        offset,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/', authenticate, studentOnly, async (request, response, next) => {
    const validated = validateCreate(request.body);
    if (validated.error) return response.status(422).json({ detail: validated.error });
    try {
      await ensureIndexes();
      const now = new Date();
      const document = {
        user_id: request.user._id,
        student_id: request.user.student_id || null,
        student_name: request.user.name || '',
        student_email: request.user.email || '',
        ...validated.value,
        status: 'pending',
        assigned_to: null,
        assigned_staff_name: null,
        resolution_notes: null,
        responses: [],
        created_at: now,
        updated_at: now,
      };
      const result = await (await getComplaintsCollection()).insertOne(document);
      return response.status(201).json(
        complaintOutput({ ...document, _id: result.insertedId }),
      );
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:complaint_id', authenticate, async (request, response, next) => {
    try {
      const complaint = await findComplaint(request.params.complaint_id);
      if (!complaint) return response.status(404).json({ detail: 'Complaint not found' });
      if (
        request.user.role !== 'admin' &&
        !complaint.user_id.equals(request.user._id)
      ) {
        return response.status(404).json({ detail: 'Complaint not found' });
      }
      return response.json(complaintOutput(complaint));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:complaint_id', authenticate, adminOnly, async (request, response, next) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response.status(422).json({ detail: 'Request body must be a JSON object' });
    }
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) =>
      !['status', 'assigned_to', 'resolution_notes'].includes(key))) {
      return response.status(422).json({ detail: 'At least one valid complaint field is required' });
    }
    const changes = {};
    if (Object.hasOwn(body, 'status')) {
      if (!STATUSES.includes(body.status)) {
        return response.status(422).json({ detail: 'status is invalid' });
      }
      changes.status = body.status;
    }
    if (Object.hasOwn(body, 'resolution_notes')) {
      const notes = body.resolution_notes;
      if (notes !== null && (typeof notes !== 'string' || !notes.trim() || notes.trim().length > 3000)) {
        return response.status(422).json({ detail: 'resolution_notes must be 1-3000 characters' });
      }
      changes.resolution_notes = notes === null ? null : notes.trim();
    }
    try {
      const complaint = await findComplaint(request.params.complaint_id);
      if (!complaint) return response.status(404).json({ detail: 'Complaint not found' });
      if (Object.hasOwn(body, 'assigned_to')) {
        if (body.assigned_to === null) {
          changes.assigned_to = null;
          changes.assigned_staff_name = null;
        } else {
          if (typeof body.assigned_to !== 'string' || !ID_PATTERN.test(body.assigned_to)) {
            return response.status(422).json({ detail: 'assigned_to must be a valid user ID or null' });
          }
          const staff = await (await getUsersCollection()).findOne(
            { _id: new ObjectId(body.assigned_to), role: { $in: ['faculty', 'admin'] } },
            { projection: { name: 1 } },
          );
          if (!staff) {
            return response.status(422).json({ detail: 'Assignee must be a faculty or admin account' });
          }
          changes.assigned_to = staff._id;
          changes.assigned_staff_name = staff.name || '';
        }
      }
      const updatedAt = new Date();
      changes.updated_at = updatedAt;
      const result = await (await getComplaintsCollection()).updateOne(
        { _id: complaint._id, updated_at: complaint.updated_at },
        { $set: changes },
      );
      if (result.matchedCount !== 1) {
        return response.status(409).json({ detail: 'Complaint changed during update. Please retry.' });
      }
      return response.json(complaintOutput({ ...complaint, ...changes }));
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/:complaint_id/responses',
    authenticate,
    adminOnly,
    async (request, response, next) => {
      const body = request.body || {};
      const validatedMessage = cleanText(body.message, 'message', 1, 3000);
      if (validatedMessage.error) {
        return response.status(422).json({ detail: validatedMessage.error });
      }
      const message = validatedMessage.value;
      let notes = null;
      if (body.resolution_notes !== undefined && body.resolution_notes !== null) {
        notes = cleanText(body.resolution_notes, 'resolution_notes', 1, 3000);
        if (notes.error) {
          return response.status(422).json({ detail: notes.error });
        }
        notes = notes.value;
      }
      try {
        const complaint = await findComplaint(request.params.complaint_id);
        if (!complaint) return response.status(404).json({ detail: 'Complaint not found' });
        const now = new Date();
        const responseDocument = {
          _id: new ObjectId(),
          author_id: request.user._id,
          author_name: request.user.name || '',
          author_role: 'admin',
          message,
          resolution_notes: notes,
          created_at: now,
        };
        const changes = { updated_at: now };
        if (notes !== null) changes.resolution_notes = notes;
        const result = await (await getComplaintsCollection()).updateOne(
          { _id: complaint._id, updated_at: complaint.updated_at },
          { $push: { responses: responseDocument }, $set: changes },
        );
        if (result.matchedCount !== 1) {
          return response.status(409).json({ detail: 'Complaint changed during update. Please retry.' });
        }
        return response.status(201).json(responseOutput(responseDocument));
      } catch (error) {
        return next(error);
      }
    },
  );

  return router;
}

module.exports = { createComplaintRouter };
