import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateMachineDeliveryState } from '../backend/application/machine-delivery-migration.mjs';
import { MACHINE_DELIVERY_GATE_MAP_INCOMPLETE } from '../backend/final/delivery-evaluator.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kaiju-production-machine-delivery.json', import.meta.url)));
const V1_CANONICAL = Object.freeze({
  canonical_version: '2026-09-13-v1',
  canonical_status: 'PUBLISHED',
  rules_snapshot_sha: '0a172900a01fdf39c2e9e84cf176961320b779ea',
});

test('the real-song acceptance scenario remains unresolved and classified conservatively', () => {
  const migrated = migrateMachineDeliveryState({
    schema: 'application-run@1',
    gates: fixture.gates,
    canonical: V1_CANONICAL,
  });
  assert.equal(migrated.migrated, true);
  assert.equal(fixture.project_id, 'prj_a808b53c7cafadaf4c6bf5f0fe4c370a');
  assert.equal(migrated.record.machine_delivery.complete_gate_map, true);
  assert.deepEqual(migrated.record.machine_delivery.blocking.map(x => x.gate),
    ['source', 'microTiming', 'core3Completeness', 'leadPromotion']);
  assert.deepEqual(migrated.record.machine_delivery.non_blocking_pending.map(x => x.gate),
    ['originalAudio', 'mobileAdaptation', 'regression']);
  assert.deepEqual(migrated.record.machine_delivery.post_delivery.map(x => x.gate),
    ['playerReadback', 'inGameAcceptance']);
  assert.equal(migrated.record.machine_delivery.lifecycle, 'CANDIDATE');
  assert.equal(migrated.record.machine_delivery.authoritative, false);
});

test('migration is pure and idempotent for a complete projection', () => {
  const original = {
    schema: 'application-run@1',
    gates: fixture.gates,
    canonical: V1_CANONICAL,
  };
  const snapshot = structuredClone(original);
  const first = migrateMachineDeliveryState(original);
  const second = migrateMachineDeliveryState(first.record);

  assert.deepEqual(original, snapshot, 'migration must not mutate stored gate/evidence data');
  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.record, first.record);
});

test('absent, empty and partial legacy gate maps all fail closed', () => {
  for (const record of [
    {},
    { gates: {} },
    { gates: { source: 'PASS' } },
  ]) {
    const migrated = migrateMachineDeliveryState({ ...record, canonical: V1_CANONICAL });
    const projection = migrated.record.machine_delivery;
    assert.equal(projection.complete_gate_map, false);
    assert.equal(projection.projection_ready, false);
    assert.equal(projection.ready, false);
    const incomplete = projection.blocking.find(entry => entry.gate === 'machineDeliveryGateMap');
    assert.ok(incomplete, JSON.stringify(projection.blocking));
    assert.ok(incomplete.blockers.includes(MACHINE_DELIVERY_GATE_MAP_INCOMPLETE));
    assert.ok(incomplete.missing_gates.length > 0);
  }
});

test('legacy transport gate names are normalized but cannot masquerade as a complete readiness map', () => {
  const migrated = migrateMachineDeliveryState({
    canonical: V1_CANONICAL,
    gates: {
      technical: 'PASS',
      source: 'PASS',
      audio: 'PENDING',
      player_readback: 'NOT_RUN',
      mobile_adaptation: 'PENDING',
      regression: 'PENDING',
      in_game: 'PENDING',
      notice: 'legacy transport summary',
    },
  });
  const projection = migrated.record.machine_delivery;
  assert.equal(projection.complete_gate_map, false);
  assert.ok(projection.non_blocking_pending.some(entry => entry.gate === 'originalAudio'));
  assert.ok(projection.post_delivery.some(entry => entry.gate === 'playerReadback'));
  assert.ok(projection.blocking.some(entry => entry.gate === 'machineDeliveryGateMap'));
});

test('unknown gates remain blocking even when the required map is otherwise complete', () => {
  const migrated = migrateMachineDeliveryState({
    gates: {
      ...fixture.gates,
      futureGate: { status: 'PENDING', blockers: ['UNKNOWN_FUTURE_GATE'] },
    },
    canonical: V1_CANONICAL,
  });
  assert.ok(migrated.record.machine_delivery.blocking.some(entry => entry.gate === 'futureGate'));
  assert.equal(migrated.record.machine_delivery.ready, false);
});
