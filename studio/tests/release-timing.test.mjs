// Source release timing / analysis precision / Final representation.
//
// These regressions pin canonical/release-timing.mjs and its wiring into the
// shared micro-gap enforcement. The rules are Published Canonical 2026-09-13-v1:
// MOBILE_SYNTAX §3/§4/§11, MASTER_RULES §3/§7, SOURCE_POLICY §1/§6, Gate 8. They
// add none. The fixtures are synthetic and labelled; the one-tick shape mirrors
// the real 《怪獸之歌》 third-party MIDI encoding but proves nothing about that
// song.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, f } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalTempoEvent,
  createCanonicalProject,
  createArbitrationDecision,
} from '../backend/canonical/index.mjs';
import { MICRO_TIMING_KEEP_ACTION, analyzeProjectMicroTiming } from '../backend/canonical/micro-timing.mjs';
import {
  FINAL_LENGTH_LCM,
  POSITION_CLASS,
  REPRESENTATION,
  TARGET_STATUS,
  RELEASE_REFUSAL,
  EVIDENCE_REFUSAL,
  RECORD_VIOLATION,
  RELEASE_RECORD_KEY,
  classifyPosition,
  analyzeReleaseTiming,
  summarizeReleaseTiming,
  buildEvidenceRegistry,
  gradeReleaseEvidence,
  planReleaseRepresentation,
  releaseRecordFor,
  verifyReleaseRepresentation,
  sourceIdentityOf,
} from '../backend/canonical/release-timing.mjs';
import { MICRO_GAP_BLOCKERS, enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import { planMobileAdaptation } from '../backend/adaptation/index.mjs';
import { compareCandidateLineage } from '../backend/compare/version-drift.mjs';
import { sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const TPQ = 480;
const TICK = new F(1, TPQ);
const MIDI_SHA = 'c'.repeat(64);
const THIRD = createSource({ id: 'third', label: 'Synthetic third-party MIDI', kind: 'third-party-midi', authority: 'supporting', sha256: MIDI_SHA });

// A note carrying the source tick resolution, the way a MIDI intake records it.
const note = ({ id, pitch = 60, start, end, role = 'Melody', sourceId = 'third' }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, voice: role, sourceIds: [sourceId], sourceEventIds: [`${sourceId}#${id}`],
  metadata: { ticksPerQuarter: TPQ },
});
const project = (events, { decisions = [], sources = [THIRD], metadata = {} } = {}) => createCanonicalProject({
  id: 'fixture:release-timing', title: 'release timing fixture', sources, events,
  tempoEvents: [createCanonicalTempoEvent({ id: 't', beat: '0', bpm: 150, sourceIds: [sources[0].id] })], decisions, metadata,
});
// One tick before a beat: the synthetic stand-in for the real encoding.
const tickBefore = beat => f(beat).sub(TICK).toString();

test('RT-1 representability is an arithmetic proof over the admitted Final lengths, not a threshold', () => {
  let twos = 0; let n = FINAL_LENGTH_LCM;
  while (n % 2n === 0n) { n /= 2n; twos += 1; }
  assert.equal(twos, 6, 'no admitted token carries more than a 2^6 whole-note denominator');
  assert.equal(classifyPosition('1'), POSITION_CLASS.SAFE_GRID);
  assert.equal(classifyPosition('17/16'), POSITION_CLASS.SAFE_GRID);
  // Triplets and other caution lengths are off the 1/64 grid but reachable: never adaptation targets.
  for (const beat of ['1/3', '2/3', '1/12', '1/5', '4/7']) assert.equal(classifyPosition(beat), POSITION_CLASS.CAUTION_REPRESENTABLE, beat);
  // One 480-tpq tick off the grid, and a 1/128 whole note, are unreachable by any token sequence.
  for (const beat of ['479/480', '239/480', '1/32', tickBefore(7)]) assert.equal(classifyPosition(beat), POSITION_CLASS.NOT_FINAL_REPRESENTABLE, beat);
});

test('RT-2 a one-tick-early release keeps its source value, gets exact options, and EXTEND is the minimal one', () => {
  const a = note({ id: 'a', pitch: 64, start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', pitch: 64, start: 1, end: tickBefore(2) });
  const c = note({ id: 'c', pitch: 67, start: 2, end: 3 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b, c]) });
  const target = analysis.targets.find(item => item.eventId === 'a');
  // Layer A: the source release is exactly what the source says.
  assert.equal(target.source.release, '479/480');
  assert.equal(target.source.ticksPerQuarter, TPQ);
  // Layer B: finer than the Final grid, exact.
  assert.equal(target.analysis.positionClass, POSITION_CLASS.NOT_FINAL_REPRESENTABLE);
  assert.equal(target.analysis.offsetBeforeNextGrid, '1/480');
  assert.equal(target.analysis.offsetBeforeNextGridTicks, 1);
  assert.equal(target.analysis.followingShape, 'sub-grid-gap-to-next-onset');
  assert.equal(target.analysis.nextIsSamePitchRepeatedAttack, true, 'a repeated attack is flagged, never merged');
  const extend = target.options.find(option => option.representation === REPRESENTATION.EXTEND_TO_NEXT_GRID);
  const truncate = target.options.find(option => option.representation === REPRESENTATION.TRUNCATE_TO_PREVIOUS_GRID);
  assert.deepEqual([extend.valid, extend.finalRelease, extend.delta, extend.effect, extend.introducesArticulation, extend.tieIntroduced], [true, '1', '1/480', 'sub-grid-gap-closed', false, false]);
  assert.deepEqual([truncate.valid, truncate.finalRelease, truncate.deltaTicks, truncate.effect, truncate.introducesArticulation], [true, '15/16', -29, 'new-rest-inserted', true]);
  assert.equal(target.recommended, REPRESENTATION.EXTEND_TO_NEXT_GRID);
  assert.equal(target.musicalMeaning, 'UNDETERMINED', 'analysis never decides meaning');
  assert.equal(target.status, TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED);
  // Onsets are never targets and the on-grid release of c is untouched.
  assert.deepEqual(analysis.targets.map(item => item.eventId).sort(), ['a', 'b']);
});

test('RT-3 a release before a real rest or at a role end is now visible to micro-timing enforcement', () => {
  // a → (rest of a beat plus one tick) → b, then b ends one tick early at the role end.
  // The interval analyzer sees no sub-grid interval anywhere here.
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 2, end: tickBefore(3) });
  const candidate = project([a, b]);
  assert.equal(analyzeProjectMicroTiming(candidate).candidateCount, 0);
  const analysis = analyzeReleaseTiming({ candidate });
  assert.deepEqual(analysis.targets.map(item => item.analysis.followingShape).sort(), ['rest-of-at-least-safe-grid', 'role-end']);
  assert.equal(analysis.notVisibleToIntervalAnalyzerCount, 2);
  const rest = analysis.targets.find(item => item.eventId === 'a').options.find(option => option.representation === REPRESENTATION.EXTEND_TO_NEXT_GRID);
  assert.equal(rest.effect, 'following-rest-shortened', 'a meaningful rest survives, shorter by exactly one tick');
  assert.equal(rest.followingSilenceAfter, '1');
  const enforcement = enforceMicroGaps(candidate);
  assert.equal(enforcement.status, 'PENDING');
  assert.deepEqual(enforcement.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]);
  assert.equal(enforcement.releaseTiming.targetCount, 2);
});

