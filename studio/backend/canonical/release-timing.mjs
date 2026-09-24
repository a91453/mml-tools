// Source release timing, analysis precision and Final representation.
//
// Implementation notes, not a Canonical rule source. Implements, and adds no
// rule to, Published Canonical 2026-09-13-v1 (rules snapshot
// 0a172900a01fdf39c2e9e84cf176961320b779ea):
//
//   MOBILE_SYNTAX §3   plain lengths 1–64 (caution for non-preferred ones) and
//                      single-dot shorthand on the preferred binary bases.
//   MOBILE_SYNTAX §4   the 1/64 safe timing resolution is a FINAL_CANONICAL_POLICY;
//                      technical micro-gaps / decomposition components finer than
//                      1/64 are FINAL_FORBIDDEN *when they have no source-supported
//                      musical meaning*.
//   MOBILE_SYNTAX §11  preserve source attacks/rests; no non-musical technical
//                      micro-gap remains; keep a reversible mapping to source
//                      events and decisions.
//   MASTER_RULES §3/§7 source-faithful baseline first; no silent duration
//                      change; technical micro-gaps *may* be normalized.
//   SOURCE_POLICY §1   official symbolic sources are primary for written
//                      duration, original official audio is primary for sustain
//                      / articulation / practical timing, third-party sources are
//                      supporting only; §6 audio metrics are locators.
//   ACCEPTANCE Gate 8  Mobile adaptations are minimal, evidence-backed and
//                      reported as adaptation, never as a source correction.
//
// Three layers are kept apart and never collapsed into one another:
//
//   A. SOURCE / PERFORMANCE EVIDENCE — the Source-Faithful Baseline release, read
//      literally from the source (for MIDI: the note-off tick). Never rewritten.
//   B. ANALYSIS — exact arithmetic over those values: which releases have no
//      Final decomposition at all, which 1/64-safe representations exist next to
//      them, what each one would change. Analysis precision may be finer than the
//      Final grid; it is evidence, not syntax, and it decides nothing.
//   C. MOBILE FINAL REPRESENTATION — a release moved onto the 1/64 grid only by an
//      explicit, accepted, evidence-backed decision, recorded on the
//      event together with the untouched source release so that the mapping stays
//      reversible and the baseline diff shows the change.
//
// What "not Final-representable" means here is a proof, not a threshold. Every
// Final length token the executable contract admits lasts 1/n of a whole note
// (n in the official 1–64 range) or 3/(2n) for a single-dotted preferred base, so
// any finite sum of them has a denominator dividing L = lcm(all those token
// denominators). A boundary whose whole-note position has a reduced denominator
// that does not divide L cannot be reached by *any* exact token sequence — for
// example a MIDI note-off one tick before a 1/64 grid point at 480 ticks per
// quarter (denominator 2^7·15 whole notes against L's 2^6). Off-grid positions
// whose denominator does divide L (triplets, other caution lengths) are
// representable in principle and are never adaptation targets here.
//
// Scope limit, stated rather than hidden. "Representable in principle" is judged
// against the full admitted lattice, caution lengths included, while Finalize
// runs the emitter without the caution opt-in. A release two 480-tpq ticks
// before the grid (1/960 whole note; 960 divides L) is therefore
// CAUTION_REPRESENTABLE here, is never a representation target, and still fails
// closed at serialization under the preferred-only lattice. This module offers
// no route for it: the one-tick encoding it was built for is exactly
// NOT_FINAL_REPRESENTABLE, and widening the target set to caution positions is a
// separate decision, not something to infer from the grid.
//
// Nothing in this module classifies a sub-grid interval as meaningful or
// meaningless from its size, from a statistical or quantization-looking pattern,
// from a source type, or from the fact that a tool produced it. A uniform
// encoding pattern is reported as an observation (`SOURCE_ENCODING_PATTERN`) and
// is explicitly not admissible evidence. Meaning is established only by a
// decision whose evidence is admissible under SOURCE_POLICY.
//
// Who submitted a decision is not what makes its evidence count. Four things
// are kept apart (see `gradeReleaseEvidence`):
//
//   provenance  who submitted the decision — a person, a conversational AI, a
//               tool, an MCP client, an imported record. Recorded for the audit
//               trail and required for it; never read by the grader.
//   source      what the cited item is, resolved against the project's evidence
//               registry: its class, kind, bytes and independence. SOURCE_POLICY
//               §1 decides what each class may prove.
//   basis       how the finding was derived from that source: a direct review of
//               the source itself, or a metric, alignment locator, encoding
//               pattern or imported assertion (SOURCE_POLICY §6: locators).
//   claim       what the representation asserts about the source event, and
//               which source classes SOURCE_POLICY lets support that claim.
//
// Published Canonical names no reviewer species for source evidence; the only
// actor-bound rule is ACCEPTANCE Gate 10 (in-game acceptance), which nothing
// here touches. A strong citation does not fail because an AI submitted it, and
// a weak one does not pass because a person did. The service verifies the cited
// source; it cannot verify the act of review, and says so.
import { f, F, ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { SAFE_GRID, MICRO_TIMING_KEEP_ACTION } from './micro-timing.mjs';

export const RELEASE_TIMING_SCHEMA = 'mml-studio/release-timing-analysis@1';
export const RELEASE_REPRESENTATION_RECORD_SCHEMA = 'mml-studio/release-representation-record@1';
export const RELEASE_REPRESENTATION_DECISION_SCHEMA = 'mml-studio/release-representation-decision@1';
export const RELEASE_RECORD_KEY = 'releaseRepresentation';

export const POSITION_CLASS = Object.freeze({
  // A whole number of 1/64 notes: expressible with preferred lengths only.
  SAFE_GRID: 'SAFE_GRID',
  // Off the 1/64 grid but reachable by admitted caution lengths (MOBILE_SYNTAX §3),
  // e.g. a triplet. Source timing is kept as it is; nothing here adapts it.
  CAUTION_REPRESENTABLE: 'CAUTION_REPRESENTABLE',
  // No finite sequence of admitted Final tokens reaches this position.
  NOT_FINAL_REPRESENTABLE: 'NOT_FINAL_REPRESENTABLE',
});

export const REPRESENTATION = Object.freeze({
  EXTEND_TO_NEXT_GRID: 'EXTEND_TO_NEXT_GRID',
  TRUNCATE_TO_PREVIOUS_GRID: 'TRUNCATE_TO_PREVIOUS_GRID',
});

export const TARGET_STATUS = Object.freeze({
  // A release no Final token sequence can express; a representation decision is
  // required before Final can carry it.
  REPRESENTATION_DECISION_REQUIRED: 'REPRESENTATION_DECISION_REQUIRED',
  // A decision already moved this release; the event carries its record.
  REPRESENTED_BY_DECISION: 'REPRESENTED_BY_DECISION',
  // A keep decision claims the sub-grid timing is musically meaningful. Final
  // cannot express it under the loaded Canonical: UNSUPPORTED, never adapted.
  SOURCE_SUPPORTED_NOT_REPRESENTABLE: 'SOURCE_SUPPORTED_NOT_REPRESENTABLE',
  // No 1/64-safe representation exists that keeps attacks, rests and pitch
  // identity intact, so nothing can be proposed.
  NO_VALID_REPRESENTATION: 'NO_VALID_REPRESENTATION',
});

export const RELEASE_REFUSAL = Object.freeze({
  EVENT_NOT_A_TARGET: 'RELEASE_EVENT_IS_NOT_A_REPRESENTATION_TARGET',
  EVENT_UNKNOWN: 'RELEASE_EVENT_NOT_IN_CANDIDATE',
  REPRESENTATION_INVALID: 'RELEASE_REPRESENTATION_NOT_VALID_FOR_EVENT',
  DECISION_CONFLICT: 'RELEASE_EVENT_NAMED_BY_MORE_THAN_ONE_DECISION',
  KEEP_DECISION_PRESENT: 'RELEASE_EVENT_HAS_A_SOURCE_SUPPORTED_KEEP_CLAIM',
});

export const EVIDENCE_CLASS = Object.freeze({
  PRIMARY_SYMBOLIC: 'primary-symbolic',
  PRIMARY_AUDIO: 'primary-audio',
});

// Classes a caller may name that are recorded and never counted, each with the
// reason. They exist so a reviewer sees why a citation did not move anything,
// instead of an "unknown class" error for evidence the project really has.
export const NON_ADMISSIBLE_EVIDENCE_CLASSES = Object.freeze({
  'third-party': 'SOURCE_POLICY §1C: third-party score/MIDI/MML is supporting arrangement evidence only; it can prove neither the presence nor the absence of musical meaning in a sub-grid release.',
  'source-encoding-pattern': 'A uniform encoding pattern is machine-derived structure over a supporting source, not source-supported musical meaning (canonical/timing.mjs: never inferred from a statistical or quantization-looking pattern).',
  'audio-metric': 'SOURCE_POLICY §6: onset/release/DTW/correlation metrics are evidence locators, not identity or articulation verdicts.',
  'tool-output': 'SOURCE_POLICY §8 / §1 D2: converter, editor and preview output is a comparison candidate, not authority.',
  'accepted-prior': 'SOURCE_POLICY §1 D1 is admissible in principle, but this build has no accepted-previous-version record to bind a citation to; it stays PENDING rather than being accepted on assertion.',
});

// Who submitted a decision. Provenance only: recorded, required for the audit
// trail, and never an input to the grade.
export const DECISION_AUTHOR_KINDS = Object.freeze(['human', 'agent', 'tool', 'mcp-client', 'imported']);

// How an item's finding was derived from the cited source.
export const EVIDENCE_BASIS = Object.freeze({
  // The finding was read from the cited source itself: the notated durations of
  // a score, or the recording's own sustain and articulation at the locator.
  DIRECT_SOURCE_REVIEW: 'direct-source-review',
  MACHINE_METRIC: 'machine-metric',
  ALIGNMENT_LOCATOR: 'alignment-locator',
  ENCODING_PATTERN: 'encoding-pattern',
  IMPORTED_ASSERTION: 'imported-assertion',
});

// Bases a caller may state that are recorded and never establish a finding.
export const NON_ADMISSIBLE_EVIDENCE_BASES = Object.freeze({
  [EVIDENCE_BASIS.MACHINE_METRIC]: 'SOURCE_POLICY §6: a metric computed from a source (onset, release, envelope, DTW, correlation, F0, confidence) is an evidence locator, not a musical verdict about that source.',
  [EVIDENCE_BASIS.ALIGNMENT_LOCATOR]: 'SOURCE_POLICY §6: beat↔recording alignment locates where to look; it does not say what is there.',
  [EVIDENCE_BASIS.ENCODING_PATTERN]: 'A regularity in how a file encodes releases is structure over that file, not source-supported musical meaning.',
  [EVIDENCE_BASIS.IMPORTED_ASSERTION]: 'A statement copied from elsewhere does not show what the cited source contains.',
});

// What a release representation asserts about the source event.
export const RELEASE_CLAIM = Object.freeze({
  // The source event is held to the grid point: the sub-grid gap after it has no
  // counterpart in the source.
  SUSTAINS_TO_GRID: 'SOURCE_EVENT_SUSTAINS_TO_GRID_POINT',
  // The source event ends at or before the grid point: the sub-grid overhang has
  // no counterpart in the source.
  RELEASES_BY_GRID: 'SOURCE_EVENT_RELEASES_BY_PREVIOUS_GRID_POINT',
});

// Which evidence classes SOURCE_POLICY §1 lets support each claim, and why.
export const RELEASE_CLAIM_AUTHORITY = Object.freeze({
  [RELEASE_CLAIM.SUSTAINS_TO_GRID]: Object.freeze({
    'primary-symbolic': 'SOURCE_POLICY §1A: primary authority for onset and duration.',
    'primary-audio': 'SOURCE_POLICY §1B: primary authority for sustain/articulation and performance timing.',
  }),
  [RELEASE_CLAIM.RELEASES_BY_GRID]: Object.freeze({
    'primary-symbolic': 'SOURCE_POLICY §1A: primary authority for onset and duration.',
    'primary-audio': 'SOURCE_POLICY §1B: primary authority for sustain/articulation and performance timing.',
  }),
});

export const EVIDENCE_REFUSAL = Object.freeze({
  PROVENANCE_MISSING: 'DECISION_PROVENANCE_MISSING',
  CLASS_NOT_ADMISSIBLE: 'EVIDENCE_CLASS_NOT_ADMISSIBLE',
  REF_UNKNOWN: 'EVIDENCE_REFERENCE_NOT_IN_PROJECT',
  REF_HOLDS_NO_BYTES: 'EVIDENCE_REFERENCE_NOT_BACKED_BY_PROJECT_BYTES',
  KIND_MISMATCH: 'EVIDENCE_REFERENCE_KIND_DOES_NOT_MATCH_CLASS',
  NOT_INDEPENDENT: 'EVIDENCE_SOURCE_NOT_INDEPENDENT',
  LOCATOR_MISSING: 'EVIDENCE_LOCATOR_MISSING',
  FINDING_MISSING: 'EVIDENCE_FINDING_MISSING',
  BASIS_MISSING: 'EVIDENCE_BASIS_MISSING',
  BASIS_NOT_SOURCE_REVIEW: 'EVIDENCE_BASIS_IS_NOT_A_DIRECT_SOURCE_REVIEW',
  CLAIM_NOT_SUPPORTED: 'EVIDENCE_CLASS_CANNOT_SUPPORT_CLAIM',
  NO_ADMISSIBLE_ITEM: 'NO_ADMISSIBLE_EVIDENCE',
});

// What would settle a release that still needs a decision, given the sources the
// project really holds. Any one of the listed items is enough.
export const RELEASE_EVIDENCE_REQUIREMENT = Object.freeze({
  ORIGINAL_AUDIO_REVIEW_REQUIRED: 'ORIGINAL_AUDIO_ARTICULATION_REVIEW_REQUIRED',
  ORIGINAL_AUDIO_SOURCE_REQUIRED: 'ORIGINAL_AUDIO_SOURCE_REQUIRED',
  SYMBOLIC_SOURCE_REVIEW_REQUIRED: 'INDEPENDENT_SYMBOLIC_SOURCE_REVIEW_REQUIRED',
  SYMBOLIC_SOURCE_REQUIRED: 'INDEPENDENT_SYMBOLIC_SOURCE_REQUIRED',
});

export const RECORD_VIOLATION = Object.freeze({
  BASELINE_SNAPSHOT_MISSING: 'RELEASE_RECORD_BASELINE_SNAPSHOT_MISSING',
  ORIGIN_MISSING: 'RELEASE_RECORD_SOURCE_EVENT_MISSING',
  SOURCE_RELEASE_MISMATCH: 'RELEASE_RECORD_SOURCE_RELEASE_MISMATCH',
  FINAL_RELEASE_MISMATCH: 'RELEASE_RECORD_FINAL_RELEASE_MISMATCH',
  OTHER_FIELD_CHANGED: 'RELEASE_RECORD_EVENT_CHANGED_BEYOND_RELEASE',
  DELTA_OUT_OF_RANGE: 'RELEASE_RECORD_DELTA_NOT_A_SUB_GRID_MOVE',
  FINAL_OFF_GRID: 'RELEASE_RECORD_FINAL_RELEASE_OFF_SAFE_GRID',
  SOURCE_REPRESENTABLE: 'RELEASE_RECORD_SOURCE_RELEASE_WAS_REPRESENTABLE',
  DECISION_MISSING: 'RELEASE_RECORD_DECISION_MISSING',
  DECISION_DOES_NOT_NAME_EVENT: 'RELEASE_RECORD_DECISION_DOES_NOT_NAME_EVENT',
  REPRESENTATION_MISMATCH: 'RELEASE_RECORD_REPRESENTATION_MISMATCH',
  DECISION_NOT_ADMISSIBLE: 'RELEASE_RECORD_DECISION_EVIDENCE_NOT_ADMISSIBLE',
  KEEP_CLAIM_PRESENT: 'RELEASE_RECORD_OVERRIDES_A_KEEP_CLAIM',
});

const syntax = EFFECTIVE_RULESET.mobileSyntax;
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isSpan = event => event && (event.kind === 'note' || event.kind === 'rest') && event.id && event.start != null && event.end != null;
const assigned = event => ROLES.includes(event?.role);

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
}
const lcm = (a, b) => (a / gcd(a, b)) * b;

