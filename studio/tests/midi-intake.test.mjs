import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMidiFile,
  ingestMIDI,
  midiFragmentToProject,
  MIDI_INGESTION_STATUS,
  sha256Hex,
} from '../backend/source/index.mjs';
import { DEMO, validateMML, writeMidi, f } from '../../dist/core.js';

// Fixtures are built from raw bytes rather than from another library so that
// each test states exactly which encoding it is asserting about. A helper that
// "fixed up" malformed input would hide the very cases these tests exist for.

const vlq = value => {
  const out = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    out.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  return out;
};

const be = (value, bytes) => Array.from({ length: bytes }, (_, i) => (value >> ((bytes - 1 - i) * 8)) & 0xff);

const chunk = (type, body) => [...Array.from(type, c => c.charCodeAt(0)), ...be(body.length, 4), ...body];

// Each entry is [deltaTicks, ...messageBytes]; End of Track is appended unless
// `omitEndOfTrack` is set, so a test can assert on its absence.
const buildTrack = (entries, { omitEndOfTrack = false } = {}) => {
  const body = entries.flatMap(([delta, ...bytes]) => [...vlq(delta), ...bytes]);
  if (!omitEndOfTrack) body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return chunk('MTrk', body);
};

const buildMidi = ({ format = 1, division = 480, tracks }) => new Uint8Array([
  ...chunk('MThd', [...be(format, 2), ...be(tracks.length, 2), ...be(division, 2)]),
  ...tracks.flat(),
]);

const noteOn = (channel, note, velocity) => [0x90 | channel, note, velocity];
const noteOff = (channel, note, velocity = 0x40) => [0x80 | channel, note, velocity];
const meta = (type, data) => [0xff, type, data.length, ...data];
const setTempo = us => meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
const timeSig = (num, denPow2, clocks = 24, thirtySeconds = 8) => meta(0x58, [num, denPow2, clocks, thirtySeconds]);

const simple = (entries, opts = {}) => buildMidi({
  format: 0,
  division: opts.division ?? 480,
  tracks: [buildTrack(entries, opts)],
});

const ingest = (bytes, options = {}) => ingestMIDI(bytes, { sourceId: 'fixture', label: 'Fixture', ...options });

test('a minimal note is projected with exact rational beats and both endpoints notated', () => {
  const fragment = ingest(simple([
    [0, ...setTempo(500000)],
    [0, ...timeSig(4, 2)],
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
  ]));

  assert.equal(fragment.complete, true);
  assert.equal(fragment.events.length, 1);
  const [note] = fragment.events;
  assert.equal(note.pitch, 60);
  assert.equal(note.start, '0');
  assert.equal(note.end, '1');
  assert.equal(note.metadata.velocity, 100);
  // MIDI states both endpoints and no length, so duration is the derived one.
  assert.equal(note.metadata.timing.start.origin, 'source-notated');
  assert.equal(note.metadata.timing.end.origin, 'source-notated');
  assert.equal(note.metadata.timing.duration.origin, 'source-derived');
  assert.equal(fragment.tempoEvents.length, 1);
  assert.equal(fragment.tempoEvents[0].bpm, 120);
  assert.deepEqual(
    [fragment.meterEvents[0].numerator, fragment.meterEvents[0].denominator],
    [4, 4],
  );
});

test('beats stay exact where the tick grid does not divide evenly', () => {
  // A triplet eighth at 480 ppq is 160 ticks: 1/3 of a quarter. Any float
  // conversion would produce 0.3333... and lose the identity of the value.
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [160, ...noteOff(0, 60)],
    [0, ...noteOn(0, 62, 100)],
    [160, ...noteOff(0, 62)],
  ]));
  assert.deepEqual(fragment.events.map(e => [e.start, e.end]), [['0', '1/3'], ['1/3', '2/3']]);
});

