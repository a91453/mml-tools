import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_CONFIRMATION,
  MUTABLE_SERVICE_FIELDS,
  mutableUpdateInput,
} from '../scripts/railway-production-config-apply.mjs';

const expected = {
  config: {
    startCommand: 'node railway/server.mjs',
    healthcheckPath: '/healthz',
    healthcheckTimeout: 60,
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 3,
    rootDirectory: '.',
    dockerfilePath: 'railway/Dockerfile',
    watchPatterns: ['/a', '/b'],
    numReplicas: 1,
  },
};

test('config apply confirmation remains an explicit fixed phrase', () => {
  assert.equal(APPLY_CONFIRMATION, 'APPLY_REPOSITORY_DESIRED_STATE');
});

test('mutable Railway field allowlist excludes destructive and scaling concerns', () => {
  const fields = new Set(MUTABLE_SERVICE_FIELDS);
  for (const forbidden of ['variables', 'domains', 'volume', 'source', 'repo', 'branch', 'numReplicas', 'region']) {
    assert.equal(fields.has(forbidden), false);
  }
});

test('mutable update input contains only fields that actually drift', () => {
  assert.deepEqual(mutableUpdateInput(expected, [
    { field: 'watchPatterns', expected: ['/a', '/b'], actual: ['/a'] },
    { field: 'healthcheckPath', expected: '/healthz', actual: '/health' },
  ]), {
    watchPatterns: ['/a', '/b'],
    healthcheckPath: '/healthz',
  });
});

test('unsupported drift fails closed instead of silently changing scaling', () => {
  assert.throws(
    () => mutableUpdateInput(expected, [{ field: 'numReplicas', expected: 1, actual: 2 }]),
    /unsupported Railway drift/,
  );
});
