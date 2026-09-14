// G11-C traceable six-role candidate suggestion.
//
// Input:  the G11-A Source-Faithful Canonical baseline + the G11-B lossless
//         monophonic lane decomposition of it.
// Output: a six-role *candidate* arrangement in which every source event is
//         still identifiable, every role decision is an explicit ledger entry,
//         and Core3 completeness is argued separately from Full6 enrichment.
//
// This module implements Published Canonical; it does not define it. The rule
// authority is `docs/CANONICAL_MANIFEST.md` and the four human-readable rule
// sources pinned at its `rules_snapshot_sha`. Every heuristic here produces
// *evidence*, never Canonical truth: when the evidence does not decide, the
// role decision is `PENDING` rather than a guess (MASTER_RULES.md §0, §4).
//
// Hard boundaries carried over from the rule sources:
//   * §3  the Source-Faithful Baseline is immutable. Nothing here changes a
//         pitch, onset, duration, prominence or octave, and nothing is deleted.
//   * §4  Melody is the Lead role, not Vocal-only. `highest note -> Melody` and
//         `not proven Vocal -> demote` are forbidden inferences.
//   * §5  Chord2 is the bass skeleton *plus* any essential inner voice needed
//         for one-player completeness. It is never hardened into Bass-only.
//   * §6  same-pitch overlap and dense simultaneous attacks are review signals,
//         never automatic deletion targets.
//   * six-role capacity is a capacity fact, not permission to delete: material
//         that does not fit is retained in `unassigned` with its reason.
//
// Determinism contract: every ordering and every decision is made on exact
// rationals, integers, or string ids. No decision reads Map/Set enumeration
// order, and no beat is ever projected to a float.

import { f, ROLES } from '../mml/index.mjs';
import { splitProjectSourceVoices } from './voice-split.mjs';

// ─── exact-rational helpers ─────────────────────────────────────────────────

const ZERO = f(0);
const cmpB = (a, b) => f(a).cmp(b);
const key = value => f(value).toString();
const sub = (a, b) => f(a).sub(b);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const maxB = (a, b) => (cmpB(a, b) >= 0 ? f(a) : f(b));
const minB = (a, b) => (cmpB(a, b) <= 0 ? f(a) : f(b));

// Ratio comparison without constructing the quotient: `a/b >= t` for exact
// rationals a, b (b > 0) and a rational threshold t.
const ratioAtLeast = (a, b, threshold) => (f(b).cmp(ZERO) <= 0 ? false : f(a).cmp(f(b).mul(threshold)) >= 0);
const ratioBelow = (a, b, threshold) => (f(b).cmp(ZERO) <= 0 ? true : f(a).cmp(f(b).mul(threshold)) < 0);

// Exact duration-weighted pitch. `averagePitch` from G11-B is a presentation
// float and is deliberately not read here (G11-B note, MASTER_RULES.md §2).
function weightedPitch(spans, fallback = 0) {
  let sum = ZERO;
  let weight = ZERO;
  for (const span of spans) {
    const duration = sub(span.end, span.start);
    sum = sum.add(duration.mul(span.pitch));
    weight = weight.add(duration);
  }
  return weight.cmp(ZERO) > 0 ? sum.div(weight) : f(fallback);
}

// ─── vocabulary ─────────────────────────────────────────────────────────────

export const SIX_ROLES = Object.freeze([...ROLES]);
export const CORE3_ROLE_NAMES = Object.freeze(['Melody', 'Chord1', 'Chord2']);
export const ENRICHMENT_ROLE_NAMES = Object.freeze(['Chord3', 'Chord4', 'Chord5']);

// MASTER_RULES.md §3 requires every meaningful change to be representable as an
// explicit decision. These are those decisions; none of them is a deletion.
export const ROLE_DECISIONS = Object.freeze({
  KEEP_ROLE: 'KEEP_ROLE',
  ASSIGN_ROLE: 'ASSIGN_ROLE',
  MOVE_ROLE: 'MOVE_ROLE',
  OMIT_FROM_SIX: 'OMIT_FROM_SIX',
  DUPLICATE_WITH_JUSTIFICATION: 'DUPLICATE_WITH_JUSTIFICATION',
  PENDING: 'PENDING',
});

// Implementer heuristics. None of these numbers is Canonical, none of them is
// an official game limit, and every evidence record carries the threshold it
// was measured against so a reviewer can disagree with the number without
// having to reverse-engineer the verdict.
export const ROLE_CANDIDATE_THRESHOLDS = Object.freeze({
  notice: 'Implementer heuristics only. Not Canonical rules, not OFFICIAL_GAME_LIMIT values. Each is recorded beside the measurement it judged.',
  leadMinDistinctPitches: 3,
  leadMinPitchChangeRatio: '1/2',
  leadMaxSharedOnsetRatio: '1/2',
  bassFloorMinRatio: '1/2',
  enrichmentDuplicationReviewRatio: '1/2',
  counterLineMinIndependentAttackRatio: '1/2',
  rhythmicDetailDensityFactor: '2',
  denseSimultaneousAttackRoles: 5,
  closeIntervalMaxLowPitch: 60,
  closeIntervalSemitones: Object.freeze([1, 11, 13]),
  sustainedTextureMinMeanSpan: '1',
});

// General MIDI program families. Instrument evidence is `supporting` only:
// SOURCE_POLICY.md §A forbids treating a symbolic instrument label as proof of
// final arrangement role.
const GM_FAMILIES = Object.freeze([
  [0, 7, 'piano'], [8, 15, 'chromatic-percussion'], [16, 23, 'organ'],
  [24, 31, 'guitar'], [32, 39, 'bass'], [40, 47, 'strings'],
  [48, 55, 'ensemble'], [56, 63, 'brass'], [64, 71, 'reed'],
  [72, 79, 'pipe'], [80, 87, 'synth-lead'], [88, 95, 'synth-pad'],
  [96, 103, 'synth-effects'], [104, 111, 'ethnic'], [112, 119, 'percussive'],
  [120, 127, 'sound-effects'],
]);

const gmFamily = program => {
  if (!Number.isInteger(program) || program < 0 || program > 127) return null;
  return GM_FAMILIES.find(([low, high]) => program >= low && program <= high)?.[2] ?? null;
};

// ─── input normalization ────────────────────────────────────────────────────

const isNote = event => event?.kind === 'note';

// G11-A records percussion as `unsupported` evidence and never emits it as a
// Canonical note (MASTER_RULES.md §8). A different adapter, or a caller who
// re-assembled a project by hand, could still hand us a percussion-tagged
// note. It must not become a pitched role by accident, so it is separated out
// here, before decomposition, and reported as unsupported/pending instead.
const PERCUSSION_CHANNEL = 9;
const UNSUPPORTED_TAGS = Object.freeze(['percussion', 'drum', 'unsupported']);

function isUnsupportedSourceNote(event) {
  if (event.metadata?.channel === PERCUSSION_CHANNEL) return 'PERCUSSION_CHANNEL_EVENT';
  const tags = event.tags ?? [];
  const tag = UNSUPPORTED_TAGS.find(candidate => tags.includes(candidate));
  return tag ? `UNSUPPORTED_SOURCE_TAG:${tag}` : null;
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object') throw Error('suggestRoleCandidates requires a Canonical project');
  if (!Array.isArray(project.events)) throw Error('project.events must be an array');
  const notes = [];
  const unsupported = [];
  const seen = new Set();
  for (const [index, event] of project.events.entries()) {
    if (!isNote(event)) continue;
    if (typeof event.id !== 'string' || !event.id) throw Error(`project.events[${index}].id must be a non-empty string`);
    if (seen.has(event.id)) throw Error(`duplicate source event id: ${event.id}`);
    seen.add(event.id);
    const reason = isUnsupportedSourceNote(event);
    if (reason) {
      unsupported.push(Object.freeze({
        eventId: event.id,
        reason,
        pitch: event.pitch,
        start: key(event.start),
        end: key(event.end),
        sourceIds: Object.freeze([...(event.sourceIds ?? [])]),
        sourceEventIds: Object.freeze([...(event.sourceEventIds ?? [])]),
        sourceVoice: event.voice ?? null,
        sourceRole: event.role ?? null,
        status: 'PENDING',
        notice: 'Retained as unsupported source evidence. MASTER_RULES.md §8 requires evidence-backed drum-face mapping before this material may become a pitched role.',
      }));
      continue;
    }
    notes.push(event);
  }
  notes.sort((a, b) => cmpB(a.start, b.start) || b.pitch - a.pitch || cmpStr(a.id, b.id));
  unsupported.sort((a, b) => cmpStr(a.eventId, b.eventId));
  return { notes, unsupported };
}

function normalizeRoleOverrides(overrides, laneIds) {
  if (overrides === undefined) return new Map();
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw Error('options.roleOverrides must be an object mapping laneId -> role or null');
  const pinned = new Map();
  for (const laneId of Object.keys(overrides).sort(cmpStr)) {
    if (!laneIds.has(laneId)) throw Error(`roleOverrides references an unknown candidate lane: ${laneId}`);
    const role = overrides[laneId];
    if (role !== null && !SIX_ROLES.includes(role)) throw Error(`roleOverrides.${laneId} must be null or one of: ${SIX_ROLES.join(', ')}`);
    pinned.set(laneId, role);
  }
  return pinned;
}

// A candidate duplication is the one way a source event may appear under more
// than one role. It is never inferred: the caller must say which roles, why,
// and on what evidence, and the ledger then marks every copy explicitly
// (MASTER_RULES.md §3, and the coverage obligation in ACCEPTANCE_CRITERIA.md
// Gate 2 that "appears somewhere in output" is not sufficient provenance).
function normalizeDuplications(duplications, laneIds) {
  if (duplications === undefined) return [];
  if (!Array.isArray(duplications)) throw Error('options.duplications must be an array');
  return duplications.map((item, index) => {
    if (!item || typeof item !== 'object') throw Error(`options.duplications[${index}] must be an object`);
    if (!laneIds.has(item.laneId)) throw Error(`options.duplications[${index}] references an unknown candidate lane: ${item.laneId}`);
    if (!Array.isArray(item.roles) || item.roles.length < 2) throw Error(`options.duplications[${index}].roles must list at least two roles`);
    for (const role of item.roles) if (!SIX_ROLES.includes(role)) throw Error(`options.duplications[${index}].roles contains an unknown role: ${role}`);
    if (new Set(item.roles).size !== item.roles.length) throw Error(`options.duplications[${index}].roles must not repeat a role`);
    if (typeof item.reason !== 'string' || !item.reason.trim()) throw Error(`options.duplications[${index}] requires a positive reason`);
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.some(entry => typeof entry !== 'string' || !entry.trim()))
      throw Error(`options.duplications[${index}] requires explicit evidence references`);
    return Object.freeze({
      laneId: item.laneId,
      roles: Object.freeze([...item.roles].sort((a, b) => SIX_ROLES.indexOf(a) - SIX_ROLES.indexOf(b))),
      reason: item.reason.trim(),
      evidence: Object.freeze([...item.evidence].map(entry => entry.trim()).sort(cmpStr)),
    });
  }).sort((a, b) => cmpStr(a.laneId, b.laneId));
}

// Trusted symbolic role evidence supplied by the caller (an official score
// adapter, a reviewed hand annotation). SOURCE_POLICY.md §A/§2 requires a
// citation before a classification may count, and audio evidence is a separate
// evidence class that this layer does not accept at all.
function normalizeRoleEvidence(entries) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw Error('options.sourceRoleEvidence must be an array');
  return entries.map((item, index) => {
    if (!item || typeof item !== 'object') throw Error(`options.sourceRoleEvidence[${index}] must be an object`);
    if (item.evidenceClass !== undefined && item.evidenceClass !== 'symbolic')
      throw Error(`options.sourceRoleEvidence[${index}].evidenceClass must be "symbolic"; audio evidence is a separate class and is not accepted by G11-C`);
    if (!SIX_ROLES.includes(item.role)) throw Error(`options.sourceRoleEvidence[${index}].role must be one of: ${SIX_ROLES.join(', ')}`);
    if (typeof item.citation !== 'string' || !item.citation.trim()) throw Error(`options.sourceRoleEvidence[${index}] requires a citation`);
    const hasTarget = typeof item.sourceVoice === 'string' || typeof item.laneId === 'string' || Array.isArray(item.eventIds);
    if (!hasTarget) throw Error(`options.sourceRoleEvidence[${index}] must target a sourceVoice, laneId, or eventIds`);
    return Object.freeze({
      sourceVoice: item.sourceVoice ?? null,
      laneId: item.laneId ?? null,
      eventIds: Object.freeze(Array.isArray(item.eventIds) ? [...item.eventIds].sort(cmpStr) : []),
      role: item.role,
      citation: item.citation.trim(),
      evidenceClass: 'symbolic',
    });
  }).sort((a, b) => cmpStr(a.citation, b.citation) || cmpStr(a.role, b.role));
}

// Optional section/form evidence. Recorded as supporting context only: it never
// assigns and never demotes.
function normalizeSections(sections) {
  if (sections === undefined) return [];
  if (!Array.isArray(sections)) throw Error('options.sections must be an array');
  return sections.map((item, index) => {
    if (!item || typeof item !== 'object') throw Error(`options.sections[${index}] must be an object`);
    if (typeof item.role !== 'string' || !item.role.trim()) throw Error(`options.sections[${index}].role must be a non-empty string`);
    const start = key(item.start);
    const end = key(item.end);
    if (cmpB(end, start) <= 0) throw Error(`options.sections[${index}] must have end > start`);
    return Object.freeze({ start, end, role: item.role.trim() });
  }).sort((a, b) => cmpB(a.start, b.start) || cmpB(a.end, b.end) || cmpStr(a.role, b.role));
}

// ─── candidate lanes ────────────────────────────────────────────────────────

