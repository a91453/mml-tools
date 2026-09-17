// Published Canonical materialization — the production condition and its edges.
//
// The defect these cover: the merged Agent Control Plane deployment succeeded
// operationally (/healthz PASS, container start PASS, Railway status SUCCESS)
// and reported CANONICAL_NOT_LOADED for every Canonical-aware operation, because
// Railway's GitHub source snapshot delivers this repository's files without
// `.git` and the runtime bootstrap reads the Manifest and the pinned rules
// snapshot out of Git objects. `backend/bootstrap/materialize.mjs` builds that
// object store at image build, from the published repository.
//
// Nothing here touches live GitHub. The published source is a real Git
// repository in a temporary directory, reached over `file://`, so every case is
// deterministic and CI never depends on a network fetch. The mechanism under
// test is the same one production uses: `git ls-remote` then `git fetch`,
// against whatever published source it was given.
//
// Nothing here writes to this checkout's refs, HEAD or object store either —
// see support/isolated-repository.mjs for why that matters under the M6 runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOOTSTRAP_ATTESTATION_REF,
  BOOTSTRAP_CONTRACT,
  BOOTSTRAP_RECORD_PATH,
  CHECKOUT_IDENTITY,
  loadPublishedCanonical,
} from '../backend/bootstrap/index.mjs';
import {
  materializePublishedCanonical,
  PUBLISHED_SOURCE,
  SOURCE_TOKEN_VARIABLE,
  sourceCredentialArguments,
} from '../backend/bootstrap/materialize.mjs';
import { createCanonicalGate } from '../backend/application/provenance.mjs';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const notLoaded = error => error.code === 'CANONICAL_NOT_LOADED';

const identity = {
  GIT_AUTHOR_NAME: 'Materialization probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'Materialization probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity },
}).trim();

// The sources a materialized image needs in its working tree. Documents are
// deliberately absent: every Canonical document is read from Git objects, so a
// worktree copy would prove nothing — and its absence proves the loader is not
// quietly reading one.
const IMAGE_SOURCES = ['studio/backend', 'scripts', 'dist/core.js', 'package.json'];

function temporary(t, prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A published source: a real bare repository carrying this repository's
 * history, reached over `file://` exactly as production reaches GitHub over
 * `https://`. `publish` moves its `main`, which is what a mutable published
 * branch does between two reads.
 */
function publishedSource(t, { head = PUBLISHED_CANONICAL.provenance.published_main_head } = {}) {
  const dir = temporary(t, 'mml-published-');
  const bare = resolve(dir, 'published.git');
  // `--no-local` forces the real transfer path rather than a hardlink clone.
  git(repositoryRoot, 'clone', '--quiet', '--bare', '--no-local', repositoryRoot, bare);
  git(bare, 'symbolic-ref', 'HEAD', BOOTSTRAP_CONTRACT.publishedBranch);
  git(bare, 'update-ref', BOOTSTRAP_CONTRACT.publishedBranch, head);
  return {
    url: `file://${bare}`,
    bare,
    head,
    publish: commit => git(bare, 'update-ref', BOOTSTRAP_CONTRACT.publishedBranch, commit),
    unpublish: () => git(bare, 'update-ref', '-d', BOOTSTRAP_CONTRACT.publishedBranch),
    // A commit carrying `parent`'s exact tree: published identity moves, sources do not.
    twinCommit: (parent, message) => git(bare, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message),
    // `parent`'s tree with one blob replaced.
    replaceBlob(path, text, message, parent = head) {
      const blobFile = resolve(dir, '.probe-blob');
      writeFileSync(blobFile, text);
      const blob = git(bare, 'hash-object', '-w', blobFile);
      const index = resolve(dir, '.probe-index');
      const withIndex = (...args) => execFileSync('git', args, {
        cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...identity, GIT_INDEX_FILE: index },
      }).trim();
      withIndex('read-tree', parent);
      withIndex('update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
      return git(bare, 'commit-tree', withIndex('write-tree'), '-p', parent, '-m', message);
    },
  };
}

/**
 * The production condition: the repository's source files, and no `.git` at all.
 */
function sourceTreeWithoutGit(t, { sources = IMAGE_SOURCES } = {}) {
  const dir = temporary(t, 'mml-nogit-');
  for (const path of sources) cpSync(resolve(repositoryRoot, path), resolve(dir, path), { recursive: true });
  assert.equal(existsSync(resolve(dir, '.git')), false, 'the fixture must reproduce the no-.git production condition');
  return dir;
}

// ─── 1. the production condition ────────────────────────────────────────────

test('a source tree with no .git loads the Published Canonical from the published source', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);

  // Before: exactly the merged deployment's failure.
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);

  const summary = materializePublishedCanonical({ root, publishedSource: published.url });
  assert.equal(summary.status, 'CANONICAL_LOADED');
  assert.equal(summary.materialized, true);

  // After: the real loader, unchanged and offline, returns the exact identities.
  const loaded = loadPublishedCanonical({ root });
  assert.equal(loaded.status, 'CANONICAL_LOADED');
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.equal(loaded.provenance.published_main_head, published.head);
  assert.equal(loaded.provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.equal(loaded.documents.length, 6);

  // Document bytes come from the snapshot, not from the published tip's tree
  // and not from a working-tree copy that does not exist here.
  const master = loaded.documents.find(document => document.path === 'docs/MASTER_RULES.md');
  assert.equal(master.content, PUBLISHED_CANONICAL.documents.find(d => d.path === 'docs/MASTER_RULES.md').content);
  assert.equal(existsSync(resolve(root, 'docs/MASTER_RULES.md')), false);
});

