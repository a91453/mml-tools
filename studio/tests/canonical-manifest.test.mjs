import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { parseCanonicalManifest } from '../backend/bootstrap/index.mjs';
import { MACHINE_DELIVERY_SCHEMA_V2 } from '../backend/final/delivery-evaluator.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = 'docs/CANONICAL_MANIFEST.md';
const manifest = readFileSync(resolve(root, manifestPath), 'utf8');
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const rulePaths = ['docs/MASTER_RULES.md', 'docs/SOURCE_POLICY.md', 'docs/MOBILE_SYNTAX.md', 'docs/ACCEPTANCE_CRITERIA.md'];
const expectedAuthority = new Map([
  ...rulePaths.map(path => [path, 'CANONICAL_RULE_SOURCE']),
  ['docs/PENDING.md', 'PENDING_HISTORICAL_INVENTORY'],
  ['docs/OFFICIAL_EVIDENCE.md', 'SUPPORTING_EVIDENCE'],
  ['studio/backend/rules/index.mjs', 'IMPLEMENTER'],
  ['studio/backend/canonical/', 'IMPLEMENTER'],
  ['studio/tests/', 'VERIFIER'],
  ['studio/audio-worker/tests/', 'VERIFIER'],
  ['tests/', 'VERIFIER'],
]);

const metadata = text => parseCanonicalManifest(text).metadata;
const authorityRows = text => parseCanonicalManifest(text).entries;

test('Manifest pins the published v3 release and stores no dynamic Git identities', () => {
  assert.deepEqual(metadata(manifest), {
    canonical_version: '2026-09-23-v3',
    canonical_status: 'PUBLISHED',
    manifest_version: '2026-09-23-v3-manifest1',
    rules_snapshot_sha: 'ff1a9df054f5ca1ae42571067fc95feb274755ef',
    machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V2,
  });
});

test('snapshot is an existing full commit that predates the Manifest, not a self-reference', () => {
  const { rules_snapshot_sha: snapshot } = metadata(manifest);
  assert.match(snapshot, /^[0-9a-f]{40}$/);
  assert.equal(git(['cat-file', '-t', snapshot]), 'commit', 'Fetch snapshot history; do not substitute HEAD');
  assert.equal(git(['rev-parse', '--verify', `${snapshot}^{commit}`]), snapshot);
  // A later release's snapshot carries the previous Manifest revision; it must
  // never carry this one. (Compared without reading either Manifest by object,
  // so this verifier resolves no Manifest identity of its own.)
  const snapshotPaths = git(['ls-tree', '-r', '--name-only', snapshot]).split('\n');
  if (snapshotPaths.includes(manifestPath)) {
    assert.notEqual(git(['diff', '--stat', snapshot, '--', manifestPath]), '', 'Rules snapshot must predate this Manifest');
  }
  const manifestCommit = git(['log', '-1', '--format=%H', 'HEAD', '--', manifestPath]);
  if (manifestCommit) assert.notEqual(snapshot, manifestCommit);
  git(['merge-base', '--is-ancestor', snapshot, 'HEAD']);
});

test('all indexed files/directories exist at the pinned snapshot and links use that snapshot', () => {
  const { rules_snapshot_sha: snapshot } = metadata(manifest);
  for (const { path, url } of authorityRows(manifest)) {
    const directory = path.endsWith('/');
    assert.equal(url, `https://github.com/a91453/mml-tools/${directory ? 'tree' : 'blob'}/${snapshot}/${path}`);
    assert.equal(git(['cat-file', '-t', `${snapshot}:${path.replace(/\/$/, '')}`]), directory ? 'tree' : 'blob', path);
    const current = statSync(resolve(root, path));
    assert.ok(directory ? current.isDirectory() : current.isFile(), `${path} must remain available`);
  }
});

test('published document headers agree with the release while retaining distinct authority roles', () => {
  const { rules_snapshot_sha: snapshot, canonical_version: version } = metadata(manifest);
  for (const path of [...rulePaths, 'docs/PENDING.md', 'docs/OFFICIAL_EVIDENCE.md']) {
    const content = git(['show', `${snapshot}:${path}`]);
    const status = path === 'docs/OFFICIAL_EVIDENCE.md' ? 'CANONICAL SUPPORTING EVIDENCE' : 'PUBLISHED CANONICAL';
    assert.ok(content.split('\n').includes(`Version: ${version}`), path);
    assert.ok(content.split('\n').includes(`Status: ${status}`), path);
  }
});

test('only the four human-readable rule sources have Canonical rule authority', () => {
  const rows = authorityRows(manifest);
  assert.equal(rows.length, expectedAuthority.size);
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length, 'No duplicate locators');
  for (const { path, authority } of rows) assert.equal(authority, expectedAuthority.get(path), path);
  assert.deepEqual(rows.filter(row => row.authority === 'CANONICAL_RULE_SOURCE').map(row => row.path), rulePaths);
  assert.equal(EFFECTIVE_RULESET.authority.executableContractDefinesRules, false);
  // Contract status is implementation evidence only; no music-rule values are copied here.
  assert.equal(EFFECTIVE_RULESET.status, 'implements-published-canonical');
});

test('an unrelated Git HEAD advance leaves the loaded release and Manifest commit unchanged', t => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'mml-manifest-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  git(['init', '-b', 'manifest-test'], fixture);
  mkdirSync(resolve(fixture, 'docs'));
  writeFileSync(resolve(fixture, manifestPath), manifest);
  const commit = message => {
    git(['add', '.'], fixture);
    git(['-c', 'user.name=Manifest test', '-c', 'user.email=manifest-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message], fixture);
  };
  const observe = () => ({
    release: metadata(git(['show', `HEAD:${manifestPath}`], fixture)),
    manifestCommit: git(['log', '-1', '--format=%H', 'HEAD', '--', manifestPath], fixture),
    repositoryHead: git(['rev-parse', 'HEAD'], fixture),
  });
  commit('Add the Manifest fixture');
  const before = observe();
  writeFileSync(resolve(fixture, 'unrelated.txt'), 'Unrelated implementation change\n');
  commit('Advance HEAD without publishing rules');
  const after = observe();
  assert.notEqual(after.repositoryHead, before.repositoryHead);
  assert.equal(after.manifestCommit, before.manifestCommit);
  assert.deepEqual(after.release, before.release);
});

test('a locator with an empty path segment is rejected instead of aliasing another locator', () => {
  const doubled = manifest.replace('[studio/tests/](', '[studio/tests//](').replace('/studio/tests/)', '/studio/tests//)');
  assert.notEqual(doubled, manifest);
  assert.throws(() => parseCanonicalManifest(doubled), /Invalid snapshot path/);
});