// One candidate lane per (source voice, G11-B lane). The lane is the unit a
// role decision is *made* on; the ledger is still written per source event, so
// a reviewer can diff at event level (MASTER_RULES.md §3).
//
// A G11-B lane index carries no role meaning whatsoever: `lane 0` is not
// Melody, the highest weighted pitch is not Melody, and the lowest is not
// Chord2. The index survives here only as provenance.
function buildLanes(decompositions, noteById) {
  const lanes = [];
  decompositions.forEach((decomposition, decompositionIndex) => {
    if (!decomposition || !Array.isArray(decomposition.lanes)) throw Error('each decomposition must expose a lanes array');
    const sourceVoice = decomposition.sourceVoice ?? null;
    const voiceKey = sourceVoice === null ? 'voice:null' : String(sourceVoice);
    for (const lane of decomposition.lanes) {
      const spans = [...lane.notes].sort((a, b) => cmpB(a.start, b.start) || b.pitch - a.pitch || cmpStr(a.eventId, b.eventId));
      if (!spans.length) continue;
      const eventIds = [...new Set(spans.map(span => span.eventId))].sort(cmpStr);
      const sourceIds = [...new Set(spans.flatMap(span => [...span.sourceIds]))].sort(cmpStr);
      const sourceEventIds = [...new Set(spans.flatMap(span => [...span.sourceEventIds]))].sort(cmpStr);
      const sourceRoles = [...new Set(eventIds.map(id => noteById.get(id)?.role ?? null))]
        .filter(role => role !== null).sort(cmpStr);
      const programs = [...new Set(eventIds.map(id => noteById.get(id)?.metadata?.program ?? null))]
        .filter(program => Number.isInteger(program)).sort((a, b) => a - b);
      const trackNames = [...new Set(eventIds.map(id => noteById.get(id)?.metadata?.trackName ?? null))]
        .filter(name => typeof name === 'string' && name).sort(cmpStr);
      lanes.push({
        id: `lane:${voiceKey}#${lane.index}`,
        decompositionIndex,
        sourceVoice,
        laneIndex: lane.index,
        chainIds: [...lane.chainIds],
        eventIds,
        sourceIds,
        sourceEventIds,
        sourceRoles,
        programs,
        trackNames,
        spans,
        junctions: [...lane.junctions],
        segments: [...lane.segments],
      });
    }
  });
  lanes.sort((a, b) => cmpStr(String(a.sourceVoice ?? ''), String(b.sourceVoice ?? '')) || a.laneIndex - b.laneIndex || cmpStr(a.id, b.id));
  return lanes;
}

// An attack is a span that begins its own source event. A continuation fragment
// is not a new note-on, and counting it as one would invent rhythm that the
// source never stated (MOBILE_SYNTAX.md §8 on note-on identity).
const isAttack = span => cmpB(span.start, span.eventStart) === 0;

function laneMetrics(lane) {
  const attacks = lane.spans.filter(isAttack);
  let sounding = ZERO;
  for (const span of lane.spans) sounding = sounding.add(sub(span.end, span.start));
  const pitches = attacks.map(span => span.pitch);
  let pitchChanges = 0;
  for (let i = 1; i < pitches.length; i++) if (pitches[i] !== pitches[i - 1]) pitchChanges++;
  const allPitches = lane.spans.map(span => span.pitch);
  return {
    start: lane.spans[0].start,
    end: lane.spans.reduce((latest, span) => (cmpB(span.end, latest) > 0 ? span.end : latest), lane.spans[0].end),
    spanCount: lane.spans.length,
    attackCount: attacks.length,
    attackBeats: [...new Set(attacks.map(span => key(span.start)))].sort(cmpB),
    soundingTime: key(sounding),
    distinctPitches: new Set(allPitches).size,
    pitchChanges,
    pitchChangeRatio: attacks.length > 1 ? key(f(pitchChanges).div(attacks.length - 1)) : '0',
    weightedPitch: key(weightedPitch(lane.spans, allPitches[0])),
    minPitch: Math.min(...allPitches),
    maxPitch: Math.max(...allPitches),
    pitchClasses: [...new Set(allPitches.map(pitch => ((pitch % 12) + 12) % 12))].sort((a, b) => a - b),
    meanSpan: key(f(sounding).div(lane.spans.length)),
  };
}

// ─── shared exact time grid ─────────────────────────────────────────────────
//
// One sweep over every exact lane boundary. Everything that needs to know "what
// was sounding together" reads this grid instead of rescanning the score, which
// keeps the cross-lane questions linear in boundaries rather than quadratic in
// notes (§19 of the G11-C brief; the repo's existing convention is a work-shape
// bound, not a wall-clock budget).
function buildGrid(lanes, instrumentation) {
  const edges = new Map();
  lanes.forEach((lane, laneIndex) => {
    for (const span of lane.spans) {
      for (const at of [span.start, span.end]) {
        const k = key(at);
        if (!edges.has(k)) edges.set(k, { beat: k, open: [], close: [] });
      }
      edges.get(key(span.start)).open.push({ laneIndex, pitch: span.pitch, eventId: span.eventId });
      edges.get(key(span.end)).close.push({ laneIndex, pitch: span.pitch, eventId: span.eventId });
    }
  });
  const ordered = [...edges.values()].sort((a, b) => cmpB(a.beat, b.beat));
  const intervals = [];
  let active = [];
  let inspections = 0;
  for (let i = 0; i < ordered.length; i++) {
    const edge = ordered[i];
    if (edge.close.length) {
      const closing = new Set(edge.close.map(item => `${item.laneIndex}|${item.pitch}|${item.eventId}`));
      active = active.filter(item => !closing.has(`${item.laneIndex}|${item.pitch}|${item.eventId}`));
    }
    for (const item of edge.open) active.push(item);
    const next = ordered[i + 1];
    if (!next || !active.length) continue;
    inspections += active.length;
    const minPitch = Math.min(...active.map(item => item.pitch));
    intervals.push({
      start: edge.beat,
      end: next.beat,
      duration: key(sub(next.beat, edge.beat)),
      active: active.map(item => ({ ...item })),
      laneIndices: [...new Set(active.map(item => item.laneIndex))].sort((a, b) => a - b),
      minPitch,
      floorLaneIndices: [...new Set(active.filter(item => item.pitch === minPitch).map(item => item.laneIndex))].sort((a, b) => a - b),
    });
  }
  if (instrumentation) {
    instrumentation.gridEdges = ordered.length;
    instrumentation.gridIntervals = intervals.length;
    instrumentation.gridActiveInspections = inspections;
  }
  return intervals;
}

// Time each lane spends as the lowest sounding pitch. This is a *function*
// measurement over the real sounding grid, not "lane with the lowest average
// pitch": Canonical forbids the latter from proving Chord2, and G11-B's
// `averagePitch` is a presentation field only.
function floorTimes(lanes, intervals) {
  const totals = lanes.map(() => ZERO);
  for (const interval of intervals) {
    for (const laneIndex of interval.floorLaneIndices) totals[laneIndex] = totals[laneIndex].add(interval.duration);
  }
  return totals.map(total => key(total));
}

// Attacks a lane shares, at the exact same beat, with another lane of the same
// source voice. A block-chord top voice shares every onset with its own inner
// voices; an independent line does not. This is what keeps "highest note" from
// becoming Lead evidence on its own.
function sharedOnsetCounts(lanes) {
  const byVoice = new Map();
  lanes.forEach((lane, index) => {
    const voiceKey = String(lane.sourceVoice ?? 'voice:null');
    if (!byVoice.has(voiceKey)) byVoice.set(voiceKey, []);
    byVoice.get(voiceKey).push(index);
  });
  const shared = lanes.map(() => 0);
  for (const indices of [...byVoice.values()]) {
    if (indices.length < 2) continue;
    const beatSets = indices.map(index => new Set(lanes[index].metrics.attackBeats));
    indices.forEach((index, position) => {
      let count = 0;
      for (const beat of lanes[index].metrics.attackBeats) {
        if (beatSets.some((set, other) => other !== position && set.has(beat))) count++;
      }
      shared[index] = count;
    });
  }
  return shared;
}

// ─── structured role evidence ───────────────────────────────────────────────
//
// SOURCE_POLICY.md §2 forbids collapsing disagreeing evidence into one score.
// Every record below keeps its own measurement and its own threshold, and the
// role decision cites the record ids it actually used. There is no aggregate
// number that could hide a conflict.
//
// `strength` is the load-bearing field:
//   primary    - may, on its own, support a role proposal;
//   supporting - context only; can never create an assignment;
//   conflict   - recorded disagreement; never silently resolved.

function evidenceRecord(lane, seq, record) {
  return Object.freeze({
    id: `ev:${lane.id}:${String(seq).padStart(2, '0')}:${record.signal}`,
    laneId: lane.id,
    evidenceClass: record.evidenceClass ?? 'symbolic-derived',
    ...record,
    supportsRoles: Object.freeze([...(record.supportsRoles ?? [])]),
    measurement: Object.freeze({ ...record.measurement }),
    threshold: record.threshold === undefined ? null : record.threshold,
  });
}

function buildLaneEvidence(lane, context) {
  const t = ROLE_CANDIDATE_THRESHOLDS;
  const records = [];
  const push = record => { records.push(evidenceRecord(lane, records.length, record)); };

  push({
    signal: 'source_voice_identity',
    strength: 'supporting',
    evidenceClass: 'symbolic',
    supportsRoles: [],
    measurement: {
      sourceVoice: lane.sourceVoice,
      decompositionLaneIndex: lane.laneIndex,
      trackNames: lane.trackNames,
      sourceIds: lane.sourceIds,
      eventCount: lane.eventIds.length,
    },
    notice: 'Source voice identity separates provenance. A G11-B lane index carries no role meaning.',
  });

  for (const role of lane.sourceRoles) {
    push({
      signal: 'source_role_hint',
      strength: 'primary',
      evidenceClass: 'symbolic',
      supportsRoles: [role],
      measurement: {
        role,
        eventIds: lane.eventIds.filter(id => context.noteById.get(id)?.role === role),
        coversWholeLane: lane.eventIds.every(id => context.noteById.get(id)?.role === role),
      },
      notice: 'Role carried by the Source-Faithful Baseline event itself.',
    });
  }

  for (const entry of context.roleEvidence) {
    const targetsVoice = entry.sourceVoice !== null && String(entry.sourceVoice) === String(lane.sourceVoice);
    const targetsLane = entry.laneId !== null && entry.laneId === lane.id;
    const targetsEvents = entry.eventIds.length > 0 && entry.eventIds.some(id => lane.eventIds.includes(id));
    if (!targetsVoice && !targetsLane && !targetsEvents) continue;
    push({
      signal: 'trusted_symbolic_role',
      strength: 'primary',
      evidenceClass: 'symbolic',
      supportsRoles: [entry.role],
      measurement: {
        role: entry.role,
        citation: entry.citation,
        matchedBy: targetsLane ? 'laneId' : targetsVoice ? 'sourceVoice' : 'eventIds',
        eventIds: entry.eventIds.filter(id => lane.eventIds.includes(id)),
      },
      notice: 'Trusted symbolic role evidence supplied with a citation. Symbolic and audio evidence remain separate classes; audio evidence is not accepted at this layer.',
    });
  }

  for (const program of lane.programs) {
    push({
      signal: 'instrument_hint',
      strength: 'supporting',
      evidenceClass: 'symbolic',
      supportsRoles: [],
      measurement: { program, family: gmFamily(program) },
      notice: 'Program/instrument alone never proves a final role (SOURCE_POLICY.md §A).',
    });
  }

  push({
    signal: 'register_position',
    strength: 'supporting',
    supportsRoles: [],
    measurement: {
      weightedPitchExact: lane.metrics.weightedPitch,
      minPitch: lane.metrics.minPitch,
      maxPitch: lane.metrics.maxPitch,
      registerRankFromTop: context.registerRank.get(lane.id),
      laneCount: context.laneCount,
    },
    notice: 'Register is supporting context only. Highest pitch never proves Melody and lowest pitch never proves Chord2.',
  });

  push({
    signal: 'continuity',
    strength: 'supporting',
    supportsRoles: [],
    measurement: {
      chainCount: lane.chainIds.length,
      soundingTime: lane.metrics.soundingTime,
      start: lane.metrics.start,
      end: lane.metrics.end,
      silenceJunctions: lane.junctions.filter(junction => junction.silence)
        .map(junction => ({ from: junction.from, to: junction.to })),
      continuousVoiceAsserted: false,
    },
    notice: 'Chains packed into one G11-B lane are a packing fact. Continuity across a silence junction is never asserted.',
  });

  push({
    signal: 'rhythmic_density',
    strength: 'supporting',
    supportsRoles: [],
    measurement: {
      attackCount: lane.metrics.attackCount,
      soundingTime: lane.metrics.soundingTime,
      meanSpan: lane.metrics.meanSpan,
    },
    notice: 'Density is diagnostic, never an optimization target (ACCEPTANCE_CRITERIA.md Gate 4).',
  });

  // ── the two function measurements that may carry a role on their own ──

  const varietyOk = lane.metrics.distinctPitches >= t.leadMinDistinctPitches
    && lane.metrics.attackCount > 1
    && ratioAtLeast(lane.metrics.pitchChanges, lane.metrics.attackCount - 1, t.leadMinPitchChangeRatio);
  const independentOk = lane.metrics.attackCount > 0
    && ratioBelow(lane.sharedOnsets, lane.metrics.attackCount, t.leadMaxSharedOnsetRatio);
  const melodicLine = varietyOk && independentOk;

  push({
    signal: 'melodic_contour',
    strength: melodicLine ? 'primary' : 'supporting',
    supportsRoles: melodicLine ? ['Melody'] : [],
    measurement: {
      distinctPitches: lane.metrics.distinctPitches,
      pitchChanges: lane.metrics.pitchChanges,
      attackCount: lane.metrics.attackCount,
      pitchChangeRatio: lane.metrics.pitchChangeRatio,
      varietySatisfied: varietyOk,
    },
    threshold: { minDistinctPitches: t.leadMinDistinctPitches, minPitchChangeRatio: t.leadMinPitchChangeRatio },
    notice: 'An independent melodic line is Lead *evidence*, never a Lead verdict.',
  });

  push({
    signal: 'attack_independence',
    strength: melodicLine ? 'primary' : 'supporting',
    supportsRoles: melodicLine ? ['Melody'] : [],
    measurement: {
      sharedOnsetsWithinSourceVoice: lane.sharedOnsets,
      attackCount: lane.metrics.attackCount,
      independenceSatisfied: independentOk,
    },
    threshold: { maxSharedOnsetRatio: t.leadMaxSharedOnsetRatio },
    notice: 'A voice whose every onset is shared with its own siblings is a chord member, not an independent line.',
  });

  const floorSatisfied = ratioAtLeast(lane.floorTime, lane.metrics.soundingTime, t.bassFloorMinRatio);
  push({
    signal: 'bass_function',
    strength: floorSatisfied ? 'primary' : 'supporting',
    supportsRoles: floorSatisfied ? ['Chord2'] : [],
    measurement: {
      timeAsLowestSoundingPitch: lane.floorTime,
      soundingTime: lane.metrics.soundingTime,
      floorSatisfied,
    },
    threshold: { minFloorRatio: t.bassFloorMinRatio },
    notice: 'Measured over the real sounding grid. This is a harmonic-floor function, not "the lane with the lowest average pitch".',
  });

  const sections = context.sections.filter(section =>
    cmpB(section.start, lane.metrics.end) < 0 && cmpB(lane.metrics.start, section.end) < 0);
  if (sections.length) {
    push({
      signal: 'section_role',
      strength: 'supporting',
      evidenceClass: 'symbolic',
      supportsRoles: [],
      measurement: { sections: sections.map(section => ({ ...section })) },
      notice: 'Section/form context only. A vocal rest never demotes a Lead and never creates a Lead gap.',
    });
  }

  return { records: records.sort((a, b) => cmpStr(a.id, b.id)), melodicLine, floorSatisfied };
}

