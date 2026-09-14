// G11-B clean-room polyphonic voice decomposition.
//
// This module consumes Source-Faithful Canonical note events and proposes
// monophonic lanes without rewriting the source events. It is deliberately
// lossless: no unison merge, note deletion, duration edit, quantization, role
// assignment, six-track reduction, or Mobile adaptation happens here.
//
// The algorithm is independently implemented from behavioral observations:
// atomic sounding slices -> continuity matching -> chain packing. Source-event
// identity is a hard continuity constraint; pitch distance is used only for
// unmatched replacements at an adjacent boundary.
//
// Determinism contract (checkpoint 2):
//   * input events are re-sorted by (start, -pitch, id) before anything else,
//     so caller array order can never change the result;
//   * every ordering / matching decision is made on exact rationals or on
//     integers, never on a float derived from a beat;
//   * no decision reads Map or Object enumeration order.

import { f } from '../mml/index.mjs';

const ZERO = f(0);

const cmpBeat = (a, b) => f(a).cmp(b);
const beatKey = value => f(value).toString();
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const subBeat = (a, b) => f(a).sub(b);
const absF = value => (value.cmp(ZERO) < 0 ? ZERO.sub(value) : value);

// Exact duration-weighted pitch. Lane ordering and lane affinity are decided
// with this rational, never with its float projection; `num()` is exposed only
// as a presentation field.
function weightedPitch(spans, fallbackPitch = 0) {
  let sum = ZERO;
  let weight = ZERO;
  for (const span of spans) {
    const duration = subBeat(span.end, span.start);
    sum = sum.add(duration.mul(span.pitch));
    weight = weight.add(duration);
  }
  return weight.cmp(ZERO) > 0 ? sum.div(weight) : f(fallbackPitch);
}

const eventSort = (a, b) =>
  cmpBeat(a.start, b.start)
  || b.pitch - a.pitch
  || cmpId(a.id, b.id);

function validateNote(event, index) {
  if (!event || event.kind !== 'note') throw Error(`events[${index}] must be a Canonical note event`);
  if (typeof event.id !== 'string' || !event.id) throw Error(`events[${index}].id must be non-empty`);
  if (!Number.isInteger(event.pitch)) throw Error(`events[${index}].pitch must be an integer`);
  if (cmpBeat(event.end, event.start) <= 0) throw Error(`events[${index}] must have end > start`);
}

function normalizeNotes(events) {
  if (!Array.isArray(events)) throw Error('events must be an array');
  const ids = new Set();
  const notes = events.map((event, index) => {
    validateNote(event, index);
    if (ids.has(event.id)) throw Error(`duplicate event id: ${event.id}`);
    ids.add(event.id);
    return event;
  });
  return notes.sort(eventSort);
}

function makeBoundaries(notes) {
  const values = new Map();
  for (const note of notes) {
    values.set(beatKey(note.start), note.start);
    values.set(beatKey(note.end), note.end);
  }
  return [...values.values()].sort(cmpBeat);
}

// Atomic sounding slices, built by a sweep over the exact boundary list. A
// boundary region with nothing sounding is skipped, which is what later makes a
// real silence visible as a continuity break rather than an assumed sustain.
// `notes` arrives sorted by (start, -pitch, id), so the sweep cursor is exact.
function buildSlices(notes) {
  const boundaries = makeBoundaries(notes);
  const slices = [];
  let cursor = 0;
  let sounding = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (cmpBeat(end, start) <= 0) continue;
    while (cursor < notes.length && cmpBeat(notes[cursor].start, start) <= 0) sounding.push(notes[cursor++]);
    sounding = sounding.filter(note => cmpBeat(note.end, start) > 0);
    if (!sounding.length) continue;
    slices.push({
      index: slices.length,
      start: beatKey(start),
      end: beatKey(end),
      active: [...sounding].sort((a, b) => b.pitch - a.pitch || cmpId(a.id, b.id)),
    });
  }
  return slices;
}

