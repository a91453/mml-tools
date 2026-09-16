import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const shaPattern = /^[0-9a-f]{40}$/;
const authorityKinds = new Set(['CANONICAL_RULE_SOURCE', 'PENDING_HISTORICAL_INVENTORY', 'SUPPORTING_EVIDENCE', 'IMPLEMENTER', 'VERIFIER']);
const documentAuthorities = new Set(['CANONICAL_RULE_SOURCE', 'PENDING_HISTORICAL_INVENTORY', 'SUPPORTING_EVIDENCE']);

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

// Discovery/consumer contract only. Musical policy belongs to the loaded documents.
export const BOOTSTRAP_CONTRACT = freeze({
  repository: 'a91453/mml-tools',
  entryPoint: 'docs/CANONICAL_MANIFEST.md',
  publishedRef: 'refs/remotes/origin/main',
  role: 'CONSUMER',
  localSkillAuthority: 'WORKFLOW_ONLY',
  executableContractDefinesRules: false,
  failureStatus: 'CANONICAL_NOT_LOADED',
  legacyFallbackAllowed: false,
});

export class CanonicalNotLoadedError extends Error {
  constructor(reason, cause) {
    super(`CANONICAL_NOT_LOADED: ${reason}`, { cause });
    this.name = 'CanonicalNotLoadedError';
    this.code = 'CANONICAL_NOT_LOADED';
  }
}

const requireValue = (condition, reason) => {
  if (!condition) throw new CanonicalNotLoadedError(reason);
};

// Parse the published Manifest's index format, never the music rules it indexes.
export function parseCanonicalManifest(text) {
  const header = text.match(/^---\n([\s\S]*?)\n---\n/);
  requireValue(header, 'Manifest metadata is missing');
  const metadata = {};
  for (const line of header[1].split('\n')) {
    const field = line.match(/^([a-z_]+): ([A-Za-z0-9-]+)$/);
    requireValue(field && !Object.hasOwn(metadata, field[1]), `Invalid or duplicate Manifest metadata: ${line}`);
    metadata[field[1]] = field[2];
  }
  requireValue(Object.keys(metadata).sort().join(',') === 'canonical_status,canonical_version,manifest_version,rules_snapshot_sha', 'Unexpected Manifest metadata fields');
  requireValue(metadata.canonical_status === 'PUBLISHED', 'Manifest does not designate a published release');
  requireValue(/^\d{4}-\d{2}-\d{2}-v\d+$/.test(metadata.canonical_version), 'Invalid Canonical version');
  requireValue(metadata.manifest_version.startsWith(`${metadata.canonical_version}-manifest`), 'Manifest version does not identify this release');
  requireValue(shaPattern.test(metadata.rules_snapshot_sha), 'Rules snapshot must be a full commit SHA');

  const map = text.match(/<!-- authority-map:start -->\n([\s\S]*?)\n<!-- authority-map:end -->/);
  requireValue(map, 'Manifest authority map is missing');
  const entries = map[1].split('\n').slice(2).map(line => {
    const row = line.match(/^\| \[([^\]]+)\]\(([^)]+)\) \| `([A-Z_]+)` \| [^|]+ \|$/);
    requireValue(row, `Invalid Manifest authority row: ${line}`);
    const [, path, url, authority] = row;
    requireValue(/^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.includes('//') && !path.split('/').some(part => part === '..' || part === '.'), 'Invalid snapshot path');
    requireValue(authorityKinds.has(authority), `Unknown authority: ${authority}`);
    const type = path.endsWith('/') ? 'tree' : 'blob';
    requireValue(url === `https://github.com/${BOOTSTRAP_CONTRACT.repository}/${type}/${metadata.rules_snapshot_sha}/${path}`, `Unpinned snapshot locator: ${path}`);
    if (authority === 'CANONICAL_RULE_SOURCE') requireValue(path.startsWith('docs/') && path.endsWith('.md'), 'Rule sources must be human-readable documents');
    return { path, url, authority, type };
  });
  requireValue(new Set(entries.map(entry => entry.path)).size === entries.length, 'Duplicate snapshot locators');
  for (const kind of authorityKinds) requireValue(entries.some(entry => entry.authority === kind), `Missing authority group: ${kind}`);
  return freeze({ metadata, entries });
}

