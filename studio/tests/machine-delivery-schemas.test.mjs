// Machine-delivery classification under each schema a Published Canonical can
// declare (ACCEPTANCE_CRITERIA "Machine delivery"; change record for
// 2026-09-23-v3 in docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md).
//
// Every identity here is constructed and passed explicitly, so these hold
// whichever release the published Manifest on origin/main names.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATED_VALIDATED,
  DELIVERY_CLASS,
  DELIVERY_FLAG,
  LISTEN_FIRST_CODES,
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  MACHINE_DELIVERY_SCHEMAS,
  deliveryBlockingGates,
  deliveryClassOf,
  evaluateMachineDelivery,
  machineDeliverySchemaOf,
} from '../backend/final/delivery-evaluator.mjs';
import { MICRO_GAP_BLOCKERS } from '../backend/final/micro-gap-enforcement.mjs';
import { migrateMachineDeliveryState } from '../backend/application/machine-delivery-migration.mjs';

const identity = (version, schema) => Object.freeze({
  canonical_version: version,
  canonical_status: 'PUBLISHED',
  rules_snapshot_sha: 'f'.repeat(40),
  ...(schema ? { machine_delivery_schema: schema } : {}),
});
const V1_IDENTITY = identity('2026-09-13-v1', null);
const AT1 = identity('2026-09-23-v2', MACHINE_DELIVERY_SCHEMA_V1);
const AT2 = identity('2026-09-23-v3', MACHINE_DELIVERY_SCHEMA_V2);

const gate = (status, blockers, extra = {}) => ({ status, ...(blockers ? { blockers } : {}), ...extra });
const completeGates = (overrides = {}) => ({ ...Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, gate('PASS')])), ...overrides });
const evaluate = (overrides, canonical) => evaluateMachineDelivery(completeGates(overrides), { canonical, requireCompleteGateMap: true });
const phaseOf = (result, name) => (result.blocking.some(x => x.gate === name) ? 'BLOCKING'
  : result.non_blocking_pending.some(x => x.gate === name) ? 'NON_BLOCKING_PENDING'
    : result.post_delivery.some(x => x.gate === name) ? 'POST_DELIVERY' : null);

// Built from the enforcement module's own constants, so a renamed code there
// fails here instead of silently falling out of the @2 rule.
const RELEASE_ONLY = gate('PENDING', [
  MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN,
  MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE,
  MICRO_GAP_BLOCKERS.RELEASE_EVIDENCE_REQUIRED,
  MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL,
], {
  provisionalReleases: [{ eventId: 'lead-1', role: 'Melody', release: '479/480', heldTo: '1', delta: '1/480', representation: 'EXTEND_TO_NEXT_GRID', intervalKeys: ['["inter-event-gap","lead-1","lead-2","479/480","1"]'] }],
  releaseOffsetSources: [{ sourceId: 'midi', dominantOffset: '1 tick(s)', share: '8/8', sharePercent: '100.0', minimumShare: '95/100', qualifies: true, releaseCount: 8, provisionallyRendered: 8, unresolved: 0 }],
});
const LEAD_MISSING = gate('PENDING', ['LEAD_PROMOTION_EVIDENCE_REQUIRED', LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING], { pendingEventIds: ['chord-1'], unverifiedLeadEventIds: ['chord-1'] });

test('the listen-first codes the evaluator restates are the ones the gates emit', () => {
  assert.equal(LISTEN_FIRST_CODES.MICRO_TIMING_RELEASE_PROVISIONAL, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL);
  assert.deepEqual(MACHINE_DELIVERY_SCHEMAS, [MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]);
  assert.equal(machineDeliverySchemaOf(AT1), MACHINE_DELIVERY_SCHEMA_V1);
  assert.equal(machineDeliverySchemaOf(AT2), MACHINE_DELIVERY_SCHEMA_V2);
  // No schema, or one this implementation does not know: the stricter @1 table.
  assert.equal(machineDeliverySchemaOf(V1_IDENTITY), MACHINE_DELIVERY_SCHEMA_V1);
  assert.equal(machineDeliverySchemaOf(identity('2026-12-31-v9', 'mabinogi-mobile-mml-studio/machine-delivery@3')), MACHINE_DELIVERY_SCHEMA_V1);
  assert.equal(machineDeliverySchemaOf(null), MACHINE_DELIVERY_SCHEMA_V1);
});

