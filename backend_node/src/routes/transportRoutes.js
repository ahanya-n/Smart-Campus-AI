const express = require('express');
const { ObjectId } = require('mongodb');

const ROUTE_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,20}$/;
const ID_PATTERN = /^[a-f\d]{24}$/i;
const PHONE_PATTERN = /^[+0-9() -]{7,24}$/;

function routeOutput(route, admin = false) {
  const assignments = route.assignments || [];
  const result = {
    id: String(route._id),
    route_number: route.route_number,
    bus_number: route.bus_number,
    registration_number: route.registration_number,
    pickup_points: [...route.pickup_points],
    drop_points: [...route.drop_points],
    driver: { name: route.driver.name },
    capacity: route.capacity,
    assigned_seats: assignments.length,
    available_seats: Math.max(0, route.capacity - assignments.length),
    created_at: route.created_at,
    updated_at: route.updated_at,
  };
  if (admin) {
    result.driver = { ...route.driver };
    result.assignments = assignments.map((assignment) => ({
      student_id: assignment.student_id,
      pickup_point: assignment.pickup_point,
      drop_point: assignment.drop_point,
      assigned_at: assignment.assigned_at,
    }));
  }
  return result;
}

function cleanPointList(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    return `${field} must contain between 1 and 30 points`;
  }
  const cleaned = value.map((point) => typeof point === 'string' ? point.trim() : '');
  if (cleaned.some((point) => !point || point.length > 100)) {
    return `${field} points must be non-empty and no more than 100 characters`;
  }
  if (new Set(cleaned.map((point) => point.toLowerCase())).size !== cleaned.length) {
    return `${field} must not contain duplicate points`;
  }
  return cleaned;
}

function validateRoute(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const routeNumber = typeof body.route_number === 'string' ? body.route_number.trim().toUpperCase() : '';
  if (!ROUTE_NUMBER_PATTERN.test(routeNumber)) {
    return { error: 'route_number may contain 1-20 letters, digits, and hyphens' };
  }
  const busNumber = typeof body.bus_number === 'string' ? body.bus_number.trim() : '';
  const registrationNumber = typeof body.registration_number === 'string'
    ? body.registration_number.trim()
    : '';
  if (!busNumber || busNumber.length > 20) {
    return { error: 'bus_number is required and must be no more than 20 characters' };
  }
  if (!registrationNumber || registrationNumber.length > 20) {
    return { error: 'registration_number is required and must be no more than 20 characters' };
  }
  const pickupPoints = cleanPointList(body.pickup_points, 'pickup_points');
  if (typeof pickupPoints === 'string') return { error: pickupPoints };
  const dropPoints = cleanPointList(body.drop_points, 'drop_points');
  if (typeof dropPoints === 'string') return { error: dropPoints };
  if (!body.driver || typeof body.driver !== 'object' || Array.isArray(body.driver)) {
    return { error: 'driver must include a name and phone' };
  }
  const driverName = typeof body.driver.name === 'string' ? body.driver.name.trim() : '';
  const driverPhone = typeof body.driver.phone === 'string' ? body.driver.phone.trim() : '';
  const phoneDigits = (driverPhone.match(/\d/g) || []).length;
  if (!driverName || driverName.length > 100) {
    return { error: 'driver.name is required and must be no more than 100 characters' };
  }
  if (!PHONE_PATTERN.test(driverPhone) || phoneDigits < 7 || phoneDigits > 15) {
    return { error: 'driver.phone must contain 7-15 digits and valid phone characters' };
  }
  if (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 100) {
    return { error: 'capacity must be an integer between 1 and 100' };
  }
  return {
    value: {
      route_number: routeNumber,
      bus_number: busNumber,
      registration_number: registrationNumber,
      pickup_points: pickupPoints,
      drop_points: dropPoints,
      driver: { name: driverName, phone: driverPhone },
      capacity: body.capacity,
    },
  };
}

