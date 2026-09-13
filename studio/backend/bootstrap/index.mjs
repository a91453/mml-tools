import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const shaPattern = /^[0-9a-f]{40}$/;
const authorityKinds = new Set(['CANONICAL_RULE_SOURCE', 'PENDING_HISTORICAL_INVENTORY', 'SUPPORTING_EVIDENCE', 'IMPLEMENTER', 'VERIFIER']);

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
    requireValue(/^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.'), 'Invalid snapshot path');
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

export function loadPublishedCanonical({ root = repositoryRoot, prHead = null, supportedCanonicalVersion = null } = {}) {
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 });
    const resolveCommit = ref => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    const repositoryHead = resolveCommit('HEAD');
    // Only the fetched published main is a discovery source. Never substitute a
    // worktree/PR Manifest, a standalone rules file, or a legacy Skill on failure.
    const publishedHead = resolveCommit(BOOTSTRAP_CONTRACT.publishedRef);
    const manifest = git('show', `${publishedHead}:${BOOTSTRAP_CONTRACT.entryPoint}`);
    const { metadata, entries } = parseCanonicalManifest(manifest);
    const snapshot = metadata.rules_snapshot_sha;
    requireValue(resolveCommit(snapshot) === snapshot, 'Snapshot is not an available commit');
    const manifestCommit = git('log', '-1', '--format=%H', publishedHead, '--', BOOTSTRAP_CONTRACT.entryPoint).trim();
    requireValue(shaPattern.test(manifestCommit) && snapshot !== manifestCommit, 'Invalid or self-referencing Manifest provenance');
    git('merge-base', '--is-ancestor', snapshot, manifestCommit);
    if (supportedCanonicalVersion !== null) requireValue(metadata.canonical_version === supportedCanonicalVersion, 'Implementation does not support the published Canonical version');
    if (prHead !== null) requireValue(shaPattern.test(prHead), 'PR head must come from actual PR metadata');

    const documents = [];
    for (const entry of entries) {
      const object = `${snapshot}:${entry.path.replace(/\/$/, '')}`;
      requireValue(git('cat-file', '-t', object).trim() === entry.type, `Missing or invalid snapshot resource: ${entry.path}`);
      if (['CANONICAL_RULE_SOURCE', 'PENDING_HISTORICAL_INVENTORY', 'SUPPORTING_EVIDENCE'].includes(entry.authority)) {
        const content = git('show', object);
        const status = entry.authority === 'SUPPORTING_EVIDENCE' ? 'CANONICAL SUPPORTING EVIDENCE' : 'PUBLISHED CANONICAL';
        requireValue(content.split('\n').includes(`Version: ${metadata.canonical_version}`), `Document version mismatch: ${entry.path}`);
        requireValue(content.split('\n').includes(`Status: ${status}`), `Document publication status mismatch: ${entry.path}`);
        documents.push({ ...entry, blob_sha: git('rev-parse', object).trim(), content });
      }
    }
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