test('RT-4 a project Final can already express keeps its enforcement result byte for byte', () => {
  const clean = sixRoleBaseline();
  const report = enforceMicroGaps(clean);
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.releaseTiming.targetCount, 0);
  // Caution-representable timing (a triplet) is neither a target nor a blocker.
  const triplet = project([note({ id: 't1', start: 0, end: '1/3' }), note({ id: 't2', start: '1/3', end: '2/3' }), note({ id: 't3', start: '2/3', end: 1 })]);
  assert.equal(analyzeReleaseTiming({ candidate: triplet }).targetCount, 0);
  assert.equal(enforceMicroGaps(triplet).blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE), false);
});

test('RT-5 options that would move an attack, swallow a rest or leave a sub-grid note are invalid', () => {
  // x ends one tick before y starts; y starts one tick before the grid itself, so
  // extending x to the grid would cross y's attack. x is also shorter than 1/64,
  // so truncating it would delete it.
  const x = note({ id: 'x', start: 0, end: tickBefore('1/16') });
  const y = note({ id: 'y', start: tickBefore('1/16'), end: 1 });
  const analysis = analyzeReleaseTiming({ candidate: project([x, y]) });
  // x's release is shared with y's (unrepresentable) attack: never a release target.
  assert.equal(analysis.targets.some(item => item.eventId === 'x'), false);
  assert.ok(analysis.unsupportedBoundaries.some(item => item.eventId === 'x' && item.reason === 'RELEASE_SHARED_WITH_AN_UNREPRESENTABLE_ONSET'));
  assert.ok(analysis.unsupportedBoundaries.some(item => item.eventId === 'y' && item.reason === 'ONSET_NOT_FINAL_REPRESENTABLE'));

  // A note shorter than 1/64 whose release is one tick early, then a rest of
  // exactly 1/64 + 1 tick: extending keeps a 1/64 rest, truncating deletes it.
  const short = note({ id: 's', start: 0, end: f('1/16').sub(TICK).toString() });
  const next = note({ id: 'n', start: '1/8', end: 1 });
  const invalid = analyzeReleaseTiming({ candidate: project([short, next]) }).targets.find(item => item.eventId === 's');
  const truncate = invalid.options.find(option => option.representation === REPRESENTATION.TRUNCATE_TO_PREVIOUS_GRID);
  assert.equal(truncate.valid, false);
  assert.ok(truncate.reasons.includes('TRUNCATION_WOULD_DELETE_THE_ATTACK'));
  const extend = invalid.options.find(option => option.representation === REPRESENTATION.EXTEND_TO_NEXT_GRID);
  assert.equal(extend.valid, true);
  assert.equal(invalid.recommended, REPRESENTATION.EXTEND_TO_NEXT_GRID);
});