test('release-only micro-timing is NON_BLOCKING_PENDING under @2 and BLOCKING under @1', () => {
  const underAt2 = evaluate({ microTiming: RELEASE_ONLY }, AT2);
  assert.equal(underAt2.schema, MACHINE_DELIVERY_SCHEMA_V2);
  assert.equal(phaseOf(underAt2, 'microTiming'), 'NON_BLOCKING_PENDING');
  assert.equal(underAt2.ready, true);
  assert.equal(underAt2.lifecycle, AUTOMATED_VALIDATED);
  const entry = underAt2.non_blocking_pending.find(x => x.gate === 'microTiming');
  assert.equal(entry.status, 'PENDING', 'never rewritten as PASS');
  assert.equal(entry.delivery_flag, DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY);
  assert.deepEqual(entry.provisional_releases, [{ event_id: 'lead-1', role: 'Melody', release: '479/480', rendered_release: '1', representation: 'EXTEND_TO_NEXT_GRID' }]);
  assert.deepEqual(entry.release_offset_sources.map(item => [item.source_id, item.dominant_offset, item.share, item.qualifies, item.provisionally_rendered, item.unresolved]), [['midi', '1 tick(s)', '8/8', true, 8, 0]]);
  assert.deepEqual(underAt2.delivery_flags, [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY]);
  assert.equal(underAt2.human_reviewed, false);
  assert.equal(underAt2.in_game_accepted, false);
  assert.equal(deliveryClassOf('microTiming', RELEASE_ONLY, { canonical: AT2 }), DELIVERY_CLASS.NON_BLOCKING_PENDING);

  for (const canonical of [AT1, V1_IDENTITY]) {
    const underAt1 = evaluate({ microTiming: RELEASE_ONLY }, canonical);
    assert.equal(underAt1.schema, MACHINE_DELIVERY_SCHEMA_V1);
    assert.equal(phaseOf(underAt1, 'microTiming'), 'BLOCKING');
    assert.equal(underAt1.ready, false);
    const blocked = underAt1.blocking.find(x => x.gate === 'microTiming');
    // The @1 entry is exactly what v2 recorded: no v3 detail, no flag.
    assert.deepEqual(Object.keys(blocked).sort(), ['blockers', 'classification', 'gate', 'status']);
    assert.deepEqual(underAt1.delivery_flags, []);
    assert.equal(deliveryClassOf('microTiming', RELEASE_ONLY, { canonical }), DELIVERY_CLASS.BLOCKING);
  }
});

test('mixed or unmarked micro-timing blocks under both schemas', () => {
  const cases = {
    'release-side codes without the listen-first code': gate('PENDING', [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]),
    'the listen-first code beside unresolved stream identity': gate('PENDING', [...RELEASE_ONLY.blockers, MICRO_GAP_BLOCKERS.STREAM_IDENTITY_UNRESOLVED]),
    'the listen-first code beside an analysis failure': gate('PENDING', [MICRO_GAP_BLOCKERS.ANALYSIS_FAILED, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]),
    'the listen-first code beside an invalid release record': gate('FAIL', [MICRO_GAP_BLOCKERS.RELEASE_RECORD_INVALID, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]),
    'the listen-first code beside technical residue': gate('FAIL', [MICRO_GAP_BLOCKERS.TECHNICAL_RESIDUE_PRESENT, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]),
    'the listen-first code beside an unpublished candidate': gate('PENDING', [MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL, MICRO_GAP_BLOCKERS.UNPUBLISHED_CANONICAL_CANDIDATE]),
    'the listen-first code on a FAIL': gate('FAIL', RELEASE_ONLY.blockers),
    'a PENDING with no blocker': gate('PENDING'),
    'an evaluation that did not run': gate('NOT_RUN'),
  };
  for (const [label, value] of Object.entries(cases)) {
    for (const canonical of [AT1, AT2]) {
      const result = evaluate({ microTiming: value }, canonical);
      assert.equal(phaseOf(result, 'microTiming'), 'BLOCKING', `${label} (${canonical.machine_delivery_schema})`);
      assert.equal(result.ready, false, label);
    }
  }
});

test('Lead promotion missing only primary evidence is NON_BLOCKING_PENDING under @2, flagged Lead unverified', () => {
  const underAt2 = evaluate({ leadPromotion: LEAD_MISSING }, AT2);
  assert.equal(phaseOf(underAt2, 'leadPromotion'), 'NON_BLOCKING_PENDING');
  assert.equal(underAt2.lifecycle, AUTOMATED_VALIDATED);
  const entry = underAt2.non_blocking_pending.find(x => x.gate === 'leadPromotion');
  assert.equal(entry.delivery_flag, DELIVERY_FLAG.LEAD_UNVERIFIED);
  assert.deepEqual(entry.unverified_lead_event_ids, ['chord-1']);
  assert.equal(entry.status, 'PENDING');
  assert.equal(phaseOf(evaluate({ leadPromotion: LEAD_MISSING }, AT1), 'leadPromotion'), 'BLOCKING');
});

