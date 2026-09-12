import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTrack,
  validateMML,
  writeMidi,
  readMidi,
  compareMidi,
  writeABC,
  readABC,
  STUDIO_MML_PROFILE,
} from '../backend/mml/index.mjs';

const six = raw => `MML@${Array(6).fill(raw).join(',')};`;

test('ingest parser accepts plain 64th notes, arbitrary 1–64 lengths and Nxx as evidence', () => {
  for (const raw of ['t120o4c64', 't120o4r64', 't120o4l64c', 't120o4c48', 't120o4c7', 't120n60']) {
    const parsed = parseTrack(raw, 'Melody');
    assert.deepEqual(parsed.errors, [], `${raw}: ${JSON.stringify(parsed.errors)}`);
  }
  assert.ok(parseTrack('t120o4c48', 'Melody').warnings.some(item => item.code === 'CAUTION_LENGTH'));
  assert.ok(parseTrack('t120n60', 'Melody').warnings.some(item => item.code === 'NUMERIC_NOTE_CAUTION'));
});

test('all sampled non-preferred plain 1–64 lengths stay ingestible but Final-caution', () => {
  for (const denominator of [5, 7, 9, 19, 21, 27, 38, 48]) {
    const ingest = parseTrack(`t120o4c${denominator}`, 'Melody');
    assert.deepEqual(ingest.errors, [], `ingest c${denominator}`);
    assert.ok(ingest.warnings.some(item => item.code === 'CAUTION_LENGTH'));

    const final = parseTrack(`t120o4c${denominator}`, 'Melody', { mode: 'final' });
    assert.ok(final.errors.some(item => item.code === 'CAUTION_LENGTH_OPT_IN_REQUIRED'), `final c${denominator}`);
  }
});

test('Studio Final accepts T255 and rejects T256', () => {
  assert.deepEqual(parseTrack('t255o4c4', 'Melody', { mode: 'final' }).errors, []);
  assert.ok(parseTrack('t256o4c4', 'Melody', { mode: 'final' }).errors.some(error => /32–255/.test(error.message)));
});

test('Final caution lengths require explicit opt-in while remaining ingestible', () => {
  const ingest = parseTrack('t120o4c48', 'Melody');
  assert.deepEqual(ingest.errors, []);

  const blocked = parseTrack('t120o4c48', 'Melody', { mode: 'final' });
  assert.ok(blocked.errors.some(error => error.code === 'CAUTION_LENGTH_OPT_IN_REQUIRED'));

  const allowed = parseTrack('t120o4c48', 'Melody', { mode: 'final', allowCautionLengths: true });
  assert.deepEqual(allowed.errors, []);
  assert.ok(allowed.warnings.some(item => item.code === 'CAUTION_LENGTH'));
});

test('Nxx is preserved at ingest and Final requires both opt-in and evidence', () => {
  const ingest = parseTrack('t120n60', 'Melody');
  assert.deepEqual(ingest.errors, []);
  assert.equal(ingest.events[0].pitch, 60);

  const blocked = parseTrack('t120n60', 'Melody', { mode: 'final' });
  assert.ok(blocked.errors.some(error => error.code === 'NUMERIC_NOTE_OPT_IN_REQUIRED'));

  const noEvidence = parseTrack('t120n60', 'Melody', { mode: 'final', numericPitchOptIn: true });
  assert.ok(noEvidence.errors.some(error => error.code === 'NUMERIC_NOTE_EVIDENCE_REQUIRED'));

  const allowed = parseTrack('t120n60', 'Melody', {
    mode: 'final',
    numericPitchOptIn: true,
    numericPitchEvidence: ['fixture:direct-parser-roundtrip'],
  });
  assert.deepEqual(allowed.errors, []);
  assert.equal(allowed.events[0].pitch, 60);
});

test('Nxx malformed and boundary values fail closed without throwing', () => {
  assert.ok(parseTrack('t120n', 'Melody').errors.some(error => error.code === 'NUMERIC_NOTE_MISSING_VALUE'));

  const n0 = parseTrack('t120n0', 'Melody');
  assert.deepEqual(n0.errors, []);
  assert.equal(n0.events[0].pitch, 0);

  const n107 = parseTrack('t120n107', 'Melody');
  assert.deepEqual(n107.errors, []);
  assert.equal(n107.events[0].pitch, 107);

  const n108 = parseTrack('t120n108', 'Melody');
  assert.ok(n108.errors.some(error => error.code === 'NUMERIC_NOTE_OUT_OF_RANGE'));
  assert.equal(n108.events.length, 0);
});

test('invalid L never reaches rational construction or fabricates event timing', () => {
  for (const raw of ['t120l0n60', 't120l65n60', 't120o4c0', 't120o4c65']) {
    let parsed;
    assert.doesNotThrow(() => { parsed = parseTrack(raw, 'Melody'); }, raw);
    assert.ok(parsed.errors.some(error => error.code === 'LENGTH_OUT_OF_RANGE' || error.code === 'DEFAULT_LENGTH_INVALID'), raw);
    assert.equal(parsed.events.length, 0, raw);
    assert.equal(parsed.total, '0', raw);
  }

  const recovered = parseTrack('t120l0l8n60', 'Melody');
  assert.ok(recovered.errors.some(error => error.code === 'LENGTH_OUT_OF_RANGE'));
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0].end, '1/2');
});

