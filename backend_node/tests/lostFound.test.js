const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { ObjectId } = require('mongodb');

const { createApp } = require('../src/app');
const {
  calculateMatchScore,
  passesMatchingFilters,
  cosineSimilarity,
} = require('../src/routes/lostFoundRoutes');

const ENV = {
  JWT_SECRET: 'test-only-smart-campus-lost-found-secret',
  JWT_ALGORITHM: 'HS256',
  TOKEN_EXPIRE_MINUTES: '60',
};

function getPath(document, path) {
  return path.split('.').reduce((value, part) => value?.[part], document);
}

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((condition) => matches(document, condition));
    const actual = getPath(document, key);
    if (expected instanceof ObjectId) {
      return actual instanceof ObjectId && actual.equals(expected);
    }
    if (expected && typeof expected === 'object') {
      if (Object.hasOwn(expected, '$in')) return expected.$in.includes(actual);
      if (Object.hasOwn(expected, '$ne')) return actual !== expected.$ne;
      if (Object.hasOwn(expected, '$regex')) {
        return new RegExp(expected.$regex, expected.$options).test(String(actual || ''));
      }
      return true;
    }
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
        sort() { return cursor; },
        async toArray() { return found; },
      };
      return cursor;
    },
    async countDocuments(query) {
      return documents.filter((document) => matches(document, query)).length;
    },
    async insertOne(document) {
      const saved = { ...document, _id: new ObjectId() };
      documents.push(saved);
      return { insertedId: saved._id };
    },
    async updateOne(query, update) {
      const saved = documents.find((document) => matches(document, query));
      if (!saved) return { matchedCount: 0 };
      Object.assign(saved, update.$set || {});
      return { matchedCount: 1 };
    },
  };
}

function user(role, values = {}) {
  return {
    _id: new ObjectId(),
    name: `Synthetic ${role}`,
    email: `${role}@lost-found.test`,
    role,
    ...values,
  };
}