// Evidence tiers per role. A higher tier is *stronger*, not merely preferred:
// selection only ever happens inside the highest non-empty tier, so a lane with
// declared source-role evidence is never outvoted by a derived measurement.
function roleSupport(lane, evidence) {
  const support = {};
  const declaredFor = role => evidence.records.filter(record =>
    (record.signal === 'source_role_hint' || record.signal === 'trusted_symbolic_role')
    && record.supportsRoles.includes(role));

  for (const role of SIX_ROLES) {
    const declared = declaredFor(role);
    if (declared.length) {
      support[role] = { tier: 1, tierName: 'DECLARED_SOURCE_ROLE', evidenceIds: declared.map(record => record.id) };
      continue;
    }
    support[role] = { tier: null, tierName: null, evidenceIds: [] };
  }

  if (support.Melody.tier === null && evidence.melodicLine) {
    support.Melody = {
      tier: evidence.floorSatisfied ? 3 : 2,
      tierName: evidence.floorSatisfied ? 'MELODIC_LINE_AT_HARMONIC_FLOOR' : 'INDEPENDENT_MELODIC_LINE',
      evidenceIds: evidence.records
        .filter(record => record.strength === 'primary' && record.supportsRoles.includes('Melody'))
        .map(record => record.id),
    };
  }

  if (support.Chord2.tier === null && evidence.floorSatisfied) {
    support.Chord2 = {
      tier: 2,
      tierName: 'BASS_FUNCTION',
      evidenceIds: evidence.records
        .filter(record => record.strength === 'primary' && record.supportsRoles.includes('Chord2'))
        .map(record => record.id),
    };
  }

  for (const role of SIX_ROLES) Object.freeze(support[role]);
  return Object.freeze(support);
}

// ─── selection primitives ───────────────────────────────────────────────────

function mergedIntervals(lane) {
  const merged = [];
  for (const span of [...lane.spans].sort((a, b) => cmpB(a.start, b.start) || cmpB(a.end, b.end))) {
    const last = merged.at(-1);
    if (last && cmpB(span.start, last.end) <= 0) last.end = key(maxB(last.end, span.end));
    else merged.push({ start: key(span.start), end: key(span.end) });
  }
  return merged;
}

function lanesOverlap(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.intervals.length && j < b.intervals.length) {
    const left = a.intervals[i];
    const right = b.intervals[j];
    if (cmpB(left.start, right.end) < 0 && cmpB(right.start, left.end) < 0) return true;
    if (cmpB(left.end, right.end) <= 0) i++; else j++;
  }
  return false;
}

// Pick inside the strongest non-empty evidence tier only.
//
// Time-disjoint lanes in that tier are a hand-off, not a contest: a Lead that
// stops while an instrumental answer continues is exactly the case
// MASTER_RULES.md §4 protects, and treating it as competition would manufacture
// the false gap ACCEPTANCE_CRITERIA.md Gate 3 forbids.
//
// Lanes that genuinely overlap inside the same tier *are* a contest. Picking
// one of them would be inventing certainty, so the whole role decision becomes
// PENDING and every candidate keeps its evidence.
function selectWithinTier(candidates) {
  if (!candidates.length) return { status: 'EMPTY', selected: [], competing: [], tier: null, tierName: null };
  const tier = Math.min(...candidates.map(item => item.tier));
  const pool = candidates
    .filter(item => item.tier === tier)
    .sort((a, b) =>
      cmpB(a.lane.metrics.start, b.lane.metrics.start)
      || f(b.lane.metrics.weightedPitch).cmp(a.lane.metrics.weightedPitch)
      || cmpStr(a.lane.id, b.lane.id));
  const selected = [pool[0]];
  const competing = [];
  for (const item of pool.slice(1)) {
    if (selected.some(chosen => lanesOverlap(chosen.lane, item.lane))) competing.push(item);
    else selected.push(item);
  }
  if (competing.length) {
    return { status: 'PENDING', selected: [], competing: pool, tier, tierName: pool[0].tierName ?? null };
  }
  return { status: 'ASSIGNED', selected, competing: [], tier, tierName: pool[0].tierName ?? null };
}

// ─── Core3 coverage over the shared grid ────────────────────────────────────

// Windows where the source sounds but none of the given lanes does.
//
// Called twice, for the two concrete, source-relative readings of "Core3 remains
// intelligible without Chord3-Chord5" (ACCEPTANCE_CRITERIA.md Gate 4):
//   * against all of Core3 - Core3 falls silent while the source still sounds;
//   * against Chord1 + Chord2 - the Lead is left with no accompaniment at all.
// Material sounding in either window is *essential*, not enrichment: a complete
// one-player arrangement needs it (MASTER_RULES.md §5).
function silentWindows(intervals, laneIndices, lanes) {
  const core3 = new Set(laneIndices);
  const windows = [];
  for (const interval of intervals) {
    if (interval.laneIndices.some(index => core3.has(index))) continue;
    const last = windows.at(-1);
    const laneIds = interval.laneIndices.map(index => lanes[index].id);
    const eventIds = [...new Set(interval.active.map(item => item.eventId))].sort(cmpStr);
    if (last && cmpB(last.end, interval.start) === 0) {
      last.end = interval.end;
      last.laneIds = [...new Set([...last.laneIds, ...laneIds])].sort(cmpStr);
      last.eventIds = [...new Set([...last.eventIds, ...eventIds])].sort(cmpStr);
      continue;
    }
    windows.push({ start: interval.start, end: interval.end, laneIds: laneIds.sort(cmpStr), eventIds });
  }
  return windows;
}

// Time a lane sounds a pitch class that no Core3 lane is sounding at that exact
// moment, and time it sounds a pitch some Core3 lane is already sounding. The
// first is what makes enrichment *add* something; the second is duplication.
function enrichmentAgainstCore3(lane, laneIndex, intervals, core3LaneIndices) {
  const core3 = new Set(core3LaneIndices);
  let addedPitchClassTime = ZERO;
  let duplicatedPitchTime = ZERO;
  let sharedWindowTime = ZERO;
  for (const interval of intervals) {
    if (!interval.laneIndices.includes(laneIndex)) continue;
    const core3Active = interval.active.filter(item => core3.has(item.laneIndex));
    if (!core3Active.length) continue;
    sharedWindowTime = sharedWindowTime.add(interval.duration);
    const core3Pitches = new Set(core3Active.map(item => item.pitch));
    const core3Classes = new Set(core3Active.map(item => ((item.pitch % 12) + 12) % 12));
    const own = interval.active.filter(item => item.laneIndex === laneIndex);
    if (own.some(item => core3Pitches.has(item.pitch))) duplicatedPitchTime = duplicatedPitchTime.add(interval.duration);
    if (own.some(item => !core3Classes.has(((item.pitch % 12) + 12) % 12))) addedPitchClassTime = addedPitchClassTime.add(interval.duration);
  }
  return {
    addedPitchClassTime: key(addedPitchClassTime),
    duplicatedPitchTime: key(duplicatedPitchTime),
    sharedWindowTime: key(sharedWindowTime),
  };
}

// ─── the assignment pipeline ────────────────────────────────────────────────
//
// Order matters and follows the Canonical musical decision hierarchy
// (MASTER_RULES.md §2): source completeness -> Lead continuity -> Core3
// completeness -> Full6 enrichment. Nothing is optimized across all six roles
// at once, because doing so lets a Full6 metric pay for a weaker Core3.

function assignRoles(state) {
  const { lanes, pinned } = state;
  const assignment = new Map();          // laneId -> role
  const roleMeta = new Map();            // role -> { status, tier, tierName, reasons, competingLaneIds, evidenceIds }
  const pendingLanes = [];
  const pendingLaneIds = new Set();
  const markPending = entry => { pendingLanes.push(entry); pendingLaneIds.add(entry.laneId); };

  const meta = (role, patch) => {
    const current = roleMeta.get(role) ?? { status: 'EMPTY', tier: null, tierName: null, reasons: [], competingLaneIds: [], evidenceIds: [] };
    roleMeta.set(role, { ...current, ...patch, reasons: [...current.reasons, ...(patch.reasons ?? [])] });
  };

  // Lead-demotion interlock, applied before anything at all is selected.
  //
  // MASTER_RULES.md §4 and SOURCE_POLICY.md §4: moving a source-supported Lead
  // off Melody needs positive role evidence and a demotion report, and G11-C is
  // not that gate. So the move is refused *and* no substitute Lead is quietly
  // chosen in its place: silently promoting some other lane to Melody while the
  // declared Lead's status is unresolved would be the same rewrite by another
  // route.
  const blockedLeadLaneIds = new Set();
  for (const lane of lanes) {
    if (!lane.sourceRoles.includes('Melody')) continue;
    if (!pinned.has(lane.id) || pinned.get(lane.id) === 'Melody') continue;
    blockedLeadLaneIds.add(lane.id);
    markPending({
      laneId: lane.id,
      proposedRole: pinned.get(lane.id),
      blockers: ['LEAD_DEMOTION_NOT_EVALUATED'],
      competingLaneIds: [],
      evidenceIds: lane.roleSupport.Melody.evidenceIds,
      gate: 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion',
    });
  }

  // Caller pins come next: an explicit override is a declared decision, and the
  // automatic selection must not compete with it.
  for (const [laneId, role] of [...pinned.entries()].sort(([a], [b]) => cmpStr(a, b))) {
    if (role === null || blockedLeadLaneIds.has(laneId)) continue;
    assignment.set(laneId, role);
    meta(role, { status: 'ASSIGNED', tier: 0, tierName: 'CALLER_ROLE_OVERRIDE', reasons: ['CALLER_ROLE_OVERRIDE'] });
  }
  const isFree = lane => !pinned.has(lane.id) && !assignment.has(lane.id) && !pendingLaneIds.has(lane.id);

  // 1. Lead / Melody.
  const melodyPinned = [...assignment.entries()].some(([, role]) => role === 'Melody');
  if (blockedLeadLaneIds.size) {
    meta('Melody', {
      status: 'PENDING',
      reasons: ['DECLARED_LEAD_DEMOTION_UNRESOLVED'],
      competingLaneIds: [...blockedLeadLaneIds].sort(cmpStr),
    });
  } else if (!melodyPinned) {
    const candidates = lanes
      .filter(isFree)
      .filter(lane => lane.roleSupport.Melody.tier !== null)
      .map(lane => ({ lane, tier: lane.roleSupport.Melody.tier, tierName: lane.roleSupport.Melody.tierName }));
    const picked = selectWithinTier(candidates);
    if (picked.status === 'ASSIGNED') {
      picked.selected.forEach((item, index) => {
        assignment.set(item.lane.id, 'Melody');
        if (index > 0) item.lane.handOff = true;
      });
      meta('Melody', {
        status: 'ASSIGNED',
        tier: picked.tier,
        tierName: picked.tierName,
        reasons: picked.selected.length > 1 ? ['LEAD_SELECTED', 'LEAD_HANDOFF_CONTINUATION'] : ['LEAD_SELECTED'],
        evidenceIds: picked.selected.flatMap(item => item.lane.roleSupport.Melody.evidenceIds).sort(cmpStr),
      });
    } else if (picked.status === 'PENDING') {
      meta('Melody', {
        status: 'PENDING',
        tier: picked.tier,
        reasons: ['COMPETING_LEAD_CANDIDATES'],
        competingLaneIds: picked.competing.map(item => item.lane.id).sort(cmpStr),
        evidenceIds: picked.competing.flatMap(item => item.lane.roleSupport.Melody.evidenceIds).sort(cmpStr),
      });
      for (const item of picked.competing) {
        markPending({
          laneId: item.lane.id,
          proposedRole: 'Melody',
          blockers: ['COMPETING_LEAD_CANDIDATES'],
          competingLaneIds: picked.competing.filter(other => other !== item).map(other => other.lane.id).sort(cmpStr),
          evidenceIds: item.lane.roleSupport.Melody.evidenceIds,
        });
      }
    } else {
      meta('Melody', { status: 'EMPTY', reasons: ['NO_LEAD_EVIDENCE'] });
    }
  }
  const available = lane => isFree(lane);

  // 2. Chord2 bass skeleton. Canonical forbids hardening Chord2 into Bass-only,
  //    so this step fills only the *skeleton*; essential inner support is added
  //    in step 4, after Core3 coverage is known.
  const chord2Pinned = [...assignment.entries()].some(([, role]) => role === 'Chord2');
  if (!chord2Pinned) {
    const candidates = lanes
      .filter(available)
      .filter(lane => lane.roleSupport.Chord2.tier !== null)
      .map(lane => ({ lane, tier: lane.roleSupport.Chord2.tier, tierName: lane.roleSupport.Chord2.tierName }));
    const picked = selectWithinTier(candidates);
    if (picked.status === 'ASSIGNED') {
      for (const item of picked.selected) assignment.set(item.lane.id, 'Chord2');
      meta('Chord2', {
        status: 'ASSIGNED',
        tier: picked.tier,
        tierName: picked.tierName,
        reasons: ['BASS_SKELETON_SELECTED'],
        evidenceIds: picked.selected.flatMap(item => item.lane.roleSupport.Chord2.evidenceIds).sort(cmpStr),
      });
    } else if (picked.status === 'PENDING') {
      meta('Chord2', {
        status: 'PENDING',
        tier: picked.tier,
        reasons: ['COMPETING_BASS_CANDIDATES'],
        competingLaneIds: picked.competing.map(item => item.lane.id).sort(cmpStr),
        evidenceIds: picked.competing.flatMap(item => item.lane.roleSupport.Chord2.evidenceIds).sort(cmpStr),
      });
      for (const item of picked.competing) {
        markPending({
          laneId: item.lane.id,
          proposedRole: 'Chord2',
          blockers: ['COMPETING_BASS_CANDIDATES'],
          competingLaneIds: picked.competing.filter(other => other !== item).map(other => other.lane.id).sort(cmpStr),
          evidenceIds: item.lane.roleSupport.Chord2.evidenceIds,
        });
      }
    } else {
      meta('Chord2', { status: 'EMPTY', reasons: ['NO_BASS_FUNCTION_EVIDENCE'] });
    }
  }

  // 3. Chord1 principal harmony / accompaniment / essential response.
  //
  //    Declared source-role evidence decides outright *and* positively
  //    establishes the function. Otherwise the source voice with the greatest
  //    source-supported harmonic coverage is ranked first, and only then its
  //    principal lane -- but that ranking produces a *candidate*, never proof.
  //    Total sounding time, attack count, register and density cannot establish
  //    principal harmony: a long sustained pad outlasts the real accompaniment
  //    without being it. Choosing at voice level keeps the ordinary "one
  //    accompaniment voice, several lanes" case from looking like a tie between
  //    three members of the same chord.
  const chord1Pinned = [...assignment.entries()].some(([, role]) => role === 'Chord1');
  if (!chord1Pinned) {
    const declared = lanes.filter(available).filter(lane => lane.roleSupport.Chord1.tier === 1);
    if (declared.length) {
      // Declared lanes are co-assignees, not rivals. The overlap contest exists
      // to stop the implementation arbitrarily picking one of several plausible
      // candidates; when the source names the role for all of them there is
      // nothing to pick between, and a role holds zero or more lanes. Declaring
      // a whole accompaniment staff as Chord1 must yield Chord1, not a deadlock.
      for (const lane of declared) assignment.set(lane.id, 'Chord1');
      meta('Chord1', {
        status: 'ASSIGNED', tier: 1, tierName: 'DECLARED_SOURCE_ROLE',
        reasons: ['PRINCIPAL_HARMONY_DECLARED'],
        evidenceIds: declared.flatMap(lane => lane.roleSupport.Chord1.evidenceIds).sort(cmpStr),
      });
    } else {
      const pool = lanes.filter(available);
      const voices = new Map();
      for (const lane of pool) {
        const voiceKey = String(lane.sourceVoice ?? 'voice:null');
        if (!voices.has(voiceKey)) voices.set(voiceKey, { voiceKey, lanes: [], sounding: ZERO, attacks: 0 });
        const entry = voices.get(voiceKey);
        entry.lanes.push(lane);
        entry.sounding = entry.sounding.add(lane.metrics.soundingTime);
        entry.attacks += lane.metrics.attackCount;
      }
      const ranked = [...voices.values()].sort((a, b) =>
        b.sounding.cmp(a.sounding) || b.attacks - a.attacks || cmpStr(a.voiceKey, b.voiceKey));
      if (!ranked.length) {
        meta('Chord1', { status: 'EMPTY', reasons: ['NO_HARMONY_CANDIDATE_LANE'] });
      } else if (ranked.length > 1
        && ranked[0].sounding.cmp(ranked[1].sounding) === 0
        && ranked[0].attacks === ranked[1].attacks) {
        const tied = ranked.filter(entry =>
          entry.sounding.cmp(ranked[0].sounding) === 0 && entry.attacks === ranked[0].attacks);
        const tiedLaneIds = tied.flatMap(entry => entry.lanes.map(lane => lane.id)).sort(cmpStr);
        meta('Chord1', {
          status: 'PENDING', tier: 2, reasons: ['COMPETING_HARMONY_CANDIDATES'],
          competingLaneIds: tiedLaneIds,
        });
        for (const laneId of tiedLaneIds) {
          markPending({
            laneId, proposedRole: 'Chord1', blockers: ['COMPETING_HARMONY_CANDIDATES'],
            competingLaneIds: tiedLaneIds.filter(other => other !== laneId), evidenceIds: [],
          });
        }
      } else {
        const voice = ranked[0];
        const byPrincipal = [...voice.lanes].sort((a, b) =>
          f(b.metrics.soundingTime).cmp(a.metrics.soundingTime)
          || f(b.metrics.weightedPitch).cmp(a.metrics.weightedPitch)
          || cmpStr(a.id, b.id));
        const principal = byPrincipal[0];
        const registerDecided = byPrincipal.length > 1
          && f(byPrincipal[1].metrics.soundingTime).cmp(principal.metrics.soundingTime) === 0;
        const selected = [principal];
        for (const lane of byPrincipal.slice(1)) {
          if (!selected.some(chosen => lanesOverlap(chosen, lane))) selected.push(lane);
        }
        for (const lane of selected) assignment.set(lane.id, 'Chord1');
        meta('Chord1', {
          status: 'ASSIGNED', tier: 2, tierName: 'BEST_AVAILABLE_COVERAGE_CANDIDATE',
          reasons: registerDecided
            ? ['BEST_AVAILABLE_COVERAGE_CANDIDATE', 'TIE_BROKEN_BY_REGISTER_WITHIN_SOURCE_VOICE']
            : ['BEST_AVAILABLE_COVERAGE_CANDIDATE'],
          evidenceIds: [],
        });
        state.chord1Measurement = Object.freeze({
          sourceVoice: voice.voiceKey,
          harmonicCoverage: key(voice.sounding),
          attackCount: voice.attacks,
          laneIdsInVoice: voice.lanes.map(lane => lane.id).sort(cmpStr),
          principalLaneId: principal.id,
          tieBrokenByRegisterWithinSourceVoice: registerDecided,
          establishesPrincipalHarmony: false,
          notice: 'Deterministic ranking only. Coverage, attack count, register and density rank candidates; none of them establishes that this voice IS the principal harmony. Register is used only to order lanes inside one already-ranked accompaniment voice, and never selects Melody or Chord2.',
        });
      }
    }
  }

  return { assignment, roleMeta, pendingLanes };
}