test('RT-6 an explicit rest is never swallowed by an extension', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const r = createCanonicalRestEvent({ id: 'r', start: tickBefore(1), end: 2, role: 'Melody', voice: 'Melody', sourceIds: ['third'] });
  const b = note({ id: 'b', start: 2, end: 3 });
  const target = analyzeReleaseTiming({ candidate: project([a, r, b]) }).targets.find(item => item.eventId === 'a');
  const extend = target.options.find(option => option.representation === REPRESENTATION.EXTEND_TO_NEXT_GRID);
  assert.equal(extend.valid, false);
  assert.ok(extend.reasons.includes('EXTENSION_CROSSES_A_SAME_ROLE_ONSET') || extend.reasons.includes('EXTENSION_ENTERS_AN_EXPLICIT_REST'));
});

test('RT-7 a keep claim makes the release UNSUPPORTED in Final, never a representation target', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: 2 });
  const keep = createArbitrationDecision({ id: 'keep', eventIds: ['a', 'b'], action: MICRO_TIMING_KEEP_ACTION, status: 'pending', reason: 'claimed articulation' });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b], { decisions: [keep] }) });
  const target = analysis.targets.find(item => item.eventId === 'a');
  assert.equal(target.status, TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE);
  assert.equal(target.musicalMeaning, 'SOURCE_SUPPORTED_CLAIM');
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({}), input: { decisions: [humanAudioDecision(['a'])] } });
  assert.deepEqual(plan.blockers.map(item => item.code), [RELEASE_REFUSAL.KEEP_DECISION_PRESENT]);
  assert.equal(plan.changes.length, 0);
});

