// Final round-trip gate.
//
// "The string looks valid" is not evidence. ACCEPTANCE_CRITERIA Gate 1 requires
// exact timing and note-on identity to be preserved, and MOBILE_SYNTAX §11 step
// 8 requires a reversible mapping from canonical output back to the source
// decisions. Both are claims about what the emitted text *means*, so the only
// way to check them is to read the text back with the authoritative parser and
// compare semantics.
//
// What is compared is the semantic IR, never the token text. The parser
// legitimately normalizes representation — a tie chain collapses into one event,
// a default length disappears into a bare note — so raw token equality would
// fail on correct output and pass on nothing useful.
//
// Every comparison is exact rational. An epsilon here would defeat the entire
// point of the exact pipeline behind it.
import { f, ROLES } from '../mml/index.mjs';
import { splitMML, parseTrack } from '../mml/parser.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
} from '../canonical/index.mjs';
import {
  DIAGNOSTIC_SEVERITY,
  EMIT_DIAGNOSTICS,
  diagnostic,
  parserFacts,
} from './emitter-contract.mjs';

const exactlyEqual = (left, right) => f(left).cmp(right) === 0;

/**
 * Silence spans implied by a parsed track: everything in `[0, total)` that no
 * note covers. This is the same inference `mml/canonicalize.mjs` makes in the
 * opposite direction, so the two stay symmetric.
 */
export function silenceSpansOf(track) {
  const spans = [];
  const ordered = [...track.events].sort((left, right) => f(left.start).cmp(right.start) || f(left.end).cmp(right.end));
  let cursor = f(0);
  for (const event of ordered) {
    const start = f(event.start);
    if (start.cmp(cursor) > 0) spans.push({ start: cursor.toString(), end: start.toString() });
    if (f(event.end).cmp(cursor) > 0) cursor = f(event.end);
  }
  const total = f(track.total);
  if (total.cmp(cursor) > 0) spans.push({ start: cursor.toString(), end: total.toString() });
  return spans;
}

function compareRole(expected, track, mismatches) {
  const { role } = expected;
  const note = (field, want, got, index) => mismatches.push({ role, field, index, expected: want, actual: got });

  if (track.errors.length) {
    for (const error of track.errors) {
      mismatches.push({ role, field: 'parse-error', index: null, expected: 'no Final parse error', actual: error.code ?? error.message });
    }
    return;
  }

  // Attack identity. The parser merges a tie chain into a single event, so the
  // count of parsed events *is* the count of attacks that survived
  // serialization. A merged pair of distinct same-pitch attacks, or a split
  // single attack, both show up right here.
  if (track.events.length !== expected.notes.length) {
    note('attack-count', expected.notes.length, track.events.length, null);
    return;
  }

  for (let index = 0; index < expected.notes.length; index += 1) {
    const want = expected.notes[index];
    const got = track.events[index];
    if (want.pitch !== got.pitch) note('pitch', want.pitch, got.pitch, index);
    if (!exactlyEqual(want.start, got.start)) note('start', want.start, got.start, index);
    if (!exactlyEqual(want.end, got.end)) note('end', want.end, got.end, index);
    if (want.volume !== got.volume) note('volume', want.volume, got.volume, index);
  }

  // Meaningful silence has to survive too. A compressor that quietly absorbs a
  // rest into the previous note keeps every attack and every pitch, and only
  // this comparison catches it.
  const silence = silenceSpansOf(track);
  if (silence.length !== expected.silence.length) {
    note('silence-span-count', expected.silence.length, silence.length, null);
  } else {
    for (let index = 0; index < silence.length; index += 1) {
      if (!exactlyEqual(expected.silence[index].start, silence[index].start)) {
        note('silence-start', expected.silence[index].start, silence[index].start, index);
      }
      if (!exactlyEqual(expected.silence[index].end, silence[index].end)) {
        note('silence-end', expected.silence[index].end, silence[index].end, index);
      }
    }
  }

  if (track.tempo.length !== expected.tempo.length) {
    note('tempo-count', expected.tempo.length, track.tempo.length, null);
  } else {
    for (let index = 0; index < track.tempo.length; index += 1) {
      if (!exactlyEqual(expected.tempo[index].beat, track.tempo[index].beat)) {
        note('tempo-position', expected.tempo[index].beat, track.tempo[index].beat, index);
      }
      if (expected.tempo[index].bpm !== track.tempo[index].bpm) {
        note('tempo-value', expected.tempo[index].bpm, track.tempo[index].bpm, index);
      }
    }
  }

  if (!exactlyEqual(expected.total, track.total)) note('total-duration', expected.total, track.total, null);
}

/**
 * Read the emitted six-role string back and compare it to what the candidate
 * said, field by field.
 *
 * Returns a frozen report plus the diagnostics a mismatch produces. A mismatch
 * is always fatal: the emitter has no licence to ship output whose meaning it
 * cannot confirm.
 */
