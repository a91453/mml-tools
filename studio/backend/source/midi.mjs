// MIDI source intake: raw bytes -> lossless evidence -> Canonical IR.
//
// G11-A scope. This adapter reads a Standard MIDI File and projects it into the
// Canonical IR as a Source-Faithful Baseline. It performs no arrangement work:
// no voice splitting, no track merging, no reduction to six roles, no velocity
// -> Mobile volume mapping, no quantization. Those are adaptations, and
// `MASTER_RULES.md` §3 requires the diff-capable baseline to exist *before* any
// of them is accepted, so doing them here would destroy the thing the later
// gates diff against.
//
// Three layers, in order:
//
//   1. `decodeMidiFile` (midi-file.mjs) records every byte as evidence.
//   2. This module pairs note-ons with note-offs and converts ticks to exact
//      rational beats, attaching each Canonical event to the raw event indices
//      it came from.
//   3. `midiFragmentToProject` wraps the result as a Canonical project.
//
// What this module refuses to decide is as important as what it decides. A
// note it cannot represent losslessly is never approximated into one: it is
// recorded in `unsupported` with its raw event indices and left out of
// `events`, so `fragment.complete` goes false and Gate 2 sees an honest
// baseline instead of a silently repaired one.

import { F, f } from '../mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../canonical/index.mjs';
import { createTimingProvenance } from '../canonical/timing.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { decodeMidiFile, toBytes } from './midi-file.mjs';
import { sha256Hex } from './sha256.mjs';

const MIDI_ADAPTER = 'studio/backend/source/midi.mjs';

const MICROSECONDS_PER_MINUTE = 60000000;

// A Standard MIDI File cannot state a tempo in BPM. It stores whole
// microseconds per quarter note, so a writer holding an integer Tempo T stores
// Math.round(60,000,000 / T) -- the repository's own `writeMidi` does exactly
// that -- and T130 arrives as 461,538 us, which divides back to
// 130.00013000013. That fraction is the storage format's rounding, not a tempo
// the source states. Read as the Canonical bpm it made the Final emitter refuse
// every such file (it writes an integer T and will not round one), and it made
// the file disagree with a score stating the same integer at the same beat,
// since control maps compare tempi exactly.
//
// The stored value is therefore read back through that encoding: when exactly
// one integer tempo in the ruleset's Tempo range is stored as this microsecond
// value, that integer is what the file states. A value no integer is stored as
// is a genuinely fractional tempo and keeps its exact rate, so the emitter
// still refuses it by name. The range is the one the Final writes
// (MOBILE_SYNTAX §7), read from the executable ruleset rather than restated.
export const SMF_INTEGER_TEMPO_ENCODING = 'SMF_INTEGER_US_ROUNDTRIP';

export function integerTempoForMicroseconds(microsecondsPerQuarter, {
  min = EFFECTIVE_RULESET.mobileSyntax.tempoMin,
  max = EFFECTIVE_RULESET.mobileSyntax.tempoMax,
} = {}) {
  if (!Number.isSafeInteger(microsecondsPerQuarter) || microsecondsPerQuarter <= 0) return null;
  // Only an integer within half a microsecond of the stored value can round to
  // it. The window is widened by one on each side so that the exact
  // Math.round comparison below decides, never this float bound.
  const low = Math.max(min, Math.floor(MICROSECONDS_PER_MINUTE / (microsecondsPerQuarter + 0.5)) - 1);
  const high = Math.min(max, Math.ceil(MICROSECONDS_PER_MINUTE / Math.max(microsecondsPerQuarter - 0.5, 0.5)) + 1);
  const matches = [];
  for (let bpm = low; bpm <= high; bpm++) {
    if (Math.round(MICROSECONDS_PER_MINUTE / bpm) === microsecondsPerQuarter) matches.push(bpm);
  }
  return matches.length === 1 ? matches[0] : null;
}

