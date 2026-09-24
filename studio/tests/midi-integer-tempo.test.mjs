import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMML, writeMidi } from '../../dist/core.js';
import { ingestMIDI, integerTempoForMicroseconds, midiFragmentToProject, MIDI_INGESTION_STATUS } from '../backend/source/index.mjs';
import { createCanonicalNoteEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { emitFinalMml, EMIT_DIAGNOSTICS } from '../backend/final/index.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { performanceFromCanonical } from '../backend/audio/prescreen/performance.mjs';
import { ingestMidiSource } from '../web/midi-source.mjs';
import { buildMidi, buildTrack, setTempo, timeSig, notesToEntries } from './fixtures/midi-fixtures.mjs';

// A Standard MIDI File stores a tempo as whole microseconds per quarter note,
// so an integer Tempo is written as Math.round(60,000,000 / T): T130 becomes
// 461,538 us, which divides back to 130.00013000013. That fraction is the file
// format's rounding, not a tempo the source states, and read as the Canonical
// bpm it made every such MIDI refuse Final (TEMPO_NOT_INTEGER) and disagree
// with a score stating the same integer (TEMPO_CONFLICT_AT_POSITION).

const US_PER_MINUTE = 60_000_000;
const { tempoMin, tempoMax } = EFFECTIVE_RULESET.mobileSyntax;
const PPQ = 480;

// A conductor track carrying `tempi` ([tick, microseconds]) and 4/4, and one
// C4 held for two bars.
function tempoFile(tempi) {
  let previous = 0;
  const conductor = [[0, ...timeSig(4, 2)]];
  for (const [tick, us] of tempi) {
    conductor.push([tick - previous, ...setTempo(us)]);
    previous = tick;
  }
  return buildMidi({ division: PPQ, tracks: [buildTrack(conductor), buildTrack(notesToEntries([[0, 60, 0, PPQ * 8]]))] });
}

// Every note placed in the Melody at a decided volume, as an accepted
// arrangement would; the tempo map is the source's, untouched.
function finalCandidate(fragment) {
  const project = midiFragmentToProject(fragment);
  return createCanonicalProject({
    ...project,
    events: project.events.map(event => createCanonicalNoteEvent({ ...event, role: 'Melody', volume: 10 })),
  });
}

test('an integer Tempo written by the repository\'s own writeMidi is read back as that integer and reaches a Final', () => {
  const song = validateMML('MML@t130o4c1,,,,,;').song;
  const fragment = ingestMIDI(writeMidi(song), { sourceId: 'written', kind: 'third-party-midi' });
  assert.equal(fragment.complete, true);
  assert.deepEqual(fragment.warnings, []);
  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 130]]);
  // What the file stores is kept beside the reading, and the reading says what it is.
  assert.deepEqual({ ...fragment.tempoEvents[0].metadata }, {
    tick: 0,
    microsecondsPerQuarter: 461538,
    trackIndex: 0,
    tempoEncoding: 'SMF_INTEGER_US_ROUNDTRIP',
    rawBpm: US_PER_MINUTE / 461538,
  });
  assert.equal(MIDI_INGESTION_STATUS.integerTempoFromMicrosecondRoundTrip, true);

  const result = emitFinalMml(finalCandidate(fragment));
  assert.equal(result.status, 'PASS', JSON.stringify(result.diagnostics.map(item => item.code)));
  assert.equal(result.diagnostics.some(item => item.code === EMIT_DIAGNOSTICS.TEMPO_NOT_INTEGER), false);
  assert.equal(result.roles.find(role => role.role === 'Melody').mml.startsWith('t130'), true);
});

test('every integer Tempo in the ruleset range survives the SMF microsecond round trip; only a rate the file cannot state exactly is marked', () => {
  let marked = 0;
  for (let bpm = tempoMin; bpm <= tempoMax; bpm++) {
    const us = Math.round(US_PER_MINUTE / bpm);
    const [event] = ingestMIDI(tempoFile([[0, us]])).tempoEvents;
    assert.equal(event.bpm, bpm, `T${bpm}, stored as ${us} us, must read back as ${bpm}`);
    assert.equal(event.metadata.microsecondsPerQuarter, us);
    if (US_PER_MINUTE % bpm === 0) {
      // The file states this rate exactly (500,000 us is 120). Nothing was
      // read into it, so the event is exactly what intake always produced.
      assert.deepEqual(Object.keys(event.metadata).sort(), ['microsecondsPerQuarter', 'tick', 'trackIndex'], `T${bpm}`);
    } else {
      marked++;
      assert.equal(event.metadata.tempoEncoding, 'SMF_INTEGER_US_ROUNDTRIP', `T${bpm}`);
      assert.equal(event.metadata.rawBpm, US_PER_MINUTE / us, `T${bpm}`);
      assert.notEqual(event.metadata.rawBpm, bpm);
    }
  }
  assert.ok(marked > 0);
});

