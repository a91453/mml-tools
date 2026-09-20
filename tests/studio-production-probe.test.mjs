import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceReport, expectedIdentity, loadProbeInputs, probeProduction, saveReport, serviceOrigin, verifyIdentity } from '../scripts/studio-production-probe.mjs';
import { WORKSPACE_ASSETS } from '../scripts/studio-container-smoke.mjs';

const main = '1'.repeat(40), manifestCommit = '2'.repeat(40), snapshot = '3'.repeat(40);
const manifest = `---\ncanonical_version: fixture-v1\ncanonical_status: PUBLISHED\nmanifest_version: fixture-manifest1\nrules_snapshot_sha: ${snapshot}\n---\n`;
const expected = expectedIdentity(manifest, main, manifestCommit);
const canonical = { ...expected, status: 'CANONICAL_LOADED', build_source_head: main, repository_head: main,
  checkout_identity: 'materialized-published-main', pr_head: null };
const origin = 'https://acceptance.invalid';
const expectedAssets = new Map(WORKSPACE_ASSETS.map(([, file]) => [file, Buffer.from('fixture-' + file)]));
const fixture = (overrides = {}) => async (url, options) => {
  assert.equal(options.redirect, 'manual');
  const path = new URL(url).pathname;
  if (path === '/healthz') return Response.json({ status: 'ok' });
  if (path === '/') return Response.json({ canonical: { ...canonical, ...overrides } });
  const asset = WORKSPACE_ASSETS.find(([route]) => route === path);
  if (asset) {
    if (options.method === 'POST') return new Response(null, { status: 405 });
    return new Response(options.method === 'HEAD' ? null : expectedAssets.get(asset[1]), { headers: {
      'content-type': asset[2], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "frame-ancestors 'none'",
    } });
  }
  if (['/studio', '/studio/index.html'].includes(path)) return new Response(null, { status: 302, headers: { location: '/studio/' } });
  if (path === '/studio/not-an-asset') return new Response(null, { status: 404 });
  if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: origin,
    authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', registration_endpoint: origin + '/oauth/register' });
  return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
};

test('public production assertions pass only for the selected Published identities', async () => {
  const report = await probeProduction({ origin, expected, expectedAssets, fetchImpl: fixture() });
  assert.equal(report.status, 'PASS'); assert.equal(report.assets.length, 4);
  assert.equal(report.canonical.rules_snapshot_sha, snapshot);
  assert.equal(acceptanceReport(origin).status, 'PENDING', 'public PASS does not promote full acceptance');
  assert.equal(acceptanceReport(origin).chatgpt_connector.status, 'NOT_RUN');
});

for (const field of ['canonical_version', 'manifest_version', 'rules_snapshot_sha', 'manifest_commit', 'published_main_head', 'build_source_head', 'repository_head', 'checkout_identity', 'pr_head']) {
  test('a healthy old/wrong deployment fails on ' + field, async () => {
    await assert.rejects(probeProduction({ origin, expected, expectedAssets, fetchImpl: fixture({ [field]: 'f'.repeat(40) }) }));
  });
}

test('missing or non-published Manifest never becomes an expectation', () => {
  for (const text of ['', manifest.replace('PUBLISHED', 'DRAFT'), manifest.replace(snapshot, 'main'),
    manifest.replace('---\ncanonical_version:', '---\ncanonical_version: duplicated\ncanonical_version:')]) {
    assert.throws(() => expectedIdentity(text, main, manifestCommit));
  }
  assert.throws(() => expectedIdentity(manifest, 'main', manifestCommit));
  assert.deepEqual(expectedIdentity(manifest.replaceAll('\n', '\r\n'), main, manifestCommit), expected);
  assert.throws(() => verifyIdentity({ ...canonical, build_source_head: undefined }, expected));
});

test('unsafe service origins fail before network access', async () => {
  for (const value of ['http://localhost', 'https://user:secret@example.com', origin + '/mcp', origin + '?token=x', origin + '#x']) {
    assert.throws(() => serviceOrigin(value));
    await assert.rejects(probeProduction({ origin: value, expected, expectedAssets, fetchImpl: () => assert.fail('network should not be called') }));
  }
});

test('evidence uses a fresh file and cannot silently overwrite an earlier run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'production-evidence-'));
  try {
    const file = join(dir, 'report.json'), report = acceptanceReport(origin);
    await saveReport(file, report);
    await assert.rejects(saveReport(file, { status: 'PASS' }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), report);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loader reads Published main assets and exact snapshot sources, with no working-tree fallback', async () => {
  const calls = [];
  const gitImpl = args => {
    calls.push(args);
    if (args[0] === 'merge-base') return Buffer.alloc(0);
    if (args[0] === 'log') return Buffer.from(manifestCommit + '\n');
    if (args[0] === 'cat-file') return Buffer.from('commit\n');
    if (args[1] === main + ':docs/CANONICAL_MANIFEST.md') return Buffer.from(manifest);
    if (args[1].startsWith(snapshot + ':docs/')) return Buffer.from('Version: fixture-v1\nStatus: '
      + (args[1].endsWith('OFFICIAL_EVIDENCE.md') ? 'CANONICAL SUPPORTING EVIDENCE' : 'PUBLISHED CANONICAL') + '\n');
    const file = args[1].split('/').at(-1);
    assert.equal(args[1], main + ':studio/web/service/' + file);
    return expectedAssets.get(file);
  };
  const result = await loadProbeInputs({ main, manifestCommit, gitImpl });
  assert.deepEqual(result.expected, expected); assert.deepEqual(result.expectedAssets, expectedAssets);
  assert.equal(calls.filter(args => args[0] === 'show' && args[1].startsWith(snapshot + ':')).length, 6);
  for (const failAt of ['merge-base', 'log', 'show', 'cat-file']) {
    await assert.rejects(loadProbeInputs({ main, manifestCommit, gitImpl: args => {
      if (args[0] === failAt) throw Error('history unavailable'); return gitImpl(args);
    } }), { code: 'CANONICAL_NOT_LOADED' });
  }
});