test('invalid evidence, an origin outside the baseline, an unresolved identity and any demotion still block under @2', () => {
  const blockingUnderAt2 = {
    leadPromotion: [
      // The gate's code alone: the grader's reports did not all say "primary evidence missing".
      gate('PENDING', ['LEAD_PROMOTION_EVIDENCE_REQUIRED']),
      gate('PENDING', ['LEAD_PROMOTION_EVIDENCE_REQUIRED', 'LEAD_IDENTITY_CORRESPONDENCE_UNRESOLVED', LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING]),
      gate('PENDING', [LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING, 'LEAD_PROMOTION_EVIDENCE_INVALID: bad']),
      gate('PENDING', [LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING, 'LEAD_PROMOTION_ORIGIN_NOT_IN_BASELINE']),
      gate('FAIL', LEAD_MISSING.blockers),
      gate('PENDING', undefined, { pendingEventIds: ['x'] }),
    ],
    // MASTER_RULES §4 is unchanged: a demotion blocks whatever it carries.
    leadDemotion: [
      gate('PENDING', ['LEAD_DEMOTION_EVIDENCE_REQUIRED']),
      gate('PENDING', ['LEAD_DEMOTION_EVIDENCE_REQUIRED', LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING]),
    ],
    // A Core3 that has no Lead, and a missing Lead-gate implementation.
    core3Completeness: [gate('FAIL', ['CORE3_INCOMPLETE'])],
    implementation: [gate('PENDING', ['LEAD_PROMOTION_GATE_PENDING'])],
  };
  for (const [name, values] of Object.entries(blockingUnderAt2)) {
    for (const value of values) {
      const result = evaluate({ [name]: value }, AT2);
      assert.equal(phaseOf(result, name), 'BLOCKING', `${name}: ${JSON.stringify(value)}`);
      assert.equal(result.ready, false);
    }
  }
});

test('unknown gates, including ones named after Object members, fail closed under both schemas', () => {
  for (const canonical of [AT1, AT2]) {
    for (const name of ['futureGate', 'constructor', 'toString', 'hasOwnProperty']) {
      const result = evaluateMachineDelivery({ ...completeGates(), [name]: gate('PENDING', [LISTEN_FIRST_CODES.MICRO_TIMING_RELEASE_PROVISIONAL]) }, { canonical, requireCompleteGateMap: true });
      assert.equal(phaseOf(result, name), 'BLOCKING', `${name} (${canonical.machine_delivery_schema})`);
      assert.equal(result.ready, false);
    }
  }
});

test('the run loop and Final read the @2 phases through deliveryBlockingGates', () => {
  const readiness = {
    preGameBlocking: ['microTiming', 'leadPromotion', 'regression'],
    machineDelivery: evaluate({ microTiming: RELEASE_ONLY, leadPromotion: LEAD_MISSING, regression: gate('PENDING', ['REGRESSION_REVIEW_REQUIRED']) }, AT2),
  };
  assert.deepEqual(deliveryBlockingGates(readiness), []);
  const underAt1 = { ...readiness, machineDelivery: evaluate({ microTiming: RELEASE_ONLY, leadPromotion: LEAD_MISSING, regression: gate('PENDING', ['REGRESSION_REVIEW_REQUIRED']) }, AT1) };
  assert.deepEqual(deliveryBlockingGates(underAt1), ['microTiming', 'leadPromotion']);
});

test('a projection recorded under @1 keeps its classification when read under @2; one without a projection is classified once', () => {
  const recorded = {
    schema: 'application-run@1',
    canonical: AT1,
    machine_delivery: evaluate({ microTiming: RELEASE_ONLY, leadPromotion: LEAD_MISSING }, AT1),
  };
  const snapshot = structuredClone(recorded);
  const read = migrateMachineDeliveryState(recorded, { canonical: AT2 });
  assert.deepEqual(recorded, snapshot, 'the stored record is never mutated');
  assert.equal(read.record.machine_delivery.schema, MACHINE_DELIVERY_SCHEMA_V1);
  assert.deepEqual(read.record.machine_delivery.blocking.map(x => x.gate), ['microTiming', 'leadPromotion']);
  assert.equal(read.record.machine_delivery.ready, false);

  // A record carrying no projection is classified under the identity it names.
  const bare = { gates: completeGates({ microTiming: RELEASE_ONLY }), canonical: AT1 };
  assert.equal(migrateMachineDeliveryState(bare).record.machine_delivery.schema, MACHINE_DELIVERY_SCHEMA_V1);
  assert.deepEqual(migrateMachineDeliveryState(bare).record.machine_delivery.blocking.map(x => x.gate), ['microTiming']);
  const bareAt2 = { gates: completeGates({ microTiming: RELEASE_ONLY }), canonical: AT2 };
  assert.equal(migrateMachineDeliveryState(bareAt2).record.machine_delivery.schema, MACHINE_DELIVERY_SCHEMA_V2);
  assert.deepEqual(migrateMachineDeliveryState(bareAt2).record.machine_delivery.blocking, []);
  // And an @2 projection read again stays @2.
  const again = migrateMachineDeliveryState(migrateMachineDeliveryState(bareAt2).record);
  assert.equal(again.migrated, false);
  assert.equal(again.record.machine_delivery.schema, MACHINE_DELIVERY_SCHEMA_V2);
});
