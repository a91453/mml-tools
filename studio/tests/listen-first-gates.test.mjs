// The two codes a gate adds when the whole of its open question needs a
// person's judgment (ACCEPTANCE_CRITERIA "Delivered first, flagged for
// listening", 2026-09-23-v3):
//
//   MICRO_TIMING_RELEASE_PROVISIONAL         every open micro-timing item is a
//                                            release at its source's dominant
//                                            export offset that can be held to
//                                            the following attack / next grid
//   LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING  every pending promotion lacks only
//                                            primary evidence
//
// Each is added beside the gate's usual codes and never replaces them, and each
// is a statement about the project, not a verdict: the gates stay PENDING. Which
// phase that lands in is the machine-delivery schema's decision
// (machine-delivery-schemas.test.mjs); here the identities are passed
// explicitly, so nothing depends on the loaded release.
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
import { INTERVAL_TYPES, MICRO_TIMING_KEEP_ACTION, createIntervalIdentity } from '../backend/canonical/micro-timing.mjs';
import { MICRO_GAP_BLOCKERS, PROVISIONAL_RELEASE_POLICY, enforceMicroGaps } from '../backend/final/micro-gap-enforcement.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';
import { PRIMARY_EVIDENCE_CONTRADICTS_LEAD, evaluateLeadPromotion } from '../backend/arbitration/lead-demotion.mjs';
import { LISTEN_FIRST_CODES, MACHINE_DELIVERY_SCHEMA_V1, MACHINE_DELIVERY_SCHEMA_V2 } from '../backend/final/delivery-evaluator.mjs';
import { createStudioApplication } from '../backend/application/index.mjs';
import { OWNER, SOURCE_ID, assign, oneTickEarlyBaseline } from './fixtures/release-fixtures.mjs';

const TICK = new F(1, 480);
const early = (beat, ticks = 1) => f(beat).sub(TICK.mul(ticks)).toString();
const MIDI = createSource({ id: 'midi', label: 'Synthetic third-party MIDI', kind: 'third-party-midi', authority: 'supporting' });
const OTHER = createSource({ id: 'other-midi', label: 'Second synthetic MIDI', kind: 'third-party-midi', authority: 'supporting' });
const OFFICIAL = createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' });

let counter = 0;
const note = ({ id = `n${++counter}`, pitch = 60, start, end, role = 'Melody', sourceId = 'midi' }) => createCanonicalNoteEvent({
  id, pitch, start: String(start), end: String(end), role, sourceIds: [sourceId], sourceEventIds: [`${sourceId}#${id}`], metadata: { ticksPerQuarter: 480 },
});
const project = (events, { sources = [MIDI, OTHER, OFFICIAL], decisions = [] } = {}) => createCanonicalProject({
  id: `listen-first:${++counter}`,
  title: 'listen-first fixture',
  sources,
  events,
  decisions,
  tempoEvents: [createCanonicalTempoEvent({ id: 'tempo', beat: '0', bpm: 120, sourceIds: ['midi'] })],
});
// `count` one-beat notes in `role`, back to back, each released `offsets[i]`
// ticks before the next beat (default one tick): the export shape, and the
// sub-grid gap to the next attack it leaves behind.
const lane = ({ count = 20, role = 'Melody', sourceId = 'midi', offsets = [], from = 0, prefix = role }) => Array.from({ length: count }, (_, index) => note({
  id: `${prefix}-${index}`, pitch: 60 + (index % 5), role, sourceId, start: from + index, end: early(from + index + 1, offsets[index] ?? 1),
}));
const PROVISIONAL = MICRO_GAP_BLOCKERS.RELEASE_PROVISIONAL;

test('a uniform one-tick source: every release is held provisionally and the gate says so', () => {
  const report = enforceMicroGaps(project(lane({})));
  assert.equal(report.status, 'PENDING', 'still unresolved');
  assert.deepEqual(report.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE, PROVISIONAL]);
  assert.equal(report.unknownCount, 19, 'the gaps stay UNKNOWN');
  assert.equal(report.provisionalReleases.length, 20);
  assert.ok(report.provisionalReleases.every(item => item.classification === 'UNKNOWN' && item.representation === 'EXTEND_TO_NEXT_GRID' && item.offsetBeforeNextGrid === '1 tick(s)'));
  // Each gap is closed by holding the release before it; the last release ends the role.
  assert.deepEqual(new Set(report.provisionalReleaseIntervalKeys), new Set(report.blockedIntervalKeys));
  const last = report.provisionalReleases.find(item => item.eventId === 'Melody-19');
  assert.deepEqual([last.release, last.heldTo, last.effect, last.intervalKeys.length], [early(20), '20', 'role-end-moves-later', 0]);
  assert.deepEqual(report.releaseOffsetSources, [{
    sourceId: 'midi', dominantOffset: '1 tick(s)', dominantOffsetBeats: '1/480', dominantCount: 20, releaseCount: 20,
    share: '20/20', sharePercent: '100.0', minimumShare: '95/100', qualifies: true, provisionallyRendered: 20, unresolved: 0,
  }]);
  assert.deepEqual(PROVISIONAL_RELEASE_POLICY.dominantOffsetMinShare, { numerator: 95, denominator: 100 });
});

