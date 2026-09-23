import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_CONTRACT, loadPublishedCanonical, parseCanonicalManifest } from '../backend/bootstrap/index.mjs';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../backend/rules/supported-releases.mjs';
import { MACHINE_DELIVERY_GATE_NAMES, MACHINE_DELIVERY_SCHEMA, evaluateMachineDelivery } from '../backend/final/delivery-evaluator.mjs';

// Publishing 2026-09-23-v2 (docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md):
// everything the publication relies on, proven against a real Git history. The
// loaded release comes from the published Manifest on origin/main, so it is v1
// while the publication is still a PR and v2 once it is merged; both hold here.

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (cwd, path, content) => { mkdirSync(dirname(resolve(cwd, path)), { recursive: true }); writeFileSync(resolve(cwd, path), content); };
const commit = cwd => {
  git(cwd, 'add', '--all');
  git(cwd, '-c', 'user.name=v2 test', '-c', 'user.email=v2@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'v2 fixture');
  return git(cwd, 'rev-parse', 'HEAD');
};
const notLoaded = error => error.code === 'CANONICAL_NOT_LOADED';
const LOADED = PUBLISHED_CANONICAL.metadata;
const workingManifest = parseCanonicalManifest(readFileSync(resolve(root, BOOTSTRAP_CONTRACT.entryPoint), 'utf8')).metadata;
const proseVersion = readFileSync(resolve(root, 'docs/MASTER_RULES.md'), 'utf8').match(/^Version: (\S+)$/m)[1];

const v2Header = snapshot => [
  '---',
  `canonical_version: ${proseVersion}`,
  'canonical_status: PUBLISHED',
  `manifest_version: ${proseVersion}-manifest1`,
  `rules_snapshot_sha: ${snapshot}`,
  `machine_delivery_schema: ${MACHINE_DELIVERY_SCHEMA}`,
  '---',
].join('\n');
const withHeader = (manifest, header) => manifest.replace(/^---\n[\s\S]*?\n---/, header);

// A history shaped like the real publication: a snapshot commit that carries the
// current rule prose, then a Manifest commit that points at it.
function v2Repository(t) {
  const cwd = mkdtempSync(resolve(tmpdir(), 'mml-v2-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-b', 'main');
  for (const entry of PUBLISHED_CANONICAL.authority.map) {
    if (entry.path.endsWith('/')) put(cwd, `${entry.path}fixture.txt`, 'Implementation fixture only\n');
    else put(cwd, entry.path, entry.path.startsWith('docs/') ? readFileSync(resolve(root, entry.path), 'utf8') : 'Implementation fixture only\n');
  }
  const snapshot = commit(cwd);
  const manifest = withHeader(PUBLISHED_CANONICAL.manifest.replaceAll(LOADED.rules_snapshot_sha, snapshot), v2Header(snapshot));
  put(cwd, BOOTSTRAP_CONTRACT.entryPoint, manifest);
  git(cwd, 'update-ref', BOOTSTRAP_CONTRACT.publishedRef, commit(cwd));
  return { cwd, snapshot };
}

const gate = (status, blockers) => (blockers ? { status, blockers } : { status });
const completeGates = (overrides = {}) => ({ ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, gate('PASS')])), ...overrides });

test('the implementation opts into exactly the published v1 and the release the current rule prose declares', () => {
  assert.equal(proseVersion, '2026-09-23-v2');
  assert.deepEqual(SUPPORTED_CANONICAL_VERSIONS, ['2026-09-13-v1', proseVersion]);
  for (const path of ['docs/MASTER_RULES.md', 'docs/SOURCE_POLICY.md', 'docs/MOBILE_SYNTAX.md', 'docs/ACCEPTANCE_CRITERIA.md', 'docs/PENDING.md', 'docs/OFFICIAL_EVIDENCE.md']) {
    assert.ok(readFileSync(resolve(root, path), 'utf8').split('\n').includes(`Version: ${proseVersion}`), path);
  }
});

test('the Manifest publishes the prose release with the machine-delivery schema, and the loaded release is consistent with it', () => {
  assert.equal(workingManifest.canonical_version, proseVersion);
  assert.equal(workingManifest.machine_delivery_schema, MACHINE_DELIVERY_SCHEMA);
  const probe = evaluateMachineDelivery(completeGates(), { canonical: LOADED, requireCompleteGateMap: true });
  if (LOADED.canonical_version === proseVersion) {
    // Published: main loads exactly this Manifest, and machine delivery is authoritative.
    assert.deepEqual(LOADED, workingManifest);
    assert.equal(probe.authoritative, true);
  } else {
    // Still a PR: main loads v1, which has no schema and no machine-delivery authority.
    assert.equal(LOADED.canonical_version, '2026-09-13-v1');
    assert.equal(Object.hasOwn(LOADED, 'machine_delivery_schema'), false);
    assert.equal(probe.authoritative, false);
  }
});

