// Production transport evidence only. Never a song or in-game acceptance gate.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyService, WORKSPACE_ASSETS } from './studio-container-smoke.mjs';

export function serviceOrigin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash, 'an explicit HTTPS origin is required');
  return url.origin;
}

export function expectedIdentity(manifest, main, manifestCommit) {
  assert.match(main ?? '', /^[0-9a-f]{40}$/, 'full Published main SHA required');
  assert.match(manifestCommit ?? '', /^[0-9a-f]{40}$/, 'full Manifest commit SHA required');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(manifest)?.[1];
  assert.ok(header, 'Published Manifest front matter required');
  const expected = {};
  for (const field of ['canonical_version', 'canonical_status', 'manifest_version', 'rules_snapshot_sha']) {
    const matches = [...header.replace(/\r/g, '').matchAll(new RegExp('^' + field + ': ([^\\r\\n]+)$', 'gm'))];
    assert.equal(matches.length, 1, 'unique Manifest field: ' + field);
    expected[field] = matches[0][1];
  }
  assert.equal(expected.canonical_status, 'PUBLISHED');
  assert.match(expected.rules_snapshot_sha, /^[0-9a-f]{40}$/);
  return { ...expected, manifest_commit: manifestCommit, published_main_head: main };
}

export function verifyIdentity(canonical, expected) {
  for (const [field, value] of Object.entries(expected)) assert.equal(canonical[field], value, 'deployment identity: ' + field);
  assert.equal(canonical.build_source_head, expected.published_main_head, 'build source must match selected Published main');
  assert.equal(canonical.repository_head, expected.published_main_head, 'materialized repository identity');
  assert.equal(canonical.checkout_identity, 'materialized-published-main');
  assert.equal(canonical.pr_head, null, 'production must not report a PR head');
}

export async function probeProduction({ origin, expected, expectedAssets, fetchImpl = fetch }) {
  origin = serviceOrigin(origin);
  const result = await verifyService({ baseURL: origin, expectedOrigin: origin, expectedAssets, fetchImpl, timeoutMs: 30000 });
  verifyIdentity(result.canonical, expected);
  return { status: 'PASS', observed_at: new Date().toISOString(), service_origin: origin, expected,
    ...result, provenance_evidence: 'HTTPS service self-report plus source asset hashes; not independent Railway control-plane evidence' };
}

export async function loadProbeInputs({ main, manifestCommit }) {
  const manifest = await readFile(new URL('../docs/CANONICAL_MANIFEST.md', import.meta.url), 'utf8');
  return { expected: expectedIdentity(manifest, main, manifestCommit),
    expectedAssets: new Map(await Promise.all(WORKSPACE_ASSETS.map(async ([, file]) =>
      [file, await readFile(new URL('../studio/web/service/' + file, import.meta.url))]))) };
}

export function acceptanceReport(origin) {
  return { schema_version: 1, status: 'PENDING', service_origin: serviceOrigin(origin),
    scope: 'Production service transport; not song quality or in-game acceptance',
    public_probe: { status: 'NOT_RUN' }, browser_mcp: { status: 'NOT_RUN' },
    chatgpt_connector: { status: 'NOT_RUN' }, real_song: { status: 'NOT_RUN' }, in_game: { status: 'NOT_RUN' } };
}

export async function saveReport(path, report) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  // Exclusive creation prevents accidental evidence replacement on reruns.
  await writeFile(resolve(path), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, 'expected-main': { type: 'string' },
    'manifest-commit': { type: 'string' }, out: { type: 'string' } } });
  if (!values.out) throw Error('--out is required (use a new evidence filename)');
  const report = acceptanceReport(values.origin);
  try {
    const inputs = await loadProbeInputs({ main: values['expected-main'], manifestCommit: values['manifest-commit'] });
    report.public_probe = await probeProduction({ origin: values.origin, ...inputs });
  } catch {
    // Never copy response bodies, URLs with secrets, or arbitrary errors to evidence.
    report.status = 'FAIL'; report.public_probe = { status: 'FAIL', reason: 'PUBLIC_PROBE_FAILED' };
  }
  await saveReport(values.out, report);
  console.log(JSON.stringify({ status: report.status, public_probe: report.public_probe.status,
    browser_mcp: report.browser_mcp.status }));
  // 2 means incomplete acceptance, even when all public checks pass.
  process.exitCode = report.status === 'FAIL' ? 1 : 2;
}