test('every Canonical note points back at the raw note-on and note-off it came from', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
  ]));
  const [note] = fragment.events;
  assert.equal(note.sourceEventIds.length, 2);
  const [onRef, offRef] = note.sourceEventIds.map(ref => Number(ref.split('event:')[1]));
  const raw = fragment.raw.tracks[0].events;
  assert.equal(raw[onRef].messageType, 'noteOn');
  assert.equal(raw[offRef].messageType, 'noteOff');
  assert.equal(raw[onRef].tick, note.metadata.startTick);
  assert.equal(raw[offRef].tick, note.metadata.endTick);
});

test('a note-on with velocity 0 is a release, not a silent attack', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOn(0, 60, 0)],
  ]));
  assert.equal(fragment.complete, true);
  assert.equal(fragment.events.length, 1);
  assert.equal(fragment.events[0].end, '1');
  assert.equal(fragment.events[0].metadata.releaseEncoding, 'note-on-velocity-0');
});

test('running status is expanded and does not change the decoded events', () => {
  // Second note-on omits the 0x90 status byte and inherits it.
  const withRunning = ingest(simple([
    [0, 0x90, 60, 100],
    [0, 64, 100],
    [480, ...noteOff(0, 60)],
    [0, ...noteOff(0, 64)],
  ]));
  const explicit = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [0, ...noteOn(0, 64, 100)],
    [480, ...noteOff(0, 60)],
    [0, ...noteOff(0, 64)],
  ]));
  assert.equal(withRunning.complete, true);
  assert.deepEqual(
    withRunning.events.map(e => [e.pitch, e.start, e.end]),
    explicit.events.map(e => [e.pitch, e.start, e.end]),
  );
  assert.equal(withRunning.raw.tracks[0].events[1].runningStatus, true);
});

test('a key restruck before its release matches oldest-first and keeps both notes', () => {
  // Two overlapping strikes of the same key: on at 0, on at 240, off at 480,
  // off at 720. FIFO gives 0-480 and 240-720. LIFO would give 0-720 and
  // 240-480, swapping the two durations.
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [240, ...noteOn(0, 60, 90)],
    [240, ...noteOff(0, 60)],
    [240, ...noteOff(0, 60)],
  ]));
  assert.equal(fragment.events.length, 2);
  assert.deepEqual(
    fragment.events.map(e => [e.start, e.end, e.metadata.velocity]),
    [['0', '1'], ['1/2', '3/2']].map((pair, i) => [...pair, [100, 90][i]]),
  );
  const restruck = fragment.warnings.find(w => w.code === 'RESTRUCK_BEFORE_RELEASE');
  assert.ok(restruck, 'the overlap is reported rather than silently resolved');
  assert.equal(restruck.depth, 2);
});

test('an unmatched note-off is recorded as evidence instead of being dropped', () => {
  const fragment = ingest(simple([[0, ...noteOff(0, 60)]]));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 0);
  const orphan = fragment.unsupported.find(u => u.code === 'ORPHAN_NOTE_OFF');
  assert.equal(orphan.noteNumber, 60);
  assert.equal(orphan.sourceEventIds.length, 1);
});

test('a note-on that is never released is recorded rather than given an invented end', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOn(0, 64, 100)],
    [480, ...noteOff(0, 64)],
  ]));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 1, 'only the closed note is projected');
  const unclosed = fragment.unsupported.find(u => u.code === 'UNCLOSED_NOTE_ON');
  assert.equal(unclosed.noteNumber, 60);
  assert.equal(unclosed.tick, 0);
});

test('a zero-duration note is refused rather than widened to fit the IR', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [0, ...noteOff(0, 60)],
  ]));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 0);
  assert.equal(fragment.unsupported.find(u => u.code === 'ZERO_DURATION_NOTE').startTick, 0);
});

test('percussion channel events never become pitched Canonical notes', () => {
  // MASTER_RULES.md §8: GM drum numbers are kit selectors, not pitches.
  const fragment = ingest(simple([
    [0, ...noteOn(9, 36, 100)],
    [240, ...noteOff(9, 36)],
    [0, ...noteOn(0, 60, 100)],
    [240, ...noteOff(0, 60)],
  ]));
  assert.equal(fragment.complete, false);
  assert.deepEqual(fragment.events.map(e => e.pitch), [60]);
  const drum = fragment.unsupported.find(u => u.code === 'PERCUSSION_CHANNEL_EVENT');
  assert.equal(drum.noteNumber, 36);
  assert.equal(drum.channel, 9);
  // Timing is retained so a drum-aware stage can still use it later.
  assert.deepEqual([drum.startTick, drum.endTick], [0, 240]);
  assert.equal(fragment.tracks[0].percussionEvents, 1);
});