// L for the admitted Final vocabulary, derived from the executable contract so
// this module restates no length list of its own.
function admittedLengthLcm() {
  let result = 1n;
  for (let n = syntax.officialLengthMin; n <= syntax.officialLengthMax; n += 1) result = lcm(result, BigInt(n));
  const forbidden = new Set(syntax.rejectDottedBasesInFinal);
  for (const n of syntax.preferredDottedBaseDenominators) {
    if (forbidden.has(n)) continue;
    // A single dot on base n lasts 3/(2n) of a whole note.
    const duration = new F(3, 2 * n);
    result = lcm(result, duration.d);
  }
  return result;
}

export const FINAL_LENGTH_LCM = admittedLengthLcm();

// Canonical IR beats are quarter notes; a whole note is four of them.
const wholeNotes = beat => f(beat).div(4);

export function classifyPosition(beat) {
  const value = f(beat);
  if (value.div(SAFE_GRID).d === 1n) return POSITION_CLASS.SAFE_GRID;
  return FINAL_LENGTH_LCM % wholeNotes(value).d === 0n
    ? POSITION_CLASS.CAUTION_REPRESENTABLE
    : POSITION_CLASS.NOT_FINAL_REPRESENTABLE;
}

// Exact neighbouring safe-grid points of an off-grid position.
function gridNeighbours(beat) {
  const units = f(beat).div(SAFE_GRID);
  const floorUnits = units.n >= 0n ? units.n / units.d : -((-units.n + units.d - 1n) / units.d);
  const floor = new F(floorUnits, 1n).mul(SAFE_GRID);
  return { floor, ceil: floor.add(SAFE_GRID) };
}

function ticksOf(event, delta) {
  const tpq = event?.metadata?.ticksPerQuarter;
  if (!Number.isInteger(tpq) || tpq <= 0) return null;
  const ticks = f(delta).mul(tpq);
  return ticks.d === 1n ? Number(ticks.n) : null;
}