// 4. Essential inner support, then Full6 enrichment.
//
//    MASTER_RULES.md §5: Chord2 is the bass skeleton *plus* any essential inner
//    voice a complete one-player arrangement needs. "Essential" is measured,
//    not asserted: a lane is essential when Core3 would otherwise fall silent
//    while the source is still sounding. Material that only adds colour inside
//    windows Core3 already covers is enrichment, and belongs in Chord3-Chord5.
function classifyRemaining(state, assignment, pendingLaneIds) {
  const { lanes, intervals, pinned } = state;
  const laneIndexById = new Map(lanes.map((lane, index) => [lane.id, index]));
  const core3Indices = () => lanes
    .map((lane, index) => (CORE3_ROLE_NAMES.includes(assignment.get(lane.id)) ? index : -1))
    .filter(index => index >= 0);

  const supportIndices = () => lanes
    .map((lane, index) => (['Chord1', 'Chord2'].includes(assignment.get(lane.id)) ? index : -1))
    .filter(index => index >= 0);

  // Essential material is only meaningful relative to a Core3 that exists. When
  // Core3 is entirely empty the candidate is already INCOMPLETE for missing
  // functions, and sweeping every remaining lane into Chord2 would invent an
  // arrangement rather than report the deficiency.
  const hasCore3 = core3Indices().length > 0;

  // Gaps are only read inside the span Core3 actually occupies. Whether roles
  // must start and end together at all is unresolved (PENDING.md P14), so a
  // lane that merely runs past Core3's last event is an end-time question, not
  // evidence that Core3 is missing essential material. Those edge windows are
  // reported separately instead.
  const core3Span = hasCore3 ? core3Indices().reduce((span, index) => {
    const lane = lanes[index];
    return span === null
      ? { start: key(lane.metrics.start), end: key(lane.metrics.end) }
      : { start: key(minB(span.start, lane.metrics.start)), end: key(maxB(span.end, lane.metrics.end)) };
  }, null) : null;
  const insideSpan = interval => core3Span !== null
    && cmpB(interval.start, core3Span.start) >= 0
    && cmpB(interval.end, core3Span.end) <= 0;
  const spanIntervals = intervals.filter(insideSpan);
  const edgeIntervals = intervals.filter(interval => !insideSpan(interval));

  const core3Silence = hasCore3 ? silentWindows(spanIntervals, core3Indices(), lanes) : [];
  const supportSilence = hasCore3 && supportIndices().length
    ? silentWindows(spanIntervals, supportIndices(), lanes)
    : [];
  const edgeWindows = hasCore3 ? silentWindows(edgeIntervals, core3Indices(), lanes) : [];
  const gapsBefore = core3Silence;
  const essentialLaneIds = new Set([
    ...core3Silence.flatMap(window => window.laneIds),
    ...supportSilence.flatMap(window => window.laneIds),
  ]);

  const promoted = [];
  for (const lane of lanes) {
    if (!essentialLaneIds.has(lane.id)) continue;
    if (assignment.has(lane.id) || pinned.has(lane.id) || pendingLaneIds.has(lane.id)) continue;
    assignment.set(lane.id, 'Chord2');
    promoted.push(lane.id);
  }

  const gapsAfter = hasCore3 ? silentWindows(spanIntervals, core3Indices(), lanes) : [];
  const supportGapsAfter = hasCore3 && supportIndices().length
    ? silentWindows(spanIntervals, supportIndices(), lanes)
    : [];
  const core3Set = core3Indices();

  // Everything outside Core3 is analysed for enrichment value, including lanes
  // a caller pinned straight into Chord3-Chord5: the Full6 rationale has to be
  // able to say that a pinned lane duplicates Core3, or that it was essential
  // and should never have been enrichment at all.
  const analysisPool = lanes.filter(lane =>
    !CORE3_ROLE_NAMES.includes(assignment.get(lane.id))
    && !pendingLaneIds.has(lane.id)
    && pinned.get(lane.id) !== null);
  const t = ROLE_CANDIDATE_THRESHOLDS;
  const core3AttackBeats = new Set(core3Set.flatMap(index => lanes[index].metrics.attackBeats));
  const chord2Lanes = lanes.filter(other => assignment.get(other.id) === 'Chord2');
  const chord2Floor = chord2Lanes.length
    ? chord2Lanes.reduce((lowest, other) => Math.min(lowest, other.metrics.minPitch), Infinity)
    : null;
  const core3MaxDensity = core3Set.reduce((best, index) => {
    const other = lanes[index];
    const density = f(other.metrics.attackCount).div(f(other.metrics.soundingTime).cmp(ZERO) > 0 ? other.metrics.soundingTime : 1);
    return density.cmp(best) > 0 ? density : best;
  }, ZERO);

  const analyses = analysisPool.map(lane => {
    const laneIndex = laneIndexById.get(lane.id);
    const measured = enrichmentAgainstCore3(lane, laneIndex, intervals, core3Set);
    const independentAttacks = lane.metrics.attackBeats.filter(beat => !core3AttackBeats.has(beat)).length;

    const addedFunctions = [];
    if (essentialLaneIds.has(lane.id)) addedFunctions.push('essential-response');
    if (f(measured.addedPitchClassTime).cmp(ZERO) > 0) addedFunctions.push('inner-harmony');
    if (lane.metrics.attackCount > 0
      && ratioAtLeast(independentAttacks, lane.metrics.attackCount, t.counterLineMinIndependentAttackRatio)
      && lane.metrics.distinctPitches >= t.leadMinDistinctPitches) addedFunctions.push('counter-line');
    if (chord2Floor !== null && lane.metrics.minPitch <= chord2Floor) addedFunctions.push('secondary-bass-reinforcement');
    if (f(lane.metrics.meanSpan).cmp(t.sustainedTextureMinMeanSpan) >= 0) addedFunctions.push('sustained-texture');
    if (core3Set.length) {
      const ownDensity = f(lane.metrics.attackCount).div(f(lane.metrics.soundingTime).cmp(ZERO) > 0 ? lane.metrics.soundingTime : 1);
      if (ownDensity.cmp(core3MaxDensity.mul(t.rhythmicDetailDensityFactor)) >= 0) addedFunctions.push('rhythmic-detail');
    }

    const duplicationRatio = f(lane.metrics.soundingTime).cmp(ZERO) > 0
      ? key(f(measured.duplicatedPitchTime).div(lane.metrics.soundingTime))
      : '0';
    const duplicative = ratioAtLeast(measured.duplicatedPitchTime, lane.metrics.soundingTime, t.enrichmentDuplicationReviewRatio);
    const duplicationRisks = [];
    if (duplicative) duplicationRisks.push({
      code: 'DUPLICATES_CORE3_PITCHES',
      duplicatedPitchTime: measured.duplicatedPitchTime,
      soundingTime: lane.metrics.soundingTime,
      duplicationRatio,
      threshold: t.enrichmentDuplicationReviewRatio,
    });

    const functions = [...new Set(addedFunctions)].sort(cmpStr);
    const informative = functions.filter(name => name !== 'sustained-texture');
    return {
      lane,
      laneIndex,
      essential: essentialLaneIds.has(lane.id),
      addedFunctions: functions,
      duplicationRisks,
      duplicationRatio,
      addedPitchClassTime: measured.addedPitchClassTime,
      duplicatedPitchTime: measured.duplicatedPitchTime,
      sharedWindowTime: measured.sharedWindowTime,
      independentAttacks,
      useful: informative.length > 0 && !duplicative,
    };
  });

  // Deterministic enrichment ranking. Essential material first (it should have
  // been promoted already; anything left is a reportable problem, never a
  // silent one), then genuinely additive lanes, then the rest. Every term is an
  // exact rational, an integer, or a string id.
  const ranked = analyses.filter(analysis => !assignment.has(analysis.lane.id)).sort((a, b) =>
    Number(b.essential) - Number(a.essential)
    || Number(b.useful) - Number(a.useful)
    || f(a.duplicationRatio).cmp(b.duplicationRatio)
    || b.addedFunctions.length - a.addedFunctions.length
    || f(b.lane.metrics.soundingTime).cmp(a.lane.metrics.soundingTime)
    || f(b.lane.metrics.weightedPitch).cmp(a.lane.metrics.weightedPitch)
    || cmpStr(a.lane.id, b.lane.id));

  const taken = new Set(assignment.values());
  const freeSlots = ENRICHMENT_ROLE_NAMES.filter(role => !taken.has(role));
  const overflow = [];
  ranked.forEach((analysis, index) => {
    const role = freeSlots[index];
    if (!role) {
      overflow.push(analysis);
      return;
    }
    assignment.set(analysis.lane.id, role);
    state.noteEnrichmentReason?.(role, analysis);
  });

  return {
    essentialLaneIds: [...essentialLaneIds].sort(cmpStr),
    promotedToChord2: promoted.sort(cmpStr),
    gapsBefore,
    gapsAfter,
    supportGapsAfter,
    edgeWindows,
    core3Span,
    analyses,
    overflow,
  };
}

// ─── cross-role review signals ──────────────────────────────────────────────
//
// MASTER_RULES.md §6: these are arbitration inputs, never deletion targets.
// Nothing in this section removes, shortens, or re-pitches an event.

function pitchBuckets(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    if (!buckets.has(entry.pitch)) buckets.set(entry.pitch, []);
    buckets.get(entry.pitch).push(entry);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => cmpB(a.start, b.start) || cmpStr(a.eventId, b.eventId)));
}

function samePitchSignals(entries, instrumentation) {
  const simultaneous = [];
  const sustained = [];
  let inspections = 0;
  for (const bucket of pitchBuckets(entries)) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        inspections++;
        const a = bucket[i];
        const b = bucket[j];
        if (cmpB(b.start, a.end) >= 0) break;
        const pair = {
          pitch: a.pitch,
          eventIds: [a.eventId, b.eventId].sort(cmpStr),
          laneIds: [a.laneId, b.laneId].sort(cmpStr),
          roles: [...new Set([a.role, b.role].filter(role => role !== null))].sort(cmpStr),
          unassignedLaneInvolved: a.role === null || b.role === null,
          from: key(maxB(a.start, b.start)),
          to: key(minB(a.end, b.end)),
        };
        if (cmpB(a.start, b.start) === 0) simultaneous.push(pair);
        else sustained.push(pair);
      }
    }
  }
  if (instrumentation) instrumentation.samePitchInspections = inspections;
  const order = (a, b) => cmpB(a.from, b.from) || a.pitch - b.pitch || cmpStr(a.eventIds[0], b.eventIds[0]);
  return { simultaneous: simultaneous.sort(order), sustained: sustained.sort(order) };
}

