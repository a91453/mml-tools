// Final delivery facade.
//
// The published Final policy lives in the human-readable Canonical rule sources;
// these modules implement and verify it. Nothing here defines a rule, and an
// emitter that succeeds has verified an implementation, not certified a song.

// G10 — source-aware sub-1/64 micro-gap enforcement.
export {
  MICRO_GAP_ENFORCEMENT,
  MICRO_GAP_BLOCKERS,
  PROVISIONAL_RELEASE_POLICY,
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
  // Provisional release rendering for a delivered Final only (2026-09-23-v3).
  PROVISIONAL_RELEASE_RENDERING,
  PROVISIONAL_RENDERING_DIAGNOSTICS,
  PROVISIONAL_RENDERING_NOTICE,
  renderProvisionalReleases,
  verifyProvisionalRenderingInvariants,
} from './technical-timing-repair.mjs';

// Per-song readiness. Remains the readiness authority; the emitter never
// substitutes for it.
export { evaluateProjectReadiness, SONG_STATE } from './readiness.mjs';
export {
  evaluateMachineDelivery,
  machineDeliveryAuthority,
  DELIVERY_CLASS,
  MACHINE_DELIVERY_SCHEMA_V1,
  MACHINE_DELIVERY_SCHEMA_V2,
  MACHINE_DELIVERY_SCHEMAS,
  MACHINE_DELIVERY_PROJECTION_VERSION,
  MACHINE_DELIVERY_GATE_NAMES,
  MACHINE_DELIVERY_GATE_MAP_INCOMPLETE,
  AUTOMATED_VALIDATED,
  DELIVERY_FLAG,
  LISTEN_FIRST_CODES,
  // Machine delivery is ready only when the Final emitter, run on exactly what
  // would be delivered with the options delivery uses, returns an emitted Final.
  FINAL_EMISSION_GATE,
  FINAL_EMISSION_CODES,
  deliveryBlockingGates,
  deliveryClassOf,
  isEmittedFinal,
  machineDeliveryEmitOptions,
  machineDeliverySchemaOf,
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