test('a materialized checkout reports how its checkout identity was established', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  const buildSourceHead = 'b'.repeat(40);
  materializePublishedCanonical({ root, publishedSource: published.url, buildSourceHead });

  const { provenance, metadata } = loadPublishedCanonical({ root });
  // repository_head equals published_main_head here by construction, and the
  // provenance says so rather than letting the pair look independently verified.
  assert.equal(provenance.checkout_identity, CHECKOUT_IDENTITY.materialized);
  assert.equal(provenance.repository_head, provenance.published_main_head);
  assert.equal(provenance.build_source_head, buildSourceHead);
  // The identities that select what is loaded stay distinct from all of it.
  assert.notEqual(metadata.rules_snapshot_sha, provenance.published_main_head);
  assert.notEqual(metadata.rules_snapshot_sha, provenance.manifest_commit);
  assert.notEqual(provenance.manifest_commit, provenance.published_main_head);

  assert.equal(provenance.published_source, published.url);

  const record = JSON.parse(readFileSync(resolve(root, BOOTSTRAP_RECORD_PATH), 'utf8'));
  assert.equal(record.published_source, published.url);
  assert.equal(record.published_main_head, published.head);
  // The claim itself lives in the object store, not in the record.
  assert.equal(git(root, 'rev-parse', BOOTSTRAP_ATTESTATION_REF), published.head);
});

test('deleting the bootstrap record cannot downgrade a materialized image to a claimed checkout', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  materializePublishedCanonical({ root, publishedSource: published.url });
  const recordPath = resolve(root, BOOTSTRAP_RECORD_PATH);
  const record = readFileSync(recordPath, 'utf8');

  // The failure this guards: with the record gone, repository_head still equals
  // published_main_head by construction, and reporting `git-checkout` would
  // publish that pair as if it were an independently verified checkout. So the
  // attestation the record belongs to lives where the identities do, and half
  // of it is not an answer.
  rmSync(recordPath);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);

  // The other half alone is refused too, so neither can outlive the other.
  writeFileSync(recordPath, record);
  git(root, 'update-ref', '-d', BOOTSTRAP_ATTESTATION_REF);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);

  // An attestation naming a different published main is refused rather than
  // trusted over the ref this load resolved.
  git(root, 'update-ref', BOOTSTRAP_ATTESTATION_REF, PUBLISHED_CANONICAL.metadata.rules_snapshot_sha);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);

  git(root, 'update-ref', BOOTSTRAP_ATTESTATION_REF, published.head);
  const restored = loadPublishedCanonical({ root });
  assert.equal(restored.provenance.checkout_identity, CHECKOUT_IDENTITY.materialized);
});