test('RT-8 a uniform encoding pattern is reported as an observation and is never admissible evidence', () => {
  const events = [0, 1, 2, 3].map(beat => note({ id: `n${beat}`, start: beat, end: tickBefore(beat + 1) }));
  const summary = summarizeReleaseTiming(analyzeReleaseTiming({ candidate: project(events) }));
  const [observation] = summary.encodingObservations;
  assert.equal(observation.uniform, true);
  assert.deepEqual(observation.offsetsBeforeNextGrid, { '1 tick(s)': 4 });
  assert.equal(observation.evidenceClass, 'SOURCE_ENCODING_PATTERN');
  assert.equal(observation.admissibleAsEvidence, false);
  const grade = gradeReleaseEvidence({ attestation: { reviewer: 'r', reviewer_kind: 'human', audio_basis: 'not-used' }, evidence: [{ class: 'source-encoding-pattern', ref: 'third', locator: 'whole file', finding: 'every release is one tick early' }] }, buildEvidenceRegistry({ sources: [THIRD] }));
  assert.equal(grade.admissible, false);
  assert.deepEqual(grade.items[0].reasons, [EVIDENCE_REFUSAL.CLASS_NOT_ADMISSIBLE]);
  assert.match(grade.items[0].nonAdmissibleClassNotice, /not source-supported musical meaning/);
});

const ASSETS = Object.freeze([
  { asset_id: 'ast_third', kind: 'third_party_midi', sha256: MIDI_SHA },
  // The same bytes uploaded again under an official label: a relabelled copy.
  { asset_id: 'ast_relabelled', kind: 'official_midi', sha256: MIDI_SHA },
  { asset_id: 'ast_score', kind: 'official_musicxml', sha256: 'd'.repeat(64) },
  { asset_id: 'ast_audio', kind: 'original_audio', sha256: 'e'.repeat(64) },
]);
function humanAudioDecision(eventIds, { id = 'rr-audio', representation = REPRESENTATION.EXTEND_TO_NEXT_GRID, attestation = { reviewer: 'user:reviewer', reviewer_kind: 'human', audio_basis: 'listening' } } = {}) {
  return { id, eventIds, representation, reason: 'Legato in the recording; no audible separation at these boundaries.', attestation,
    evidence: [{ class: 'primary-audio', ref: 'ast_audio', locator: '0:12-0:20', finding: 'Sustained through each boundary; no audible break.' }] };
}

test('RT-9 evidence counts only when a human attests an independent primary source under a matching kind', () => {
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  assert.equal(registry.get('ast_relabelled').independent, false, 'byte-identical to the third-party MIDI');
  assert.equal(registry.get('ast_score').independent, true);
  const grade = decision => gradeReleaseEvidence(decision, registry);
  assert.equal(grade(humanAudioDecision(['a'])).admissible, true);
  assert.deepEqual(grade(humanAudioDecision(['a'], { attestation: { reviewer: 'agent:x', reviewer_kind: 'agent', audio_basis: 'listening' } })).reasons, [EVIDENCE_REFUSAL.ATTESTATION_NOT_HUMAN]);
  assert.equal(grade(humanAudioDecision(['a'], { attestation: { reviewer: 'agent:x', reviewer_kind: 'agent', audio_basis: 'listening' } })).countedAsReviewerEvidence, false);
  assert.deepEqual(grade(humanAudioDecision(['a'], { attestation: { reviewer: 'u', reviewer_kind: 'human', audio_basis: 'machine-metric' } })).items[0].reasons, [EVIDENCE_REFUSAL.AUDIO_BASIS_NOT_LISTENING]);
  assert.deepEqual(grade({ attestation: null, evidence: [] }).reasons, [EVIDENCE_REFUSAL.ATTESTATION_MISSING]);
  const symbolic = ref => ({ attestation: { reviewer: 'u', reviewer_kind: 'human', audio_basis: 'not-used' }, evidence: [{ class: 'primary-symbolic', ref, locator: 'bars 1-4', finding: 'Notated eighth notes, no staccato.' }] });
  assert.equal(grade(symbolic('ast_score')).admissible, true);
  assert.deepEqual(grade(symbolic('ast_relabelled')).items[0].reasons, [EVIDENCE_REFUSAL.NOT_INDEPENDENT]);
  assert.deepEqual(grade(symbolic('ast_third')).items[0].reasons, [EVIDENCE_REFUSAL.KIND_MISMATCH]);
  assert.deepEqual(grade(symbolic('ast_missing')).items[0].reasons, [EVIDENCE_REFUSAL.REF_UNKNOWN]);
  // An imported Canonical source cannot promote itself by its authority string alone.
  const imported = buildEvidenceRegistry({ sources: [createSource({ id: 'claims-official', label: 'x', kind: 'third-party-midi', authority: 'primary-symbolic' })] });
  assert.equal(gradeReleaseEvidence(symbolic('claims-official'), imported).admissible, false);
});

