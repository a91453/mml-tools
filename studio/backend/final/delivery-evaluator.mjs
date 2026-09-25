// Machine-delivery policy projection. The classifications are release data,
// not caller input: neither an AI nor a transport can promote a gate.
//
// This module imports nothing, on purpose. The application layer imports it
// statically and has to be able to report an unavailable Published Canonical
// instead of failing to load, so the gate codes it classifies on are restated
// here as string literals. studio/tests/machine-delivery-schemas.test.mjs pins
// every one of them to the module that emits it.
export const DELIVERY_CLASS = Object.freeze({
  BLOCKING: 'BLOCKING',
  NON_BLOCKING_PENDING: 'NON_BLOCKING_PENDING',
  POST_DELIVERY: 'POST_DELIVERY',
});

// The machine-delivery schemas a Published Canonical can declare.
//
//   @1  2026-09-23-v2: machine delivery, with Core3 completeness residue and
//       version-drift review delivered for listening first.
//   @2  2026-09-23-v3: @1, plus sub-grid releases rendered provisionally and
//       Lead promotion without primary evidence (ACCEPTANCE_CRITERIA "Machine
//       delivery", "Delivered first, flagged for listening").
//
// A projection is classified under the schema of the Canonical identity it is
// evaluated under, and says which one. A stored projection keeps the schema it
// was recorded under (application/machine-delivery-migration.mjs).
export const MACHINE_DELIVERY_SCHEMA_V1 = 'mabinogi-mobile-mml-studio/machine-delivery@1';
export const MACHINE_DELIVERY_SCHEMA_V2 = 'mabinogi-mobile-mml-studio/machine-delivery@2';
export const MACHINE_DELIVERY_SCHEMAS = Object.freeze([MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2]);
export const MACHINE_DELIVERY_PROJECTION_VERSION = 2;
export const AUTOMATED_VALIDATED = 'AUTOMATED_VALIDATED';
export const MACHINE_DELIVERY_GATE_MAP_INCOMPLETE = 'MACHINE_DELIVERY_GATE_MAP_INCOMPLETE';

// What a delivery carries unresolved and must say so about. A flag is a label on
// a NON_BLOCKING_PENDING ledger entry; it is never a verdict.
export const DELIVERY_FLAG = Object.freeze({
  RELEASES_RENDERED_PROVISIONALLY: 'RELEASES_RENDERED_PROVISIONALLY',
  LEAD_UNVERIFIED: 'LEAD_UNVERIFIED',
});

// The codes a gate adds when the whole of its open question is one a person has
// to judge. Emitted by final/micro-gap-enforcement.mjs and final/readiness.mjs.
export const LISTEN_FIRST_CODES = Object.freeze({
  MICRO_TIMING_RELEASE_PROVISIONAL: 'MICRO_TIMING_RELEASE_PROVISIONAL',
  LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING: 'LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING',
});

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

// ACCEPTANCE_CRITERIA "Machine delivery": what a machine can determine blocks;
// what needs a person's judgment is delivered for listening first. Some
// BLOCKING gates carry both kinds of result, so the split is made on the gate's
// own status and blocker codes, never on caller input. A rule applies only to a
// PENDING whose every blocker is in `allowed` and, when `requires` is set, that
// carries `requires` -- the code the gate adds only when it has established the
// whole of its open question is of that kind. A PENDING with no blocker, or with
// any other blocker, stays in the gate's base class.
//
// @1 (2026-09-23-v2):
//   * core3Completeness -- FAIL (CORE3_INCOMPLETE: no Lead, or a Core3 that
//     depends on Chord3-Chord5) and an evaluation that did not run stay
//     BLOCKING; PENDING whose every blocker is reviewer residue does not;
//   * versionDrift -- its only unresolved state is a review request when
//     divergence increased (MASTER_RULES §10: a review trigger, not a verdict).
// @2 (2026-09-23-v3), in addition:
//   * microTiming -- every UNKNOWN interval is a release-side case the Final can
//     hold provisionally to the following attack or next grid point. Mixed
//     results, stream identity, analysis failure, invalid release records,
//     technical residue and anything else stay BLOCKING. That includes
//     MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE, left out on purpose: an
//     onset or role end no Final token sequence reaches is not a release, a
//     release it names is one under a keep claim or with no valid
//     representation, the provisional rendering never moves an attack or a
//     rest and holds only a release with a valid extension and no keep claim,
//     and the gate never adds the listen-first code beside it, so there is
//     nothing to deliver -- the same answer RELEASE_NOT_FINAL_REPRESENTABLE
//     gets without that code;
//   * leadPromotion -- every pending promotion is missing primary evidence and
//     nothing else. Demotion is another gate and is not touched; invalid
//     evidence, an origin outside the baseline, an ungraded promotion and an
//     unresolved identity correspondence stay BLOCKING.
const rule = (allowed, { requires = null, flag = null } = {}) => Object.freeze({ allowed: Object.freeze([...allowed]), requires, flag });

