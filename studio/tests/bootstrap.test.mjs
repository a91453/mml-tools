import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_CONTRACT, loadPublishedCanonical, parseCanonicalManifest } from '../backend/bootstrap/index.mjs';
import { EFFECTIVE_RULESET, PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';
import { MML_ENGINE_ADAPTER } from '../backend/mml/index.mjs';
import { removeRepository } from './support/remove-repository.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entryPoint = BOOTSTRAP_CONTRACT.entryPoint;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const read = path => readFileSync(resolve(root, path), 'utf8');
const put = (cwd, path, content) => {
  mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
  writeFileSync(resolve(cwd, path), content);
};
const commit = cwd => {
  git(cwd, 'add', '--all');
  git(cwd, '-c', 'user.name=Bootstrap test', '-c', 'user.email=bootstrap@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Bootstrap fixture');
  return git(cwd, 'rev-parse', 'HEAD');
};
const publish = cwd => git(cwd, 'update-ref', BOOTSTRAP_CONTRACT.publishedRef, commit(cwd));
const notLoaded = error => error.code === 'CANONICAL_NOT_LOADED';

// Real Git histories exercise snapshot/provenance failure modes. No music-policy
// fixture is maintained here: document bytes are read from the published snapshot.
function fixture(t, { omitPath, transformDocument = text => text, transformManifest = text => text } = {}) {
  const cwd = mkdtempSync(resolve(tmpdir(), 'mml-bootstrap-'));
  t.after(() => removeRepository(cwd));
  git(cwd, 'init', '-b', 'main');
  for (const entry of PUBLISHED_CANONICAL.authority.map) {
    if (entry.path === omitPath) continue;
    const document = PUBLISHED_CANONICAL.documents.find(item => item.path === entry.path);
    put(cwd, entry.path.endsWith('/') ? `${entry.path}fixture.txt` : entry.path,
      document ? transformDocument(document.content, entry.path) : 'Implementation fixture only\n');
  }
  put(cwd, 'skills/mabinogi-mobile-mml/legacy-master.md', 'Legacy fallback must never be loaded\n');
  const snapshot = commit(cwd);
  const manifest = transformManifest(PUBLISHED_CANONICAL.manifest.replaceAll(PUBLISHED_CANONICAL.metadata.rules_snapshot_sha, snapshot));
  put(cwd, entryPoint, manifest);
  const manifestCommit = commit(cwd);
  git(cwd, 'update-ref', BOOTSTRAP_CONTRACT.publishedRef, manifestCommit);
  return { cwd, snapshot, manifestCommit };
}

test('Skill invocation runs the shared Manifest loader and returns all pinned documents', () => {
  const skill = read('skills/mabinogi-mobile-mml/SKILL.md');
  assert.ok(skill.includes(entryPoint));
  const command = skill.match(/`node (scripts\/[^`]+\.mjs)`/);
  assert.ok(command, 'Skill must provide a runnable Bootstrap invocation');
  const loaded = JSON.parse(execFileSync(process.execPath, [command[1]], { cwd: root, encoding: 'utf8' }));
  assert.equal(loaded.status, 'CANONICAL_LOADED');
  assert.equal(loaded.authority.entryPoint, entryPoint);
  assert.equal(loaded.manifest, PUBLISHED_CANONICAL.manifest);
  assert.equal(loaded.documents.length, 6);
  assert.equal(BOOTSTRAP_CONTRACT.localSkillAuthority, 'WORKFLOW_ONLY');
  assert.equal(loaded.authority.localSkillDefinesRules, false);
  assert.equal(BOOTSTRAP_CONTRACT.legacyFallbackAllowed, false);
});

test('contract and adapter consume the exact Manifest authority map, keeping PENDING outside rule sources', () => {
  const entries = parseCanonicalManifest(PUBLISHED_CANONICAL.manifest).entries;
  assert.deepEqual(EFFECTIVE_RULESET.authority.map, entries);
  assert.deepEqual(EFFECTIVE_RULESET.authority.humanReadable, entries.filter(item => item.authority === 'CANONICAL_RULE_SOURCE').map(item => item.path));
  assert.equal(EFFECTIVE_RULESET.authority.humanReadable.length, 4);
  assert.ok(!EFFECTIVE_RULESET.authority.humanReadable.includes('docs/PENDING.md'));
  assert.deepEqual(EFFECTIVE_RULESET.authority.pendingHistoricalInventory, ['docs/PENDING.md']);
  assert.deepEqual(EFFECTIVE_RULESET.authority.supportingEvidence, ['docs/OFFICIAL_EVIDENCE.md']);
  assert.equal(EFFECTIVE_RULESET.authority.executableContractDefinesRules, false);
  assert.equal(MML_ENGINE_ADAPTER.rulesEntryPoint, entryPoint);
  assert.equal(MML_ENGINE_ADAPTER.rulesAuthority, EFFECTIVE_RULESET.authority.humanReadable);
  assert.equal(MML_ENGINE_ADAPTER.canonical, EFFECTIVE_RULESET.canonical);
  assert.doesNotMatch(MML_ENGINE_ADAPTER.name + MML_ENGINE_ADAPTER.migrationStatus, /draft2|candidate/i);
});

test('loaded rule text is snapshot-exact and immutable, regardless of worktree edits', t => {
  const { cwd, snapshot } = fixture(t);
  put(cwd, 'docs/MASTER_RULES.md', 'Uncommitted local override\n');
  const loaded = loadPublishedCanonical({ root: cwd });
  const master = loaded.documents.find(item => item.path === 'docs/MASTER_RULES.md');
  assert.equal(master.content.trim(), git(cwd, 'show', `${snapshot}:docs/MASTER_RULES.md`));
  assert.equal(master.blob_sha, git(cwd, 'rev-parse', `${snapshot}:docs/MASTER_RULES.md`));
  assert.throws(() => loaded.authority.humanReadable.push('skills/legacy.md'), TypeError);
  assert.throws(() => { loaded.metadata.rules_snapshot_sha = loaded.provenance.repository_head; }, TypeError);
});

test('repository/main advancement preserves rules snapshot, Canonical version and Manifest commit', t => {
  const { cwd, snapshot, manifestCommit } = fixture(t);
  const before = loadPublishedCanonical({ root: cwd });
  put(cwd, 'unrelated.txt', 'An implementation-only commit\n');
  publish(cwd);
  const after = loadPublishedCanonical({ root: cwd, prHead: manifestCommit });
  assert.notEqual(before.provenance.repository_head, after.provenance.repository_head);
  assert.notEqual(before.provenance.published_main_head, after.provenance.published_main_head);
  assert.equal(after.provenance.manifest_commit, manifestCommit);
  assert.equal(after.provenance.pr_head, manifestCommit);
  assert.notEqual(after.provenance.pr_head, after.provenance.repository_head);
  assert.equal(after.metadata.rules_snapshot_sha, snapshot);
  assert.deepEqual(after.metadata, before.metadata);
});

test('an unmerged PR Manifest cannot replace the published main entry point', t => {
  const { cwd, snapshot, manifestCommit } = fixture(t);
  git(cwd, 'switch', '-c', 'unpublished-candidate');
  put(cwd, entryPoint, 'Unpublished candidate authority\n');
  const prHead = commit(cwd);
  const loaded = loadPublishedCanonical({ root: cwd, prHead });
  assert.equal(loaded.metadata.rules_snapshot_sha, snapshot);
  assert.equal(loaded.provenance.manifest_commit, manifestCommit);
  assert.equal(loaded.provenance.pr_head, prHead);
  assert.equal(loaded.provenance.published_main_head, manifestCommit);
});

for (const [name, options] of [
  ['malformed Manifest', { transformManifest: () => '# Invalid Manifest\n' }],
  ['unpublished status', { transformManifest: text => text.replace('canonical_status: PUBLISHED', 'canonical_status: CANDIDATE') }],
  ['missing snapshot document', { omitPath: 'docs/SOURCE_POLICY.md' }],
  ['document version mismatch', { transformDocument: text => text.replace(/^Version: \S+$/m, 'Version: outdated') }],
  ['document status mismatch', { transformDocument: text => text.replace('Status: PUBLISHED CANONICAL', 'Status: DRAFT') }],
  ['unknown snapshot commit', { transformManifest: text => text.replaceAll(text.match(/rules_snapshot_sha: ([0-9a-f]{40})/)[1], 'a'.repeat(40)) }],
  ['unversioned resource link', { transformManifest: text => text.replace(/\/blob\/[0-9a-f]{40}\//, '/blob/main/') }],
]) {
  test(`${name} fails with CANONICAL_NOT_LOADED even when legacy rules are available`, t => {
    const { cwd } = fixture(t, options);
    assert.ok(existsSync(resolve(cwd, 'skills/mabinogi-mobile-mml/legacy-master.md')));
    assert.throws(() => loadPublishedCanonical({ root: cwd }), notLoaded);
  });
}

test('missing Manifest cannot fall back to standalone documents or legacy Skill', t => {
  const { cwd, snapshot } = fixture(t);
  git(cwd, 'update-ref', BOOTSTRAP_CONTRACT.publishedRef, snapshot);
  assert.throws(() => loadPublishedCanonical({ root: cwd }), notLoaded);
});

test('missing fetched main cannot fall back to the checkout Manifest', t => {
  const { cwd } = fixture(t);
  git(cwd, 'update-ref', '-d', BOOTSTRAP_CONTRACT.publishedRef);
  assert.ok(existsSync(resolve(cwd, entryPoint)));
  assert.throws(() => loadPublishedCanonical({ root: cwd }), notLoaded);
});

test('an unchanged implementation cannot silently adopt a different Canonical release', t => {
  const { cwd } = fixture(t);
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: 'unsupported-release' }), notLoaded);
});

test('real Studio imports and Bootstrap CLI stop when published discovery is unavailable', t => {
  const { cwd } = fixture(t);
  for (const path of ['package.json', 'dist/core.js', 'studio/backend/bootstrap/index.mjs', 'studio/backend/rules/index.mjs', 'studio/backend/rules/supported-releases.mjs', 'studio/backend/mml/index.mjs', 'studio/backend/mml/parser.mjs', 'scripts/bootstrap-canonical.mjs']) put(cwd, path, read(path));
  git(cwd, 'update-ref', '-d', BOOTSTRAP_CONTRACT.publishedRef);
  const code = `try { await import('./studio/backend/mml/index.mjs'); process.exitCode = 2; } catch (error) { console.log(JSON.stringify({ code: error.code })); }`;
  const adapter = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
  assert.equal(adapter.status, 0, adapter.stderr);
  assert.equal(JSON.parse(adapter.stdout).code, 'CANONICAL_NOT_LOADED');
  const env = { ...process.env };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_EVENT_PATH;
  const cli = spawnSync(process.execPath, ['scripts/bootstrap-canonical.mjs'], { cwd, encoding: 'utf8', env });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(JSON.parse(cli.stderr).status, 'CANONICAL_NOT_LOADED');
  assert.equal(JSON.parse(cli.stderr).legacyFallbackAllowed, false);
});

// The migration these two tests guard moved the rules into the first published
// release, so they compare against that release's snapshot. Later releases
// change no policy value (2026-09-23-v2 changes delivery only), which the first
// test also keeps true.
const FIRST_RULES_SNAPSHOT = '0a172900a01fdf39c2e9e84cf176961320b779ea';

test('migration changes no non-authority executable policy values', async () => {
  const original = git(root, 'show', `${FIRST_RULES_SNAPSHOT}:studio/backend/rules/index.mjs`);
  const moduleText = original.replace("from '../../../dist/core.js'", `from '${new URL('../../dist/core.js', import.meta.url).href}'`);
  const baseline = await import(`data:text/javascript,${encodeURIComponent(moduleText)}`);
  const { authority: oldAuthority, ...oldPolicy } = baseline.EFFECTIVE_RULESET;
  const { authority: newAuthority, canonical, ...newPolicy } = EFFECTIVE_RULESET;
  assert.deepEqual(newPolicy, oldPolicy);
});

test('Lead Role historical evidence is preserved byte-for-byte outside the live Skill', () => {
  for (const [directory, name] of [['patches', '2026-09-10-lead-role.md'], ['references', '2026-09-10-lead-role-master-rules.md']]) {
    const oldPath = `skills/mabinogi-mobile-mml/${directory}/${name}`;
    const original = execFileSync('git', ['show', `${FIRST_RULES_SNAPSHOT}:${oldPath}`], { cwd: root });
    assert.deepEqual(readFileSync(resolve(root, 'docs/history/lead-role-2026-09-10', name)), original);
    assert.equal(existsSync(resolve(root, oldPath)), false);
  }
});