// The share is over the releases Final cannot express (the release analysis's
// targets, as `encodingObservations` counts them). At 480 tpq one and three
// ticks early are such releases; two ticks early is 1/960 of a whole note, which
// a caution length can reach, so it is not one (canonical/release-timing.mjs).
test('scattered offsets below 95% keep the ordinary codes', () => {
  // 18 of 20 releases one tick early, 2 three ticks early: 90%.
  const report = enforceMicroGaps(project(lane({ offsets: { 3: 3, 11: 3 } })));
  assert.deepEqual(report.blockers, [MICRO_GAP_BLOCKERS.CLASSIFICATION_UNKNOWN, MICRO_GAP_BLOCKERS.RELEASE_NOT_FINAL_REPRESENTABLE]);
  assert.deepEqual(report.provisionalReleases, []);
  assert.deepEqual(report.releaseOffsetSources.map(item => [item.dominantOffset, item.share, item.qualifies, item.provisionallyRendered, item.unresolved]), [['1 tick(s)', '18/20', false, 0, 20]]);
});

test('a qualifying source with an outlier: the outlier keeps the gate on its ordinary codes', () => {
  // 19 of 20 at one tick is exactly 95%: the source qualifies, and the release
  // three ticks early is still not at its dominant offset.
  const report = enforceMicroGaps(project(lane({ offsets: { 7: 3 } })));
  assert.deepEqual(report.releaseOffsetSources.map(item => [item.share, item.qualifies, item.provisionallyRendered, item.unresolved]), [['19/20', true, 0, 20]]);
  assert.equal(report.blockers.includes(PROVISIONAL), false);
  assert.deepEqual(report.provisionalReleases, []);
  // A release two ticks early is outside the share (Final can reach it with a
  // caution length) but its two-tick gap is still UNKNOWN and closed by nothing
  // listed, so it keeps the ordinary codes too.
  const representable = enforceMicroGaps(project(lane({ offsets: { 7: 2 } })));
  assert.deepEqual(representable.releaseOffsetSources.map(item => [item.share, item.qualifies]), [['19/19', true]]);
  assert.equal(representable.blockers.includes(PROVISIONAL), false);
  assert.deepEqual(representable.provisionalReleases, []);
  // A tie has no dominant offset at all.
  const tied = enforceMicroGaps(project(lane({ count: 2, offsets: { 0: 1, 1: 3 } })));
  assert.equal(tied.releaseOffsetSources[0].dominantOffset, null);
  assert.equal(tied.releaseOffsetSources[0].qualifies, false);
  assert.equal(tied.blockers.includes(PROVISIONAL), false);
});

test('every source must qualify; a source with no sub-grid release is unaffected', () => {
  const scatteredChords = lane({ count: 4, role: 'Chord1', sourceId: 'other-midi', offsets: { 0: 1, 1: 3, 2: 5, 3: 7 } });
  assert.equal(enforceMicroGaps(project([...lane({}), ...scatteredChords])).blockers.includes(PROVISIONAL), false);
  // Official on-grid material beside the export: nothing of it is a sub-grid release.
  const onGrid = [0, 1, 2, 3].map(beat => note({ id: `bass-${beat}`, role: 'Chord2', sourceId: 'official', start: beat, end: beat + 1, pitch: 40 }));
  const report = enforceMicroGaps(project([...lane({}), ...onGrid]));
  assert.ok(report.blockers.includes(PROVISIONAL));
  assert.deepEqual(report.releaseOffsetSources.map(item => item.sourceId), ['midi']);
});

