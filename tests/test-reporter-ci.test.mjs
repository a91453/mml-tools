import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstLine } from '../scripts/test-reporter-ci.mjs';

const reporter = fileURLToPath(new URL('../scripts/test-reporter-ci.mjs', import.meta.url));
const run = async (files, env = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-reporter-'));
  try {
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    // Without NODE_TEST_CONTEXT the child is a runner of its own, not a subtest.
    const { GITHUB_ACTIONS, NODE_TEST_CONTEXT, ...base } = process.env;
    return spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, ...Object.keys(files)],
      { cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...base, ...env } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const header = "import test, { before, describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const failing = {
  'a.test.mjs': header + "test('passes', () => {});\ntest('outer', async t => { await t.test('inner fails', () => assert.equal(1, 2)); });\n",
  'b.test.mjs': header + "describe('suite', () => { it('deep fail', () => assert.ok(false, 'deep message')); });\ntest.todo('todo', () => { throw Error('not counted'); });\n",
  'c.test.mjs': "throw new Error('crashed while loading');\n",
};

test('failed tests are listed by file, line and full name after the TAP summary', async () => {
  const result = await run(failing);
  assert.equal(result.status, 1, result.stderr);
  const tail = result.stdout.slice(result.stdout.lastIndexOf('# duration_ms'));
  assert.match(tail, /# Failed tests \(3\):/);
  assert.match(tail, /#   a\.test\.mjs:4 › outer › inner fails — Expected values to be strictly equal:/);
  assert.match(tail, /#   b\.test\.mjs:3 › suite › deep fail — deep message/);
  assert.match(tail, /#   c\.test\.mjs:1 › c\.test\.mjs/);
  assert.doesNotMatch(tail, /› outer —|todo|passes/, 'parents of a failed subtest, todo and passing tests are not listed');
  assert.doesNotMatch(result.stdout, /^::error/m, 'annotations only under GitHub Actions');
});

test('under GitHub Actions each failure is also an error annotation', async () => {
  const result = await run(failing, { GITHUB_ACTIONS: 'true' });
  assert.match(result.stdout, /^::error file=a\.test\.mjs,line=4,title=Failed test%3A outer › inner fails::Expected values/m);
  assert.equal(result.stdout.match(/^::error /gm).length, 3);
});

test('a failing hook is listed once, not with every test it cancelled', async () => {
  const result = await run({ 'h.test.mjs': header + "describe('suite', () => {\n  before(() => { throw Error('hook broke'); });\n  it('one', () => {});\n  it('two', () => {});\n});\n" });
  assert.equal(result.status, 1, result.stderr);
  const tail = result.stdout.slice(result.stdout.lastIndexOf('# duration_ms'));
  assert.match(tail, /# Failed tests \(1\):\n#   h\.test\.mjs:3 › suite — hook broke/);
});

test('a passing run prints plain TAP and nothing after it', async () => {
  const result = await run({ 'a.test.mjs': header + "test('passes', () => {});\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^TAP version 13/);
  assert.match(result.stdout, /# duration_ms [\d.]+\n$/);
});

test('messages are one trimmed line', () => {
  assert.equal(firstLine(new Error('\n  first line  \nsecond')), 'first line');
  assert.equal(firstLine({ cause: new Error('from cause') }), 'from cause');
  assert.equal(firstLine(new Error('x'.repeat(500))).length, 200);
});

test('test:ci runs exactly the files npm test runs', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts['test:ci'], scripts.test.replace('node --test ', 'node --test --test-reporter=./scripts/test-reporter-ci.mjs '));
});