const RESIDUE_V1 = Object.freeze({
  core3Completeness: rule(['CORE3_COMPLETENESS_UNRESOLVED', 'CORE3_ENRICHMENT_DEPENDENCE_UNRESOLVED']),
  versionDrift: rule(['VERSION_DIVERGENCE_REVIEW_REQUIRED']),
});

const RESIDUE_V2 = Object.freeze({
  ...RESIDUE_V1,
  microTiming: rule([
    'MICRO_TIMING_CLASSIFICATION_UNKNOWN',
    'MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE',
    'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED',
    LISTEN_FIRST_CODES.MICRO_TIMING_RELEASE_PROVISIONAL,
  ], { requires: LISTEN_FIRST_CODES.MICRO_TIMING_RELEASE_PROVISIONAL, flag: DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY }),
  leadPromotion: rule([
    'LEAD_PROMOTION_EVIDENCE_REQUIRED',
    LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING,
  ], { requires: LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING, flag: DELIVERY_FLAG.LEAD_UNVERIFIED }),
});

const RESIDUE_BY_SCHEMA = Object.freeze({
  [MACHINE_DELIVERY_SCHEMA_V1]: RESIDUE_V1,
  [MACHINE_DELIVERY_SCHEMA_V2]: RESIDUE_V2,
});

// Gate names come from stored records too, so only own keys count: a gate named
// after an Object.prototype member must not find a class there.
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/**
 * The schema a projection is classified under: the one the Canonical identity
 * declares, when this implementation knows it. An identity that declares none
 * (v1), or one this implementation does not know, is classified under @1, the
 * stricter table, and has no machine-delivery authority either.
 */
export function machineDeliverySchemaOf(canonical) {
  const declared = canonical?.machine_delivery_schema;
  return MACHINE_DELIVERY_SCHEMAS.includes(declared) ? declared : MACHINE_DELIVERY_SCHEMA_V1;
}

function classify(name, value, schema) {
  const base = own(CLASS_BY_GATE, name) ?? DELIVERY_CLASS.BLOCKING; // unknown gates fail closed
  const residue = own(RESIDUE_BY_SCHEMA[schema] ?? RESIDUE_V1, name);
  const blockers = Array.isArray(value?.blockers) ? value.blockers : [];
  if (residue
    && value?.status === 'PENDING'
    && blockers.length
    && blockers.every(code => residue.allowed.includes(code))
    && (residue.requires === null || blockers.includes(residue.requires))) {
    return { classification: DELIVERY_CLASS.NON_BLOCKING_PENDING, flag: residue.flag };
  }
  return { classification: base, flag: null };
}

/**
 * One gate's delivery class under the schema `canonical` declares. The emitter
 * reads it before it renders anything provisionally, so it acts on exactly the
 * classification the ledger records.
 */
export function deliveryClassOf(name, value, { canonical = null } = {}) {
  return classify(name, value, machineDeliverySchemaOf(canonical)).classification;
}

