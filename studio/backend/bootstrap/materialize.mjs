// Build-time Published Canonical materialization.
//
// Scope: the Agent Control Plane image only -- Railway project `mml-tools-allen`,
// service `mml-tools`. It is not the Permanent Studio Web release architecture
// and says nothing about `studio-web-permanent`, its pinned artifact, its trust
// bundle or `/studio-cache`.
//
// Why this exists
// ---------------
// `loadPublishedCanonical` reads the Manifest from `refs/remotes/origin/main`
// and every rule document from the pinned rules snapshot, out of local Git
// objects. Railway's GitHub source snapshot delivers the repository's *files*
// and no `.git`, so the deployed image had no object store to read: the service
// started, answered `/healthz`, served the legacy technical tools, and reported
// CANONICAL_NOT_LOADED for everything Canonical-aware. Fail-closed and correct,
// and useless.
//
// This module is the missing step. It runs once, at image build, and makes the
// local object store contain the published history the loader needs. It does
// not change what counts as published, and it is not a loader: the runtime
// loader is untouched, still offline, still reads only Git objects.
//
// What it must never become
// -------------------------
// The one substitution the bootstrap contract forbids is manufacturing
// `refs/remotes/origin/main` out of whatever the build context happened to
// carry -- HEAD, a branch, a working-tree Manifest -- because that lets any
// build declare itself published Canonical. So:
//
//   * the published identity is captured from the published repository itself,
//     by `ls-remote` on `BOOTSTRAP_CONTRACT.publishedBranch`, before anything is
//     read;
//   * `refs/remotes/origin/main` is set to that captured commit and nothing
//     else -- never to HEAD, never to the fetched tip if the branch moved
//     underneath us;
//   * the Manifest is read from that same captured commit, so the pinned
//     `rules_snapshot_sha` cannot come from one main and the rules from another;
//   * the snapshot commit the Manifest names must be present as a real object,
//     or the build fails. Current main is never substituted for it;
//   * no working-tree file is read as Canonical content at any point;
//   * every failure is terminal. There is no fallback path, and no mode in
//     which an unreachable published source quietly becomes "use what is here".
//
// Availability decides nothing. This function always contacts the published
// source it was given; if it cannot, it throws, and the build that called it
// fails rather than producing an image with an unusable Canonical-aware service.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BOOTSTRAP_CONTRACT,
  BOOTSTRAP_RECORD_PATH,
  CHECKOUT_IDENTITY,
  CanonicalNotLoadedError,
  gitEnvironment,
  loadPublishedCanonical,
  parseCanonicalManifest,
} from './index.mjs';

// The published repository, and the only default. A caller may name a different
// source -- deterministic regressions point this at a local fixture rather than
// depending on live GitHub -- but only by passing it explicitly, and the value
// used is recorded in the bootstrap record and printed by the build probe. The
// choice is never made for the caller by what happens to be reachable.
export const PUBLISHED_SOURCE = `https://github.com/${BOOTSTRAP_CONTRACT.repository}.git`;

// Where the branch is fetched to. The captured commit is what `publishedRef`
// ends up pointing at; this ref only keeps the fetched objects reachable in
// between, and is released immediately afterwards.
const FETCH_REF = 'refs/canonical-bootstrap/fetched-main';

const shaPattern = /^[0-9a-f]{40}$/;

const requireValue = (condition, reason) => {
  if (!condition) throw new CanonicalNotLoadedError(reason);
};