// Minimum-cost assignment for the unmatched portion of one adjacent boundary.
// Rows may outnumber columns; in that case the matrix is transposed and mapped
// back. The matrix is integer-only, so the assignment is a pure function of the
// two slices.
function hungarian(cost) {
  const rows = cost.length;
  const cols = rows ? cost[0].length : 0;
  if (!rows || !cols) return new Array(rows).fill(-1);
  if (rows > cols) {
    const transposed = Array.from({ length: cols }, (_, c) =>
      Array.from({ length: rows }, (_, r) => cost[r][c]));
    const reverse = hungarian(transposed);
    const out = new Array(rows).fill(-1);
    reverse.forEach((row, col) => { if (row >= 0) out[row] = col; });
    return out;
  }

  const u = new Array(rows + 1).fill(0);
  const v = new Array(cols + 1).fill(0);
  const owner = new Array(cols + 1).fill(0);
  const previous = new Array(cols + 1).fill(0);

  for (let r = 1; r <= rows; r++) {
    owner[0] = r;
    let c0 = 0;
    const min = new Array(cols + 1).fill(Infinity);
    const used = new Array(cols + 1).fill(false);
    do {
      used[c0] = true;
      const r0 = owner[c0];
      let delta = Infinity;
      let c1 = 0;
      for (let c = 1; c <= cols; c++) {
        if (used[c]) continue;
        const reduced = cost[r0 - 1][c - 1] - u[r0] - v[c];
        if (reduced < min[c]) {
          min[c] = reduced;
          previous[c] = c0;
        }
        if (min[c] < delta || (min[c] === delta && c < c1)) {
          delta = min[c];
          c1 = c;
        }
      }
      for (let c = 0; c <= cols; c++) {
        if (used[c]) {
          u[owner[c]] += delta;
          v[c] -= delta;
        } else {
          min[c] -= delta;
        }
      }
      c0 = c1;
    } while (owner[c0] !== 0);

    do {
      const c1 = previous[c0];
      owner[c0] = owner[c1];
      c0 = c1;
    } while (c0 !== 0);
  }

  const result = new Array(rows).fill(-1);
  for (let c = 1; c <= cols; c++) {
    if (owner[c] > 0) result[owner[c] - 1] = c - 1;
  }
  return result;
}

// Cost for one candidate replacement pair.
//
// `distance * stride + column` keeps semitone distance strictly dominant: an
// assignment uses min(rows, cols) pairs contributing at most `cols - 1` each, so
// the whole tie-break term stays below `stride` and can never outweigh a single
// semitone. When there are more candidates than rows, equal-distance assignments
// deterministically prefer the lowest column indices (the higher-pitched
// candidates, since a slice is ordered by descending pitch); when every column is
// used the term is constant and the matrix alone decides. Either way the matrix
// is integral, so nothing depends on float rounding or on hash iteration order.
function replacementCost(distance, column, rows, cols) {
  const stride = rows * cols + 1;
  return distance * stride + column;
}

function connectSlices(previous, next) {
  const mapping = new Array(previous.active.length).fill(-1);
  const nextTaken = new Set();
  const nextById = new Map(next.active.map((note, index) => [note.id, index]));

  // A still-sounding source event must stay in the same chain. This has higher
  // priority than pitch distance and prevents a sustained note from jumping to
  // another lane when surrounding voices move.
  previous.active.forEach((note, index) => {
    const target = nextById.get(note.id);
    if (target !== undefined) {
      mapping[index] = target;
      nextTaken.add(target);
    }
  });

  const previousOpen = previous.active
    .map((note, index) => ({ note, index }))
    .filter(item => mapping[item.index] < 0);
  const nextOpen = next.active
    .map((note, index) => ({ note, index }))
    .filter(item => !nextTaken.has(item.index));

  if (!previousOpen.length || !nextOpen.length) return mapping;

  const rows = previousOpen.length;
  const cols = nextOpen.length;
  const costs = previousOpen.map(left => nextOpen.map((right, column) =>
    replacementCost(Math.abs(left.note.pitch - right.note.pitch), column, rows, cols)));
  const assignment = hungarian(costs);
  assignment.forEach((targetIndex, row) => {
    if (targetIndex >= 0) mapping[previousOpen[row].index] = nextOpen[targetIndex].index;
  });
  return mapping;
}