test('unknown meta events and SysEx survive as evidence with their raw bytes', () => {
  const bytes = simple([
    [0, 0xff, 0x60, 0x02, 0xde, 0xad],           // undefined meta type 0x60
    [0, 0xf0, 0x03, 0x7e, 0x7f, 0x09],           // SysEx
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
  ]);
  const decoded = decodeMidiFile(bytes);
  const unknownMeta = decoded.tracks[0].events.find(e => e.metaType === 0x60);
  assert.equal(unknownMeta.metaName, null, 'unnamed, but still present');
  assert.equal(unknownMeta.raw, 'dead');
  const sysex = decoded.tracks[0].events.find(e => e.kind === 'sysex');
  assert.equal(sysex.raw, '7e7f09');
  assert.equal(sysex.sysexType, 'normal');
  // The note is unaffected; an unrecognized event is not a reason to fail.
  const fragment = ingest(bytes);
  assert.equal(fragment.events.length, 1);
  assert.ok(decoded.anomalies.some(a => a.code === 'UNKNOWN_META_TYPE'));
});

test('a text meta event keeps bytes that are not valid UTF-8', () => {
  // 0xFF 0x01 with a lone 0x80 byte: invalid UTF-8, valid SMF text.
  const decoded = decodeMidiFile(simple([[0, 0xff, 0x01, 0x02, 0x41, 0x80]]));
  const text = decoded.tracks[0].events.find(e => e.metaName === 'text');
  assert.equal(text.raw, '4180');
  assert.equal(text.text.length, 2);
});

test('SMPTE division is refused because it is absolute time, not musical time', () => {
  // 0xE728 = 25 fps, 40 ticks per frame.
  const fragment = ingest(buildMidi({
    format: 0,
    division: 0xe728,
    tracks: [buildTrack([[0, ...noteOn(0, 60, 100)], [480, ...noteOff(0, 60)]])],
  }));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 0);
  assert.ok(fragment.unsupported.some(u => u.code === 'SMPTE_DIVISION_NOT_MUSICAL_TIME'));
  assert.equal(fragment.source.metadata.division.type, 'smpte');
  assert.equal(fragment.source.metadata.division.framesPerSecond, 25);
});

test('format 2 sequences are not laid onto one shared timeline', () => {
  const fragment = ingest(buildMidi({
    format: 2,
    tracks: [
      buildTrack([[0, ...noteOn(0, 60, 100)], [480, ...noteOff(0, 60)]]),
      buildTrack([[0, ...noteOn(0, 64, 100)], [480, ...noteOff(0, 64)]]),
    ],
  }));
  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 0);
  assert.ok(fragment.unsupported.some(u => u.code === 'FORMAT_2_INDEPENDENT_SEQUENCES'));
});

test('sustain pedal is recorded as evidence and does not extend any note', () => {
  const fragment = ingest(simple([
    [0, 0xb0, 64, 127],                 // pedal down
    [0, ...noteOn(0, 60, 100)],
    [240, ...noteOff(0, 60)],
    [240, 0xb0, 64, 0],                 // pedal up, well after the release
  ]));
  assert.equal(fragment.complete, true);
  // The written release stands: 240 ticks, not extended to the pedal release.
  assert.equal(fragment.events[0].end, '1/2');
  assert.equal(fragment.pedalEvents.length, 2);
  assert.deepEqual(fragment.pedalEvents.map(p => [p.controller, p.value]), [['sustain', 127], ['sustain', 0]]);
  assert.equal(MIDI_INGESTION_STATUS.sustainPedalNoteExtension, false);
});

