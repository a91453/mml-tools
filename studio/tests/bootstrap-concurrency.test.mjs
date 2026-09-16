// M6 — Canonical bootstrap under parallel test processes.
//
// Every test file is its own process and bootstraps the published Canonical
// from the shared checkout's discovery ref. These tests pin down what the
// loader must guarantee in that setting and reproduce, deterministically and
// in a private repository, the two failure messages that were observed
// intermittently across the full suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublishedCanonical } from '../backend/bootstrap/index.mjs';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';
import { MANIFEST_PATH, PUBLISHED_REF, isolatedRepository, observePublishedRef, repositoryRoot } from './support/isolated-repository.mjs';

const SUPPORTED = '2026-09-13-v1';
const notLoaded = pattern => error => error.code === 'CANONICAL_NOT_LOADED' && pattern.test(error.message);

// The two probe Manifests that web-build-reproducibility publishes to prove
// the build fails closed. Published on the *shared* checkout's discovery ref,
// even briefly, they were read by sibling test processes: that was M6.
const unsupportedVersion = text => text
  .replace('canonical_version: 2026-09-13-v1', 'canonical_version: 2999-01-01-v9')
  .replace('manifest_version: 2026-09-13-v1-manifest1', 'manifest_version: 2999-01-01-v9-manifest1');
const unavailableSnapshot = text => text.replace(/rules_snapshot_sha: [0-9a-f]{40}/, `rules_snapshot_sha: ${'0'.repeat(40)}`);

test('M6 signature: both observed messages are the loader refusing a probe Manifest on the discovery ref', t => {
  const shared = observePublishedRef();
  const repo = isolatedRepository(t);
  const source = repo.git('show', `${repo.published}:${MANIFEST_PATH}`);

  repo.publish(repo.republishManifest(unsupportedVersion(source), 'probe: unsupported Canonical version'));
  assert.throws(() => loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED }),
    notLoaded(/^CANONICAL_NOT_LOADED: Implementation does not support the published Canonical version$/));

  repo.publish(repo.republishManifest(unavailableSnapshot(source), 'probe: unavailable rules snapshot'));
  assert.throws(() => loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED }),
    notLoaded(/^CANONICAL_NOT_LOADED: Unpinned snapshot locator: docs\/MASTER_RULES\.md$/));

  // The probes lived in the private repository only: the shared discovery ref
  // was never written, and a bootstrap from the checkout still loads the release.
  assert.deepEqual(observePublishedRef(), shared);
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.equal(loaded.provenance.published_main_head, shared.value);
});

test('an isolated repository carries the checkout Git identity but owns its refs', t => {
  const repo = isolatedRepository(t);
  const loaded = loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.equal(loaded.provenance.repository_head, PUBLISHED_CANONICAL.provenance.repository_head);
  assert.equal(loaded.provenance.published_main_head, PUBLISHED_CANONICAL.provenance.published_main_head);
  assert.equal(loaded.provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.deepEqual(loaded.documents.map(document => [document.path, document.blob_sha]), PUBLISHED_CANONICAL.documents.map(document => [document.path, document.blob_sha]));

  const shared = observePublishedRef();
  const twin = repo.twinCommit(repo.published, 'probe: advance published main');
  repo.publish(twin);
  assert.equal(repo.git('rev-parse', PUBLISHED_REF), twin);
  assert.deepEqual(observePublishedRef(), shared);
  const advanced = loadPublishedCanonical({ root: repo.dir, supportedCanonicalVersion: SUPPORTED });
  assert.equal(advanced.provenance.published_main_head, twin);
  assert.equal(advanced.provenance.manifest_commit, PUBLISHED_CANONICAL.provenance.manifest_commit);
  assert.deepEqual(advanced.metadata, PUBLISHED_CANONICAL.metadata);
});

// --- Git subprocess fan-out and repository binding -----------------------------

import { BOOTSTRAP_CONTRACT, gitEnvironment, gitSubprocess } from '../backend/bootstrap/index.mjs';

// A counting adapter around the production adapter: the same child processes
// run, and every call is recorded.
function countingGit() {
  const calls = [];
  const git = request => {
    calls.push({ root: request.root, args: request.args, input: request.input ?? null });
    return gitSubprocess(request);
  };
  return { git, calls };
}
const subcommand = args => args.find(arg => !arg.startsWith('-'));

test('one bootstrap is exactly eight bound Git subprocesses, and every read after discovery names a SHA', () => {
  const { git, calls } = countingGit();
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED, git });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(call => subcommand(call.args)), ['rev-parse', 'rev-parse', 'rev-parse', 'cat-file', 'rev-parse', 'log', 'merge-base', 'cat-file']);
  assert.ok(calls.every(call => call.root === repositoryRoot), 'every call is bound to the requested root');
  // The discovery ref is named exactly once; after that, only SHAs are read.
  const named = calls.map(call => `${call.args.join(' ')}\n${call.input ?? ''}`);
  assert.equal(named.filter(text => text.includes(BOOTSTRAP_CONTRACT.publishedRef)).length, 1);
  assert.equal(named.findIndex(text => text.includes(BOOTSTRAP_CONTRACT.publishedRef)), 2);
  for (const text of named.slice(3)) assert.doesNotMatch(text, /refs\/|HEAD/, text);
  // The batch reads name the pinned snapshot for every indexed resource.
  const batch = calls[7];
  assert.equal(subcommand(batch.args), 'cat-file');
  assert.deepEqual(batch.input.trim().split('\n'), loaded.authority.map.map(entry => `${loaded.metadata.rules_snapshot_sha}:${entry.path.replace(/\/$/, '')}`));
});