function makeNodes(slices) {
  return slices.map(slice => slice.active.map((note, rank) => ({
    id: `${slice.index}:${rank}`,
    sliceIndex: slice.index,
    rank,
    note,
    pitch: note.pitch,
    start: slice.start,
    end: slice.end,
  })));
}

function buildChains(slices) {
  const nodes = makeNodes(slices);
  const parent = new Map();
  const find = id => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const flat = nodes.flat();
  flat.forEach(node => parent.set(node.id, node.id));

  // Only slices that physically touch may be connected. A real silence between
  // two sounding regions is a continuity break, never an assumed sustain.
  for (let i = 0; i + 1 < slices.length; i++) {
    const previous = slices[i];
    const next = slices[i + 1];
    if (cmpBeat(previous.end, next.start) !== 0) continue;
    const mapping = connectSlices(previous, next);
    mapping.forEach((target, source) => {
      if (target >= 0) union(nodes[i][source].id, nodes[i + 1][target].id);
    });
  }

  const grouped = new Map();
  for (const node of flat) {
    const root = find(node.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(node);
  }

  const chains = [...grouped.values()].map(chainNodes => {
    chainNodes.sort((a, b) => cmpBeat(a.start, b.start) || a.rank - b.rank);
    return {
      id: '',
      start: chainNodes[0].start,
      end: chainNodes.at(-1).end,
      pitch: weightedPitch(chainNodes, chainNodes[0].note.pitch),
      nodes: chainNodes,
    };
  });

  chains.sort((a, b) =>
    cmpBeat(a.start, b.start)
    || b.pitch.cmp(a.pitch)
    || cmpId(a.nodes[0].note.id, b.nodes[0].note.id));
  chains.forEach((chain, index) => { chain.id = `chain:${index}`; });
  return chains;
}

// One chain -> emitted spans. Adjacent nodes that carry the same source event
// are re-joined into the original span; a source event that could not be
// represented contiguously keeps every fragment instead of losing one.
function chainSpans(chain) {
  const spans = [];
  for (const node of chain.nodes) {
    const last = spans.at(-1);
    if (last && last.eventId === node.note.id && cmpBeat(last.end, node.start) === 0) {
      last.end = node.end;
      continue;
    }
    spans.push({
      eventId: node.note.id,
      chainId: chain.id,
      pitch: node.note.pitch,
      start: node.start,
      end: node.end,
      eventStart: beatKey(node.note.start),
      eventEnd: beatKey(node.note.end),
      sourceIds: [...(node.note.sourceIds ?? [])],
      sourceEventIds: [...(node.note.sourceEventIds ?? [])],
      sourceVoice: node.note.voice ?? null,
      sourceRole: node.note.role ?? null,
    });
  }
  for (const span of spans) {
    span.fragment = !(cmpBeat(span.start, span.eventStart) === 0 && cmpBeat(span.end, span.eventEnd) === 0);
  }
  return spans;
}

function packChains(chains, laneCapacity) {
  const lanes = Array.from({ length: laneCapacity }, (_, index) => ({
    index,
    availableAt: null,
    pitch: null,
    chains: [],
  }));

  for (const chain of chains) {
    let best = null;
    for (const lane of lanes) {
      if (lane.availableAt !== null && cmpBeat(lane.availableAt, chain.start) > 0) continue;
      const distance = lane.pitch === null ? ZERO : absF(lane.pitch.sub(chain.pitch));
      if (!best || distance.cmp(best.distance) < 0) best = { lane, distance };
    }
    if (!best) throw Error('voice decomposition invariant failed: no non-overlapping lane available');
    best.lane.chains.push(chain);
    best.lane.availableAt = chain.end;
    best.lane.pitch = chain.pitch;
  }

  const filled = lanes
    .filter(lane => lane.chains.length)
    .map(lane => {
      const notes = lane.chains.flatMap(chainSpans);
      const segments = lane.chains.map(chain => ({
        chainId: chain.id,
        start: chain.start,
        end: chain.end,
      }));
      // Continuity graph: a junction between two chains parked in the same lane
      // records whether the lane was reused across real silence. Lane adjacency
      // is a packing fact, not evidence of one continuous voice.
      const junctions = [];
      for (let i = 0; i + 1 < lane.chains.length; i++) {
        const before = lane.chains[i];
        const after = lane.chains[i + 1];
        junctions.push({
          previousChainId: before.id,
          nextChainId: after.id,
          from: before.end,
          to: after.start,
          silence: cmpBeat(before.end, after.start) !== 0,
        });
      }
      return {
        index: lane.index,
        pitch: weightedPitch(notes),
        chainIds: lane.chains.map(chain => chain.id),
        segments,
        junctions,
        notes,
      };
    });

  filled.sort((a, b) => b.pitch.cmp(a.pitch) || a.index - b.index);
  return filled.map((lane, index) => ({
    index,
    averagePitch: lane.pitch.num(),
    averagePitchExact: lane.pitch.toString(),
    chainIds: lane.chainIds,
    segments: lane.segments,
    junctions: lane.junctions,
    notes: lane.notes,
  }));
}

// ─── diagnostics ────────────────────────────────────────────────────────────

// Same onset + same pitch from two distinct Canonical events. Kept as two
// events: collapsing them here would destroy provenance that later cross-source
// arbitration needs.
function findSimultaneousUnisons(notes) {
  const groups = new Map();
  for (const note of notes) {
    const key = `${beatKey(note.start)}|${note.pitch}`;
    if (!groups.has(key)) groups.set(key, { start: beatKey(note.start), pitch: note.pitch, eventIds: [] });
    groups.get(key).eventIds.push(note.id);
  }
  return [...groups.values()]
    .filter(group => group.eventIds.length > 1)
    .map(group => ({ ...group, eventIds: [...group.eventIds].sort(cmpId) }))
    .sort((a, b) => cmpBeat(a.start, b.start) || a.pitch - b.pitch);
}

// Notes bucketed by pitch, each bucket still ordered by (start, id). Same-pitch
// questions are the only ones these two scans ask, so bucketing keeps them
// linear in the number of reported pairs instead of quadratic in the score.
function pitchBuckets(notes) {
  const buckets = new Map();
  for (const note of notes) {
    if (!buckets.has(note.pitch)) buckets.set(note.pitch, []);
    buckets.get(note.pitch).push(note);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

// Same pitch, different onsets, overlapping in time. A review signal under the
// Canonical cross-source arbitration rules, never an automatic deletion.
function findOverlappingSamePitch(notes) {
  const found = [];
  for (const bucket of pitchBuckets(notes)) {
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        if (cmpBeat(b.start, a.end) >= 0) break;
        if (cmpBeat(a.start, b.start) === 0) continue;
        const [left, right] = cmpId(a.id, b.id) <= 0 ? [a, b] : [b, a];
        found.push({
          pitch: a.pitch,
          eventIds: [left.id, right.id],
          from: beatKey(cmpBeat(a.start, b.start) >= 0 ? a.start : b.start),
          to: beatKey(cmpBeat(a.end, b.end) <= 0 ? a.end : b.end),
        });
      }
    }
  }
  return found.sort((a, b) =>
    cmpBeat(a.from, b.from) || a.pitch - b.pitch || cmpId(a.eventIds[0], b.eventIds[0]));
}

// Same pitch, end == next start. Canonical forbids silently turning an adjacent
// repeated attack into one sustain, so the pair is reported with `tieForbidden`.
// A successor always starts strictly later than its predecessor, so one forward
// scan per bucket sees every pair.
function findAdjacentRepeatedAttacks(notes) {
  const found = [];
  for (const bucket of pitchBuckets(notes)) {
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        const order = cmpBeat(b.start, a.end);
        if (order > 0) break;
        if (order !== 0) continue;
        found.push({
          pitch: a.pitch,
          eventIds: [a.id, b.id],
          at: beatKey(a.end),
          tieForbidden: true,
        });
      }
    }
  }
  return found.sort((a, b) =>
    cmpBeat(a.at, b.at) || a.pitch - b.pitch || cmpId(a.eventIds[0], b.eventIds[0]));
}

