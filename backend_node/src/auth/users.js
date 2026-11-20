const { ObjectId } = require('mongodb');

const ROLES = Object.freeze(['student', 'faculty', 'admin']);
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function safeUser(user) {
  return {
    name: user.name || '',
    email: user.email || '',
    role: ROLES.includes(user.role) ? user.role : 'student',
    student_id: user.student_id ?? null,
    assigned_subject_codes: Array.isArray(user.assigned_subject_codes)
      ? user.assigned_subject_codes
      : [],
  };
}

function validateRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { detail: 'Request body must be a JSON object' };
  }
  const { name, email, password } = body;
  if (typeof name !== 'string' || name.length < 1 || name.length > 100) {
    return { detail: 'name must be between 1 and 100 characters' };
  }
  if (typeof email !== 'string' || email.length < 3 || email.length > 254) {
    return { detail: 'email must be between 3 and 254 characters' };
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return { detail: 'password must be between 8 and 128 characters' };
  }

  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    return { detail: 'Please enter a valid email' };
  }
  if (!name.trim()) {
    return { detail: 'Name is required' };
  }
  return null;
}

function validateLogin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { detail: 'Request body must be a JSON object' };
  }
  if (
    typeof body.email !== 'string' ||
    body.email.length < 1 ||
    body.email.length > 254 ||
    typeof body.password !== 'string' ||
    body.password.length < 1 ||
    body.password.length > 128
  ) {
    return { detail: 'Email and password are required' };
  }
  return null;
}

function parseObjectId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) return null;
  return new ObjectId(value);
}

module.exports = {
  EMAIL_PATTERN,
  ROLES,
  normalizeEmail,
  parseObjectId,
  safeUser,
  validateLogin,
  validateRegistration,
};
