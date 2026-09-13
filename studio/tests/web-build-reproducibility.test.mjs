// The Studio artifact must identify its own content, not the Git state that
// happened to be checked out when it was produced. Before this was enforced,
// advancing main rebuilt byte-different assets and a different buildId from
// identical sources, so a permanent deployment could not rebuild the release
// it was serving and had to keep fetching a disposable preview instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, cp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyStudioArtifact } from '../../scripts/verify-studio-artifact.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// commit-tree needs a committer identity that a bare CI runner may not have.
const identity = {
  GIT_AUTHOR_NAME: 'Studio artifact test', GIT_AUTHOR_EMAIL: 'artifact@example.invalid',
  GIT_COMMITTER_NAME: 'Studio artifact test', GIT_COMMITTER_EMAIL: 'artifact@example.invalid',
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const scratch = async () => mkdtemp(resolve(tmpdir(), 'mml-artifact-'));

// Each build writes to its own directory so concurrent test files never race.
async function build(t, env = {}) {
  const out = await scratch();
  t.after(() => rm(out, { recursive: true, force: true }));
  const summary = JSON.parse(execFileSync(process.execPath, ['scripts/build-studio-web.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, STUDIO_WEB_BUILD_OUT: out },
  }));
  const manifest = JSON.parse(await readFile(resolve(out, 'build.json'), 'utf8'));
  return { out, summary, manifest };
}

const buildFails = (env = {}) => {
  try {
    execFileSync(process.execPath, ['scripts/build-studio-web.mjs'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
  } catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}`; }
  return null;
};

// A commit carrying main's exact tree: Git identity moves, sources do not.
function twinCommit(parent, message) {
  return git('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message);
}

async function withPublishedMain(commit, run) {
  const original = git('rev-parse', 'refs/remotes/origin/main');
  try {
    git('update-ref', 'refs/remotes/origin/main', commit);
    return await run();
  } finally { git('update-ref', 'refs/remotes/origin/main', original); }
}

test('advancing published main leaves the runtime artifact and buildId unchanged', async t => {
  const before = await build(t);
  const twin = twinCommit(git('rev-parse', 'refs/remotes/origin/main'), 'reproducibility probe: advance published main');
  const after = await withPublishedMain(twin, () => build(t));

  assert.notEqual(after.manifest.audit.published_main_head, before.manifest.audit.published_main_head);
  assert.equal(after.summary.buildId, before.summary.buildId);
  assert.deepEqual(after.manifest.files, before.manifest.files);
  assert.deepEqual(after.manifest.release, before.manifest.release);
});

test('a different CI checkout identity leaves the runtime artifact and buildId unchanged', async t => {
  const before = await build(t);
  const dir = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prHead = twinCommit(git('rev-parse', 'refs/remotes/origin/main'), 'reproducibility probe: synthetic merge identity');
  const eventPath = resolve(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify({ pull_request: { head: { sha: prHead } } }));

  const out = await scratch();
  t.after(() => rm(out, { recursive: true, force: true }));
  const summary = JSON.parse(execFileSync(process.execPath, ['scripts/build-studio-web.mjs'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, STUDIO_WEB_BUILD_OUT: out, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath },
  }));
  const manifest = JSON.parse(await readFile(resolve(out, 'build.json'), 'utf8'));

  assert.equal(manifest.audit.pr_head, prHead);
  assert.notEqual(manifest.audit.pr_head, before.manifest.audit.pr_head);
  assert.equal(summary.buildId, before.summary.buildId);
  assert.deepEqual(manifest.files, before.manifest.files);
});

test('build.json still preserves the dynamic provenance that no longer moves buildId', async t => {
  const { manifest } = await build(t);
  for (const field of ['manifest_commit', 'repository_head', 'published_main_head', 'source_sha']) {
    assert.match(manifest.audit[field] ?? '', /^[a-f0-9]{40}$/, field);
  }
  assert.equal(manifest.audit.repository_head, git('rev-parse', 'HEAD'));
  assert.equal(manifest.audit.published_main_head, git('rev-parse', 'refs/remotes/origin/main'));
  // Audit provenance must never masquerade as release identity.
  assert.equal(manifest.release.canonical.rules_snapshot_sha, manifest.release.rules_snapshot_sha);
  assert.notEqual(manifest.release.rules_snapshot_sha, manifest.audit.published_main_head);
  for (const [path] of manifest.files) assert.notEqual(path, 'build.json');
});

test('changing a runtime source changes buildId', async t => {
  const before = await build(t);
  const path = resolve(root, 'studio/web/style.css');
  const original = await readFile(path);
  try {
    await appendFile(path, '\n/* reproducibility probe */\n');
    const after = await build(t);
    assert.notEqual(after.summary.buildId, before.summary.buildId);
  } finally { await writeFile(path, original); }
});

test('an unsupported Canonical release fails closed instead of silently reusing the artifact', async t => {
  const manifestPath = 'docs/CANONICAL_MANIFEST.md';
  const published = git('rev-parse', 'refs/remotes/origin/main');
  const source = git('show', `${published}:${manifestPath}`);

  const republish = async (text, message) => {
    const dir = await scratch();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const blobPath = resolve(dir, 'manifest.md');
    await writeFile(blobPath, text);
    const blob = git('hash-object', '-w', blobPath);
    const index = resolve(dir, 'index');
    const withIndex = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...identity, GIT_INDEX_FILE: index } }).trim();
    withIndex('read-tree', published);
    withIndex('update-index', '--add', '--cacheinfo', `100644,${blob},${manifestPath}`);
    return git('commit-tree', withIndex('write-tree'), '-p', published, '-m', message);
  };

  const renamed = await republish(source.replace('canonical_version: 2026-09-13-v1', 'canonical_version: 2999-01-01-v9').replace('manifest_version: 2026-09-13-v1-manifest1', 'manifest_version: 2999-01-01-v9-manifest1'), 'probe: unsupported Canonical version');
  const versionFailure = await withPublishedMain(renamed, () => buildFails());
  assert.match(versionFailure ?? '', /CANONICAL_NOT_LOADED/);

  const moved = await republish(source.replace(/rules_snapshot_sha: [0-9a-f]{40}/, `rules_snapshot_sha: ${'0'.repeat(40)}`), 'probe: unavailable rules snapshot');
  const snapshotFailure = await withPublishedMain(moved, () => buildFails());
  assert.match(snapshotFailure ?? '', /CANONICAL_NOT_LOADED/);
});

test('the verifier rejects a tampered asset, manifest, identity or stowaway file', async t => {
  const { out } = await build(t);
  const copyOf = async () => {
    const dir = await scratch();
    t.after(() => rm(dir, { recursive: true, force: true }));
    await cp(out, dir, { recursive: true });
    return dir;
  };
  const rejects = (dir, pattern, expected) => assert.rejects(() => verifyStudioArtifact(dir, expected), error => {
    assert.equal(error.code, 'ARTIFACT_NOT_VERIFIED');
    assert.match(error.message, pattern);
    return true;
  });

  await assert.doesNotReject(() => verifyStudioArtifact(out));

  const tampered = await copyOf();
  await appendFile(resolve(tampered, 'studio/web/model.mjs'), '\n// tamper\n');
  await rejects(tampered, /Asset hash mismatch: studio\/web\/model\.mjs/);

  const relabelled = await copyOf();
  const relabelledJson = JSON.parse(await readFile(resolve(relabelled, 'build.json'), 'utf8'));
  relabelledJson.buildId = 'f'.repeat(64);
  await writeFile(resolve(relabelled, 'build.json'), JSON.stringify(relabelledJson));
  await rejects(relabelled, /Declared buildId does not match the asset manifest/);

  const rewritten = await copyOf();
  const rewrittenJson = JSON.parse(await readFile(resolve(rewritten, 'build.json'), 'utf8'));
  rewrittenJson.files[0] = [rewrittenJson.files[0][0], 'a'.repeat(64)];
  await writeFile(resolve(rewritten, 'build.json'), JSON.stringify(rewrittenJson));
  await rejects(rewritten, /Declared buildId does not match the asset manifest/);

  const unpublished = await copyOf();
  const unpublishedJson = JSON.parse(await readFile(resolve(unpublished, 'build.json'), 'utf8'));
  delete unpublishedJson.release.canonical.canonical_status;
  await writeFile(resolve(unpublished, 'build.json'), JSON.stringify(unpublishedJson));
  await rejects(unpublished, /not a PUBLISHED Canonical release/);

  const stripped = await copyOf();
  const strippedJson = JSON.parse(await readFile(resolve(stripped, 'build.json'), 'utf8'));
  delete strippedJson.audit;
  await writeFile(resolve(stripped, 'build.json'), JSON.stringify(strippedJson));
  await rejects(stripped, /preserves no dynamic build provenance/);

  const stowaway = await copyOf();
  await writeFile(resolve(stowaway, 'studio/web/extra.mjs'), 'export const injected = true;\n');
  await rejects(stowaway, /Unexpected file not covered by the asset manifest/);

  const removed = await copyOf();
  await rm(resolve(removed, 'studio/web/model.mjs'));
  await rejects(removed, /Asset declared in build\.json is missing/);

  await rejects(out, /buildId mismatch/, { buildId: 'b'.repeat(64) });
  await rejects(out, /canonical_version mismatch/, { canonical_version: '1999-01-01-v1' });
});

test('repeating a build reproduces the same buildId and byte-identical hashed assets', async t => {
  const first = await build(t);
  const second = await build(t);
  assert.equal(second.summary.buildId, first.summary.buildId);
  assert.deepEqual(second.manifest.files, first.manifest.files);
  for (const [path] of first.manifest.files) {
    assert.deepEqual(await readFile(resolve(second.out, path)), await readFile(resolve(first.out, path)), path);
  }
  const verified = await verifyStudioArtifact(second.out, {
    buildId: first.summary.buildId,
    canonical_version: '2026-09-13-v1',
    rules_snapshot_sha: first.manifest.release.rules_snapshot_sha,
  });
  assert.equal(verified.assetCount, first.manifest.files.length);
});