// Exact, event-level coverage audit. `complete` means every input event is
// represented once, with its original span fully covered and nothing invented.
function auditCoverage(notes, lanes) {
  const byEvent = new Map(notes.map(note => [note.id, []]));
  const unknownEventIds = [];
  lanes.forEach(lane => {
    lane.notes.forEach(span => {
      const bucket = byEvent.get(span.eventId);
      if (!bucket) {
        unknownEventIds.push(span.eventId);
        return;
      }
      bucket.push({ laneIndex: lane.index, start: span.start, end: span.end, pitch: span.pitch });
    });
  });

  const missingEventIds = [];
  const fragmentedEventIds = [];
  const splitAcrossLanes = [];
  const spanMismatchEventIds = [];
  const pitchMismatchEventIds = [];

  for (const note of notes) {
    const spans = byEvent.get(note.id);
    if (!spans.length) {
      missingEventIds.push(note.id);
      continue;
    }
    const laneIndices = [...new Set(spans.map(span => span.laneIndex))].sort((a, b) => a - b);
    if (laneIndices.length > 1) splitAcrossLanes.push({ eventId: note.id, laneIndices });
    if (spans.some(span => span.pitch !== note.pitch)) pitchMismatchEventIds.push(note.id);

    const ordered = [...spans].sort((a, b) => cmpBeat(a.start, b.start) || a.laneIndex - b.laneIndex);
    let covered = ZERO;
    for (const span of ordered) covered = covered.add(subBeat(span.end, span.start));
    const expected = subBeat(note.end, note.start);
    const startsMatch = cmpBeat(ordered[0].start, note.start) === 0;
    const endsMatch = cmpBeat(ordered.at(-1).end, note.end) === 0;
    if (covered.cmp(expected) !== 0 || !startsMatch || !endsMatch) spanMismatchEventIds.push(note.id);
    if (ordered.length > 1) fragmentedEventIds.push(note.id);
  }

  return {
    missingEventIds,
    unknownEventIds: [...new Set(unknownEventIds)].sort(cmpId),
    fragmentedEventIds,
    splitAcrossLanes,
    spanMismatchEventIds,
    pitchMismatchEventIds,
  };
}