test('the Manifest may declare the machine-delivery schema, and nothing else beyond the four fields', () => {
  const manifest = withHeader(PUBLISHED_CANONICAL.manifest, v2Header(LOADED.rules_snapshot_sha));
  assert.equal(parseCanonicalManifest(manifest).metadata.machine_delivery_schema, MACHINE_DELIVERY_SCHEMA);
  const bad = extra => withHeader(PUBLISHED_CANONICAL.manifest, v2Header(LOADED.rules_snapshot_sha).replace('\n---', `\n${extra}\n---`));
  assert.throws(() => parseCanonicalManifest(bad('delivery_policy: open')), notLoaded, 'an unknown field is refused');
  assert.throws(() => parseCanonicalManifest(bad(`machine_delivery_schema: ${MACHINE_DELIVERY_SCHEMA}`)), notLoaded, 'a duplicate is refused');
  const malformed = withHeader(PUBLISHED_CANONICAL.manifest, v2Header(LOADED.rules_snapshot_sha).replace(MACHINE_DELIVERY_SCHEMA, 'machine delivery'));
  assert.throws(() => parseCanonicalManifest(malformed), notLoaded, 'a malformed schema value is refused');
  const missing = withHeader(PUBLISHED_CANONICAL.manifest, v2Header(LOADED.rules_snapshot_sha).replace(/^manifest_version: .*\n/m, ''));
  assert.throws(() => parseCanonicalManifest(missing), notLoaded, 'a required field is still required');
});

test('a published v2 loads end to end and activates AUTOMATED_VALIDATED only on machine-determined gates', t => {
  const { cwd, snapshot } = v2Repository(t);
  const loaded = loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: SUPPORTED_CANONICAL_VERSIONS });
  assert.deepEqual(loaded.metadata, {
    canonical_version: proseVersion, canonical_status: 'PUBLISHED', manifest_version: `${proseVersion}-manifest1`,
    rules_snapshot_sha: snapshot, machine_delivery_schema: MACHINE_DELIVERY_SCHEMA,
  });
  assert.equal(loaded.documents.length, 6);

  // Everything a person must judge is still unresolved, and delivery proceeds.
  const listenFirst = evaluateMachineDelivery(completeGates({
    core3Completeness: gate('PENDING', ['CORE3_COMPLETENESS_UNRESOLVED']),
    versionDrift: gate('PENDING', ['VERSION_DIVERGENCE_REVIEW_REQUIRED']),
    originalAudio: gate('PENDING'), mobileAdaptation: gate('PENDING'), regression: gate('PENDING'),
    playerReadback: gate('NOT_RUN'), inGameAcceptance: gate('PENDING'),
  }), { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(listenFirst.authoritative, true);
  assert.equal(listenFirst.ready, true);
  assert.equal(listenFirst.lifecycle, 'AUTOMATED_VALIDATED');
  assert.deepEqual(listenFirst.non_blocking_pending.map(x => x.gate), ['core3Completeness', 'versionDrift', 'originalAudio', 'mobileAdaptation', 'regression']);
  assert.equal(listenFirst.human_reviewed, false);
  assert.equal(listenFirst.in_game_accepted, false);

  // A machine-determined defect still blocks, under the same published v2.
  const defect = evaluateMachineDelivery(completeGates({ core3Completeness: gate('FAIL', ['CORE3_INCOMPLETE']) }), { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(defect.ready, false);
  assert.deepEqual(defect.blocking.map(x => x.gate), ['core3Completeness']);

  // The captured real-song scenario still blocks on source, micro-timing and Lead.
  const kaiju = JSON.parse(readFileSync(new URL('./fixtures/kaiju-production-machine-delivery.json', import.meta.url), 'utf8'));
  const real = evaluateMachineDelivery(kaiju.gates, { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(real.ready, false);
  assert.deepEqual(real.blocking.map(x => x.gate), ['source', 'microTiming', 'leadPromotion']);
});

test('an implementation that has not opted into v2 refuses to load it', t => {
  const { cwd } = v2Repository(t);
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: '2026-09-13-v1' }), notLoaded);
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: ['2026-09-13-v1'] }), notLoaded);
});
