const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { verifyPassword } = require('../src/auth/passwords');

const {
  isLocalMongoUri,
  promptHidden,
  provisionAdmin,
  validateCredentials,
  validateProvisioningConfig,
} = require('../scripts/provision-admin');

const TEST_ENV = {
  MONGO_URI: 'mongodb://127.0.0.1:27017',
  MONGO_DB_NAME: 'smart_campus_test',
};
const CREDENTIALS = {
  name: '  Campus Admin ',
  email: ' ADMIN@example.edu ',
  password: 'AdminPassword123',
};

function createUsersCollection(initialUsers = []) {
  const documents = [...initialUsers];
  return {
    documents,
    async countDocuments(filter) {
      return documents.filter((user) => user.role === filter.role).length;
    },
    async findOne(query) {
      const expression = query.email?.$regex;
      const regex = expression
        ? new RegExp(expression, query.email.$options)
        : null;
      return documents.find((user) =>
        regex ? regex.test(user.email) : (query.email?.$in || []).includes(user.email),
      ) || null;
    },
    async insertOne(document) {
      documents.push({ ...document, _id: 'test-id' });
      return { acknowledged: true, insertedId: 'test-id' };
    },
  };
}

test('allows only the isolated test database on a local MongoDB URI', () => {
  assert.deepEqual(
    {
      databaseName: validateProvisioningConfig(TEST_ENV).databaseName,
      localHostAccepted: isLocalMongoUri('mongodb://localhost:27017'),
      ipv6HostAccepted: isLocalMongoUri('mongodb://[::1]:27017'),
    },
    {
      databaseName: 'smart_campus_test',
      localHostAccepted: true,
      ipv6HostAccepted: true,
    },
  );
  assert.equal(isLocalMongoUri('mongodb+srv://localhost/example'), false);
  assert.equal(isLocalMongoUri('mongodb://db.example.com:27017'), false);
  assert.equal(isLocalMongoUri('mongodb://localhost:27017,remote.example:27017'), false);
  assert.throws(
    () => validateProvisioningConfig({ ...TEST_ENV, MONGO_DB_NAME: 'smart_campus' }),
    /Refusing to use the existing production database/,
  );
  assert.throws(
    () => validateProvisioningConfig({ ...TEST_ENV, MONGO_URI: 'mongodb://remote:27017' }),
    /only with a local MongoDB URI/,
  );
});

test('refuses unsafe databases before requesting a MongoDB collection', async () => {
  let collectionRequested = false;
  await assert.rejects(
    provisionAdmin({
      env: { ...TEST_ENV, MONGO_DB_NAME: 'smart_campus' },
      credentials: CREDENTIALS,
      getUsersCollection: async () => {
        collectionRequested = true;
        return createUsersCollection();
      },
      hashPasswordImpl: async () => 'unused',
    }),
    /Refusing to use the existing production database/,
  );
  assert.equal(collectionRequested, false);
});

test('validates account fields without altering the password', () => {
  assert.deepEqual(validateCredentials(CREDENTIALS), {
    name: 'Campus Admin',
    email: 'admin@example.edu',
    password: CREDENTIALS.password,
  });
  assert.throws(
    () => validateCredentials({ ...CREDENTIALS, password: 'short' }),
    /8 to 128 characters/,
  );
  assert.throws(
    () => validateCredentials({ ...CREDENTIALS, password: 'x'.repeat(129) }),
    /8 to 128 characters/,
  );
});

test('hidden terminal prompt reads the submitted password without echoing it', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  const outputWrites = [];
  const output = {
    isTTY: true,
    write(value) {
      outputWrites.push(value);
    },
  };
  const enteredPassword = '12345678';

  const password = await promptHidden('Password: ', {
    input,
    output,
    createInterface(options) {
      assert.equal(options.input, input);
      assert.equal(options.terminal, true);
      assert.equal(options.output.isTTY, true);
      options.output.write(enteredPassword);
      const terminal = new EventEmitter();
      terminal.close = () => terminal.emit('close');
      setImmediate(() => terminal.emit('line', enteredPassword));
      return terminal;
    },
  });

  assert.equal(password, enteredPassword);
  assert.deepEqual(outputWrites, ['Password: ', '\n']);
  assert.equal(validateCredentials({ ...CREDENTIALS, password }).password, enteredPassword);
});

test('hidden terminal prompt rejects non-interactive input without reading a password', () => {
  assert.throws(
    () => promptHidden('Password: ', {
      input: { isTTY: false },
      output: { isTTY: false },
    }),
    /Set ADMIN_PASSWORD in the environment/,
  );
});

test('creates the expected admin schema with the existing password hasher', async () => {
  const users = createUsersCollection();
  const result = await provisionAdmin({
    env: TEST_ENV,
    credentials: CREDENTIALS,
    getUsersCollection: async () => users,
  });

  assert.deepEqual(result, { name: 'Campus Admin', role: 'admin' });
  assert.equal(users.documents.length, 1);
  assert.deepEqual({ ...users.documents[0], password: undefined }, {
    name: 'Campus Admin',
    email: 'admin@example.edu',
    password: undefined,
    role: 'admin',
    _id: 'test-id',
  });
  assert.match(users.documents[0].password, /^\$argon2id\$/);
  assert.equal(
    await verifyPassword(CREDENTIALS.password, users.documents[0].password),
    true,
  );
});

test('refuses provisioning when an administrator already exists', async () => {
  const users = createUsersCollection([{ email: 'existing-admin@example.edu', role: 'admin' }]);
  await assert.rejects(
    provisionAdmin({
      env: TEST_ENV,
      credentials: CREDENTIALS,
      getUsersCollection: async () => users,
      hashPasswordImpl: async () => 'unused',
    }),
    /administrator already exists/,
  );
  assert.equal(users.documents.length, 1);
});

test('refuses to overwrite or promote an existing account', async () => {
  const existing = {
    name: 'Existing Student',
    email: 'ADMIN@Example.edu',
    password: 'existing-hash',
    role: 'student',
    student_id: 'MCA123',
  };
  const users = createUsersCollection([existing]);
  await assert.rejects(
    provisionAdmin({
      env: TEST_ENV,
      credentials: CREDENTIALS,
      getUsersCollection: async () => users,
      hashPasswordImpl: async () => 'unused',
    }),
    /account with this email already exists/,
  );
  assert.equal(users.documents.length, 1);
  assert.equal(users.documents[0].role, 'student');
  assert.equal(users.documents[0].student_id, 'MCA123');
});

test('handles a concurrent duplicate email without overwriting users', async () => {
  const users = createUsersCollection();
  users.insertOne = async () => {
    const error = new Error('private duplicate index information');
    error.code = 11000;
    throw error;
  };
  await assert.rejects(
    provisionAdmin({
      env: TEST_ENV,
      credentials: CREDENTIALS,
      getUsersCollection: async () => users,
      hashPasswordImpl: async () => 'test-hash',
    }),
    /account with this email already exists/,
  );
  assert.equal(users.documents.length, 0);
});