test('a missing End of Track is reported but the decoded events are kept', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
  ], { omitEndOfTrack: true }));
  assert.equal(fragment.events.length, 1, 'evidence survives the structural fault');
  assert.ok(fragment.warnings.some(w => w.code === 'MISSING_END_OF_TRACK'));
});

test('a truncated track keeps everything decoded before the damage', () => {
  // A note-on whose second data byte is cut off mid-event.
  const body = [...vlq(0), ...noteOn(0, 60, 100), ...vlq(480), ...noteOff(0, 60), ...vlq(0), 0x90, 64];
  const bytes = new Uint8Array([
    ...chunk('MThd', [...be(0, 2), ...be(1, 2), ...be(480, 2)]),
    ...chunk('MTrk', body),
  ]);
  const fragment = ingest(bytes);
  assert.equal(fragment.events.length, 1, 'the complete note before the truncation is kept');
  assert.equal(fragment.complete, false);
  assert.ok(fragment.unsupported.some(u => u.code === 'TRACK_TRUNCATED'));
});

test('velocity is preserved as source evidence and never mapped to Mobile volume', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 127)],
    [480, ...noteOff(0, 60, 64)],
  ]));
  const [note] = fragment.events;
  assert.equal(note.volume, null, 'Mobile 0-15 volume is a Gate 8 adaptation, not an intake fact');
  assert.equal(note.metadata.velocity, 127);
  assert.equal(note.metadata.releaseVelocity, 64);
  assert.equal(MIDI_INGESTION_STATUS.velocityToMobileVolume, false);
});

test('multi-track files keep track and channel identity without merging lines', () => {
  const fragment = ingest(buildMidi({
    format: 1,
    tracks: [
      buildTrack([[0, ...meta(0x03, [0x4c, 0x65, 0x61, 0x64])], [0, ...setTempo(500000)]]),
      buildTrack([[0, 0xc1, 40], [0, ...noteOn(1, 72, 100)], [480, ...noteOff(1, 72)]]),
      buildTrack([[0, 0xc2, 33], [0, ...noteOn(2, 48, 80)], [480, ...noteOff(2, 48)]]),
    ],
  }));
  assert.equal(fragment.complete, true);
  assert.deepEqual(fragment.events.map(e => e.voice), ['track:2/channel:2', 'track:1/channel:1']);
  assert.deepEqual(fragment.events.map(e => e.metadata.program), [33, 40]);
  assert.equal(fragment.tracks[0].name, 'Lead');
  assert.equal(MIDI_INGESTION_STATUS.trackMerging, false);
  assert.equal(MIDI_INGESTION_STATUS.voiceSplitting, false);
});

test('a real generated MIDI file round-trips into a complete Canonical project', () => {
  const song = validateMML(DEMO, { meterText: '0 4/4\n8 2/4\n10 4/4' }).song;
  const fragment = ingest(writeMidi(song), { sourceId: 'demo', kind: 'third-party-midi' });

  assert.equal(fragment.complete, true);
  assert.deepEqual(fragment.warnings, []);
  assert.deepEqual(fragment.unsupported, []);

  const expectedNotes = song.tracks.reduce((total, track) => total + track.events.length, 0);
  assert.equal(fragment.events.length, expectedNotes, 'every source note survives intake');
  assert.equal(fragment.tempoEvents.length, song.tempo.length);
  assert.equal(fragment.meterEvents.length, song.meter.length);

  // Onsets and endpoints match the source model exactly, as rationals.
  const sourcePitches = song.tracks.flatMap(t => t.events.map(e => `${e.pitch}@${e.start}-${e.end}`)).sort();
  const intakePitches = fragment.events.map(e => `${e.pitch}@${e.start}-${e.end}`).sort();
  assert.deepEqual(intakePitches, sourcePitches);

  const project = midiFragmentToProject(fragment);
  assert.equal(project.schema, 'mabinogi-mobile-mml-studio/canonical-project@2');
  assert.equal(project.events.length, expectedNotes);
  assert.equal(project.metadata.sourceComplete, true);
  assert.equal(project.sources[0].authority, 'supporting');
});