function closeIntervalSignals(intervals, lanes, assignment, instrumentation) {
  const t = ROLE_CANDIDATE_THRESHOLDS;
  const widestInterval = Math.max(...t.closeIntervalSemitones);
  const found = new Map();
  let inspections = 0;
  for (const interval of intervals) {
    const active = [...interval.active].sort((a, b) => a.pitch - b.pitch || cmpStr(a.eventId, b.eventId));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        inspections++;
        const low = active[i];
        const high = active[j];
        const distance = high.pitch - low.pitch;
        if (distance > widestInterval) break;
        if (!t.closeIntervalSemitones.includes(distance)) continue;
        if (low.pitch >= t.closeIntervalMaxLowPitch) continue;
        const id = [low.eventId, high.eventId].sort(cmpStr).join('|');
        if (found.has(id)) continue;
        found.set(id, {
          semitones: distance,
          intervalName: distance === 1 ? 'm2' : distance === 11 ? 'M7' : 'm9',
          pitches: [low.pitch, high.pitch],
          eventIds: [low.eventId, high.eventId].sort(cmpStr),
          roles: [...new Set([assignment.get(lanes[low.laneIndex].id) ?? null, assignment.get(lanes[high.laneIndex].id) ?? null])]
            .filter(role => role !== null).sort(cmpStr),
          at: interval.start,
          threshold: { maxLowPitch: t.closeIntervalMaxLowPitch },
        });
      }
    }
  }
  if (instrumentation) instrumentation.closeIntervalInspections = inspections;
  return [...found.values()].sort((a, b) => cmpB(a.at, b.at) || a.pitches[0] - b.pitches[0] || cmpStr(a.eventIds[0], b.eventIds[0]));
}

function denseAttackSignals(entries) {
  const t = ROLE_CANDIDATE_THRESHOLDS;
  const beats = new Map();
  for (const entry of entries) {
    if (!entry.attack || entry.role === null) continue;
    if (!beats.has(entry.start)) beats.set(entry.start, { at: entry.start, roles: new Set(), eventIds: [] });
    const bucket = beats.get(entry.start);
    bucket.roles.add(entry.role);
    bucket.eventIds.push(entry.eventId);
  }
  return [...beats.values()]
    .filter(bucket => bucket.roles.size >= t.denseSimultaneousAttackRoles)
    .map(bucket => ({
      at: bucket.at,
      roleCount: bucket.roles.size,
      roles: [...bucket.roles].sort((a, b) => SIX_ROLES.indexOf(a) - SIX_ROLES.indexOf(b)),
      eventIds: [...new Set(bucket.eventIds)].sort(cmpStr),
      threshold: t.denseSimultaneousAttackRoles,
      justificationRequired: true,
    }))
    .sort((a, b) => cmpB(a.at, b.at));
}

// Concurrent harmony/inner siblings left outside Core3.
//
// A silence gap is one way to prove a lane is essential; it is not the
// definition of essential inner support. A polyphonic accompaniment source voice
// decomposes into several simultaneous G11-B lanes: one may be selected into
// Core3 while a sibling of the *same source voice*, sounding at the same time,
// is left outside. Core3 never falls silent, so no gap analysis sees it -- and
// yet that sibling may carry harmonic identity a complete one-player
// arrangement needs (MASTER_RULES.md §5, ACCEPTANCE_CRITERIA.md Gate 4).
//
// Absence of evidence that the sibling is essential is NOT evidence that it is
// optional, so this is reported as unresolved rather than decided either way.
// It is an uncertainty interlock, not an assignment rule: the sibling is not
// moved, merged or deleted, and it is not forced into Chord2. Only positive
// evidence -- a declared source role or a cited trusted symbolic role naming an
// enrichment role -- establishes it as optional and clears the blocker.
function unresolvedHarmonySiblings(lanes, assignment, pendingLaneIds) {
  const core3ByVoice = new Map();
  for (const lane of lanes) {
    if (!CORE3_ROLE_NAMES.includes(assignment.get(lane.id))) continue;
    const voiceKey = String(lane.sourceVoice ?? 'voice:null');
    if (!core3ByVoice.has(voiceKey)) core3ByVoice.set(voiceKey, []);
    core3ByVoice.get(voiceKey).push(lane);
  }

  const unresolved = [];
  for (const lane of lanes) {
    const role = assignment.get(lane.id) ?? null;
    if (CORE3_ROLE_NAMES.includes(role)) continue;
    // A lane already blocking the candidate needs no second blocker.
    if (pendingLaneIds.has(lane.id)) continue;

    const siblings = (core3ByVoice.get(String(lane.sourceVoice ?? 'voice:null')) ?? [])
      .filter(sibling => lanesOverlap(sibling, lane));
    if (!siblings.length) continue;

    const optionalEvidence = ENRICHMENT_ROLE_NAMES
      .filter(enrichmentRole => lane.roleSupport[enrichmentRole].tier === 1)
      .flatMap(enrichmentRole => lane.roleSupport[enrichmentRole].evidenceIds);
    if (optionalEvidence.length) continue;

    unresolved.push({
      laneId: lane.id,
      sourceVoice: lane.sourceVoice,
      candidateRole: role,
      core3SiblingLaneIds: siblings.map(sibling => sibling.id).sort(cmpStr),
      core3SiblingRoles: [...new Set(siblings.map(sibling => assignment.get(sibling.id)))]
        .sort((a, b) => SIX_ROLES.indexOf(a) - SIX_ROLES.indexOf(b)),
      eventIds: [...lane.eventIds],
      blocker: 'UNRESOLVED_CORE_HARMONY_SIBLING',
      resolvedBy: 'A declared source role or a cited trusted symbolic role naming Chord3, Chord4 or Chord5 for this lane.',
      notice: 'Sounds concurrently with Core3 material from the same source voice and is outside Core3. Nothing establishes it as optional enrichment, so Core3 completeness stays unresolved. The lane is preserved and is not moved into Chord2.',
    });
  }
  return unresolved.sort((a, b) => cmpStr(a.laneId, b.laneId));
}

// ─── Core3 completeness ─────────────────────────────────────────────────────
//
// ACCEPTANCE_CRITERIA.md Gate 4. Three non-empty roles is NOT completeness:
// each of the four musical functions has to be positively evidenced, and Core3
// has to remain intelligible when Chord3-Chord5 are removed.

function evaluateCore3(context) {
  const { lanes, assignment, roleMeta, classification, pendingLanes, allNotes } = context;
  const laneById = new Map(lanes.map(lane => [lane.id, lane]));
  const lanesFor = role => lanes.filter(lane => assignment.get(lane.id) === role);
  const idsFor = role => lanesFor(role).flatMap(lane => lane.eventIds).sort(cmpStr);

  const melodyLanes = lanesFor('Melody');
  const chord1Lanes = lanesFor('Chord1');
  const chord2Lanes = lanesFor('Chord2');
  const melodyMeta = roleMeta.get('Melody') ?? { status: 'EMPTY', reasons: [] };
  const chord1Meta = roleMeta.get('Chord1') ?? { status: 'EMPTY', reasons: [] };
  const chord2Meta = roleMeta.get('Chord2') ?? { status: 'EMPTY', reasons: [] };

  const silenceJunctions = melodyLanes.flatMap(lane => lane.junctions
    .filter(junction => junction.silence)
    .map(junction => ({ laneId: lane.id, from: junction.from, to: junction.to })));

  const leadContinuity = {
    satisfied: melodyMeta.status === 'ASSIGNED' && melodyLanes.length > 0,
    status: melodyMeta.status === 'PENDING' ? 'PENDING' : melodyLanes.length ? 'PRESENT' : 'ABSENT',
    laneIds: melodyLanes.map(lane => lane.id).sort(cmpStr),
    evidenceTier: melodyMeta.tier ?? null,
    evidenceTierName: melodyMeta.tierName ?? null,
    handOffLaneCount: melodyLanes.length,
    sourceSupportedHandOff: melodyLanes.length > 1,
    silenceJunctions,
    continuousAcrossSilence: silenceJunctions.length === 0 ? null : false,
    notice: 'Lead continuity is source-relative. Lanes packed around a silence are not asserted to be one continuous voice, and a vocal rest is never a Lead gap.',
  };

  const bassLanes = chord2Lanes.filter(lane => lane.roleSupport.Chord2.tier !== null);
  const bassSkeleton = {
    satisfied: chord2Meta.status !== 'PENDING' && bassLanes.length > 0,
    status: chord2Meta.status === 'PENDING' ? 'PENDING' : bassLanes.length ? 'PRESENT' : 'ABSENT',
    laneIds: bassLanes.map(lane => lane.id).sort(cmpStr),
    measurement: bassLanes.map(lane => ({
      laneId: lane.id,
      timeAsLowestSoundingPitch: lane.floorTime,
      soundingTime: lane.metrics.soundingTime,
      minPitch: lane.metrics.minPitch,
    })),
    notice: 'Bass function is measured over the sounding grid. Chord2 is never hardened into Bass-only.',
  };

  // Having a Chord1 candidate is not the same as having established principal
  // harmony. Only a declared source role or a cited trusted symbolic role does
  // that; a coverage/attack ranking picks the best available candidate and says
  // so. `CANDIDATE_ONLY` keeps the proposal useful without overclaiming.
  const chord1PositivelyEvidenced = chord1Lanes.length > 0
    && chord1Lanes.every(lane => lane.roleSupport.Chord1.tier === 1);
  const principalHarmony = {
    satisfied: chord1Meta.status === 'ASSIGNED' && chord1PositivelyEvidenced,
    status: chord1Meta.status === 'PENDING' ? 'PENDING'
      : !chord1Lanes.length ? 'ABSENT'
        : chord1PositivelyEvidenced ? 'PRESENT' : 'CANDIDATE_ONLY',
    evidenceStrength: chord1Lanes.length ? (chord1PositivelyEvidenced ? 'POSITIVE' : 'HEURISTIC_CANDIDATE') : 'NONE',
    laneIds: chord1Lanes.map(lane => lane.id).sort(cmpStr),
    unevidencedLaneIds: chord1Lanes.filter(lane => lane.roleSupport.Chord1.tier !== 1)
      .map(lane => lane.id).sort(cmpStr),
    evidenceTier: chord1Meta.tier ?? null,
    evidenceTierName: chord1Meta.tierName ?? null,
    measurement: context.chord1Measurement ?? null,
    notice: 'Total sounding time, attack count, register and density rank Chord1 candidates. They never, on their own, establish that a source voice is the principal harmony (MASTER_RULES.md §5, ACCEPTANCE_CRITERIA.md Gate 4).',
  };

  const misplacedEssential = classification.essentialLaneIds.filter(laneId => {
    const role = assignment.get(laneId) ?? null;
    return role === null || !CORE3_ROLE_NAMES.includes(role);
  }).sort(cmpStr);
  const essentialEventIds = [...new Set(classification.essentialLaneIds
    .flatMap(laneId => laneById.get(laneId)?.eventIds ?? []))].sort(cmpStr);

  const unresolvedSiblings = context.unresolvedSiblings ?? [];
  const unresolvedSiblingLaneIds = unresolvedSiblings.map(item => item.laneId);

  // Two separate questions, deliberately not collapsed into one slot:
  //   * essentialInnerSupport - is material we have *proven* essential inside
  //     Core3? Proven by the silence-gap test.
  //   * concurrentHarmonyResolution - is there material we can prove neither
  //     essential nor optional? Unresolved is not a synonym for either.
  const essentialInnerSupport = {
    satisfied: misplacedEssential.length === 0,
    status: misplacedEssential.length ? 'MISPLACED' : classification.promotedToChord2.length ? 'PRESENT' : 'NOT_REQUIRED',
    essentialLaneIds: [...classification.essentialLaneIds],
    promotedToChord2: [...classification.promotedToChord2],
    misplacedLaneIds: misplacedEssential,
    notice: 'A lane sounding while Core3 is silent is proven essential and belongs to Core3 (MASTER_RULES.md §5). That silence-gap test is one positive route to essentiality, not the definition of it.',
  };

  const concurrentHarmonyResolution = {
    satisfied: unresolvedSiblings.length === 0,
    status: unresolvedSiblings.length ? 'UNRESOLVED' : 'RESOLVED',
    unresolvedLaneIds: [...unresolvedSiblingLaneIds],
    notice: 'Material from a Core3 source voice that sounds concurrently with Core3 and sits outside it. Core3 never falls silent there, so the silence-gap test cannot reach it. Absence of evidence that it is essential is not evidence that it is optional, so Core3 completeness stays unresolved until a declared or cited source role settles it.',
  };

  const core3EventIds = [...new Set(CORE3_ROLE_NAMES.flatMap(idsFor))].sort(cmpStr);
  const sourceCoverage = {
    core3EventCount: core3EventIds.length,
    sourceEventCount: allNotes.length,
    core3EventIds,
    core3Span: classification.core3Span,
    uncoveredSoundingWindows: classification.gapsAfter,
    unaccompaniedSoundingWindows: classification.supportGapsAfter,
    outsideCore3SpanWindows: classification.edgeWindows,
    outsideSpanNotice: 'Windows outside the Core3 span are an end-time question (PENDING.md P14), not evidence of missing essential material. Meaningful silence is never padded to force numeric equality.',
    notice: 'Coverage is diagnostic, never an optimization target (ACCEPTANCE_CRITERIA.md Gate 4). A true source rest is not a gap; these windows are reported, never filled.',
  };

  const functions = { leadContinuity, principalHarmony, bassSkeleton, essentialInnerSupport, concurrentHarmonyResolution };

  // `missingFunctions` keeps its checkpoint-1 meaning: every Core3 function that
  // is not satisfied. It is then split by *why*. A function positively absent
  // from the candidate is a deficiency (INCOMPLETE); a function that merely
  // cannot be proven from the available evidence is unresolved (PENDING).
  // Collapsing the two would let "we could not tell" read as a verdict.
  const unproven = new Set(['PENDING', 'CANDIDATE_ONLY', 'UNRESOLVED']);
  const missingFunctions = [];
  const unprovenFunctions = [];
  const absentFunctions = [];
  for (const [name, entry] of [
    ['lead-continuity', leadContinuity],
    ['principal-harmony', principalHarmony],
    ['bass-skeleton', bassSkeleton],
    ['essential-inner-support', essentialInnerSupport],
    ['concurrent-harmony-resolution', concurrentHarmonyResolution],
  ]) {
    if (entry.satisfied) continue;
    missingFunctions.push(name);
    (unproven.has(entry.status) ? unprovenFunctions : absentFunctions).push(name);
  }

  const conflicts = [];
  for (const role of CORE3_ROLE_NAMES) {
    const entry = roleMeta.get(role);
    if (entry?.competingLaneIds?.length) conflicts.push({ role, code: entry.reasons.at(-1) ?? 'COMPETING_CANDIDATES', laneIds: [...entry.competingLaneIds] });
  }
  if (misplacedEssential.length) conflicts.push({ role: 'Chord2', code: 'ESSENTIAL_MATERIAL_OUTSIDE_CORE3', laneIds: misplacedEssential });
  if (unresolvedSiblings.length) conflicts.push({
    role: 'Chord1',
    code: 'UNRESOLVED_CORE_HARMONY_SIBLING',
    laneIds: [...unresolvedSiblingLaneIds],
  });

  const pending = pendingLanes
    .filter(item => CORE3_ROLE_NAMES.includes(item.proposedRole))
    .map(item => ({ ...item, eventIds: laneById.get(item.laneId)?.eventIds ?? [] }))
    .sort((a, b) => cmpStr(a.laneId, b.laneId));

  const decisionsOpen = pending.length > 0
    || CORE3_ROLE_NAMES.some(role => (roleMeta.get(role)?.status ?? 'EMPTY') === 'PENDING');
  const identityDependsOnEnrichment = misplacedEssential.length > 0;
  const identityMayDependOnEnrichment = unresolvedSiblings.length > 0;

  // A function is only *proven* absent while no role decision is still open:
  // Chord1 can read as empty simply because both of its candidates are locked in
  // an unresolved Lead contest, and calling that a deficiency would report a
  // verdict we have not earned.
  const provenAbsent = decisionsOpen ? [] : absentFunctions;

  // Fail closed. COMPLETE requires Lead continuity, positively supported
  // principal harmony, a measured or declared bass skeleton, every known
  // essential lane inside Core3, no unresolved possible-essential material, and
  // no open role conflict. Anything short of that is PENDING or INCOMPLETE.
  let status;
  if (identityDependsOnEnrichment || provenAbsent.length) status = 'INCOMPLETE';
  else if (decisionsOpen || unprovenFunctions.length || absentFunctions.length || identityMayDependOnEnrichment) status = 'PENDING';
  else status = 'COMPLETE';

  const rationale = [];
  rationale.push({
    code: 'CORE3_EVALUATED_INDEPENDENTLY_OF_FULL6',
    detail: 'Melody + Chord1 + Chord2 were evaluated as a standalone three-role candidate. Chord3-Chord5 contribute nothing to this verdict.',
  });
  rationale.push({
    code: leadContinuity.satisfied ? 'LEAD_CONTINUITY_SOURCE_SUPPORTED' : 'LEAD_CONTINUITY_UNRESOLVED',
    detail: leadContinuity.satisfied
      ? `Melody carries ${leadContinuity.laneIds.length} source-supported lane(s) at evidence tier ${leadContinuity.evidenceTierName ?? leadContinuity.evidenceTier}.`
      : `Melody is ${leadContinuity.status}: ${(melodyMeta.reasons ?? []).join(', ') || 'no lead evidence'}.`,
    laneIds: leadContinuity.laneIds,
  });
  rationale.push({
    code: principalHarmony.satisfied ? 'PRINCIPAL_HARMONY_PRESENT'
      : principalHarmony.status === 'CANDIDATE_ONLY' ? 'PRINCIPAL_HARMONY_CANDIDATE_ONLY'
        : 'PRINCIPAL_HARMONY_MISSING',
    detail: principalHarmony.satisfied
      ? 'Chord1 supplies the principal accompaniment / essential response, positively evidenced by a declared or cited source role.'
      : principalHarmony.status === 'CANDIDATE_ONLY'
        ? 'Chord1 holds the best available candidate, ranked by source-supported coverage. Coverage, attack count, register and density do not establish principal harmony, so the function stays unresolved rather than satisfied.'
        : `Chord1 is ${principalHarmony.status}: ${(chord1Meta.reasons ?? []).join(', ') || 'no harmony candidate'}.`,
    laneIds: principalHarmony.laneIds,
  });
  rationale.push({
    code: bassSkeleton.satisfied ? 'BASS_SKELETON_PRESENT' : 'BASS_SKELETON_MISSING',
    detail: bassSkeleton.satisfied
      ? 'Chord2 carries a measured harmonic-floor lane as the bass skeleton.'
      : `Chord2 has no lane with bass-function evidence: ${(chord2Meta.reasons ?? []).join(', ') || 'none'}.`,
    laneIds: bassSkeleton.laneIds,
  });
  rationale.push({
    code: essentialInnerSupport.satisfied
      ? (classification.promotedToChord2.length ? 'ESSENTIAL_INNER_SUPPORT_IN_CHORD2' : 'NO_ESSENTIAL_INNER_SUPPORT_REQUIRED')
      : 'ESSENTIAL_MATERIAL_OUTSIDE_CORE3',
    detail: essentialInnerSupport.satisfied
      ? (classification.promotedToChord2.length
        ? 'Lanes that sound while Core3 would otherwise be silent were added to Chord2 as essential inner support.'
        : 'No source material sounds while Core3 is silent, so no essential inner support is required.')
      : 'Material that sounds while Core3 is silent is currently outside Core3. Core3 cannot be reported complete while its musical identity depends on Chord3-Chord5 or on unassigned material.',
    laneIds: essentialInnerSupport.misplacedLaneIds,
  });
  if (unresolvedSiblings.length) rationale.push({
    code: 'UNRESOLVED_CORE_HARMONY_SIBLING',
    detail: 'Material from a source voice that also supplies Core3 sounds concurrently with it and sits outside Core3. Core3 never falls silent there, so no gap analysis reaches it, and nothing establishes the material as optional enrichment. Core3 completeness stays unresolved; the lanes are preserved and are not moved into Chord2.',
    laneIds: [...unresolvedSiblingLaneIds],
  });
  if (classification.gapsAfter.length) rationale.push({
    code: 'CORE3_SILENT_WHILE_SOURCE_SOUNDS',
    detail: 'There are windows where the source sounds and no Core3 role does. These are reported, never filled with invented material.',
    windows: classification.gapsAfter,
  });

  return Object.freeze({
    status,
    canonicallyCompleteGate: 'CORE3',
    functions: Object.freeze(functions),
    rationale: Object.freeze(rationale),
    essentialEventIds: Object.freeze(essentialEventIds),
    sourceCoverage: Object.freeze(sourceCoverage),
    identityDependsOnEnrichment,
    identityMayDependOnEnrichment,
    missingFunctions: Object.freeze(missingFunctions),
    absentFunctions: Object.freeze(absentFunctions),
    absenceProven: !decisionsOpen,
    unprovenFunctions: Object.freeze(unprovenFunctions),
    unresolvedHarmony: Object.freeze(unresolvedSiblings.map(item => Object.freeze({
      ...item,
      core3SiblingLaneIds: Object.freeze([...item.core3SiblingLaneIds]),
      core3SiblingRoles: Object.freeze([...item.core3SiblingRoles]),
      eventIds: Object.freeze([...item.eventIds]),
    }))),
    conflicts: Object.freeze(conflicts),
    pending: Object.freeze(pending),
    notice: 'Core3 completeness requires evidenced musical function. Three non-empty roles are never sufficient, and this is a candidate-stage reading, not ACCEPTANCE_CRITERIA.md Gate 4 acceptance.',
  });
}