// General MIDI reserves channel 10 (index 9) for percussion. `MASTER_RULES.md`
// §8 is explicit that these note numbers are drum-kit selectors, not pitches,
// and must not leak into pitched instruments. They are therefore recorded as
// evidence and never emitted as Canonical note events; mapping them to Mobile
// drum-face positions needs evidence this adapter does not have.
const PERCUSSION_CHANNEL = 9;

const SUSTAIN_CONTROLLERS = Object.freeze({ 64: 'sustain', 66: 'sostenuto', 67: 'softPedal' });

const eventRef = (trackIndex, eventIndex) => `track:${trackIndex}/event:${eventIndex}`;

// Canonical event ranges, restated here so this adapter can decide *before*
// calling a constructor whether the source value is representable. Duplicating
// the bounds is deliberate: it lets a rejection carry a specific code and the
// offending value instead of a constructor's generic message.
const CANONICAL_LIMITS = Object.freeze({
  pitch: { min: 0, max: 127 },
  bpm: { min: 0, max: 1000 },          // min exclusive
  meterNumerator: { min: 1, max: 255 },
  meterDenominator: { min: 1, max: 1024 },
});

// Every Canonical event is created through this. A single event the schema
// cannot represent must never destroy the whole ingest: the file's remaining
// evidence is exactly what `ACCEPTANCE_CRITERIA.md` Gate 2 needs, and losing
// all of it to one malformed byte would be the silent data loss this adapter
// exists to prevent. A constructor that throws anyway — a range this module
// failed to anticipate — is caught rather than propagated, so the guarantee
// does not depend on the explicit checks being exhaustive.
function project(create, descriptor, unsupported) {
  try {
    return create();
  } catch (error) {
    unsupported.push({ ...descriptor, code: descriptor.code ?? 'CANONICAL_SCHEMA_REJECTED', message: error.message });
    return null;
  }
}