// Descriptive only: the seconds a beat span lasts under the project's Tempo Map.
// Floating point is acceptable here because nothing reads it as a verdict; every
// decision above is exact.
export function spanSeconds(tempoEvents, startBeat, endBeat) {
  const tempos = [...(tempoEvents ?? [])].filter(t => Number.isFinite(t?.bpm) && t.bpm > 0).sort((a, b) => f(a.beat).cmp(b.beat));
  if (!tempos.length) return null;
  const start = f(startBeat);
  const end = f(endBeat);
  const sign = end.cmp(start) < 0 ? -1 : 1;
  const [lo, hi] = sign < 0 ? [end, start] : [start, end];
  let seconds = 0;
  let cursor = lo;
  let bpm = tempos[0].bpm;
  for (const tempo of tempos) {
    const at = f(tempo.beat);
    if (at.cmp(cursor) <= 0) { bpm = tempo.bpm; continue; }
    if (at.cmp(hi) >= 0) break;
    seconds += at.sub(cursor).num() * 60 / bpm;
    cursor = at;
    bpm = tempo.bpm;
  }
  seconds += hi.sub(cursor).num() * 60 / bpm;
  return sign * seconds;
}

const secondsText = value => (value === null ? null : (Math.round(value * 1e6) / 1e3).toFixed(3));

// Events whose *release boundary* an open keep claim covers. A keep decision
// names an interval (canonical/micro-timing.mjs), so it is about this release
// only when that interval is the event's own duration or the gap that follows
// it; a claim on the gap *before* the event says nothing about its release. An
// accepted or pending keep is an open claim; a rejected one is not.
function releaseKeepClaims(project) {
  const ids = new Set();
  for (const decision of project?.decisions ?? []) {
    if (decision?.action !== MICRO_TIMING_KEEP_ACTION) continue;
    if (decision.status !== 'accepted' && decision.status !== 'pending') continue;
    const identity = decision.metadata?.intervalIdentity;
    if (identity?.type === 'event-duration' && text(identity.eventId)) ids.add(identity.eventId);
    else if (identity?.type === 'inter-event-gap' && text(identity.previousEventId)) ids.add(identity.previousEventId);
  }
  return ids;
}

// The Source-Faithful origin of a candidate event: the baseline event with the
// same id, or — for a justified derived duplicate — the baseline event its
// reversible `derivedFromEventId` chain leads to. Never matched by pitch or time.
function originResolver(baselineEvents, candidateEvents) {
  const baselineById = new Map((baselineEvents ?? []).map(event => [event.id, event]));
  const candidateById = new Map((candidateEvents ?? []).map(event => [event.id, event]));
  return id => {
    const seen = new Set();
    let current = id;
    while (typeof current === 'string' && !seen.has(current)) {
      if (baselineById.has(current)) return baselineById.get(current);
      seen.add(current);
      current = candidateById.get(current)?.metadata?.g11d?.derivedFromEventId ?? null;
    }
    return null;
  };
}

function sourcesById(project) {
  return new Map((project?.sources ?? []).filter(s => text(s?.id)).map(source => [source.id, source]));
}

// One role's spans, ordered, with exact bounds parsed once and the lookups the
// analysis needs answered by binary search instead of a scan per release.
function indexStream(spans) {
  const entries = spans.map(event => ({ event, start: f(event.start), end: f(event.end) }))
    .sort((a, b) => a.start.cmp(b.start) || a.end.cmp(b.end) || cmpStr(String(a.event.id), String(b.event.id)));
  const prefixMaxEnd = [];
  for (const [index, entry] of entries.entries()) prefixMaxEnd.push(index && prefixMaxEnd[index - 1].cmp(entry.end) > 0 ? prefixMaxEnd[index - 1] : entry.end);
  const rests = entries.filter(entry => entry.event.kind === 'rest');
  // First index whose start is > value (strict) or >= value.
  const search = (value, strict) => {
    let low = 0; let high = entries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const c = entries[mid].start.cmp(value);
      if (strict ? c > 0 : c >= 0) high = mid; else low = mid + 1;
    }
    return low;
  };
  return {
    entries,
    events: entries.map(entry => entry.event),
    // Another note of this role attacks exactly here.
    noteStartsAt(value, selfId) {
      for (let i = search(value, false); i < entries.length && entries[i].start.cmp(value) === 0; i += 1) {
        if (entries[i].event.kind === 'note' && entries[i].event.id !== selfId) return true;
      }
      return false;
    },
    // Some span of this role is sounding/resting across `value`.
    coveredAt(value) {
      const upto = search(value, false);
      return upto > 0 && prefixMaxEnd[upto - 1].cmp(value) > 0;
    },
    // The first span starting at or after `value`, other than `selfId`.
    nextFrom(value, selfId) {
      for (let i = search(value, false); i < entries.length; i += 1) if (entries[i].event.id !== selfId) return entries[i];
      return null;
    },
    // Any span, other than `selfId`, starting strictly inside (lo, hi).
    startsInside(lo, hi, selfId) {
      for (let i = search(lo, true); i < entries.length && entries[i].start.cmp(hi) < 0; i += 1) if (entries[i].event.id !== selfId) return true;
      return false;
    },
    // Any explicit rest overlapping (lo, hi).
    restOverlaps(lo, hi) {
      return rests.some(entry => entry.start.cmp(hi) < 0 && entry.end.cmp(lo) > 0);
    },
  };
}

function roleStreams(project) {
  const byRole = new Map();
  for (const event of (project?.events ?? []).filter(isSpan)) {
    if (!assigned(event)) continue;
    if (!byRole.has(event.role)) byRole.set(event.role, []);
    byRole.get(event.role).push(event);
  }
  return new Map([...byRole.entries()].map(([role, spans]) => [role, indexStream(spans)]));
}

// Assigned notes per pitch, ordered by onset, with the longest duration so an
// overlap query only walks back as far as any note could still be sounding.
function notesByPitch(project) {
  const byPitch = new Map();
  for (const event of project?.events ?? []) {
    if (event?.kind !== 'note' || !assigned(event)) continue;
    if (!byPitch.has(event.pitch)) byPitch.set(event.pitch, []);
    byPitch.get(event.pitch).push({ event, start: f(event.start), end: f(event.end) });
  }
  const index = new Map();
  for (const [pitch, list] of byPitch) {
    list.sort((a, b) => a.start.cmp(b.start));
    const longest = list.reduce((max, item) => { const d = item.end.sub(item.start); return d.cmp(max) > 0 ? d : max; }, new F(0));
    index.set(pitch, {
      // Notes of this pitch sounding somewhere inside (lo, hi).
      overlapping(lo, hi) {
        let low = 0; let high = list.length;
        while (low < high) { const mid = (low + high) >> 1; if (list[mid].start.cmp(hi) < 0) low = mid + 1; else high = mid; }
        const found = [];
        const floor = lo.sub(longest);
        for (let i = low - 1; i >= 0 && list[i].start.cmp(floor) >= 0; i -= 1) if (list[i].end.cmp(lo) > 0) found.push(list[i]);
        return found;
      },
    });
  }
  return index;
}
const NO_PITCH = Object.freeze({ overlapping: () => [] });

function recordOf(event) {
  const record = event?.metadata?.[RELEASE_RECORD_KEY];
  return plainObject(record) ? record : null;
}

// Evaluate one representation option for a release. Pure arithmetic over the
// candidate; the result says what the option *would* change, never whether it is
// musically right.
function evaluateOption(kind, { event, stream, samePitch, release, floor, ceil, following, nextOnset, restAtRelease = false }) {
  const start = f(event.start);
  const to = kind === REPRESENTATION.EXTEND_TO_NEXT_GRID ? ceil : floor;
  const delta = to.sub(release);
  const reasons = [];
  if (kind === REPRESENTATION.EXTEND_TO_NEXT_GRID) {
    // A later same-role span starting before the new release would be overlapped:
    // that is an attack moved or swallowed, never a representation choice.
    if (stream.startsInside(release, to, event.id)) reasons.push('EXTENSION_CROSSES_A_SAME_ROLE_ONSET');
    if (stream.restOverlaps(release, to)) reasons.push('EXTENSION_ENTERS_AN_EXPLICIT_REST');
    // A new same-pitch overlap with another role is a collision the source did not
    // have (MASTER_RULES §6 review signal); an option that creates one is not offered.
    if (samePitch.overlapping(release, to).some(peer => peer.event.id !== event.id && peer.event.role !== event.role
      && !(peer.start.cmp(release) < 0 && peer.end.cmp(event.start) > 0))) reasons.push('EXTENSION_INTRODUCES_CROSS_ROLE_SAME_PITCH_OVERLAP');
    if (nextOnset) {
      const after = nextOnset.sub(to);
      if (after.cmp(0) > 0 && after.cmp(SAFE_GRID) < 0) reasons.push('FOLLOWING_SILENCE_WOULD_BECOME_SUB_GRID');
    }
  } else {
    const duration = to.sub(start);
    if (duration.cmp(0) <= 0) reasons.push('TRUNCATION_WOULD_DELETE_THE_ATTACK');
    else if (duration.cmp(SAFE_GRID) < 0) reasons.push('TRUNCATION_WOULD_LEAVE_A_SUB_GRID_NOTE');
    if (stream.restOverlaps(to, release)) reasons.push('TRUNCATION_ENTERS_AN_EXPLICIT_REST');
    if (nextOnset) {
      const after = nextOnset.sub(to);
      if (after.cmp(0) > 0 && after.cmp(SAFE_GRID) < 0) reasons.push('FOLLOWING_SILENCE_WOULD_BECOME_SUB_GRID');
    }
    // An explicit rest that begins at this release keeps its unrepresentable
    // start whichever way the note moves; that is a rest-boundary question
    // (technical timing repair), not a release representation.
    if (restAtRelease) reasons.push('RELEASE_ADJOINS_AN_EXPLICIT_REST');
  }
  const silenceBefore = following;
  let silenceAfter = null;
  if (nextOnset) silenceAfter = nextOnset.sub(to);
  let effect;
  if (kind === REPRESENTATION.EXTEND_TO_NEXT_GRID) {
    if (!nextOnset) effect = 'role-end-moves-later';
    else if (silenceAfter.cmp(0) === 0) effect = 'sub-grid-gap-closed';
    else effect = 'following-rest-shortened';
  } else if (!nextOnset) effect = 'role-end-moves-earlier';
  else if (silenceBefore !== null && silenceBefore.cmp(SAFE_GRID) >= 0) effect = 'following-rest-lengthened';
  else effect = 'new-rest-inserted';
  // A new audible silence where the source shows none (or only a sub-grid gap) is
  // a new articulation the source does not carry.
  const introducesArticulation = kind === REPRESENTATION.TRUNCATE_TO_PREVIOUS_GRID
    && nextOnset !== null && (silenceBefore === null || silenceBefore.cmp(SAFE_GRID) < 0);
  return Object.freeze({
    representation: kind,
    valid: reasons.length === 0,
    reasons: Object.freeze(reasons),
    finalRelease: to.toString(),
    delta: delta.toString(),
    deltaTicks: ticksOf(event, delta),
    effect,
    followingSilenceBefore: silenceBefore === null ? null : silenceBefore.toString(),
    followingSilenceAfter: silenceAfter === null ? null : silenceAfter.toString(),
    introducesArticulation,
    attackIdentityPreserved: true,
    pitchPreserved: true,
    tieIntroduced: false,
  });
}

