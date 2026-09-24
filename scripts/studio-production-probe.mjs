// Production transport evidence only. Never a song or in-game acceptance gate.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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

// The image captures published main with `git ls-remote` when it is BUILT, not
// the commit Railway built it from. When a merge that touches no watched path
// lands between a watched merge and its build (Wait for CI delays the build by
// minutes), the image reports that later main as published_main_head while its
// build_source_head is the audited commit, and no audit could pass until the
// next watched merge rebuilt it. A later published main is therefore accepted
// when `laterMain` confirms it descends from the audited one; the build source
// must still be the audited commit, and every Manifest identity (version,
// status, snapshot, Manifest commit) must still match, so a Canonical release
// in between still fails.
export function verifyIdentity(canonical, expected, { laterMain = () => false } = {}) {
  const { published_main_head: main, ...pinned } = expected;
  for (const [field, value] of Object.entries(pinned)) assert.equal(canonical[field], value, 'deployment identity: ' + field);
  assert.equal(canonical.build_source_head, main, 'build source must match selected Published main');
  if (canonical.published_main_head !== main) {
    assert.ok(/^[0-9a-f]{40}$/.test(canonical.published_main_head ?? '') && laterMain(canonical.published_main_head) === true,
      'deployment identity: published_main_head');
  }
  assert.equal(canonical.repository_head, canonical.published_main_head, 'materialized repository identity');
  assert.equal(canonical.checkout_identity, 'materialized-published-main');
  assert.equal(canonical.pr_head, null, 'production must not report a PR head');
}

export async function probeProduction({ origin, expected, expectedAssets, laterMain, fetchImpl = fetch }) {
  origin = serviceOrigin(origin);
  const result = await verifyService({ baseURL: origin, expectedOrigin: origin, expectedAssets, fetchImpl, timeoutMs: 30000 });
  verifyIdentity(result.canonical, expected, { laterMain });
  return { status: 'PASS', observed_at: new Date().toISOString(), service_origin: origin, expected,
    ...result, provenance_evidence: 'HTTPS service self-report plus source asset hashes; not independent Railway control-plane evidence' };
}

export async function loadProbeInputs({ main, manifestCommit, gitImpl = args => execFileSync('git', args,
  { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 8 * 1024 * 1024 }) }) {
  try {
    assert.match(main ?? '', /^[0-9a-f]{40}$/);
    assert.match(manifestCommit ?? '', /^[0-9a-f]{40}$/);
    // The operator fetches origin/main first. A working-tree or PR Manifest is
    // never an authority, and missing history has no current-HEAD fallback.
    gitImpl(['merge-base', '--is-ancestor', main, 'refs/remotes/origin/main']);
    const show = (sha, path) => gitImpl(['show', `${sha}:${path}`]);
    const manifest = show(main, 'docs/CANONICAL_MANIFEST.md').toString('utf8');
    const expected = expectedIdentity(manifest, main, manifestCommit);
    assert.equal(gitImpl(['cat-file', '-t', expected.rules_snapshot_sha]).toString('utf8').trim(), 'commit');
    assert.equal(gitImpl(['log', '-1', '--format=%H', main, '--', 'docs/CANONICAL_MANIFEST.md']).toString('utf8').trim(), manifestCommit);
    for (const file of ['MASTER_RULES', 'SOURCE_POLICY', 'MOBILE_SYNTAX', 'ACCEPTANCE_CRITERIA', 'PENDING', 'OFFICIAL_EVIDENCE']) {
      const source = show(expected.rules_snapshot_sha, `docs/${file}.md`).toString('utf8');
      assert.ok(source.split(/\r?\n/).includes('Version: ' + expected.canonical_version));
      assert.ok(source.split(/\r?\n/).includes('Status: ' + (file === 'OFFICIAL_EVIDENCE' ? 'CANONICAL SUPPORTING EVIDENCE' : 'PUBLISHED CANONICAL')));
    }
    // A later published main counts only when it is on main and descends from
    // this one; the operator's fetch of origin/main is what makes it known.
    const laterMain = sha => {
      try {
        gitImpl(['merge-base', '--is-ancestor', main, sha]);
        gitImpl(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']);
        return true;
      } catch { return false; }
    };
    return { expected, laterMain, expectedAssets: new Map(WORKSPACE_ASSETS.map(([, file]) =>
      [file, show(main, 'studio/web/service/' + file)])) };
  } catch (error) {
    // The code stays fixed so callers fail closed the same way, but the cause
    // travels with it: a loader bug and an operator who forgot to fetch
    // origin/main must not be indistinguishable.
    throw Object.assign(new Error('CANONICAL_NOT_LOADED', { cause: error }), { code: 'CANONICAL_NOT_LOADED' });
  }
}

/** One stderr line naming the failed check and, for CANONICAL_NOT_LOADED, why. Never written to evidence. */
export function describeFailure(error) {
  const cause = error?.cause?.message ? ` (cause: ${error.cause.message})` : '';
  return `acceptance failed: ${error?.message ?? String(error)}${cause}`;
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
  } catch (error) {
    // Never copy response bodies, URLs with secrets, or arbitrary errors to evidence.
    // The operator still has to learn which check failed: that goes to stderr only.
    console.error(describeFailure(error));
    report.status = 'FAIL'; report.public_probe = { status: 'FAIL', reason:
      error.code === 'CANONICAL_NOT_LOADED' ? 'CANONICAL_NOT_LOADED' : 'PUBLIC_PROBE_FAILED' };
  }
  await saveReport(values.out, report);
  console.log(JSON.stringify({ status: report.status, public_probe: report.public_probe.status,
    browser_mcp: report.browser_mcp.status }));
  // 2 means incomplete acceptance, even when all public checks pass.
  process.exitCode = report.status === 'FAIL' ? 1 : 2;
}
