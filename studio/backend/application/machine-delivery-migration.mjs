import {
  MACHINE_DELIVERY_PROJECTION_VERSION,
  MACHINE_DELIVERY_SCHEMAS,
  evaluateMachineDelivery,
  machineDeliveryAuthority,
} from '../final/delivery-evaluator.mjs';

export const MACHINE_DELIVERY_MIGRATION = '2026-09-13-v1-to-machine-delivery-v2';

const LEGACY_GATE_NAMES = Object.freeze({
  audio: 'originalAudio',
  player_readback: 'playerReadback',
  mobile_adaptation: 'mobileAdaptation',
  in_game: 'inGameAcceptance',
});

function normalizeGateMap(record) {
  // A Final artifact carries the complete readiness map here. Prefer it over
  // the older seven-axis transport summary in record.gates.
  const stored = record?.readiness_summary?.gates ?? record?.gates ?? {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  const gates = {};
  for (const [rawName, rawValue] of Object.entries(stored)) {
    if (rawName === 'notice') continue;
    const name = LEGACY_GATE_NAMES[rawName] ?? rawName;
    const value = typeof rawValue === 'string' ? { status: rawValue } : rawValue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      gates[name] = { status: 'NOT_RUN' };
      continue;
    }
    gates[name] = structuredClone(value);
  }
  return gates;
}

function refreshAuthority(existing, canonical) {
  const authority = machineDeliveryAuthority(canonical);
  const projectionReady = existing.projection_ready === true;
  const ready = projectionReady && authority.active;
  const mobilePending = Array.isArray(existing.non_blocking_pending)
    && existing.non_blocking_pending.some(entry => entry?.gate === 'mobileAdaptation');
  return {
    ...structuredClone(existing),
    authoritative: authority.active,
    activation: authority,
    ready,
    lifecycle: ready ? 'AUTOMATED_VALIDATED' : 'CANDIDATE',
    generic_mobile_delivery: ready && mobilePending,
  };
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Pure/lazy migration for persisted run and artifact projections. It does not
// edit evidence, stored gate maps, or any acceptance state. The returned
// projection is a read model; callers do not need to persist it.
//
// A complete projection recorded under a known machine-delivery schema keeps
// that schema's classification: a run or Final recorded under @1 is not
// re-classified under @2 because a later release is loaded. Only its authority
// is re-read, from the identity it was recorded under. A record with no complete
// projection is classified once, under the schema its own identity declares.
export function migrateMachineDeliveryState(record, { canonical = record?.canonical ?? null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('record is required');

  const clone = structuredClone(record);
  const existing = clone.machine_delivery;
  if (MACHINE_DELIVERY_SCHEMAS.includes(existing?.schema)
    && existing?.projection_version === MACHINE_DELIVERY_PROJECTION_VERSION
    && existing?.complete_gate_map === true) {
    const refreshed = refreshAuthority(existing, canonical);
    return {
      record: { ...clone, machine_delivery: refreshed },
      migrated: !equalJson(existing, refreshed),
      migration: MACHINE_DELIVERY_MIGRATION,
    };
  }

  const gates = normalizeGateMap(clone);
  const machineDelivery = evaluateMachineDelivery(gates, {
    canonical,
    requireCompleteGateMap: true,
  });
  return {
    record: { ...clone, machine_delivery: machineDelivery },
    migrated: !equalJson(existing, machineDelivery),
    migration: MACHINE_DELIVERY_MIGRATION,
  };
}
