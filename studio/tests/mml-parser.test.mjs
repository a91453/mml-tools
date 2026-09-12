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

test('Studio parser accepts 64th-note notes, rests and L64', () => {
  for (const raw of ['t120o4c64', 't120o4r64', 't120o4l64c']) {
    const parsed = parseTrack(raw, 'Melody');
    assert.deepEqual(parsed.errors, [], `${raw}: ${JSON.stringify(parsed.errors)}`);
  }
});

test('Studio parser accepts T255 and rejects T256', () => {
  assert.deepEqual(parseTrack('t255o4c4', 'Melody').errors, []);
  assert.ok(parseTrack('t256o4c4', 'Melody').errors.some(error => /32–255/.test(error.message)));
});

test('Studio parser preserves strict canonical exclusions', () => {
  for (const raw of ['t120o4c48', 't120o4c128', 't120o4c3.', 't120o4c6.', 't120o4c12.', 't120o4c24.', 't120o4c4..', 't120o4n60']) {
    assert.ok(parseTrack(raw, 'Melody').errors.length, raw);
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
