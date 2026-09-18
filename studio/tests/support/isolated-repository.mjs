// Test support: a private Git repository for probes that move the published
// discovery ref, republish a Manifest, or edit build sources.
//
// M6 background. `npm test` runs every test file in its own process, and almost
// every file bootstraps the published Canonical from the shared checkout's
// `refs/remotes/origin/main`. A test that rewrote that ref in the shared
// checkout, even briefly and even with a restore, handed a probe Manifest to
// whichever sibling process happened to resolve the ref inside the window. The
// loader then refused it (correctly) and an unrelated test file died with
// CANONICAL_NOT_LOADED. So: nothing here writes to the shared checkout. Probes
// get a `--shared` clone with its own refs, index and working tree; the clone
// reads the shared object store through alternates and writes its own objects
// only into itself.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const PUBLISHED_REF = 'refs/remotes/origin/main';
export const MANIFEST_PATH = 'docs/CANONICAL_MANIFEST.md';

// commit-tree needs a committer identity that a bare CI runner may not have.
const identity = {
  GIT_AUTHOR_NAME: 'Studio isolated probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'Studio isolated probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid',
};

export function gitIn(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity, ...env } }).trim();
}

// Read-only observation of a checkout's published discovery ref. Tests use it
// to prove they left the ref alone. The reflog records every update, so a
// transient rewrite-and-restore is visible after the restore; a delete-and-
// recreate that leaves the same value and entry count behind is caught by the
// identity (inode, size, change time) of the ref, its reflog and packed-refs,
// which read-only Git commands never touch.
const fileIdentity = path => {
  try {
    const stat = statSync(path, { bigint: true });
    return { ino: String(stat.ino), size: String(stat.size), ctimeNs: String(stat.ctimeNs), mtimeNs: String(stat.mtimeNs) };
  } catch { return null; }
};
export function observePublishedRef(root = repositoryRoot) {
  const value = gitIn(root, ['rev-parse', '--verify', '--end-of-options', `${PUBLISHED_REF}^{commit}`]);
  const reflog = gitIn(root, ['reflog', 'show', '--date=iso', '--format=%H %gd %gs', PUBLISHED_REF]);
  const files = Object.fromEntries([`logs/${PUBLISHED_REF}`, PUBLISHED_REF, 'packed-refs']
    .map(path => [path, fileIdentity(resolve(root, gitIn(root, ['rev-parse', '--git-path', path])))]));
  return { value, reflogEntries: reflog ? reflog.split('\n').length : 0, reflog, files };
}

// Default sources a build or loader needs from the working tree. The copies are
// the checkout's current files, so an uncommitted edit under test is exercised;
// Git identity (HEAD, the published ref, objects) comes from the clone.
const DEFAULT_SOURCES = ['scripts', 'studio/backend', 'studio/web', 'dist/core.js', 'package.json'];

export function isolatedRepository(t, { sources = DEFAULT_SOURCES } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mml-isolated-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = gitIn(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  const published = gitIn(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${PUBLISHED_REF}^{commit}`]);
  gitIn(repositoryRoot, ['clone', '--quiet', '--shared', '--no-checkout', repositoryRoot, dir]);
  // Detached HEAD at the checkout's commit; the published ref starts where the
  // checkout's does. Neither write touches the source repository.
  gitIn(dir, ['update-ref', '--no-deref', 'HEAD', head]);
  gitIn(dir, ['update-ref', PUBLISHED_REF, published]);
  for (const path of sources) cpSync(resolve(repositoryRoot, path), resolve(dir, path), { recursive: true });
  symlinkSync(resolve(repositoryRoot, 'node_modules'), resolve(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const git = (...args) => gitIn(dir, args);
  return {
    dir,
    head,
    published,
    git,
    publish: commit => git('update-ref', PUBLISHED_REF, commit),
    // A commit carrying `parent`'s exact tree: Git identity moves, sources do not.
    twinCommit: (parent, message) => git('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message),
    // `parent`'s tree with the Manifest blob replaced by `text`.
    republishManifest(text, message, parent = published) {
      const blobPath = resolve(dir, '.probe-manifest.md');
      writeFileSync(blobPath, text);
      const blob = git('hash-object', '-w', blobPath);
      const index = resolve(dir, '.probe-index');
      const withIndex = (...args) => gitIn(dir, args, { GIT_INDEX_FILE: index });
      withIndex('read-tree', parent);
      withIndex('update-index', '--add', '--cacheinfo', `100644,${blob},${MANIFEST_PATH}`);
      return git('commit-tree', withIndex('write-tree'), '-p', parent, '-m', message);
    },
  };
}