test('a real checkout that has no attestation is not asked to carry a record', t => {
  // The ordinary case stays the ordinary case: no attestation, no record, and
  // repository_head equal to published_main_head is normal on a checkout of
  // published main rather than something to refuse.
  const published = publishedSource(t);
  const dir = temporary(t, 'mml-plain-');
  const clone = resolve(dir, 'checkout');
  git(repositoryRoot, 'clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, clone);
  git(clone, 'update-ref', '--no-deref', 'HEAD', published.head);
  git(clone, 'update-ref', BOOTSTRAP_CONTRACT.publishedRef, published.head);
  for (const path of IMAGE_SOURCES) cpSync(resolve(repositoryRoot, path), resolve(clone, path), { recursive: true });

  const loaded = loadPublishedCanonical({ root: clone });
  assert.equal(loaded.provenance.checkout_identity, CHECKOUT_IDENTITY.gitCheckout);
  assert.equal(loaded.provenance.repository_head, loaded.provenance.published_main_head);
  assert.equal(loaded.provenance.published_source, null);
  assert.equal(loaded.provenance.build_source_head, null);

  // A record with no attestation behind it is refused, not ignored.
  writeFileSync(resolve(clone, BOOTSTRAP_RECORD_PATH), JSON.stringify({
    bootstrap_version: 1,
    checkout_identity: CHECKOUT_IDENTITY.materialized,
    published_main_head: published.head,
    published_source: 'https://evil.example/not-the-published-repo.git',
    build_source_head: null,
  }));
  assert.throws(() => loadPublishedCanonical({ root: clone }), notLoaded);
});

test('a published source must use a transport that cannot execute a command', t => {
  const root = sourceTreeWithoutGit(t);
  for (const hostile of [
    'ext::sh -c echo%20pwned',
    'ssh://git@example.invalid/x.git',
    'http://example.invalid/x.git',
    '/absolute/path/x.git',
    'example.invalid:x.git',
  ]) {
    assert.throws(() => materializePublishedCanonical({ root, publishedSource: hostile }), notLoaded, hostile);
  }
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
});

test('a damaged checkout is refused rather than relabelled as materialized', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  assert.throws(() => materializePublishedCanonical({
    root,
    publishedSource: published.url,
    git({ root: cwd, args }) {
      // HEAD fails for a reason that is not "unborn": a corrupt object store
      // reports 128, and reading that as "this tree has no checkout identity"
      // would set HEAD to the published head and attest a materialization.
      if (args.includes('HEAD^{commit}')) {
        const error = Error('fatal: bad object HEAD');
        error.status = 128;
        error.stdout = Buffer.alloc(0);
        throw error;
      }
      return execFileSync('git', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    },
  }), notLoaded);
  assert.equal(existsSync(resolve(root, BOOTSTRAP_RECORD_PATH)), false, 'no attestation may be written for a checkout that could not be read');
});

test('the record cannot introduce an identity the load did not resolve', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  materializePublishedCanonical({ root, publishedSource: published.url });
  const recordPath = resolve(root, BOOTSTRAP_RECORD_PATH);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));

  for (const [name, mutate] of [
    ['a published main the load did not resolve', value => ({ ...value, published_main_head: 'c'.repeat(40) })],
    ['an unknown checkout identity', value => ({ ...value, checkout_identity: 'trust-me' })],
    ['an unknown field', value => ({ ...value, rules_snapshot_sha: '0'.repeat(40) })],
    ['a missing field', ({ build_source_head, ...rest }) => rest],
    ['an unsupported version', value => ({ ...value, bootstrap_version: 2 })],
    ['a forged build source head', value => ({ ...value, build_source_head: 'not-a-sha' })],
  ]) {
    writeFileSync(recordPath, JSON.stringify(mutate(record)));
    assert.throws(() => loadPublishedCanonical({ root }), notLoaded, name);
  }
  writeFileSync(recordPath, '{ not json');
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);

  // Restoring the truthful record restores the load; nothing was cached.
  writeFileSync(recordPath, JSON.stringify(record));
  assert.equal(loadPublishedCanonical({ root }).status, 'CANONICAL_LOADED');
});

// ─── 2. the published identity is captured before anything is read ──────────

