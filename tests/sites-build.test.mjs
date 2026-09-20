import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
let directory, bundle;
const files = ['README.md', 'package.json', '.gitignore', '.dockerignore', '.openai/hosting.json',
  'dist/index.html', 'dist/style.css', 'dist/core.js', 'dist/player.js', 'dist/app.js',
  'server/mcp.mjs', 'server/worker.mjs', 'scripts/build.mjs',
  'tests/core.test.mjs', 'tests/player.test.mjs', 'tests/mcp.test.mjs', 'tests/railway.test.mjs',
  'railway/service-settings.json', 'railway/Dockerfile', 'railway/auth.mjs', 'railway/server.mjs',
  'railway/README.md', 'railway/deployment-target.json',
  'studio/backend/application/contracts.mjs', 'studio/backend/application/technical-service.mjs'];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mml-sites-build-'));
  for (const file of files) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await cp(join(root, file), join(directory, file));
  }
  // Allows running this regression against the old build before the fix exists.
  try { await cp(join(root, 'scripts/bundle-sites-worker.mjs'), join(directory, 'scripts/bundle-sites-worker.mjs')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: directory });
  bundle = await readFile(join(directory, 'dist/server/index.js'), 'utf8');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
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
  assert.match(info.result.structuredContent.binary_data_plane, /CANONICAL_NOT_LOADED/);
});

test('the generated artifact retains input-schema and request-size guards', async () => {
  const worker = (await load()).default;
  const reply = await (await worker.fetch(request('tools/call', { name: 'mml_validate', arguments: { mml: 'MML@t120o4c1,,,,,;' } }))).json();
  assert.equal(reply.error.code, -32602);
  assert.equal((await worker.fetch(request('ping', null, { 'content-length': '131073' }))).status, 413);
  const post = new Request('https://sites.example/', { method: 'POST' });
  assert.equal((await worker.fetch(post)).status, 405);
});

test('the build rejects a new unmapped module import rather than shipping another broken artifact', async () => {
  await appendFile(join(directory, 'server/mcp.mjs'), "\nimport { readFileSync } from 'node:fs';\n");
  assert.throws(() => execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: directory, stdio: 'pipe' }), /Command failed/);
});