test('events are ordered deterministically and ingest is byte-for-byte repeatable', () => {
  const bytes = writeMidi(validateMML(DEMO, { meterText: '0 4/4\n8 2/4\n10 4/4' }).song);
  const first = ingest(bytes, { sourceId: 'demo' });
  const second = ingest(bytes, { sourceId: 'demo' });
  // Onsets are non-decreasing, and equal onsets are ordered by pitch.
  for (let i = 1; i < first.events.length; i++) {
    const previous = first.events[i - 1];
    const current = first.events[i];
    const order = f(previous.start).cmp(current.start);
    assert.ok(order <= 0, `event ${i} starts before its predecessor`);
    if (order === 0) assert.ok(previous.pitch <= current.pitch, `equal onsets at ${i} are not pitch-ordered`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(second.events)), JSON.parse(JSON.stringify(first.events)));
  assert.deepEqual(JSON.parse(JSON.stringify(second.tracks)), JSON.parse(JSON.stringify(first.tracks)));
});

// --- P1-1: effective program at note onset -------------------------------
//
// The program a note sounds with is the one in force when it is struck. Reading
// the channel's program after the whole track has been walked gives every note
// the file's last program, and lets a program change that happens after a note
// has already been released rewrite that note's provenance.

const programChange = (channel, program) => [0xc0 | channel, program];

test('a note keeps the program in force at its onset, not the channel final program', () => {
  const fragment = ingest(simple([
    [0, ...programChange(0, 0)],
    [0, ...noteOn(0, 60, 100)],
    [480, ...programChange(0, 41)],
    [0, ...noteOff(0, 60)],
    [0, ...noteOn(0, 62, 100)],
    [480, ...noteOff(0, 62)],
  ]));

  assert.equal(fragment.complete, true);
  const c4 = fragment.events.find(e => e.pitch === 60);
  const d4 = fragment.events.find(e => e.pitch === 62);
  assert.equal(c4.metadata.program, 0, 'C4 was struck under program 0');
  assert.equal(d4.metadata.program, 41, 'D4 was struck under program 41');
  // Provenance points at the program change actually in force, not the last one.
  assert.notEqual(c4.metadata.programSourceEventId, d4.metadata.programSourceEventId);
});

test('a program change after a note is released does not rewrite that note', () => {
  const fragment = ingest(simple([
    [0, ...programChange(0, 0)],
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
    [0, ...programChange(0, 41)],
  ]));
  assert.equal(fragment.events.length, 1);
  assert.equal(fragment.events[0].metadata.program, 0);
  // The trailing change is still recorded as evidence, just not applied backwards.
  assert.deepEqual(fragment.tracks[0].programChanges.map(c => c.program), [0, 41]);
});

test('a note struck before any program change has no program rather than a later one', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
    [0, ...programChange(0, 41)],
  ]));
  assert.equal(fragment.events[0].metadata.program, null);
  assert.equal(fragment.events[0].metadata.programSourceEventId, null);
});

test('program state on the same channel does not leak between tracks', () => {
  // Both tracks use channel 0. Track 1 sets program 41; track 2 sets none.
  // Track 2's note must not inherit track 1's instrument.
  const fragment = ingest(buildMidi({
    format: 1,
    tracks: [
      buildTrack([[0, ...setTempo(500000)]]),
      buildTrack([[0, ...programChange(0, 41)], [0, ...noteOn(0, 72, 100)], [480, ...noteOff(0, 72)]]),
      buildTrack([[0, ...noteOn(0, 48, 100)], [480, ...noteOff(0, 48)]]),
    ],
  }));
  assert.equal(fragment.complete, true);
  assert.equal(fragment.events.find(e => e.pitch === 72).metadata.program, 41);
  assert.equal(fragment.events.find(e => e.pitch === 48).metadata.program, null, 'track 3 did not inherit track 2 program state');
});