function collectTiming(decoded, warnings, unsupported) {
  const tempoPoints = [];
  const meterPoints = [];
  for (const track of decoded.tracks) {
    for (const event of track.events) {
      if (event.kind !== 'meta') continue;
      if (event.metaName === 'setTempo') {
        if (event.microsecondsPerQuarter === undefined) {
          unsupported.push({ code: 'MALFORMED_TEMPO', sourceEventIds: [eventRef(track.index, event.eventIndex)], raw: event.raw });
          continue;
        }
        if (event.microsecondsPerQuarter <= 0) {
          unsupported.push({ code: 'NON_POSITIVE_TEMPO', sourceEventIds: [eventRef(track.index, event.eventIndex)], microsecondsPerQuarter: event.microsecondsPerQuarter });
          continue;
        }
        tempoPoints.push({ tick: event.tick, trackIndex: track.index, eventIndex: event.eventIndex, microsecondsPerQuarter: event.microsecondsPerQuarter });
      } else if (event.metaName === 'timeSignature') {
        if (!event.timeSignature) {
          unsupported.push({ code: 'MALFORMED_TIME_SIGNATURE', sourceEventIds: [eventRef(track.index, event.eventIndex)], raw: event.raw });
          continue;
        }
        meterPoints.push({ tick: event.tick, trackIndex: track.index, eventIndex: event.eventIndex, ...event.timeSignature });
      }
    }
  }
  // A tick ordering is stable across tracks; ties keep track order so a
  // multi-track file with duplicate control events stays deterministic.
  const byTick = (a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex;
  tempoPoints.sort(byTick);
  meterPoints.sort(byTick);

  for (const [label, points] of [['TEMPO', tempoPoints], ['METER', meterPoints]]) {
    for (let i = 1; i < points.length; i++) {
      if (points[i].tick === points[i - 1].tick) {
        warnings.push({
          code: `DUPLICATE_${label}_AT_TICK`,
          tick: points[i].tick,
          sourceEventIds: [eventRef(points[i - 1].trackIndex, points[i - 1].eventIndex), eventRef(points[i].trackIndex, points[i].eventIndex)],
        });
      }
    }
  }
  return { tempoPoints, meterPoints };
}

// Pairs note-ons with note-offs inside one track.
//
// Two conventions matter and both are handled literally rather than guessed
// at. A note-on with velocity 0 is a note-off -- that is how most writers
// encode releases under running status, and treating it as an attack would
// invent silent zero-velocity notes. And when the same channel+pitch is struck
// again before its release, the pending attacks form a queue: the release is
// matched to the *oldest* unreleased attack (FIFO), which is the behavior
// synthesizers implement and the only one that keeps attack count equal to
// release count. LIFO would reorder durations between two legitimately
// overlapping strikes of one key.
function matchNotes(track, state) {
  const active = new Map();
  const matched = [];
  const key = (channel, note) => `${channel}:${note}`;

  for (const event of track.events) {
    if (event.kind === 'channel' && event.messageType === 'programChange') {
      const record = { program: event.program, sourceEventId: eventRef(track.index, event.eventIndex), tick: event.tick, channel: event.channel };
      state.programs.set(event.channel, record);
      state.programChanges.push(record);
      continue;
    }
    if (event.kind === 'channel' && event.messageType === 'controlChange' && SUSTAIN_CONTROLLERS[event.controller]) {
      // Recorded as evidence only. Extending a note to the pedal release is an
      // interpretation of performance, not a fact the file states, so it is
      // left to a later stage rather than baked into the baseline.
      state.pedalEvents.push({
        controller: SUSTAIN_CONTROLLERS[event.controller],
        controllerNumber: event.controller,
        channel: event.channel,
        value: event.value,
        tick: event.tick,
        sourceEventId: eventRef(track.index, event.eventIndex),
      });
      continue;
    }
    if (event.kind === 'meta' && event.metaName === 'trackName' && state.trackName === null) {
      state.trackName = event.text ?? null;
      continue;
    }
    if (event.kind !== 'channel') continue;
    if (event.messageType !== 'noteOn' && event.messageType !== 'noteOff') continue;

    const isRelease = event.messageType === 'noteOff' || event.velocity === 0;
    const id = key(event.channel, event.noteNumber);

    if (!isRelease) {
      if (!active.has(id)) active.set(id, []);
      const queue = active.get(id);
      // The program in force is captured here, at the attack. Reading it when
      // the note is released instead would let a later program change rewrite
      // the provenance of a note that already finished sounding, and would
      // give every note on the channel the file's last program.
      queue.push({ event, program: state.programs.get(event.channel) ?? null });
      if (queue.length > 1 && queue.length <= RESTRIKE_DETAIL_DEPTH) {
        state.warnings.push({
          code: 'RESTRUCK_BEFORE_RELEASE',
          trackIndex: track.index,
          channel: event.channel,
          noteNumber: event.noteNumber,
          depth: queue.length,
          sourceEventIds: queue.map(pending => eventRef(track.index, pending.event.eventIndex)),
        });
      } else if (queue.length > RESTRIKE_DETAIL_DEPTH) {
        // Past the detailed depth, one record per run of overlapping strikes,
        // updated in place: the first and the latest strike, and the deepest
        // the queue went. Listing every open strike on every new one made the
        // warnings quadratic in the strikes -- a 30 KB file of one key struck
        // 10,000 times without release exhausted the heap and took down the
        // whole service. Every strike still becomes an event or an
        // UNCLOSED_NOTE_ON, so nothing is dropped; only the listing is bounded.
        const first = eventRef(track.index, queue[0].event.eventIndex);
        const latest = eventRef(track.index, event.eventIndex);
        if (!queue.overflow) {
          queue.overflow = {
            code: 'RESTRUCK_BEFORE_RELEASE',
            trackIndex: track.index,
            channel: event.channel,
            noteNumber: event.noteNumber,
            depth: queue.length,
            sourceEventIds: [first, latest],
            listing: 'FIRST_AND_LATEST_STRIKE',
          };
          state.warnings.push(queue.overflow);
        } else {
          queue.overflow.depth = Math.max(queue.overflow.depth, queue.length);
          queue.overflow.sourceEventIds = [queue.overflow.sourceEventIds[0], latest];
        }
      }
      continue;
    }

    const queue = active.get(id);
    if (!queue || !queue.length) {
      state.unsupported.push({
        code: 'ORPHAN_NOTE_OFF',
        trackIndex: track.index,
        channel: event.channel,
        noteNumber: event.noteNumber,
        tick: event.tick,
        sourceEventIds: [eventRef(track.index, event.eventIndex)],
      });
      continue;
    }
    const pending = queue.shift();
    if (!queue.length) active.delete(id);
    matched.push({ on: pending.event, off: event, program: pending.program });
  }

  for (const [id, queue] of active) {
    const [channel, noteNumber] = id.split(':').map(Number);
    for (const pending of queue) {
      state.unsupported.push({
        code: 'UNCLOSED_NOTE_ON',
        trackIndex: track.index,
        channel,
        noteNumber,
        tick: pending.event.tick,
        sourceEventIds: [eventRef(track.index, pending.event.eventIndex)],
      });
    }
  }
  return matched;
}

// Overlapping strikes of one key are listed in full up to this depth, which
// covers every real voicing and keeps such warnings exactly as they were.
// Deeper runs are summarized (see the note-on branch in matchNotes).
export const RESTRIKE_DETAIL_DEPTH = 16;

export function ingestMIDI(input, options = {}) {
  const bytes = toBytes(input);
  const decoded = decodeMidiFile(bytes);
  const warnings = [];
  const unsupported = [];

  // Structural damage found by the decoder is evidence about the source, so it
  // is carried forward rather than re-derived or dropped.
  for (const anomaly of decoded.anomalies) {
    const target = anomaly.code === 'MISSING_END_OF_TRACK' || anomaly.code === 'UNKNOWN_CHUNK' || anomaly.code === 'EXTENDED_HEADER'
      ? warnings
      : unsupported;
    target.push({ ...anomaly, origin: 'decoder' });
  }

  // SOURCE_POLICY.md §1C: a third-party MIDI is supporting evidence until it is
  // independently confirmed, so that is the default. A caller with the evidence
  // to claim more has to say so explicitly.
  const kind = options.kind ?? 'third-party-midi';
  const source = createSource({
    id: options.sourceId ?? 'midi-source',
    label: options.label ?? 'MIDI source',
    kind,
    authority: options.authority ?? (kind === 'official-midi' ? 'primary-symbolic' : 'supporting'),
    // Identity is computed from the bytes actually parsed. A source record
    // that could carry a digest and does not makes later provenance claims
    // unverifiable, so this defaults to the real hash rather than to null; an
    // explicit option still wins for a caller that already has one.
    sha256: options.sha256 ?? sha256Hex(bytes),
    metadata: {
      adapter: MIDI_ADAPTER,
      format: decoded.format,
      declaredTrackCount: decoded.declaredTrackCount,
      trackCount: decoded.tracks.length,
      division: decoded.division,
      byteLength: decoded.byteLength,
    },
  });

  // Only formats 0 and 1 define tracks that share one timeline. Format 2's
  // tracks are independent sequences, and a format above 2 is undefined by the
  // SMF specification — its track relationship is unknown, not assumed to be
  // concurrent. Treating either as format 0/1 would assert a musical
  // relationship the file does not state, so neither projects any event.
  const knownConcurrentFormat = decoded.format === 0 || decoded.format === 1;
  if (!knownConcurrentFormat) {
    unsupported.push({
      code: decoded.format === 2 ? 'FORMAT_2_INDEPENDENT_SEQUENCES' : 'UNKNOWN_SMF_FORMAT',
      format: decoded.format,
      trackCount: decoded.tracks.length,
    });
  }

  const usableDivision = decoded.division.type === 'ppq' && decoded.division.ticksPerQuarter > 0;
  if (!usableDivision) {
    unsupported.push({
      code: decoded.division.type === 'smpte' ? 'SMPTE_DIVISION_NOT_MUSICAL_TIME' : 'UNUSABLE_DIVISION',
      division: decoded.division,
    });
  }

  const projectEvents = knownConcurrentFormat && usableDivision;
  const ppq = decoded.division.ticksPerQuarter;
  // One Canonical beat is one quarter note, matching the MusicXML adapter,
  // where a <duration> is read against <divisions> per quarter.
  const toBeat = tick => new F(tick, ppq);
  // A tick is 1/(4 x ppq) of a whole note. Recorded so a reviewer can see the
  // grid the source was encoded on without re-deriving it.
  const tickUnit = projectEvents ? new F(1, ppq).div(4) : null;

  const { tempoPoints, meterPoints } = collectTiming(decoded, warnings, unsupported);
  const events = [];
  const tempoEvents = [];
  const meterEvents = [];
  const trackSummaries = [];
  const pedalEvents = [];

  if (projectEvents) {
    for (const point of tempoPoints) {
      const sourceEventIds = [eventRef(point.trackIndex, point.eventIndex)];
      // 60,000,000 microseconds per minute. The rate is a float because BPM is
      // a rate, not a position; the exact source integer is preserved in
      // metadata so nothing depends on this division.
      const rate = MICROSECONDS_PER_MINUTE / point.microsecondsPerQuarter;
      // The integer the file's microsecond encoding states, when there is one
      // (see integerTempoForMicroseconds). A rate that is already that integer
      // (500,000 us is exactly 120) is left exactly as it always was, so only
      // a value the encoding had to round is read, and only such an event is
      // marked as read.
      const integer = integerTempoForMicroseconds(point.microsecondsPerQuarter);
      const read = integer !== null && integer !== rate;
      const bpm = read ? integer : rate;
      if (!Number.isFinite(bpm) || bpm <= CANONICAL_LIMITS.bpm.min || bpm > CANONICAL_LIMITS.bpm.max) {
        // A legal SMF tempo can sit outside the Canonical BPM range. Clamping
        // it would invent a tempo the source never stated, so the source value
        // is recorded and no tempo event is produced for it.
        unsupported.push({
          code: 'TEMPO_OUT_OF_CANONICAL_RANGE',
          trackIndex: point.trackIndex,
          tick: point.tick,
          microsecondsPerQuarter: point.microsecondsPerQuarter,
          bpm,
          limit: CANONICAL_LIMITS.bpm,
          sourceEventIds,
        });
        continue;
      }
      const event = project(() => createCanonicalTempoEvent({
        id: `${source.id}:tempo:${point.trackIndex}:${point.eventIndex}`,
        beat: String(toBeat(point.tick)),
        bpm,
        sourceIds: [source.id],
        sourceEventIds,
        metadata: {
          tick: point.tick,
          microsecondsPerQuarter: point.microsecondsPerQuarter,
          trackIndex: point.trackIndex,
          // Provenance of a read value: how it was read, and the unrounded
          // rate the stored microseconds divide to.
          ...(read ? { tempoEncoding: SMF_INTEGER_TEMPO_ENCODING, rawBpm: rate } : {}),
        },
      }), { trackIndex: point.trackIndex, tick: point.tick, sourceEventIds, target: 'tempo' }, unsupported);
      if (event) tempoEvents.push(event);
    }
    for (const point of meterPoints) {
      const sourceEventIds = [eventRef(point.trackIndex, point.eventIndex)];
      const { numerator, denominator } = point;
      const inRange = (value, limit) => Number.isInteger(value) && value >= limit.min && value <= limit.max;
      if (!inRange(numerator, CANONICAL_LIMITS.meterNumerator) || !inRange(denominator, CANONICAL_LIMITS.meterDenominator)) {
        // A time signature byte pair can encode a numerator of 0 or a
        // denominator of 2^255. Neither is representable, and substituting a
        // plausible meter would be a repair the source does not support.
        unsupported.push({
          code: 'METER_OUT_OF_CANONICAL_RANGE',
          trackIndex: point.trackIndex,
          tick: point.tick,
          numerator,
          denominator,
          limit: { numerator: CANONICAL_LIMITS.meterNumerator, denominator: CANONICAL_LIMITS.meterDenominator },
          sourceEventIds,
        });
        continue;
      }
      const event = project(() => createCanonicalMeterEvent({
        id: `${source.id}:meter:${point.trackIndex}:${point.eventIndex}`,
        beat: String(toBeat(point.tick)),
        numerator,
        denominator,
        sourceIds: [source.id],
        sourceEventIds,
        metadata: {
          tick: point.tick,
          trackIndex: point.trackIndex,
          clocksPerClick: point.clocksPerClick,
          thirtySecondsPerQuarter: point.thirtySecondsPerQuarter,
        },
      }), { trackIndex: point.trackIndex, tick: point.tick, sourceEventIds, target: 'meter' }, unsupported);
      if (event) meterEvents.push(event);
    }
  }

  for (const track of decoded.tracks) {
    // Per-track state. Program and pedal state are deliberately not shared
    // across tracks: in a format 1 file two tracks may use the same channel
    // number for unrelated parts, so letting one track's program changes reach
    // another would attribute an instrument the file never gave that note.
    const state = {
      warnings,
      unsupported,
      programs: new Map(),
      programChanges: [],
      pedalEvents: [],
      trackName: null,
    };
    const matched = matchNotes(track, state);
    pedalEvents.push(...state.pedalEvents.map(pedal => ({ ...pedal, trackIndex: track.index })));

    let noteCount = 0;
    let percussionCount = 0;

    for (const { on, off, program } of matched) {
      const sourceEventIds = [eventRef(track.index, on.eventIndex), eventRef(track.index, off.eventIndex)];

      if (on.channel === PERCUSSION_CHANNEL) {
        // MASTER_RULES.md §8. Held as evidence with full timing so a drum-aware
        // stage can map it later; never emitted as a pitched Canonical note.
        percussionCount++;
        unsupported.push({
          code: 'PERCUSSION_CHANNEL_EVENT',
          trackIndex: track.index,
          channel: on.channel,
          noteNumber: on.noteNumber,
          startTick: on.tick,
          endTick: off.tick,
          velocity: on.velocity,
          sourceEventIds,
        });
        continue;
      }

      if (!projectEvents) continue;

      if (off.tick <= on.tick) {
        // MOBILE_SYNTAX.md §4 forbids zero-duration events, and the Canonical
        // IR requires end > start. Nudging the release to make it fit would
        // invent a duration the source never stated.
        unsupported.push({
          code: off.tick === on.tick ? 'ZERO_DURATION_NOTE' : 'NEGATIVE_DURATION_NOTE',
          trackIndex: track.index,
          channel: on.channel,
          noteNumber: on.noteNumber,
          startTick: on.tick,
          endTick: off.tick,
          sourceEventIds,
        });
        continue;
      }

      if (!Number.isInteger(on.noteNumber) || on.noteNumber < CANONICAL_LIMITS.pitch.min || on.noteNumber > CANONICAL_LIMITS.pitch.max) {
        // A corrupt data byte can carry the high bit and read back above 127.
        // Masking it to 7 bits would silently invent a different pitch.
        unsupported.push({
          code: 'MALFORMED_NOTE_DATA',
          trackIndex: track.index,
          channel: on.channel,
          noteNumber: on.noteNumber,
          velocity: on.velocity,
          startTick: on.tick,
          endTick: off.tick,
          limit: CANONICAL_LIMITS.pitch,
          sourceEventIds,
        });
        continue;
      }

      const event = project(() => createCanonicalNoteEvent({
        id: `${source.id}:note:${track.index}:${on.eventIndex}`,
        pitch: on.noteNumber,
        start: String(toBeat(on.tick)),
        end: String(toBeat(off.tick)),
        sourceIds: [source.id],
        sourceEventIds,
        role: null,
        // The independent line a MIDI event belongs to is identified by its
        // track and channel together; neither alone is unambiguous across
        // format 0 and format 1 files.
        voice: `track:${track.index}/channel:${on.channel}`,
        // Left null deliberately. MIDI velocity is 0-127 and Canonical volume
        // is the Mobile 0-15 scale; mapping between them is a Mobile
        // adaptation under ACCEPTANCE_CRITERIA.md Gate 8, not an intake fact.
        // The source velocity is preserved in metadata instead.
        volume: null,
        tags: ['source-faithful'],
        metadata: {
          trackIndex: track.index,
          trackName: state.trackName,
          channel: on.channel,
          program: program?.program ?? null,
          programSourceEventId: program?.sourceEventId ?? null,
          velocity: on.velocity,
          releaseVelocity: off.messageType === 'noteOff' ? off.velocity : null,
          releaseEncoding: off.messageType === 'noteOff' ? 'note-off' : 'note-on-velocity-0',
          startTick: on.tick,
          endTick: off.tick,
          ticksPerQuarter: ppq,
          // MIDI notates both endpoints and states no length, so the duration
          // is the derived component here -- the mirror image of MusicXML,
          // where the length is notated and the endpoints are positional.
          timing: createTimingProvenance({
            adapter: MIDI_ADAPTER,
            start: { origin: 'source-notated', unit: tickUnit },
            duration: { origin: 'source-derived' },
            end: { origin: 'source-notated', unit: tickUnit },
          }),
        },
      }), { trackIndex: track.index, channel: on.channel, noteNumber: on.noteNumber, startTick: on.tick, endTick: off.tick, sourceEventIds, target: 'note' }, unsupported);
      if (event) {
        events.push(event);
        noteCount++;
      }
    }

    trackSummaries.push(Object.freeze({
      index: track.index,
      name: state.trackName,
      rawEvents: track.events.length,
      noteEvents: noteCount,
      percussionEvents: percussionCount,
      channels: Object.freeze([...new Set(track.events.filter(e => e.kind === 'channel').map(e => e.channel))].sort((a, b) => a - b)),
      // Every program change in order, not a last-wins map: a channel that
      // switches instrument mid-track has more than one answer, and a summary
      // that kept only the last would misdescribe the notes before it.
      programChanges: Object.freeze(state.programChanges.map(change => Object.freeze({
        channel: change.channel,
        program: change.program,
        tick: change.tick,
        sourceEventId: change.sourceEventId,
      }))),
      endTick: track.endTick,
      endBeat: projectEvents ? String(toBeat(track.endTick)) : null,
      sawEndOfTrack: track.sawEndOfTrack,
    }));
  }

  // Canonical order is by onset. Ties break on pitch then id so that two runs
  // over the same bytes always produce the same array.
  events.sort((a, b) => f(a.start).cmp(b.start) || a.pitch - b.pitch || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return Object.freeze({
    source,
    // A track name is evidence and is preserved verbatim in `tracks`, but a
    // blank one cannot become the project title: createCanonicalProject rejects
    // a whitespace-only title, which would throw away a fully parsed file over
    // a legal SMF text meta event. Only a name with actual content is a title.
    title: options.title ?? trackSummaries.find(track => track.name?.trim())?.name.trim() ?? source.label,
    complete: unsupported.length === 0,
    events: Object.freeze(events),
    tempoEvents: Object.freeze(tempoEvents),
    meterEvents: Object.freeze(meterEvents),
    tracks: Object.freeze(trackSummaries),
    pedalEvents: Object.freeze(pedalEvents.map(Object.freeze)),
    warnings: Object.freeze(warnings.map(Object.freeze)),
    unsupported: Object.freeze(unsupported.map(Object.freeze)),
    raw: decoded,
  });
}

export function midiFragmentToProject(fragment, options = {}) {
  if (!fragment?.source || !Array.isArray(fragment.events)) throw Error('invalid MIDI fragment');
  return createCanonicalProject({
    id: options.id ?? `${fragment.source.id}-project`,
    title: options.title ?? (fragment.title?.trim() ? fragment.title : fragment.source.label),
    sources: [fragment.source],
    events: [...fragment.events],
    tempoEvents: [...fragment.tempoEvents],
    meterEvents: [...fragment.meterEvents],
    metadata: {
      ingestion: 'midi-v1',
      sourceComplete: fragment.complete,
      warnings: [...fragment.warnings],
      unsupported: [...fragment.unsupported],
      tracks: [...fragment.tracks],
      pedalEvents: [...fragment.pedalEvents],
    },
  });
}
