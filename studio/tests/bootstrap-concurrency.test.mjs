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