// One synchronous child process per call, bound to the target root, with the
// same redirecting-variable scrubbing the runtime loader uses. Tests may pass a
// wrapper to observe ordering or to fail a specific call; the build passes
// nothing. Unlike the loader's adapter this one is allowed to reach the network,
// which is exactly why it lives here and not in `index.mjs`.
export function materializeSubprocess({ root, args }) {
  return execFileSync('git', args, {
    cwd: root,
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Make `root` carry the published history, then prove the real loader can read it.
 *
 * Returns the loaded Published Canonical summary. Throws CanonicalNotLoadedError
 * if any step cannot be proven.
 */
export function materializePublishedCanonical({
  root,
  publishedSource = PUBLISHED_SOURCE,
  buildSourceHead = null,
  git = materializeSubprocess,
} = {}) {
  requireValue(typeof root === 'string' && root !== '' && existsSync(root), 'Materialization root must be an existing directory');
  requireValue(typeof publishedSource === 'string' && publishedSource !== '' && !publishedSource.startsWith('-'), 'The published source must be named explicitly');
  requireValue(buildSourceHead === null || shaPattern.test(buildSourceHead), 'Build source head must be a full commit SHA or null');

  const run = (args, reason) => {
    let output;
    try {
      output = git({ root, args });
    } catch (error) {
      throw new CanonicalNotLoadedError(reason, error);
    }
    return Buffer.isBuffer(output) ? output : Buffer.from(String(output ?? ''), 'utf8');
  };
  const line = (args, reason) => run(args, reason).toString('utf8').trim();
  const resolved = (revision, reason) => {
    const commit = line(['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], reason);
    requireValue(shaPattern.test(commit), reason);
    return commit;
  };

  // 1. An object store to put the published history in. An existing one is used
  //    as it stands; nothing here rewrites a real checkout's branches.
  if (!existsSync(resolve(root, '.git'))) {
    line(['init', '--quiet'], 'Could not create a Git object store for the Published Canonical');
  }
  requireValue(line(['rev-parse', '--git-dir'], 'Materialization root is not a Git repository') !== '', 'Materialization root is not a Git repository');

  // 2. Capture the published main identity FIRST, from the published source
  //    itself, and hold it for the rest of the load. Everything below names this
  //    commit. `main` may advance a second later; this identity does not, so no
  //    two reads in this build can come from two different published mains.
  const advertised = line(
    ['ls-remote', '--exit-code', publishedSource, BOOTSTRAP_CONTRACT.publishedBranch],
    'Published main could not be resolved from the published source',
  );
  const captured = advertised
    .split('\n')
    .map(entry => entry.match(/^([0-9a-f]{40})\s+(\S+)$/))
    .filter(entry => entry && entry[2] === BOOTSTRAP_CONTRACT.publishedBranch)
    .map(entry => entry[1]);
  requireValue(captured.length === 1, 'Published main did not advertise exactly one commit');
  const publishedHead = captured[0];

  // 3. Fetch the published history. The branch is fetched by name because that
  //    is what a server reliably serves, but the branch tip is never trusted as
  //    the identity: the captured commit must be present in what arrived, and
  //    that is what the discovery ref is set to. A main that advanced mid-build
  //    therefore changes nothing; a main that was rewritten past the captured
  //    commit fails closed.
  run(
    ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', publishedSource, `+${BOOTSTRAP_CONTRACT.publishedBranch}:${FETCH_REF}`],
    'Published main history could not be obtained from the published source',
  );
  requireValue(
    resolved(publishedHead, 'The captured published main commit is absent from the fetched history') === publishedHead,
    'The captured published main commit is absent from the fetched history',
  );
  line(['update-ref', BOOTSTRAP_CONTRACT.publishedRef, publishedHead], 'Could not record the published discovery ref');
  line(['update-ref', '-d', FETCH_REF], 'Could not release the fetch ref');

  // 4. Read the Manifest from the captured commit, and take the rules snapshot
  //    it declares. Not main, not HEAD, not the working tree.
  const manifest = run(
    ['cat-file', 'blob', `${publishedHead}:${BOOTSTRAP_CONTRACT.entryPoint}`],
    'The Published Manifest is absent from the captured published main commit',
  ).toString('utf8');
  const snapshot = parseCanonicalManifest(manifest).metadata.rules_snapshot_sha;

  // 5. The exact snapshot the Manifest pins must be a real commit here. If the
  //    fetched history does not reach it, the build fails: substituting main or
  //    HEAD for the reviewed snapshot is the failure mode this whole contract
  //    exists to prevent.
  requireValue(
    resolved(snapshot, `The pinned rules snapshot ${snapshot} is absent from the fetched history`) === snapshot,
    `The pinned rules snapshot ${snapshot} is absent from the fetched history`,
  );

  // 6. Checkout identity. A real checkout already has one and keeps it. A source
  //    tree that arrived without Git metadata has none, so HEAD is set to the
  //    captured published main head and the record below says that is where it
  //    came from.
  let existingHead = null;
  try {
    existingHead = resolved('HEAD', 'HEAD does not resolve');
  } catch {
    existingHead = null;
  }
  const materialized = existingHead === null;
  const recordPath = resolve(root, BOOTSTRAP_RECORD_PATH);
  if (materialized) {
    line(['update-ref', '--no-deref', 'HEAD', publishedHead], 'Could not record the materialized checkout identity');
    writeFileSync(recordPath, `${JSON.stringify({
      bootstrap_version: 1,
      checkout_identity: CHECKOUT_IDENTITY.materialized,
      published_main_head: publishedHead,
      published_source: publishedSource,
      build_source_head: buildSourceHead,
    }, null, 2)}\n`);
  } else {
    // A checkout with its own HEAD must not carry a record claiming otherwise.
    rmSync(recordPath, { force: true });
  }

  // 7. Prove it. The build's claim is not "the fetch succeeded" but "the real
  //    loader returns CANONICAL_LOADED from this object store", so the real
  //    loader is what answers. Any failure throws out of here.
  const loaded = loadPublishedCanonical({ root });
  requireValue(loaded.status === 'CANONICAL_LOADED', 'The materialized object store did not produce a Published Canonical load');
  requireValue(loaded.provenance.published_main_head === publishedHead, 'The load resolved a different published main than the one captured');
  requireValue(loaded.metadata.rules_snapshot_sha === snapshot, 'The load resolved a different rules snapshot than the Manifest pinned');

  return Object.freeze({
    status: loaded.status,
    materialized,
    published_source: publishedSource,
    metadata: loaded.metadata,
    provenance: loaded.provenance,
  });
}
