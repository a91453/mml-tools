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

test('Nxx is preserved at ingest and requires Final opt-in', () => {
  const ingest = parseTrack('t120n60', 'Melody');
  assert.deepEqual(ingest.errors, []);
  assert.equal(ingest.events[0].pitch, 60);

  const blocked = parseTrack('t120n60', 'Melody', { mode: 'final' });
  assert.ok(blocked.errors.some(error => error.code === 'NUMERIC_NOTE_OPT_IN_REQUIRED'));

  const allowed = parseTrack('t120n60', 'Melody', { mode: 'final', numericPitchOptIn: true });
  assert.deepEqual(allowed.errors, []);
  assert.equal(allowed.events[0].pitch, 60);
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
    finalPartial: '1/4',
  });
  assert.equal(numericBlocked.ok, false);
  assert.ok(numericBlocked.errors.some(error => error.code === 'NUMERIC_NOTE_OPT_IN_REQUIRED'));
});

test('cross-role end-time mismatch is review-only and never auto-padded', () => {
  const result = validateMML('MML@t120o4c1,t120o4c2,,,,;', { meterText: '0 4/4' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some(item => item.code === 'CROSS_ROLE_END_TIME_REVIEW'));
  assert.equal(result.song.tracks[1].total, '2');
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