const absolute = value => { const v = f(value); return v.cmp(0) < 0 ? v.mul(-1) : v; };

function recommend(options) {
  const valid = options.filter(option => option.valid);
  if (!valid.length) return { recommended: null, basis: 'no-valid-representation' };
  // Minimal necessary adaptation (MASTER_RULES §2): first never add an articulation
  // the source does not carry, then move the release as little as possible. A tie
  // is left to the reviewer rather than broken by an implementer preference.
  const ranked = [...valid].sort((a, b) => Number(a.introducesArticulation) - Number(b.introducesArticulation)
    || absolute(a.delta).cmp(absolute(b.delta)));
  const [first, second] = ranked;
  if (second && first.introducesArticulation === second.introducesArticulation && absolute(first.delta).cmp(absolute(second.delta)) === 0) {
    return { recommended: null, basis: 'multiple-equally-minimal-representations' };
  }
  if (first.introducesArticulation) return { recommended: first.representation, basis: 'only-valid-representations-add-an-articulation' };
  return { recommended: first.representation, basis: 'minimal-change-without-new-articulation' };
}

// The following shapes after which the sub-grid *interval* analyzer
// (canonical/micro-timing.mjs) builds no interval at the release.
const SHAPES_WITHOUT_AN_INTERVAL = new Set(['rest-of-at-least-safe-grid', 'role-end', 'covered-by-same-role-span', 'explicit-rest-at-release']);

/**
 * Whether a release target is one `notVisibleToIntervalAnalyzerCount` counts:
 * the sub-grid interval analyzer has no interval for it (the release is followed
 * by a rest of at least the safe grid, an explicit rest, a same-role span, or
 * ends the role, and the note itself is not a sub-grid duration), and no keep
 * claim takes it out of the representation question. Exactly these are what
 * `final/micro-gap-enforcement.mjs` raises
 * MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE for, so a caller asking "does
 * the release side decide this release" asks this, not its own copy.
 */
export function isNotVisibleToIntervalAnalyzer(target) {
  return target.status !== TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE
    && SHAPES_WITHOUT_AN_INTERVAL.has(target.analysis.followingShape)
    && f(target.source.duration).cmp(SAFE_GRID) >= 0;
}

/**
 * Layer A/B analysis of every note release in the candidate's assigned roles.
 *
 * `baseline` is the Source-Faithful Baseline the candidate derives from; a
 * candidate release that a recorded decision already moved is reported against
 * the baseline value, which is never changed.
 */
export function analyzeReleaseTiming({ candidate, baseline = null, windowGapBeats = '4' } = {}) {
  if (!candidate || !Array.isArray(candidate.events)) throw Error('release timing analysis requires a Canonical candidate');
  const streams = roleStreams(candidate);
  const byPitch = notesByPitch(candidate);
  const resolveOrigin = originResolver(baseline?.events ?? [], candidate.events);
  const keepClaims = releaseKeepClaims(candidate);
  const sources = sourcesById(candidate);
  const targets = [];
  const unsupportedBoundaries = [];
  const represented = [];
  let releaseCount = 0;
  const classCounts = { [POSITION_CLASS.SAFE_GRID]: 0, [POSITION_CLASS.CAUTION_REPRESENTABLE]: 0, [POSITION_CLASS.NOT_FINAL_REPRESENTABLE]: 0 };

  for (const [role, stream] of [...streams.entries()].sort(([a], [b]) => cmpStr(a, b))) {
    for (const span of stream.events) {
      // Onsets are attacks: nothing here may move one. An onset Final cannot
      // reach is reported as UNSUPPORTED, never offered for adaptation.
      if (classifyPosition(span.start) === POSITION_CLASS.NOT_FINAL_REPRESENTABLE) {
        unsupportedBoundaries.push(Object.freeze({ eventId: span.id, role, kind: span.kind, boundary: 'start', position: String(span.start), reason: span.kind === 'note' ? 'ONSET_NOT_FINAL_REPRESENTABLE' : 'REST_START_NOT_FINAL_REPRESENTABLE' }));
      }
      if (span.kind === 'rest') {
        // A rest ending where the next span starts shares that boundary; the
        // onset check above already reports it once.
        const after = stream.nextFrom(f(span.end), span.id);
        if (classifyPosition(span.end) === POSITION_CLASS.NOT_FINAL_REPRESENTABLE
          && !(after && after.start.cmp(span.end) === 0)) {
          unsupportedBoundaries.push(Object.freeze({ eventId: span.id, role, kind: 'rest', boundary: 'end', position: String(span.end), reason: 'REST_END_NOT_FINAL_REPRESENTABLE' }));
        }
        continue;
      }
      releaseCount += 1;
      const release = f(span.end);
      const positionClass = classifyPosition(release);
      classCounts[positionClass] += 1;
      const record = recordOf(span);
      if (record) {
        represented.push(Object.freeze({ eventId: span.id, role, decisionId: record.decisionId ?? null, sourceRelease: record.source?.end ?? null, finalRelease: String(span.end), representation: record.representation ?? null }));
        continue;
      }
      if (positionClass !== POSITION_CLASS.NOT_FINAL_REPRESENTABLE) continue;
      const anchored = stream.noteStartsAt(release, span.id);
      if (anchored) {
        unsupportedBoundaries.push(Object.freeze({ eventId: span.id, role, kind: 'note', boundary: 'end', position: release.toString(), reason: 'RELEASE_SHARED_WITH_AN_UNREPRESENTABLE_ONSET' }));
        continue;
      }
      const covered = stream.coveredAt(release);
      const nextEntry = stream.nextFrom(release, span.id);
      const next = nextEntry?.event ?? null;
      const nextOnset = nextEntry ? nextEntry.start : null;
      const following = nextOnset ? nextOnset.sub(release) : null;
      const restAtRelease = Boolean(nextEntry && nextEntry.event.kind === 'rest' && nextEntry.start.cmp(release) === 0);
      const { floor, ceil } = gridNeighbours(release);
      const context = { event: span, stream, samePitch: byPitch.get(span.pitch) ?? NO_PITCH, release, floor, ceil, following, nextOnset, restAtRelease };
      const options = covered
        ? []
        : [evaluateOption(REPRESENTATION.EXTEND_TO_NEXT_GRID, context), evaluateOption(REPRESENTATION.TRUNCATE_TO_PREVIOUS_GRID, context)];
      const { recommended, basis } = covered ? { recommended: null, basis: 'role-polyphony-at-release' } : recommend(options);
      const origin = resolveOrigin(span.id);
      const keepClaim = keepClaims.has(span.id);
      let status = TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED;
      if (keepClaim) status = TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE;
      else if (!options.some(option => option.valid)) status = TARGET_STATUS.NO_VALID_REPRESENTATION;
      const sourceClasses = (span.sourceIds ?? []).map(id => {
        const source = sources.get(id);
        return Object.freeze({ sourceId: id, kind: source?.kind ?? null, authority: source?.authority ?? null, sha256: source?.sha256 ?? null });
      });
      const nearestOffset = ceil.sub(release);
      targets.push(Object.freeze({
        eventId: span.id,
        role,
        voice: span.voice ?? null,
        pitch: span.pitch,
        sourceIds: Object.freeze([...(span.sourceIds ?? [])]),
        sourceEventIds: Object.freeze([...(span.sourceEventIds ?? [])]),
        sourceClasses: Object.freeze(sourceClasses),
        // Layer A: exactly what the source says, from the baseline when known.
        source: Object.freeze({
          onset: String(origin?.start ?? span.start),
          release: String(origin?.end ?? span.end),
          duration: f(origin?.end ?? span.end).sub(origin?.start ?? span.start).toString(),
          releaseOrigin: span.metadata?.timing?.end?.origin ?? null,
          ticksPerQuarter: Number.isInteger(span.metadata?.ticksPerQuarter) ? span.metadata.ticksPerQuarter : null,
          startTick: Number.isInteger(span.metadata?.startTick) ? span.metadata.startTick : null,
          endTick: Number.isInteger(span.metadata?.endTick) ? span.metadata.endTick : null,
          fromBaseline: Boolean(origin),
        }),
        // Layer B: exact arithmetic, finer than the Final grid.
        analysis: Object.freeze({
          positionClass,
          safeGridFloor: floor.toString(),
          safeGridCeil: ceil.toString(),
          offsetBeforeNextGrid: nearestOffset.toString(),
          offsetBeforeNextGridTicks: ticksOf(span, nearestOffset),
          offsetBeforeNextGridSeconds: secondsText(spanSeconds(candidate.tempoEvents, release, ceil)),
          followingSilence: following === null ? null : following.toString(),
          followingShape: covered ? 'covered-by-same-role-span'
            : restAtRelease ? 'explicit-rest-at-release'
              : following === null ? 'role-end'
                : following.cmp(SAFE_GRID) < 0 ? 'sub-grid-gap-to-next-onset' : 'rest-of-at-least-safe-grid',
          nextEventId: next?.id ?? null,
          nextIsSamePitchRepeatedAttack: Boolean(next && next.kind === 'note' && next.pitch === span.pitch),
          analysisNoise: false,
          measuredPerformanceRelease: null,
        }),
        options: Object.freeze(options),
        recommended,
        recommendationBasis: basis,
        // Layer C is decided elsewhere, and only with evidence.
        musicalMeaning: keepClaim ? 'SOURCE_SUPPORTED_CLAIM' : 'UNDETERMINED',
        status,
      }));
    }
  }

  // Presentation windows: per role, consecutive targets close in time. A window is
  // a reading aid for a reviewer, never a decision scope by itself.
  const gap = f(windowGapBeats);
  const windows = [];
  for (const role of [...new Set(targets.map(target => target.role))].sort(cmpStr)) {
    let current = null;
    for (const target of targets.filter(item => item.role === role).sort((a, b) => f(a.source.onset).cmp(b.source.onset))) {
      if (current && f(target.source.onset).sub(current.end).cmp(gap) <= 0) {
        current.eventIds.push(target.eventId);
        current.end = f(target.source.release).cmp(current.end) > 0 ? f(target.source.release) : current.end;
        current.recommended[target.recommended ?? 'none'] = (current.recommended[target.recommended ?? 'none'] ?? 0) + 1;
        current.statuses[target.status] = (current.statuses[target.status] ?? 0) + 1;
        continue;
      }
      if (current) windows.push(current);
      current = { role, start: f(target.source.onset), end: f(target.source.release), eventIds: [target.eventId], recommended: { [target.recommended ?? 'none']: 1 }, statuses: { [target.status]: 1 } };
    }
    if (current) windows.push(current);
  }
  const frozenWindows = windows.map((window, index) => Object.freeze({
    windowId: `release-window:${window.role}:${index}`,
    role: window.role,
    start: window.start.toString(),
    end: window.end.toString(),
    count: window.eventIds.length,
    eventIds: Object.freeze(window.eventIds),
    recommended: Object.freeze(window.recommended),
    statuses: Object.freeze(window.statuses),
  }));

  // Observation only: how each source's non-representable releases sit relative
  // to the grid. Reported so a reviewer can see an encoding pattern; never
  // admissible evidence of meaning.
  const patterns = new Map();
  for (const target of targets) {
    for (const sourceId of target.sourceIds) {
      if (!patterns.has(sourceId)) patterns.set(sourceId, new Map());
      const key = releaseOffsetKeyOf(target);
      patterns.get(sourceId).set(key, (patterns.get(sourceId).get(key) ?? 0) + 1);
    }
  }
  const encodingObservations = [...patterns.entries()].sort(([a], [b]) => cmpStr(a, b)).map(([sourceId, offsets]) => Object.freeze({
    sourceId,
    offsetsBeforeNextGrid: Object.freeze(Object.fromEntries([...offsets.entries()].sort(([a], [b]) => cmpStr(a, b)))),
    uniform: offsets.size === 1,
    evidenceClass: 'SOURCE_ENCODING_PATTERN',
    admissibleAsEvidence: false,
    notice: NON_ADMISSIBLE_EVIDENCE_CLASSES['source-encoding-pattern'],
  }));

  const count = status => targets.filter(target => target.status === status).length;
  const hidden = targets.filter(isNotVisibleToIntervalAnalyzer);
  return Object.freeze({
    schema: RELEASE_TIMING_SCHEMA,
    safeGrid: SAFE_GRID.toString(),
    finalLengthLcm: FINAL_LENGTH_LCM.toString(),
    releaseCount,
    positionClassCounts: Object.freeze(classCounts),
    targetCount: targets.length,
    decisionRequiredCount: count(TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED),
    sourceSupportedNotRepresentableCount: count(TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE),
    noValidRepresentationCount: count(TARGET_STATUS.NO_VALID_REPRESENTATION),
    representedCount: represented.length,
    unsupportedBoundaryCount: unsupportedBoundaries.length,
    notVisibleToIntervalAnalyzerCount: hidden.length,
    targets: Object.freeze(targets),
    represented: Object.freeze(represented),
    unsupportedBoundaries: Object.freeze(unsupportedBoundaries),
    windows: Object.freeze(frozenWindows),
    encodingObservations: Object.freeze(encodingObservations),
    notice: 'Analysis only. Source releases are reported exactly as the Source-Faithful Baseline holds them; representation options and the recommendation are arithmetic, not a musical verdict. A release moves only through a reviewer-accepted decision with admissible evidence, and every move stays reversible and visible in the baseline diff.',
  });
}

