import { evaluateMachineDelivery } from '../final/delivery-evaluator.mjs';

export const MACHINE_DELIVERY_MIGRATION = '2026-09-13-v1-to-machine-delivery-v2';

// Pure/lazy migration for persisted v1 run and artifact projections. It does
// not edit evidence and cannot manufacture a gate result. Callers persist the
// returned copy through their normal owner-scoped atomic store path.
export function migrateMachineDeliveryState(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('record is required');
  if (record.machine_delivery?.schema === 'mabinogi-mobile-mml-studio/machine-delivery@1') {
    return { record: structuredClone(record), migrated: false, migration: MACHINE_DELIVERY_MIGRATION };
  }
  const statuses = record.gates ?? record.readiness_summary?.gates ?? {};
  const gates = Object.fromEntries(Object.entries(statuses).map(([name, value]) => [
    name, typeof value === 'string' ? { status: value } : value,
  ]));
  const machineDelivery = evaluateMachineDelivery(gates);
  return {
    record: { ...structuredClone(record), machine_delivery: machineDelivery },
    migrated: true,
    migration: MACHINE_DELIVERY_MIGRATION,
  };
}
