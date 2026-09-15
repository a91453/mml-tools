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

// Per-song readiness. Remains the readiness authority; the emitter never
// substitutes for it.
export { evaluateProjectReadiness } from './readiness.mjs';

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