// --- Git access ---------------------------------------------------------------
//
// Every Git command is bound to the requested repository root. Ambient variables
// that would point Git at another repository, object store, index or namespace
// are dropped, so neither a parent process (a hook, a wrapper, a test harness)
// nor a caller-supplied environment can redirect discovery. Objects are read as
// stored, without replacement refs, and the Manifest pathspec is literal.
// Configuration injection (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT/KEY/VALUE) is
// deliberately left in place: it is the only per-process channel for
// `safe.directory` in a foreign-owned checkout, and no configuration value can
// move discovery past the root binding below or change object content once
// replacement refs are disabled; at worst it makes the load fail closed.
const REDIRECTING_GIT_ENVIRONMENT = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|IMPLICIT_WORK_TREE|PREFIX|GRAFT_FILE|SHALLOW_FILE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|LITERAL_PATHSPECS)$/;

export function gitEnvironment(environment = process.env) {
  const bound = {};
  for (const [key, value] of Object.entries(environment)) if (!REDIRECTING_GIT_ENVIRONMENT.test(key)) bound[key] = value;
  bound.GIT_OPTIONAL_LOCKS = '0';
  return bound;
}

// The production adapter: one synchronous child process per call. Tests may
// pass a wrapper to count, delay or fail calls; production callers pass nothing.
export function gitSubprocess({ root, args, input }) {
  const options = { cwd: root, env: gitEnvironment(), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 };
  if (input !== undefined) options.input = input;
  return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', ...args], options);
}

// `git cat-file --batch` output: for each requested name, in request order,
// `<sha> <type> <size>\n` followed by exactly `size` bytes and a newline. It is
// parsed on bytes, so a short read, a `missing`/`ambiguous` line, a type other
// than the one the Manifest declares, or trailing data all fail closed.
function readObjects(run, requests) {
  const output = run(['cat-file', '--batch'], `${requests.map(request => request.name).join('\n')}\n`);
  const objects = [];
  let offset = 0;
  for (const request of requests) {
    const end = output.indexOf(0x0a, offset);
    const header = end === -1 ? null : output.subarray(offset, end).toString('utf8').match(/^([0-9a-f]{40}) (blob|tree|commit|tag) (\d+)$/);
    requireValue(header && header[2] === request.type, `Missing or invalid snapshot resource: ${request.label}`);
    const size = Number(header[3]);
    const start = end + 1;
    requireValue(output.length > start + size && output[start + size] === 0x0a, `Truncated snapshot resource: ${request.label}`);
    objects.push({ sha: header[1], content: output.subarray(start, start + size) });
    offset = start + size + 1;
  }
  requireValue(offset === output.length, 'Unexpected data after the requested snapshot resources');
  return objects;
}

const samePath = (left, right) => realpathSync(left) === realpathSync(right);