/**
 * How far a target release sits before its next safe-grid point, as the one
 * key `encodingObservations` counts by: whole source ticks when the event
 * carries its ticks-per-quarter and the offset is a whole number of them, the
 * exact beat offset otherwise. Anything that groups releases by offset reads
 * this, so an observation and a check on it can never disagree about what
 * "the same offset" means.
 */
export function releaseOffsetKeyOf(target) {
  return target.analysis.offsetBeforeNextGridTicks !== null
    ? `${target.analysis.offsetBeforeNextGridTicks} tick(s)`
    : `${target.analysis.offsetBeforeNextGrid} beat(s)`;
}

/** Compact counts for gates and run receipts; the full analysis stays in the plan. */
export function summarizeReleaseTiming(analysis) {
  const byRole = {};
  for (const target of analysis.targets) {
    byRole[target.role] ??= { targets: 0, recommendedExtend: 0, recommendedTruncate: 0, noRecommendation: 0 };
    byRole[target.role].targets += 1;
    if (target.recommended === REPRESENTATION.EXTEND_TO_NEXT_GRID) byRole[target.role].recommendedExtend += 1;
    else if (target.recommended === REPRESENTATION.TRUNCATE_TO_PREVIOUS_GRID) byRole[target.role].recommendedTruncate += 1;
    else byRole[target.role].noRecommendation += 1;
  }
  const shapes = {};
  for (const target of analysis.targets) shapes[target.analysis.followingShape] = (shapes[target.analysis.followingShape] ?? 0) + 1;
  return Object.freeze({
    schema: `${RELEASE_TIMING_SCHEMA}#summary`,
    releaseCount: analysis.releaseCount,
    targetCount: analysis.targetCount,
    decisionRequiredCount: analysis.decisionRequiredCount,
    sourceSupportedNotRepresentableCount: analysis.sourceSupportedNotRepresentableCount,
    noValidRepresentationCount: analysis.noValidRepresentationCount,
    representedCount: analysis.representedCount,
    unsupportedBoundaryCount: analysis.unsupportedBoundaryCount,
    notVisibleToIntervalAnalyzerCount: analysis.notVisibleToIntervalAnalyzerCount,
    samePitchRepeatedAttackTargets: analysis.targets.filter(target => target.analysis.nextIsSamePitchRepeatedAttack).length,
    followingShapes: Object.freeze(shapes),
    byRole: Object.freeze(byRole),
    windowCount: analysis.windows.length,
    encodingObservations: analysis.encodingObservations,
  });
}

// ─── evidence admissibility ─────────────────────────────────────────────────

const PRIMARY_SYMBOLIC_KINDS = new Set(['official-midi', 'official-musicxml']);
const PRIMARY_AUDIO_KINDS = new Set(['original-audio']);
const normalizeKind = kind => (typeof kind === 'string' ? kind.trim().toLowerCase().replaceAll('_', '-') : null);

/**
 * The project's evidence registry: uploaded assets and Canonical sources, each
 * with the kind it was declared as and its bytes' SHA-256.
 *
 * Evidence must resolve to bytes the project really holds. An uploaded asset
 * holds its own bytes. A Canonical source only names bytes: it holds them when
 * its SHA-256 equals an uploaded asset's of a compatible kind (a score through
 * an official score/MIDI asset, the recording through an original-audio
 * asset), so a source an imported IR merely declares (no digest, a digest
 * nothing uploaded matches, or audio bytes declared as a score) is never
 * evidence. A primary entry whose bytes are identical to any non-primary file
 * is a relabelled copy, not an independent source (a third-party MIDI uploaded
 * again as `official_midi`, a Final MML or report uploaded as audio), and an
 * entry whose bytes are unknown cannot be shown independent either. A source id
 * that is also an asset id is ambiguous and resolves to nothing.
 */
