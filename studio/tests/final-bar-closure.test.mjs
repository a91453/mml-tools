// Final bar closure: the Final emitter and the Canonical technical validator
// agree on a piece that stops before its last bar line (roadmap G15).
//
// The emitter serialized such a piece and round-tripped it, and then the
// validator every Canonical-claiming entry point uses (`validateMML`) refused
// it: `末小節剩N拍，請依來源明確填寫末小節長度`. No Published Canonical rule
// requires the last bar to be full. MOBILE_SYNTAX §11 step 7 asks that meter
// and time alignment be verified, Gate 6 that bars come exactly from the
// confirmed meter, and PENDING P14 leaves end-time and total-duration
// expectations unformalized and says not to pad meaningful silence. So the
// validator now keeps the partial bar the music has and reports it for review
// (FINAL_BAR_PARTIAL_UNDECLARED) instead of failing it.
//
// What this does not do, and these tests hold it to: it adds no Final Gate and
// no rule, resolves nothing in P14, pads nothing, moves no attack, infers no
// final partial bar, pickup or meter, and lets no real meter or bar problem
// through. The legacy `dist/core.js` validator keeps its own behaviour; it is a
// labelled diagnostic, not a Canonical verdict (canonical-validator-routing).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSource, createCanonicalNoteEvent, createCanonicalTempoEvent, createCanonicalMeterEvent, createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { EMIT_STATUS, emitFinalMml } from '../backend/final/index.mjs';
import { FINAL_BAR_CLOSURE, validateMML } from '../backend/mml/parser.mjs';
import { validateMML as legacyValidateMML } from '../../dist/core.js';
import { createStudioApplication } from '../backend/application/index.mjs';
import { newWorkspace, intake, recordReview, REVIEW_NAMES, analyzeWorkspace } from '../web/model.mjs';

const OFFICIAL = createSource({ id: 'official', label: 'Official MusicXML', kind: 'official-musicxml', authority: 'primary-symbolic' });
const note = (id, pitch, start, end, role = 'Melody') => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, volume: 8, sourceIds: ['official'],
});
const project = (events, meters = [[0, 4, 4]]) => createCanonicalProject({
  id: 'final-bar-fixture', title: 'Final bar fixture', sources: [OFFICIAL], events,
  tempoEvents: [createCanonicalTempoEvent({ id: 't1', beat: '0', bpm: 120, sourceIds: ['official'] })],
  meterEvents: meters.map(([beat, numerator, denominator], index) => createCanonicalMeterEvent({
    id: `m${index + 1}`, beat: String(beat), numerator, denominator, sourceIds: ['official'],
  })),
  decisions: [], metadata: { sourceComplete: true },
});
const REVIEW = 'FINAL_BAR_PARTIAL_UNDECLARED';
const reviewWarnings = result => result.warnings.filter(item => item.code === REVIEW);
const messages = result => result.errors.map(error => error.message);
const eventsOf = song => song.tracks.map(track => track.events.map(event => [event.pitch, event.start, event.end]));

// One full 4/4 bar and then two beats of a second bar.
const SIX_BEATS = [note('a', 60, 0, 1), note('b', 62, 1, 2), note('c', 64, 2, 4), note('d', 65, 4, 5), note('e', 67, 5, 6), note('f', 55, 0, 4, 'Chord1')];

// ─── Case A: a legitimate partial ending ────────────────────────────────────