test('RT-10 decisions become exact per-event changes only when admissible, and malformed statements are refused', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: tickBefore(2) });
  const c = note({ id: 'c', start: 2, end: 3 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b, c]) });
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  const pending = planReleaseRepresentation({ analysis, registry, input: { decisions: [humanAudioDecision(['a', 'b'], { attestation: { reviewer: 'agent', reviewer_kind: 'agent', audio_basis: 'listening' } })] } });
  assert.equal(pending.changes.length, 0, 'an agent assertion moves nothing');
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.unresolvedTargetCount, 2);
  const applied = planReleaseRepresentation({ analysis, registry, input: { decisions: [humanAudioDecision(['a', 'b'])] } });
  assert.deepEqual(applied.changes.map(change => [change.eventId, change.before.end, change.after.end, change.delta, change.selectedRecommended]), [
    ['a', '479/480', '1', '1/480', true],
    ['b', '959/480', '2', '1/480', true],
  ]);
  assert.equal(applied.unresolvedTargetCount, 0);
  const refused = planReleaseRepresentation({ analysis, registry, input: { decisions: [humanAudioDecision(['c'])] } });
  assert.deepEqual(refused.blockers.map(item => item.code), [RELEASE_REFUSAL.EVENT_NOT_A_TARGET]);
  const conflict = planReleaseRepresentation({ analysis, registry, input: { decisions: [humanAudioDecision(['a'], { id: 'one' }), humanAudioDecision(['a'], { id: 'two' })] } });
  assert.ok(conflict.blockers.every(item => item.code === RELEASE_REFUSAL.DECISION_CONFLICT));
  assert.throws(() => planReleaseRepresentation({ analysis, registry, input: { decisions: [{ ...humanAudioDecision(['a']), pitch: 61 }] } }), /unsupported/);
  assert.throws(() => planReleaseRepresentation({ analysis, registry, input: { decisions: [{ ...humanAudioDecision(['a']), representation: 'QUANTIZE' }] } }), /representation/);
});

function represented(candidateEvents, changes, decisions, { snapshotEvents = candidateEvents } = {}) {
  const byId = new Map(changes.map(change => [change.eventId, change]));
  const events = candidateEvents.map(event => (byId.has(event.id)
    ? createCanonicalNoteEvent({ ...event, end: byId.get(event.id).after.end, metadata: { ...event.metadata, [RELEASE_RECORD_KEY]: releaseRecordFor(byId.get(event.id)) } })
    : event));
  const snapshot = project(snapshotEvents);
  return project(events, { metadata: { sourceFaithfulBaseline: { snapshot }, mobileAdaptation: { releaseRepresentation: { decisions } } } });
}