test('ambient Git redirection cannot move discovery away from the requested root', t => {
  // A second repository whose published Manifest is a probe. Pointing GIT_DIR,
  // GIT_WORK_TREE or injected config at it must not change what `root` loads.
  const other = isolatedRepository(t);
  const source = other.git('show', `${other.published}:${MANIFEST_PATH}`);
  other.publish(other.republishManifest(unsupportedVersion(source), 'probe: unsupported Canonical version'));
  assert.throws(() => loadPublishedCanonical({ root: other.dir, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not support/));

  const redirected = {
    GIT_DIR: `${other.dir}/.git`, GIT_WORK_TREE: other.dir, GIT_COMMON_DIR: `${other.dir}/.git`,
    GIT_OBJECT_DIRECTORY: `${other.dir}/.git/objects`, GIT_CEILING_DIRECTORIES: repositoryRoot,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_PARAMETERS: "'core.bare=true'", GIT_NAMESPACE: 'probe', GIT_INDEX_FILE: `${other.dir}/.probe-index`,
  };
  const previous = {};
  for (const [key, value] of Object.entries(redirected)) { previous[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  for (const key of Object.keys(redirected)) assert.ok(!(key in gitEnvironment()), `${key} must not reach Git`);
  assert.equal(gitEnvironment().GIT_OPTIONAL_LOCKS, '0');
  assert.equal(gitEnvironment().PATH, process.env.PATH);
  const loaded = loadPublishedCanonical({ root: repositoryRoot, supportedCanonicalVersion: SUPPORTED });
  assert.deepEqual(loaded.metadata, PUBLISHED_CANONICAL.metadata);
  assert.deepEqual(loaded.provenance, PUBLISHED_CANONICAL.provenance);
  assert.deepEqual(loaded.documents, PUBLISHED_CANONICAL.documents);
  // And the probe repository still loads as itself: binding is per call, not global.
  assert.throws(() => loadPublishedCanonical({ root: other.dir, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not support/));
});

test('a root inside a checkout, or a root that is not a checkout, does not bind to the enclosing repository', t => {
  assert.throws(() => loadPublishedCanonical({ root: `${repositoryRoot}studio`, supportedCanonicalVersion: SUPPORTED }), notLoaded(/does not bind to the requested checkout/));
  const empty = isolatedRepository(t, { sources: [] });
  assert.doesNotThrow(() => loadPublishedCanonical({ root: empty.dir, supportedCanonicalVersion: SUPPORTED }));
  assert.throws(() => loadPublishedCanonical({ root: `${empty.dir}/.git/objects`, supportedCanonicalVersion: SUPPORTED }), notLoaded(/./));
  for (const root of ['', 42, null]) assert.throws(() => loadPublishedCanonical({ root, supportedCanonicalVersion: SUPPORTED }), notLoaded(/./));
});