test('Final parser preserves canonical fragile-form exclusions', () => {
  for (const raw of [
    't120o4c128',
    't120o4c64.',
    't120o4r64.',
    't120o4c3.',
    't120o4c6.',
    't120o4c12.',
    't120o4c24.',
    't120o4c48.',
    't120o4c4..',
  ]) {
    assert.ok(parseTrack(raw, 'Melody', { mode: 'final', allowCautionLengths: true }).errors.length, raw);
  }
});

test('ingest preserves a non-Final dotted source form without rewriting its duration', () => {
  const parsed = parseTrack('t120o4c64.', 'Melody');
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.warnings.some(item => item.code === 'NONCANONICAL_DOTTED_SOURCE_FORM'));
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].start, '0');
  assert.equal(parsed.events[0].end, '3/32');
});

test('Studio validator requires source-confirmed meter instead of assuming 4/4', () => {
  const missing = validateMML(six('t120o4c1'));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => /拍號圖/.test(error.message)));

  const supplied = validateMML(six('t120o4c1'), { meterText: '0 4/4' });
  assert.equal(supplied.ok, true, JSON.stringify(supplied.errors));
  assert.equal(supplied.song.profile, STUDIO_MML_PROFILE);
});

test('Final validator keeps caution policy separate from ingest capability', () => {
  const cautionBlocked = validateMML(six('t120o4c48'), {
    meterText: '0 4/4',
    finalPartial: '1/12',
  });
  assert.equal(cautionBlocked.ok, false);
  assert.ok(cautionBlocked.errors.some(error => error.code === 'CAUTION_LENGTH_OPT_IN_REQUIRED'));

  const numericBlocked = validateMML(six('t120n60'), {
    meterText: '0 4/4',
    finalPartial: '1',
  });
  assert.equal(numericBlocked.ok, false);
  assert.ok(numericBlocked.errors.some(error => error.code === 'NUMERIC_NOTE_OPT_IN_REQUIRED'));

  const numericNoEvidence = validateMML(six('t120n60'), {
    meterText: '0 4/4',
    finalPartial: '1',
    numericPitchOptIn: true,
  });
  assert.equal(numericNoEvidence.ok, false);
  assert.ok(numericNoEvidence.errors.some(error => error.code === 'NUMERIC_NOTE_EVIDENCE_REQUIRED'));

  const numericAllowed = validateMML(six('t120n60'), {
    meterText: '0 4/4',
    finalPartial: '1',
    numericPitchOptIn: true,
    numericPitchEvidence: ['fixture:roundtrip-and-ingame'],
  });
  assert.equal(numericAllowed.ok, true, JSON.stringify(numericAllowed.errors));
  assert.deepEqual(numericAllowed.song.policyOptIns.numericPitchEvidence, ['fixture:roundtrip-and-ingame']);
});

test('Tempo map mismatch is Final-blocking but ingest-review only, and empty roles remain empty', () => {
  const raw = 'MML@t120o4c1,t130o4c1,,,,;';
  const finalResult = validateMML(raw, { meterText: '0 4/4' });
  assert.equal(finalResult.ok, false);
  assert.ok(finalResult.errors.some(item => item.code === 'TEMPO_MAP_MISMATCH'));

  const ingest = validateMML(raw, { meterText: '0 4/4', validationMode: 'ingest' });
  assert.equal(ingest.ok, true, JSON.stringify(ingest.errors));
  assert.ok(ingest.warnings.some(item => item.code === 'TEMPO_MAP_MISMATCH'));
  assert.deepEqual(ingest.song.tracks[2].tempo, []);
  assert.equal(ingest.song.tracks[2].events.length, 0);
});

test('cross-role end-time mismatch is review-only and never auto-padded', () => {
  const result = validateMML('MML@t120o4c1,t120o4c2,,,,;', { meterText: '0 4/4' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some(item => item.code === 'CROSS_ROLE_END_TIME_REVIEW'));
  assert.equal(result.song.tracks[1].total, '2');
});

test('named-note mapping above official pitch 107 is visible as a warning, not mislabeled engine law', () => {
  const parsed = parseTrack('t120o8c4', 'Melody');
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.events[0].pitch, 108);
  assert.ok(parsed.warnings.some(item => item.code === 'NAMED_NOTE_ABOVE_OFFICIAL_PITCH_RANGE'));
});

test('1/64 events survive MIDI and ABC preview round trips', () => {
  const result = validateMML(six('t120o4c64r64c32'), {
    meterText: '0 4/4',
    finalPartial: '1/4',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const song = result.song;
  assert.ok(compareMidi(song, readMidi(writeMidi(song))).ok);
  assert.ok(compareMidi(song, readABC(writeABC(song), { finalPartial: '1/4' })).ok);
});
