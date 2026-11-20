const SUPPORTED_JWT_ALGORITHM = 'HS256';

function getJwtConfig(env = process.env) {
  const secret = env.JWT_SECRET?.trim();
  const algorithm = env.JWT_ALGORITHM || SUPPORTED_JWT_ALGORITHM;
  const expiresInMinutes = Number(env.TOKEN_EXPIRE_MINUTES || 60);

  if (!secret || secret === 'change-me') {
    const error = new Error('JWT_SECRET is not configured');
    error.statusCode = 500;
    throw error;
  }
  if (algorithm !== SUPPORTED_JWT_ALGORITHM) {
    const error = new Error('JWT_ALGORITHM must be HS256');
    error.statusCode = 500;
    throw error;
  }
  if (!Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 1) {
    const error = new Error('TOKEN_EXPIRE_MINUTES must be a positive integer');
    error.statusCode = 500;
    throw error;
  }

  return { secret, algorithm, expiresInMinutes };
}

module.exports = { getJwtConfig };