// ─── Full6 enrichment ───────────────────────────────────────────────────────
//
// ACCEPTANCE_CRITERIA.md Gate 5: Chord3-Chord5 must enrich rather than damage
// Core3. Enrichment is reported separately from Core3 on purpose — an extra
// role must never be able to pay for a weaker Core3.

function evaluateFull6(context) {
  const { lanes, assignment, classification, core3 } = context;
  const byLaneId = new Map(classification.analyses.map(analysis => [analysis.lane.id, analysis]));
  const unresolvedLaneIds = new Set((context.unresolvedSiblings ?? []).map(item => item.laneId));

  const roleContributions = {};
  const rationale = [];
  const duplicationRisks = [];
  const addedFunctions = new Set();

  for (const role of ENRICHMENT_ROLE_NAMES) {
    const roleLanes = lanes.filter(lane => assignment.get(lane.id) === role);
    if (!roleLanes.length) {
      roleContributions[role] = Object.freeze({ role, status: 'EMPTY', laneIds: Object.freeze([]), addedFunctions: Object.freeze([]) });
      continue;
    }
    const entries = roleLanes.map(lane => {
      const analysis = byLaneId.get(lane.id);
      const functions = analysis?.addedFunctions ?? [];
      for (const name of functions) addedFunctions.add(name);
      for (const risk of analysis?.duplicationRisks ?? []) duplicationRisks.push({ role, laneId: lane.id, ...risk });
      const unresolved = unresolvedLaneIds.has(lane.id);
      const essential = analysis?.essential ?? false;
      // Enrichment means optional-but-useful *after* Core3 integrity. A lane
      // Core3 may actually require is never reported as harmless: `useful` is
      // withheld while the dependency is unresolved, and the tri-state below
      // keeps "not established as intact" distinct from "proven to break Core3".
      const entry = {
        role,
        laneId: lane.id,
        sourceVoice: lane.sourceVoice,
        eventIds: lane.eventIds,
        addedFunctions: functions,
        useful: (analysis?.useful ?? false) && !unresolved && !essential,
        essential,
        core3DependencyUnresolved: unresolved,
        core3IntegrityIfRemoved: essential ? 'DEPENDS' : unresolved ? 'UNRESOLVED' : 'INTACT',
        duplicationRisks: analysis?.duplicationRisks ?? [],
        duplicationRatio: analysis?.duplicationRatio ?? '0',
        measurement: {
          addedPitchClassTime: analysis?.addedPitchClassTime ?? '0',
          duplicatedPitchTime: analysis?.duplicatedPitchTime ?? '0',
          sharedWindowTime: analysis?.sharedWindowTime ?? '0',
          soundingTime: lane.metrics.soundingTime,
          attackCount: lane.metrics.attackCount,
          independentAttacks: analysis?.independentAttacks ?? 0,
        },
        // An enrichment lane that is essential is precisely the failure Gate 4
        // guards against: removing it would take musical identity with it. An
        // unresolved one is not established as safe to remove either, so this
        // stays false there too -- it asserts "established intact", nothing less.
        removingLeavesCore3Intact: !essential && !unresolved,
      };
      rationale.push(entry);
      return entry;
    });
    roleContributions[role] = Object.freeze({
      role,
      status: entries.some(entry => entry.essential) ? 'ESSENTIAL_MATERIAL_MISPLACED'
        : entries.some(entry => entry.core3DependencyUnresolved) ? 'CORE3_DEPENDENCY_UNRESOLVED'
          : entries.some(entry => entry.useful) ? 'USEFUL' : 'REVIEW',
      laneIds: Object.freeze(roleLanes.map(lane => lane.id).sort(cmpStr)),
      addedFunctions: Object.freeze([...new Set(entries.flatMap(entry => entry.addedFunctions))].sort(cmpStr)),
      entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
    });
  }

  const used = ENRICHMENT_ROLE_NAMES.filter(role => roleContributions[role].status !== 'EMPTY');
  const conflictSignals = context.enrichmentConflictSignals;
  let status;
  if (!used.length) status = 'NONE';
  else if (used.some(role => ['ESSENTIAL_MATERIAL_MISPLACED', 'CORE3_DEPENDENCY_UNRESOLVED'].includes(roleContributions[role].status))) status = 'CORE3_DEPENDENCY';
  else if (core3.status === 'PENDING') status = 'PENDING';
  else if (used.every(role => roleContributions[role].status === 'USEFUL') && !duplicationRisks.length) status = 'USEFUL';
  else status = 'REVIEW';

  return Object.freeze({
    status,
    rolesUsed: Object.freeze(used),
    roleContributions: Object.freeze(roleContributions),
    enrichmentRationale: Object.freeze(rationale.sort((a, b) =>
      SIX_ROLES.indexOf(a.role) - SIX_ROLES.indexOf(b.role) || cmpStr(a.laneId, b.laneId))),
    addedFunctions: Object.freeze([...addedFunctions].sort(cmpStr)),
    duplicationRisks: Object.freeze(duplicationRisks.sort((a, b) => cmpStr(a.laneId, b.laneId) || cmpStr(a.code, b.code))),
    conflictSignals: Object.freeze(conflictSignals),
    core3DependencyLaneIds: Object.freeze([...unresolvedLaneIds].sort(cmpStr)),
    pending: Object.freeze(context.pendingLanes
      .filter(item => ENRICHMENT_ROLE_NAMES.includes(item.proposedRole))
      .sort((a, b) => cmpStr(a.laneId, b.laneId))),
    notice: 'Full6 enrichment is reported separately from Core3. Chord3-Chord5 may not be used to hide an incomplete or unresolved Core3, and a non-empty enrichment role is not by itself a benefit. Enrichment means optional-but-useful after Core3 integrity, never material Core3 may still require.',
  });
}

// ─── reduced-role diagnostics ───────────────────────────────────────────────
//
// PENDING.md P17: one-role and two-role completeness are NOT formalized by
// Published Canonical. These numbers exist so a later performance-allocation
// stage has something to read; they are explicitly not a completeness gate,
// and nothing here may be reported as Canonically complete.
function reducedRoleDiagnostics(core3) {
  const priority = ['Melody', 'Chord1', 'Chord2'];
  const present = new Map([
    ['Melody', core3.functions.leadContinuity.satisfied],
    ['Chord1', core3.functions.principalHarmony.satisfied],
    ['Chord2', core3.functions.bassSkeleton.satisfied],
  ]);
  const functionOf = {
    Melody: 'lead-continuity',
    Chord1: 'principal-harmony',
    Chord2: 'bass-skeleton-and-essential-inner-support',
  };
  const tiers = [1, 2].map(count => {
    const kept = priority.slice(0, count);
    const dropped = priority.slice(count);
    return Object.freeze({
      roleCount: count,
      rolePriority: Object.freeze(kept),
      missingFunctions: Object.freeze(dropped.map(role => functionOf[role])),
      keptFunctionsPresent: Object.freeze(kept.filter(role => present.get(role)).map(role => functionOf[role])),
      canonicalCompleteness: 'NOT_DEFINED',
      pendingReference: 'PENDING.md P17',
    });
  });
  return Object.freeze({
    notice: 'Diagnostic only. Published Canonical defines Core3 (Melody + Chord1 + Chord2) as the single-player three-role target; one-role and two-role completeness remain unresolved under PENDING.md P17 and are never reported as complete here.',
    canonicalCompletenessGate: 'CORE3',
    rolePriority: Object.freeze(priority),
    tiers: Object.freeze(tiers),
  });
}

// ─── entry point ────────────────────────────────────────────────────────────

const decisionFor = (sourceRole, candidateRole) => {
  if (candidateRole === null) return ROLE_DECISIONS.OMIT_FROM_SIX;
  if (sourceRole === null) return ROLE_DECISIONS.ASSIGN_ROLE;
  return sourceRole === candidateRole ? ROLE_DECISIONS.KEEP_ROLE : ROLE_DECISIONS.MOVE_ROLE;
};

/**
 * Suggest a traceable six-role candidate arrangement.
 *
 * Consumes the G11-A Source-Faithful Canonical baseline and the G11-B lossless
 * lane decomposition of it, and produces role *candidates*: an assignment, an
 * event-level decision ledger, separate Core3 and Full6 readings, cross-role
 * review signals, and an exact coverage audit.
 *
 * It never emits Final MML, never adapts for Mobile, never changes a pitch,
 * onset, duration or prominence, and never deletes a source event.
 */
