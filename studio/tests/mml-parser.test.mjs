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

test('Final blocks unverified named-note mappings above 107 while ingest preserves them', () => {
  const raw = six('t120o8c1');
  const ingest = validateMML(raw, { meterText: '0 4/4', validationMode: 'ingest' });
  assert.equal(ingest.ok, true);
  assert.equal(ingest.song.tracks[0].events[0].pitch, 108);
  const final = validateMML(raw, { meterText: '0 4/4' });
  assert.equal(final.ok, false);
  assert.ok(final.errors.some(item => item.code === 'NAMED_NOTE_FINAL_RANGE_UNVERIFIED'));
  assert.equal(final.song.tracks[0].events[0].pitch, 108, 'validation never rewrites the source pitch');
  assert.equal(validateMML(six('t120o7b1'), { meterText: '0 4/4' }).ok, true, 'mapped pitch 107 remains allowed');
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

// G1 — MASTER_RULES §7 and MOBILE_SYNTAX §8 make tie/attack identity a Canonical
// guarantee: `&` continues the same pitch only, and a repeated attack must never
// be folded into one sustain. Both directions were previously unasserted, so
// deleting the guard left the suite green.
test('a tie may only continue the same pitch and never spans a rest', () => {
  const different = parseTrack('t120o4c4&d4', 'Melody');
  assert.ok(different.errors.some(item => item.code === 'TIE_PITCH_OR_GAP'), JSON.stringify(different.errors));

  const overRest = parseTrack('t120o4c4&r4', 'Melody');
  assert.ok(overRest.errors.length, 'a tie into a rest is not a continuation');

  const unfinished = parseTrack('t120o4c4&', 'Melody');
  assert.ok(unfinished.errors.length, 'a track may not end on an unresolved tie');
});

test('a same-pitch tie joins one event while a repeated attack stays two attacks', () => {
  const tied = parseTrack('t120o4c4&c4', 'Melody');
  assert.deepEqual(tied.errors, [], JSON.stringify(tied.errors));
  assert.equal(tied.events.length, 1, 'a legitimate tie is one sustained event');
  assert.equal(tied.events[0].start, '0');
  assert.equal(tied.events[0].end, '2', 'the tie sustains across both quarter-note beats');

  const repeated = parseTrack('t120o4c4c4', 'Melody');
  assert.deepEqual(repeated.errors, [], JSON.stringify(repeated.errors));
  assert.equal(repeated.events.length, 2, 'adjacent repeated attacks must not become one sustain');
  assert.deepEqual(repeated.events.map(event => [event.start, event.end]), [['0', '1'], ['1', '2']]);
});

// G2 — MOBILE_SYNTAX §7 clause 1 is a FINAL_CANONICAL_POLICY: every non-empty role
// starts with the same initial Tempo. P2 keeps the engine-law question open, so this
// asserts the project's delivery policy only, not an engine requirement.
test('Final requires an initial Tempo on every non-empty role while ingest still reviews it', () => {
  const missing = parseTrack('o4c4', 'Melody', { mode: 'final' });
  assert.ok(missing.errors.some(item => item.code === 'INITIAL_TEMPO_REQUIRED'), JSON.stringify(missing.errors));

  const late = parseTrack('o4c4t120c4', 'Melody', { mode: 'final' });
  assert.ok(late.errors.some(item => item.code === 'INITIAL_TEMPO_REQUIRED'), 'a Tempo after beat 0 is not an initial Tempo');

  assert.deepEqual(parseTrack('t120o4c4', 'Melody', { mode: 'final' }).errors, []);
  assert.ok(!parseTrack('o4c4', 'Melody').errors.some(item => item.code === 'INITIAL_TEMPO_REQUIRED'),
    'ingest keeps the source event instead of failing closed on delivery policy');
  assert.deepEqual(parseTrack('', 'Chord5', { mode: 'final' }).errors, [], 'an empty role stays empty and gets no filler Tempo');
});

// G3 — MOBILE_SYNTAX §2 documents the 2,400 limit and §11.6 requires each role to be
// checked independently. P1 leaves exact client counter semantics unverified, so this
// asserts the project validator's own raw-length enforcement and claims no client
// equivalence.
test('Final enforces the 2,400-character per-role limit that ingest only reports', () => {
  const body = 'o4'.concat('c4'.repeat(1300));
  const raw = `t120${body}`;
  assert.ok(raw.length > 2400, `fixture must cross the limit, got ${raw.length}`);

  const final = parseTrack(raw, 'Melody', { mode: 'final' });
  assert.ok(final.errors.some(item => item.code === 'TRACK_CHARACTER_LIMIT'), JSON.stringify(final.errors.slice(0, 3)));
  assert.equal(final.characters, raw.length, 'the validator reports the raw count it actually measured');

  const ingest = parseTrack(raw, 'Melody');
  assert.ok(ingest.warnings.some(item => item.code === 'TRACK_CHARACTER_LIMIT_SOURCE_ONLY'));
  assert.ok(!ingest.errors.some(item => item.code === 'TRACK_CHARACTER_LIMIT'), 'oversized source evidence is retained at ingest');

  const withinLimit = `t120o4${'c4'.repeat(1100)}`;
  assert.ok(withinLimit.length < 2400);
  assert.deepEqual(parseTrack(withinLimit, 'Melody', { mode: 'final' }).errors, []);
});

// G4 — MOBILE_SYNTAX §6 and P6 keep O-token range an implementation mapping against
// official pitch 0–107, not Nexon wording. The guard must stay, and must stay labelled
// as an implementation mapping.
test('octave bounds fail closed as an implementation mapping, not as an official rule', () => {
  for (const raw of ['t120o9c4', 't120o4>>>>>c4']) {
    const parsed = parseTrack(raw, 'Melody', { mode: 'final' });
    const finding = parsed.errors.find(item => item.code === 'OCTAVE_IMPLEMENTATION_MAPPING');
    assert.ok(finding, `${raw}: ${JSON.stringify(parsed.errors)}`);
    assert.match(finding.message, /實作映射/, 'the bound is reported as the current implementation mapping');
  }
  assert.match(
    parseTrack('t120o9c4', 'Melody', { mode: 'final' }).errors.find(item => item.code === 'OCTAVE_IMPLEMENTATION_MAPPING').message,
    /非Nexon官方措辭/,
    'the explicit O-token bound still disclaims official wording, per MOBILE_SYNTAX §6 and P6',
  );
  // O8 is inside the octave mapping even though O8 C resolves to pitch 108: the
  // octave-token bound and the official pitch 0-107 range stay separate checks.
  const edge = parseTrack('t120o8c4', 'Melody', { mode: 'final' });
  assert.ok(!edge.errors.some(item => item.code === 'OCTAVE_IMPLEMENTATION_MAPPING'), JSON.stringify(edge.errors));
  assert.ok(edge.errors.some(item => item.code === 'NAMED_NOTE_FINAL_RANGE_UNVERIFIED'));
  assert.deepEqual(parseTrack('t120o7b4', 'Melody', { mode: 'final' }).errors, [], 'mapped pitch 107 stays allowed');
});