function buildDiagnostics(notes, lanes, coverage, laneTarget) {
  const diagnostics = [];

  const unisons = findSimultaneousUnisons(notes);
  if (unisons.length) diagnostics.push({
    code: 'SIMULTANEOUS_UNISONS_PRESERVED',
    merged: false,
    groups: unisons,
  });

  const overlaps = findOverlappingSamePitch(notes);
  if (overlaps.length) diagnostics.push({
    code: 'OVERLAPPING_SAME_PITCH_EVENTS',
    merged: false,
    pairs: overlaps,
  });

  const repeats = findAdjacentRepeatedAttacks(notes);
  if (repeats.length) diagnostics.push({
    code: 'ADJACENT_REPEATED_ATTACKS',
    tiedIntoSustain: false,
    pairs: repeats,
  });

  const silenceReuse = lanes
    .map(lane => ({
      laneIndex: lane.index,
      junctions: lane.junctions.filter(junction => junction.silence),
    }))
    .filter(entry => entry.junctions.length);
  if (silenceReuse.length) diagnostics.push({
    code: 'LANE_REUSED_ACROSS_SILENCE',
    continuousVoiceAsserted: false,
    lanes: silenceReuse,
  });

  if (coverage.fragmentedEventIds.length) diagnostics.push({
    code: 'EVENT_REPRESENTED_AS_FRAGMENTS',
    eventIds: [...coverage.fragmentedEventIds].sort(cmpId),
  });

  if (laneTarget !== null && lanes.length > laneTarget) diagnostics.push({
    code: 'LANE_COUNT_EXCEEDS_TARGET',
    laneCount: lanes.length,
    laneTarget,
    reductionApplied: false,
  });

  const broken = coverage.missingEventIds.length
    || coverage.unknownEventIds.length
    || coverage.splitAcrossLanes.length
    || coverage.spanMismatchEventIds.length
    || coverage.pitchMismatchEventIds.length;
  if (broken) diagnostics.push({
    code: 'SOURCE_COVERAGE_MISMATCH',
    missingEventIds: [...coverage.missingEventIds].sort(cmpId),
    unknownEventIds: coverage.unknownEventIds,
    splitAcrossLanes: coverage.splitAcrossLanes,
    spanMismatchEventIds: [...coverage.spanMismatchEventIds].sort(cmpId),
    pitchMismatchEventIds: [...coverage.pitchMismatchEventIds].sort(cmpId),
  });

  return diagnostics.sort((a, b) => cmpId(a.code, b.code));
}