test('A: the emitter writes and round-trips a piece that ends mid-bar, and the validator no longer refuses it', () => {
  const emitted = emitFinalMml(project(SIX_BEATS));
  assert.equal(emitted.status, EMIT_STATUS.PASS);
  assert.equal(emitted.roundTrip.status, 'PASS');
  const result = validateMML(emitted.combinedMml, { meterText: '0 4/4' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.song.bars.map(bar => [bar.start, bar.end, bar.partial]), [['0', '4', false], ['4', '6', true]]);
  assert.deepEqual(result.song.finalBar, { closure: FINAL_BAR_CLOSURE.UNDECLARED_PARTIAL, beats: '2', declaredPickup: null, declaredFinalPartial: null });
  const [review] = reviewWarnings(result);
  assert.deepEqual([review.start, review.beats], ['4', '2']);
  assert.match(review.message, /PENDING P14/);
  assert.match(review.message, /不自動補休止/);
  // Ingest reads it the same way: a review note, not a parse error.
  const ingested = validateMML(emitted.combinedMml, { meterText: '0 4/4', validationMode: 'ingest' });
  assert.equal(ingested.ok, true);
  assert.equal(reviewWarnings(ingested).length, 1);
});

// ─── Case B: a source-confirmed final partial bar ───────────────────────────

test('B: a stated final_partial is kept and reported as source-confirmed; a contradicted one still fails', () => {
  const mml = emitFinalMml(project(SIX_BEATS)).combinedMml;
  const stated = validateMML(mml, { meterText: '0 4/4', finalPartial: '2' });
  assert.equal(stated.ok, true);
  assert.deepEqual(stated.song.finalBar, { closure: FINAL_BAR_CLOSURE.SOURCE_CONFIRMED_PARTIAL, beats: '2', declaredPickup: null, declaredFinalPartial: '2' });
  assert.deepEqual(reviewWarnings(stated), [], 'a stated closure needs no review note');
  const unstated = validateMML(mml, { meterText: '0 4/4' });
  assert.deepEqual(stated.song.bars, unstated.song.bars, 'the statement labels the bar; it does not change it');

  // The music contradicts the statement: a meter/time-alignment failure.
  assert.deepEqual(messages(validateMML(mml, { meterText: '0 4/4', finalPartial: '3' })), ['末小節剩2拍，請依來源明確填寫末小節長度']);
  assert.deepEqual(messages(validateMML(emitFinalMml(project(SIX_BEATS.slice(0, 3).concat(SIX_BEATS[5]))).combinedMml, { meterText: '0 4/4', finalPartial: '2' })),
    ['末小節長度設定與實際結尾不符'], 'a final_partial stated for a piece that ends on its bar line');
  assert.equal(validateMML(mml, { meterText: '0 4/4', finalPartial: '0' }).ok, false);
});

// ─── Case C: a pickup is not an ending ──────────────────────────────────────

test('C: a stated pickup is the first bar, never mistaken for the ending, and no pickup is guessed', () => {
  // One pickup beat, one full bar: ends on its bar line.
  const bar = 'MML@t120o4c4c1,,,,,;';
  const picked = validateMML(bar, { meterText: '0 4/4', pickup: '1' });
  assert.equal(picked.ok, true);
  assert.deepEqual(picked.song.bars.map(item => [item.start, item.end, item.partial]), [['0', '1', true], ['1', '5', false]]);
  assert.deepEqual(picked.song.finalBar, { closure: FINAL_BAR_CLOSURE.BAR_LINE, beats: '4', declaredPickup: '1', declaredFinalPartial: null });
  assert.deepEqual(reviewWarnings(picked), [], 'the partial first bar is the pickup, not an unstated ending');

  // A pickup and an unstated partial ending: only the ending is reported.
  const both = validateMML('MML@t120o4c4c1c2,,,,,;', { meterText: '0 4/4', pickup: '1' });
  assert.equal(both.ok, true);
  assert.deepEqual(both.song.bars.map(item => [item.start, item.end, item.partial]), [['0', '1', true], ['1', '5', false], ['5', '7', true]]);
  assert.deepEqual(reviewWarnings(both).map(item => [item.start, item.beats]), [['5', '2']]);
  assert.deepEqual(validateMML('MML@t120o4c4c1c2,,,,,;', { meterText: '0 4/4', pickup: '1', finalPartial: '2' }).song.finalBar.closure, FINAL_BAR_CLOSURE.SOURCE_CONFIRMED_PARTIAL);

  // The same one-beat-then-bar music with no pickup stated is read from beat 0.
  // Nothing infers the pickup that would make it end on a bar line.
  const unstated = validateMML(bar, { meterText: '0 4/4' });
  assert.equal(unstated.ok, true);
  assert.deepEqual(unstated.song.bars.map(item => [item.start, item.end, item.partial]), [['0', '4', false], ['4', '5', true]]);
  assert.equal(unstated.song.finalBar.declaredPickup, null);
  assert.equal(unstated.song.finalBar.closure, FINAL_BAR_CLOSURE.UNDECLARED_PARTIAL);

  // A pickup as long as its bar is still a bar error.
  assert.deepEqual(messages(validateMML(bar, { meterText: '0 4/4', pickup: '4' })), ['弱起需短於第一小節拍號']);
});

// ─── Case D: nothing is padded or moved ─────────────────────────────────────

test('D: the partial ending is delivered as written: no rest, no longer note, no moved attack', () => {
  const candidate = project(SIX_BEATS);
  const emitted = emitFinalMml(candidate);
  assert.equal(emitted.combinedMml, 'MML@t120o4cde2fg,t120o3g1,,,,;', 'nothing is written after the last note');
  assert.doesNotMatch(emitted.combinedMml.split(',')[0], /r/, 'no rest is appended to the Melody');
  const result = validateMML(emitted.combinedMml, { meterText: '0 4/4' });
  assert.equal(result.song.total, '6', 'the timeline ends where the music ends, not at beat 8');
  const expected = SIX_BEATS.filter(event => event.role === 'Melody').map(event => [event.pitch, event.start, event.end]);
  assert.deepEqual(eventsOf(result.song)[0], expected, 'every Melody attack, pitch and duration as in the candidate');
  assert.deepEqual(eventsOf(result.song)[1], [[55, '0', '4']]);
  // Validating is read-only: with or without the statement, the same events.
  assert.deepEqual(eventsOf(validateMML(emitted.combinedMml, { meterText: '0 4/4', finalPartial: '2' }).song), eventsOf(result.song));
  // Both roles keep their own end; the shorter Chord1 is a P14 review note only.
  assert.ok(result.warnings.some(item => item.code === 'CROSS_ROLE_END_TIME_REVIEW' && item.role === 'Chord1' && /PENDING P14/.test(item.message)));
});

// ─── Case E: real meter and bar problems still fail closed ──────────────────

test('E: a missing, malformed or misaligned meter map still fails, for its own reason', () => {
  const mml = emitFinalMml(project(SIX_BEATS)).combinedMml;
  const cases = [
    [{}, 'Studio Final 驗證需要來源確認的拍號圖，不可自動假設4/4'],
    [{ meterText: '   ' }, 'Studio Final 驗證需要來源確認的拍號圖，不可自動假設4/4'],
    [{ meterText: '0 4/5' }, '拍號分母需為1–128的2次方，分子1–255'],
    [{ meterText: '0 four/4' }, '拍號圖第1行應為「起拍 拍號」'],
    [{ meterText: '1 4/4' }, '拍號圖必須从第0拍開始'],
    [{ meterText: '0 4/4\n2 3/4' }, '第2拍變拍落在小節內；請核對來源或弱起'],
    [{ meterText: '0 4/4\n5 3/4' }, '第5拍變拍落在小節內；請核對來源或弱起'],
    [{ meterText: '0 4/4\n6 3/4' }, '拍號切換需位於樂曲結束之前'],
    [{ meterText: '0 4/4', pickup: '0' }, '弱起及末小節需為正拍長'],
  ];
  for (const [settings, message] of cases) {
    const result = validateMML(mml, settings);
    assert.equal(result.ok, false, JSON.stringify(settings));
    assert.deepEqual(messages(result), [message], JSON.stringify(settings));
    assert.equal(reviewWarnings(result).length, 0, 'a refused bar structure is not also reported as a partial ending');
    assert.equal(result.song.finalBar, null);
  }
  // Other Final failures are untouched by the closure: a tempo map mismatch.
  const mismatch = validateMML('MML@t120o4cd,t100o4cd,,,,;', { meterText: '0 4/4' });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some(error => error.code === 'TEMPO_MAP_MISMATCH'));
});

