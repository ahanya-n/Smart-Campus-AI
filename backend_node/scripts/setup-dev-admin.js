const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { getJwtConfig } = require('../src/auth/config');
const { hashPassword } = require('../src/auth/passwords');
const { COLLECTIONS, closeMongo, connectMongo } = require('../src/config/mongo');
const {
  isLocalMongoUri,
  promptHidden,
  validateCredentials,
  validateProvisioningConfig,
} = require('./provision-admin');

const CONFIRMATION_PHRASE = 'CREATE ADMIN';

function findExistingEmailQuery(email) {
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { email: { $regex: `^${escapedEmail}$`, $options: 'i' } };
}

function proposalFor({ databaseName, name, email }) {
  return {
    database: databaseName,
    mongo_host: 'local MongoDB',
    operation: 'insert one new user document',
    user: { name, email, role: 'admin' },
  };
}

async function setupDevAdmin({
  env = process.env,
  credentials,
  getUsersCollection = async () =>
    (await connectMongo(env)).collection(COLLECTIONS.users),
  hashPasswordImpl = hashPassword,
  displayProposal = () => {},
  confirm = async () => false,
}) {
  const config = validateProvisioningConfig(env);
  if (config.databaseName !== 'smart_campus_test' || !isLocalMongoUri(config.uri)) {
    throw new Error('Development admin setup is restricted to local smart_campus_test.');
  }

  const admin = validateCredentials(credentials);
  const users = await getUsersCollection();
  if (await users.findOne(findExistingEmailQuery(admin.email), { projection: { _id: 1 } })) {
    throw new Error('An account with this email already exists; no accounts were changed.');
  }

  const document = {
    name: admin.name,
    email: admin.email,
    password: await hashPasswordImpl(admin.password),
    role: 'admin',
  };
  const proposal = proposalFor({
    databaseName: config.databaseName,
    name: document.name,
    email: document.email,
  });
  displayProposal(proposal);

  if (!await confirm(proposal)) {
    return { created: false };
  }

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

  return { created: true, name: document.name, email: document.email, role: document.role };
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

async function readCredentials() {
  const name = await promptLine('Admin name: ');
  const email = await promptLine('Admin email: ');
  const password = await promptHidden('Admin password (input hidden): ');
  return validateCredentials({ name, email, password });
}

function displayProposal(proposal) {
  console.log('\nProposed operation:');
  console.log(JSON.stringify(proposal, null, 2));
  console.log(`\nType ${CONFIRMATION_PHRASE} to authorize this insertion.`);
}

async function confirmProposal() {
  const answer = await promptLine('Confirmation: ');
  return isConfirmation(answer);
}

function isConfirmation(answer) {
  return typeof answer === 'string' && answer.trim() === CONFIRMATION_PHRASE;
}

async function main() {
  require('dotenv').config({
    path: path.resolve(__dirname, '..', '.env'),
    quiet: true,
  });

  validateProvisioningConfig(process.env);
  getJwtConfig(process.env);
  const credentials = await readCredentials();

  try {
    const result = await setupDevAdmin({
      env: process.env,
      credentials,
      displayProposal,
      confirm: confirmProposal,
    });
    if (result.created) {
      console.log('Development administrator created in the isolated test database.');
    } else {
      console.log('No account was created; confirmation was not provided.');
    }
  } catch (error) {
    if (error.message === 'An account with this email already exists; no accounts were changed.') {
      throw error;
    }
    throw new Error('Development admin setup failed. Check the isolated MongoDB configuration and local service.');
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
  CONFIRMATION_PHRASE,
  findExistingEmailQuery,
  isConfirmation,
  proposalFor,
  setupDevAdmin,
};
