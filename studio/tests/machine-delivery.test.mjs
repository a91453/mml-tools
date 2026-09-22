import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATED_VALIDATED,
  MACHINE_DELIVERY_GATE_MAP_INCOMPLETE,
  MACHINE_DELIVERY_GATE_NAMES,
  evaluateMachineDelivery,
} from '../backend/final/delivery-evaluator.mjs';

const gate = status => ({ status });
const V1_CANONICAL = Object.freeze({
  canonical_version: '2026-09-13-v1',
  canonical_status: 'PUBLISHED',
  rules_snapshot_sha: '0a172900a01fdf39c2e9e84cf176961320b779ea',
});
const V2_CANONICAL = Object.freeze({
  canonical_version: '2026-09-22-v2',
  canonical_status: 'PUBLISHED',
  rules_snapshot_sha: '1'.repeat(40),
  machine_delivery_schema: 'mabinogi-mobile-mml-studio/machine-delivery@1',
});

function completeGates(overrides = {}) {
  const gates = Object.fromEntries(MACHINE_DELIVERY_GATE_NAMES.map(name => [name, gate('PASS')]));
  return { ...gates, ...overrides };
}

test('machine delivery classifies the production-song evidence gaps without laundering them', () => {
  const result = evaluateMachineDelivery(completeGates({
    source: gate('PENDING'),
    microTiming: gate('PENDING'),
    core3Completeness: gate('PENDING'),
    leadPromotion: gate('PENDING'),
    originalAudio: gate('PENDING'),
    playerReadback: gate('NOT_RUN'),
    mobileAdaptation: gate('PENDING'),
    regression: gate('PENDING'),
    inGameAcceptance: gate('PENDING'),
  }), { canonical: V1_CANONICAL, requireCompleteGateMap: true });

  assert.deepEqual(result.blocking.map(x => x.gate), ['source', 'microTiming', 'core3Completeness', 'leadPromotion']);
  assert.deepEqual(result.non_blocking_pending.map(x => x.gate), ['originalAudio', 'mobileAdaptation', 'regression']);
  assert.deepEqual(result.post_delivery.map(x => x.gate), ['playerReadback', 'inGameAcceptance']);
  assert.equal(result.complete_gate_map, true);
  assert.equal(result.projection_ready, false);
  assert.equal(result.ready, false);
  assert.equal(result.lifecycle, 'CANDIDATE');
  assert.equal(result.authoritative, false);
  assert.equal(result.human_reviewed, false);
  assert.equal(result.in_game_accepted, false);
  assert.ok(result.unresolved_evidence_ledger.every(x => x.status !== 'PASS'));
});

test('Published v1 keeps a projection informational even when candidate policy would be ready', () => {
  const result = evaluateMachineDelivery(completeGates({
    originalAudio: gate('PENDING'),
    playerReadback: gate('NOT_RUN'),
    mobileAdaptation: gate('PENDING'),
    regression: gate('PENDING'),
    inGameAcceptance: gate('PENDING'),
  }), { canonical: V1_CANONICAL, requireCompleteGateMap: true });

  assert.equal(result.projection_ready, true);
  assert.equal(result.authoritative, false);
  assert.equal(result.ready, false);
  assert.equal(result.lifecycle, 'CANDIDATE');
  assert.equal(result.generic_mobile_projection, true);
  assert.equal(result.generic_mobile_delivery, false);
  assert.ok(result.activation.blockers.includes('MACHINE_DELIVERY_SCHEMA_NOT_ACTIVATED'));
});

test('only a Published Canonical identity carrying the matching schema can activate AUTOMATED_VALIDATED', () => {
  const result = evaluateMachineDelivery(completeGates({
    originalAudio: gate('PENDING'),
    playerReadback: gate('NOT_RUN'),
    mobileAdaptation: gate('PENDING'),
    regression: gate('PENDING'),
    inGameAcceptance: gate('PENDING'),
  }), { canonical: V2_CANONICAL, requireCompleteGateMap: true });

  assert.equal(result.projection_ready, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.ready, true);
  assert.equal(result.lifecycle, AUTOMATED_VALIDATED);
  assert.equal(result.generic_mobile_delivery, true);
  assert.equal(result.human_reviewed, false);
  assert.equal(result.in_game_accepted, false);
});

test('incomplete maps fail closed, unknown gates block, and technical is exempt only before emission', () => {
  const incomplete = evaluateMachineDelivery({ source: gate('PASS') }, {
    canonical: V2_CANONICAL,
    requireCompleteGateMap: true,
  });
  assert.equal(incomplete.projection_ready, false);
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.blocking[0].gate, 'machineDeliveryGateMap');
  assert.ok(incomplete.blocking[0].blockers.includes(MACHINE_DELIVERY_GATE_MAP_INCOMPLETE));

  const unknown = evaluateMachineDelivery({
    ...completeGates(),
    futureGate: gate('PENDING'),
  }, { canonical: V2_CANONICAL, requireCompleteGateMap: true });
  assert.ok(unknown.blocking.some(entry => entry.gate === 'futureGate'));
  assert.equal(unknown.ready, false);

  const preEmission = evaluateMachineDelivery(completeGates({ technical: gate('NOT_RUN') }), {
    canonical: V2_CANONICAL,
    requireCompleteGateMap: true,
    preEmission: true,
  });
  assert.equal(preEmission.ready, true);

  const postEmission = evaluateMachineDelivery(completeGates({ technical: gate('NOT_RUN') }), {
    canonical: V2_CANONICAL,
    requireCompleteGateMap: true,
  });
  assert.equal(postEmission.ready, false);
});
