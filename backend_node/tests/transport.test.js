const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-transport-secret',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function getPath(document, path) {
  return path.split('.').reduce((value, part) => {
    if (Array.isArray(value)) return value.map((item) => item?.[part]);
    return value?.[part];
  }, document);
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((condition) => matches(document, condition));
    const actual = getPath(document, key);
    if (expected instanceof ObjectId) {
      return actual instanceof ObjectId && actual.equals(expected);
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, '$ne')) {
        const values = Array.isArray(actual) ? actual : [actual];
        return !values.some((value) => value === expected.$ne);
      }
      if (Object.hasOwn(expected, '$type')) return typeof actual === 'string';
    }
    if (Array.isArray(expected)) {
      return JSON.stringify(actual) === JSON.stringify(expected);
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

function collection(initial = []) {
  const documents = [...initial];
  return {
    documents,
    async createIndex() {},
    async findOne(query) {
      return documents.find((document) => matches(document, query)) || null;
    },
    find(query = {}) {
      let found = documents.filter((document) => matches(document, query));
      const cursor = {
        sort(order) {
          const [[field, direction]] = Object.entries(order);
          found = found.sort((left, right) =>
            String(left[field] ?? '').localeCompare(String(right[field] ?? '')) * direction);
          return cursor;
        },
        async toArray() { return found; },
      };
      return cursor;
    },
    async insertOne(document) {
      if (documents.some((saved) => saved.route_number === document.route_number)) {
        const duplicate = new Error('duplicate route');
        duplicate.code = 11000;
        throw duplicate;
      }
      const assigned = new Set(
        documents.flatMap((saved) =>
          (saved.assignments || []).map((item) => item.student_id)),
      );
      if ((document.assignments || []).some((item) => assigned.has(item.student_id))) {
        const duplicate = new Error('duplicate assignment');
        duplicate.code = 11000;
        throw duplicate;
      }
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const found = documents.find((document) => matches(document, query));
      if (!found) return { matchedCount: 0 };
      Object.assign(found, update.$set);
      return { matchedCount: 1 };
    },
    async deleteOne(query) {
      const index = documents.findIndex((document) => matches(document, query));
      if (index < 0) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

function user(role, properties = {}) {
  return {
    _id: new ObjectId(),
    name: `Transport ${role}`,
    email: `${role}@transport.test`,
    role,
    ...properties,
  };
}

function setup(users, routes = [], students = []) {
  const usersCollection = collection(users);
  const routesCollection = collection(routes);
  const studentsCollection = collection(students);
  const app = createApp({
    env: ENV,
    getUsersCollection: async () => usersCollection,
    getTransportRoutesCollection: async () => routesCollection,
    getStudentsCollection: async () => studentsCollection,
  });
  return { app, routesCollection, studentsCollection };
}

function asUser(app, account, method, path, body) {
  const token = jwt.sign({}, ENV.JWT_SECRET, {
    algorithm: 'HS256',
    subject: account._id.toHexString(),
    expiresIn: '1h',
  });
  const call = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body === undefined ? call : call.send(body);
}

const routeInput = {
  route_number: 'R-12',
  bus_number: 'BUS-12',
  registration_number: 'TEST-REG-12',
  pickup_points: ['North Gate', 'Library'],
  drop_points: ['Campus'],
  driver: { name: 'Synthetic Driver', phone: '+1 555 123 4567' },
  capacity: 2,
};

test('transport route listing requires authentication and hides private fields', async () => {
  const student = user('student');
  const route = {
    _id: new ObjectId(),
    ...routeInput,
    assignments: [{
      student_id: 'TEST-STUDENT',
      pickup_point: 'Library',
      drop_point: 'Campus',
    }],
  };
  const { app } = setup([student], [route]);
  assert.equal((await request(app).get('/api/transport/routes')).status, 401);
  const response = await asUser(app, student, 'get', '/api/transport/routes');
  assert.equal(response.status, 200);
  assert.equal(response.body[0].available_seats, 1);
  assert.deepEqual(response.body[0].driver, { name: 'Synthetic Driver' });
  assert.equal('assignments' in response.body[0], false);
});

test('only admins may create and update routes; inputs are validated', async () => {
  const admin = user('admin');
  const faculty = user('faculty');
  const { app, routesCollection } = setup([admin, faculty]);
  assert.equal(
    (await asUser(app, faculty, 'post', '/api/transport/routes', routeInput)).status,
    403,
  );
  assert.equal(
    (await asUser(app, admin, 'post', '/api/transport/routes', {
      ...routeInput,
      capacity: 0,
    })).status,
    422,
  );
  const created = await asUser(app, admin, 'post', '/api/transport/routes', routeInput);
  assert.equal(created.status, 201);
  assert.equal(created.body.available_seats, 2);
  assert.equal(created.body.driver.phone, routeInput.driver.phone);
  const routeId = created.body.id;
  assert.equal(routesCollection.documents.length, 1);
  assert.equal(
    (await asUser(app, admin, 'post', '/api/transport/routes', routeInput)).status,
    409,
  );
  const updated = await asUser(app, admin, 'patch', `/api/transport/routes/${routeId}`, {
    ...routeInput,
    bus_number: 'BUS-UPDATED',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.bus_number, 'BUS-UPDATED');
});

test('route updates preserve assignments when stop capitalization changes', async () => {
  const admin = user('admin');
  const route = {
    _id: new ObjectId(),
    ...routeInput,
    assignments: [{
      student_id: 'TEST-STUDENT',
      pickup_point: 'Library',
      drop_point: 'Campus',
    }],
  };
  const { app, routesCollection } = setup([admin], [route]);

  const updated = await asUser(app, admin, 'patch', `/api/transport/routes/${route._id}`, {
    ...routeInput,
    pickup_points: ['NORTH GATE', 'LIBRARY'],
    drop_points: ['CAMPUS'],
  });

  assert.equal(updated.status, 200);
  assert.equal(routesCollection.documents[0].assignments[0].pickup_point, 'LIBRARY');
  assert.equal(routesCollection.documents[0].assignments[0].drop_point, 'CAMPUS');
});

test('admins can assign existing students and capacity and points are enforced', async () => {
  const admin = user('admin');
  const student = user('student', { student_id: 'TEST-STUDENT-1' });
  const route = { _id: new ObjectId(), ...routeInput, assignments: [] };
  const { app, routesCollection, studentsCollection } = setup(
    [admin, student],
    [route],
    [{ student_id: 'TEST-STUDENT-1' }],
  );
  const assignment = {
    student_id: 'TEST-STUDENT-1',
    pickup_point: 'Library',
    drop_point: 'Campus',
  };
  const denied = await asUser(
    app,
    student,
    'post',
    `/api/transport/routes/${route._id}/assignments`,
    assignment,
  );
  assert.equal(denied.status, 403);
  const assigned = await asUser(
    app,
    admin,
    'post',
    `/api/transport/routes/${route._id}/assignments`,
    assignment,
  );
  assert.equal(assigned.status, 201);
  assert.equal(studentsCollection.documents.length, 1);
  assert.equal(routesCollection.documents[0].assignments.length, 1);

  const studentTransport = await asUser(app, student, 'get', '/api/transport/me');
  assert.equal(studentTransport.status, 200);
  assert.equal(studentTransport.body.assigned, true);
  assert.equal(studentTransport.body.assignment.pickup_point, 'Library');
  assert.equal('phone' in studentTransport.body.route.driver, false);

  assert.equal(
    (await asUser(
      app,
      admin,
      'post',
      `/api/transport/routes/${route._id}/assignments`,
      assignment,
    )).status,
    409,
  );
  assert.equal(
    (await asUser(
      app,
      admin,
      'patch',
      `/api/transport/routes/${route._id}`,
      { ...routeInput, capacity: 1, pickup_points: ['North Gate'] },
    )).status,
    409,
  );
  const adminRoutes = await asUser(app, admin, 'get', '/api/transport/routes');
  assert.equal(adminRoutes.body[0].assignments[0].student_id, 'TEST-STUDENT-1');
});

test('unknown students, invalid stops, and deleting assigned routes are rejected', async () => {
  const admin = user('admin');
  const route = { _id: new ObjectId(), ...routeInput, assignments: [] };
  const { app } = setup([admin], [route]);
  const unknown = await asUser(
    app,
    admin,
    'post',
    `/api/transport/routes/${route._id}/assignments`,
    {
      student_id: 'MISSING',
      pickup_point: 'Library',
      drop_point: 'Campus',
    },
  );
  assert.equal(unknown.status, 404);
  const invalid = await asUser(
    app,
    admin,
    'post',
    `/api/transport/routes/${route._id}/assignments`,
    {
      student_id: 'MISSING',
      pickup_point: 'Not a stop',
      drop_point: 'Campus',
    },
  );
  assert.equal(invalid.status, 404);
  assert.equal((await asUser(app, admin, 'delete', `/api/transport/routes/${route._id}`)).status, 204);
});
