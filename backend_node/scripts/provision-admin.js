const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { EMAIL_PATTERN, normalizeEmail } = require('../src/auth/users');
const { getJwtConfig } = require('../src/auth/config');
const { hashPassword } = require('../src/auth/passwords');
const { readMongoConfig } = require('../src/config/database');
const { COLLECTIONS, connectMongo, closeMongo } = require('../src/config/mongo');

const ALLOWED_DATABASE = 'smart_campus_test';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalMongoUri(uri) {
  if (typeof uri !== 'string' || !/^mongodb:\/\//i.test(uri)) return false;
  const authorityMatch = /^mongodb:\/\/([^/?#]+)/i.exec(uri);
  if (!authorityMatch) return false;

  const authority = authorityMatch[1].split('@').pop();
  const hosts = authority.split(',');
  if (!hosts.length) return false;

  return hosts.every((hostPort) => {
    const ipv6Match = /^\[([^\]]+)\](?::\d+)?$/.exec(hostPort);
    const hostnameMatch = /^([^:]+)(?::\d+)?$/.exec(hostPort);
    const hostname = (ipv6Match?.[1] || hostnameMatch?.[1] || '').toLowerCase();
    return LOCAL_HOSTS.has(hostname);
  });
}

function validateProvisioningConfig(env) {
  const config = readMongoConfig(env);
  if (config.databaseName !== ALLOWED_DATABASE) {
    throw new Error('Admin provisioning is allowed only for smart_campus_test.');
  }
  if (!isLocalMongoUri(config.uri)) {
    throw new Error('Admin provisioning is allowed only with a local MongoDB URI.');
  }
  return config;
}

function validateCredentials({ name, email, password }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw new Error('Admin name must contain 1 to 100 characters.');
  }
  if (
    typeof email !== 'string' ||
    email.trim().length < 3 ||
    email.trim().length > 254 ||
    !EMAIL_PATTERN.test(normalizeEmail(email))
  ) {
    throw new Error('A valid admin email is required.');
  }
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128
  ) {
    throw new Error('Admin password must contain 8 to 128 characters.');
  }
  return {
    name: name.trim(),
    email: normalizeEmail(email),
    password,
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function provisionAdmin({
  env = process.env,
  credentials,
  getUsersCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.users),
  hashPasswordImpl = hashPassword,
}) {
  validateProvisioningConfig(env);
  const admin = validateCredentials(credentials);
  const users = await getUsersCollection();

  if (await users.countDocuments({ role: 'admin' })) {
    throw new Error('An administrator already exists; provisioning is one-time only.');
  }

  if (await users.findOne({
    email: { $regex: `^${escapeRegex(admin.email)}$`, $options: 'i' },
  })) {
    throw new Error('An account with this email already exists; no accounts were changed.');
  }

  const document = {
    name: admin.name,
    email: admin.email,
    password: await hashPasswordImpl(admin.password),
    role: 'admin',
  };

  try {
    const result = await users.insertOne(document);
    if (!result.acknowledged) {
      throw new Error('MongoDB did not confirm administrator creation.');
    }
  } catch (error) {
    if (error.code === 11000) {
      throw new Error('An account with this email already exists; no accounts were changed.');
    }
    throw error;
  }

  return { name: document.name, role: document.role };
}

async function promptLine(question) {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise((resolve) => terminal.question(question, resolve));
  } finally {
    terminal.close();
  }
}

function promptHidden(
  question,
  {
    input = process.stdin,
    output = process.stdout,
    createInterface = readline.createInterface,
  } = {},
) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Set ADMIN_PASSWORD in the environment or run this script in an interactive terminal.');
  }

  const hiddenOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  hiddenOutput.isTTY = true;
  hiddenOutput.columns = output.columns;
  output.write(question);

  const terminal = createInterface({
    input,
    output: hiddenOutput,
    terminal: true,
    crlfDelay: Infinity,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error, password) {
      if (settled) return;
      settled = true;
      terminal.close();
      output.write('\n');
      if (error) reject(error);
      else resolve(password);
    }

    terminal.once('line', (password) => finish(null, password));
    terminal.once('SIGINT', () => finish(new Error('Admin provisioning cancelled.')));
    terminal.once('close', () => {
      finish(new Error('Admin password input was closed before submission.'));
    });
  });
}

async function readCredentials(env) {
  const name = env.ADMIN_NAME || await promptLine('Admin name: ');
  const email = env.ADMIN_EMAIL || await promptLine('Admin email: ');
  const password = env.ADMIN_PASSWORD || await promptHidden('Admin password (input hidden): ');
  return validateCredentials({ name, email, password });
}

async function main() {
  require('dotenv').config({
    path: path.resolve(__dirname, '..', '.env'),
    quiet: true,
  });

  validateProvisioningConfig(process.env);
  getJwtConfig(process.env);
  const credentials = await readCredentials(process.env);
  try {
    await provisionAdmin({ env: process.env, credentials });
    console.log('Administrator account created for the isolated test database.');
  } catch (error) {
    if (
      error.message === 'An administrator already exists; provisioning is one-time only.' ||
      error.message === 'An account with this email already exists; no accounts were changed.' ||
      error.message === 'MongoDB did not confirm administrator creation.'
    ) {
      throw error;
    }
    throw new Error('Admin provisioning failed. Check the isolated MongoDB service and backend configuration.');
  } finally {
    try {
      await closeMongo();
    } catch {
      throw new Error('Could not safely close the MongoDB connection.');
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  isLocalMongoUri,
  provisionAdmin,
  promptHidden,
  validateCredentials,
  validateProvisioningConfig,
};