test('each restruck note keeps the program in force at its own onset', () => {
  // Same key struck twice with a program change between the two attacks; FIFO
  // pairing must carry each attack's own program, not one shared value.
  const fragment = ingest(simple([
    [0, ...programChange(0, 5)],
    [0, ...noteOn(0, 60, 100)],
    [240, ...programChange(0, 60)],
    [0, ...noteOn(0, 60, 90)],
    [240, ...noteOff(0, 60)],
    [240, ...noteOff(0, 60)],
  ]));
  assert.equal(fragment.events.length, 2);
  const byOnset = [...fragment.events].sort((a, b) => f(a.start).cmp(b.start));
  assert.deepEqual(byOnset.map(e => e.metadata.program), [5, 60]);
});

test('MIDI_INGESTION_STATUS.programChangeProvenance is backed by onset snapshotting', () => {
  assert.equal(MIDI_INGESTION_STATUS.programChangeProvenance, true);
  assert.equal(MIDI_INGESTION_STATUS.programAtNoteOnset, true);
});

// --- P1-2: a rejected event must not abort the ingest ---------------------
//
// The Canonical constructors validate their own ranges and throw. A legal SMF
// can hold values outside those ranges, and a corrupt one certainly can. If a
// single such event propagated its throw, the whole file's evidence would be
// lost -- the opposite of what Gate 2 needs.

const rawTempo = (b0, b1, b2) => [0xff, 0x51, 0x03, b0, b1, b2];
const rawTimeSig = (num, denPow2) => [0xff, 0x58, 0x04, num, denPow2, 24, 8];

test('a note whose pitch byte exceeds 127 is refused without aborting the ingest', () => {
  const fragment = ingest(simple([
    [0, ...noteOn(0, 60, 100)],
    [0, 0x90, 0x99, 100],            // corrupt: data byte carries the high bit
    [480, 0x80, 0x99, 0x40],
    [0, ...noteOff(0, 60)],
    [0, ...noteOn(0, 64, 100)],
    [480, ...noteOff(0, 64)],
  ]));

  assert.equal(fragment.complete, false);
  assert.deepEqual(fragment.events.map(e => e.pitch).sort((a, b) => a - b), [60, 64], 'both valid notes survive');
  const bad = fragment.unsupported.find(u => u.code === 'MALFORMED_NOTE_DATA');
  assert.equal(bad.noteNumber, 0x99);
  assert.deepEqual(bad.limit, { min: 0, max: 127 });
  assert.equal(bad.sourceEventIds.length, 2, 'the rejected note still names its raw events');
});

test('a tempo outside the Canonical BPM range is refused, not clamped', () => {
  const fragment = ingest(simple([
    [0, ...setTempo(500000)],        // 120 bpm, valid
    [0, ...noteOn(0, 60, 100)],
    [480, ...rawTempo(0x00, 0x00, 0x01)],  // 1 us/quarter -> 60,000,000 bpm
    [0, ...noteOff(0, 60)],
  ]));

  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 1, 'the note survives');
  assert.deepEqual(fragment.tempoEvents.map(t => t.bpm), [120], 'the valid tempo survives');
  const bad = fragment.unsupported.find(u => u.code === 'TEMPO_OUT_OF_CANONICAL_RANGE');
  assert.equal(bad.microsecondsPerQuarter, 1);
  assert.equal(bad.bpm, 60000000, 'the source value is reported as-is, not clamped to the limit');
  assert.equal(fragment.tempoEvents.some(t => t.bpm === 1000), false, 'no clamped substitute was emitted');
});

test('a time signature with numerator 0 is refused while valid meters survive', () => {
  const fragment = ingest(simple([
    [0, ...timeSig(4, 2)],
    [0, ...noteOn(0, 60, 100)],
    [480, ...rawTimeSig(0x00, 0x02)],   // numerator 0
    [0, ...noteOff(0, 60)],
  ]));

  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 1);
  assert.deepEqual(fragment.meterEvents.map(m => [m.numerator, m.denominator]), [[4, 4]]);
  const bad = fragment.unsupported.find(u => u.code === 'METER_OUT_OF_CANONICAL_RANGE');
  assert.equal(bad.numerator, 0);
});

