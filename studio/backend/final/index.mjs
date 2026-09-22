// Final delivery facade.
//
// The published Final policy lives in the human-readable Canonical rule sources;
// these modules implement and verify it. Nothing here defines a rule, and an
// emitter that succeeds has verified an implementation, not certified a song.

// G10 — source-aware sub-1/64 micro-gap enforcement.
export {
  MICRO_GAP_ENFORCEMENT,
  MICRO_GAP_BLOCKERS,
  enforceMicroGaps,
  readMicroGapPolicy,
  isBelowSafeGrid,
} from './micro-gap-enforcement.mjs';

// Canonical-aware Technical Timing Repair. G10's rejected worklist becomes an
// exact, auditable transformation — or a structured refusal. It holds no
// classification authority of its own.
export {
  REPAIR_STATUS,
  REPAIR_OPERATIONS,
  REPAIR_NEUTRALITY,
  REPAIR_DIAGNOSTICS,
  REPAIR_SEVERITY,
  REPAIR_UNSUPPORTED,
  TECHNICAL_REPAIR_NOTICE,
  repairTechnicalTiming,
  readRejectedTechnicalRecords,
  verifyRepairInvariants,
} from './technical-timing-repair.mjs';

// Per-song readiness. Remains the readiness authority; the emitter never
// substitutes for it.
export { evaluateProjectReadiness } from './readiness.mjs';
export {
  evaluateMachineDelivery,
  DELIVERY_CLASS,
  MACHINE_DELIVERY_SCHEMA,
  AUTOMATED_VALIDATED,
} from './delivery-evaluator.mjs';

// Canonical-aware Final MML emitter.
export { emitFinalMml } from './mml-emitter.mjs';
export {
  EMIT_STATUS,
  EMIT_DIAGNOSTICS,
  DIAGNOSTIC_SEVERITY,
  parserFacts,
} from './emitter-contract.mjs';
export {
  LENGTH_CLASS,
  PLAN_FAILURE,
  MAX_OFF_GRID_SEGMENTS,
  buildTokenLattice,
  planDuration,
  createPlanState,
  planExactDuration,
} from './duration-plan.mjs';
export {
  verifyFinalReadback,
  silenceSpansOf,
  projectFromFinalReadback,
} from './round-trip.mjs';