export function suggestRoleCandidates(project, options = {}) {
  const instrumentation = options.instrumentation ?? null;
  const { notes, unsupported } = normalizeProject(project);
  const noteById = new Map(notes.map(note => [note.id, note]));

  const decompositions = options.decompositions
    ?? splitProjectSourceVoices({ ...project, events: notes });
  if (!Array.isArray(decompositions)) throw Error('options.decompositions must be an array of G11-B decomposition results');

  const lanes = buildLanes(decompositions, noteById);
  const laneIds = new Set(lanes.map(lane => lane.id));
  const pinned = normalizeRoleOverrides(options.roleOverrides, laneIds);
  const duplications = normalizeDuplications(options.duplications, laneIds);
  const roleEvidence = normalizeRoleEvidence(options.sourceRoleEvidence);
  const sections = normalizeSections(options.sections);

  for (const lane of lanes) lane.metrics = laneMetrics(lane);
  const intervals = buildGrid(lanes, instrumentation);
  const floors = floorTimes(lanes, intervals);
  const shared = sharedOnsetCounts(lanes);
  lanes.forEach((lane, index) => {
    lane.floorTime = floors[index];
    lane.sharedOnsets = shared[index];
    lane.intervals = mergedIntervals(lane);
  });

  const registerRank = new Map([...lanes]
    .sort((a, b) => f(b.metrics.weightedPitch).cmp(a.metrics.weightedPitch) || cmpStr(a.id, b.id))
    .map((lane, index) => [lane.id, index]));
  const evidenceContext = { noteById, roleEvidence, sections, registerRank, laneCount: lanes.length };
  for (const lane of lanes) {
    const evidence = buildLaneEvidence(lane, evidenceContext);
    lane.evidence = evidence.records;
    lane.roleSupport = roleSupport(lane, evidence);
  }

  const state = { lanes, intervals, pinned, duplications };
  const { assignment, roleMeta, pendingLanes } = assignRoles(state);
  // Enrichment slots are filled after Core3 is known, so their reasons are
  // recorded from there rather than in the Core3 selection pass.
  state.noteEnrichmentReason = (role, analysis) => {
    const current = roleMeta.get(role) ?? { status: 'EMPTY', tier: null, tierName: null, reasons: [], competingLaneIds: [], evidenceIds: [] };
    const reasons = analysis.essential
      ? ['ESSENTIAL_MATERIAL_PINNED_OUTSIDE_CORE3']
      : analysis.useful
        ? ['FULL6_ENRICHMENT_SELECTED', ...analysis.addedFunctions.map(name => `ADDS:${name}`)]
        : ['FULL6_ENRICHMENT_LOW_VALUE_REVIEW'];
    roleMeta.set(role, {
      ...current,
      status: 'ASSIGNED',
      tierName: current.tierName ?? 'FULL6_ENRICHMENT_RANK',
      reasons: [...current.reasons, ...reasons],
    });
  };

  // Lead-demotion interlock, as an invariant guard. Caller pins are refused
  // inside `assignRoles` before anything is selected; this catches any other
  // route by which a declared source Lead could end up off Melody, and leaves
  // the decision PENDING rather than performing a silent demotion
  // (MASTER_RULES.md §4, SOURCE_POLICY.md §4).
  const alreadyPending = new Set(pendingLanes.map(item => item.laneId));
  for (const lane of lanes) {
    if (!lane.sourceRoles.includes('Melody')) continue;
    if (alreadyPending.has(lane.id)) continue;
    const role = assignment.get(lane.id) ?? null;
    if (role === 'Melody') continue;
    assignment.delete(lane.id);
    pendingLanes.push({
      laneId: lane.id,
      proposedRole: role,
      blockers: ['LEAD_DEMOTION_NOT_EVALUATED'],
      competingLaneIds: [],
      evidenceIds: lane.roleSupport.Melody.evidenceIds,
      gate: 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion',
    });
  }
  const pendingLaneIds = new Set(pendingLanes.map(item => item.laneId));

  const classification = classifyRemaining(state, assignment, pendingLaneIds);

  // ── buckets: every lane lands in exactly one ──
  const overflowLaneIds = new Set(classification.overflow.map(analysis => analysis.lane.id));
  const excludedLaneIds = new Set([...pinned.entries()].filter(([, role]) => role === null).map(([laneId]) => laneId));
  const duplicationByLane = new Map(duplications.map(item => [item.laneId, item]));

  const entries = [];
  const ledger = [];
  const unassigned = [];
  const pendingByLane = new Map(pendingLanes.map(item => [item.laneId, item]));
  const analysisByLane = new Map(classification.analyses.map(item => [item.lane.id, item]));
  const laneById = new Map(lanes.map(lane => [lane.id, lane]));

  for (const [laneIndex, lane] of lanes.entries()) {
    const role = assignment.get(lane.id) ?? null;
    const pendingEntry = pendingByLane.get(lane.id) ?? null;
    const duplication = duplicationByLane.get(lane.id) ?? null;
    const analysis = analysisByLane.get(lane.id) ?? null;

    for (const span of lane.spans) {
      entries.push({
        eventId: span.eventId,
        laneId: lane.id,
        laneIndex,
        pitch: span.pitch,
        start: key(span.start),
        end: key(span.end),
        attack: isAttack(span),
        role,
      });
    }

    for (const eventId of lane.eventIds) {
      const note = noteById.get(eventId);
      const sourceRole = note?.role ?? null;
      const base = {
        eventId,
        laneId: lane.id,
        sourceVoice: lane.sourceVoice,
        sourceIds: [...(note?.sourceIds ?? [])],
        sourceEventIds: [...(note?.sourceEventIds ?? [])],
        // The Source-Faithful values, restated so the ledger itself proves the
        // candidate changed none of them.
        sourcePitch: note?.pitch ?? null,
        sourceStart: note ? key(note.start) : null,
        sourceEnd: note ? key(note.end) : null,
        sourceRole,
      };

      if (pendingEntry) {
        ledger.push({
          ...base,
          candidateRole: null,
          proposedRole: pendingEntry.proposedRole ?? null,
          decision: ROLE_DECISIONS.PENDING,
          reason: pendingEntry.blockers.join('+'),
          evidenceIds: [...pendingEntry.evidenceIds].sort(cmpStr),
          competingLaneIds: [...pendingEntry.competingLaneIds],
          uncertainty: 'PENDING',
          selected: false,
          duplicate: false,
          provisional: true,
        });
        continue;
      }

      if (duplication) {
        for (const duplicateRole of duplication.roles) {
          ledger.push({
            ...base,
            candidateRole: duplicateRole,
            proposedRole: duplicateRole,
            decision: ROLE_DECISIONS.DUPLICATE_WITH_JUSTIFICATION,
            reason: duplication.reason,
            evidenceIds: [...duplication.evidence],
            competingLaneIds: [],
            uncertainty: 'DECLARED_DUPLICATION',
            selected: true,
            duplicate: true,
            provisional: false,
          });
        }
        continue;
      }

      if (role === null) {
        const reason = excludedLaneIds.has(lane.id) ? 'CALLER_EXCLUDED_FROM_SIX'
          : overflowLaneIds.has(lane.id) ? 'SIX_ROLE_CAPACITY_EXCEEDED'
            : 'NO_ROLE_EVIDENCE';
        ledger.push({
          ...base,
          candidateRole: null,
          proposedRole: analysis?.addedFunctions.length ? ENRICHMENT_ROLE_NAMES[0] : null,
          decision: ROLE_DECISIONS.OMIT_FROM_SIX,
          reason,
          evidenceIds: lane.evidence.filter(record => record.strength === 'primary').map(record => record.id),
          competingLaneIds: [],
          uncertainty: 'PROVISIONAL',
          selected: false,
          duplicate: false,
          provisional: true,
        });
        continue;
      }

      ledger.push({
        ...base,
        candidateRole: role,
        proposedRole: role,
        decision: decisionFor(sourceRole, role),
        reason: (roleMeta.get(role)?.reasons ?? []).join('+') || 'ROLE_ASSIGNED',
        evidenceIds: [...(lane.roleSupport[role]?.evidenceIds ?? [])].sort(cmpStr),
        competingLaneIds: [],
        uncertainty: 'NONE',
        selected: true,
        duplicate: false,
        provisional: false,
      });
    }

    if (role === null && !pendingEntry && !duplication) {
      unassigned.push(Object.freeze({
        laneId: lane.id,
        sourceVoice: lane.sourceVoice,
        eventIds: Object.freeze([...lane.eventIds]),
        sourceEventIds: Object.freeze([...lane.sourceEventIds]),
        reason: excludedLaneIds.has(lane.id) ? 'CALLER_EXCLUDED_FROM_SIX'
          : overflowLaneIds.has(lane.id) ? 'SIX_ROLE_CAPACITY_EXCEEDED' : 'NO_ROLE_EVIDENCE',
        competingRole: analysis?.addedFunctions.length ? ENRICHMENT_ROLE_NAMES[0] : null,
        addedFunctions: Object.freeze([...(analysis?.addedFunctions ?? [])]),
        essential: analysis?.essential ?? false,
        provisional: true,
        evidenceIds: Object.freeze(lane.evidence.filter(record => record.strength === 'primary').map(record => record.id)),
        notice: 'Not selected into this six-role proposal. The source events remain intact and identifiable; omission is provisional and reversible.',
      }));
    }
  }

  ledger.sort((a, b) => cmpStr(a.eventId, b.eventId)
    || SIX_ROLES.indexOf(a.candidateRole ?? '') - SIX_ROLES.indexOf(b.candidateRole ?? '')
    || cmpStr(a.decision, b.decision));
  unassigned.sort((a, b) => cmpStr(a.laneId, b.laneId));

  // ── roles view ──
  const roles = {};
  for (const role of SIX_ROLES) {
    const roleLanes = lanes.filter(lane => assignment.get(lane.id) === role);
    const meta = roleMeta.get(role) ?? { status: roleLanes.length ? 'ASSIGNED' : 'EMPTY', tier: null, tierName: null, reasons: [], competingLaneIds: [], evidenceIds: [] };
    const duplicatedIn = duplications.filter(item => item.roles.includes(role));
    roles[role] = Object.freeze({
      role,
      group: CORE3_ROLE_NAMES.includes(role) ? 'core3' : 'full6',
      status: roleLanes.length ? 'ASSIGNED' : meta.status,
      laneIds: Object.freeze(roleLanes.map(lane => lane.id).sort(cmpStr)),
      eventIds: Object.freeze([...new Set([
        ...roleLanes.flatMap(lane => lane.eventIds),
        ...duplicatedIn.flatMap(item => laneById.get(item.laneId)?.eventIds ?? []),
      ])].sort(cmpStr)),
      evidenceTier: meta.tier ?? null,
      evidenceTierName: meta.tierName ?? null,
      reasons: Object.freeze([...new Set(meta.reasons)]),
      competingLaneIds: Object.freeze([...(meta.competingLaneIds ?? [])]),
      evidenceIds: Object.freeze([...new Set(meta.evidenceIds ?? [])].sort(cmpStr)),
      duplicatedLaneIds: Object.freeze(duplicatedIn.map(item => item.laneId).sort(cmpStr)),
    });
  }

  // ── cross-role review signals ──
  const samePitch = samePitchSignals(entries, instrumentation);
  const closeIntervals = closeIntervalSignals(intervals, lanes, assignment, instrumentation);
  const denseAttacks = denseAttackSignals(entries);
  const observedRolePairs = new Set();
  for (const pair of [...samePitch.simultaneous, ...samePitch.sustained]) {
    if (pair.roles.length === 2 && !pair.unassignedLaneInvolved) observedRolePairs.add(pair.roles.join('|'));
  }
  const roleDuplicationPairs = [...samePitch.simultaneous, ...samePitch.sustained]
    .filter(pair => pair.roles.length === 1 && !pair.unassignedLaneInvolved && pair.laneIds[0] !== pair.laneIds[1]);

  const conflictingEvidenceLanes = lanes.map(lane => {
    const primaryRoles = [...new Set(lane.evidence
      .filter(record => record.strength === 'primary')
      .flatMap(record => record.supportsRoles))].sort(cmpStr);
    const assigned = assignment.get(lane.id) ?? null;
    const declared = lane.sourceRoles;
    const disagrees = declared.length && assigned !== null && !declared.includes(assigned);
    if (primaryRoles.length < 2 && !disagrees) return null;
    return {
      laneId: lane.id,
      primaryEvidenceRoles: primaryRoles,
      declaredSourceRoles: [...declared],
      candidateRole: assigned,
      evidenceIds: lane.evidence.filter(record => record.strength === 'primary').map(record => record.id),
    };
  }).filter(Boolean).sort((a, b) => cmpStr(a.laneId, b.laneId));

  const silenceLanes = lanes
    .filter(lane => assignment.has(lane.id) && lane.junctions.some(junction => junction.silence))
    .map(lane => ({
      laneId: lane.id,
      role: assignment.get(lane.id),
      junctions: lane.junctions.filter(junction => junction.silence).map(junction => ({ from: junction.from, to: junction.to })),
    }))
    .sort((a, b) => cmpStr(a.laneId, b.laneId));

  const multiLaneRoles = SIX_ROLES
    .map(role => ({ role, laneIds: roles[role].laneIds }))
    .filter(entry => entry.laneIds.length > 1);

  const diagnostics = [];
  const add = (code, payload) => diagnostics.push(Object.freeze({ code, ...payload }));

  if (samePitch.simultaneous.length) add('SIMULTANEOUS_SAME_PITCH_DOUBLING', {
    deleted: false, pairs: Object.freeze(samePitch.simultaneous.map(pair => Object.freeze(pair))),
  });
  if (samePitch.sustained.length) add('SUSTAINED_SAME_PITCH_OVERLAP', {
    deleted: false,
    truncated: false,
    rolePairsObserved: Object.freeze([...observedRolePairs].sort(cmpStr)),
    rolePairsPossible: 15,
    pendingReference: 'PENDING.md P11, P15',
    pairs: Object.freeze(samePitch.sustained.map(pair => Object.freeze(pair))),
  });
  if (roleDuplicationPairs.length || classification.analyses.some(analysis => analysis.duplicationRisks.length)) add('ROLE_DUPLICATION', {
    deleted: false,
    samePitchWithinRole: Object.freeze(roleDuplicationPairs.map(pair => Object.freeze(pair))),
    enrichmentDuplication: Object.freeze(classification.analyses
      .filter(analysis => analysis.duplicationRisks.length)
      .map(analysis => Object.freeze({
        laneId: analysis.lane.id,
        role: assignment.get(analysis.lane.id) ?? null,
        risks: Object.freeze(analysis.duplicationRisks.map(risk => Object.freeze(risk))),
      }))),
  });
  if (denseAttacks.length) add('DENSE_SIMULTANEOUS_ATTACKS', {
    deleted: false, occurrences: Object.freeze(denseAttacks.map(item => Object.freeze(item))),
  });
  if (closeIntervals.length) add('LOW_MID_CLOSE_INTERVAL', {
    deleted: false,
    repaired: false,
    candidates: Object.freeze(closeIntervals.map(item => Object.freeze(item))),
  });
  for (const [role, code] of [['Melody', 'COMPETING_LEAD_CANDIDATES'], ['Chord2', 'COMPETING_BASS_CANDIDATES'], ['Chord1', 'COMPETING_HARMONY_CANDIDATES']]) {
    const meta = roleMeta.get(role);
    if (meta?.status === 'PENDING' && meta.competingLaneIds?.length) add(code, {
      role, deleted: false, laneIds: Object.freeze([...meta.competingLaneIds]),
    });
  }
  if (conflictingEvidenceLanes.length) add('CONFLICTING_ROLE_EVIDENCE', {
    deleted: false, lanes: Object.freeze(conflictingEvidenceLanes.map(item => Object.freeze(item))),
  });
  if (overflowLaneIds.size) add('SOURCE_LANE_OVERFLOW', {
    deleted: false,
    laneCount: lanes.length,
    roleCapacity: SIX_ROLES.length,
    laneIds: Object.freeze([...overflowLaneIds].sort(cmpStr)),
    notice: 'Six-role capacity is a capacity fact. Overflowing lanes are retained in `unassigned` with their evidence.',
  });
  const misplacedEssential = classification.essentialLaneIds
    .filter(laneId => ENRICHMENT_ROLE_NAMES.includes(assignment.get(laneId) ?? ''));
  if (misplacedEssential.length) add('ESSENTIAL_MATERIAL_IN_ENRICHMENT', {
    deleted: false, laneIds: Object.freeze(misplacedEssential.sort(cmpStr)),
    notice: 'Chord3-Chord5 may not carry material Core3 needs. Core3 is reported INCOMPLETE rather than letting Full6 hide the deficiency.',
  });
  const unassignedEssential = classification.essentialLaneIds.filter(laneId => !assignment.has(laneId));
  if (unassignedEssential.length) add('ESSENTIAL_MATERIAL_UNASSIGNED', {
    deleted: false, laneIds: Object.freeze(unassignedEssential.sort(cmpStr)),
  });
  if (silenceLanes.length) add('LANE_PACKING_IS_NOT_CONTINUITY', {
    continuousVoiceAsserted: false, lanes: Object.freeze(silenceLanes.map(item => Object.freeze(item))),
  });
  if (unsupported.length) add('UNSUPPORTED_SOURCE_MATERIAL_RETAINED', {
    deleted: false,
    eventIds: Object.freeze(unsupported.map(item => item.eventId)),
    notice: 'Percussion / unsupported source material never becomes a pitched role here. It stays PENDING under MASTER_RULES.md §8 and PENDING.md P10.',
  });
  if (pendingLanes.length) add('ROLE_ASSIGNMENT_PENDING', {
    deleted: false,
    lanes: Object.freeze([...pendingLanes].sort((a, b) => cmpStr(a.laneId, b.laneId)).map(item => Object.freeze({
      laneId: item.laneId,
      proposedRole: item.proposedRole ?? null,
      blockers: Object.freeze([...item.blockers]),
      competingLaneIds: Object.freeze([...item.competingLaneIds]),
      gate: item.gate ?? null,
    }))),
  });
  if (multiLaneRoles.length) add('ROLE_CARRIES_MULTIPLE_LANES', {
    deleted: false,
    roles: Object.freeze(multiLaneRoles.map(entry => Object.freeze({ role: entry.role, laneIds: entry.laneIds }))),
    notice: 'Candidate-stage fact. Whether a role can be performed on a one-chord or three-chord instrument is a later allocation question.',
  });

  // ── exact event-level coverage audit ──
  //
  // ACCEPTANCE_CRITERIA.md Gate 2 and the G11-C brief: input event ids must
  // equal assigned ∪ pending ∪ unassigned ∪ unsupported, with no silent loss
  // and no invented id. "Appears somewhere in the output" is not enough — the
  // ledger carries the original pitch/onset/duration beside every decision.
  const assignedEventIds = new Set(ledger.filter(entry => entry.selected).map(entry => entry.eventId));
  const pendingEventIds = new Set(ledger.filter(entry => entry.decision === ROLE_DECISIONS.PENDING).map(entry => entry.eventId));
  const unassignedEventIds = new Set(ledger.filter(entry => entry.decision === ROLE_DECISIONS.OMIT_FROM_SIX).map(entry => entry.eventId));
  const unsupportedEventIds = new Set(unsupported.map(item => item.eventId));
  const accounted = new Set([...assignedEventIds, ...pendingEventIds, ...unassignedEventIds, ...unsupportedEventIds]);
  const inputEventIds = [...new Set(project.events.filter(isNote).map(event => event.id))].sort(cmpStr);
  const inputEventIdSet = new Set(inputEventIds);
  const missingEventIds = inputEventIds.filter(id => !accounted.has(id));
  const unknownEventIds = [...accounted].filter(id => !inputEventIdSet.has(id)).sort(cmpStr);
  const duplicatedEventIds = [...new Set(ledger
    .filter(entry => entry.duplicate)
    .map(entry => entry.eventId))].sort(cmpStr);

  // Nothing here may alter the baseline. Proven, not asserted: every ledger
  // entry restates the source pitch/onset/duration, and they are compared back
  // against the Canonical events they came from.
  const mutatedEventIds = [...new Set(ledger.filter(entry => {
    const note = noteById.get(entry.eventId);
    if (!note) return false;
    return entry.sourcePitch !== note.pitch
      || cmpB(entry.sourceStart, note.start) !== 0
      || cmpB(entry.sourceEnd, note.end) !== 0;
  }).map(entry => entry.eventId))].sort(cmpStr);

  const coverageComplete = !missingEventIds.length && !unknownEventIds.length && !mutatedEventIds.length;
  if (!coverageComplete) add('CANDIDATE_COVERAGE_MISMATCH', {
    missingEventIds: Object.freeze(missingEventIds),
    unknownEventIds: Object.freeze(unknownEventIds),
    mutatedEventIds: Object.freeze(mutatedEventIds),
  });

  const coverage = Object.freeze({
    complete: coverageComplete,
    sourceEventCount: inputEventIds.length,
    assignedEventCount: assignedEventIds.size,
    pendingEventCount: pendingEventIds.size,
    unassignedEventCount: unassignedEventIds.size,
    unsupportedEventCount: unsupportedEventIds.size,
    duplicatedEventIds: Object.freeze(duplicatedEventIds),
    missingEventIds: Object.freeze(missingEventIds),
    unknownEventIds: Object.freeze(unknownEventIds),
    mutatedEventIds: Object.freeze(mutatedEventIds),
    inputEventIds: Object.freeze(inputEventIds),
    notice: 'Every source note event is either represented in one or more candidate roles with provenance, or explicitly present as pending / unassigned / unsupported evidence.',
  });

  const unresolvedSiblings = unresolvedHarmonySiblings(lanes, assignment, pendingLaneIds);
  if (unresolvedSiblings.length) add('UNRESOLVED_CORE_HARMONY_SIBLING', {
    deleted: false,
    movedToChord2: false,
    laneIds: Object.freeze(unresolvedSiblings.map(item => item.laneId)),
    siblings: Object.freeze(unresolvedSiblings.map(item => Object.freeze({
      ...item,
      core3SiblingLaneIds: Object.freeze([...item.core3SiblingLaneIds]),
      core3SiblingRoles: Object.freeze([...item.core3SiblingRoles]),
      eventIds: Object.freeze([...item.eventIds]),
    }))),
    notice: 'Concurrent material from a Core3 source voice that is not established as optional enrichment. An uncertainty interlock, not an assignment rule: nothing is moved, merged or deleted.',
  });

  const core3 = evaluateCore3({
    lanes, assignment, roleMeta, classification, pendingLanes, noteById,
    allNotes: notes, chord1Measurement: state.chord1Measurement ?? null,
    unresolvedSiblings,
  });
  const full6 = evaluateFull6({
    lanes, assignment, classification, core3, pendingLanes, unresolvedSiblings,
    enrichmentConflictSignals: Object.freeze(diagnostics
      .filter(item => ['SIMULTANEOUS_SAME_PITCH_DOUBLING', 'SUSTAINED_SAME_PITCH_OVERLAP', 'ROLE_DUPLICATION', 'DENSE_SIMULTANEOUS_ATTACKS', 'LOW_MID_CLOSE_INTERVAL'].includes(item.code))
      .map(item => item.code)
      .sort(cmpStr)),
  });

  diagnostics.sort((a, b) => cmpStr(a.code, b.code));

  const freezeLane = lane => Object.freeze({
    id: lane.id,
    sourceVoice: lane.sourceVoice,
    decompositionLaneIndex: lane.laneIndex,
    decompositionIndex: lane.decompositionIndex,
    candidateRole: assignment.get(lane.id) ?? null,
    chainIds: Object.freeze([...lane.chainIds]),
    eventIds: Object.freeze([...lane.eventIds]),
    sourceIds: Object.freeze([...lane.sourceIds]),
    sourceEventIds: Object.freeze([...lane.sourceEventIds]),
    declaredSourceRoles: Object.freeze([...lane.sourceRoles]),
    metrics: Object.freeze({
      ...lane.metrics,
      attackBeats: Object.freeze([...lane.metrics.attackBeats]),
      pitchClasses: Object.freeze([...lane.metrics.pitchClasses]),
      timeAsLowestSoundingPitch: lane.floorTime,
      sharedOnsetsWithinSourceVoice: lane.sharedOnsets,
    }),
    soundingIntervals: Object.freeze(lane.intervals.map(interval => Object.freeze({ ...interval }))),
    continuity: Object.freeze({
      chainCount: lane.chainIds.length,
      silenceJunctions: Object.freeze(lane.junctions.filter(junction => junction.silence)
        .map(junction => Object.freeze({ from: junction.from, to: junction.to }))),
      continuousVoiceAsserted: false,
    }),
    roleSupport: lane.roleSupport,
    evidence: Object.freeze(lane.evidence),
    spans: Object.freeze(lane.spans.map(span => Object.freeze({ ...span }))),
  });

  if (instrumentation) {
    instrumentation.laneCount = lanes.length;
    instrumentation.sourceEventCount = inputEventIds.length;
    instrumentation.ledgerEntries = ledger.length;
  }

  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/role-candidate-arrangement@1',
    projectId: project.id ?? null,
    title: project.title ?? null,
    stage: 'G11-C',
    stageKind: 'ARRANGEMENT_CANDIDATE',
    roles: Object.freeze(roles),
    lanes: Object.freeze(lanes.map(freezeLane)),
    ledger: Object.freeze(ledger.map(entry => Object.freeze({
      ...entry,
      sourceIds: Object.freeze(entry.sourceIds),
      sourceEventIds: Object.freeze(entry.sourceEventIds),
      evidenceIds: Object.freeze(entry.evidenceIds),
      competingLaneIds: Object.freeze(entry.competingLaneIds),
    }))),
    unassigned: Object.freeze(unassigned),
    pending: Object.freeze([...pendingLanes].sort((a, b) => cmpStr(a.laneId, b.laneId)).map(item => Object.freeze({
      laneId: item.laneId,
      proposedRole: item.proposedRole ?? null,
      blockers: Object.freeze([...item.blockers]),
      competingLaneIds: Object.freeze([...item.competingLaneIds]),
      evidenceIds: Object.freeze([...item.evidenceIds]),
      eventIds: Object.freeze([...(laneById.get(item.laneId)?.eventIds ?? [])]),
      gate: item.gate ?? null,
      notice: 'Evidence is insufficient or conflicting. The source events are preserved and the role decision stays open.',
    }))),
    unsupportedSourceMaterial: Object.freeze(unsupported),
    declaredDuplications: Object.freeze(duplications),
    core3,
    full6,
    reducedRoleDiagnostics: reducedRoleDiagnostics(core3),
    diagnostics: Object.freeze(diagnostics),
    coverage,
    thresholds: ROLE_CANDIDATE_THRESHOLDS,
    notice: 'G11-C produces arrangement candidates only. It certifies no ACCEPTANCE_CRITERIA.md gate: not TECHNICAL_PASS, SOURCE_PASS, PLAYER_READBACK_PASS, AUDIO_ALIGNMENT_PASS, MOBILE_ADAPTATION_PASS or IN_GAME_ACCEPTED.',
  });
}

