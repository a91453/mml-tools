import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_CONTRACT, loadPublishedCanonical, parseCanonicalManifest } from '../backend/bootstrap/index.mjs';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../backend/rules/supported-releases.mjs';
import {
  DELIVERY_FLAG,
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  evaluateMachineDelivery,
  machineDeliveryAuthority,
} from '../backend/final/delivery-evaluator.mjs';
import { publishedReleaseRepository, releaseHeader, withHeader } from './support/published-release-fixture.mjs';

// Publishing 2026-09-23-v3 (docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md,
// "Change record for 2026-09-23-v3"): everything that publication will rely on,
// proven against a real Git history before the published Manifest moves.
//
// The loaded release comes from the published Manifest on origin/main. It is v2
// while this prose and its implementation are under review and while the
// publication is a pull request, and v3 once that is merged. Every test here
// holds in all three states; none of them names which release is loaded.

const root = fileURLToPath(new URL('../../', import.meta.url));
const notLoaded = error => error.code === 'CANONICAL_NOT_LOADED';
const LOADED = PUBLISHED_CANONICAL.metadata;
const workingManifest = parseCanonicalManifest(readFileSync(resolve(root, BOOTSTRAP_CONTRACT.entryPoint), 'utf8')).metadata;
const proseVersion = readFileSync(resolve(root, 'docs/MASTER_RULES.md'), 'utf8').match(/^Version: (\S+)$/m)[1];
const V2 = '2026-09-23-v2';
const SCHEMA_OF = Object.freeze({ [V2]: MACHINE_DELIVERY_SCHEMA_V1, [proseVersion]: MACHINE_DELIVERY_SCHEMA_V2 });

