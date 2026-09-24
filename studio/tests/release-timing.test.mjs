// Source release timing / analysis precision / Final representation.
//
// These regressions pin canonical/release-timing.mjs and its wiring into the
// shared micro-gap enforcement. The rules are Published Canonical 2026-09-13-v1:
// MOBILE_SYNTAX §3/§4/§11, MASTER_RULES §3/§7, SOURCE_POLICY §1/§6, Gate 8. They
// add none. The fixtures are synthetic and labelled; the one-tick shape mirrors
// the captured real song's third-party MIDI encoding but proves nothing about that
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
import { MICRO_TIMING_KEEP_ACTION, analyzeProjectMicroTiming, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import {
  FINAL_LENGTH_LCM,
  POSITION_CLASS,
  REPRESENTATION,
  TARGET_STATUS,
  RELEASE_REFUSAL,
  EVIDENCE_REFUSAL,
  EVIDENCE_BASIS,
  DECISION_AUTHOR_KINDS,
  RELEASE_CLAIM,
  RELEASE_EVIDENCE_REQUIREMENT,
  RECORD_VIOLATION,
  RELEASE_RECORD_KEY,
  classifyPosition,
  analyzeReleaseTiming,
  summarizeReleaseTiming,
  buildEvidenceRegistry,
  gradeReleaseEvidence,
  planReleaseRepresentation,
  releaseEvidenceRequirement,
  releaseRecordFor,
  verifyReleaseRepresentation,
  sourceIdentityOf,
} from '../backend/canonical/release-timing.mjs';
import { MICRO_GAP_BLOCKERS, enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import { planMobileAdaptation } from '../backend/adaptation/index.mjs';
import { emitFinalMml } from '../backend/final/mml-emitter.mjs';
import { REPAIR_DIAGNOSTICS, repairTechnicalTiming } from '../backend/final/technical-timing-repair.mjs';
import { contentDigest } from '../backend/arrangement/decision-application.mjs';
import { compareCandidateLineage, compareCanonicalVersions } from '../backend/compare/version-drift.mjs';
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
  // Both releases sit at their one source's single offset, one tick before the
  // grid, and nothing else is open, so the gate also says the whole question is
  // release-side (2026-09-23-v3). It stays PENDING; whether a delivery may hold
  // the releases is the machine-delivery schema's call, not this gate's.
  assert.deepEqual(enforcement.blockers, [MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL]);
  assert.deepEqual(enforcement.provisionalReleases.map(item => [item.eventId, item.heldTo, item.intervalKeys.length]), [['a', '1', 0], ['b', '3', 0]]);
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
  // A pending keep on the gap that follows a: an open claim on a's release.
  const keep = createArbitrationDecision({ id: 'keep', eventIds: ['a', 'b'], action: MICRO_TIMING_KEEP_ACTION, status: 'pending', reason: 'claimed articulation',
    metadata: { intervalIdentity: createIntervalIdentity({ type: 'inter-event-gap', previousEventId: 'a', nextEventId: 'b', start: tickBefore(1), end: '1' }) } });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b], { decisions: [keep] }) });
  const target = analysis.targets.find(item => item.eventId === 'a');
  assert.equal(target.status, TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE);
  assert.equal(target.musicalMeaning, 'SOURCE_SUPPORTED_CLAIM');
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({}), input: { decisions: [audioDecision(['a'])] } });
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
  // Whoever submits it: the pattern is structure over a supporting file.
  for (const reviewer_kind of ['agent', 'human']) {
    const grade = gradeReleaseEvidence({ representation: REPRESENTATION.EXTEND_TO_NEXT_GRID, attestation: { reviewer: 'r', reviewer_kind }, evidence: [{ class: 'source-encoding-pattern', ref: 'third', basis: EVIDENCE_BASIS.ENCODING_PATTERN, locator: 'whole file', finding: 'every release is one tick early' }] }, buildEvidenceRegistry({ sources: [THIRD] }));
    assert.equal(grade.admissible, false, reviewer_kind);
    assert.deepEqual(grade.items[0].reasons, [EVIDENCE_REFUSAL.CLASS_NOT_ADMISSIBLE, EVIDENCE_REFUSAL.BASIS_NOT_SOURCE_REVIEW]);
    assert.match(grade.items[0].nonAdmissibleClassNotice, /not source-supported musical meaning/);
    assert.match(grade.items[0].nonAdmissibleBasisNotice, /not source-supported musical meaning/);
  }
});