export function buildEvidenceRegistry({ assets = [], sources = [] } = {}) {
  const entries = [];
  const digest = value => (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null);
  const isPrimaryKind = kind => PRIMARY_SYMBOLIC_KINDS.has(kind) || PRIMARY_AUDIO_KINDS.has(kind);
  for (const asset of assets) {
    if (!text(asset?.asset_id)) continue;
    const sha256 = digest(asset.sha256);
    entries.push({ ref: asset.asset_id, origin: 'asset', kind: normalizeKind(asset.kind), sha256, bytesHeld: sha256 !== null });
  }
  const assetEntries = [...entries];
  const assetRefs = new Set(assetEntries.map(entry => entry.ref));
  // A source holds bytes only through an uploaded asset with the same digest
  // and a compatible kind: a score through an official score/MIDI asset, the
  // recording through an original-audio asset. Audio bytes are never a score.
  const backedBy = (sha256, kind) => sha256 !== null && assetEntries.some(asset => asset.sha256 === sha256
    && (PRIMARY_SYMBOLIC_KINDS.has(kind) ? PRIMARY_SYMBOLIC_KINDS.has(asset.kind)
      : PRIMARY_AUDIO_KINDS.has(kind) ? PRIMARY_AUDIO_KINDS.has(asset.kind) : true));
  for (const source of sources) {
    if (!text(source?.id)) continue;
    // A source id that is also an asset id is ambiguous: neither is guessed.
    if (assetRefs.has(source.id)) {
      const index = entries.findIndex(entry => entry.ref === source.id);
      entries[index] = { ref: source.id, origin: 'ambiguous', kind: 'ambiguous-reference', sha256: null, bytesHeld: false };
      continue;
    }
    const authority = typeof source.authority === 'string' ? source.authority : null;
    // A Canonical source is primary only when kind and authority agree; an
    // imported authority string cannot promote a supporting record.
    let kind = normalizeKind(source.kind);
    if ((PRIMARY_SYMBOLIC_KINDS.has(kind) && authority !== 'primary-symbolic') || (PRIMARY_AUDIO_KINDS.has(kind) && authority !== 'primary-audio')) kind = 'derived';
    const sha256 = digest(source.sha256);
    entries.push({ ref: source.id, origin: 'source', kind, sha256, bytesHeld: backedBy(sha256, kind) });
  }
  // Bytes any non-primary file also has cannot be independent primary evidence:
  // a relabelled third-party file, a Final MML or report uploaded as audio, ...
  const nonPrimaryShas = new Set(entries.filter(entry => !isPrimaryKind(entry.kind) && entry.sha256).map(entry => entry.sha256));
  const byRef = new Map();
  for (const entry of entries) {
    const primary = isPrimaryKind(entry.kind);
    const independent = primary ? entry.sha256 !== null && !nonPrimaryShas.has(entry.sha256) : true;
    const resolved = { ...entry, primary, independent };
    byRef.set(entry.ref, Object.freeze({ ...resolved, sourceClass: evidenceSourceClassOf(resolved) }));
  }
  return Object.freeze({
    entries: Object.freeze([...byRef.values()].sort((a, b) => cmpStr(a.ref, b.ref))),
    get: ref => (typeof ref === 'string' ? byRef.get(ref) ?? null : null),
  });
}

/**
 * What SOURCE_POLICY §1 class a resolved registry entry belongs to, for any
 * evidence path that cites a project source by reference (release
 * representation here, Lead evidence reviews in the application layer):
 *
 *   'primary-symbolic'  an official score/MIDI whose bytes the project holds and
 *                       that is not a copy of a supporting file (§1A);
 *   'primary-audio'     the original recording, held and independent (§1B);
 *   'not-independent'   a primary label on bytes a supporting file also has;
 *   'bytes-not-held'    declared, but no bytes the project holds back it;
 *   'supporting'        anything else: third-party, derived, current/historical
 *                       MML (§1C, §1D2).
 *
 * Returns null for an unknown reference. Who cited it plays no part.
 */
export function evidenceSourceClassOf(entry) {
  if (!entry) return null;
  if (entry.bytesHeld !== true) return 'bytes-not-held';
  const symbolic = PRIMARY_SYMBOLIC_KINDS.has(entry.kind);
  const audio = PRIMARY_AUDIO_KINDS.has(entry.kind);
  if (!symbolic && !audio) return 'supporting';
  if (entry.independent !== true) return 'not-independent';
  return symbolic ? 'primary-symbolic' : 'primary-audio';
}

// Who submitted the decision. `attestation` keeps its name from the first
// version of this schema; it is provenance, not authority. The legacy
// `audio_basis` is read only as the default basis of a primary-audio item that
// states none: `listening` is a direct review of the recording, whoever or
// whatever did it, and `machine-metric` stays a metric.
const LEGACY_AUDIO_BASIS = Object.freeze({ listening: EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW, 'machine-metric': EVIDENCE_BASIS.MACHINE_METRIC });
// Caller strings index these tables; only own keys count, never the prototype.
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);
function normalizeProvenance(value) {
  if (!plainObject(value)) return null;
  return Object.freeze({
    reviewer: text(value.reviewer) ? value.reviewer.trim().slice(0, 200) : null,
    reviewer_kind: DECISION_AUTHOR_KINDS.includes(value.reviewer_kind) ? value.reviewer_kind : null,
  });
}

/** The claim a representation makes about its source event. */
export function releaseClaimOf(representation) {
  if (representation === REPRESENTATION.EXTEND_TO_NEXT_GRID) return RELEASE_CLAIM.SUSTAINS_TO_GRID;
  if (representation === REPRESENTATION.TRUNCATE_TO_PREVIOUS_GRID) return RELEASE_CLAIM.RELEASES_BY_GRID;
  return null;
}

/**
 * Grade one decision's evidence. Returns the resolved items (so a stored record
 * can be re-graded later without the registry) and whether any item is
 * admissible.
 *
 * An item is admissible when: it cites a primary source this project really
 * holds, under a matching kind, and independent of the supporting sources; its
 * finding was derived by a direct review of that source (not a metric, locator,
 * encoding pattern or imported assertion); SOURCE_POLICY lets that source class
 * support the claim the representation makes; and it carries a locator and a
 * finding. The decision must say who submitted it. Who that is — a person, a
 * conversational AI, a tool — is recorded and never read here.
 */
export function gradeReleaseEvidence(decision, registry) {
  const provenance = normalizeProvenance(decision?.attestation);
  const legacyAudioBasis = plainObject(decision?.attestation) ? own(LEGACY_AUDIO_BASIS, decision.attestation.audio_basis) : null;
  const claim = releaseClaimOf(decision?.representation);
  const authority = claim ? RELEASE_CLAIM_AUTHORITY[claim] : {};
  const decisionReasons = [];
  if (!provenance || !provenance.reviewer || !provenance.reviewer_kind) decisionReasons.push(EVIDENCE_REFUSAL.PROVENANCE_MISSING);
  const items = (Array.isArray(decision?.evidence) ? decision.evidence : []).map(raw => {
    const item = plainObject(raw) ? raw : {};
    const evidenceClass = typeof item.class === 'string' ? item.class.trim() : '';
    const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
    const statedBasis = typeof item.basis === 'string' ? item.basis.trim() : '';
    const basis = statedBasis || (evidenceClass === EVIDENCE_CLASS.PRIMARY_AUDIO ? legacyAudioBasis : null) || null;
    const reasons = [];
    const stored = plainObject(item.resolved) ? item.resolved : null;
    const resolved = registry ? registry.get(ref) : stored;
    if (!Object.values(EVIDENCE_CLASS).includes(evidenceClass)) reasons.push(EVIDENCE_REFUSAL.CLASS_NOT_ADMISSIBLE);
    else if (!resolved) reasons.push(EVIDENCE_REFUSAL.REF_UNKNOWN);
    else if (evidenceClass === EVIDENCE_CLASS.PRIMARY_SYMBOLIC && !PRIMARY_SYMBOLIC_KINDS.has(resolved.kind)) reasons.push(EVIDENCE_REFUSAL.KIND_MISMATCH);
    else if (evidenceClass === EVIDENCE_CLASS.PRIMARY_AUDIO && !PRIMARY_AUDIO_KINDS.has(resolved.kind)) reasons.push(EVIDENCE_REFUSAL.KIND_MISMATCH);
    // Checked as `=== true`: a stored resolution (re-graded without a registry)
    // that omits either fact has not shown it.
    else if (resolved.bytesHeld !== true) reasons.push(EVIDENCE_REFUSAL.REF_HOLDS_NO_BYTES);
    else if (resolved.independent !== true) reasons.push(EVIDENCE_REFUSAL.NOT_INDEPENDENT);
    if (Object.values(EVIDENCE_CLASS).includes(evidenceClass) && !own(authority, evidenceClass)) reasons.push(EVIDENCE_REFUSAL.CLAIM_NOT_SUPPORTED);
    if (!basis) reasons.push(EVIDENCE_REFUSAL.BASIS_MISSING);
    else if (basis !== EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW) reasons.push(EVIDENCE_REFUSAL.BASIS_NOT_SOURCE_REVIEW);
    if (!text(item.locator)) reasons.push(EVIDENCE_REFUSAL.LOCATOR_MISSING);
    if (!text(item.finding)) reasons.push(EVIDENCE_REFUSAL.FINDING_MISSING);
    return Object.freeze({
      class: evidenceClass,
      ref,
      basis: basis ? basis.slice(0, 64) : null,
      locator: text(item.locator) ? item.locator.trim().slice(0, 500) : null,
      finding: text(item.finding) ? item.finding.trim().slice(0, 2000) : null,
      resolved: resolved ? Object.freeze({ ref: resolved.ref, origin: resolved.origin, kind: resolved.kind, sha256: resolved.sha256, bytesHeld: resolved.bytesHeld, primary: resolved.primary, independent: resolved.independent }) : null,
      claimAuthority: own(authority, evidenceClass),
      nonAdmissibleClassNotice: own(NON_ADMISSIBLE_EVIDENCE_CLASSES, evidenceClass),
      nonAdmissibleBasisNotice: own(NON_ADMISSIBLE_EVIDENCE_BASES, basis),
      admissible: reasons.length === 0 && decisionReasons.length === 0,
      reasons: Object.freeze(reasons),
    });
  });
  const admissible = decisionReasons.length === 0 && items.some(item => item.admissible);
  const reasons = [...decisionReasons];
  if (!decisionReasons.length && !items.some(item => item.admissible)) reasons.push(EVIDENCE_REFUSAL.NO_ADMISSIBLE_ITEM);
  return Object.freeze({
    admissible,
    claim,
    // Provenance, recorded for the audit trail. Not part of the grade.
    attestation: provenance,
    items: Object.freeze(items),
    reasons: Object.freeze(reasons),
  });
}

