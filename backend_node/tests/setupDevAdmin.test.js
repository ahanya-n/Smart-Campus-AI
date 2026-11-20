const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyPassword } = require('../src/auth/passwords');
const {
  CONFIRMATION_PHRASE,
  isConfirmation,
  setupDevAdmin,
} = require('../scripts/setup-dev-admin');

const ENV = {
  MONGO_URI: 'mongodb://127.0.0.1:27017',
  MONGO_DB_NAME: 'smart_campus_test',
};
const CREDENTIALS = {
  name: 'Local Developer',
  email: '  DEV@example.edu ',
  password: 'LocalAdminPassword123',
};

function makeCollection(initialUsers = []) {
  const documents = [...initialUsers];
  return {
    documents,
    async findOne(query) {
      const regex = new RegExp(query.email.$regex, query.email.$options);
      return documents.find((user) => regex.test(user.email)) || null;
    },
    async insertOne(document) {
      documents.push(document);
      return { acknowledged: true };
    },
  };
}

test('inserts only a new admin after displaying a redacted proposal and explicit confirmation', async () => {
  const users = makeCollection();
  const events = [];
  const result = await setupDevAdmin({
    env: ENV,
    credentials: CREDENTIALS,
    getUsersCollection: async () => users,
    displayProposal(proposal) {
      events.push('proposal');
      assert.deepEqual(proposal, {
        database: 'smart_campus_test',
        mongo_host: 'local MongoDB',
        operation: 'insert one new user document',
        user: {
          name: 'Local Developer',
          email: 'dev@example.edu',
          role: 'admin',
        },
      });
      assert.equal(JSON.stringify(proposal).includes(CREDENTIALS.password), false);
      assert.equal(JSON.stringify(proposal).includes(ENV.MONGO_URI), false);
    },
    async confirm() {
      events.push('confirmation');
      return true;
    },
  });

  assert.deepEqual(events, ['proposal', 'confirmation']);
  assert.deepEqual(result, {
    created: true,
    name: 'Local Developer',
    email: 'dev@example.edu',
    role: 'admin',
  });
  assert.equal(users.documents.length, 1);
  assert.deepEqual({
    name: users.documents[0].name,
    email: users.documents[0].email,
    role: users.documents[0].role,
  }, {
    name: 'Local Developer',
    email: 'dev@example.edu',
    role: 'admin',
  });
  assert.match(users.documents[0].password, /^\$argon2id\$/);
  assert.equal(
    await verifyPassword(CREDENTIALS.password, users.documents[0].password),
    true,
  );
});

test('does not insert when explicit confirmation is declined', async () => {
  const users = makeCollection();
  let proposalDisplayed = false;
  const result = await setupDevAdmin({
    env: ENV,
    credentials: CREDENTIALS,
    getUsersCollection: async () => users,
    displayProposal() {
      proposalDisplayed = true;
    },
    confirm: async () => false,
  });

  assert.equal(proposalDisplayed, true);
  assert.deepEqual(result, { created: false });
  assert.equal(users.documents.length, 0);
});

test('stops without modifying an existing account with a case-insensitive email match', async () => {
  const existing = {
    name: 'Existing Faculty',
    email: 'Dev@Example.edu',
    password: 'existing-hash',
    role: 'faculty',
    assigned_subject_codes: ['CS101'],
  };
  const users = makeCollection([existing]);
  let proposalDisplayed = false;
  await assert.rejects(
    setupDevAdmin({
      env: ENV,
      credentials: CREDENTIALS,
      getUsersCollection: async () => users,
      displayProposal() {
        proposalDisplayed = true;
      },
      confirm: async () => true,
    }),
    /account with this email already exists/,
  );
  assert.equal(proposalDisplayed, false);
  assert.equal(users.documents.length, 1);
  assert.deepEqual(users.documents[0], existing);
});

test('rejects unsafe database targets before obtaining the collection', async () => {
  for (const env of [
    { ...ENV, MONGO_DB_NAME: 'smart_campus' },
    { ...ENV, MONGO_URI: 'mongodb://remote.example:27017' },
    { ...ENV, MONGO_URI: 'mongodb://localhost:27017,remote.example:27017' },
  ]) {
    let collectionRequested = false;
    await assert.rejects(
      setupDevAdmin({
        env,
        credentials: CREDENTIALS,
        getUsersCollection: async () => {
          collectionRequested = true;
          return makeCollection();
        },
        confirm: async () => true,
      }),
    );
    assert.equal(collectionRequested, false);
  }
});

test('handles an email uniqueness race without changing other records', async () => {
  const users = makeCollection();
  users.insertOne = async () => {
    const error = new Error('private duplicate index details');
    error.code = 11000;
    throw error;
  };
  await assert.rejects(
    setupDevAdmin({
      env: ENV,
      credentials: CREDENTIALS,
      getUsersCollection: async () => users,
      confirm: async () => true,
    }),
    /account with this email already exists/,
  );
  assert.equal(users.documents.length, 0);
});

test('uses the expected exact confirmation phrase', () => {
  assert.equal(CONFIRMATION_PHRASE, 'CREATE ADMIN');
  assert.equal(isConfirmation('CREATE ADMIN'), true);
  assert.equal(isConfirmation(' CREATE ADMIN '), true);
  assert.equal(isConfirmation('create admin'), false);
  assert.equal(isConfirmation('yes'), false);
});
