// Railway production has "Wait for CI" enabled: a deployment stays WAITING
// until every GitHub Actions workflow on its commit has finished. A workflow on
// that commit which waits on the deployment is one of the checks Railway waits
// for, and the two deadlock. Observed 2026-09-22 on main 37ddf414: the
// deployment stayed WAITING for 14 minutes while a dispatched production audit
// polled it; it deployed only after the audit was cancelled.
//
// These checks pin the orchestration order:
//   merge -> main CI -> Wait for CI releases -> BUILDING/DEPLOYING -> audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');
const AUDIT = '.github/workflows/railway-production-audit.yml';

// Code only: drop comment lines so documentation cannot satisfy or break a check.
const code = yaml => yaml.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');

// The text of one top-level block (`on:`) or one job under `jobs:`.
function block(yaml, header, indent) {
  const lines = code(yaml).split('\n');
  const start = lines.findIndex(line => line === `${' '.repeat(indent)}${header}:` || line.startsWith(`${' '.repeat(indent)}${header}: `));
  assert.ok(start >= 0, `${header} block exists`);
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

test('the production audit is never a push or pull_request check', () => {
  const on = block(read(AUDIT), 'on', 0);
  assert.doesNotMatch(on, /^\s{2}(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(on, /^\s{2}workflow_dispatch:/m);
  assert.match(on, /^\s{2}deployment_status:/m);
});

test('anything that waits on Railway runs only after a non-waiting gate releases it', () => {
  const yaml = read(AUDIT);
  const gate = block(yaml, 'gate', 2);
  const audit = block(yaml, 'audit', 2);
  assert.match(gate, /railway-production-audit\.mjs --gate/);
  assert.doesNotMatch(gate, /--wait-seconds/, 'the gate never waits');
  assert.match(gate, /timeout-minutes:\s*5\b/);
  assert.match(audit, /^\s{4}needs:\s*gate\s*$/m);
  assert.match(audit, /^\s{4}if:\s*needs\.gate\.outputs\.released == 'true'\s*$/m);
  assert.match(audit, /--wait-seconds/);
  // Only the released audit job may call the waiting audit.
  const waitingCalls = code(yaml).match(/railway-production-audit\.mjs(?! --gate)/g) ?? [];
  assert.equal(waitingCalls.length, 1);
});

test('automatic audits start only from Railway\'s own terminal production status', () => {
  const gate = block(read(AUDIT), 'gate', 2);
  const condition = gate.slice(0, gate.indexOf('runs-on:'));
  assert.match(condition, /github\.event\.deployment\.environment == 'mml-tools-allen \/ production'/);
  assert.match(condition, /github\.event\.deployment\.creator\.login == 'railway-app\[bot\]'/);
  // Railway posts in_progress while the deployment is still WAITING; the deploy
  // workflow's own GitHub "production" environment reports success right after
  // it only *requests* a deployment. Neither may start an audit.
  assert.doesNotMatch(condition, /in_progress|queued|pending/);
  for (const state of ['success', 'failure', 'error']) {
    assert.match(condition, new RegExp(`deployment_status\\.state == '${state}'`));
  }
});

test('ignored deployment events cannot cancel a real audit', () => {
  const group = code(read(AUDIT)).match(/^\s{2}group:\s*(.+)$/m);
  assert.ok(group, 'concurrency group');
  assert.match(group[1], /'production' \|\| github\.run_id/);
});

test('no Wait-for-CI participant waits on or triggers the production audit', () => {
  const dir = resolve(root, '.github/workflows');
  for (const name of readdirSync(dir).filter(file => file.endsWith('.yml'))) {
    if (`.github/workflows/${name}` === AUDIT) continue;
    // Path filters that merely list the audit files (to run its unit tests) are fine.
    const yaml = code(read(`.github/workflows/${name}`));
    assert.doesNotMatch(yaml, /node\s+scripts\/railway-production-audit\.mjs|workflow\s+run\s+railway-production-audit|workflows\/railway-production-audit\.yml\/dispatches|uses:\s*\.\/\.github\/workflows\/railway-production-audit/, `${name} must not run or dispatch the waiting audit`);
  }
  // The deploy request itself must return immediately; Railway and the audit own the waiting.
  assert.doesNotMatch(code(read('.github/workflows/railway-production-deploy.yml')), /--wait|sleep|until /);
});