test('RT-11 a recorded representation re-verifies from the project alone, and every forgery is caught', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: 2 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b]) });
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  const plan = planReleaseRepresentation({ analysis, registry, input: { decisions: [humanAudioDecision(['a'])] } });
  const good = represented([a, b], plan.changes, plan.decisions);
  assert.deepEqual(verifyReleaseRepresentation(good).violations, []);
  const clean = enforceMicroGaps(good);
  assert.equal(clean.status, 'PASS', 'the represented release leaves no sub-grid interval and no non-representable release');
  assert.equal(clean.releaseRepresentationRecords.recordCount, 1);

  const codes = candidate => verifyReleaseRepresentation(candidate).violations.map(item => item.code);
  // The baseline no longer says what the record says the source said.
  assert.ok(codes(represented([a, b], plan.changes, plan.decisions, { snapshotEvents: [note({ id: 'a', start: 0, end: tickBefore('3/4') }), b] })).includes(RECORD_VIOLATION.SOURCE_RELEASE_MISMATCH));
  // The decision the record names is not stored.
  assert.ok(codes(represented([a, b], plan.changes, [])).includes(RECORD_VIOLATION.DECISION_MISSING));
  // A stored decision whose attestation is an agent's never re-grades admissible.
  const forged = plan.decisions.map(decision => ({ ...decision, attestation: { ...decision.attestation, reviewer_kind: 'agent' } }));
  assert.ok(codes(represented([a, b], plan.changes, forged)).includes(RECORD_VIOLATION.DECISION_NOT_ADMISSIBLE));
  // A release moved by more than one sub-grid step is not a representation.
  const far = plan.changes.map(change => ({ ...change, after: { end: '2' }, delta: f('2').sub(change.before.end).toString() }));
  const farCodes = codes(represented([a, note({ id: 'b', start: 2, end: 3 })], far, plan.decisions, { snapshotEvents: [a, note({ id: 'b', start: 2, end: 3 })] }));
  assert.ok(farCodes.includes(RECORD_VIOLATION.DELTA_OUT_OF_RANGE));
  const invalid = enforceMicroGaps(represented([a, b], plan.changes, forged));
  assert.equal(invalid.status, 'FAIL');
  assert.ok(invalid.blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_RECORD_INVALID));
});

test('RT-12 the source identity of a represented note is its source release, and nothing else is reversed', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: 2 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b]) });
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({ assets: ASSETS }), input: { decisions: [humanAudioDecision(['a'])] } });
  const adapted = represented([a, b], plan.changes, plan.decisions).events.find(event => event.id === 'a');
  assert.equal(adapted.end, '1');
  assert.equal(sourceIdentityOf(adapted, a).end, '479/480');
  // A record that does not match the event is not honoured.
  const tampered = { ...adapted, end: '2' };
  assert.equal(sourceIdentityOf(tampered, a).end, '2');
  // A pitch change is never reversed by a release record.
  assert.equal(sourceIdentityOf({ ...adapted, pitch: 72 }, a).pitch, 72);
});

test('RT-13 no release representation without a Source-Faithful Baseline, and nothing is invented without input', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const candidate = project([a, note({ id: 'b', start: 1, end: 2 })]);
  assert.throws(() => planMobileAdaptation({ baseline: null, candidate, releaseRepresentation: { decisions: [] } }), /Source-Faithful Baseline/);
  assert.throws(() => planMobileAdaptation({ baseline: candidate, candidate }), /profile, release representation decisions, or both/);
  const plan = planMobileAdaptation({ baseline: candidate, candidate, releaseRepresentation: { decisions: [] } });
  assert.equal(plan.profile, null, 'no profile is invented');
  assert.equal(plan.profileRequirement.status, 'NOT_SUPPLIED');
  assert.deepEqual(plan.changes, []);
});

test('RT-14 an accepted previous version stays comparable, and the comparison shows only the recorded release moves', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: tickBefore(2) });
  const source = project([a, b]);
  const analysis = analyzeReleaseTiming({ candidate: source });
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({ assets: ASSETS }), input: { decisions: [humanAudioDecision(['a', 'b'])] } });
  const candidate = represented([a, b], plan.changes, plan.decisions);
  // An accepted previous version that already carried a on the grid.
  const previous = project([note({ id: 'a', start: 0, end: 1 }), b]);
  const lineage = compareCandidateLineage({ sourceBaseline: source, acceptedPrevious: previous, candidate });
  assert.equal(lineage.sourceToCandidate.summary.noteModified, 2);
  assert.equal(lineage.previousToCandidate.summary.noteModified, 1, 'only b differs from the accepted previous version');
  assert.deepEqual(lineage.previousToCandidate.notes.modified.map(pair => [pair.before.id, pair.changes.end]), [['b', { before: '959/480', after: '2' }]]);
  assert.equal(lineage.sourceToCandidate.summary.noteAdded + lineage.sourceToCandidate.summary.noteRemoved, 0);
});
