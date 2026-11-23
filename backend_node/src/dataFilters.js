const LOCAL_DEMO_SEED_MARKER = 'smart-campus-local-demo-v1';
const REALISTIC_DEMO_SEED_MARKER = 'smart-campus-realistic-students-v1';
const TRUSTED_DEMO_SEED_MARKERS = new Set([
  LOCAL_DEMO_SEED_MARKER,
  REALISTIC_DEMO_SEED_MARKER,
]);

function trustedDemoMarkers(owner) {
  if (!owner) return [];
  return [owner.local_demo_seed, owner.demo_seed_key]
    .filter((marker) => TRUSTED_DEMO_SEED_MARKERS.has(marker));
}

function isTrustedDemoAccount(owner) {
  return trustedDemoMarkers(owner).length > 0;
}

function isTrustedDemoStudent(student) {
  return trustedDemoMarkers(student).length > 0;
}

function isTrustedDemoPair(account, student) {
  const accountMarkers = new Set(trustedDemoMarkers(account));
  return trustedDemoMarkers(student).some((marker) => accountMarkers.has(marker));
}

function trustedDemoFilter(owner) {
  const markers = trustedDemoMarkers(owner);
  if (markers.length === 0) {
    return { is_demo: { $ne: true }, synthetic_demo: { $ne: true } };
  }
  return {
    is_demo: true,
    synthetic_demo: true,
    $and: [{
      $or: [
        { demo_seed_key: { $in: markers } },
        { local_demo_seed: { $in: markers } },
      ],
    }],
  };
}

module.exports = {
  LOCAL_DEMO_SEED_MARKER,
  REALISTIC_DEMO_SEED_MARKER,
  TRUSTED_DEMO_SEED_MARKERS,
  isTrustedDemoAccount,
  isTrustedDemoStudent,
  isTrustedDemoPair,
  trustedDemoFilter,
};
