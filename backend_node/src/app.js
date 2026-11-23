const express = require('express');
const { MongoError } = require('mongodb');
const { createAuthRouter } = require('./routes/authRoutes');
const { createAttendanceRouter } = require('./routes/attendanceRoutes');
const { createAdminRouter } = require('./routes/adminRoutes');
const { createAssistantRouter } = require('./routes/assistantRoutes');
const { createNotificationRouter } = require('./routes/notificationRoutes');
const { createStudentRouter } = require('./routes/studentRoutes');
const { createTimetableRouter } = require('./routes/timetableRoutes');
const { createLibraryRouter } = require('./routes/libraryRoutes');
const { createTransportRouter } = require('./routes/transportRoutes');
const { createComplaintRouter } = require('./routes/complaintRoutes');
const { createLostFoundRouter } = require('./routes/lostFoundRoutes');
const { createAcademicIntelligenceRouter } = require('./routes/academicIntelligenceRoutes');
const { createAuthMiddleware } = require('./middleware/auth');
const { COLLECTIONS, connectMongo } = require('./config/mongo');

function createApp({
  env = process.env,
  getUsersCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.users),
  getStudentsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.students),
  getSubjectsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.subjects),
  getClassesCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.classes),
  getAttendanceCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.attendance),
  getAttendanceEntriesCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.attendanceEntries),
  getTimetableCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.timetable),
  getNotificationsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.notifications),
  getLinkCodesCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.studentLinkCodes),
  getBooksCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.books),
  getBookLoansCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.bookLoans),
  getTransportRoutesCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.transportRoutes),
  getComplaintsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.complaints),
  getLostFoundItemsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.lostFoundItems),
  getLostFoundMatchesCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.lostFoundMatches),
  getLostFoundClaimsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.lostFoundClaims),
  getAssignmentsCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.assignments),
  getMarksCollection = async () =>
    (await connectMongo(env)).collection('marks'),
  fetchAcademicIntelligence = globalThis.fetch,
  fetchAssistant = globalThis.fetch,
  lostFoundUploadDir,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_request, response) => {
    response.status(200).json({
      status: 'ok',
      service: 'smart-campus-api',
      timestamp: new Date().toISOString(),
    });
  });

  const authMiddleware = createAuthMiddleware({ env, getUsersCollection });
  app.use('/api/auth', createAuthRouter({
    env,
    getUsersCollection,
    getStudentsCollection,
    getLinkCodesCollection,
  }));
  app.use('/api/students', createStudentRouter({
    ...authMiddleware,
    getStudentsCollection,
    getTimetableCollection,
    getAttendanceCollection,
    getAttendanceEntriesCollection,
    getAssignmentsCollection,
    getMarksCollection,
    getNotificationsCollection,
  }));
  app.use('/api/attendance', createAttendanceRouter({
    ...authMiddleware,
    getStudentsCollection,
    getAttendanceCollection,
    getAttendanceEntriesCollection,
  }));
  app.use('/api/timetable', createTimetableRouter({
    ...authMiddleware,
    getStudentsCollection,
    getTimetableCollection,
    getUsersCollection,
  }));
  app.use('/api/library', createLibraryRouter({
    ...authMiddleware,
    getBooksCollection,
    getBookLoansCollection,
  }));
  app.use('/api/transport', createTransportRouter({
    ...authMiddleware,
    getTransportRoutesCollection,
    getStudentsCollection,
  }));
  app.use('/api/complaints', createComplaintRouter({
    ...authMiddleware,
    getComplaintsCollection,
    getUsersCollection,
  }));
  app.use('/api/lost-found', createLostFoundRouter({
    ...authMiddleware,
    getLostFoundItemsCollection,
    getLostFoundMatchesCollection,
    getLostFoundClaimsCollection,
    getNotificationsCollection,
    getUsersCollection,
    uploadDir: lostFoundUploadDir,
    aiServiceBaseUrl: env.LOST_FOUND_AI_BASE_URL,
    aiInternalKey: env.LOST_FOUND_INTERNAL_KEY,
    highConfidenceThreshold: env.LOST_FOUND_HIGH_CONFIDENCE_THRESHOLD,
    minimumMatchThreshold: env.LOST_FOUND_MINIMUM_MATCH_THRESHOLD,
  }));
  app.use('/api/notifications', createNotificationRouter({
    ...authMiddleware,
    getStudentsCollection,
    getAttendanceCollection,
    getNotificationsCollection,
  }));
  app.use('/api/admin', createAdminRouter({
    ...authMiddleware,
    getUsersCollection,
    getStudentsCollection,
    getSubjectsCollection,
    getClassesCollection,
    getLinkCodesCollection,
    getAttendanceEntriesCollection,
    getTimetableCollection,
    getBooksCollection,
    getComplaintsCollection,
  }));
  app.use('/api/assistant', createAssistantRouter({
    authenticate: authMiddleware.authenticate,
    fetchImpl: fetchAssistant,
    baseUrl: env.FASTAPI_BASE_URL || 'http://127.0.0.1:8000',
  }));
  app.use('/api/academic-intelligence', createAcademicIntelligenceRouter({
    authenticate: authMiddleware.authenticate,
    fetchImpl: fetchAcademicIntelligence,
    baseUrl: env.FASTAPI_BASE_URL || 'http://127.0.0.1:8000',
  }));

  app.use((error, _request, response, _next) => {
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ detail: 'Invalid JSON body' });
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ detail: 'Request body is too large' });
    }
    if (error.code === 'MONGODB_NOT_CONFIGURED') {
      return response.status(503).json({
        detail: 'Database is not configured. Set MONGO_URI and MONGO_DB_NAME in backend_node/.env.',
      });
    }
    if (error.code === 'MONGODB_CONFIG_INVALID') {
      return response.status(503).json({
        detail: 'Database configuration is invalid. Check backend_node/.env.',
      });
    }

    if (
      error.statusCode === 503 ||
      error.code === 'MONGODB_UNAVAILABLE' ||
      error instanceof MongoError
    ) {
      return response.status(503).json({ detail: 'Database is unavailable' });
    }

    console.error('Unhandled API error:', error.name || 'Error');
    return response.status(500).json({ detail: 'Internal server error' });
  });

  return app;
}

const app = createApp();
const { authenticate, requireRoles } = createAuthMiddleware({
  env: process.env,
  getUsersCollection: async () =>
    (await connectMongo(process.env)).collection(COLLECTIONS.users),
});

module.exports = app;
module.exports.createApp = createApp;
module.exports.authenticate = authenticate;
module.exports.requireRoles = requireRoles;
