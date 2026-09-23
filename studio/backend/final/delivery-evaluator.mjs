// Machine-delivery policy projection. The classifications are release data,
// not caller input: neither an AI nor a transport can promote a gate.
export const DELIVERY_CLASS = Object.freeze({
  BLOCKING: 'BLOCKING',
  NON_BLOCKING_PENDING: 'NON_BLOCKING_PENDING',
  POST_DELIVERY: 'POST_DELIVERY',
});

export const MACHINE_DELIVERY_SCHEMA = 'mabinogi-mobile-mml-studio/machine-delivery@1';
export const MACHINE_DELIVERY_PROJECTION_VERSION = 2;
export const AUTOMATED_VALIDATED = 'AUTOMATED_VALIDATED';
export const MACHINE_DELIVERY_GATE_MAP_INCOMPLETE = 'MACHINE_DELIVERY_GATE_MAP_INCOMPLETE';

const PASS_LIKE = new Set(['PASS', 'N/A']);
const CLASS_BY_GATE = Object.freeze({
  implementation: DELIVERY_CLASS.BLOCKING,
  source: DELIVERY_CLASS.BLOCKING,
  baseline: DELIVERY_CLASS.BLOCKING,
  technical: DELIVERY_CLASS.BLOCKING,
  microTiming: DELIVERY_CLASS.BLOCKING,
  core3: DELIVERY_CLASS.BLOCKING,
  core3Completeness: DELIVERY_CLASS.BLOCKING,
  leadDemotion: DELIVERY_CLASS.BLOCKING,
  leadPromotion: DELIVERY_CLASS.BLOCKING,
  crossSourceHarmony: DELIVERY_CLASS.BLOCKING,
  versionDrift: DELIVERY_CLASS.BLOCKING,
  pendingDecisions: DELIVERY_CLASS.BLOCKING,
  originalAudio: DELIVERY_CLASS.NON_BLOCKING_PENDING,
  mobileAdaptation: DELIVERY_CLASS.NON_BLOCKING_PENDING,
  regression: DELIVERY_CLASS.NON_BLOCKING_PENDING,
  playerReadback: DELIVERY_CLASS.POST_DELIVERY,
  inGameAcceptance: DELIVERY_CLASS.POST_DELIVERY,
});

export const MACHINE_DELIVERY_GATE_NAMES = Object.freeze(Object.keys(CLASS_BY_GATE));

// ACCEPTANCE_CRITERIA "Machine delivery" (2026-09-23-v2): what a machine can
// determine blocks; what needs a person's judgment is delivered for listening
// first. Two BLOCKING gates carry both kinds of result, so the split is made on
// the evaluator's own status and blocker codes, never on caller input:
//   * core3Completeness -- FAIL (CORE3_INCOMPLETE: no Lead, or a Core3 that
//     depends on Chord3-Chord5) and an evaluation that did not run stay
//     BLOCKING; PENDING whose every blocker is reviewer residue does not;
//   * versionDrift -- its only unresolved state is a review request when
//     divergence increased (MASTER_RULES §10: a review trigger, not a verdict).
// A PENDING with no blocker, or with any other blocker, stays BLOCKING.
const REVIEWER_RESIDUE = Object.freeze({
  core3Completeness: Object.freeze(['CORE3_COMPLETENESS_UNRESOLVED', 'CORE3_ENRICHMENT_DEPENDENCE_UNRESOLVED']),
  versionDrift: Object.freeze(['VERSION_DIVERGENCE_REVIEW_REQUIRED']),
});

function classify(name, value) {
  const base = CLASS_BY_GATE[name] ?? DELIVERY_CLASS.BLOCKING; // unknown gates fail closed
  const residue = REVIEWER_RESIDUE[name];
  const blockers = Array.isArray(value?.blockers) ? value.blockers : [];
  if (residue && value?.status === 'PENDING' && blockers.length && blockers.every(code => residue.includes(code))) {
    return DELIVERY_CLASS.NON_BLOCKING_PENDING;
  }
  return base;
}

const ACTIVATION_BLOCKER = Object.freeze({
  NOT_PUBLISHED: 'MACHINE_DELIVERY_CANONICAL_NOT_PUBLISHED',
  SNAPSHOT_INVALID: 'MACHINE_DELIVERY_RULES_SNAPSHOT_INVALID',
  SCHEMA_NOT_ACTIVATED: 'MACHINE_DELIVERY_SCHEMA_NOT_ACTIVATED',
});

const unresolvedEntry = (name, value, classification, extra = {}) => Object.freeze({
  gate: name,
  classification,
  status: typeof value?.status === 'string' ? value.status : 'NOT_RUN',
  blockers: Object.freeze([...(Array.isArray(value?.blockers) ? value.blockers : [])]),
  ...extra,
});

const validRulesSnapshot = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/**
 * Authority is selected by the Published Canonical identity, never by a PR,
 * candidate document, caller, transport, or model.
 */