test('a time signature denominator beyond the Canonical range is refused', () => {
  const fragment = ingest(simple([
    [0, ...rawTimeSig(0x04, 0xff)],     // 2^255
    [0, ...noteOn(0, 60, 100)],
    [480, ...noteOff(0, 60)],
  ]));

  assert.equal(fragment.complete, false);
  assert.equal(fragment.events.length, 1, 'the note is unaffected by the bad meter');
  assert.equal(fragment.meterEvents.length, 0);
  const bad = fragment.unsupported.find(u => u.code === 'METER_OUT_OF_CANONICAL_RANGE');
  assert.equal(bad.denominator, 2 ** 255);
  assert.equal(bad.limit.denominator.max, 1024);
});

test('a file mixing valid and unrepresentable events keeps every valid piece of evidence', () => {
  // One file carrying all four rejection classes alongside good data. The point
  // of the test is the survivors, not the rejections.
  const fragment = ingest(simple([
    [0, ...setTempo(500000)],              // valid tempo   120 bpm
    [0, ...timeSig(3, 2)],                 // valid meter   3/4
    [0, ...programChange(0, 7)],
    [0, ...noteOn(0, 60, 100)],            // valid note    C4
    [0, ...rawTempo(0x00, 0x00, 0x01)],    // INVALID tempo
    [0, ...rawTimeSig(0x00, 0x02)],        // INVALID meter (numerator 0)
    [0, 0x90, 0x88, 100],                  // INVALID note  (pitch 136)
    [480, 0x80, 0x88, 0x40],
    [0, ...noteOff(0, 60)],
    [0, ...noteOn(0, 67, 90)],             // valid note    G4
    [480, ...noteOff(0, 67)],
    [0, ...setTempo(400000)],              // valid tempo   150 bpm
  ]));

  assert.equal(fragment.complete, false, 'the file is not complete');

  // Everything representable is still here.
  assert.deepEqual(fragment.events.map(e => e.pitch).sort((a, b) => a - b), [60, 67]);
  assert.deepEqual(fragment.tempoEvents.map(t => t.bpm), [120, 150]);
  assert.deepEqual(fragment.meterEvents.map(m => [m.numerator, m.denominator]), [[3, 4]]);
  assert.equal(fragment.events.find(e => e.pitch === 60).metadata.program, 7);

  // And each rejection is individually accounted for.
  assert.deepEqual(
    ['MALFORMED_NOTE_DATA', 'TEMPO_OUT_OF_CANONICAL_RANGE', 'METER_OUT_OF_CANONICAL_RANGE']
      .map(code => fragment.unsupported.some(u => u.code === code)),
    [true, true, true],
  );

  // The raw decode still holds every byte, including the rejected events.
  const rawKinds = fragment.raw.tracks[0].events.filter(e => e.metaName === 'setTempo').length;
  assert.equal(rawKinds, 3, 'all three tempo metas remain in the raw evidence');

  // The project builds from what survived.
  const project = midiFragmentToProject(fragment);
  assert.equal(project.events.length, 2);
  assert.equal(project.metadata.sourceComplete, false);
});

test('an ingest never throws on any malformed event the decoder can still read', () => {
  // The explicit range checks are not assumed to be exhaustive; the projection
  // guard must hold for anything they miss.
  for (const entries of [
    [[0, 0x90, 0xff, 0xff], [480, 0x80, 0xff, 0x40]],
    [[0, ...rawTempo(0x00, 0x00, 0x00)]],
    [[0, ...rawTempo(0xff, 0xff, 0xff)]],
    [[0, ...rawTimeSig(0xff, 0xfe)]],
    [[0, 0xff, 0x58, 0x00]],
    [[0, 0xff, 0x51, 0x00]],
  ]) {
    const fragment = ingest(simple(entries));
    assert.equal(typeof fragment.complete, 'boolean');
    assert.ok(Array.isArray(fragment.unsupported));
  }
});

// --- P2: evidence completeness and source identity -----------------------