// ─── entry points ───────────────────────────────────────────────────────────

const deepFreezeLane = lane => Object.freeze({
  ...lane,
  chainIds: Object.freeze([...lane.chainIds]),
  segments: Object.freeze(lane.segments.map(segment => Object.freeze({ ...segment }))),
  junctions: Object.freeze(lane.junctions.map(junction => Object.freeze({ ...junction }))),
  notes: Object.freeze(lane.notes.map(note => Object.freeze({
    ...note,
    sourceIds: Object.freeze([...note.sourceIds]),
    sourceEventIds: Object.freeze([...note.sourceEventIds]),
  }))),
});

export function splitCanonicalVoice(events, options = {}) {
  const notes = normalizeNotes(events);
  const laneTarget = options.laneTarget ?? null;
  if (laneTarget !== null && (!Number.isInteger(laneTarget) || laneTarget < 1)) {
    throw Error('options.laneTarget must be a positive integer when provided');
  }

  if (!notes.length) {
    return Object.freeze({
      schema: 'mabinogi-mobile-mml-studio/voice-decomposition@2',
      sourceVoice: options.sourceVoice ?? null,
      complete: true,
      maxPolyphony: 0,
      laneTarget,
      lanes: Object.freeze([]),
      diagnostics: Object.freeze([]),
      inputEventIds: Object.freeze([]),
      outputEventIds: Object.freeze([]),
    });
  }

  const voices = new Set(notes.map(note => note.voice ?? null));
  if (options.requireSingleSourceVoice !== false && voices.size > 1) {
    throw Error('splitCanonicalVoice requires events from one source voice; group them before decomposition');
  }

  const slices = buildSlices(notes);
  const maxPolyphony = Math.max(0, ...slices.map(slice => slice.active.length));
  const chains = buildChains(slices);
  const lanes = packChains(chains, maxPolyphony);
  const coverage = auditCoverage(notes, lanes);
  const diagnostics = buildDiagnostics(notes, lanes, coverage, laneTarget);

  const complete = !coverage.missingEventIds.length
    && !coverage.unknownEventIds.length
    && !coverage.splitAcrossLanes.length
    && !coverage.spanMismatchEventIds.length
    && !coverage.pitchMismatchEventIds.length;

  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/voice-decomposition@2',
    sourceVoice: options.sourceVoice ?? (voices.size === 1 ? [...voices][0] : null),
    complete,
    maxPolyphony,
    laneTarget,
    lanes: Object.freeze(lanes.map(deepFreezeLane)),
    diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))),
    inputEventIds: Object.freeze(notes.map(note => note.id)),
    outputEventIds: Object.freeze(lanes.flatMap(lane => lane.notes.map(note => note.eventId))),
  });
}

export function splitProjectSourceVoices(project, options = {}) {
  if (!project || !Array.isArray(project.events)) throw Error('project.events must be an array');
  const groups = new Map();
  for (const event of project.events) {
    if (event?.kind !== 'note') continue;
    const key = event.voice ?? 'voice:null';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return Object.freeze([...groups.entries()]
    .sort(([a], [b]) => cmpId(a, b))
    .map(([voice, events]) => splitCanonicalVoice(events, { ...options, sourceVoice: voice })));
}

export const VOICE_SPLIT_STATUS = Object.freeze({
  sourceEventCoverage: 'lossless',
  exactCanonicalTiming: true,
  floatFreeOrdering: true,
  inputOrderIndependent: true,
  sustainedEventContinuityHardConstraint: true,
  replacementPitchDistanceMatching: true,
  silenceBreaksContinuityGraph: true,
  fragmentProvenanceRetained: true,
  simultaneousUnisonMerge: false,
  overlappingSamePitchMerge: false,
  repeatedAttackTied: false,
  quantization: false,
  durationRewrite: false,
  eventDeletion: false,
  laneCapReduction: false,
  roleAssignment: false,
  sixTrackReduction: false,
  mobileAdaptation: false,
  referenceStatus: 'MML_MABI_REFERENCE_NOT_VERIFIED',
});