test('published main is captured before the Manifest is read, so a moving branch cannot mix two mains', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  const captured = published.head;
  // A later published main whose tree is identical: only the identity differs,
  // so any read that silently followed the branch would still succeed and
  // report the wrong commit.
  const moved = published.twinCommit(captured, 'published main advanced mid-build');
  assert.notEqual(moved, captured);

  const calls = [];
  let advanced = false;
  const summary = materializePublishedCanonical({
    root,
    publishedSource: published.url,
    git({ root: cwd, args }) {
      calls.push(args);
      const output = execFileSync('git', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      // The moment the published identity has been captured, move the branch.
      if (args[0] === 'ls-remote' && !advanced) { published.publish(moved); advanced = true; }
      return output;
    },
  });

  // The capture happens before anything is read, and every later read names the
  // captured commit rather than the branch.
  const capture = calls.findIndex(args => args[0] === 'ls-remote');
  const manifestRead = calls.findIndex(args => args[0] === 'cat-file' && args.some(arg => String(arg).includes(BOOTSTRAP_CONTRACT.entryPoint)));
  assert.ok(capture !== -1, 'the published identity must be captured from the published source');
  assert.deepEqual(
    [...new Set(calls.slice(0, capture).map(args => args[0]))].sort(),
    ['init', 'rev-parse'],
    'only creating the object store may precede the capture — nothing may be read first',
  );
  assert.ok(manifestRead > capture, 'the Manifest must be read after the capture');
  assert.ok(String(calls[manifestRead].at(-1)).startsWith(captured), 'the Manifest must be read from the captured commit');
  // No later call names the branch; they name the captured commit.
  for (const args of calls.slice(capture + 1)) {
    if (args[0] === 'fetch') continue;
    assert.ok(!args.includes(BOOTSTRAP_CONTRACT.publishedBranch), `a read after the capture named the mutable branch: ${args.join(' ')}`);
  }

  assert.equal(summary.provenance.published_main_head, captured);
  assert.equal(loadPublishedCanonical({ root }).provenance.published_main_head, captured);
  assert.equal(git(root, 'rev-parse', BOOTSTRAP_CONTRACT.publishedRef), captured);
  // The branch really did move; the build simply did not follow it.
  assert.equal(git(published.bare, 'rev-parse', BOOTSTRAP_CONTRACT.publishedBranch), moved);
});

test('a published main rewritten past the captured commit fails closed rather than following the branch', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  const captured = published.head;
  const unrelated = PUBLISHED_CANONICAL.metadata.rules_snapshot_sha;

  assert.throws(() => materializePublishedCanonical({
    root,
    publishedSource: published.url,
    git({ root: cwd, args }) {
      const run = () => execFileSync('git', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      if (args[0] !== 'fetch') return run();
      // Between the capture and the fetch, main is rewritten to a commit that
      // does not contain the captured one.
      published.publish(unrelated);
      return run();
    },
  }), notLoaded);
  assert.notEqual(captured, unrelated);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
});

// ─── 3. the exact pinned snapshot, never HEAD ───────────────────────────────

test('rule sources are read from the Manifest snapshot even when published main carries different bytes', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  // Published main's own copy of a rule source is replaced. The Manifest still
  // pins the reviewed snapshot, so the replacement must never be loaded.
  const substituted = published.replaceBlob('docs/MASTER_RULES.md', 'Version: 2026-09-13-v1\nStatus: PUBLISHED CANONICAL\n\nHEAD substitution\n', 'replace a rule source on main');
  published.publish(substituted);

  materializePublishedCanonical({ root, publishedSource: published.url });
  const loaded = loadPublishedCanonical({ root });
  assert.equal(loaded.provenance.published_main_head, substituted);
  assert.equal(loaded.metadata.rules_snapshot_sha, PUBLISHED_CANONICAL.metadata.rules_snapshot_sha);
  const master = loaded.documents.find(document => document.path === 'docs/MASTER_RULES.md');
  assert.equal(master.content, PUBLISHED_CANONICAL.documents.find(d => d.path === 'docs/MASTER_RULES.md').content);
  assert.doesNotMatch(master.content, /HEAD substitution/);
});

// ─── 4-7. every unprovable step fails closed ────────────────────────────────

test('an unavailable published main takes no fallback', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  published.unpublish();
  assert.throws(() => materializePublishedCanonical({ root, publishedSource: published.url }), notLoaded);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
});