test('a sub-grid note whose release the hold resolves is release-side; attack timing, rests and claims are not', () => {
  // A note one tick short of a 1/64 grid length, released before the next attack.
  const short = [
    note({ id: 'a', start: 0, end: early(1) }),
    note({ id: 'b', start: 1, end: early('17/16') }),
    note({ id: 'c', start: '17/16', end: early(2) }),
  ];
  const resolved = enforceMicroGaps(project(short));
  assert.ok(resolved.blockers.includes(PROVISIONAL), resolved.blockers.join(', '));
  assert.equal(resolved.provisionalReleases.find(item => item.eventId === 'b').intervalKeys.length, 2, 'its own duration and the gap after it');

  // Attack timing: a release on the grid and the next attack one tick late.
  const late = enforceMicroGaps(project([...lane({ count: 3 }), note({ id: 'on-grid', start: 3, end: 4 }), note({ id: 'late', start: f(4).add(TICK).toString(), end: early(5) })]));
  assert.equal(late.blockers.includes(PROVISIONAL), false);
  assert.ok(late.unsupportedBoundaries.length > 0);

  // An explicit one-tick rest where the gap was: the hold would enter it.
  const withRest = project([
    note({ id: 'x', start: 0, end: early(1) }),
    createCanonicalRestEvent({ id: 'r', start: early(1), end: '1', role: 'Melody', sourceIds: ['midi'] }),
    note({ id: 'y', start: 1, end: early(2) }),
  ]);
  assert.equal(enforceMicroGaps(withRest).blockers.includes(PROVISIONAL), false);

  // An open source-supported claim on one gap: nothing is held.
  const events = lane({ count: 3 });
  const identity = createIntervalIdentity({ type: INTERVAL_TYPES.INTER_EVENT_GAP, previousEventId: events[0].id, nextEventId: events[1].id, start: events[0].end, end: events[1].start });
  const claimed = project(events, { decisions: [createArbitrationDecision({
    id: 'keep', eventIds: [events[0].id, events[1].id], action: MICRO_TIMING_KEEP_ACTION, status: 'pending', reason: 'claimed breath', evidence: ['official'],
    metadata: { intervalIdentity: identity },
  })] });
  assert.equal(enforceMicroGaps(claimed).blockers.includes(PROVISIONAL), false);
});

// ── Lead promotion ─────────────────────────────────────────────────────────

// With its Tempo at beat 0: machine delivery also needs the Final emitter to
// write the candidate, and a project with no Tempo is one it refuses
// (TEMPO_INITIAL_MISSING, recorded as FINAL_EMISSION_REFUSED).
const promotion = () => {
  const before = createCanonicalNoteEvent({ id: 'p1', pitch: 67, start: '0', end: '1', sourceIds: ['official'], sourceEventIds: ['official#p1'], role: 'Chord1' });
  const tempoEvents = [createCanonicalTempoEvent({ id: 't0', beat: '0', bpm: 120, sourceIds: ['official'] })];
  const baseline = createCanonicalProject({ id: 'baseline:p', title: 'b', sources: [OFFICIAL], events: [before], tempoEvents, metadata: { sourceComplete: true } });
  return createCanonicalProject({
    id: 'candidate:p', title: 'c', sources: [OFFICIAL], events: [{ ...before, role: 'Melody' }], tempoEvents,
    metadata: { sourceComplete: true, sourceFaithfulBaseline: { snapshot: baseline } },
  });
};
const readiness = (reports, canonical = null) => evaluateProjectReadiness({
  project: promotion(),
  mmlValidation: { ok: true, errors: [] },
  core3Report: { status: 'PASS', blockers: [] },
  core3CompletenessReport: { status: 'PASS', blockers: [] },
  harmonyReport: { status: 'PASS', unresolvedCount: 0 },
  leadPromotionReports: reports,
  originalAudioRequired: false,
  playerReadback: 'N/A',
  mobileAdaptation: 'PASS',
  regressionReviewed: true,
  ...(canonical ? { canonical } : {}),
});
const report = (blockers, evidence = undefined) => ({ eventId: 'p1', status: 'PENDING', blockers, ...(evidence ? { evidence } : {}) });
const LEAD_CODE = LISTEN_FIRST_CODES.LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING;
const AT1 = { canonical_version: '2026-09-23-v2', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'e'.repeat(40), machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V1 };
const AT2 = { canonical_version: '2026-09-23-v3', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'e'.repeat(40), machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V2 };

