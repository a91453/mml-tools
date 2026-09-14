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
import { decodeMidiFile } from './midi-file.mjs';

const MIDI_ADAPTER = 'studio/backend/source/midi.mjs';

// General MIDI reserves channel 10 (index 9) for percussion. `MASTER_RULES.md`
// §8 is explicit that these note numbers are drum-kit selectors, not pitches,
// and must not leak into pitched instruments. They are therefore recorded as
// evidence and never emitted as Canonical note events; mapping them to Mobile
// drum-face positions needs evidence this adapter does not have.
const PERCUSSION_CHANNEL = 9;

const SUSTAIN_CONTROLLERS = Object.freeze({ 64: 'sustain', 66: 'sostenuto', 67: 'softPedal' });

const eventRef = (trackIndex, eventIndex) => `track:${trackIndex}/event:${eventIndex}`;

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
      state.programs.set(event.channel, { program: event.program, sourceEventId: eventRef(track.index, event.eventIndex) });
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
      queue.push(event);
      if (queue.length > 1) {
        state.warnings.push({
          code: 'RESTRUCK_BEFORE_RELEASE',
          trackIndex: track.index,
          channel: event.channel,
          noteNumber: event.noteNumber,
          depth: queue.length,
          sourceEventIds: queue.map(pending => eventRef(track.index, pending.eventIndex)),
        });
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
    const onEvent = queue.shift();
    if (!queue.length) active.delete(id);
    matched.push({ on: onEvent, off: event });
  }

  for (const [id, queue] of active) {
    const [channel, noteNumber] = id.split(':').map(Number);
    for (const pending of queue) {
      state.unsupported.push({
        code: 'UNCLOSED_NOTE_ON',
        trackIndex: track.index,
        channel,
        noteNumber,
        tick: pending.tick,
        sourceEventIds: [eventRef(track.index, pending.eventIndex)],
      });
    }
  }
  return matched;
}

export function ingestMIDI(input, options = {}) {
  const decoded = decodeMidiFile(input);
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
    sha256: options.sha256 ?? null,
    metadata: {
      adapter: MIDI_ADAPTER,
      format: decoded.format,
      declaredTrackCount: decoded.declaredTrackCount,
      trackCount: decoded.tracks.length,
      division: decoded.division,
      byteLength: decoded.byteLength,
    },
  });

  if (decoded.format === 2) {
    // Format 2 tracks are independent sequences, not concurrent parts. Laying
    // them on one timeline would assert a musical relationship the file does
    // not state, so no events are projected.
    unsupported.push({ code: 'FORMAT_2_INDEPENDENT_SEQUENCES', format: 2, trackCount: decoded.tracks.length });
  }

  const usableDivision = decoded.division.type === 'ppq' && decoded.division.ticksPerQuarter > 0;
  if (!usableDivision) {
    unsupported.push({
      code: decoded.division.type === 'smpte' ? 'SMPTE_DIVISION_NOT_MUSICAL_TIME' : 'UNUSABLE_DIVISION',
      division: decoded.division,
    });
  }

  const projectEvents = decoded.format !== 2 && usableDivision;
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
      tempoEvents.push(createCanonicalTempoEvent({
        id: `${source.id}:tempo:${point.trackIndex}:${point.eventIndex}`,
        beat: String(toBeat(point.tick)),
        // 60,000,000 microseconds per minute. Kept as a float because BPM is a
        // rate, not a position; the exact source integer is preserved in
        // metadata so nothing depends on this rounding.
        bpm: 60000000 / point.microsecondsPerQuarter,
        sourceIds: [source.id],
        sourceEventIds: [eventRef(point.trackIndex, point.eventIndex)],
        metadata: { tick: point.tick, microsecondsPerQuarter: point.microsecondsPerQuarter, trackIndex: point.trackIndex },
      }));
    }
    for (const point of meterPoints) {
      meterEvents.push(createCanonicalMeterEvent({
        id: `${source.id}:meter:${point.trackIndex}:${point.eventIndex}`,
        beat: String(toBeat(point.tick)),
        numerator: point.numerator,
        denominator: point.denominator,
        sourceIds: [source.id],
        sourceEventIds: [eventRef(point.trackIndex, point.eventIndex)],
        metadata: {
          tick: point.tick,
          trackIndex: point.trackIndex,
          clocksPerClick: point.clocksPerClick,
          thirtySecondsPerQuarter: point.thirtySecondsPerQuarter,
        },
      }));
    }
  }

  for (const track of decoded.tracks) {
    const state = {
      warnings,
      unsupported,
      programs: new Map(),
      pedalEvents: [],
      trackName: null,
    };
    const matched = matchNotes(track, state);
    pedalEvents.push(...state.pedalEvents.map(pedal => ({ ...pedal, trackIndex: track.index })));

    let noteCount = 0;
    let percussionCount = 0;

    for (const { on, off } of matched) {
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

      const program = state.programs.get(on.channel) ?? null;
      events.push(createCanonicalNoteEvent({
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
      }));
      noteCount++;
    }

    trackSummaries.push(Object.freeze({
      index: track.index,
      name: state.trackName,
      rawEvents: track.events.length,
      noteEvents: noteCount,
      percussionEvents: percussionCount,
      channels: Object.freeze([...new Set(track.events.filter(e => e.kind === 'channel').map(e => e.channel))].sort((a, b) => a - b)),
      programs: Object.freeze([...state.programs.entries()].map(([channel, value]) => Object.freeze({ channel, program: value.program }))),
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
    title: options.title ?? trackSummaries.find(track => track.name)?.name ?? source.label,
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
    title: options.title ?? fragment.title ?? fragment.source.label,
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
