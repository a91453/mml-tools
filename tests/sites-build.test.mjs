import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, appendFile, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { PROFILE as LEGACY_PROFILE } from '../dist/core.js';
import { WORKBENCH_SOURCE_FILES, WORKBENCH_SOURCE_ZIP } from '../scripts/workbench-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = [];
let directory, bundle, archive;
const scratch = async prefix => { const dir = await mkdtemp(join(tmpdir(), prefix)); directories.push(dir); return dir; };
// A fresh checkout as far as the build can tell: the declared inputs and
// nothing else -- in particular no previously built archive.
async function declaredInputs(prefix) {
  const dir = await scratch(prefix);
  for (const file of WORKBENCH_SOURCE_FILES) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(join(root, file), join(dir, file));
  }
  return dir;
}
const build = (cwd, env = {}) => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd, stdio: 'pipe', env: { ...process.env, ...env } });
const entryNames = zip => execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
const entryBytes = (zip, name) => execFileSync('unzip', ['-p', zip, name], { maxBuffer: 4 * 1024 * 1024 });
async function extracted(zip, prefix) {
  const dir = await scratch(prefix);
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  return dir;
}
before(async () => {
  directory = await declaredInputs('mml-sites-build-');
  assert.equal(existsSync(join(directory, WORKBENCH_SOURCE_ZIP)), false, 'precondition: no archive exists before the build');
  build(directory);
  bundle = await readFile(join(directory, 'dist/server/index.js'), 'utf8');
  archive = await readFile(join(directory, WORKBENCH_SOURCE_ZIP));
});
after(async () => { for (const dir of directories) await rm(dir, { recursive: true, force: true }); });
const load = () => import('data:text/javascript;base64,' + Buffer.from(bundle).toString('base64'));
const request = (method, params, extra = {}) => new Request('https://sites.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'oai-authenticated-user-id': 'synthetic', ...extra },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
});

test('the generated Sites Worker loads as a single isolated module, not just as concatenated text', async () => {
  const module = await load();
  assert.equal(typeof module.default.fetch, 'function');
});

test('the actual Sites artifact preserves static assets, health and gateway authentication', async () => {
  const worker = (await load()).default;
  assert.equal(await (await worker.fetch(new Request('https://sites.example/'))).text(), await readFile(join(root, 'dist/index.html'), 'utf8'));
  assert.equal((await worker.fetch(new Request('https://sites.example/healthz'))).status, 200);
  const unauthenticated = request('tools/list');
  unauthenticated.headers.delete('oai-authenticated-user-id');
  assert.equal((await worker.fetch(unauthenticated)).status, 401);
  const tools = await (await worker.fetch(request('tools/list'))).json();
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ['mml_service_info', 'mml_validate', 'mml_overlap_details']);
  assert.equal((await worker.fetch(request('tools/list', null, { origin: 'https://evil.example' }))).status, 403);
});

