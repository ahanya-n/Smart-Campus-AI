const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTrustedDemoAccount,
  isTrustedDemoStudent,
  isTrustedDemoPair,
  trustedDemoFilter,
} = require('../src/dataFilters');

test('realistic demo marker is trusted for matching account and profile', () => {
  const marker = 'smart-campus-realistic-students-v1';
  const account = { role: 'student', student_id: '20252MCA0275', demo_seed_key: marker };
  const student = { student_id: '20252MCA0275', demo_seed_key: marker, is_demo: true };

  assert.equal(isTrustedDemoAccount(account), true);
  assert.equal(isTrustedDemoStudent(student), true);
  assert.equal(isTrustedDemoPair(account, student), true);
  assert.deepEqual(trustedDemoFilter(account), {
    is_demo: true,
    synthetic_demo: true,
    $and: [{
      $or: [
        { demo_seed_key: { $in: [marker] } },
        { local_demo_seed: { $in: [marker] } },
      ],
    }],
  });
});

test('unknown demo marker is not trusted', () => {
  const owner = { demo_seed_key: 'untrusted-custom-marker', is_demo: true };
  assert.equal(isTrustedDemoAccount(owner), false);
  assert.equal(isTrustedDemoStudent(owner), false);
  assert.deepEqual(trustedDemoFilter(owner), {
    is_demo: { $ne: true },
    synthetic_demo: { $ne: true },
  });
});
