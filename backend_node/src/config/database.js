const PRODUCTION_DATABASE_NAME = 'smart_campus';

function configurationError(message, code) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = code;
  return error;
}

function readMongoConfig(env = process.env) {
  const uri = env.MONGO_URI?.trim();
  const databaseName = env.MONGO_DB_NAME?.trim();

  if (!uri) {
    throw configurationError(
      'MONGO_URI is required before MongoDB can be connected.',
      'MONGODB_NOT_CONFIGURED',
    );
  }
  if (!databaseName) {
    throw configurationError(
      'MONGO_DB_NAME is required before MongoDB can be connected.',
      'MONGODB_NOT_CONFIGURED',
    );
  }
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri) || /[<>\s]/.test(uri)) {
    throw configurationError(
      'MONGO_URI must be a valid MongoDB connection URI.',
      'MONGODB_CONFIG_INVALID',
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) {
    throw configurationError(
      'MONGO_DB_NAME contains unsupported characters.',
      'MONGODB_CONFIG_INVALID',
    );
  }
  if (
    databaseName === PRODUCTION_DATABASE_NAME &&
    env.MONGO_ALLOW_PRODUCTION !== 'true'
  ) {
    throw configurationError(
      'Refusing to use the existing production database without explicit approval.',
      'MONGODB_CONFIG_INVALID',
    );
  }

  return {
    uri,
    databaseName,
    serverSelectionTimeoutMS: 5000,
    appName: 'smart-campus-express',
  };
}

module.exports = { readMongoConfig };