const ASSETS = Object.freeze([
  { asset_id: 'ast_third', kind: 'third_party_midi', sha256: MIDI_SHA },
  // The same bytes uploaded again under an official label: a relabelled copy.
  { asset_id: 'ast_relabelled', kind: 'official_midi', sha256: MIDI_SHA },
  { asset_id: 'ast_score', kind: 'official_musicxml', sha256: 'd'.repeat(64) },
  { asset_id: 'ast_audio', kind: 'original_audio', sha256: 'e'.repeat(64) },
]);
// A direct review of the original recording. The default submitter is a
// conversational AI on purpose: who submits is provenance, not authority.
const AGENT = Object.freeze({ reviewer: 'agent:assistant', reviewer_kind: 'agent' });
const HUMAN = Object.freeze({ reviewer: 'user:reviewer', reviewer_kind: 'human' });
function audioDecision(eventIds, { id = 'rr-audio', representation = REPRESENTATION.EXTEND_TO_NEXT_GRID, attestation = AGENT, basis = EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW, ref = 'ast_audio' } = {}) {
  return { id, eventIds, representation, reason: 'Legato in the recording; no audible separation at these boundaries.', attestation,
    evidence: [{ class: 'primary-audio', ref, basis, locator: '0:12-0:20', finding: 'Sustained through each boundary; no separation before the next attack.' }] };
}
function scoreDecision(eventIds, { id = 'rr-score', attestation = AGENT, ref = 'ast_score', basis = EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW, evidenceClass = 'primary-symbolic' } = {}) {
  return { id, eventIds, representation: REPRESENTATION.EXTEND_TO_NEXT_GRID, reason: 'Notated durations reach the next beat.', attestation,
    evidence: [{ class: evidenceClass, ref, basis, locator: 'bars 1-4', finding: 'Notated quarter notes, no staccato or rest between them.' }] };
}
// The grade with the submitter taken out: what must not depend on who submitted.
const gradeWithoutProvenance = grade => JSON.stringify({ admissible: grade.admissible, claim: grade.claim, reasons: grade.reasons, items: grade.items });

test('RT-9 evidence authority is the cited source, its basis and the claim; who submitted the decision is provenance only', () => {
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  assert.equal(registry.get('ast_relabelled').independent, false, 'byte-identical to the third-party MIDI');
  assert.equal(registry.get('ast_score').independent, true);
  const grade = decision => gradeReleaseEvidence(decision, registry);

  // R1/R2/R3: the same independent primary citation grades the same for every
  // kind of submitter, a conversational AI included.
  const byKind = kind => ({ audio: grade(audioDecision(['a'], { attestation: { reviewer: `${kind}:x`, reviewer_kind: kind } })), score: grade(scoreDecision(['a'], { attestation: { reviewer: `${kind}:x`, reviewer_kind: kind } })) });
  const reference = byKind('human');
  assert.equal(reference.audio.admissible, true);
  assert.equal(reference.score.admissible, true);
  for (const kind of DECISION_AUTHOR_KINDS) {
    const graded = byKind(kind);
    assert.equal(graded.audio.attestation.reviewer_kind, kind, 'provenance is recorded');
    assert.equal(gradeWithoutProvenance(graded.audio), gradeWithoutProvenance(reference.audio), `${kind}: audio grade`);
    assert.equal(gradeWithoutProvenance(graded.score), gradeWithoutProvenance(reference.score), `${kind}: score grade`);
  }
  assert.equal(reference.audio.claim, RELEASE_CLAIM.SUSTAINS_TO_GRID);
  assert.match(reference.audio.items[0].claimAuthority, /SOURCE_POLICY §1B/);
  assert.match(reference.score.items[0].claimAuthority, /SOURCE_POLICY §1A/);
  // A decision must still say who submitted it, whoever that is.
  assert.deepEqual(grade({ ...audioDecision(['a']), attestation: null }).reasons, [EVIDENCE_REFUSAL.PROVENANCE_MISSING]);
  assert.deepEqual(grade({ ...audioDecision(['a']), attestation: { reviewer: 'x', reviewer_kind: 'wizard' } }).reasons, [EVIDENCE_REFUSAL.PROVENANCE_MISSING]);

  // R4: a person does not make weak evidence strong.
  for (const attestation of [HUMAN, AGENT]) {
    assert.deepEqual(grade(scoreDecision(['a'], { attestation, ref: 'ast_third', evidenceClass: 'third-party' })).items[0].reasons, [EVIDENCE_REFUSAL.CLASS_NOT_ADMISSIBLE]);
    assert.deepEqual(grade(scoreDecision(['a'], { attestation, ref: 'ast_third' })).items[0].reasons, [EVIDENCE_REFUSAL.KIND_MISMATCH]);
    assert.deepEqual(grade(scoreDecision(['a'], { attestation, ref: 'ast_relabelled' })).items[0].reasons, [EVIDENCE_REFUSAL.NOT_INDEPENDENT]);
    assert.deepEqual(grade(scoreDecision(['a'], { attestation, ref: 'ast_missing' })).items[0].reasons, [EVIDENCE_REFUSAL.REF_UNKNOWN]);
  }

  // R6/R8: the original recording stays a primary source (R7), but a metric or
  // an alignment locator computed from it is not a finding about it (SOURCE_POLICY
  // §6), for anyone; nor is an unstated basis.
  for (const attestation of [HUMAN, AGENT]) {
    for (const basis of [EVIDENCE_BASIS.MACHINE_METRIC, EVIDENCE_BASIS.ALIGNMENT_LOCATOR, EVIDENCE_BASIS.IMPORTED_ASSERTION]) {
      const metric = grade(audioDecision(['a'], { attestation, basis }));
      assert.equal(metric.admissible, false, `${attestation.reviewer_kind} ${basis}`);
      assert.deepEqual(metric.items[0].reasons, [EVIDENCE_REFUSAL.BASIS_NOT_SOURCE_REVIEW]);
      assert.equal(metric.items[0].resolved.primary, true, 'the source itself is still primary');
    }
    assert.deepEqual(grade(audioDecision(['a'], { attestation, basis: '' })).items[0].reasons, [EVIDENCE_REFUSAL.BASIS_MISSING]);
    const metricClass = grade({ ...audioDecision(['a'], { attestation }), evidence: [{ class: 'audio-metric', ref: 'ast_audio', basis: EVIDENCE_BASIS.MACHINE_METRIC, locator: '0:12', finding: 'release energy drop' }] });
    assert.deepEqual(metricClass.items[0].reasons, [EVIDENCE_REFUSAL.CLASS_NOT_ADMISSIBLE, EVIDENCE_REFUSAL.BASIS_NOT_SOURCE_REVIEW]);
  }
  assert.match(grade(audioDecision(['a'], { basis: EVIDENCE_BASIS.MACHINE_METRIC })).items[0].nonAdmissibleBasisNotice, /SOURCE_POLICY §6/);

  // The first schema's decision-level audio_basis still reads, with its old
  // human-only meaning gone: `listening` is a direct review by whoever did it.
  const legacy = attestation => ({ ...audioDecision(['a'], { basis: '' }), attestation });
  assert.equal(grade(legacy({ reviewer: 'agent:x', reviewer_kind: 'agent', audio_basis: 'listening' })).admissible, true);
  assert.deepEqual(grade(legacy({ reviewer: 'user:x', reviewer_kind: 'human', audio_basis: 'machine-metric' })).items[0].reasons, [EVIDENCE_REFUSAL.BASIS_NOT_SOURCE_REVIEW]);
  assert.deepEqual(grade(legacy({ reviewer: 'user:x', reviewer_kind: 'human', audio_basis: 'constructor' })).items[0].reasons, [EVIDENCE_REFUSAL.BASIS_MISSING], 'only own table keys are read');
  assert.equal(grade(legacy({ reviewer: 'user:x', reviewer_kind: 'human', audio_basis: 'listening' })).attestation.audio_basis, undefined, 'provenance records who, not how');

  // An imported Canonical source cannot promote itself by its authority string alone.
  const imported = buildEvidenceRegistry({ sources: [createSource({ id: 'claims-official', label: 'x', kind: 'third-party-midi', authority: 'primary-symbolic' })] });
  assert.equal(gradeReleaseEvidence(scoreDecision(['a'], { ref: 'claims-official' }), imported).admissible, false);
});

