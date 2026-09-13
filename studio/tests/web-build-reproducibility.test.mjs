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
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { verifyStudioArtifact } from '../../scripts/verify-studio-artifact.mjs';
import { verifyCanonicalPackage } from '../web/canonical-package.mjs';

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


// --- Release identity must cover the Service Worker and the shipped Canonical
// --- payload. Hash self-consistency alone let a re-signed artifact through.

const PUBLISHED = 'studio/web/published.mjs';
const BOOTSTRAP = 'studio/backend/bootstrap/index.mjs';
const PAYLOAD = /^export const canonical = (\{.*\});$/m;
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function walkArtifact(dir, base = '') {
  const found = [];
  for (const entry of await readdir(resolve(dir, base), { withFileTypes: true })) {
    const path = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walkArtifact(dir, path));
    else found.push(path);
  }
  return found;
}

// Re-sign an artifact the way a careful attacker would: every asset hash, the
// buildId and the declared digests are made internally consistent again.
async function resign(dir, patch = {}) {
  const files = (await walkArtifact(dir)).filter(path => path !== 'build.json').sort();
  const hashes = await Promise.all(files.map(async path => [path, sha256(await readFile(resolve(dir, path)))]));
  const build = JSON.parse(await readFile(resolve(dir, 'build.json'), 'utf8'));
  build.files = hashes;
  build.buildId = sha256(JSON.stringify(hashes));
  Object.assign(build.release, patch);
  await writeFile(resolve(dir, 'build.json'), JSON.stringify(build, null, 2));
  return build;
}

const readPayload = async dir => PAYLOAD.exec(await readFile(resolve(dir, PUBLISHED), 'utf8'))[1];
const writePublished = (dir, json) => writeFile(resolve(dir, PUBLISHED), `export const canonical = ${json};\nexport const canonicalDigest = '${sha256(json)}';\n`);
async function writeBootstrap(dir, json) {
  const text = await readFile(resolve(dir, BOOTSTRAP), 'utf8');
  await writeFile(resolve(dir, BOOTSTRAP), text.replace(/^const loaded = .*;$/m, `const loaded = ${json};`));
}

function rejects(dir, pattern, expected) {
  return assert.rejects(() => verifyStudioArtifact(dir, expected), error => {
    assert.equal(error.code, 'ARTIFACT_NOT_VERIFIED');
    assert.match(error.message, pattern);
    return true;
  });
}

test('the release manifest covers the generated Service Worker', async t => {
  const { out, manifest } = await build(t);
  assert.ok(manifest.files.some(([path]) => path === 'sw.js'), 'sw.js must be in the asset manifest');
  assert.match(manifest.release.cacheId ?? '', /^[a-f0-9]{64}$/);
  const worker = await readFile(resolve(out, 'sw.js'), 'utf8');
  assert.ok(worker.includes(`mml-studio-v1-${manifest.release.cacheId}`), 'cache name must be derived from cacheId');
  assert.ok(!worker.includes(manifest.buildId), 'the worker must not embed buildId, which would be circular');
  await assert.doesNotReject(() => verifyStudioArtifact(out));

  const copyOf = async () => {
    const dir = await scratch();
    t.after(() => rm(dir, { recursive: true, force: true }));
    await cp(out, dir, { recursive: true });
    return dir;
  };

  const replaced = await copyOf();
  await writeFile(resolve(replaced, 'sw.js'), "self.addEventListener('fetch',e=>e.respondWith(new Response('hostile')));\n");
  await rejects(replaced, /Asset hash mismatch: sw\.js/);

  const deleted = await copyOf();
  await rm(resolve(deleted, 'sw.js'));
  await rejects(deleted, /Asset declared in build\.json is missing: sw\.js/);

  // Re-signing a swapped worker still fails: its cache identity no longer
  // matches the declared cacheId.
  const laundered = await copyOf();
  await writeFile(resolve(laundered, 'sw.js'), "self.addEventListener('fetch',e=>e.respondWith(new Response('hostile')));\n");
  await resign(laundered);
  await rejects(laundered, /Service Worker cache identity disagrees with release\.cacheId/);
});

