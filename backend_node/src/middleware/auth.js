const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('../auth/config');
const { parseObjectId, ROLES } = require('../auth/users');

function createAuthMiddleware({ env = process.env, getUsersCollection }) {
  async function authenticate(request, response, next) {
    const authorization = request.get('authorization');
    const match = typeof authorization === 'string'
      ? /^Bearer\s+(\S+)$/i.exec(authorization)
      : null;

    if (!match) {
      return response
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ detail: 'Not authenticated' });
    }

    let config;
    try {
      config = getJwtConfig(env);
    } catch (error) {
      return response.status(error.statusCode || 500).json({ detail: error.message });
    }

    let payload;
    try {
      payload = jwt.verify(match[1], config.secret, {
        algorithms: [config.algorithm],
        complete: false,
      });
    } catch (error) {
      const detail = error.name === 'TokenExpiredError'
        ? 'Token has expired'
        : 'Invalid token';
      return response
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ detail });
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.sub !== 'string' ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp)
    ) {
      return response
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ detail: 'Invalid token' });
    }

    const objectId = parseObjectId(payload.sub);
    if (!objectId) {
      return response
        .status(401)
        .set('WWW-Authenticate', 'Bearer')
        .json({ detail: 'Invalid token' });
    }

    try {
      const collection = await getUsersCollection();
      const user = await collection.findOne(
        { _id: objectId },
        { projection: { password: 0 } },
      );
      if (!user) {
        return response
          .status(401)
          .set('WWW-Authenticate', 'Bearer')
          .json({ detail: 'User not found' });
      }

      request.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function requireRoles(...allowedRoles) {
    if (
      allowedRoles.length === 0 ||
      allowedRoles.some((role) => !ROLES.includes(role))
    ) {
      throw new Error('requireRoles must be configured with valid roles.');
    }

    return (request, response, next) => {
      if (!request.user) {
        return response
          .status(401)
          .set('WWW-Authenticate', 'Bearer')
          .json({ detail: 'Not authenticated' });
      }

      const role = ROLES.includes(request.user.role) ? request.user.role : 'student';
      if (!allowedRoles.includes(role)) {
        const roleText = allowedRoles.join(' or ');
        return response.status(403).json({
          detail: `This action requires the ${roleText} role.`,
        });
      }
      return next();
    };
  }

  return { authenticate, requireRoles };
}

module.exports = { createAuthMiddleware };