export function machineDeliveryAuthority(canonical) {
  const blockers = [];
  if (canonical?.canonical_status !== 'PUBLISHED') blockers.push(ACTIVATION_BLOCKER.NOT_PUBLISHED);
  if (!validRulesSnapshot(canonical?.rules_snapshot_sha)) blockers.push(ACTIVATION_BLOCKER.SNAPSHOT_INVALID);
  if (canonical?.machine_delivery_schema !== MACHINE_DELIVERY_SCHEMA) blockers.push(ACTIVATION_BLOCKER.SCHEMA_NOT_ACTIVATED);
  return Object.freeze({
    active: blockers.length === 0,
    blockers: Object.freeze(blockers),
    canonical_version: canonical?.canonical_version ?? null,
    canonical_status: canonical?.canonical_status ?? null,
    rules_snapshot_sha: canonical?.rules_snapshot_sha ?? null,
    machine_delivery_schema: canonical?.machine_delivery_schema ?? null,
  });
}

/**
 * The gates that stop delivery for one readiness result: the single answer
 * Final, the emitter and the run loop all use.
 *
 * Under the loaded release without machine-delivery authority it is the
 * pre-game blockers. Under an active release it is the ledger's BLOCKING phase,
 * plus any pre-game blocker the ledger does not account for at all: a gate the
 * projection never saw fails closed, never through.
 */
export function deliveryBlockingGates(readiness) {
  const preGame = Array.isArray(readiness?.preGameBlocking) ? readiness.preGameBlocking : [];
  const projection = readiness?.machineDelivery;
  if (projection?.authoritative !== true) return Object.freeze([...preGame]);
  const blocking = projection.blocking.map(entry => entry.gate);
  const ledger = new Set([...projection.blocking, ...projection.non_blocking_pending, ...projection.post_delivery].map(entry => entry.gate));
  return Object.freeze([...blocking, ...preGame.filter(name => !ledger.has(name))]);
}

function missingRequiredGates(gates) {
  return MACHINE_DELIVERY_GATE_NAMES.filter(name => !Object.prototype.hasOwnProperty.call(gates, name));
}

/**
 * One evaluator used by readiness, Final, reports, UI and MCP projections.
 *
 * projection_ready is the candidate-policy answer. ready/AUTOMATED_VALIDATED
 * are authoritative only after Published Canonical explicitly activates this
 * exact schema. This keeps an unpublished candidate from changing v1 delivery.
 */
export function evaluateMachineDelivery(gates, {
  preEmission = false,
  canonical = null,
  requireCompleteGateMap = false,
} = {}) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw Error('gates are required');

  const ledger = [];
  for (const [name, value] of Object.entries(gates)) {
    const classification = classify(name, value);
    if (!PASS_LIKE.has(value?.status)) ledger.push(unresolvedEntry(name, value, classification));
  }

  const missingGates = missingRequiredGates(gates);
  if (requireCompleteGateMap && missingGates.length) {
    ledger.unshift(unresolvedEntry(
      'machineDeliveryGateMap',
      { status: 'PENDING', blockers: [MACHINE_DELIVERY_GATE_MAP_INCOMPLETE] },
      DELIVERY_CLASS.BLOCKING,
      { missing_gates: Object.freeze([...missingGates]) },
    ));
  }

  const blocking = ledger.filter(entry => entry.classification === DELIVERY_CLASS.BLOCKING
    && !(preEmission && entry.gate === 'technical'));
  const pending = ledger.filter(entry => entry.classification === DELIVERY_CLASS.NON_BLOCKING_PENDING);
  const postDelivery = ledger.filter(entry => entry.classification === DELIVERY_CLASS.POST_DELIVERY);
  const projectionReady = blocking.length === 0;
  const authority = machineDeliveryAuthority(canonical);
  const ready = projectionReady && authority.active;

  return Object.freeze({
    schema: MACHINE_DELIVERY_SCHEMA,
    projection_version: MACHINE_DELIVERY_PROJECTION_VERSION,
    complete_gate_map: missingGates.length === 0,
    missing_gates: Object.freeze([...missingGates]),
    projection_ready: projectionReady,
    authoritative: authority.active,
    activation: authority,
    ready,
    lifecycle: ready ? AUTOMATED_VALIDATED : 'CANDIDATE',
    blocking: Object.freeze(blocking),
    non_blocking_pending: Object.freeze(pending),
    post_delivery: Object.freeze(postDelivery),
    unresolved_evidence_ledger: Object.freeze(ledger),
    generic_mobile_projection: projectionReady && pending.some(entry => entry.gate === 'mobileAdaptation'),
    generic_mobile_delivery: ready && pending.some(entry => entry.gate === 'mobileAdaptation'),
    human_reviewed: false,
    in_game_accepted: false,
    notice: ready
      ? 'AUTOMATED_VALIDATED is an authoritative machine-delivery verdict under the active Published Canonical schema only. It is not Human reviewed or IN_GAME_ACCEPTED.'
      : 'Machine-delivery is an informational projection until Published Canonical activates this exact schema. Missing evidence remains recorded and no projection can create Human review, in-game acceptance, or a delivery permission.',
  });
}