function createTransportRouter({
  authenticate,
  requireRoles,
  getTransportRoutesCollection,
  getStudentsCollection,
}) {
  const router = express.Router();
  const adminOnly = requireRoles('admin');
  let indexesReady;

  async function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = (async () => {
        const routes = await getTransportRoutesCollection();
        await Promise.all([
          routes.createIndex(
            { route_number: 1 },
            { name: 'route_number_unique', unique: true },
          ),
          routes.createIndex(
            { 'assignments.student_id': 1 },
            {
              name: 'transport_student_assignment_unique',
              unique: true,
              partialFilterExpression: { 'assignments.student_id': { $type: 'string' } },
            },
          ),
        ]);
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    await indexesReady;
  }

  async function findRoute(rawId) {
    if (!ID_PATTERN.test(rawId)) return null;
    return (await getTransportRoutesCollection()).findOne({ _id: new ObjectId(rawId) });
  }

  async function replaceAssignments(route, assignments) {
    return (await getTransportRoutesCollection()).updateOne(
      { _id: route._id, assignments: route.assignments || [] },
      { $set: { assignments, updated_at: new Date() } },
    );
  }

  router.get('/routes', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const routes = await (await getTransportRoutesCollection())
        .find({})
        .sort({ route_number: 1 })
        .toArray();
      return response.json(routes.map((route) => routeOutput(route, request.user.role === 'admin')));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', authenticate, requireRoles('student'), async (request, response, next) => {
    const studentId = request.user.student_id;
    if (typeof studentId !== 'string' || !studentId.trim()) {
      return response.json({ assigned: false, route: null, assignment: null });
    }
    try {
      await ensureIndexes();
      const routes = await (await getTransportRoutesCollection())
        .find({ 'assignments.student_id': studentId })
        .toArray();
      for (const route of routes) {
        const assignment = (route.assignments || [])
          .find((item) => item.student_id === studentId);
        if (assignment) {
          return response.json({
            assigned: true,
            route: routeOutput(route),
            assignment: {
              student_id: studentId,
              pickup_point: assignment.pickup_point,
              drop_point: assignment.drop_point,
              assigned_at: assignment.assigned_at,
            },
          });
        }
      }
      return response.json({ assigned: false, route: null, assignment: null });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/routes', authenticate, adminOnly, async (request, response, next) => {
    const validated = validateRoute(request.body);
    if (validated.error) return response.status(422).json({ detail: validated.error });
    try {
      await ensureIndexes();
      const now = new Date();
      const document = {
        ...validated.value,
        assignments: [],
        created_at: now,
        updated_at: now,
      };
      const result = await (await getTransportRoutesCollection()).insertOne(document);
      return response.status(201).json(routeOutput({ ...document, _id: result.insertedId }, true));
    } catch (error) {
      if (error.code === 11000) {
        return response.status(409).json({ detail: 'Route number already exists' });
      }
      return next(error);
    }
  });

  router.get('/routes/:route_id', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const route = await findRoute(request.params.route_id);
      if (!route) return response.status(404).json({ detail: 'Transport route not found' });
      return response.json(routeOutput(route, request.user.role === 'admin'));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/routes/:route_id', authenticate, adminOnly, async (request, response, next) => {
    const validated = validateRoute(request.body);
    if (validated.error) return response.status(422).json({ detail: validated.error });
    try {
      await ensureIndexes();
      const route = await findRoute(request.params.route_id);
      if (!route) return response.status(404).json({ detail: 'Transport route not found' });
      const assignments = route.assignments || [];
      if (validated.value.capacity < assignments.length) {
        return response.status(409).json({
          detail: 'Capacity cannot be lower than the number of assigned students',
        });
      }
      if (assignments.some((item) =>
        !validated.value.pickup_points.some((point) =>
          point.toLowerCase() === item.pickup_point.toLowerCase()) ||
        !validated.value.drop_points.some((point) =>
          point.toLowerCase() === item.drop_point.toLowerCase()))) {
        return response.status(409).json({
          detail: 'Existing student pickup and drop points must be retained',
        });
      }
      const pickupPoints = new Map(
        validated.value.pickup_points.map((point) => [point.toLowerCase(), point]),
      );
      const dropPoints = new Map(
        validated.value.drop_points.map((point) => [point.toLowerCase(), point]),
      );
      const updatedAssignments = assignments.map((item) => ({
        ...item,
        pickup_point: pickupPoints.get(item.pickup_point.toLowerCase()),
        drop_point: dropPoints.get(item.drop_point.toLowerCase()),
      }));
      const updatedAt = new Date();
      const result = await (await getTransportRoutesCollection()).updateOne(
        { _id: route._id, updated_at: route.updated_at },
        { $set: { ...validated.value, assignments: updatedAssignments, updated_at: updatedAt } },
      );
      if (result.matchedCount !== 1) {
        return response.status(409).json({ detail: 'Route changed during the update. Please retry.' });
      }
      return response.json(routeOutput({ ...route, ...validated.value, updated_at: updatedAt }, true));
    } catch (error) {
      if (error.code === 11000) {
        return response.status(409).json({ detail: 'Route number already exists' });
      }
      return next(error);
    }
  });

  router.delete('/routes/:route_id', authenticate, adminOnly, async (request, response, next) => {
    try {
      await ensureIndexes();
      const route = await findRoute(request.params.route_id);
      if (!route) return response.status(404).json({ detail: 'Transport route not found' });
      if ((route.assignments || []).length > 0) {
        return response.status(409).json({
          detail: 'Remove assigned students before deleting this route',
        });
      }
      const deleted = await (await getTransportRoutesCollection()).deleteOne({
        _id: route._id,
        assignments: route.assignments || [],
        updated_at: route.updated_at,
      });
      if (deleted.deletedCount !== 1) {
        return response.status(409).json({
          detail: 'Route changed during deletion. Please retry.',
        });
      }
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/routes/:route_id/assignments',
    authenticate,
    adminOnly,
    async (request, response, next) => {
      const { student_id: studentId, pickup_point: pickupPoint, drop_point: dropPoint } =
        request.body || {};
      if (
        typeof studentId !== 'string' ||
        !/^[A-Za-z0-9-]{1,50}$/.test(studentId.trim()) ||
        typeof pickupPoint !== 'string' ||
        !pickupPoint.trim() ||
        pickupPoint.trim().length > 100 ||
        typeof dropPoint !== 'string' ||
        !dropPoint.trim() ||
        dropPoint.trim().length > 100
      ) {
        return response.status(422).json({
          detail: 'student_id, pickup_point and drop_point are required and must be valid',
        });
      }
      const normalizedStudentId = studentId.trim();
      try {
        await ensureIndexes();
        const student = await (await getStudentsCollection()).findOne(
          { student_id: normalizedStudentId },
          { projection: { _id: 1 } },
        );
        if (!student) return response.status(404).json({ detail: 'Student record not found' });
        if (!ID_PATTERN.test(request.params.route_id)) {
          return response.status(404).json({ detail: 'Transport route not found' });
        }
        const routeId = new ObjectId(request.params.route_id);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const route = await (await getTransportRoutesCollection()).findOne({ _id: routeId });
          if (!route) return response.status(404).json({ detail: 'Transport route not found' });
          const assignments = route.assignments || [];
          if (assignments.some((item) => item.student_id === normalizedStudentId)) {
            return response.status(409).json({ detail: 'Student is already assigned to this route' });
          }
          const pickup = route.pickup_points.find(
            (point) => point.toLowerCase() === pickupPoint.trim().toLowerCase(),
          );
          if (!pickup) return response.status(422).json({ detail: 'Pickup point is not on this route' });
          const drop = route.drop_points.find(
            (point) => point.toLowerCase() === dropPoint.trim().toLowerCase(),
          );
          if (!drop) return response.status(422).json({ detail: 'Drop point is not on this route' });
          if (assignments.length >= route.capacity) {
            return response.status(409).json({ detail: 'This route is at capacity' });
          }
          if (await (await getTransportRoutesCollection()).findOne({
            'assignments.student_id': normalizedStudentId,
          })) {
            return response.status(409).json({ detail: 'Student is already assigned to another route' });
          }
          const assignment = {
            student_id: normalizedStudentId,
            pickup_point: pickup,
            drop_point: drop,
            assigned_at: new Date(),
          };
          try {
            const result = await replaceAssignments(route, [...assignments, assignment]);
            if (result.matchedCount === 1) {
              return response.status(201).json({
                route_id: String(routeId),
                ...assignment,
              });
            }
          } catch (error) {
            if (error.code === 11000) {
              return response.status(409).json({
                detail: 'Student is already assigned to another route',
              });
            }
            throw error;
          }
        }
        return response.status(409).json({
          detail: 'Route changed during assignment. Please retry.',
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.delete(
    '/routes/:route_id/assignments/:student_id',
    authenticate,
    adminOnly,
    async (request, response, next) => {
      if (!/^[A-Za-z0-9-]{1,50}$/.test(request.params.student_id)) {
        return response.status(404).json({ detail: 'Student assignment not found' });
      }
      try {
        await ensureIndexes();
        const route = await findRoute(request.params.route_id);
        if (!route) return response.status(404).json({ detail: 'Transport route not found' });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const assignments = route.assignments || [];
          const remaining = assignments.filter(
            (item) => item.student_id !== request.params.student_id,
          );
          if (remaining.length === assignments.length) {
            return response.status(404).json({ detail: 'Student assignment not found' });
          }
          const result = await replaceAssignments(route, remaining);
          if (result.matchedCount === 1) return response.status(204).end();
          const latest = await findRoute(request.params.route_id);
          if (!latest) return response.status(404).json({ detail: 'Transport route not found' });
          route.assignments = latest.assignments;
          route.updated_at = latest.updated_at;
        }
        return response.status(409).json({ detail: 'Route changed during removal. Please retry.' });
      } catch (error) {
        return next(error);
      }
    },
  );

  return router;
}

module.exports = { createTransportRouter, routeOutput, validateRoute };