test('an unreachable published source takes no fallback', t => {
  const root = sourceTreeWithoutGit(t);
  const absent = `file://${resolve(temporary(t, 'mml-absent-'), 'nothing-published.git')}`;
  assert.throws(() => materializePublishedCanonical({ root, publishedSource: absent }), notLoaded);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
});

for (const [name, manifest] of [
  ['a malformed Manifest', '# Not a Manifest\n'],
  ['an unpublished Manifest', PUBLISHED_CANONICAL.manifest.replace('canonical_status: PUBLISHED', 'canonical_status: CANDIDATE')],
  ['a Manifest pinning an unavailable snapshot', PUBLISHED_CANONICAL.manifest.replaceAll(PUBLISHED_CANONICAL.metadata.rules_snapshot_sha, 'a'.repeat(40))],
  ['a Manifest pointing at a mutable ref', PUBLISHED_CANONICAL.manifest.replace(/\/blob\/[0-9a-f]{40}\//, '/blob/main/')],
]) {
  test(`${name} fails closed with CANONICAL_NOT_LOADED`, t => {
    const published = publishedSource(t);
    const root = sourceTreeWithoutGit(t);
    published.publish(published.replaceBlob(BOOTSTRAP_CONTRACT.entryPoint, manifest, name));
    assert.throws(() => materializePublishedCanonical({ root, publishedSource: published.url }), notLoaded);
    assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
  });
}

test('a missing Manifest on published main cannot fall back to the pinned snapshot', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  // The rules snapshot commit predates the Manifest, so publishing it leaves a
  // main with every rule document and no entry point.
  published.publish(PUBLISHED_CANONICAL.metadata.rules_snapshot_sha);
  assert.throws(() => materializePublishedCanonical({ root, publishedSource: published.url }), notLoaded);
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
});

for (const [name, replacement] of [
  ['a required rule document missing from the snapshot', null],
  ['a rule document at the wrong version', 'Version: outdated\nStatus: PUBLISHED CANONICAL\n'],
  ['a rule document at the wrong publication status', 'Version: 2026-09-13-v1\nStatus: DRAFT\n'],
]) {
  test(`${name} fails closed with CANONICAL_NOT_LOADED`, t => {
    const published = publishedSource(t);
    const root = sourceTreeWithoutGit(t);
    // A snapshot built here, with one document broken, and a Manifest pinning it.
    const work = temporary(t, 'mml-snapshot-');
    git(work, 'init', '--quiet', '-b', 'main');
    for (const entry of PUBLISHED_CANONICAL.authority.map) {
      const document = PUBLISHED_CANONICAL.documents.find(item => item.path === entry.path);
      const path = entry.path.endsWith('/') ? `${entry.path}fixture.txt` : entry.path;
      if (entry.path === 'docs/SOURCE_POLICY.md') {
        if (replacement === null) continue;
        mkdirSync(resolve(work, 'docs'), { recursive: true });
        writeFileSync(resolve(work, path), replacement);
        continue;
      }
      mkdirSync(resolve(work, path.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      writeFileSync(resolve(work, path), document ? document.content : 'Implementation fixture only\n');
    }
    git(work, 'add', '--all');
    git(work, '-c', 'commit.gpgsign=false', 'commit', '-m', 'probe snapshot');
    const snapshot = git(work, 'rev-parse', 'HEAD');
    // Move the probe snapshot into the published source so the Manifest can pin it.
    git(published.bare, 'fetch', '--quiet', '--no-tags', work, `+HEAD:refs/probe/snapshot`);
    const manifest = PUBLISHED_CANONICAL.manifest.replaceAll(PUBLISHED_CANONICAL.metadata.rules_snapshot_sha, snapshot);
    published.publish(published.replaceBlob(BOOTSTRAP_CONTRACT.entryPoint, manifest, name));

    assert.throws(() => materializePublishedCanonical({ root, publishedSource: published.url }), notLoaded);
    assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
  });
}

// ─── 8. ENGINE_UNAVAILABLE stays distinct from CANONICAL_NOT_LOADED ─────────

test('an engine failure after the rules load keeps CANONICAL_LOADED provenance', async t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  materializePublishedCanonical({ root, publishedSource: published.url });
  const materialized = loadPublishedCanonical({ root });
  assert.equal(materialized.provenance.checkout_identity, CHECKOUT_IDENTITY.materialized);

  const { EngineUnavailableError } = await import('../backend/application/provenance.mjs');
  const gate = createCanonicalGate({
    load: ({ recordPublished }) => {
      // The rules resolve — with the materialized image's real identity — and a
      // later, non-rules engine module then fails to import.
      recordPublished(materialized);
      throw new EngineUnavailableError('a Canonical-aware engine module could not be imported');
    },
  });

  const provenance = await gate.provenance();
  assert.equal(provenance.status, 'CANONICAL_LOADED');
  assert.equal(provenance.engine_status, 'ENGINE_UNAVAILABLE');
  assert.equal(provenance.rules_snapshot_sha, PUBLISHED_CANONICAL.metadata.rules_snapshot_sha);
  assert.equal(provenance.published_main_head, published.head);
  assert.equal(provenance.checkout_identity, CHECKOUT_IDENTITY.materialized);
  await assert.rejects(() => gate.engines(), error => error.code === 'ENGINE_UNAVAILABLE');
});

// ─── 9. the ordinary checkout is untouched ──────────────────────────────────

test('a real checkout keeps its own checkout identity and needs no materialization', () => {
  const loaded = loadPublishedCanonical({ root: repositoryRoot });
  assert.equal(loaded.status, 'CANONICAL_LOADED');
  assert.equal(loaded.provenance.checkout_identity, CHECKOUT_IDENTITY.gitCheckout);
  assert.equal(loaded.provenance.build_source_head, null);
  assert.equal(loaded.provenance.repository_head, git(repositoryRoot, 'rev-parse', 'HEAD'));
  assert.equal(existsSync(resolve(repositoryRoot, BOOTSTRAP_RECORD_PATH)), false);
  // The runtime loader gained no network step: what the image needs is done by
  // a separate build-time module the runtime never imports.
  const loader = readFileSync(resolve(repositoryRoot, 'studio/backend/bootstrap/index.mjs'), 'utf8');
  assert.doesNotMatch(loader, /^\s*import[^\n]*materialize/m, 'the runtime loader must not import the build-time materialization');
  assert.doesNotMatch(loader, /materializePublishedCanonical/, 'the runtime loader must not call the build-time materialization');
});

test('materialization into a checkout that already has one keeps that identity', t => {
  const published = publishedSource(t);
  // A private clone, so this never writes to the shared checkout's refs.
  const dir = temporary(t, 'mml-clone-');
  const clone = resolve(dir, 'checkout');
  git(repositoryRoot, 'clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, clone);
  const head = published.twinCommit(published.head, 'a checkout that is not published main');
  git(published.bare, 'update-ref', 'refs/probe/checkout-head', head);
  git(clone, 'fetch', '--quiet', '--no-tags', published.url, '+refs/probe/checkout-head:refs/probe/checkout-head');
  git(clone, 'update-ref', '--no-deref', 'HEAD', head);
  for (const path of IMAGE_SOURCES) cpSync(resolve(repositoryRoot, path), resolve(clone, path), { recursive: true });

  const summary = materializePublishedCanonical({ root: clone, publishedSource: published.url });
  assert.equal(summary.materialized, false);
  assert.equal(existsSync(resolve(clone, BOOTSTRAP_RECORD_PATH)), false);
  const loaded = loadPublishedCanonical({ root: clone });
  assert.equal(loaded.provenance.checkout_identity, CHECKOUT_IDENTITY.gitCheckout);
  assert.equal(loaded.provenance.repository_head, head);
  assert.notEqual(loaded.provenance.repository_head, loaded.provenance.published_main_head);
  assert.equal(loaded.provenance.published_main_head, published.head);
});

// ─── the build entry point ──────────────────────────────────────────────────

test('the build entry point defaults to the published GitHub repository and fails closed', t => {
  assert.equal(PUBLISHED_SOURCE, `https://github.com/${BOOTSTRAP_CONTRACT.repository}.git`);

  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  const run = args => spawnSync(process.execPath, ['scripts/materialize-canonical.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, MML_BUILD_SOURCE_HEAD: 'd'.repeat(40) },
  });

  const ok = run(['--root', root, '--published-source', published.url]);
  assert.equal(ok.status, 0, ok.stderr);
  const summary = JSON.parse(ok.stdout);
  assert.equal(summary.status, 'CANONICAL_LOADED');
  assert.equal(summary.provenance.build_source_head, 'd'.repeat(40));
  assert.equal(summary.published_source, published.url);

  const broken = run(['--root', root, '--published-source', `file://${resolve(root, 'nothing.git')}`]);
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.equal(JSON.parse(broken.stderr).status, 'CANONICAL_NOT_LOADED');
  assert.equal(JSON.parse(broken.stderr).legacyFallbackAllowed, false);

  const misused = run(['--not-an-option', 'x']);
  assert.equal(misused.status, 1);
});

// ─── read access to a private published source ──────────────────────────────

test('a read credential reaches only the calls that contact the published source, and is never written down', t => {
  const token = 'ghp_SYNTHETIC_TEST_TOKEN_NEVER_REAL_0123456789';
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);

  // With no token, no credential configuration is produced at all.
  assert.deepEqual(sourceCredentialArguments({}), []);
  assert.deepEqual(sourceCredentialArguments({ [SOURCE_TOKEN_VARIABLE]: '' }), []);

  // With one, the configuration names the variable rather than carrying its
  // value, so the token is never in an argument vector a process listing shows.
  const configured = sourceCredentialArguments({ [SOURCE_TOKEN_VARIABLE]: token });
  assert.equal(configured[0], '-c');
  assert.ok(configured[1].startsWith('credential.helper='));
  assert.ok(!configured.join(' ').includes(token), 'the token must never appear in Git arguments');
  assert.ok(configured[1].includes(`$${SOURCE_TOKEN_VARIABLE}`), 'the helper must read the token from the environment');

  // End to end: only ls-remote and fetch carry it, and nothing the build
  // produces contains the token.
  const calls = [];
  process.env[SOURCE_TOKEN_VARIABLE] = token;
  t.after(() => { delete process.env[SOURCE_TOKEN_VARIABLE]; });
  const summary = materializePublishedCanonical({
    root,
    publishedSource: published.url,
    git({ root: cwd, args }) {
      calls.push(args);
      return execFileSync('git', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    },
  });
  assert.equal(summary.status, 'CANONICAL_LOADED');

  const contactsSource = args => args.includes('ls-remote') || args.includes('fetch');
  for (const args of calls) {
    assert.ok(!args.join(' ').includes(token), `the token reached a Git argument vector: ${args[0]}`);
    assert.equal(
      args.some(argument => String(argument).startsWith('credential.helper=')),
      contactsSource(args),
      `credential configuration must appear on exactly the calls that contact the published source: ${args.join(' ')}`,
    );
  }
  assert.ok(!JSON.stringify(summary).includes(token), 'the build summary must not carry the token');
  assert.ok(!readFileSync(resolve(root, BOOTSTRAP_RECORD_PATH), 'utf8').includes(token), 'the bootstrap record must not carry the token');
  assert.ok(!summary.published_source.includes(token), 'the published source URL must not carry the token');
});

test('an unreachable private published source fails the build and names the credential it needs', t => {
  const root = sourceTreeWithoutGit(t);
  const absent = `file://${resolve(temporary(t, 'mml-private-'), 'unreachable.git')}`;
  const env = { ...process.env };
  delete env[SOURCE_TOKEN_VARIABLE];

  const result = spawnSync(process.execPath, [
    'scripts/materialize-canonical.mjs', '--root', root, '--published-source', absent,
  ], { cwd: root, encoding: 'utf8', env });

  assert.equal(result.status, 1);
  const reported = JSON.parse(result.stderr);
  assert.equal(reported.status, 'CANONICAL_NOT_LOADED');
  assert.equal(reported.legacyFallbackAllowed, false);
  assert.match(reported.hint, new RegExp(SOURCE_TOKEN_VARIABLE));
  assert.ok(reported.hint.includes(PUBLISHED_SOURCE), 'the hint must name the published repository');
  // No fallback was taken on the way out.
  assert.throws(() => loadPublishedCanonical({ root }), notLoaded);
});

// ─── the build entry point stays diagnosable and never gates on provenance ──

test('a platform-supplied source head that is not a commit SHA is reported and dropped, never fatal', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  const run = value => spawnSync(process.execPath, [
    'scripts/materialize-canonical.mjs', '--root', root, '--published-source', published.url,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, MML_BUILD_SOURCE_HEAD: value } });

  // `build_source_head` selects no Manifest, no snapshot and no rule document,
  // so a platform that reports it abbreviated or upper-cased must not be able
  // to fail the deployment over it.
  for (const malformed of ['abc1234', 'not-a-sha', `${'a'.repeat(39)}`, `${'a'.repeat(41)}`]) {
    const result = run(malformed);
    assert.equal(result.status, 0, `${malformed}: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'CANONICAL_LOADED');
    assert.equal(summary.provenance.build_source_head, null);
    assert.match(summary.build_source_head_ignored, /not a full commit SHA/);
  }

  // A real one, however it is cased or padded, is carried through as itself.
  const upper = run(`  ${'A'.repeat(40)}  `);
  assert.equal(upper.status, 0, upper.stderr);
  assert.equal(JSON.parse(upper.stdout).provenance.build_source_head, 'a'.repeat(40));
  assert.ok(!Object.hasOwn(JSON.parse(upper.stdout), 'build_source_head_ignored'));
});

test('re-materializing the same tree refreshes its attestation rather than downgrading it', t => {
  const published = publishedSource(t);
  const root = sourceTreeWithoutGit(t);
  const first = materializePublishedCanonical({ root, publishedSource: published.url, buildSourceHead: 'c'.repeat(40) });
  assert.equal(first.materialized, true);

  // The second run finds the HEAD the first one set. Reading that as "this is a
  // real checkout" would strip the attestation and republish an equal
  // repository_head / published_main_head pair as an ordinary checkout.
  const moved = published.twinCommit(published.head, 'published main advanced between builds');
  published.publish(moved);
  const second = materializePublishedCanonical({ root, publishedSource: published.url });
  assert.equal(second.materialized, true);

  const loaded = loadPublishedCanonical({ root });
  assert.equal(loaded.provenance.checkout_identity, CHECKOUT_IDENTITY.materialized);
  assert.equal(loaded.provenance.published_main_head, moved);
  assert.equal(loaded.provenance.repository_head, moved);
  assert.equal(loaded.provenance.build_source_head, null, 'the refreshed record carries the second run\'s inputs, not the first\'s');
  assert.equal(git(root, 'rev-parse', BOOTSTRAP_ATTESTATION_REF), moved, 'both halves must name the newly captured head');
});

test('a failing build reports the underlying Git error, with the token redacted', t => {
  const root = sourceTreeWithoutGit(t);
  const absent = `file://${resolve(temporary(t, 'mml-diagnose-'), 'unreachable.git')}`;
  const token = 'ghp_SYNTHETIC_TEST_TOKEN_NEVER_REAL_0123456789';
  const run = env => spawnSync(process.execPath, [
    'scripts/materialize-canonical.mjs', '--root', root, '--published-source', absent,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

  // Without Git's own stderr, an expired token, a DNS failure and a proxy
  // refusal are the same single line, and the gate is undiagnosable in exactly
  // the situation it exists for.
  const withoutToken = run({ [SOURCE_TOKEN_VARIABLE]: '' });
  assert.equal(withoutToken.status, 1);
  const bare = JSON.parse(withoutToken.stderr);
  assert.equal(bare.status, 'CANONICAL_NOT_LOADED');
  assert.ok(bare.gitError && bare.gitError.length > 0, 'the underlying Git failure must be reported');
  assert.match(bare.hint, new RegExp(`\\$${SOURCE_TOKEN_VARIABLE} is not set`));

  // With one supplied, the hint points at expiry and scope instead, and nothing
  // in the output carries the value.
  const withToken = run({ [SOURCE_TOKEN_VARIABLE]: token });
  assert.equal(withToken.status, 1);
  const reported = JSON.parse(withToken.stderr);
  assert.match(reported.hint, /has not expired/);
  assert.ok(!withToken.stderr.includes(token), 'the token must never be echoed');
  assert.ok(!withToken.stdout.includes(token));
});