test('an unknown chunk keeps its whole body, not just a type and a length', () => {
  const bytes = new Uint8Array([
    ...chunk('MThd', [...be(0, 2), ...be(1, 2), ...be(480, 2)]),
    ...chunk('XFIR', [0xde, 0xad, 0xbe, 0xef]),
    ...buildTrack([[0, ...noteOn(0, 60, 100)], [480, ...noteOff(0, 60)]]),
  ]);
  const decoded = decodeMidiFile(bytes);
  const unknown = decoded.anomalies.find(a => a.code === 'UNKNOWN_CHUNK');
  assert.equal(unknown.chunkType, 'XFIR');
  assert.equal(unknown.bytes, 4);
  assert.equal(unknown.raw, 'deadbeef', 'the skipped bytes are recoverable');
  // The chunk is skipped for projection but the track still reads.
  assert.equal(ingest(bytes).events.length, 1);
});

test('bytes after End of Track and after the last chunk are kept verbatim', () => {
  const trackBody = [
    ...vlq(0), ...noteOn(0, 60, 100),
    ...vlq(480), ...noteOff(0, 60),
    ...vlq(0), 0xff, 0x2f, 0x00,
    0xca, 0xfe,                            // stowaway bytes inside the chunk
  ];
  const bytes = new Uint8Array([
    ...chunk('MThd', [...be(0, 2), ...be(1, 2), ...be(480, 2)]),
    ...chunk('MTrk', trackBody),
    0xba, 0xbe,                            // stowaway bytes after the last chunk
  ]);
  const decoded = decodeMidiFile(bytes);
  assert.equal(decoded.anomalies.find(a => a.code === 'DATA_AFTER_END_OF_TRACK').raw, 'cafe');
  assert.equal(decoded.anomalies.find(a => a.code === 'TRAILING_BYTES').raw, 'babe');
  assert.equal(ingest(bytes).events.length, 1, 'the valid note is still projected');
});

test('a format above 2 is not projected as if its tracks shared a timeline', () => {
  for (const format of [3, 7, 0xffff]) {
    const fragment = ingest(buildMidi({
      format,
      tracks: [
        buildTrack([[0, ...noteOn(0, 60, 100)], [480, ...noteOff(0, 60)]]),
        buildTrack([[0, ...noteOn(0, 64, 100)], [480, ...noteOff(0, 64)]]),
      ],
    }));
    assert.equal(fragment.complete, false, `format ${format} must not read as complete`);
    assert.equal(fragment.events.length, 0, `format ${format} must not project events`);
    const bad = fragment.unsupported.find(u => u.code === 'UNKNOWN_SMF_FORMAT');
    assert.equal(bad.format, format);
  }
  assert.equal(MIDI_INGESTION_STATUS.smfFormatAbove2, false);
});

test('formats 0 and 1 still project normally after the format guard', () => {
  for (const format of [0, 1]) {
    const fragment = ingest(buildMidi({
      format,
      tracks: [buildTrack([[0, ...noteOn(0, 60, 100)], [480, ...noteOff(0, 60)]])],
    }));
    assert.equal(fragment.complete, true, `format ${format} must still ingest cleanly`);
    assert.equal(fragment.events.length, 1);
  }
});

test('source identity is the SHA-256 of the parsed bytes and is deterministic', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = simple([[0, ...noteOn(0, 60, 100)], [480, ...noteOff(0, 60)]]);
  const expected = createHash('sha256').update(bytes).digest('hex');

  const fragment = ingest(bytes);
  assert.equal(fragment.source.sha256, expected, 'matches the platform digest');
  assert.equal(ingest(bytes).source.sha256, expected, 'stable across runs');

  // A different file yields a different identity.
  const other = simple([[0, ...noteOn(0, 61, 100)], [480, ...noteOff(0, 61)]]);
  assert.notEqual(ingest(other).source.sha256, expected);

  // An explicit digest from the caller still wins.
  const supplied = 'f'.repeat(64);
  assert.equal(ingest(bytes, { sha256: supplied }).source.sha256, supplied);
});

test('sha256Hex agrees with the platform digest across padding boundaries', async () => {
  const { createHash } = await import('node:crypto');
  // 55/56 and 63/64 straddle the block-padding boundaries where a hand-written
  // implementation typically goes wrong.
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) % 256;
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'), `length ${length}`);
  }
});
