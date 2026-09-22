// Machine-delivery policy projection. The classifications are release data,
// not caller input: neither an AI nor a transport can promote a gate.
export const DELIVERY_CLASS = Object.freeze({
  BLOCKING: 'BLOCKING',
  NON_BLOCKING_PENDING: 'NON_BLOCKING_PENDING',
  POST_DELIVERY: 'POST_DELIVERY',
});

export const MACHINE_DELIVERY_SCHEMA = 'mabinogi-mobile-mml-studio/machine-delivery@1';
export const AUTOMATED_VALIDATED = 'AUTOMATED_VALIDATED';

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

const unresolvedEntry = (name, value, classification) => Object.freeze({
  gate: name,
  classification,
  status: typeof value?.status === 'string' ? value.status : 'NOT_RUN',
  blockers: Object.freeze([...(Array.isArray(value?.blockers) ? value.blockers : [])]),
});

/** One evaluator used by readiness, Final, reports, UI and MCP projections. */
export function evaluateMachineDelivery(gates, { preEmission = false } = {}) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw Error('gates are required');
  const ledger = [];
  for (const [name, value] of Object.entries(gates)) {
    const classification = CLASS_BY_GATE[name] ?? DELIVERY_CLASS.BLOCKING; // unknown gates fail closed
    if (!PASS_LIKE.has(value?.status)) ledger.push(unresolvedEntry(name, value, classification));
  }
  const blocking = ledger.filter(entry => entry.classification === DELIVERY_CLASS.BLOCKING
    && !(preEmission && entry.gate === 'technical'));
  const pending = ledger.filter(entry => entry.classification === DELIVERY_CLASS.NON_BLOCKING_PENDING);
  const postDelivery = ledger.filter(entry => entry.classification === DELIVERY_CLASS.POST_DELIVERY);
  const ready = blocking.length === 0;
  return Object.freeze({
    schema: MACHINE_DELIVERY_SCHEMA,
    ready,
    lifecycle: ready ? AUTOMATED_VALIDATED : 'CANDIDATE',
    blocking: Object.freeze(blocking),
    non_blocking_pending: Object.freeze(pending),
    post_delivery: Object.freeze(postDelivery),
    unresolved_evidence_ledger: Object.freeze(ledger),
    generic_mobile_delivery: pending.some(entry => entry.gate === 'mobileAdaptation'),
    human_reviewed: false,
    in_game_accepted: false,
    notice: 'AUTOMATED_VALIDATED is a machine-delivery verdict only. Pending evidence remains recorded; it does not mean Human reviewed or IN_GAME_ACCEPTED.',
  });
}