/**
 * What evidence would settle a release that still needs a decision, from the
 * sources this project really holds. Any one listed item is enough, submitted
 * by anyone, as long as it cites the source with a direct-source-review basis, a
 * locator and a finding. Returns null without a registry: what the project holds
 * is then unknown, and nothing is guessed.
 */
export function releaseEvidenceRequirement(registry) {
  if (!registry) return null;
  const entries = registry.entries ?? [];
  const refsOf = (kinds, independent) => entries.filter(entry => kinds.has(entry.kind) && entry.bytesHeld === true && entry.independent === independent).map(entry => entry.ref);
  const symbolic = refsOf(PRIMARY_SYMBOLIC_KINDS, true);
  const audio = refsOf(PRIMARY_AUDIO_KINDS, true);
  return Object.freeze({
    anyOf: Object.freeze([
      Object.freeze(audio.length
        ? { code: RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_REVIEW_REQUIRED, class: EVIDENCE_CLASS.PRIMARY_AUDIO, availableRefs: Object.freeze(audio), notIndependentRefs: Object.freeze(refsOf(PRIMARY_AUDIO_KINDS, false)), needed: 'A direct review of the original recording at each listed release (locator in the recording) stating whether the note is held to the grid point or released before it. Alignment, envelope or onset metrics locate the place to look and do not answer it (SOURCE_POLICY §6).' }
        : { code: RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_SOURCE_REQUIRED, class: EVIDENCE_CLASS.PRIMARY_AUDIO, availableRefs: Object.freeze([]), notIndependentRefs: Object.freeze(refsOf(PRIMARY_AUDIO_KINDS, false)), needed: 'The project holds no independent original recording.' }),
      Object.freeze(symbolic.length
        ? { code: RELEASE_EVIDENCE_REQUIREMENT.SYMBOLIC_SOURCE_REVIEW_REQUIRED, class: EVIDENCE_CLASS.PRIMARY_SYMBOLIC, availableRefs: Object.freeze(symbolic), notIndependentRefs: Object.freeze(refsOf(PRIMARY_SYMBOLIC_KINDS, false)), needed: 'A direct reading of the independent official score/MIDI at each listed release stating its written duration.' }
        : { code: RELEASE_EVIDENCE_REQUIREMENT.SYMBOLIC_SOURCE_REQUIRED, class: EVIDENCE_CLASS.PRIMARY_SYMBOLIC, availableRefs: Object.freeze([]), notIndependentRefs: Object.freeze(refsOf(PRIMARY_SYMBOLIC_KINDS, false)), needed: 'The project holds no independent official score or MIDI; an asset labelled official whose bytes equal a supporting file is a relabelled copy.' }),
    ]),
    notice: 'Any one item settles the releases it names. Who submits it is recorded and does not change its grade; third-party files, encoding patterns, metrics, tool output and bare assertions are recorded and never counted.',
  });
}

// ─── decisions → planned release changes ────────────────────────────────────

const DECISION_KEYS = new Set(['id', 'eventIds', 'representation', 'reason', 'evidence', 'attestation']);

function normalizeDecision(raw, index) {
  if (!plainObject(raw)) throw Error(`releaseRepresentation.decisions[${index}] must be an object`);
  for (const key of Object.keys(raw)) if (!DECISION_KEYS.has(key)) throw Error(`releaseRepresentation.decisions[${index}].${key} is unsupported`);
  if (!text(raw.id) || raw.id.length > 200) throw Error(`releaseRepresentation.decisions[${index}].id is required`);
  if (!Array.isArray(raw.eventIds) || !raw.eventIds.length || raw.eventIds.some(id => !text(id))) throw Error(`releaseRepresentation.decisions[${index}].eventIds must name at least one event`);
  if (new Set(raw.eventIds.map(id => id.trim())).size !== raw.eventIds.length) throw Error(`releaseRepresentation.decisions[${index}].eventIds must not repeat an event`);
  if (!Object.values(REPRESENTATION).includes(raw.representation)) throw Error(`releaseRepresentation.decisions[${index}].representation must be one of ${Object.values(REPRESENTATION).join(', ')}`);
  if (!text(raw.reason) || raw.reason.length > 2000) throw Error(`releaseRepresentation.decisions[${index}].reason is required`);
  if (!Array.isArray(raw.evidence) || raw.evidence.length > 50) throw Error(`releaseRepresentation.decisions[${index}].evidence must be an array of at most 50 items`);
  return { id: raw.id.trim(), eventIds: raw.eventIds.map(id => id.trim()), representation: raw.representation, reason: raw.reason.trim(), evidence: raw.evidence, attestation: raw.attestation ?? null };
}

export function normalizeReleaseRepresentationInput(input) {
  if (input === null || input === undefined) return null;
  if (!plainObject(input)) throw Error('releaseRepresentation must be an object');
  for (const key of Object.keys(input)) if (key !== 'decisions') throw Error(`releaseRepresentation.${key} is unsupported`);
  if (!Array.isArray(input.decisions) || input.decisions.length > 500) throw Error('releaseRepresentation.decisions must be an array of at most 500 decisions');
  const decisions = input.decisions.map(normalizeDecision);
  if (new Set(decisions.map(decision => decision.id)).size !== decisions.length) throw Error('releaseRepresentation decision ids must be unique');
  return { decisions };
}

/**
 * Turn representation decisions into exact, per-event release changes.
 *
 * A decision whose evidence is not admissible is kept on the plan as PENDING and
 * changes nothing; its reasons are reported. A decision that names an event that
 * is not a representation target, or asks for an option that is invalid for it,
 * is a blocker: the caller's statement does not describe this candidate.
 */
export function planReleaseRepresentation({ analysis, input, registry }) {
  const normalized = normalizeReleaseRepresentationInput(input) ?? { decisions: [] };
  const targets = new Map(analysis.targets.map(target => [target.eventId, target]));
  const represented = new Set(analysis.represented.map(item => item.eventId));
  const named = new Map();
  for (const decision of normalized.decisions) for (const eventId of decision.eventIds) named.set(eventId, (named.get(eventId) ?? 0) + 1);
  const blockers = [];
  const pending = [];
  const changes = [];
  const decisions = [];
  for (const decision of normalized.decisions) {
    const grade = gradeReleaseEvidence(decision, registry);
    const decisionBlockers = [];
    for (const eventId of decision.eventIds) {
      if ((named.get(eventId) ?? 0) > 1) { decisionBlockers.push({ code: RELEASE_REFUSAL.DECISION_CONFLICT, eventId }); continue; }
      const target = targets.get(eventId);
      if (!target) { decisionBlockers.push({ code: RELEASE_REFUSAL.EVENT_NOT_A_TARGET, eventId, detail: represented.has(eventId) ? 'already represented by a recorded decision' : 'release is Final-representable, or the event is not an assigned-role note of this candidate' }); continue; }
      if (target.status === TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE) { decisionBlockers.push({ code: RELEASE_REFUSAL.KEEP_DECISION_PRESENT, eventId }); continue; }
      const option = target.options.find(item => item.representation === decision.representation);
      if (!option?.valid) { decisionBlockers.push({ code: RELEASE_REFUSAL.REPRESENTATION_INVALID, eventId, reasons: option?.reasons ?? ['no-option'] }); continue; }
    }
    const record = Object.freeze({
      schema: RELEASE_REPRESENTATION_DECISION_SCHEMA,
      id: decision.id,
      eventIds: Object.freeze([...decision.eventIds].sort(cmpStr)),
      representation: decision.representation,
      reason: decision.reason,
      claim: grade.claim,
      attestation: grade.attestation,
      evidence: grade.items,
      admissible: grade.admissible,
      evidenceReasons: grade.reasons,
      classification: grade.admissible ? 'NO_SOURCE_SUPPORTED_MEANING_ESTABLISHED_BY_EVIDENCE' : 'UNDETERMINED',
    });
    decisions.push(record);
    if (decisionBlockers.length) { blockers.push(...decisionBlockers.map(item => ({ ...item, decisionId: decision.id }))); continue; }
    if (!grade.admissible) { pending.push(Object.freeze({ decisionId: decision.id, eventIds: record.eventIds, reasons: grade.reasons, items: grade.items.map(item => ({ class: item.class, ref: item.ref, reasons: item.reasons })) })); continue; }
    for (const eventId of decision.eventIds) {
      const target = targets.get(eventId);
      const option = target.options.find(item => item.representation === decision.representation);
      changes.push(Object.freeze({
        eventId,
        role: target.role,
        pitch: target.pitch,
        start: target.source.onset,
        before: Object.freeze({ end: target.source.release }),
        after: Object.freeze({ end: option.finalRelease }),
        delta: option.delta,
        deltaTicks: option.deltaTicks,
        representation: decision.representation,
        recommended: target.recommended,
        selectedRecommended: target.recommended === decision.representation,
        effect: option.effect,
        introducesArticulation: option.introducesArticulation,
        decisionId: decision.id,
      }));
    }
  }
  changes.sort((a, b) => cmpStr(a.eventId, b.eventId));
  const changedIds = new Set(changes.map(change => change.eventId));
  const unresolved = analysis.targets.filter(target => !changedIds.has(target.eventId)).map(target => target.eventId);
  const openDecisionRequired = analysis.targets.filter(target => target.status === TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED && !changedIds.has(target.eventId)).length;
  return Object.freeze({
    decisions: Object.freeze(decisions.sort((a, b) => cmpStr(a.id, b.id))),
    changes: Object.freeze(changes),
    pending: Object.freeze(pending),
    blockers: Object.freeze(blockers),
    unresolvedTargetCount: unresolved.length,
    // Of those, the releases a representation decision could still settle.
    openDecisionRequiredCount: openDecisionRequired,
    unresolvedTargetEventIds: Object.freeze(unresolved),
  });
}