test('changing the Service Worker template changes cacheId and buildId', async t => {
  const before = await build(t);
  const path = resolve(root, 'studio/web/sw.js');
  const original = await readFile(path);
  try {
    await appendFile(path, '\n// reproducibility probe\n');
    const after = await build(t);
    assert.notEqual(after.manifest.release.cacheId, before.manifest.release.cacheId);
    assert.notEqual(after.summary.buildId, before.summary.buildId);
  } finally { await writeFile(path, original); }
});

test('repeating a build reproduces the same cacheId and the same Service Worker bytes', async t => {
  const first = await build(t);
  const second = await build(t);
  assert.equal(second.manifest.release.cacheId, first.manifest.release.cacheId);
  assert.equal(second.summary.buildId, first.summary.buildId);
  assert.deepEqual(await readFile(resolve(second.out, 'sw.js')), await readFile(resolve(first.out, 'sw.js')));
});

test('the verifier rejects a Canonical payload the browser would refuse to boot', async t => {
  const { out } = await build(t);
  const copyOf = async () => {
    const dir = await scratch();
    t.after(() => rm(dir, { recursive: true, force: true }));
    await cp(out, dir, { recursive: true });
    return dir;
  };

  const wrong = await copyOf();
  await resign(wrong, { runtimeBundleDigest: '0'.repeat(64) });
  await rejects(wrong, /runtimeBundleDigest does not match/);

  const missing = await copyOf();
  const missingBuild = JSON.parse(await readFile(resolve(missing, 'build.json'), 'utf8'));
  delete missingBuild.release.runtimeBundleDigest;
  await writeFile(resolve(missing, 'build.json'), JSON.stringify(missingBuild, null, 2));
  await rejects(missing, /runtimeBundleDigest does not match/);

  // Dynamic provenance reintroduced and every affected digest recomputed.
  const contaminated = await copyOf();
  const bundle = JSON.parse(await readPayload(contaminated));
  bundle.provenance = { manifest_commit: '0'.repeat(40), repository_head: '1'.repeat(40), pr_head: null, published_main_head: '2'.repeat(40) };
  const contaminatedJson = JSON.stringify(bundle);
  await writePublished(contaminated, contaminatedJson);
  await writeBootstrap(contaminated, contaminatedJson);
  await resign(contaminated, { runtimeBundleDigest: sha256(contaminatedJson) });
  await rejects(contaminated, /carries dynamic Git provenance/);
  // The browser rejects the same bytes; verifier and runtime now agree.
  await assert.rejects(() => verifyCanonicalPackage(bundle, sha256(contaminatedJson)), /CANONICAL_NOT_LOADED/);

  // Shipped Canonical identity disagreeing with the declared release identity.
  const relabelled = await copyOf();
  const drifted = JSON.parse(await readPayload(relabelled));
  drifted.metadata.manifest_version = '2026-09-13-v1-manifest99';
  const driftedJson = JSON.stringify(drifted);
  await writePublished(relabelled, driftedJson);
  await writeBootstrap(relabelled, driftedJson);
  await resign(relabelled, { runtimeBundleDigest: sha256(driftedJson) });
  await rejects(relabelled, /Shipped Canonical manifest_version disagrees/);

  // Only one of the two embedded copies swapped, everything else re-signed.
  const divergent = await copyOf();
  const second = JSON.parse(await readPayload(divergent));
  second.metadata.manifest_version = '2026-09-13-v1-manifest99';
  await writeBootstrap(divergent, JSON.stringify(second));
  await resign(divergent);
  await rejects(divergent, /Embedded Canonical bundles disagree/);
});

test('a verified artifact also satisfies the browser Canonical package contract', async t => {
  const { out, manifest } = await build(t);
  const verified = await verifyStudioArtifact(out, {
    canonical_version: '2026-09-13-v1',
    rules_snapshot_sha: manifest.release.rules_snapshot_sha,
  });
  assert.equal(verified.buildId, manifest.buildId);

  const json = await readPayload(out);
  assert.equal(sha256(json), manifest.release.runtimeBundleDigest);
  const accepted = await verifyCanonicalPackage(JSON.parse(json), sha256(json));
  assert.equal(accepted.status, 'CANONICAL_LOADED');
  assert.equal(accepted.metadata.rules_snapshot_sha, manifest.release.rules_snapshot_sha);
});
