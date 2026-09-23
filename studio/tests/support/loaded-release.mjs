import assert from 'node:assert/strict';
import { EFFECTIVE_RULESET } from '../../backend/rules/index.mjs';
import {
  MACHINE_DELIVERY_SCHEMA_V2,
  machineDeliveryAuthority,
  machineDeliverySchemaOf,
} from '../../backend/final/delivery-evaluator.mjs';

// Which unresolved gates stop delivery is decided by the loaded release, and
// the loaded release is read from the published Manifest on origin/main: the
// previous release while a publication is still a pull request, the new one
// once it is merged. A test whose outcome depends on that difference states
// both outcomes and picks one by these flags, never by a version literal.
//
//   MACHINE_DELIVERY_ACTIVE
//     false  2026-09-13-v1: every pre-game gate blocks Final.
//     true   2026-09-23-v2 and later: only the machine-delivery BLOCKING phase
//            does; the rest is delivered for listening first and stays
//            unresolved.
//   LISTEN_FIRST_RELEASES_ACTIVE
//     true   2026-09-23-v3 (schema @2): in addition, micro-timing that is only
//            release-side is delivered with those releases held provisionally,
//            and a Lead promotion missing only primary evidence is delivered
//            flagged "Lead unverified" (ACCEPTANCE_CRITERIA "Delivered first,
//            flagged for listening"). Both stay unresolved.
export const MACHINE_DELIVERY_ACTIVE = machineDeliveryAuthority(EFFECTIVE_RULESET.canonical).active;
export const LOADED_MACHINE_DELIVERY_SCHEMA = machineDeliverySchemaOf(EFFECTIVE_RULESET.canonical);
export const LISTEN_FIRST_RELEASES_ACTIVE = MACHINE_DELIVERY_ACTIVE && LOADED_MACHINE_DELIVERY_SCHEMA === MACHINE_DELIVERY_SCHEMA_V2;

/**
 * `gate` is unresolved and treated as the loaded release says: a delivery
 * blocker under v1; under v2 a blocker only in the BLOCKING phase, otherwise
 * carried in the ledger phase v2 assigns it (`non_blocking_pending` or
 * `post_delivery`) and never dropped. Works on a finalize result and on a run.
 */
export function assertUnresolved(result, gate, phase) {
  // A run names its blocking gates in readiness_blockers; its blockers carry codes.
  const blocking = result.readiness_blockers ?? result.blockers;
  if (!MACHINE_DELIVERY_ACTIVE || phase === 'blocking') {
    assert.ok(blocking.includes(gate), `${gate} must block: ${JSON.stringify(blocking)}`);
    return;
  }
  assert.equal(blocking.includes(gate), false, `${gate} is delivered for listening first`);
  const entries = result.machine_delivery?.[phase] ?? [];
  assert.ok(entries.some(entry => entry.gate === gate), `${gate} must stay unresolved in ${phase}: ${JSON.stringify(entries.map(entry => entry.gate))}`);
}

/**
 * A finalize result with `gates` ([name, v2 phase] pairs) unresolved: withheld
 * under v1; under v2 delivered for listening as AUTOMATED_VALIDATED, and never
 * VALIDATED while any of them is unresolved.
 */
export function assertFinalWithheldOrDeliveredUnresolved(result, gates) {
  for (const [gate, phase] of gates) assertUnresolved(result, gate, phase);
  if (!MACHINE_DELIVERY_ACTIVE) {
    assert.equal(result.operation, 'blocked');
    assert.equal(result.mml, null);
    assert.equal(result.artifact_id, null);
    return;
  }
  assert.equal(result.operation, 'succeeded', JSON.stringify(result.blockers));
  assert.match(result.mml, /^MML@/);
  assert.ok(result.artifact_id);
  assert.equal(result.machine_delivery.lifecycle, 'AUTOMATED_VALIDATED');
  assert.notEqual(result.song_state, 'VALIDATED');
}

/** The same for a run: halted for review under v1, completed with a Final delivered for listening under v2. */
export function assertRunHeldOrDeliveredUnresolved(run, gates) {
  for (const [gate, phase] of gates) assertUnresolved(run, gate, phase);
  if (!MACHINE_DELIVERY_ACTIVE) {
    assert.notEqual(run.state, 'completed');
    assert.equal(run.final_artifact_id, null);
    for (const [gate] of gates) assert.ok(run.review_requests.some(entry => entry.gate === gate), `${gate} must be requested: ${JSON.stringify(run.review_requests.map(entry => entry.gate))}`);
    return;
  }
  assert.equal(run.state, 'completed', JSON.stringify(run.blockers));
  assert.ok(run.final_artifact_id);
  assert.equal(run.machine_delivery.lifecycle, 'AUTOMATED_VALIDATED');
}
