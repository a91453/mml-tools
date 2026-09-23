import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_CONTRACT } from '../../backend/bootstrap/index.mjs';
import { PUBLISHED_CANONICAL } from '../../backend/rules/index.mjs';
import { removeRepository } from './remove-repository.mjs';

// A Git history shaped like the publication of one Canonical release, for the
// activation tests. Nothing here touches this checkout: every repository is a
// temporary directory of its own.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const LOADED = PUBLISHED_CANONICAL.metadata;

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (cwd, path, content) => { mkdirSync(dirname(resolve(cwd, path)), { recursive: true }); writeFileSync(resolve(cwd, path), content); };
const commit = cwd => {
  git(cwd, 'add', '--all');
  git(cwd, '-c', 'user.name=release test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'release fixture');
  return git(cwd, 'rev-parse', 'HEAD');
};

export const releaseHeader = ({ version, schema, snapshot }) => [
  '---',
  `canonical_version: ${version}`,
  'canonical_status: PUBLISHED',
  `manifest_version: ${version}-manifest1`,
  `rules_snapshot_sha: ${snapshot}`,
  ...(schema ? [`machine_delivery_schema: ${schema}`] : []),
  '---',
].join('\n');

export const withHeader = (manifest, header) => manifest.replace(/^---\n[\s\S]*?\n---/, header);

/**
 * A snapshot commit that carries the current rule prose, then a Manifest commit
 * that points at it and declares `version` and `schema`. The loader checks each
 * indexed document's `Version:` header against the release, so the fixture
 * labels the prose `version`; what is under test is loading and activation, not
 * the prose of that release.
 */
export function publishedReleaseRepository(t, { version, schema }) {
  const cwd = mkdtempSync(resolve(tmpdir(), 'mml-release-'));
  t.after(() => removeRepository(cwd));
  git(cwd, 'init', '-b', 'main');
  for (const entry of PUBLISHED_CANONICAL.authority.map) {
    if (entry.path.endsWith('/')) put(cwd, `${entry.path}fixture.txt`, 'Implementation fixture only\n');
    else if (entry.path.startsWith('docs/')) put(cwd, entry.path, readFileSync(resolve(root, entry.path), 'utf8').replace(/^Version: \S+$/m, `Version: ${version}`));
    else put(cwd, entry.path, 'Implementation fixture only\n');
  }
  const snapshot = commit(cwd);
  const manifest = withHeader(PUBLISHED_CANONICAL.manifest.replaceAll(LOADED.rules_snapshot_sha, snapshot), releaseHeader({ version, schema, snapshot }));
  put(cwd, BOOTSTRAP_CONTRACT.entryPoint, manifest);
  git(cwd, 'update-ref', BOOTSTRAP_CONTRACT.publishedRef, commit(cwd));
  return { cwd, snapshot };
}