export function verifyFinalReadback(combinedMml, expectedRoles, options = {}) {
  const diagnostics = [];
  const mismatches = [];
  let tracks;

  try {
    tracks = splitMML(combinedMml);
  } catch (error) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.ROUND_TRIP_PARSE_ERROR,
      DIAGNOSTIC_SEVERITY.ERROR,
      `The emitted six-role string could not be split: ${error.message}`,
      {},
    ));
    return {
      diagnostics,
      report: Object.freeze({ status: 'FAIL', comparedFields: Object.freeze([]), mismatches: Object.freeze([]) }),
    };
  }

  const byRole = new Map(expectedRoles.map(entry => [entry.role, entry]));
  for (let index = 0; index < ROLES.length; index += 1) {
    const role = ROLES[index];
    const expected = byRole.get(role);
    const raw = tracks[index];

    if (!expected || expected.empty) {
      // MOBILE_SYNTAX §10: empty roles stay empty. No filler tempo, no filler
      // rest, and the readback has to show exactly that.
      if (raw !== '') mismatches.push({ role, field: 'empty-role', index: null, expected: '', actual: raw });
      continue;
    }

    compareRole(expected, parseTrack(raw, role, {
      mode: 'final',
      allowCautionLengths: options.cautionLengthOptIn === true,
    }), mismatches);
  }

  if (mismatches.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.ROUND_TRIP_MISMATCH,
      DIAGNOSTIC_SEVERITY.ERROR,
      `The emitted MML does not read back as the candidate: ${mismatches.length} mismatch(es), first at ${mismatches[0].role}/${mismatches[0].field}.`,
      { mismatches: Object.freeze(mismatches.slice(0, 40).map(Object.freeze)) },
    ));
  }

  return {
    diagnostics,
    report: Object.freeze({
      status: mismatches.length ? 'FAIL' : 'PASS',
      comparedFields: Object.freeze([
        'parse-errors', 'attack-count', 'pitch', 'start', 'end', 'volume',
        'silence-spans', 'tempo-count', 'tempo-position', 'tempo-value',
        'total-duration', 'empty-role',
      ]),
      mismatches: Object.freeze(mismatches.map(Object.freeze)),
    }),
  };
}

/**
 * Semantic snapshot of what the candidate says a role must sound like.
 *
 * `volume: null` means the candidate decided nothing, so the expectation is the
 * parser's own default — the level the emitted string will actually produce.
 * Recording that explicitly is what keeps "undecided" from quietly becoming
 * "unchecked".
 */
export function expectedRoleSemantics(role, pieces, tempoEvents, total) {
  const facts = parserFacts();
  const notes = [];
  const silence = [];
  for (const piece of pieces) {
    if (piece.kind === 'note') {
      notes.push({
        pitch: piece.pitch,
        start: piece.start.toString(),
        end: piece.end.toString(),
        volume: piece.volume === null || piece.volume === undefined ? facts.defaultVolume : piece.volume,
      });
    } else {
      silence.push({ start: piece.start.toString(), end: piece.end.toString() });
    }
  }
  return Object.freeze({
    role,
    empty: false,
    notes: Object.freeze(notes.map(Object.freeze)),
    silence: Object.freeze(silence.map(Object.freeze)),
    tempo: Object.freeze(tempoEvents.map(event => Object.freeze({ beat: event.beat, bpm: event.bpm }))),
    total: total.toString(),
  });
}

/**
 * Rebuild a Canonical project from an emitted string's own parse.
 *
 * This exists so `emit → parse → emit` can be asserted byte-identical. The
 * reconstruction is deliberately mechanical: it asserts nothing about the music
 * and claims no provenance beyond `derived`, because a re-read of the project's
 * own output is not a source. It is not part of the emit path.
 */
export function projectFromFinalReadback(combinedMml, options = {}) {
  const sourceId = options.sourceId ?? 'final-readback';
  const source = createSource({
    id: sourceId,
    label: options.label ?? 'Final emitter readback',
    kind: 'current-mml',
    authority: 'derived',
  });

  const tracks = splitMML(combinedMml).map((raw, index) => parseTrack(raw, ROLES[index], {
    mode: 'final',
    allowCautionLengths: options.cautionLengthOptIn === true,
  }));

  const events = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const role = ROLES[index];
    track.events.forEach((event, position) => {
      events.push(createCanonicalNoteEvent({
        id: `${sourceId}:note:${role}:${position + 1}`,
        pitch: event.pitch,
        start: event.start,
        end: event.end,
        volume: event.volume,
        role,
        voice: role,
        sourceIds: [sourceId],
      }));
    });
    silenceSpansOf(track).forEach((span, position) => {
      events.push(createCanonicalRestEvent({
        id: `${sourceId}:rest:${role}:${position + 1}`,
        start: span.start,
        end: span.end,
        role,
        voice: role,
        sourceIds: [sourceId],
      }));
    });
  }

  const active = tracks.find(track => !track.empty);
  const tempoEvents = (active?.tempo ?? []).map((tempo, index) => createCanonicalTempoEvent({
    id: `${sourceId}:tempo:${index + 1}`,
    beat: tempo.beat,
    bpm: tempo.bpm,
    sourceIds: [sourceId],
  }));

  return createCanonicalProject({
    id: options.id ?? `${sourceId}-project`,
    title: options.title ?? 'Final emitter readback',
    sources: [source],
    events,
    tempoEvents,
  });
}