export function releaseRecordFor(change) {
  return Object.freeze({
    schema: RELEASE_REPRESENTATION_RECORD_SCHEMA,
    decisionId: change.decisionId,
    representation: change.representation,
    source: Object.freeze({ end: change.before.end }),
    final: Object.freeze({ end: change.after.end }),
    delta: change.delta,
    deltaTicks: change.deltaTicks,
    effect: change.effect,
    reversal: Object.freeze({ field: 'end', restore: change.before.end }),
    notice: 'Mobile Final representation of a release that no admitted Final token sequence can express. source.end is the Source-Faithful release and stays the source truth; final.end is an evidence-backed adaptation, not a source correction.',
  });
}

// ─── verification of recorded representations ───────────────────────────────

// Fields a represented event may legitimately differ from its origin in: the
// release itself and its record, the role and volume other stages decide, an
// octave-only pitch change (enforced by the adaptation invariant), tags, and the
// id of a derived duplicate (resolved above through its reversible chain).
const RELEASE_ONLY_KEYS = ['end', 'metadata', 'role', 'volume', 'pitch', 'tags', 'id'];
function sameExceptRelease(event, origin) {
  for (const key of new Set([...Object.keys(event), ...Object.keys(origin)])) {
    if (RELEASE_ONLY_KEYS.includes(key)) continue;
    if (JSON.stringify(event[key]) !== JSON.stringify(origin[key])) return false;
  }
  return true;
}

/**
 * Re-establish that every recorded release representation is what it claims:
 * the source release equals the baseline origin, the Final release equals the
 * event, the move is a single sub-grid step onto the safe grid from a release
 * Final could not express, no open keep claim covers the release, and the
 * decision it names is stored, names the event (or its origin), and still grades
 * admissible. Given the project's current evidence registry, every citation is
 * resolved again against it; without one, the resolution stored with the
 * decision is re-graded. Nothing recorded is taken as a verdict.
 */
export function verifyReleaseRepresentation(project, { registry = null } = {}) {
  const events = (project?.events ?? []).filter(event => event?.kind === 'note' && recordOf(event));
  const decisionList = project?.metadata?.mobileAdaptation?.releaseRepresentation?.decisions;
  const decisions = new Map((Array.isArray(decisionList) ? decisionList : []).filter(item => text(item?.id)).map(item => [item.id, item]));
  if (!events.length) return Object.freeze({ recordCount: 0, violations: Object.freeze([]), registryChecked: Boolean(registry) });
  const snapshot = project?.metadata?.sourceFaithfulBaseline?.snapshot;
  const violations = [];
  if (!snapshot || !Array.isArray(snapshot.events)) {
    return Object.freeze({ recordCount: events.length, violations: Object.freeze(events.map(event => Object.freeze({ eventId: event.id, code: RECORD_VIOLATION.BASELINE_SNAPSHOT_MISSING }))), registryChecked: Boolean(registry) });
  }
  const resolveOrigin = originResolver(snapshot.events, project.events);
  const keepClaims = releaseKeepClaims(project);
  const graded = new Map();
  for (const event of events) {
    const record = recordOf(event);
    const push = code => violations.push(Object.freeze({ eventId: event.id, code }));
    // The baseline event itself, or the one a justified derived duplicate's
    // reversible chain leads to.
    const origin = resolveOrigin(event.id);
    if (!origin) { push(RECORD_VIOLATION.ORIGIN_MISSING); continue; }
    let sourceEnd; let finalEnd;
    try { sourceEnd = f(record.source?.end); finalEnd = f(record.final?.end); } catch { push(RECORD_VIOLATION.SOURCE_RELEASE_MISMATCH); continue; }
    if (f(origin.end).cmp(sourceEnd) !== 0) push(RECORD_VIOLATION.SOURCE_RELEASE_MISMATCH);
    if (f(event.end).cmp(finalEnd) !== 0) push(RECORD_VIOLATION.FINAL_RELEASE_MISMATCH);
    if (!sameExceptRelease(event, origin) || f(event.start).cmp(origin.start) !== 0) push(RECORD_VIOLATION.OTHER_FIELD_CHANGED);
    const delta = finalEnd.sub(sourceEnd);
    if (delta.cmp(0) === 0 || absolute(delta).cmp(SAFE_GRID) >= 0) push(RECORD_VIOLATION.DELTA_OUT_OF_RANGE);
    if (classifyPosition(finalEnd) !== POSITION_CLASS.SAFE_GRID) push(RECORD_VIOLATION.FINAL_OFF_GRID);
    if (classifyPosition(sourceEnd) !== POSITION_CLASS.NOT_FINAL_REPRESENTABLE) push(RECORD_VIOLATION.SOURCE_REPRESENTABLE);
    if (keepClaims.has(event.id) || keepClaims.has(origin.id)) push(RECORD_VIOLATION.KEEP_CLAIM_PRESENT);
    const decision = decisions.get(record.decisionId);
    if (!decision) { push(RECORD_VIOLATION.DECISION_MISSING); continue; }
    // A duplicate derived after the representation carries its origin's record,
    // and the decision names the origin.
    const named = decision.eventIds ?? [];
    if (!named.includes(event.id) && !named.includes(origin.id)) push(RECORD_VIOLATION.DECISION_DOES_NOT_NAME_EVENT);
    if (decision.representation !== record.representation) push(RECORD_VIOLATION.REPRESENTATION_MISMATCH);
    // With the project's current evidence registry, every citation is resolved
    // again (kind, independence, presence); without one, the resolution stored
    // with the decision is re-graded.
    if (!graded.has(decision.id)) graded.set(decision.id, gradeReleaseEvidence(decision, registry));
    if (!graded.get(decision.id).admissible) push(RECORD_VIOLATION.DECISION_NOT_ADMISSIBLE);
  }
  return Object.freeze({ recordCount: events.length, violations: Object.freeze(violations), registryChecked: Boolean(registry) });
}

/**
 * The release the Lead / Core3 *context* is read at. An EXTEND representation
 * only closes a sub-grid gap or shortens a rest of at least the safe grid by less
 * than the grid: it creates no silence and removes no rest, so the Lead
 * continuity picture a reviewer's claim was made about is unchanged at Final
 * resolution, and the recorded source release is read instead. A TRUNCATE
 * representation inserts silence and is read as the change it is. The record's
 * agreement with the baseline is re-verified separately by the micro-timing gate
 * (`verifyReleaseRepresentation`); this only requires it to be self-consistent.
 */
export function contextReleaseOf(event) {
  const record = recordOf(event);
  if (!record || record.representation !== REPRESENTATION.EXTEND_TO_NEXT_GRID) return event?.end;
  try {
    if (f(event.end).cmp(record.final?.end) !== 0) return event.end;
    const delta = f(record.final.end).sub(record.source.end);
    if (delta.cmp(0) <= 0 || delta.cmp(SAFE_GRID) >= 0) return event.end;
    if (classifyPosition(record.source.end) !== POSITION_CLASS.NOT_FINAL_REPRESENTABLE) return event.end;
    return String(record.source.end);
  } catch {
    return event.end;
  }
}

/**
 * The event as the source states it: a verified release representation is
 * reversed, and nothing else is. Used where evidence is bound to a source event's
 * musical identity (Lead evidence), so that a recorded Mobile representation of
 * the release does not read as a different source event, while any other change
 * still does.
 */
export function sourceIdentityOf(event, origin = null) {
  const record = recordOf(event);
  if (!record) return event;
  try {
    if (f(event.end).cmp(record.final?.end) !== 0) return event;
    if (origin && f(origin.end).cmp(record.source?.end) !== 0) return event;
    const delta = f(record.final.end).sub(record.source.end);
    if (delta.cmp(0) === 0 || absolute(delta).cmp(SAFE_GRID) >= 0) return event;
    if (classifyPosition(record.source.end) !== POSITION_CLASS.NOT_FINAL_REPRESENTABLE) return event;
    return { ...event, end: String(record.source.end) };
  } catch {
    return event;
  }
}