test('RT-9b what would settle an open release is named from the sources the project holds, never from who may submit it', () => {
  const realSongShaped = buildEvidenceRegistry({ assets: [ASSETS[0], ASSETS[1], ASSETS[3]], sources: [THIRD] });
  const requirement = releaseEvidenceRequirement(realSongShaped);
  assert.deepEqual(requirement.anyOf.map(item => [item.code, [...item.availableRefs], [...item.notIndependentRefs]]), [
    [RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_REVIEW_REQUIRED, ['ast_audio'], []],
    [RELEASE_EVIDENCE_REQUIREMENT.SYMBOLIC_SOURCE_REQUIRED, [], ['ast_relabelled']],
  ]);
  assert.doesNotMatch(JSON.stringify(requirement), /human|HUMAN|listen/);
  const withScore = releaseEvidenceRequirement(buildEvidenceRegistry({ assets: ASSETS }));
  assert.equal(withScore.anyOf[1].code, RELEASE_EVIDENCE_REQUIREMENT.SYMBOLIC_SOURCE_REVIEW_REQUIRED);
  assert.deepEqual([...withScore.anyOf[1].availableRefs], ['ast_score']);
  assert.equal(releaseEvidenceRequirement(buildEvidenceRegistry({})).anyOf[0].code, RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_SOURCE_REQUIRED);
  assert.equal(releaseEvidenceRequirement(null), null, 'without a registry nothing is guessed');
  // Surfaced by the micro-timing gate as a precise blocker when a registry is known.
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const candidate = project([a, note({ id: 'b', start: 2, end: 3 })]);
  const gate = enforceMicroGaps(candidate, { releaseEvidenceRegistry: realSongShaped });
  assert.ok(gate.blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_EVIDENCE_REQUIRED));
  assert.equal(gate.releaseEvidenceRequirement.anyOf[0].code, RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_REVIEW_REQUIRED);
  assert.ok(!enforceMicroGaps(candidate).blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_EVIDENCE_REQUIRED), 'unknown sources: no requirement is guessed');
});

