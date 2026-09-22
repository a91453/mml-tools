import { f } from '../mml/index.mjs';

const asProject = value => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.events)) throw Error('compare input must be a Canonical project-like object');
  return value;
};

const noteEvents = project => project.events.filter(event => event.kind === 'note');
const restEvents = project => project.events.filter(event => event.kind === 'rest');
const roleKey = event => event.role ?? 'UNASSIGNED';
const structuralKey = event => `${roleKey(event)}|${event.start}|${event.pitch}|${event.end}`;
const roleMoveKey = event => `${event.start}|${event.pitch}|${event.end}`;
const onsetPitchKey = event => `${event.start}|${event.pitch}`;
const sameOnsetKey = event => `${roleKey(event)}|${event.start}`;
const samePitchOnsetKey = event => `${roleKey(event)}|${event.start}|${event.pitch}`;
const restKey = event => `${roleKey(event)}|${event.start}|${event.end}`;
const tempoKey = event => String(event.beat);

function sorted(events) {
  return [...events].sort((a, b) =>
    f(a.start ?? a.beat).cmp(b.start ?? b.beat)
      || roleKey(a).localeCompare(roleKey(b))
      || Number(a.pitch ?? 0) - Number(b.pitch ?? 0)
      || f(a.end ?? a.start ?? a.beat).cmp(b.end ?? b.start ?? b.beat)
      || String(a.id).localeCompare(String(b.id)));
}