const gate = (status, blockers) => (blockers ? { status, blockers } : { status });
const completeGates = (overrides = {}) => ({ ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, gate('PASS')])), ...overrides });
const RELEASE_ONLY = gate('PENDING', ['MICRO_TIMING_CLASSIFICATION_UNKNOWN', 'MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE', 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED', 'MICRO_TIMING_RELEASE_PROVISIONAL']);
const LEAD_UNVERIFIED = gate('PENDING', ['LEAD_PROMOTION_EVIDENCE_REQUIRED', 'LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING']);

test('the implementation opts into exactly v1, v2 and the release the current rule prose declares', () => {
  assert.equal(proseVersion, '2026-09-23-v3');
  assert.deepEqual(SUPPORTED_CANONICAL_VERSIONS, ['2026-09-13-v1', V2, proseVersion]);
  for (const path of ['docs/MASTER_RULES.md', 'docs/SOURCE_POLICY.md', 'docs/MOBILE_SYNTAX.md', 'docs/ACCEPTANCE_CRITERIA.md', 'docs/PENDING.md', 'docs/OFFICIAL_EVIDENCE.md']) {
    assert.ok(readFileSync(resolve(root, path), 'utf8').split('\n').includes(`Version: ${proseVersion}`), path);
  }
});

test('the working Manifest names v2 or the prose release with its own schema, and the loaded release is consistent with it', () => {
  assert.ok(Object.hasOwn(SCHEMA_OF, workingManifest.canonical_version), workingManifest.canonical_version);
  assert.equal(workingManifest.machine_delivery_schema, SCHEMA_OF[workingManifest.canonical_version]);
  // Either release is authoritative, each under its own schema.
  const probe = evaluateMachineDelivery(completeGates(), { canonical: LOADED, requireCompleteGateMap: true });
  assert.equal(probe.authoritative, true);
  assert.equal(probe.schema, SCHEMA_OF[LOADED.canonical_version]);
  if (LOADED.canonical_version === workingManifest.canonical_version) {
    // Published (or not yet proposed): main loads exactly this Manifest.
    assert.deepEqual(LOADED, workingManifest);
  } else {
    // The publication is a pull request: main still loads v2.
    assert.equal(LOADED.canonical_version, V2);
    assert.equal(workingManifest.canonical_version, proseVersion);
  }
});

test('the Manifest may declare the @2 schema; an unknown schema parses but activates nothing', () => {
  const header = releaseHeader({ version: proseVersion, schema: MACHINE_DELIVERY_SCHEMA_V2, snapshot: LOADED.rules_snapshot_sha });
  const metadata = parseCanonicalManifest(withHeader(PUBLISHED_CANONICAL.manifest, header)).metadata;
  assert.equal(metadata.machine_delivery_schema, MACHINE_DELIVERY_SCHEMA_V2);
  assert.equal(machineDeliveryAuthority(metadata).active, true);
  const future = parseCanonicalManifest(withHeader(PUBLISHED_CANONICAL.manifest, header.replace('machine-delivery@2', 'machine-delivery@3'))).metadata;
  assert.equal(machineDeliveryAuthority(future).active, false);
  assert.deepEqual(machineDeliveryAuthority(future).blockers, ['MACHINE_DELIVERY_SCHEMA_NOT_ACTIVATED']);
  // Classified under the stricter @1 table, and not authoritative.
  const projection = evaluateMachineDelivery(completeGates({ microTiming: RELEASE_ONLY }), { canonical: future, requireCompleteGateMap: true });
  assert.equal(projection.schema, MACHINE_DELIVERY_SCHEMA_V1);
  assert.deepEqual(projection.blocking.map(x => x.gate), ['microTiming']);
  assert.equal(projection.ready, false);
});

test('a published v3 loads end to end and delivers release-side micro-timing and unverified Lead for listening first', t => {
  const { cwd, snapshot } = publishedReleaseRepository(t, { version: proseVersion, schema: MACHINE_DELIVERY_SCHEMA_V2 });
  const loaded = loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: SUPPORTED_CANONICAL_VERSIONS });
  assert.deepEqual(loaded.metadata, {
    canonical_version: proseVersion, canonical_status: 'PUBLISHED', manifest_version: `${proseVersion}-manifest1`,
    rules_snapshot_sha: snapshot, machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V2,
  });
  assert.equal(loaded.documents.length, 6);

  const listenFirst = evaluateMachineDelivery(completeGates({
    microTiming: RELEASE_ONLY,
    leadPromotion: LEAD_UNVERIFIED,
    core3Completeness: gate('PENDING', ['CORE3_COMPLETENESS_UNRESOLVED']),
    originalAudio: gate('PENDING'), mobileAdaptation: gate('PENDING'), regression: gate('PENDING'),
    playerReadback: gate('NOT_RUN'), inGameAcceptance: gate('PENDING'),
  }), { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(listenFirst.schema, MACHINE_DELIVERY_SCHEMA_V2);
  assert.equal(listenFirst.ready, true);
  assert.equal(listenFirst.lifecycle, 'AUTOMATED_VALIDATED');
  assert.deepEqual(listenFirst.non_blocking_pending.map(x => x.gate), ['microTiming', 'core3Completeness', 'leadPromotion', 'originalAudio', 'mobileAdaptation', 'regression']);
  assert.deepEqual(listenFirst.delivery_flags, [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY, DELIVERY_FLAG.LEAD_UNVERIFIED]);
  assert.equal(listenFirst.human_reviewed, false);
  assert.equal(listenFirst.in_game_accepted, false);

  // A mixed micro-timing result still blocks under the same published v3.
  const mixed = evaluateMachineDelivery(completeGates({
    microTiming: gate('PENDING', [...RELEASE_ONLY.blockers, 'MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED']),
  }), { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.deepEqual(mixed.blocking.map(x => x.gate), ['microTiming']);
  assert.equal(mixed.ready, false);

  // The captured real-song scenario predates the listen-first codes, so it
  // still blocks on source, micro-timing and Lead under v3 too.
  const captured = JSON.parse(readFileSync(new URL('./fixtures/real-song-production-machine-delivery.json', import.meta.url), 'utf8'));
  const real = evaluateMachineDelivery(captured.gates, { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(real.ready, false);
  assert.deepEqual(real.blocking.map(x => x.gate), ['source', 'microTiming', 'leadPromotion']);
});

test('an implementation that has not opted into v3 refuses to load it', t => {
  const { cwd } = publishedReleaseRepository(t, { version: proseVersion, schema: MACHINE_DELIVERY_SCHEMA_V2 });
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: ['2026-09-13-v1', V2] }), notLoaded);
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: V2 }), notLoaded);
});
