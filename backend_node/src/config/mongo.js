const { MongoClient } = require('mongodb');
const { readMongoConfig } = require('./database');

const COLLECTIONS = Object.freeze({
  users: 'users',
  students: 'students',
  subjects: 'subjects',
  classes: 'classes',
  attendance: 'attendance',
  attendanceEntries: 'attendance_entries',
  timetable: 'timetable',
  studentLinkCodes: 'student_link_codes',
  books: 'books',
  bookLoans: 'book_loans',
  complaints: 'complaints',
  events: 'events',
  transportRoutes: 'transport_routes',
  notifications: 'notifications',
  lostFoundItems: 'lost_found_items',
  lostFoundMatches: 'lost_found_matches',
  lostFoundClaims: 'lost_found_claims',
  assignments: 'assignments',
});

let client;
let database;
let connectionPromise;

async function connectMongo(env = process.env, MongoClientFactory = MongoClient) {
  if (database) return database;
  if (connectionPromise) return connectionPromise;

  const config = readMongoConfig(env);
  connectionPromise = (async () => {
    let pendingClient;
    try {
      pendingClient = new MongoClientFactory(config.uri, {
        serverSelectionTimeoutMS: config.serverSelectionTimeoutMS,
        appName: config.appName,
      });
      await pendingClient.connect();
      client = pendingClient;
      database = pendingClient.db(config.databaseName);
      return database;
    } catch (error) {
      let closeError;
      if (pendingClient) {
        try {
          await pendingClient.close();
        } catch (cleanupError) {
          closeError = cleanupError;
        }
      }

      const unavailable = new Error('MongoDB connection failed.');
      unavailable.statusCode = 503;
      unavailable.code = 'MONGODB_UNAVAILABLE';
      unavailable.cause = closeError
        ? new AggregateError([error, closeError], 'MongoDB connection and cleanup failed.')
        : error;
      throw unavailable;
    }
  })();

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = undefined;
  }
}

function getDatabase() {
  if (!database) {
    throw new Error('MongoDB is not connected. Call connectMongo() explicitly first.');
  }
  return database;
}

async function closeMongo() {
  if (connectionPromise) await connectionPromise;
  if (client) await client.close();
  client = undefined;
  database = undefined;
}

module.exports = {
  COLLECTIONS,
  closeMongo,
  connectMongo,
  getDatabase,
};