test('a promotion the grader found without primary evidence adds the code; delivered for listening only under @2', () => {
  const missing = {
    'no evidence record at all': report(['LEAD_EVIDENCE_MISSING', 'LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH']),
    'nothing of the review supplied': report(['SOURCE_IDENTITY_MISSING', 'SECTION_ROLE_UNRESOLVED', 'LEAD_CONTINUITY_NOT_CHECKED', 'CORE3_NOT_CHECKED', 'POSITIVE_LEAD_EVIDENCE_MISSING']),
    'supporting-only evidence': report(['POSITIVE_LEAD_EVIDENCE_MISSING'], { score: { availability: 'available', classification: 'lead', sourceAuthority: 'supporting' } }),
    'no leadEvidence on the decision': report(['LEAD_PROMOTION_EVIDENCE_MISSING']),
  };
  for (const [label, value] of Object.entries(missing)) {
    const result = readiness([value], AT2);
    assert.equal(result.gates.leadPromotion.status, 'PENDING', label);
    assert.deepEqual(result.gates.leadPromotion.blockers, ['LEAD_PROMOTION_EVIDENCE_REQUIRED', LEAD_CODE], label);
    assert.deepEqual(result.gates.leadPromotion.unverifiedLeadEventIds, ['p1'], label);
    assert.ok(result.machineDelivery.non_blocking_pending.some(entry => entry.gate === 'leadPromotion' && entry.delivery_flag === 'LEAD_UNVERIFIED'), label);
    assert.equal(result.songState, 'CANDIDATE', `${label}: never VALIDATED`);
    const underAt1 = readiness([value], AT1);
    assert.ok(underAt1.machineDelivery.blocking.some(entry => entry.gate === 'leadPromotion'), `${label} blocks under @1`);
  }
});

test('anything beyond missing primary evidence keeps the Lead promotion gate on its ordinary code', () => {
  const blocking = {
    'no report: the grader never ran': null,
    'invalid evidence': report(['LEAD_PROMOTION_EVIDENCE_INVALID: sectionRole is invalid']),
    'an origin outside the baseline': report(['LEAD_PROMOTION_ORIGIN_NOT_IN_BASELINE']),
    'a citation that resolves to nothing': report(['POSITIVE_LEAD_EVIDENCE_MISSING'], { score: { availability: 'available', classification: 'lead', sourceAuthority: 'unresolved' } }),
    'contradicting evidence': report(['POSITIVE_LEAD_EVIDENCE_MISSING', 'SOURCE_ROLE_EVIDENCE_CONFLICT']),
    'a Lead gap the review found': report(['POSITIVE_LEAD_EVIDENCE_MISSING', 'LEAD_GAP_CREATED']),
    'a Core3 failure': report(['POSITIVE_LEAD_EVIDENCE_MISSING', 'CORE3_FAILED']),
    'evidence about another event': report(['LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH']),
    'evidence for an earlier candidate': report(['LEAD_EVIDENCE_CONTEXT_CHANGED']),
    'primary evidence present, continuity unchecked': report(['LEAD_CONTINUITY_NOT_CHECKED']),
    'no record plus anything else': report(['LEAD_EVIDENCE_MISSING', 'LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH', 'LEAD_EVIDENCE_PROVENANCE_PAIR_AMBIGUOUS']),
    'a FAIL': { eventId: 'p1', status: 'FAIL', blockers: ['POSITIVE_LEAD_EVIDENCE_MISSING'] },
    'primary evidence that contradicts the Lead': report(['POSITIVE_LEAD_EVIDENCE_MISSING', PRIMARY_EVIDENCE_CONTRADICTS_LEAD]),
    // A report graded before the grader raised the contradiction code: the
    // report's own evidence still says the event is not the Lead.
    'a stored report whose primary score says accompaniment': report(['POSITIVE_LEAD_EVIDENCE_MISSING'], { score: { availability: 'available', classification: 'accompaniment', citation: 's', sourceAuthority: 'primary' } }),
    'a stored report whose listening hears background': report(['POSITIVE_LEAD_EVIDENCE_MISSING'], { audio: { availability: 'available', classification: 'background', citation: 'a', basis: 'listening' } }),
  };
  for (const [label, value] of Object.entries(blocking)) {
    const result = readiness(value ? [value] : [], AT2);
    assert.deepEqual(result.gates.leadPromotion.blockers, ['LEAD_PROMOTION_EVIDENCE_REQUIRED'], label);
    assert.ok(result.machineDelivery.blocking.some(entry => entry.gate === 'leadPromotion'), label);
  }
});