// Factual capability record. `false` means this stage does not do the thing --
// either because it is out of G11-C scope or because doing it would need
// evidence this layer does not have. It never means the input was silently
// accepted as if it had been handled.
export const ROLE_CANDIDATE_STATUS = Object.freeze({
  // Implemented in G11-C checkpoint 1.
  sourceEventCoverage: 'lossless',
  eventLevelRoleLedger: true,
  exactCanonicalTiming: true,
  floatFreeOrdering: true,
  inputOrderIndependent: true,
  sixRoleCandidateModel: true,
  laneProvenanceRetained: true,
  structuredRoleEvidence: true,
  pendingAllowed: true,
  explicitOverflowRetained: true,
  core3EvaluatedIndependently: true,
  full6EvaluatedIndependently: true,
  crossRoleReviewSignals: true,
  declaredCandidateDuplication: true,
  leadDemotionInterlock: true,
  principalHarmonyRequiresPositiveEvidence: true,
  concurrentHarmonySiblingInterlock: true,
  core3FailsClosedOnUnprovenFunction: true,

  // Coverage, attack count, register and density rank candidates only.
  coverageRankingEstablishesPrincipalHarmony: false,
  silenceGapIsCompleteEssentialDefinition: false,
  unresolvedSiblingForcedIntoChord2: false,

  // Not done here, by decision.
  sourceEventDeletion: false,
  sourceEventAddition: false,
  pitchRewrite: false,
  onsetRewrite: false,
  durationRewrite: false,
  prominenceRewrite: false,
  octaveShift: false,
  quantization: false,
  laneMerge: false,
  bestSixOptimizer: false,
  collisionRepair: false,
  theoryCleanupPass: false,
  finalVolumeMapping: false,
  finalInstrumentAssignment: false,
  finalTempoMapEmission: false,
  finalMmlEmission: false,
  pasteReadyMmlEmission: false,
  mobileRegisterAdaptation: false,
  audioEvidenceIntake: false,
  performerCountAllocation: false,
  oneRoleCompletenessRule: false,
  twoRoleCompletenessRule: false,

  // Gates this stage explicitly does not certify.
  certifiesTechnicalPass: false,
  certifiesSourcePass: false,
  certifiesPlayerReadbackPass: false,
  certifiesAudioAlignmentPass: false,
  certifiesMobileAdaptationPass: false,
  certifiesInGameAccepted: false,

  canonicalCompletenessGate: 'CORE3',
  reducedRolePolicy: 'PENDING.md P17 unresolved',
  referenceStatus: 'MML_MABI_REFERENCE_NOT_VERIFIED',
});
