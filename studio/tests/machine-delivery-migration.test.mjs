import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateMachineDeliveryState } from '../backend/application/machine-delivery-migration.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/kaiju-production-machine-delivery.json', import.meta.url)));

test('the real-song acceptance scenario remains unresolved and classified conservatively', () => {
  const migrated = migrateMachineDeliveryState({ schema: 'application-run@1', gates: fixture.gates });
  assert.equal(migrated.migrated, true);
  assert.equal(fixture.project_id, 'prj_a808b53c7cafadaf4c6bf5f0fe4c370a');
  assert.deepEqual(migrated.record.machine_delivery.blocking.map(x => x.gate),
    ['source', 'microTiming', 'core3Completeness', 'leadPromotion']);
  assert.deepEqual(migrated.record.machine_delivery.non_blocking_pending.map(x => x.gate),
    ['originalAudio', 'mobileAdaptation', 'regression']);
  assert.deepEqual(migrated.record.machine_delivery.post_delivery.map(x => x.gate), ['playerReadback']);
  assert.equal(migrated.record.machine_delivery.lifecycle, 'CANDIDATE');
});

test('v1 migration is idempotent and missing gate data fails closed', () => {
  const first = migrateMachineDeliveryState({ gates: { source: 'PASS' } });
  const second = migrateMachineDeliveryState(first.record);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.record, first.record);
  const unknown = migrateMachineDeliveryState({ gates: { future: 'PENDING' } });
  assert.deepEqual(unknown.record.machine_delivery.blocking.map(x => x.gate), ['future']);
});