test('a microsecond value no integer Tempo is written as keeps its exact rate, and the Final emitter still refuses it', () => {
  // T130 is written as 461,538 us and T131 as 458,015 us, so no integer Tempo
  // is ever written as 461,000 us: that file states 130.15... BPM.
  const fragment = ingestMIDI(tempoFile([[0, 461538], [PPQ * 4, 461000]]));
  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 130], ['4', US_PER_MINUTE / 461000]]);
  const fractional = fragment.tempoEvents[1];
  assert.equal(Number.isInteger(fractional.bpm), false);
  assert.deepEqual(Object.keys(fractional.metadata).sort(), ['microsecondsPerQuarter', 'tick', 'trackIndex']);

  const result = emitFinalMml(finalCandidate(fragment));
  assert.equal(result.status, 'FAIL');
  // Refused by name, and only the tempo the source genuinely states as a fraction.
  assert.deepEqual(result.diagnostics.filter(item => item.code === EMIT_DIAGNOSTICS.TEMPO_NOT_INTEGER).map(item => item.bpm), [US_PER_MINUTE / 461000]);

  // Outside the ruleset's Tempo range no integer is looked for: the rate stays
  // what the file states, and the emitter refuses it for its range as before.
  for (const bpm of [tempoMin - 1, tempoMax + 15]) {
    const [event] = ingestMIDI(tempoFile([[0, Math.round(US_PER_MINUTE / bpm)]])).tempoEvents;
    assert.equal(Number.isInteger(event.bpm), false, `T${bpm} is outside ${tempoMin}-${tempoMax}`);
    assert.equal(event.metadata.tempoEncoding, undefined);
  }
});

test('the audio prescreen can play a MIDI baseline at T130', () => {
  // The prescreen clock is exact rational arithmetic; the float 130.00013
  // could not be made a rational there and the performance threw.
  const performance = performanceFromCanonical(finalCandidate(ingestMIDI(tempoFile([[0, 461538]]))));
  assert.deepEqual(performance.tempo, [{ beat: '0', bpm: 130 }]);
  assert.ok(Math.abs(performance.durationSeconds - (8 * 60) / 130) < 1e-12);
});

test('Studio Web raw MIDI intake reads the same integer Tempo', () => {
  const asset = ingestMidiSource({ name: 't130.mid', bytes: tempoFile([[0, 461538]]) });
  assert.deepEqual(asset.project.tempoEvents.map(event => event.bpm), [130]);
  assert.equal(asset.project.tempoEvents[0].metadata.tempoEncoding, 'SMF_INTEGER_US_ROUNDTRIP');
  assert.equal(asset.project.tempoEvents[0].metadata.microsecondsPerQuarter, 461538);
});

// The rule is exact: a stored value is read as the integer Tempo only when that
// integer is written as exactly that value. One microsecond either side of
// every integer's encoding is a different tempo the source states, and a
// matcher that snapped anything near an integer would invent tempi.
test('only the exact microsecond encoding of an integer Tempo is read back as that integer', () => {
  const snapped = [];
  for (let bpm = tempoMin; bpm <= tempoMax; bpm++) {
    const us = Math.round(US_PER_MINUTE / bpm);
    assert.equal(integerTempoForMicroseconds(us), bpm, `T${bpm} (${us} us)`);
    for (const near of [us - 1, us + 1]) {
      const read = integerTempoForMicroseconds(near);
      // A neighbour is snapped only if it is itself some integer's encoding.
      const encodes = read !== null && Math.round(US_PER_MINUTE / read) === near;
      if (read !== null && !encodes) snapped.push(`${near} us -> T${read}`);
      if (read === null) continue;
      assert.ok(encodes, `${near} us is not the encoding of T${read}`);
    }
  }
  assert.deepEqual(snapped, []);
  // A value one microsecond off T130's encoding keeps its exact rate.
  const fragment = ingestMIDI(tempoFile([[0, Math.round(US_PER_MINUTE / 130) + 1]]));
  assert.equal(Number.isInteger(fragment.tempoEvents[0].bpm), false, String(fragment.tempoEvents[0].bpm));
});

// A rounded tempo later in the song is read back at its own beat, not only at
// tick 0 (the DEMO song's T138 sits at beat 8).
test('a tempo change the file could only round is read back as its integer at its own beat', () => {
  const fragment = ingestMIDI(tempoFile([[0, 500000], [PPQ * 4, Math.round(US_PER_MINUTE / 138)]]));
  assert.deepEqual(fragment.tempoEvents.map(event => [String(event.beat), event.bpm]), [['0', 120], ['4', 138]]);
  assert.equal(fragment.tempoEvents[1].metadata?.tempoEncoding, 'SMF_INTEGER_US_ROUNDTRIP');
  assert.equal(fragment.tempoEvents[0].metadata?.tempoEncoding, undefined, 'an exact rate carries no marker');
});