// ACCEPTANCE_CRITERIA "Delivered first", rule 2 keeps contradicting evidence
// BLOCKING. Before the grader raised PRIMARY_EVIDENCE_CONTRADICTS_LEAD, an
// official score calling the event accompaniment, or listening to the original
// recording hearing it in the background, left the same single blocker as no
// evidence at all, and the promotion was delivered as "Lead unverified".
test('the real Lead grader: primary evidence that the event is not the Lead keeps the promotion BLOCKING; no evidence stays listen-first', () => {
  const origin = createCanonicalNoteEvent({ id: 'p1', pitch: 67, start: '0', end: '1', sourceIds: ['official'], sourceEventIds: ['official#p1'], role: 'Chord1' });
  const reviewed = {
    event: origin,
    sourceIdentity: { sourceId: 'official', sourceEventId: 'official#p1' },
    sectionRole: 'vocal-active',
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
    core3: { checked: true, status: 'PASS' },
    positiveReason: 'fills the melody',
  };
  const graded = extra => evaluateLeadPromotion({ ...reviewed, ...extra });

  const none = graded({});
  assert.deepEqual([...none.blockers], ['POSITIVE_LEAD_EVIDENCE_MISSING']);
  const listenFirst = readiness([none], AT2);
  assert.deepEqual(listenFirst.gates.leadPromotion.blockers, ['LEAD_PROMOTION_EVIDENCE_REQUIRED', LEAD_CODE]);
  assert.ok(listenFirst.machineDelivery.non_blocking_pending.some(entry => entry.gate === 'leadPromotion' && entry.delivery_flag === 'LEAD_UNVERIFIED'));
  assert.deepEqual(listenFirst.machineDelivery.blocking, []);
  assert.equal(listenFirst.machineDelivery.lifecycle, 'AUTOMATED_VALIDATED', 'no evidence: delivered, flagged Lead unverified');

  const contradicting = {
    'the official score classifies it as accompaniment': { scoreEvidence: { availability: 'available', classification: 'accompaniment', citation: 'official score m.2: accompaniment staff', sourceAuthority: 'primary' } },
    'listening to the original recording hears it in the background': { audioEvidence: { availability: 'available', classification: 'background', citation: 'recording 0:12', basis: 'listening', sourceAuthority: 'primary' } },
  };
  for (const [label, extra] of Object.entries(contradicting)) {
    const report = graded(extra);
    assert.equal(report.status, 'PENDING', label);
    assert.ok(report.blockers.includes(PRIMARY_EVIDENCE_CONTRADICTS_LEAD), label);
    const result = readiness([report], AT2);
    assert.equal(result.gates.leadPromotion.status, 'PENDING', label);
    assert.deepEqual(result.gates.leadPromotion.blockers, ['LEAD_PROMOTION_EVIDENCE_REQUIRED'], label);
    assert.equal('unverifiedLeadEventIds' in result.gates.leadPromotion, false, label);
    assert.deepEqual(result.machineDelivery.blocking.map(entry => entry.gate), ['leadPromotion'], `${label}: BLOCKING`);
    assert.equal(result.machineDelivery.non_blocking_pending.some(entry => entry.gate === 'leadPromotion'), false, label);
    assert.equal(result.machineDelivery.lifecycle, 'CANDIDATE', `${label}: never machine-delivered`);
  }
});

test('the real lineage grader: role-less material assigned to Melody with no evidence reads as primary evidence missing', async () => {
  const service = createStudioApplication({});
  const baseline = oneTickEarlyBaseline();
  const created = (await service.createProject(OWNER, { title: 'Lead unverified' })).project;
  await service.uploadAsset(OWNER, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(baseline)) });
  await service.analyzeSources(OWNER, created.project_id);
  // Initial role-less assignment into Melody with no Lead evidence: a
  // reversible review candidate, not Lead evidence (decision-application.mjs).
  const decisions = [
    ...['lead-1', 'lead-2', 'lead-3', 'lead-4'].map(id => assign(id, 'Melody', { leadEvidence: null })),
    ...['harm-1', 'harm-2'].map(id => assign(id, 'Chord1')),
    ...['bass-1', 'bass-2'].map(id => assign(id, 'Chord2')),
  ];
  const applied = await service.applyDecisions(OWNER, created.project_id, { decisions });
  assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected ?? applied.decisions));
  const { review } = await service.reviewCandidate(OWNER, created.project_id, { candidateId: applied.decisions.candidate_id });
  const gate = review.readiness.gates.leadPromotion;
  assert.equal(gate.status, 'PENDING');
  assert.deepEqual(gate.blockers, ['LEAD_PROMOTION_EVIDENCE_REQUIRED', LEAD_CODE]);
  assert.deepEqual([...gate.unverifiedLeadEventIds].sort(), ['lead-1', 'lead-2', 'lead-3', 'lead-4']);
  assert.equal(SOURCE_ID, 'fixture:third-party-midi');
});
