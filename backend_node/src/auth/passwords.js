const argon2 = require('argon2');

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
  hashLength: 32,
  saltLength: 16,
});

const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$LW6tMLj0smIX0JuzPMDhvA$ohG+jAKl6MoalS7L4Rootr93i/yMW8TE1lJqC8JvJ24';
async function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPassword(password, encodedHash) {
  if (
    typeof encodedHash !== 'string' ||
    encodedHash.length > 256
  ) {
    return false;
  }

  const match = /^\$argon2id\$v=19\$(?<parameters>(?:m|t|p)=\d+,(?:m|t|p)=\d+,(?:m|t|p)=\d+)\$(?<salt>[A-Za-z0-9+/]+)\$(?<digest>[A-Za-z0-9+/]+)$/.exec(encodedHash);
  if (!match || match.groups.salt.length < 16 || match.groups.digest.length < 32) {
    return false;
  }

  const parameters = Object.fromEntries(
    match.groups.parameters.split(',').map((item) => {
      const [key, value] = item.split('=');
      return [key, Number(value)];
    }),
  );
  if (
    Object.keys(parameters).length !== 3 ||
    parameters.m < 8 ||
    parameters.m > 262144 ||
    parameters.t < 1 ||
    parameters.t > 10 ||
    parameters.p < 1 ||
    parameters.p > 16
  ) {
    return false;
  }

  try {
    return await argon2.verify(encodedHash, password, { type: argon2.argon2id });
  } catch (error) {
    if (error instanceof Error && error.name === 'Argon2Error') return false;
    throw error;
  }
}

async function performDummyVerification(password) {
  return verifyPassword(password, DUMMY_HASH);
}

module.exports = {
  ARGON2_OPTIONS,
  hashPassword,
  performDummyVerification,
  verifyPassword,
};