test('RT-10 decisions become exact per-event changes only when admissible, and malformed statements are refused', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: tickBefore(2) });
  const c = note({ id: 'c', start: 2, end: 3 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b, c]) });
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  const pending = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['a', 'b'], { basis: EVIDENCE_BASIS.MACHINE_METRIC })] } });
  assert.equal(pending.changes.length, 0, 'a metric-only citation moves nothing');
  assert.equal(pending.pending.length, 1);
  assert.deepEqual([...pending.pending[0].reasons], [EVIDENCE_REFUSAL.NO_ADMISSIBLE_ITEM]);
  assert.deepEqual([...pending.pending[0].items[0].reasons], [EVIDENCE_REFUSAL.BASIS_NOT_SOURCE_REVIEW]);
  assert.equal(pending.unresolvedTargetCount, 2);
  const applied = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['a', 'b'])] } });
  // The same citation submitted by a person plans the identical changes.
  const byHuman = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['a', 'b'], { attestation: HUMAN })] } });
  assert.deepEqual(byHuman.changes, applied.changes);
  assert.equal(applied.decisions[0].claim, RELEASE_CLAIM.SUSTAINS_TO_GRID);
  assert.deepEqual(applied.changes.map(change => [change.eventId, change.before.end, change.after.end, change.delta, change.selectedRecommended]), [
    ['a', '479/480', '1', '1/480', true],
    ['b', '959/480', '2', '1/480', true],
  ]);
  assert.equal(applied.unresolvedTargetCount, 0);
  const refused = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['c'])] } });
  assert.deepEqual(refused.blockers.map(item => item.code), [RELEASE_REFUSAL.EVENT_NOT_A_TARGET]);
  const conflict = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['a'], { id: 'one' }), audioDecision(['a'], { id: 'two' })] } });
  assert.ok(conflict.blockers.every(item => item.code === RELEASE_REFUSAL.DECISION_CONFLICT));
  assert.throws(() => planReleaseRepresentation({ analysis, registry, input: { decisions: [{ ...audioDecision(['a']), pitch: 61 }] } }), /unsupported/);
  assert.throws(() => planReleaseRepresentation({ analysis, registry, input: { decisions: [{ ...audioDecision(['a']), representation: 'QUANTIZE' }] } }), /representation/);
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
  const plan = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['a'])] } });
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
  // Re-labelling the submitter changes nothing either way: provenance is not authority.
  const relabelled = plan.decisions.map(decision => ({ ...decision, attestation: { ...decision.attestation, reviewer_kind: 'human' } }));
  assert.deepEqual(codes(represented([a, b], plan.changes, relabelled)), []);
  // A stored citation whose basis was edited to a metric never re-grades admissible.
  const forged = plan.decisions.map(decision => ({ ...decision, evidence: decision.evidence.map(item => ({ ...item, basis: EVIDENCE_BASIS.MACHINE_METRIC })) }));
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
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({ assets: ASSETS }), input: { decisions: [audioDecision(['a'])] } });
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
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({ assets: ASSETS }), input: { decisions: [audioDecision(['a', 'b'])] } });
  const candidate = represented([a, b], plan.changes, plan.decisions);
  // An accepted previous version that already carried a on the grid.
  const previous = project([note({ id: 'a', start: 0, end: 1 }), b]);
  const lineage = compareCandidateLineage({ sourceBaseline: source, acceptedPrevious: previous, candidate });
  assert.equal(lineage.sourceToCandidate.summary.noteModified, 2);
  assert.equal(lineage.previousToCandidate.summary.noteModified, 1, 'only b differs from the accepted previous version');
  assert.deepEqual(lineage.previousToCandidate.notes.modified.map(pair => [pair.before.id, pair.changes.end]), [['b', { before: '959/480', after: '2' }]]);
  assert.equal(lineage.sourceToCandidate.summary.noteAdded + lineage.sourceToCandidate.summary.noteRemoved, 0);
});

test('RT-15 the version diff pairs a moved release with its source note only through a recorded representation', () => {
  const source = createCanonicalNoteEvent({ id: 'a', pitch: 60, start: '0', end: tickBefore(1), role: null, sourceIds: ['third'], metadata: {} });
  const baseline = project([source]);
  // Same onset and pitch, new role and a different release, but no record: an
  // unrelated removal and addition, exactly as before this pass existed.
  const unrecorded = project([createCanonicalNoteEvent({ ...source, role: 'Melody', end: '1' })]);
  const plain = compareCanonicalVersions(baseline, unrecorded);
  assert.deepEqual([plain.summary.noteRemoved, plain.summary.noteAdded, plain.summary.noteModified], [1, 1, 0]);
  // With the record naming that exact source release, it is one modified note.
  const change = { eventId: 'a', before: { end: source.end }, after: { end: '1' }, delta: '1/480', deltaTicks: 1, representation: REPRESENTATION.EXTEND_TO_NEXT_GRID, effect: 'role-end-moves-later', decisionId: 'rr' };
  const recorded = project([createCanonicalNoteEvent({ ...source, role: 'Melody', end: '1', metadata: { [RELEASE_RECORD_KEY]: releaseRecordFor(change) } })]);
  const traced = compareCanonicalVersions(baseline, recorded);
  assert.deepEqual([traced.summary.noteRemoved, traced.summary.noteAdded, traced.summary.noteModified], [0, 0, 1]);
  assert.deepEqual(traced.notes.modified[0].changes.end, { before: source.end, after: '1' });
  // A record naming a different source release pairs nothing.
  const wrong = project([createCanonicalNoteEvent({ ...source, role: 'Melody', end: '1', metadata: { [RELEASE_RECORD_KEY]: releaseRecordFor({ ...change, before: { end: tickBefore('3/4') } }) } })]);
  assert.equal(compareCanonicalVersions(baseline, wrong).summary.noteModified, 0);
});