// One call is one complete, independent load. Nothing is memoised across calls:
// a caller receives an immutable result built entirely from Git reads made for
// that call, so no caller can observe another caller's partial state, and a
// failed load leaves nothing behind for a later call to reuse. A failure throws
// CanonicalNotLoadedError to that caller and never retries a Git command; a
// later, independent call starts from scratch. `rules/index.mjs` calls once at
// module evaluation, so a failure there fails every importer in that process.
export function loadPublishedCanonical({ root = repositoryRoot, prHead = null, supportedCanonicalVersion = null, git = gitSubprocess } = {}) {
  try {
    requireValue(typeof root === 'string' && root !== '', 'Repository root must be a path');
    const run = (args, input) => {
      const output = git({ root, args, input });
      return Buffer.isBuffer(output) ? output : Buffer.from(String(output), 'utf8');
    };
    const line = args => run(args).toString('utf8').trim();
    const resolveCommit = ref => {
      const commit = line(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
      requireValue(shaPattern.test(commit), `Unresolvable commit: ${ref}`);
      return commit;
    };

    // The repository Git finds from `root` must be `root` itself, never an
    // enclosing checkout that happens to contain it.
    requireValue(samePath(line(['rev-parse', '--show-toplevel']), root), 'Repository root does not bind to the requested checkout');
    const repositoryHead = resolveCommit('HEAD');
    // Only the fetched published main is a discovery source. Never substitute a
    // worktree/PR Manifest, a standalone rules file, or a legacy Skill on failure.
    // The ref is resolved to one commit first; every later read names that commit
    // or the snapshot by SHA, so a ref moving mid-load cannot mix two Manifests.
    const publishedHead = resolveCommit(BOOTSTRAP_CONTRACT.publishedRef);
    const [manifestObject] = readObjects(run, [{ name: `${publishedHead}:${BOOTSTRAP_CONTRACT.entryPoint}`, type: 'blob', label: BOOTSTRAP_CONTRACT.entryPoint }]);
    const manifest = manifestObject.content.toString('utf8');
    const { metadata, entries } = parseCanonicalManifest(manifest);
    const snapshot = metadata.rules_snapshot_sha;
    requireValue(resolveCommit(snapshot) === snapshot, 'Snapshot is not an available commit');
    const manifestCommit = line(['log', '-1', '--format=%H', publishedHead, '--', BOOTSTRAP_CONTRACT.entryPoint]);
    requireValue(shaPattern.test(manifestCommit) && snapshot !== manifestCommit, 'Invalid or self-referencing Manifest provenance');
    run(['merge-base', '--is-ancestor', snapshot, manifestCommit]);
    if (supportedCanonicalVersion !== null) requireValue(metadata.canonical_version === supportedCanonicalVersion, 'Implementation does not support the published Canonical version');
    if (prHead !== null) requireValue(shaPattern.test(prHead), 'PR head must come from actual PR metadata');

    // Every indexed resource is read from the pinned snapshot in one batch.
    const objects = readObjects(run, entries.map(entry => ({ name: `${snapshot}:${entry.path.replace(/\/$/, '')}`, type: entry.type, label: entry.path })));
    const documents = [];
    entries.forEach((entry, index) => {
      if (!documentAuthorities.has(entry.authority)) return;
      const content = objects[index].content.toString('utf8');
      const status = entry.authority === 'SUPPORTING_EVIDENCE' ? 'CANONICAL SUPPORTING EVIDENCE' : 'PUBLISHED CANONICAL';
      requireValue(content.split('\n').includes(`Version: ${metadata.canonical_version}`), `Document version mismatch: ${entry.path}`);
      requireValue(content.split('\n').includes(`Status: ${status}`), `Document publication status mismatch: ${entry.path}`);
      documents.push({ ...entry, blob_sha: objects[index].sha, content });
    });
    const paths = kind => entries.filter(entry => entry.authority === kind).map(entry => entry.path);
    return freeze({
      status: 'CANONICAL_LOADED',
      metadata,
      provenance: { manifest_commit: manifestCommit, repository_head: repositoryHead, pr_head: prHead, published_main_head: publishedHead },
      authority: {
        entryPoint: BOOTSTRAP_CONTRACT.entryPoint,
        humanReadable: paths('CANONICAL_RULE_SOURCE'),
        pendingHistoricalInventory: paths('PENDING_HISTORICAL_INVENTORY'),
        supportingEvidence: paths('SUPPORTING_EVIDENCE'),
        implementers: paths('IMPLEMENTER'),
        verifiers: paths('VERIFIER'),
        map: entries,
        localSkillDefinesRules: false,
        executableContractDefinesRules: false,
      },
      manifest,
      documents,
    });
  } catch (error) {
    if (error instanceof CanonicalNotLoadedError) throw error;
    throw new CanonicalNotLoadedError('Published Manifest, snapshot, or required Git history is unavailable; no legacy fallback', error);
  }
}