function indexQueues(events, keyFn) {
  const map = new Map();
  for (const event of sorted(events)) {
    const key = keyFn(event);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return map;
}

function take(queueMap, key, used) {
  const queue = queueMap.get(key) ?? [];
  while (queue.length && used.has(queue[0].id)) queue.shift();
  const value = queue.shift() ?? null;
  if (value) used.add(value.id);
  return value;
}

function noteChanges(before, after) {
  const changes = {};
  if (before.role !== after.role) changes.role = { before: before.role, after: after.role };
  if (before.pitch !== after.pitch) changes.pitch = { before: before.pitch, after: after.pitch };
  if (before.start !== after.start) changes.start = { before: before.start, after: after.start };
  if (before.end !== after.end) changes.end = { before: before.end, after: after.end };
  if ((before.volume ?? null) !== (after.volume ?? null)) changes.volume = { before: before.volume ?? null, after: after.volume ?? null };
  return changes;
}

function alignNotes(beforeEvents, afterEvents) {
  const before = sorted(beforeEvents);
  const after = sorted(afterEvents);
  const usedBefore = new Set();
  const usedAfter = new Set();
  const aligned = [];

  const passes = [
    { name: 'exact-structure', beforeIndex: indexQueues(before, structuralKey), key: structuralKey },
    { name: 'same-role-onset-pitch', beforeIndex: indexQueues(before, samePitchOnsetKey), key: samePitchOnsetKey },
    { name: 'same-role-onset', beforeIndex: indexQueues(before, sameOnsetKey), key: sameOnsetKey },
    { name: 'role-move', beforeIndex: indexQueues(before, roleMoveKey), key: roleMoveKey },
    // Last, and only over what every pass above left unpaired: the same attack
    // (onset and pitch) whose role and release both changed, e.g. a role-less
    // source event assigned a role whose release a Mobile representation moved.
    // Pairing it keeps the release change traceable as a modification of that
    // event instead of hiding it inside an unrelated removal and addition.
    { name: 'same-onset-pitch', beforeIndex: indexQueues(before, onsetPitchKey), key: onsetPitchKey },
  ];

  for (const pass of passes) {
    for (const candidate of after) {
      if (usedAfter.has(candidate.id)) continue;
      const matched = take(pass.beforeIndex, pass.key(candidate), usedBefore);
      if (!matched) continue;
      usedAfter.add(candidate.id);
      aligned.push({ before: matched, after: candidate, match: pass.name, changes: noteChanges(matched, candidate) });
    }
  }

  return {
    aligned,
    removed: before.filter(event => !usedBefore.has(event.id)),
    added: after.filter(event => !usedAfter.has(event.id)),
  };
}

function multisetDiff(beforeEvents, afterEvents, keyFn) {
  const beforeIndex = indexQueues(beforeEvents, keyFn);
  const usedBefore = new Set();
  const matched = [];
  const added = [];
  for (const event of sorted(afterEvents)) {
    const prior = take(beforeIndex, keyFn(event), usedBefore);
    if (prior) matched.push({ before: prior, after: event });
    else added.push(event);
  }
  return {
    matched,
    removed: sorted(beforeEvents).filter(event => !usedBefore.has(event.id)),
    added,
  };
}

function tempoDiff(beforeEvents = [], afterEvents = []) {
  const before = indexQueues(beforeEvents, tempoKey);
  const usedBefore = new Set();
  const changed = [];
  const added = [];
  for (const event of [...afterEvents].sort((a, b) => f(a.beat).cmp(b.beat))) {
    const prior = take(before, tempoKey(event), usedBefore);
    if (!prior) added.push(event);
    else if (Number(prior.bpm) !== Number(event.bpm)) changed.push({ beat: event.beat, before: prior.bpm, after: event.bpm, beforeId: prior.id, afterId: event.id });
  }
  return {
    changed,
    added,
    removed: beforeEvents.filter(event => !usedBefore.has(event.id)),
  };
}

export function compareCanonicalVersions(beforeInput, afterInput) {
  const before = asProject(beforeInput);
  const after = asProject(afterInput);
  const notes = alignNotes(noteEvents(before), noteEvents(after));
  const rests = multisetDiff(restEvents(before), restEvents(after), restKey);
  const tempo = tempoDiff(before.tempoEvents ?? [], after.tempoEvents ?? []);

  const noteModified = notes.aligned.filter(pair => Object.keys(pair.changes).length);
  const roleMoves = noteModified.filter(pair => pair.changes.role && !pair.changes.pitch && !pair.changes.start && !pair.changes.end);
  const otherNoteModifications = noteModified.filter(pair => !roleMoves.includes(pair));

  const summary = Object.freeze({
    noteAdded: notes.added.length,
    noteRemoved: notes.removed.length,
    noteModified: otherNoteModifications.length,
    roleMoved: roleMoves.length,
    restAdded: rests.added.length,
    restRemoved: rests.removed.length,
    tempoAdded: tempo.added.length,
    tempoRemoved: tempo.removed.length,
    tempoChanged: tempo.changed.length,
  });

  const diagnosticChangeCount = Object.values(summary).reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    before: before.id ?? null,
    after: after.id ?? null,
    structurallyIdentical: diagnosticChangeCount === 0,
    diagnosticChangeCount,
    summary,
    notes: Object.freeze({
      added: Object.freeze(notes.added),
      removed: Object.freeze(notes.removed),
      modified: Object.freeze(otherNoteModifications),
      roleMoved: Object.freeze(roleMoves),
    }),
    rests: Object.freeze({ added: Object.freeze(rests.added), removed: Object.freeze(rests.removed) }),
    tempo: Object.freeze({ added: Object.freeze(tempo.added), removed: Object.freeze(tempo.removed), changed: Object.freeze(tempo.changed) }),
    notice: 'Change counts are diagnostic only. More or fewer changes do not prove musical quality or source correctness.',
  });
}

export function compareCandidateLineage({ sourceBaseline, acceptedPrevious, candidate }) {
  const source = compareCanonicalVersions(sourceBaseline, candidate);
  const previousSource = acceptedPrevious ? compareCanonicalVersions(sourceBaseline, acceptedPrevious) : null;
  const previousCandidate = acceptedPrevious ? compareCanonicalVersions(acceptedPrevious, candidate) : null;
  const divergenceIncreased = previousSource
    ? source.diagnosticChangeCount > previousSource.diagnosticChangeCount
    : null;

  return Object.freeze({
    sourceToCandidate: source,
    sourceToPrevious: previousSource,
    previousToCandidate: previousCandidate,
    divergenceIncreased,
    reviewRequired: divergenceIncreased === true,
    notice: 'Increased diagnostic divergence is a review trigger, not proof that the candidate is worse. Source/audio evidence decides whether each change is valid.',
  });
}