test('RT-16 a keep claim covers only the release it names, and a rejected claim is no claim', () => {
  // Review reproduction: W → one-tick gap → X, then X is followed by a real rest.
  // A keep on the W→X gap is about W's release, never X's.
  const w = note({ id: 'w', start: 0, end: tickBefore(1) });
  const x = note({ id: 'x', start: 1, end: tickBefore(2) });
  const y = note({ id: 'y', start: 3, end: 4 });
  const gap = createIntervalIdentity({ type: 'inter-event-gap', previousEventId: 'w', nextEventId: 'x', start: tickBefore(1), end: '1' });
  const OFFICIAL = createSource({ id: 'official', label: 'official score', kind: 'official-musicxml', authority: 'primary-symbolic' });
  const onOfficial = event => createCanonicalNoteEvent({ ...event, sourceIds: ['official'] });
  const keep = status => createArbitrationDecision({ id: `keep-${status}`, eventIds: ['w', 'x'], action: MICRO_TIMING_KEEP_ACTION, status, reason: 'notated separation', evidence: ['official bar 1'], metadata: { intervalIdentity: gap, evidenceSourceIds: ['official'] } });
  for (const status of ['accepted', 'rejected']) {
    const candidate = project([w, x, y].map(onOfficial), { sources: [OFFICIAL], decisions: [keep(status)] });
    const analysis = analyzeReleaseTiming({ candidate });
    assert.equal(analysis.targets.find(item => item.eventId === 'x').status, TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED, `${status}: X's own release is still a target`);
    assert.equal(analysis.notVisibleToIntervalAnalyzerCount, 1);
    assert.ok(enforceMicroGaps(candidate).blockers.includes(MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE), `${status}: X is never silenced`);
    const wTarget = analysis.targets.find(item => item.eventId === 'w');
    assert.equal(wTarget.status, status === 'accepted' ? TARGET_STATUS.SOURCE_SUPPORTED_NOT_REPRESENTABLE : TARGET_STATUS.REPRESENTATION_DECISION_REQUIRED);
  }
});

test('RT-17 a release followed at once by an explicit rest is visible and never offered a move that keeps the rest off-grid', () => {
  const x = note({ id: 'x', start: 0, end: tickBefore(1) });
  const r = createCanonicalRestEvent({ id: 'r', start: tickBefore(1), end: 2, role: 'Melody', voice: 'Melody', sourceIds: ['third'] });
  const y = note({ id: 'y', start: 2, end: 3 });
  const candidate = project([x, r, y]);
  const target = analyzeReleaseTiming({ candidate }).targets.find(item => item.eventId === 'x');
  assert.equal(target.analysis.followingShape, 'explicit-rest-at-release');
  assert.equal(target.status, TARGET_STATUS.NO_VALID_REPRESENTATION);
  assert.ok(target.options.every(option => !option.valid));
  // Visible to G10, as the boundary nothing moves: no representation of this
  // release is valid, so the release code (whose answer is a representation)
  // is not raised for it, and the rest's start at the release blocks instead.
  const enforcement = enforceMicroGaps(candidate);
  assert.equal(enforcement.status, 'PENDING');
  assert.deepEqual(enforcement.blockers, [MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(enforcement.unsupportedBoundaries.map(item => [item.eventId, item.boundary, item.coverage]), [['r', 'start', 'none']]);
});

test('RT-18 a derived duplicate is traced to its origin, and its record re-verifies', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const dupe = createCanonicalNoteEvent({ ...a, id: 'a#dup', role: 'Chord1', metadata: { ticksPerQuarter: TPQ, g11d: { derivedFromEventId: 'a' } } });
  const baseline = project([a]);
  const analysis = analyzeReleaseTiming({ candidate: project([a, dupe]), baseline });
  const target = analysis.targets.find(item => item.eventId === 'a#dup');
  assert.equal(target.source.fromBaseline, true, 'origin found through the reversible chain');
  const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({ assets: ASSETS }), input: { decisions: [audioDecision(['a', 'a#dup'])] } });
  assert.equal(plan.changes.length, 2);
  const byId = new Map(plan.changes.map(change => [change.eventId, change]));
  const events = [a, dupe].map(event => createCanonicalNoteEvent({ ...event, end: byId.get(event.id).after.end, metadata: { ...event.metadata, [RELEASE_RECORD_KEY]: releaseRecordFor(byId.get(event.id)) } }));
  const represented = project(events, { metadata: { sourceFaithfulBaseline: { snapshot: baseline }, mobileAdaptation: { releaseRepresentation: { decisions: plan.decisions } } } });
  assert.deepEqual(verifyReleaseRepresentation(represented).violations, []);
  // A duplicate derived *after* the representation carries the origin's record;
  // the decision names the origin, and that is enough.
  const later = createCanonicalNoteEvent({ ...events[0], id: 'a#dup2', role: 'Chord2', metadata: { ...events[0].metadata, g11d: { derivedFromEventId: 'a' } } });
  const withLater = project([...events, later], { metadata: represented.metadata });
  assert.deepEqual(verifyReleaseRepresentation(withLater).violations, []);
});

