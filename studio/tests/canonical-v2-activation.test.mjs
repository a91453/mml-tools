import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPublishedCanonical, parseCanonicalManifest } from '../backend/bootstrap/index.mjs';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../backend/rules/supported-releases.mjs';
import { MACHINE_DELIVERY_GATE_NAMES, MACHINE_DELIVERY_SCHEMA_V1, evaluateMachineDelivery } from '../backend/final/delivery-evaluator.mjs';
import { publishedReleaseRepository, releaseHeader, withHeader } from './support/published-release-fixture.mjs';

// Publishing 2026-09-23-v2 (docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md):
// everything that publication relies on, proven against a real Git history.
// v2 stays a supported release after 2026-09-23-v3 is written: runs and
// artifacts recorded under it keep its `@1` classification. Which release the
// loaded Manifest names, and how the working Manifest relates to the rule prose,
// is canonical-v3-activation.test.mjs's concern.

const V2 = '2026-09-23-v2';
const notLoaded = error => error.code === 'CANONICAL_NOT_LOADED';
const LOADED = PUBLISHED_CANONICAL.metadata;

const gate = (status, blockers) => (blockers ? { status, blockers } : { status });
const completeGates = (overrides = {}) => ({ ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, gate('PASS')])), ...overrides });

test('the implementation still opts into the published v2 release', () => {
  assert.ok(SUPPORTED_CANONICAL_VERSIONS.includes('2026-09-13-v1'));
  assert.ok(SUPPORTED_CANONICAL_VERSIONS.includes(V2));
});

test('the Manifest may declare the machine-delivery schema, and nothing else beyond the four fields', () => {
  const header = releaseHeader({ version: V2, schema: MACHINE_DELIVERY_SCHEMA_V1, snapshot: LOADED.rules_snapshot_sha });
  const manifest = withHeader(PUBLISHED_CANONICAL.manifest, header);
  assert.equal(parseCanonicalManifest(manifest).metadata.machine_delivery_schema, MACHINE_DELIVERY_SCHEMA_V1);
  const bad = extra => withHeader(PUBLISHED_CANONICAL.manifest, header.replace('\n---', `\n${extra}\n---`));
  assert.throws(() => parseCanonicalManifest(bad('delivery_policy: open')), notLoaded, 'an unknown field is refused');
  assert.throws(() => parseCanonicalManifest(bad(`machine_delivery_schema: ${MACHINE_DELIVERY_SCHEMA_V1}`)), notLoaded, 'a duplicate is refused');
  const malformed = withHeader(PUBLISHED_CANONICAL.manifest, header.replace(MACHINE_DELIVERY_SCHEMA_V1, 'machine delivery'));
  assert.throws(() => parseCanonicalManifest(malformed), notLoaded, 'a malformed schema value is refused');
  const missing = withHeader(PUBLISHED_CANONICAL.manifest, header.replace(/^manifest_version: .*\n/m, ''));
  assert.throws(() => parseCanonicalManifest(missing), notLoaded, 'a required field is still required');
});

test('a published v2 loads end to end and activates AUTOMATED_VALIDATED only on machine-determined gates', t => {
  const { cwd, snapshot } = publishedReleaseRepository(t, { version: V2, schema: MACHINE_DELIVERY_SCHEMA_V1 });
  const loaded = loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: SUPPORTED_CANONICAL_VERSIONS });
  assert.deepEqual(loaded.metadata, {
    canonical_version: V2, canonical_status: 'PUBLISHED', manifest_version: `${V2}-manifest1`,
    rules_snapshot_sha: snapshot, machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V1,
  });
  assert.equal(loaded.documents.length, 6);

  // Everything a person must judge is still unresolved, and delivery proceeds.
  const listenFirst = evaluateMachineDelivery(completeGates({
    core3Completeness: gate('PENDING', ['CORE3_COMPLETENESS_UNRESOLVED']),
    versionDrift: gate('PENDING', ['VERSION_DIVERGENCE_REVIEW_REQUIRED']),
    originalAudio: gate('PENDING'), mobileAdaptation: gate('PENDING'), regression: gate('PENDING'),
    playerReadback: gate('NOT_RUN'), inGameAcceptance: gate('PENDING'),
  }), { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(listenFirst.schema, MACHINE_DELIVERY_SCHEMA_V1);
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

  // The v3 listen-first codes change nothing under v2's @1 classification.
  const v3Shapes = evaluateMachineDelivery(completeGates({
    microTiming: gate('PENDING', ['MICRO_TIMING_CLASSIFICATION_UNKNOWN', 'MICRO_TIMING_RELEASE_PROVISIONAL']),
    leadPromotion: gate('PENDING', ['LEAD_PROMOTION_EVIDENCE_REQUIRED', 'LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING']),
  }), { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.deepEqual(v3Shapes.blocking.map(x => x.gate), ['microTiming', 'leadPromotion']);

  // The captured real-song scenario still blocks on source, micro-timing and Lead.
  const captured = JSON.parse(readFileSync(new URL('./fixtures/real-song-production-machine-delivery.json', import.meta.url), 'utf8'));
  const real = evaluateMachineDelivery(captured.gates, { canonical: loaded.metadata, requireCompleteGateMap: true });
  assert.equal(real.ready, false);
  assert.deepEqual(real.blocking.map(x => x.gate), ['source', 'microTiming', 'leadPromotion']);
});

test('an implementation that has not opted into v2 refuses to load it', t => {
  const { cwd } = publishedReleaseRepository(t, { version: V2, schema: MACHINE_DELIVERY_SCHEMA_V1 });
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: '2026-09-13-v1' }), notLoaded);
  assert.throws(() => loadPublishedCanonical({ root: cwd, supportedCanonicalVersion: ['2026-09-13-v1'] }), notLoaded);
});
