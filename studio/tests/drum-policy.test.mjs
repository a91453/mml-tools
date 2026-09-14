import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMML, expectedMidi } from '../backend/mml/index.mjs';

// G11 — MASTER_RULES §8 keeps General MIDI drum note numbers out of ordinary pitched
// Mobile output: a drum source must first be mapped to evidence-backed drum-face
// positions, and an unsupported mapping stays PENDING rather than leaking GM pitches.
//
// The mapping below is a minimal test fixture, NOT a drum-face mapping for any target
// instrument. PENDING P10 still owns the real mapping, so these tests assert the
// fail-closed guard and the pitched/percussion separation only, never mapping content.
const drumProfile = (mapping, overrides = {}) => JSON.stringify({
  role: 'Chord5',
  instrument: 'fixture-percussion',
  evidence: 'fixture-only; not an evidence-backed Mobile drum-face mapping (PENDING P10)',
  mapping,
  ...overrides,
});

const meter = { meterText: '0 4/4' };
// Melody and the drum role carry the same written pitch, so an unguarded pipeline
// would treat the percussion event as an ordinary pitched note.
const withDrumRole = 'MML@t120o4c1,,,,,t120o4c1;';

test('an unmapped GM drum pitch fails closed instead of reaching pitched output', () => {
  const result = validateMML(withDrumRole, { ...meter, drumText: drumProfile({ 62: 38 }) });
  assert.equal(result.ok, false, 'a drum event with no drum-face mapping cannot validate');
  assert.ok(result.errors.some(item => /鼓面對應/.test(item.message)), JSON.stringify(result.errors));

  const mapped = validateMML(withDrumRole, { ...meter, drumText: drumProfile({ 60: 38 }) });
  assert.equal(mapped.ok, true, JSON.stringify(mapped.errors));
});

test('a drum profile without an evidence reference is rejected', () => {
  for (const bad of [drumProfile({ 60: 38 }, { evidence: '   ' }), drumProfile({})]) {
    const result = validateMML(withDrumRole, { ...meter, drumText: bad });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(item => /鼓面表需要role、instrument、evidence與非空mapping/.test(item.message)), JSON.stringify(result.errors));
  }
});

test('the drum role is excluded from pitched overlap review without losing any role pair', () => {
  const pitched = validateMML(withDrumRole, meter);
  assert.equal(pitched.ok, true, JSON.stringify(pitched.errors));
  assert.equal(pitched.song.review.pairs.length, 15);
  assert.equal(pitched.song.review.pairs.every(pair => pair.status === 'reviewed_intervals'), true);
  const pitchedPair = pitched.song.review.pairs.find(pair => pair.left === 'Melody' && pair.right === 'Chord5');
  assert.ok(pitchedPair.overlaps.length, 'without a drum profile the shared pitch is a pitched overlap');

  const percussive = validateMML(withDrumRole, { ...meter, drumText: drumProfile({ 60: 38 }) });
  assert.equal(percussive.ok, true, JSON.stringify(percussive.errors));
  assert.equal(percussive.song.review.pairs.length, 15, 'all 15 role pairs are still enumerated');

  const drumPairs = percussive.song.review.pairs.filter(pair => pair.left === 'Chord5' || pair.right === 'Chord5');
  assert.equal(drumPairs.length, 5);
  for (const pair of drumPairs) {
    assert.equal(pair.status, 'percussion_not_pitched', `${pair.left}/${pair.right}`);
    assert.deepEqual(pair.overlaps, [], 'percussion is never compared as a pitched voice');
  }
  for (const pair of percussive.song.review.pairs.filter(pair => pair.left !== 'Chord5' && pair.right !== 'Chord5')) {
    assert.equal(pair.status, 'reviewed_intervals', 'pitched pairs keep ordinary interval review');
  }
});

test('drum delivery emits the mapped drum face, never the raw source pitch', () => {
  const result = validateMML(withDrumRole, { ...meter, drumText: drumProfile({ 60: 38 }) });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.song.tracks[5].events[0].pitch, 60, 'the source event itself is never rewritten');

  const midi = expectedMidi(result.song);
  const drumTrack = midi.tracks.find(track => track.role === 'Chord5');
  assert.equal(drumTrack.channel, 9, 'percussion is routed to the drum channel');
  assert.equal(drumTrack.program, null, 'percussion carries no melodic program');
  assert.deepEqual(drumTrack.events.map(event => event.pitch), [38], 'the mapped drum face is delivered');
  assert.ok(!drumTrack.events.some(event => event.pitch === 60), 'the raw source pitch never leaks into delivery');

  const melody = midi.tracks.find(track => track.role === 'Melody');
  assert.notEqual(melody.channel, 9);
  assert.deepEqual(melody.events.map(event => event.pitch), [60], 'pitched roles are unaffected by the drum mapping');
});