test('RT-19 with the current evidence registry a record whose citation is no longer independent stops verifying', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: 2 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b]) });
  // Whoever submitted it, a stored citation is re-resolved against the sources
  // the project holds now.
  for (const attestation of [HUMAN, AGENT]) {
    const official = scoreDecision(['a'], { attestation });
    const plan = planReleaseRepresentation({ analysis, registry: buildEvidenceRegistry({ assets: ASSETS }), input: { decisions: [official] } });
    const candidate = represented([a, b], plan.changes, plan.decisions);
    assert.deepEqual(verifyReleaseRepresentation(candidate, { registry: buildEvidenceRegistry({ assets: ASSETS }) }).violations, []);
    // Later, a supporting upload turns out to be byte-identical to the "official" score.
    const later = buildEvidenceRegistry({ assets: [...ASSETS, { asset_id: 'ast_copy', kind: 'third_party_musicxml', sha256: 'd'.repeat(64) }] });
    assert.deepEqual(verifyReleaseRepresentation(candidate, { registry: later }).violations.map(item => item.code), [RECORD_VIOLATION.DECISION_NOT_ADMISSIBLE], attestation.reviewer_kind);
    assert.equal(enforceMicroGaps(candidate, { releaseEvidenceRegistry: later }).status, 'FAIL');
    // The cited asset is gone, or is now declared as something else.
    const gone = buildEvidenceRegistry({ assets: ASSETS.filter(asset => asset.asset_id !== 'ast_score') });
    const retyped = buildEvidenceRegistry({ assets: ASSETS.map(asset => (asset.asset_id === 'ast_score' ? { ...asset, kind: 'third_party_musicxml' } : asset)) });
    for (const registry of [gone, retyped]) assert.deepEqual(verifyReleaseRepresentation(candidate, { registry }).violations.map(item => item.code), [RECORD_VIOLATION.DECISION_NOT_ADMISSIBLE]);
  }
});

test('RT-19b a decision carries no field that can set a gate, and its submitter cannot widen what counts', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const analysis = analyzeReleaseTiming({ candidate: project([a, note({ id: 'b', start: 2, end: 3 })]) });
  const registry = buildEvidenceRegistry({ assets: ASSETS });
  for (const extra of [{ inGameAccepted: true }, { in_game: 'PASS' }, { admissible: true }, { status: 'PASS' }]) {
    assert.throws(() => planReleaseRepresentation({ analysis, registry, input: { decisions: [{ ...audioDecision(['a']), ...extra }] } }), /unsupported/, JSON.stringify(extra));
  }
  // An item that claims its own resolution is re-resolved against the registry.
  const claimed = { ...audioDecision(['a'], { ref: 'ast_third' }) };
  claimed.evidence = claimed.evidence.map(item => ({ ...item, resolved: { ref: 'ast_third', kind: 'original-audio', primary: true, independent: true } }));
  assert.equal(planReleaseRepresentation({ analysis, registry, input: { decisions: [claimed] } }).changes.length, 0);
});

