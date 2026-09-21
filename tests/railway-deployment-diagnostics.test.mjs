import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeLogMessage,
  sanitizeLogs,
  selectDeployment,
} from '../scripts/railway-deployment-diagnostics.mjs';

const FAILED_ID = '11111111-2222-3333-4444-555555555555';
const SUCCESS_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('diagnostic log sanitizer removes common credential shapes and flattens lines', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    ' MML_OWNER_PASSWORD=super-secret',
    ' url=https://user:pass@example.test/path',
    ' token=railway_abcdefghijklmnopqrstuvwxyz',
    ' github_pat_abcdefghijklmnopqrstuvwxyz123456',
  ].join('\n');
  const output = sanitizeLogMessage(input);
  assert.doesNotMatch(output, /abc\.def\.ghi/);
  assert.doesNotMatch(output, /super-secret/);
  assert.doesNotMatch(output, /user:pass/);
  assert.doesNotMatch(output, /railway_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(output, /github_pat_/);
  assert.doesNotMatch(output, /[\r\n]/);
  assert.match(output, /\[REDACTED\]/);
});

test('diagnostic log sanitizer is bounded', () => {
  assert.equal(sanitizeLogMessage('x'.repeat(3000)).length, 2000);
  const entries = Array.from({ length: 250 }, (_, i) => ({
    timestamp: String(i), severity: 'info', message: 'line ' + i,
  }));
  assert.equal(sanitizeLogs(entries).length, 200);
});

test('diagnostics accept only a failed or crashed deployment in the selected service history', () => {
  const deployments = [
    { id: FAILED_ID, status: 'FAILED' },
    { id: SUCCESS_ID, status: 'SUCCESS' },
  ];
  assert.equal(selectDeployment(deployments, FAILED_ID).status, 'FAILED');
  assert.throws(() => selectDeployment(deployments, SUCCESS_ID), /FAILED\/CRASHED/);
  assert.throws(
    () => selectDeployment(deployments, '99999999-2222-3333-4444-555555555555'),
    /configured production service history/,
  );
  assert.throws(() => selectDeployment(deployments, 'not-an-id'), /valid Railway deployment UUID/);
});