function setup(users, reports = [], uploadDir, env = ENV) {
  const userCollection = collection(users);
  const reportCollection = collection(reports);
  const matchCollection = collection();
  const claimCollection = collection();
  const notificationCollection = collection();
  const app = createApp({
    env,
    getUsersCollection: async () => userCollection,
    getLostFoundItemsCollection: async () => reportCollection,
    getLostFoundMatchesCollection: async () => matchCollection,
    getLostFoundClaimsCollection: async () => claimCollection,
    getNotificationsCollection: async () => notificationCollection,
    lostFoundUploadDir: uploadDir,
  });
  return {
    app,
    userCollection,
    reportCollection,
    matchCollection,
    claimCollection,
    notificationCollection,
  };
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

const lostInput = {
  report_type: 'lost',
  item_name: 'Black backpack',
  brand: 'North Face',
  description: 'A black laptop backpack with a blue zip pouch.',
  category: 'Bag',
  colour: 'Black',
  event_date: '2026-11-21',
  event_time: '10:00',
  location: 'Central Library',
  additional_details: 'Red pen in the front pocket.',
};

const foundInput = {
  ...lostInput,
  report_type: 'found',
  item_name: 'Found backpack',
  location: 'Near the library entrance',
};

test('authenticated student can create lost and found reports', async () => {
  const student = user('student');
  const { app, reportCollection } = setup([student]);

  const lost = await asUser(app, student, 'post', '/api/lost-found', lostInput);
  assert.equal(lost.status, 201);
  assert.equal(lost.body.report_type, 'lost');
  assert.equal(lost.body.brand, 'North Face');
  assert.equal(lost.body.status, 'active');
  assert.equal(reportCollection.documents[0].event_timestamp.toISOString(), '2026-11-21T10:00:00.000Z');

  const found = await asUser(app, student, 'post', '/api/lost-found', foundInput);
  assert.equal(found.status, 201);
  assert.equal(found.body.report_type, 'found');
  assert.equal(reportCollection.documents.length, 2);
  assert.ok(reportCollection.documents.every((report) => report.user_id.equals(student._id)));
});

test('lost and found creation validates authentication and required fields', async () => {
  const student = user('student');
  const { app } = setup([student]);

  const unauthenticated = await request(app).post('/api/lost-found').send(lostInput);
  assert.equal(unauthenticated.status, 401);

  assert.equal((await asUser(app, student, 'post', '/api/lost-found', {
    ...lostInput,
    item_name: '',
  })).status, 422);
  assert.equal((await asUser(app, student, 'post', '/api/lost-found', {
    ...lostInput,
    report_type: 'missing',
  })).status, 422);
  assert.equal((await asUser(app, student, 'post', '/api/lost-found', {
    ...lostInput,
    event_time: '25:00',
  })).status, 422);
  assert.equal((await asUser(app, student, 'post', '/api/lost-found', {
    ...lostInput,
    brand: 'x'.repeat(81),
  })).status, 422);
  assert.equal((await asUser(app, student, 'post', '/api/lost-found', {
    ...lostInput,
    image: { type: 'application/pdf', data: 'JVBERi0=' },
  })).status, 422);
});

test('students retrieve only their own reports and cannot access another report', async () => {
  const student = user('student');
  const other = user('student');
  const now = new Date();
  const own = {
    _id: new ObjectId(),
    user_id: student._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const privateReport = {
    _id: new ObjectId(),
    user_id: other._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T17:30:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const { app } = setup([student, other], [own, privateReport]);

  const ownList = await asUser(app, student, 'get', '/api/lost-found/my-reports');
  assert.equal(ownList.status, 200);
  assert.equal(ownList.body.total, 1);
  assert.equal(ownList.body.items[0].id, own._id.toHexString());

  const privateDetail = await asUser(
    app, student, 'get', `/api/lost-found/${privateReport._id.toHexString()}`,
  );
  assert.equal(privateDetail.status, 404);

  const invalidDetail = await asUser(app, student, 'get', '/api/lost-found/not-an-id');
  assert.equal(invalidDetail.status, 404);
});

test('owner can close a report, but cannot close another report or resolved report', async () => {
  const student = user('student');
  const other = user('student');
  const now = new Date();
  const own = {
    _id: new ObjectId(),
    user_id: student._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const otherReport = {
    ...own,
    _id: new ObjectId(),
    user_id: other._id,
  };
  const resolved = {
    ...own,
    _id: new ObjectId(),
    status: 'resolved',
  };
  const { app, reportCollection } = setup([student, other], [own, otherReport, resolved]);

  const closed = await asUser(
    app, student, 'patch', `/api/lost-found/${own._id.toHexString()}/close`,
  );
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.ok(closed.body.closed_at);

  const otherClose = await asUser(
    app, student, 'patch', `/api/lost-found/${otherReport._id.toHexString()}/close`,
  );
  assert.equal(otherClose.status, 404);

  const resolvedClose = await asUser(
    app, student, 'patch', `/api/lost-found/${resolved._id.toHexString()}/close`,
  );
  assert.equal(resolvedClose.status, 409);
  assert.equal(reportCollection.documents.length, 3);
});

test('closing invalidates pending matches and claims but preserves records', async () => {
  const owner = user('student');
  const claimant = user('student');
  const now = new Date();
  const queried = {
    _id: new ObjectId(),
    user_id: claimant._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const candidate = {
    _id: new ObjectId(),
    user_id: owner._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const match = {
    _id: new ObjectId(),
    queried_report_id: queried._id,
    candidate_report_id: candidate._id,
    claimant_id: claimant._id,
    report_owner_id: owner._id,
    similarity_score: 80,
    match_status: 'verification_pending',
  };
  const claim = {
    _id: new ObjectId(),
    match_id: match._id,
    claimant_id: claimant._id,
    report_owner_id: owner._id,
    verification_status: 'pending',
  };
  const { app, matchCollection, claimCollection } = setup(
    [owner, claimant],
    [queried, candidate],
  );
  matchCollection.documents.push(match);
  claimCollection.documents.push(claim);

  const closed = await asUser(
    app,
    owner,
    'patch',
    `/api/lost-found/${candidate._id.toHexString()}/close`,
  );
  assert.equal(closed.status, 200);
  assert.equal(match.match_status, 'invalidated');
  assert.equal(claim.verification_status, 'invalidated');
  assert.equal(typeof match.invalidated_at, 'object');
  assert.equal(typeof claim.invalidated_at, 'object');

  const staleImage = await asUser(
    app,
    owner,
    'get',
    `/api/lost-found/matches/${match._id.toHexString()}/image`,
  );
  assert.equal(staleImage.status, 404);
});

test('owner or admin can resolve reports and resolved reports cannot be reopened', async () => {
  const student = user('student');
  const admin = user('admin');
  const now = new Date();
  const report = {
    _id: new ObjectId(),
    user_id: student._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const match = {
    _id: new ObjectId(),
    queried_report_id: new ObjectId(),
    candidate_report_id: report._id,
    similarity_score: 80,
    match_status: 'verification_pending',
  };
  const claim = {
    _id: new ObjectId(),
    match_id: match._id,
    verification_status: 'pending',
  };
  const { app, matchCollection, claimCollection } = setup([student, admin], [report]);
  matchCollection.documents.push(match);
  claimCollection.documents.push(claim);

  const studentResolve = await asUser(
    app, student, 'patch', `/api/lost-found/${report._id.toHexString()}/resolve`,
  );
  assert.equal(studentResolve.status, 200);
  assert.equal(match.match_status, 'invalidated');
  assert.equal(claim.verification_status, 'invalidated');

  const secondResolve = await asUser(
    app, admin, 'patch', `/api/lost-found/${report._id.toHexString()}/resolve`,
  );
  assert.equal(secondResolve.status, 409);

  const reopen = await asUser(
    app, admin, 'patch', `/api/lost-found/${report._id.toHexString()}/close`,
  );
  assert.equal(reopen.status, 409);
});

test('reports older than 24 hours remain active and are not deleted', async () => {
  const student = user('student');
  const now = new Date();
  const oldReport = {
    _id: new ObjectId(),
    user_id: student._id,
    ...lostInput,
    event_timestamp: new Date('2020-01-01T10:00:00Z'),
    status: 'active',
    created_at: new Date('2020-01-01T10:00:00Z'),
    updated_at: now,
  };
  const { app, reportCollection } = setup([student], [oldReport]);

  const result = await asUser(app, student, 'get', '/api/lost-found/my-reports');
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 1);
  assert.equal(result.body.items[0].status, 'active');
  assert.equal(reportCollection.documents.length, 1);
});

test('matching hard filters accept only opposite active reports within exactly 24 hours', () => {
  const lost = {
    _id: new ObjectId(),
    report_type: 'lost',
    status: 'active',
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
  };
  const foundInside = {
    _id: new ObjectId(),
    report_type: 'found',
    status: 'active',
    event_timestamp: new Date('2026-11-22T10:00:00Z'),
  };
  const foundOutside = {
    _id: new ObjectId(),
    report_type: 'found',
    status: 'active',
    event_timestamp: new Date('2026-11-22T10:00:01Z'),
  };
  const lostOther = { ...lost, _id: new ObjectId() };
  const closed = { ...foundInside, _id: new ObjectId(), status: 'closed', closed_at: new Date() };
  const resolved = { ...foundInside, _id: new ObjectId(), status: 'resolved', resolved_at: new Date() };

  assert.equal(passesMatchingFilters(lost, foundInside), true);
  assert.equal(passesMatchingFilters(foundInside, lost), true);
  assert.equal(passesMatchingFilters(lost, foundOutside), false);
  assert.equal(passesMatchingFilters(lost, lostOther), false);
  assert.equal(passesMatchingFilters(lost, closed), false);
  assert.equal(passesMatchingFilters(lost, resolved), false);
});

test('cosine and multi-factor matching scores normalize and handle missing data', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], null), null);

  const left = {
    item_name: 'Smartphone',
    brand: 'Samsung',
    description: 'black laptop backpack',
    additional_details: 'blue zip pouch',
    category: 'Bag',
    colour: 'Black',
    location: 'Central Library',
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
  };
  const right = {
    item_name: 'Mobile phone',
    brand: 'Samsung',
    description: 'black laptop backpack',
    additional_details: 'blue zip pouch',
    category: 'Bag',
    colour: 'Black',
    location: 'Central Library',
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
  };
  const perfectButMissingImage = calculateMatchScore(left, right, null, null);
  assert.equal(perfectButMissingImage.score, 100);
  assert.equal(perfectButMissingImage.factors.image, null);
  assert.equal(perfectButMissingImage.factors.itemName, 1);
  assert.ok(Math.abs(perfectButMissingImage.weights.description - 15 / 55) < 1e-10);
  assert.ok(Math.abs(perfectButMissingImage.weights.categoryColour - 10 / 55) < 1e-10);
  assert.ok(Math.abs(perfectButMissingImage.weights.location - 5 / 55) < 1e-10);
  assert.ok(Math.abs(perfectButMissingImage.weights.eventTime - 5 / 55) < 1e-10);
  assert.ok(Math.abs(
    Object.values(perfectButMissingImage.weights).reduce((sum, weight) => sum + weight, 0) - 1,
  ) < 1e-10);

  const imageMatch = calculateMatchScore(left, right, [1, 0, 0], [1, 0, 0]);
  assert.equal(imageMatch.score, 100);
  assert.equal(imageMatch.score <= 100, true);

  const mismatchedDetails = calculateMatchScore(
    left,
    {
      ...right,
      brand: 'Apple',
      event_timestamp: new Date('2026-11-21T22:00:00Z'),
    },
    [1, 0],
    [0.427, 0.904],
  );
  assert.equal(mismatchedDetails.factors.brand, 0);
  assert.equal(mismatchedDetails.factors.eventTime, 0.5);
  const weakVisualMatch = calculateMatchScore(left, right, [1, 0], [0.427, 0.904]);
  assert.equal(weakVisualMatch.factors.image < 0.5, true);
  assert.equal(weakVisualMatch.score < 75, true);
});

test('match results expose no candidate description or identity', async () => {
  const claimant = user('student', { student_id: 'LF-CLAIMANT' });
  const owner = user('student', { student_id: 'LF-OWNER' });
  const now = new Date();
  const queried = {
    _id: new ObjectId(),
    user_id: claimant._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    last_matching_at: now,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const candidate = {
    _id: new ObjectId(),
    user_id: owner._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
    image_reference: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg',
  };
  const match = {
    _id: new ObjectId(),
    queried_report_id: queried._id,
    candidate_report_id: candidate._id,
    claimant_id: claimant._id,
    report_owner_id: owner._id,
    similarity_score: 82,
    factor_scores: { image: 0.9, description: 0.7 },
    match_status: 'pending',
  };

  const { app, matchCollection, notificationCollection } = setup(
    [claimant, owner],
    [queried, candidate],
  );
  matchCollection.documents.push(match);

  const result = await asUser(
    app,
    claimant,
    'get',
    `/api/lost-found/${queried._id.toHexString()}/matches`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.high_confidence.length, 1);
  const candidateResult = result.body.high_confidence[0];
  assert.equal(Object.hasOwn(candidateResult, 'description'), false);
  assert.equal(Object.hasOwn(candidateResult, 'reporter_name'), false);
  assert.equal(Object.hasOwn(candidateResult, 'reporter_email'), false);
  assert.equal(candidateResult.approximate_location, 'Sensitive exact location withheld');
  assert.equal(candidateResult.item_name, foundInput.item_name);
  assert.equal(candidateResult.report_type, 'found');
  assert.ok(candidateResult.explanation.includes('Images are visually similar.'));

  const firstRequest = await asUser(
    app,
    claimant,
    'post',
    `/api/lost-found/matches/${match._id.toHexString()}/request`,
  );
  assert.equal(firstRequest.status, 201);
  assert.equal(firstRequest.body.private_details_revealed, false);
  assert.equal(notificationCollection.documents.length, 1);
  assert.equal(notificationCollection.documents[0].action_type, 'lost_found_claim');
  assert.equal(String(notificationCollection.documents[0].claim_id), firstRequest.body.id);
  assert.equal(String(notificationCollection.documents[0].recipient_user_id), String(owner._id));

  const duplicate = await asUser(
    app,
    claimant,
    'post',
    `/api/lost-found/matches/${match._id.toHexString()}/request`,
  );
  assert.equal(duplicate.status, 409);
  assert.equal(notificationCollection.documents.length, 1);
});

test('match generation and claims always use LOST report as claimant and FOUND report as candidate', async () => {
  const lostOwner = user('student');
  const foundOwner = user('student');
  const now = new Date();
  const lost = {
    _id: new ObjectId(),
    user_id: lostOwner._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const found = {
    _id: new ObjectId(),
    user_id: foundOwner._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const { app, matchCollection } = setup([lostOwner, foundOwner], [found, lost]);

  const foundMatches = await asUser(
    app,
    foundOwner,
    'get',
    `/api/lost-found/${found._id.toHexString()}/matches`,
  );
  assert.equal(foundMatches.status, 422);

  const lostMatches = await asUser(
    app,
    lostOwner,
    'get',
    `/api/lost-found/${lost._id.toHexString()}/matches`,
  );
  assert.equal(lostMatches.status, 200);
  assert.ok(matchCollection.documents.length > 0);
  assert.ok(matchCollection.documents.every((match) =>
    match.queried_report_id.equals(lost._id) && match.candidate_report_id.equals(found._id)));

  const wrongDirectionMatch = {
    _id: new ObjectId(),
    queried_report_id: found._id,
    candidate_report_id: lost._id,
    similarity_score: 99,
    match_status: 'pending',
  };
  matchCollection.documents.push(wrongDirectionMatch);
  const wrongDirectionRequest = await asUser(
    app,
    foundOwner,
    'post',
    `/api/lost-found/matches/${wrongDirectionMatch._id.toHexString()}/request`,
  );
  assert.equal(wrongDirectionRequest.status, 409);
});

test('unauthorized users cannot review match requests and match requests do not resolve reports', async () => {
  const claimant = user('student');
  const owner = user('student');
  const outsider = user('student');
  const now = new Date();
  const queried = {
    _id: new ObjectId(),
    user_id: claimant._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const candidate = {
    _id: new ObjectId(),
    user_id: owner._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const match = {
    _id: new ObjectId(),
    queried_report_id: queried._id,
    candidate_report_id: candidate._id,
    claimant_id: claimant._id,
    report_owner_id: owner._id,
    similarity_score: 80,
  };
  const claim = {
    _id: new ObjectId(),
    match_id: match._id,
    claimant_id: claimant._id,
    report_owner_id: owner._id,
    verification_status: 'pending',
  };

  const { app, reportCollection, matchCollection, claimCollection } = setup(
    [claimant, owner, outsider],
    [queried, candidate],
  );
  matchCollection.documents.push(match);
  claimCollection.documents.push(claim);
  const matchUrl = `/api/lost-found/matches/${match._id.toHexString()}/claims/${claim._id.toHexString()}/review`;

  const unauthorized = await asUser(app, outsider, 'patch', matchUrl, { decision: 'approved' });
  assert.equal(unauthorized.status, 403);
  const unauthorizedImage = await asUser(
    app,
    outsider,
    'get',
    `/api/lost-found/matches/${match._id.toHexString()}/image`,
  );
  assert.equal(unauthorizedImage.status, 404);
  assert.equal(unauthorizedImage.body.detail, 'Match not found');
  assert.equal(reportCollection.documents.every((report) => report.status === 'active'), true);
});

test('incoming match requests are limited to owners and omit requester private details', async () => {
  const claimant = user('student');
  const owner = user('student');
  const outsider = user('student');
  const admin = user('admin');
  const queried = {
    _id: new ObjectId(),
    user_id: claimant._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    status: 'active',
  };
  const candidate = {
    _id: new ObjectId(),
    user_id: owner._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    status: 'active',
    image_url: `/api/lost-found/images/${'a'.repeat(40)}.jpg`,
  };
  const match = {
    _id: new ObjectId(),
    queried_report_id: queried._id,
    candidate_report_id: candidate._id,
    similarity_score: 78,
  };
  const claim = {
    _id: new ObjectId(),
    match_id: match._id,
    claimant_id: claimant._id,
    report_owner_id: owner._id,
    verification_status: 'pending',
    created_at: new Date('2026-11-21T12:00:00Z'),
  };
  const { app, matchCollection, claimCollection } = setup(
    [claimant, owner, outsider, admin],
    [queried, candidate],
  );
  matchCollection.documents.push(match);
  claimCollection.documents.push(claim);

  const response = await asUser(app, owner, 'get', '/api/lost-found/claims/incoming');
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].owner_report.item_name, foundInput.item_name);
  assert.equal(response.body.items[0].requesting_report.item_name, lostInput.item_name);
  assert.equal(response.body.items[0].similarity_score, 78);
  assert.equal(Object.hasOwn(response.body.items[0].requesting_report, 'description'), false);
  assert.equal(Object.hasOwn(response.body.items[0].requesting_report, 'location'), false);
  assert.equal(Object.hasOwn(response.body.items[0], 'claimant_id'), false);

  const unrelated = await asUser(app, outsider, 'get', '/api/lost-found/claims/incoming');
  assert.equal(unrelated.status, 200);
  assert.equal(unrelated.body.items.length, 0);

  const adminQueue = await asUser(app, admin, 'get', '/api/lost-found/claims/incoming');
  assert.equal(adminQueue.status, 200);
  assert.equal(adminQueue.body.items.length, 1);
  const adminReview = await asUser(
    app,
    admin,
    'patch',
    `/api/lost-found/matches/${match._id.toHexString()}/claims/${claim._id.toHexString()}/review`,
    { decision: 'approved' },
  );
  assert.equal(adminReview.status, 200);
  assert.equal(adminReview.body.verification_status, 'approved');
});

test('matching results exclude a candidate report owned by the same student', async () => {
  const student = user('student');
  const now = new Date();
  const queried = {
    _id: new ObjectId(),
    user_id: student._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    last_matching_at: now,
    status: 'active',
  };
  const candidate = {
    _id: new ObjectId(),
    user_id: student._id,
    ...foundInput,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    status: 'active',
  };
  const match = {
    _id: new ObjectId(),
    queried_report_id: queried._id,
    candidate_report_id: candidate._id,
    similarity_score: 99,
  };
  const { app, matchCollection } = setup([student], [queried, candidate]);
  matchCollection.documents.push(match);

  const response = await asUser(
    app,
    student,
    'get',
    `/api/lost-found/${queried._id.toHexString()}/matches`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 0);
});

test('configured thresholds separate high-confidence and possible matches', async () => {
  const claimant = user('student');
  const ownerOne = user('student');
  const ownerTwo = user('student');
  const now = new Date();
  const queried = {
    _id: new ObjectId(),
    user_id: claimant._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    last_matching_at: now,
    status: 'active',
  };
  const candidates = [ownerOne, ownerTwo].map((owner, index) => ({
    _id: new ObjectId(),
    user_id: owner._id,
    ...foundInput,
    event_timestamp: new Date(`2026-11-21T${11 + index}:00:00Z`),
    status: 'active',
  }));
  const { app, matchCollection } = setup(
    [claimant, ownerOne, ownerTwo],
    [queried, ...candidates],
    undefined,
    {
      ...ENV,
      LOST_FOUND_HIGH_CONFIDENCE_THRESHOLD: '85',
      LOST_FOUND_MINIMUM_MATCH_THRESHOLD: '60',
    },
  );
  matchCollection.documents.push(
    {
      _id: new ObjectId(),
      queried_report_id: queried._id,
      candidate_report_id: candidates[0]._id,
      similarity_score: 90,
    },
    {
      _id: new ObjectId(),
      queried_report_id: queried._id,
      candidate_report_id: candidates[1]._id,
      similarity_score: 70,
    },
  );

  const response = await asUser(
    app,
    claimant,
    'get',
    `/api/lost-found/${queried._id.toHexString()}/matches`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.high_confidence_threshold, 85);
  assert.equal(response.body.minimum_threshold, 60);
  assert.equal(response.body.high_confidence.length, 1);
  assert.equal(response.body.possible_matches.length, 1);
});

test('uploaded images survive app recreation and missing image files return 404', async () => {
  const student = user('student');
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lost-found-persistence-'));
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
    'base64',
  );
  const { app, userCollection, reportCollection, matchCollection, claimCollection, notificationCollection } =
    setup([student], [], uploadDir);
  try {
    const created = await asUser(app, student, 'post', '/api/lost-found', {
      ...lostInput,
      image: { type: 'image/png', data: imageBytes.toString('base64') },
    });
    assert.equal(created.status, 201);
    const reference = created.body.image_url.split('/').pop();
    const restartedApp = createApp({
      env: ENV,
      getUsersCollection: async () => userCollection,
      getLostFoundItemsCollection: async () => reportCollection,
      getLostFoundMatchesCollection: async () => matchCollection,
      getLostFoundClaimsCollection: async () => claimCollection,
      getNotificationsCollection: async () => notificationCollection,
      lostFoundUploadDir: uploadDir,
    });

    const imageAfterRestart = await asUser(
      restartedApp,
      student,
      'get',
      `/api/lost-found/images/${reference}`,
    );
    assert.equal(imageAfterRestart.status, 200);
    assert.deepEqual(imageAfterRestart.body, imageBytes);

    await fs.unlink(path.join(uploadDir, reference));
    const missingImage = await asUser(
      restartedApp,
      student,
      'get',
      `/api/lost-found/images/${reference}`,
    );
    assert.equal(missingImage.status, 404);
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});

test('embeddings persist across app recreation and missing embeddings invalidate stale scores', async () => {
  const claimant = user('student');
  const owner = user('student');
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lost-found-embeddings-'));
  const uploadDir = path.join(rootDir, 'uploads', 'lost-found');
  const embeddingDir = path.resolve(uploadDir, '..', 'lost-found-embeddings');
  const leftReference = `lost_found_${'a'.repeat(40)}.json`;
  const rightReference = `lost_found_${'b'.repeat(40)}.json`;
  const queried = {
    _id: new ObjectId(),
    user_id: claimant._id,
    ...lostInput,
    event_timestamp: new Date('2026-11-21T10:00:00Z'),
    last_matching_at: new Date(0),
    image_embedding_reference: leftReference,
    status: 'active',
  };
  const candidate = {
    _id: new ObjectId(),
    user_id: owner._id,
    ...foundInput,
    location: lostInput.location,
    event_timestamp: new Date('2026-11-21T11:00:00Z'),
    image_embedding_reference: rightReference,
    status: 'active',
  };
  const existingMatch = {
    _id: new ObjectId(),
    queried_report_id: queried._id,
    candidate_report_id: candidate._id,
    similarity_score: 100,
    match_status: 'verification_pending',
  };
  const { app, userCollection, reportCollection, matchCollection, claimCollection, notificationCollection } =
    setup([claimant, owner], [queried, candidate], uploadDir);
  matchCollection.documents.push(existingMatch);

  try {
    await fs.mkdir(embeddingDir, { recursive: true });
    for (const reference of [leftReference, rightReference]) {
      await fs.writeFile(
        path.join(embeddingDir, reference),
        JSON.stringify({ embedding: [1, 0] }),
      );
    }

    const restartedApp = createApp({
      env: ENV,
      getUsersCollection: async () => userCollection,
      getLostFoundItemsCollection: async () => reportCollection,
      getLostFoundMatchesCollection: async () => matchCollection,
      getLostFoundClaimsCollection: async () => claimCollection,
      getNotificationsCollection: async () => notificationCollection,
      lostFoundUploadDir: uploadDir,
    });
    const persistedResults = await asUser(
      restartedApp,
      claimant,
      'get',
      `/api/lost-found/${queried._id.toHexString()}/matches`,
    );
    assert.equal(persistedResults.status, 200);
    assert.equal(persistedResults.body.high_confidence.length, 1);

    await fs.unlink(path.join(embeddingDir, rightReference));
    queried.last_matching_at = new Date(0);
    const missingResults = await asUser(
      restartedApp,
      claimant,
      'get',
      `/api/lost-found/${queried._id.toHexString()}/matches`,
    );
    assert.equal(missingResults.status, 200);
    assert.equal(missingResults.body.items.length, 1);
    assert.ok(existingMatch.similarity_score < 100);
    assert.ok(existingMatch.similarity_score >= 55);
    assert.equal(existingMatch.match_status, 'verification_pending');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