test('RT-20 without a profile, role and drum-face questions are asked only of the notes a release change touches', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: 2 });
  // An unmapped drum hit, one tick short like the rest, on a role of its own.
  const kick = createCanonicalNoteEvent({ id: 'kick', pitch: 36, start: '0', end: tickBefore(1), role: 'Chord5', voice: 'drums', sourceIds: ['third'], sourceEventIds: ['third#kick'], metadata: { ticksPerQuarter: TPQ, channel: 9 } });
  const candidate = project([a, b, kick]);
  const evidenceSources = { assets: ASSETS, sources: [THIRD] };
  const lead = planMobileAdaptation({ baseline: candidate, candidate, evidenceSources, releaseRepresentation: { decisions: [audioDecision(['a'])] } });
  assert.equal(lead.status, 'PASS', JSON.stringify(lead.blockers));
  assert.deepEqual(lead.releaseRepresentation.changes.map(change => change.eventId), ['a']);
  const drum = planMobileAdaptation({ baseline: candidate, candidate, evidenceSources, releaseRepresentation: { decisions: [audioDecision(['kick'])] } });
  assert.equal(drum.status, 'PENDING');
  assert.deepEqual(drum.blockers.map(item => [item.code, item.eventId]), [['DRUM_FACE_MAPPING_REQUIRED', 'kick']]);
  // With a profile the profile-era questions are asked of every note, as before.
  const profiled = planMobileAdaptation({ baseline: candidate, candidate, evidenceSources, profile: { schema: 'mml-studio/mobile-adaptation-profile@1', id: 'fixture-profile', reason: 'fixture', evidence: ['fixture'], roles: { Melody: { volumeDelta: 0 } } } });
  assert.ok(profiled.blockers.some(item => item.code === 'DRUM_FACE_MAPPING_REQUIRED' && item.eventId === 'kick'));
});

test('RT-21 scope limit: a caution-representable release is no target and still fails closed at preferred-only emission', () => {
  // Two 480-tpq ticks before the beat is 1/960 of a whole note: reachable with
  // caution lengths, so not NOT_FINAL_REPRESENTABLE, and no route is offered.
  const twoTicks = f(1).sub(new F(2, TPQ)).toString();
  const candidate = project([note({ id: 'a', start: 0, end: twoTicks }), note({ id: 'b', start: 2, end: 3 })]);
  assert.equal(classifyPosition(twoTicks), POSITION_CLASS.CAUTION_REPRESENTABLE);
  const analysis = analyzeReleaseTiming({ candidate });
  assert.equal(analysis.targetCount, 0);
  assert.equal(enforceMicroGaps(candidate).status, 'PASS', 'not a micro-timing target');
  const emitted = emitFinalMml(candidate);
  assert.equal(emitted.status, 'FAIL', 'the preferred-only lattice cannot write it, and nothing is approximated');
  assert.ok(emitted.diagnostics.some(item => item.code === 'DURATION_SEARCH_POLICY_LIMIT'));
});

test('RT-9c evidence must resolve to bytes the project holds: a source an imported IR merely declares is never evidence', () => {
  const declared = [
    createSource({ id: 'claimed:recording', label: 'declared, no bytes', kind: 'original-audio', authority: 'primary-audio', sha256: null }),
    createSource({ id: 'claimed:score', label: 'declared, digest nothing uploaded matches', kind: 'official-musicxml', authority: 'primary-symbolic', sha256: 'f'.repeat(64) }),
    createSource({ id: 'held:recording', label: 'backed by the uploaded recording', kind: 'original-audio', authority: 'primary-audio', sha256: 'e'.repeat(64) }),
  ];
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD, ...declared] });
  assert.equal(registry.get('claimed:recording').bytesHeld, false);
  assert.equal(registry.get('claimed:recording').independent, false, 'unknown bytes cannot be shown independent');
  assert.equal(registry.get('claimed:score').bytesHeld, false);
  assert.equal(registry.get('held:recording').bytesHeld, true);
  for (const attestation of [HUMAN, AGENT]) {
    assert.deepEqual(gradeReleaseEvidence(audioDecision(['a'], { attestation, ref: 'claimed:recording' }), registry).items[0].reasons, [EVIDENCE_REFUSAL.REF_HOLDS_NO_BYTES]);
    assert.deepEqual(gradeReleaseEvidence(scoreDecision(['a'], { attestation, ref: 'claimed:score' }), registry).items[0].reasons, [EVIDENCE_REFUSAL.REF_HOLDS_NO_BYTES]);
    assert.equal(gradeReleaseEvidence(audioDecision(['a'], { attestation, ref: 'held:recording' }), registry).admissible, true);
  }
  // Only held bytes are offered as a way to settle an open release.
  const requirement = releaseEvidenceRequirement(buildEvidenceRegistry({ assets: [ASSETS[0]], sources: [THIRD, ...declared.slice(0, 2)] }));
  assert.deepEqual(requirement.anyOf.map(item => [item.code, [...item.availableRefs]]), [
    [RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_SOURCE_REQUIRED, []],
    [RELEASE_EVIDENCE_REQUIREMENT.SYMBOLIC_SOURCE_REQUIRED, []],
  ]);
});

