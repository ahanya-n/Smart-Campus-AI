const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { getJwtConfig } = require('../auth/config');
const {
  hashPassword,
  performDummyVerification,
  verifyPassword,
} = require('../auth/passwords');
const {
  normalizeEmail,
  safeUser,
  validateLogin,
  validateRegistration,
} = require('../auth/users');
const { createAuthMiddleware } = require('../middleware/auth');

function createAuthRouter({
  env = process.env,
  getUsersCollection,
  getStudentsCollection,
  getLinkCodesCollection,
}) {
  const router = express.Router();
  const { authenticate } = createAuthMiddleware({ env, getUsersCollection });

  router.post('/register', async (request, response, next) => {
    const validationError = validateRegistration(request.body);
    if (validationError) {
      return response.status(422).json(validationError);
    }

    try {
      const collection = await getUsersCollection();
      const name = request.body.name.trim();
      const email = normalizeEmail(request.body.email);
      const existing = await collection.findOne({
        email: { $in: [...new Set([request.body.email.trim(), email])] },
      });
      if (existing) {
        return response.status(400).json({ detail: 'Email already registered' });
      }

      const user = {
        name,
        email,
        password: await hashPassword(request.body.password),
        role: 'student',
      };
      const result = await collection.insertOne(user);
      if (!result.acknowledged) {
        return response.status(500).json({ detail: 'Could not register user' });
      }

      return response.status(200).json({ message: 'User registered successfully' });
    } catch (error) {
      if (error.code === 11000) {
        return response.status(400).json({ detail: 'Email already registered' });
      }
      return next(error);
    }
  });

  router.post('/login', async (request, response, next) => {
    const validationError = validateLogin(request.body);
    if (validationError) {
      return response.status(422).json(validationError);
    }

    try {
      getJwtConfig(env);
      const email = request.body.email.trim();
      const collection = await getUsersCollection();
      const user = await collection.findOne({
        email: { $in: [...new Set([email, email.toLowerCase()])] },
      });

      if (!user) {
        await performDummyVerification(request.body.password);
        return response
          .status(401)
          .set('WWW-Authenticate', 'Bearer')
          .json({ detail: 'Incorrect email or password' });
      }

      const passwordMatches = await verifyPassword(
        request.body.password,
        user.password,
      );
      if (!passwordMatches) {
        return response
          .status(401)
          .set('WWW-Authenticate', 'Bearer')
          .json({ detail: 'Incorrect email or password' });
      }

      const config = getJwtConfig(env);
      const accessToken = jwt.sign(
        { role: user.role || 'student' },
        config.secret,
        {
          algorithm: config.algorithm,
          subject: String(user._id),
          expiresIn: `${config.expiresInMinutes}m`,
        },
      );
      return response.json({ access_token: accessToken, token_type: 'bearer' });
    } catch (error) {
      if (
        error.statusCode === 500 &&
        ['JWT_SECRET is not configured', 'JWT_ALGORITHM must be HS256',
          'TOKEN_EXPIRE_MINUTES must be a positive integer'].includes(error.message)
      ) {
        return response.status(500).json({ detail: error.message });
      }
      return next(error);
    }
  });

  router.get('/me', authenticate, (request, response) => {
    return response.json(safeUser(request.user));
  });

  router.post('/me/link-student', authenticate, async (request, response, next) => {
    const { student_id: studentId, link_code: linkCode } = request.body || {};
    if (
      typeof studentId !== 'string' ||
      studentId.length < 1 ||
      studentId.length > 50 ||
      typeof linkCode !== 'string' ||
      linkCode.length < 4 ||
      linkCode.length > 32
    ) {
      return response.status(422).json({
        detail: 'student_id and link_code are required',
      });
    }
    if (request.user.role !== 'student') {
      return response.status(403).json({ detail: 'Only student accounts can link a student record' });
    }
    if (request.user.student_id) {
      return response.status(409).json({ detail: 'Your account is already linked to a student record' });
    }
    try {
      const normalizedStudentId = studentId.trim();
      const codes = await getLinkCodesCollection();
      const record = await codes.findOne({ student_id: normalizedStudentId });
      const expiresAt = record?.expires_at instanceof Date
        ? record.expires_at
        : record?.expires_at
          ? new Date(record.expires_at)
          : null;
      if (!record || !expiresAt || Number.isNaN(expiresAt.valueOf()) || expiresAt <= new Date()) {
        return response.status(400).json({ detail: 'Invalid or expired link code' });
      }
      const digest = crypto.createHash('sha256')
        .update(linkCode.trim().toUpperCase())
        .digest();
      const storedHash = Buffer.from(record.code_hash || '', 'hex');
      const matches = storedHash.length === digest.length &&
        crypto.timingSafeEqual(storedHash, digest);
      if (!matches) {
        await codes.updateOne(
          {
            _id: record._id,
            expires_at: { $gt: new Date() },
            attempts: { $lt: 5 },
          },
          { $inc: { attempts: 1 } },
        );
        await codes.deleteOne({ _id: record._id, attempts: { $gte: 5 } });
        return response.status(400).json({ detail: 'Invalid or expired link code' });
      }

      const students = await getStudentsCollection();
      if (!await students.findOne(
        { student_id: normalizedStudentId },
        { projection: { _id: 1 } },
      )) {
        return response.status(404).json({ detail: `Student ${normalizedStudentId} not found` });
      }
      const users = await getUsersCollection();
      const duplicate = await users.findOne({
        student_id: normalizedStudentId,
        _id: { $ne: request.user._id },
      }, { projection: { _id: 1 } });
      if (duplicate) {
        return response.status(409).json({
          detail: `Student ${normalizedStudentId} is already linked to another account`,
        });
      }

      const consumed = await codes.deleteOne({
        _id: record._id,
        student_id: normalizedStudentId,
        code_hash: record.code_hash,
        expires_at: { $gt: new Date() },
        attempts: { $lt: 5 },
      });
      if (consumed.deletedCount !== 1) {
        return response.status(400).json({ detail: 'Invalid or expired link code' });
      }

      try {
        const update = await users.updateOne(
          {
            _id: new ObjectId(String(request.user._id)),
            role: 'student',
            student_id: { $in: [null] },
          },
          { $set: { student_id: normalizedStudentId } },
        );
        if (update.matchedCount !== 1) {
          return response.status(409).json({
            detail: 'Your account is already linked to a student record',
          });
        }
      } catch (error) {
        if (error.code === 11000) {
          return response.status(409).json({
            detail: `Student ${normalizedStudentId} is already linked to another account`,
          });
        }
        throw error;
      }
      return response.json({
        ...safeUser({ ...request.user, student_id: normalizedStudentId }),
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