// ─── Case F: a full last bar is unchanged ───────────────────────────────────

test('F: a Final that ends on its bar line reads exactly as before', () => {
  const full = [note('a', 60, 0, 1), note('b', 62, 1, 2), note('c', 64, 2, 4), note('d', 55, 0, 4, 'Chord1')];
  const mml = emitFinalMml(project(full)).combinedMml;
  const result = validateMML(mml, { meterText: '0 4/4' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.song.bars, [{ index: 1, start: '0', end: '4', numerator: 4, denominator: 4, partial: false }]);
  assert.deepEqual(result.song.finalBar, { closure: FINAL_BAR_CLOSURE.BAR_LINE, beats: '4', declaredPickup: null, declaredFinalPartial: null });
  // A meter change on a bar line, ending on a bar line.
  const changed = validateMML('MML@t120o4c1c2.,,,,,;', { meterText: '0 4/4\n4 3/4' });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.song.bars.map(bar => [bar.start, bar.end, bar.numerator, bar.partial]), [['0', '4', 4, false], ['4', '7', 3, false]]);
  assert.equal(changed.song.finalBar.closure, FINAL_BAR_CLOSURE.BAR_LINE);
});

// ─── Case G: one artifact, one verdict ──────────────────────────────────────

test('G: the emitter, the parser, the Web delivery check and the technical service agree on one Final', async () => {
  const candidate = project(SIX_BEATS);
  const emitted = emitFinalMml(candidate);
  assert.equal(emitted.status, EMIT_STATUS.PASS);
  const mml = emitted.combinedMml;

  const direct = validateMML(mml, { meterText: '0 4/4' });
  // The service every Canonical-claiming transport (MCP mml_validate, the HTTP
  // API) routes to.
  const service = await createStudioApplication({}).validateTechnicalMml({ mml, meter_text: '0 4/4' });
  // The Web workspace grading the same string as its delivery.
  const w = newWorkspace();
  w.title = 'G15 parity';
  w.settings = { meterText: '0 4/4', recording: 'synthetic version 1', offset: '0', end: '6', audioRequired: 'no', preview: 'none' };
  for (const slot of ['candidate', 'baseline']) w.assets[slot] = intake({ name: `${slot}.mml`, content: mml, id: slot, meterText: w.settings.meterText });
  const report = analyzeWorkspace(REVIEW_NAMES.reduce((acc, name) => recordReview(acc, name, `Reviewed ${name}`, 'fixture:whole-piece'), w));

  assert.equal(direct.ok, true);
  assert.equal(service.technical_ok, true);
  assert.equal(report.technical.ok, true);
  assert.equal(report.gates.technical.status, 'PASS');
  assert.equal(report.rawMml, mml, 'the Web carries the exact string');
  // The same review note from each, and the same bar grid.
  for (const warnings of [direct.warnings, service.warnings, report.technical.warnings]) {
    assert.deepEqual(warnings.filter(item => item.code === REVIEW).map(item => [item.start, item.beats]), [['4', '2']]);
  }
  assert.equal(service.bar_count, direct.song.bars.length);
  assert.deepEqual(report.technical.song.bars, direct.song.bars);

  // The legacy engine still refuses it, labelled as the legacy diagnostic it is.
  assert.equal(legacyValidateMML(mml, { meterText: '0 4/4' }).ok, false);
});