test('RT-9d a stored resolution is re-checked, not believed: every fact it omits counts against it', () => {
  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const b = note({ id: 'b', start: 1, end: 2 });
  const analysis = analyzeReleaseTiming({ candidate: project([a, b]) });
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  const plan = planReleaseRepresentation({ analysis, registry, input: { decisions: [audioDecision(['a'])] } });
  const codes = (decisions, options) => verifyReleaseRepresentation(represented([a, b], plan.changes, decisions), options).violations.map(item => item.code);
  assert.deepEqual(codes(plan.decisions), []);
  // A third-party citation dressed with a resolution it never had.
  const dressed = plan.decisions.map(decision => ({ ...decision, evidence: decision.evidence.map(item => ({ ...item, ref: 'ast_third', resolved: { ref: 'ast_third', kind: 'original-audio' } })) }));
  assert.deepEqual(codes(dressed), [RECORD_VIOLATION.DECISION_NOT_ADMISSIBLE], 'without a registry, an omitted fact is not assumed');
  assert.deepEqual(codes(dressed, { registry }), [RECORD_VIOLATION.DECISION_NOT_ADMISSIBLE], 'with one, the ref is resolved again');
  // A claim with no source class behind it is refused, whatever is cited.
  assert.ok(gradeReleaseEvidence({ ...audioDecision(['a']), representation: 'QUANTIZE' }, registry).items[0].reasons.includes(EVIDENCE_REFUSAL.CLAIM_NOT_SUPPORTED));
});

test('RT-22 a profile-only plan keeps its identity, and technical repair grades with the same evidence registry', () => {
  // The plan body a profile-only plan hashes is the one it hashed before release
  // representation existed; the release summary is reported beside it.
  const candidate = sixRoleBaseline();
  const profile = { schema: 'mml-studio/mobile-adaptation-profile@1', id: 'fixture-profile', reason: 'fixture', evidence: ['fixture'], roles: { Melody: { volumeDelta: 0 } } };
  const plan = planMobileAdaptation({ baseline: candidate, candidate, profile });
  const keys = ['schema', 'baselineIdentity', 'inputDigest', 'profileDigest', 'profile', 'canonicalIdentity', 'leadBoundEventIds', 'rolePlans', 'changes', 'blockers', 'warnings', 'collisions', 'status'];
  assert.equal(plan.id, `mobile:plan:${contentDigest(Object.fromEntries(keys.map(key => [key, plan[key]])))}`);
  assert.ok(plan.releaseRepresentation, 'still reported');
  const withRelease = planMobileAdaptation({ baseline: candidate, candidate, profile, releaseRepresentation: { decisions: [] } });
  assert.notEqual(withRelease.id, plan.id, 'supplied release decisions are part of the plan');

  const a = note({ id: 'a', start: 0, end: tickBefore(1) });
  const oneTick = project([a, note({ id: 'b', start: 1, end: 2 })]);
  const registry = buildEvidenceRegistry({ assets: ASSETS, sources: [THIRD] });
  const enforcement = enforceMicroGaps(oneTick, { releaseEvidenceRegistry: registry });
  const repaired = repairTechnicalTiming(oneTick, { enforcement, releaseEvidenceRegistry: registry });
  assert.equal(repaired.diagnostics.some(item => item.code === REPAIR_DIAGNOSTICS.ENFORCEMENT_STALE), false);
  // The repair's own re-grade uses the registry the caller graded with, so a
  // recorded representation cannot pass there on its stored citation alone.
  assert.equal(repaired.verification.releaseRepresentationRecords.registryChecked, true);
  assert.equal(repaired.verification.releaseEvidenceRequirement.anyOf[0].code, RELEASE_EVIDENCE_REQUIREMENT.ORIGINAL_AUDIO_REVIEW_REQUIRED);
});

test('RT-9e relabelled output, audio declared as a score and colliding references are never primary evidence', () => {
  const recording = 'a'.repeat(64); const finalMml = 'b'.repeat(64);
  const registry = buildEvidenceRegistry({
    assets: [
      { asset_id: 'final', kind: 'final_mml', sha256: finalMml },
      { asset_id: 'final-as-audio', kind: 'original_audio', sha256: finalMml },
      { asset_id: 'rec', kind: 'original_audio', sha256: recording },
      { asset_id: 'shared-id', kind: 'original_audio', sha256: 'c'.repeat(64) },
    ],
    sources: [
      createSource({ id: 'audio-as-score', label: 'x', kind: 'official-midi', authority: 'primary-symbolic', sha256: recording }),
      createSource({ id: 'shared-id', label: 'x', kind: 'official-midi', authority: 'primary-symbolic', sha256: recording }),
      createSource({ id: 'rec-source', label: 'x', kind: 'original-audio', authority: 'primary-audio', sha256: recording }),
    ],
  });
  assert.equal(registry.get('final-as-audio').sourceClass, 'not-independent', 'Final MML bytes uploaded as audio');
  assert.equal(registry.get('audio-as-score').sourceClass, 'bytes-not-held', 'audio bytes are never a score');
  assert.equal(registry.get('shared-id').sourceClass, 'bytes-not-held', 'an id naming both an asset and a source is ambiguous');
  assert.equal(registry.get('rec').sourceClass, 'primary-audio');
  assert.equal(registry.get('rec-source').sourceClass, 'primary-audio');
  for (const ref of ['final-as-audio', 'shared-id']) assert.equal(gradeReleaseEvidence(audioDecision(['a'], { ref }), registry).admissible, false, ref);
});