// What a flagged entry lists, read from the gate's own report. Bounded to the
// fields a reader needs to find each item: the interval each release closes
// stays on the gate report and in the Final's own rendering records, so a
// ledger that is filed with every run and Final does not repeat it.
const text = value => (typeof value === 'string' ? value : null);
const FLAG_DETAILS = Object.freeze({
  [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY]: value => ({
    provisional_releases: Object.freeze((Array.isArray(value?.provisionalReleases) ? value.provisionalReleases : []).map(item => Object.freeze({
      event_id: text(item?.eventId),
      role: text(item?.role),
      release: text(item?.release),
      rendered_release: text(item?.heldTo),
      representation: text(item?.representation),
    }))),
  }),
  [DELIVERY_FLAG.LEAD_UNVERIFIED]: value => ({
    unverified_lead_event_ids: Object.freeze((Array.isArray(value?.unverifiedLeadEventIds) ? value.unverifiedLeadEventIds : []).filter(id => typeof id === 'string')),
  }),
});

// What an @2 micro-timing entry reports per symbolic source, whatever its class:
// the dominant offset before the next grid point, its share against the rule's
// minimum, and how many of that source's releases are held provisionally and
// how many remain unresolved (ACCEPTANCE_CRITERIA "Delivered first, flagged for
// listening", rule 1). Read from the gate's own report.
const SCHEMA_DETAILS = Object.freeze({
  [MACHINE_DELIVERY_SCHEMA_V2]: Object.freeze({
    microTiming: value => ({
      release_offset_sources: Object.freeze((Array.isArray(value?.releaseOffsetSources) ? value.releaseOffsetSources : []).map(item => Object.freeze({
        source_id: text(item?.sourceId),
        dominant_offset: text(item?.dominantOffset),
        share: text(item?.share),
        share_percent: text(item?.sharePercent),
        minimum_share: text(item?.minimumShare),
        qualifies: item?.qualifies === true,
        release_count: Number.isInteger(item?.releaseCount) ? item.releaseCount : null,
        provisionally_rendered: Number.isInteger(item?.provisionallyRendered) ? item.provisionallyRendered : null,
        unresolved: Number.isInteger(item?.unresolved) ? item.unresolved : null,
      }))),
    }),
  }),
});

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
  if (!MACHINE_DELIVERY_SCHEMAS.includes(canonical?.machine_delivery_schema)) blockers.push(ACTIVATION_BLOCKER.SCHEMA_NOT_ACTIVATED);
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
 * are authoritative only after Published Canonical explicitly activates a
 * machine-delivery schema. This keeps an unpublished candidate from changing
 * delivery, and the schema the identity declares decides the classification.
 */
export function evaluateMachineDelivery(gates, {
  preEmission = false,
  canonical = null,
  requireCompleteGateMap = false,
} = {}) {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw Error('gates are required');

  const schema = machineDeliverySchemaOf(canonical);
  const ledger = [];
  for (const [name, value] of Object.entries(gates)) {
    if (PASS_LIKE.has(value?.status)) continue;
    const { classification, flag } = classify(name, value, schema);
    const detail = own(SCHEMA_DETAILS[schema] ?? {}, name);
    ledger.push(unresolvedEntry(name, value, classification, {
      ...(detail ? detail(value) : {}),
      ...(flag ? { delivery_flag: flag, ...FLAG_DETAILS[flag](value) } : {}),
    }));
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
  const flags = Object.freeze([...new Set(pending.map(entry => entry.delivery_flag).filter(Boolean))]);

  return Object.freeze({
    schema,
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
    // What a delivery under this projection is flagged with: each flag names an
    // unresolved NON_BLOCKING_PENDING entry, never a verdict.
    delivery_flags: flags,
    generic_mobile_projection: projectionReady && pending.some(entry => entry.gate === 'mobileAdaptation'),
    generic_mobile_delivery: ready && pending.some(entry => entry.gate === 'mobileAdaptation'),
    human_reviewed: false,
    in_game_accepted: false,
    notice: `${ready
      ? 'AUTOMATED_VALIDATED is an authoritative machine-delivery verdict under the active Published Canonical schema only. It is not Human reviewed or IN_GAME_ACCEPTED.'
      : 'Machine-delivery is an informational projection until Published Canonical activates this exact schema. Missing evidence remains recorded and no projection can create Human review, in-game acceptance, or a delivery permission.'}${flags.length
      ? ' Each delivery flag names a result that stays unresolved until evidence decides it.'
      : ''}`,
  });
}
