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

import { f } from '../mml/index.mjs';

const cmpBeat = (a, b) => f(a).cmp(b);
const beatKey = value => f(value).toString();
const durationNumber = (start, end) => f(end).sub(start).num();

const eventSort = (a, b) =>
  cmpBeat(a.start, b.start)
  || b.pitch - a.pitch
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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

function activeAt(notes, beat) {
  return notes
    .filter(note => cmpBeat(note.start, beat) <= 0 && cmpBeat(note.end, beat) > 0)
    .sort((a, b) => b.pitch - a.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function buildSlices(notes) {
  const boundaries = makeBoundaries(notes);
  const slices = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (cmpBeat(end, start) <= 0) continue;
    const active = activeAt(notes, start);
    if (!active.length) continue;
    slices.push({
      index: slices.length,
      start: beatKey(start),
      end: beatKey(end),
      active,
    });
  }
  return slices;
}

// Minimum-cost assignment for the unmatched portion of one adjacent boundary.
// Rows may outnumber columns; in that case the matrix is transposed and mapped
// back. Cost is semitone distance with deterministic column-order tie breaking.
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

  const scale = 1_000_000;
  const costs = previousOpen.map((left, r) => nextOpen.map((right, c) =>
    Math.abs(left.note.pitch - right.note.pitch) * scale + c * 1000 + r));
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

  nodes.flat().forEach(node => parent.set(node.id, node.id));

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
  for (const node of nodes.flat()) {
    const root = find(node.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(node);
  }

  const chains = [...grouped.values()].map((chainNodes, index) => {
    chainNodes.sort((a, b) => cmpBeat(a.start, b.start) || a.rank - b.rank);
    const weighted = chainNodes.reduce((acc, node) => {
      const weight = durationNumber(node.start, node.end);
      return { sum: acc.sum + node.note.pitch * weight, weight: acc.weight + weight };
    }, { sum: 0, weight: 0 });
    return {
      id: `chain:${index}`,
      start: chainNodes[0].start,
      end: chainNodes.at(-1).end,
      pitch: weighted.weight ? weighted.sum / weighted.weight : chainNodes[0].note.pitch,
      nodes: chainNodes,
    };
  });

  chains.sort((a, b) => cmpBeat(a.start, b.start) || b.pitch - a.pitch || (a.id < b.id ? -1 : 1));
  chains.forEach((chain, index) => { chain.id = `chain:${index}`; });
  return chains;
}

function coalesceChain(chain) {
  const spans = [];
  for (const node of chain.nodes) {
    const last = spans.at(-1);
    if (last && last.eventId === node.note.id && cmpBeat(last.end, node.start) === 0) {
      last.end = node.end;
      continue;
    }
    spans.push({
      eventId: node.note.id,
      pitch: node.note.pitch,
      start: node.start,
      end: node.end,
      sourceIds: [...(node.note.sourceIds ?? [])],
      sourceEventIds: [...(node.note.sourceEventIds ?? [])],
      sourceVoice: node.note.voice ?? null,
      sourceRole: node.note.role ?? null,
    });
  }
  return spans;
}

function packChains(chains, maxPolyphony) {
  const lanes = Array.from({ length: maxPolyphony }, (_, index) => ({
    index,
    availableAt: null,
    pitch: null,
    chains: [],
  }));

  for (const chain of chains) {
    let best = null;
    for (const lane of lanes) {
      if (lane.availableAt !== null && cmpBeat(lane.availableAt, chain.start) > 0) continue;
      const distance = lane.pitch === null ? 0 : Math.abs(lane.pitch - chain.pitch);
      if (!best || distance < best.distance || (distance === best.distance && lane.index < best.lane.index)) {
        best = { lane, distance };
      }
    }
    if (!best) throw Error('voice decomposition invariant failed: no non-overlapping lane available');
    best.lane.chains.push(chain);
    best.lane.availableAt = chain.end;
    best.lane.pitch = chain.pitch;
  }

  const result = lanes
    .filter(lane => lane.chains.length)
    .map(lane => {
      const notes = lane.chains.flatMap(coalesceChain);
      const weight = notes.reduce((acc, note) => {
        const duration = durationNumber(note.start, note.end);
        return { sum: acc.sum + note.pitch * duration, duration: acc.duration + duration };
      }, { sum: 0, duration: 0 });
      return {
        index: lane.index,
        averagePitch: weight.duration ? weight.sum / weight.duration : 0,
        chainIds: lane.chains.map(chain => chain.id),
        notes,
      };
    })
    .sort((a, b) => b.averagePitch - a.averagePitch || a.index - b.index);

  result.forEach((lane, index) => { lane.index = index; });
  return result;
}

function findUnisonGroups(notes) {
  const groups = new Map();
  for (const note of notes) {
    const key = `${beatKey(note.start)}:${note.pitch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note.id);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, eventIds]) => {
      const split = key.lastIndexOf(':');
      return { start: key.slice(0, split), pitch: Number(key.slice(split + 1)), eventIds };
    });
}

export function splitCanonicalVoice(events, options = {}) {
  const notes = normalizeNotes(events);
  if (!notes.length) {
    return Object.freeze({
      schema: 'mabinogi-mobile-mml-studio/voice-decomposition@1',
      sourceVoice: options.sourceVoice ?? null,
      complete: true,
      maxPolyphony: 0,
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
  const outputEventIds = lanes.flatMap(lane => lane.notes.map(note => note.eventId));
  const inputEventIds = notes.map(note => note.id);
  const inputSet = new Set(inputEventIds);
  const outputSet = new Set(outputEventIds);
  const missingEventIds = inputEventIds.filter(id => !outputSet.has(id));
  const unknownEventIds = outputEventIds.filter(id => !inputSet.has(id));

  const diagnostics = [];
  const unisons = findUnisonGroups(notes);
  if (unisons.length) diagnostics.push({
    code: 'SIMULTANEOUS_UNISONS_PRESERVED',
    groups: unisons,
  });
  if (missingEventIds.length || unknownEventIds.length) diagnostics.push({
    code: 'SOURCE_COVERAGE_MISMATCH',
    missingEventIds,
    unknownEventIds,
  });

  return Object.freeze({
    schema: 'mabinogi-mobile-mml-studio/voice-decomposition@1',
    sourceVoice: options.sourceVoice ?? (voices.size === 1 ? [...voices][0] : null),
    complete: missingEventIds.length === 0 && unknownEventIds.length === 0,
    maxPolyphony,
    lanes: Object.freeze(lanes.map(lane => Object.freeze({
      ...lane,
      chainIds: Object.freeze([...lane.chainIds]),
      notes: Object.freeze(lane.notes.map(note => Object.freeze({ ...note,
        sourceIds: Object.freeze([...note.sourceIds]),
        sourceEventIds: Object.freeze([...note.sourceEventIds]),
      }))),
    }))),
    diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))),
    inputEventIds: Object.freeze(inputEventIds),
    outputEventIds: Object.freeze(outputEventIds),
  });
}

export function splitProjectSourceVoices(project) {
  if (!project || !Array.isArray(project.events)) throw Error('project.events must be an array');
  const groups = new Map();
  for (const event of project.events) {
    if (event?.kind !== 'note') continue;
    const key = event.voice ?? 'voice:null';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return Object.freeze([...groups.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([voice, events]) => splitCanonicalVoice(events, { sourceVoice: voice })));
}

export const VOICE_SPLIT_STATUS = Object.freeze({
  sourceEventCoverage: 'lossless',
  exactCanonicalTiming: true,
  sustainedEventContinuityHardConstraint: true,
  replacementPitchDistanceMatching: true,
  simultaneousUnisonMerge: false,
  quantization: false,
  durationRewrite: false,
  eventDeletion: false,
  roleAssignment: false,
  sixTrackReduction: false,
  mobileAdaptation: false,
});