test('a Sites artifact without published Git history refuses Canonical work instead of falling back', async () => {
  const worker = (await load()).default;
  for (const name of ['mml_validate', 'mml_overlap_details']) {
    const reply = await (await worker.fetch(request('tools/call', { name, arguments: { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' } }))).json();
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.structuredContent.error.code, 'CANONICAL_NOT_LOADED');
    assert.equal(reply.result.structuredContent.error.details.legacy_fallback_allowed, false);
    assert.equal(reply.result.structuredContent.technical_ok, undefined);
  }
  const info = await (await worker.fetch(request('tools/call', { name: 'mml_service_info', arguments: {} }))).json();
  assert.equal(info.result.isError, false, 'service info keeps answering without Canonical');
  const described = info.result.structuredContent;
  assert.match(described.binary_data_plane, /CANONICAL_NOT_LOADED/);
  // It says Canonical is not loaded rather than naming the legacy profile as
  // the one the two refused tools would have answered under.
  assert.equal(described.profile, null);
  assert.equal(described.canonical_validation, 'CANONICAL_NOT_LOADED');
  assert.equal(described.canonical_release.status, 'CANONICAL_NOT_LOADED');
  assert.match(described.profile_notice, /CANONICAL_NOT_LOADED/);
  assert.equal(described.legacy_profile, LEGACY_PROFILE);
  assert.equal(described.core_version, undefined);
});

test('the generated artifact retains input-schema and request-size guards', async () => {
  const worker = (await load()).default;
  const reply = await (await worker.fetch(request('tools/call', { name: 'mml_validate', arguments: { mml: 'MML@t120o4c1,,,,,;' } }))).json();
  assert.equal(reply.error.code, -32602);
  assert.equal((await worker.fetch(request('ping', null, { 'content-length': '131073' }))).status, 413);
  const post = new Request('https://sites.example/', { method: 'POST' });
  assert.equal((await worker.fetch(post)).status, 405);
});

// ─── the legacy source archive is a build output (roadmap G12) ──────────────

test('Git tracks no build output: the source archive and the Worker bundle are ignored and untracked', () => {
  // A committed copy of the archive drifted from its inputs (23 entries against
  // the 26 the build wrote). With no committed copy there is nothing to drift.
  for (const output of [WORKBENCH_SOURCE_ZIP, 'dist/server/index.js', 'dist/.openai/hosting.json']) {
    assert.equal(execFileSync('git', ['ls-files', '--', output], { cwd: root, encoding: 'utf8' }), '', `${output} must not be tracked`);
    assert.equal(spawnSync('git', ['check-ignore', '-q', '--no-index', output], { cwd: root }).status, 0, `${output} must be ignored`);
  }
});

test('a clean build writes the archive with exactly the declared inputs, byte for byte', async () => {
  assert.deepEqual(entryNames(join(directory, WORKBENCH_SOURCE_ZIP)), [...WORKBENCH_SOURCE_FILES]);
  for (const file of WORKBENCH_SOURCE_FILES) {
    assert.ok(entryBytes(join(directory, WORKBENCH_SOURCE_ZIP), file).equals(await readFile(join(root, file))), `${file} differs from its source`);
  }
});

test('the archive rebuilds itself byte for byte from nothing but its own entries', async () => {
  // Every file the build reads is therefore declared: an undeclared one would be
  // missing here and the build, or the byte comparison, would fail.
  const rebuilt = await extracted(join(directory, WORKBENCH_SOURCE_ZIP), 'mml-sites-rebuild-');
  build(rebuilt);
  assert.ok((await readFile(join(rebuilt, WORKBENCH_SOURCE_ZIP))).equals(archive), 'the rebuilt archive differs');
  assert.equal(await readFile(join(rebuilt, 'dist/server/index.js'), 'utf8'), bundle, 'the rebuilt Worker bundle differs');
});

test('a file the build reads that the archive does not declare is caught by the self-rebuild', async () => {
  // Negative control for the test above: the build grows a new input, present
  // in the checkout but not added to WORKBENCH_SOURCE_FILES.
  const grown = await declaredInputs('mml-sites-grown-');
  await writeFile(join(grown, 'scripts/extra-input.mjs'), 'export const extra = 1;\n');
  await appendFile(join(grown, 'scripts/build.mjs'), "\nawait import('./extra-input.mjs');\n");
  build(grown);
  const rebuilt = await extracted(join(grown, WORKBENCH_SOURCE_ZIP), 'mml-sites-grown-rebuild-');
  assert.equal(existsSync(join(rebuilt, 'scripts/extra-input.mjs')), false);
  assert.throws(() => build(rebuilt), /Command failed/);
});

test('the archive depends on its inputs\' bytes only, not on checkout time, file mode or time zone', async () => {
  const again = await declaredInputs('mml-sites-again-');
  for (const file of WORKBENCH_SOURCE_FILES) {
    await chmod(join(again, file), 0o664);
    await utimes(join(again, file), new Date('2031-05-06T07:08:09Z'), new Date('2031-05-06T07:08:09Z'));
  }
  build(again, { TZ: 'Pacific/Kiritimati' });
  assert.ok((await readFile(join(again, WORKBENCH_SOURCE_ZIP))).equals(archive));
});

test('the Worker serves the built archive at the download link the page offers', async () => {
  assert.match(await readFile(join(root, 'dist/index.html'), 'utf8'), /<a id="source-download" href="\.\/workbench-source\.zip" download>/);
  const worker = (await load()).default;
  const response = await worker.fetch(new Request('https://sites.example/workbench-source.zip'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(archive));
});

test('the build rejects a new unmapped module import rather than shipping another broken artifact', async () => {
  await appendFile(join(directory, 'server/mcp.mjs'), "\nimport { readFileSync } from 'node:fs';\n");
  assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: directory, stdio: 'pipe' }), /Command failed/);
});
