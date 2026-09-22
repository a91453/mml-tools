import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMachineDelivery, AUTOMATED_VALIDATED } from '../backend/final/delivery-evaluator.mjs';

const gate = status => ({ status });

test('machine delivery classifies the production song evidence gaps without laundering them', () => {
  const result = evaluateMachineDelivery({
    source: gate('PENDING'), microTiming: gate('PENDING'), core3Completeness: gate('PENDING'),
    leadPromotion: gate('PENDING'), originalAudio: gate('PENDING'), playerReadback: gate('NOT_RUN'),
    mobileAdaptation: gate('PENDING'), regression: gate('PENDING'), inGameAcceptance: gate('PENDING'),
  });
  assert.deepEqual(result.blocking.map(x => x.gate), ['source', 'microTiming', 'core3Completeness', 'leadPromotion']);
  assert.deepEqual(result.non_blocking_pending.map(x => x.gate), ['originalAudio', 'mobileAdaptation', 'regression']);
  assert.deepEqual(result.post_delivery.map(x => x.gate), ['playerReadback', 'inGameAcceptance']);
  assert.equal(result.ready, false);
  assert.equal(result.human_reviewed, false);
  assert.equal(result.in_game_accepted, false);
  assert.ok(result.unresolved_evidence_ledger.every(x => x.status !== 'PASS'));
});

test('only machine blocking gates control AUTOMATED_VALIDATED and generic Mobile delivery', () => {
  const result = evaluateMachineDelivery({
    source: gate('PASS'), technical: gate('PASS'), leadPromotion: gate('N/A'),
    originalAudio: gate('PENDING'), playerReadback: gate('NOT_RUN'),
    mobileAdaptation: gate('PENDING'), regression: gate('PENDING'), inGameAcceptance: gate('PENDING'),
  });
  assert.equal(result.ready, true);
  assert.equal(result.lifecycle, AUTOMATED_VALIDATED);
  assert.equal(result.generic_mobile_delivery, true);
  assert.equal(result.unresolved_evidence_ledger.length, 5);
});

test('unknown gates are blocking and technical is exempt only before emission', () => {
  assert.deepEqual(evaluateMachineDelivery({ futureGate: gate('PENDING') }).blocking.map(x => x.gate), ['futureGate']);
  assert.equal(evaluateMachineDelivery({ technical: gate('NOT_RUN') }, { preEmission: true }).ready, true);
  assert.equal(evaluateMachineDelivery({ technical: gate('NOT_RUN') }).ready, false);
});
