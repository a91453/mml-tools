// Studio Application Service — a decision's own Lead citation is graded on
// the source it cites, like every other Lead citation.
//
// The shared Lead grader reads two things a caller must not be able to leave
// out: which project source a classified score/audio item cites (resolved into
// `sourceAuthority`) and how an audio classification was established (`basis`).
// It reads their ABSENCE as the historical "may prove a role". Fresh
// `reviewLeadEvidence` records were prepared for the grader (resolved against
// the project's evidence registry, audio basis from the stated method), but the
// citation an accepted `MOVE_ROLE` decision carries in `leadEvidence` reached
// the lineage report builders exactly as stored. So, through `reviewCandidate`
// and `finalize` alike:
//
//   a score citation naming nothing the project holds     positive evidence
//   a score citation naming a third-party MIDI (§1C)       positive evidence
//   an audio "F0 salience metric" with no stated method   positive evidence
//   => Lead promotion PASS, readiness gate PASS
//
// SOURCE_POLICY §1C (third-party material is supporting only) and §6 (audio
// metrics are locators, never role evidence) forbid every line of that. The
// decision-time interlock is unchanged -- the decision still applies -- but the
// Gate 3 verdict is now graded on the resolved citation: only an official score
// the project holds proves a role on this path, and a decision states no audio
// method, so its audio classification is graded as a machine metric. The
// stored application is never rewritten; the preparation happens at read time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication } from '../backend/application/index.mjs';
import { createStore } from '../backend/application/store.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const SOURCE_ID = 'fixture:official-midi';

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'mml-lead-decision-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function project(title, directory = null) {
  const service = createStudioApplication(directory ? { dataDirectory: directory, durability: 'persistent' } : {});
  const created = (await service.createProject(OWNER, { title })).project;
  const projectId = created.project_id;
  await service.uploadAsset(OWNER, projectId, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()),
  });
  await service.analyzeSources(OWNER, projectId);
  // Held after intake, so they stay evidence and are not parsed into the baseline.
  const upload = async (kind, filename, mediaType, text) => (await service.uploadAsset(OWNER, projectId, {
    kind, filename, mediaType, bytes: new TextEncoder().encode(`${text} for ${title}`),
  })).asset.asset_id;
  const refs = {
    officialScore: await upload('official_musicxml', 'score.musicxml', 'application/xml', 'fixture official score'),
    recording: await upload('original_audio', 'song.m4a', 'audio/mp4', 'fixture recording'),
    thirdParty: await upload('third_party_midi', 'cover.mid', 'application/octet-stream', 'fixture youtube cover'),
  };
  return { service, projectId, refs };
}

// A Lead citation in the shape a decision carries it. `scoreRef`/`audioRef`
// are omitted from the item when null, exactly as a free-text citation is.
const citation = (eventId, { scoreClass, audioClass, scoreRef = null, audioRef = null, score = {}, audio = {} }) => ({
  sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#${eventId}` },
  sectionRole: 'instrumental',
  scoreEvidence: { availability: 'available', classification: scoreClass, citation: 'the top line of a score', ...(scoreRef ? { ref: scoreRef } : {}), ...score },
  audioEvidence: { availability: 'available', classification: audioClass, citation: 'F0 salience metric', ...(audioRef ? { ref: audioRef } : {}), ...audio },
  continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
  core3: { checked: true, status: 'PASS' },
  positiveReason: 'The cited score and recording carry this line.',
});

const promote = (eventId, refs) => ({
  id: `promote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Chord3', toRole: 'Melody',
  reason: 'Accepted: the cited material carries the foreground lead here.',
  evidence: ['cited score', 'cited audio'],
  leadEvidence: citation(eventId, { scoreClass: 'lead', audioClass: 'foreground', ...refs }),
  acceptedBy: 'reviewer:test',
});

const demote = (eventId, refs) => ({
  id: `demote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Melody', toRole: 'Chord3',
  reason: 'Accepted: the cited material places this attack in an inner voice.',
  evidence: ['cited score', 'cited audio'],
  leadEvidence: citation(eventId, { scoreClass: 'inner', audioClass: 'background', ...refs }),
  acceptedBy: 'reviewer:test',
});

const reportFor = (reports, eventId) => reports.find(report => report.eventId === eventId);

async function applied(service, projectId, decision) {
  const result = await service.applyDecisions(OWNER, projectId, { decisions: [decision] });
  // The decision-time interlock is not what changed: the move still applies.
  assert.equal(result.decisions.applied, true, JSON.stringify(result.decisions.rejected ?? null));
  return result.decisions.candidate_id;
}

// ─── 1. the audit's reproduction, through review and finalize ───────────────

test('a decision citing no project source, or a third-party one, with an audio metric does not pass Lead promotion through review or finalize', async () => {
  for (const [label, scoreRef, authority] of [['uncited', null, 'unresolved'], ['third-party', 'thirdParty', 'supporting']]) await withDirectory(async directory => {
    const { service, projectId, refs } = await project(`decision citation ${label}`, directory);
    const candidateId = await applied(service, projectId, promote('chord3-1', { scoreRef: scoreRef ? refs[scoreRef] : null }));
    const stored = () => createStore({ directory }).getJson(`application:${projectId}:${candidateId}`);
    const storedBefore = stored();
    assert.ok(storedBefore?.applied?.[0]?.leadEvidence, label);

    const { review } = await service.reviewCandidate(OWNER, projectId, { candidateId });
    const report = reportFor(review.lead_promotion, 'chord3-1');
    assert.equal(report.evidenceSource, 'revision', `${label}: graded from the decision's own citation`);
    assert.equal(report.status, 'PENDING', `${label}: ${JSON.stringify(report.blockers)}`);
    assert.ok(report.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'), `${label}: ${report.blockers.join(', ')}`);
    // The citation was resolved against the project, and the audio "metric"
    // was graded as one: the report says why neither proves a role.
    assert.equal(report.evidence.score.sourceAuthority, authority, label);
    assert.equal(report.evidence.audio.sourceAuthority, 'unresolved', `${label}: an audio citation naming no project source proves nothing`);
    assert.equal(report.evidence.audio.basis, 'machine-metric', label);
    assert.ok(report.warnings.includes('AUDIO_METRIC_IS_A_LOCATOR_NOT_ROLE_EVIDENCE'), label);
    assert.ok(report.warnings.includes('LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE'), label);
    assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING', label);
    assert.ok(review.blockers.includes('leadPromotion'), label);

    const finalized = await service.finalize(OWNER, projectId, { candidateId });
    assert.equal(finalized.readiness.gates.leadPromotion.status, 'PENDING', `${label}: finalize grades what review grades`);
    assert.notEqual(finalized.operation, 'succeeded', `${label}: an unresolved citation is invalid evidence, not missing evidence`);
    assert.ok(finalized.blockers.includes('leadPromotion'), `${label}: ${finalized.blockers.join(', ')}`);

    // Graded at read time: the stored application is not rewritten.
    assert.deepEqual(stored(), storedBefore, label);
  });
});

test('a decision whose only primary citation is an audio metric is Lead unverified, never PASS', async () => {
  // Third-party score (supporting only) and the project's own recording, cited
  // by reference -- but a decision states no audio method, so the recording's
  // classification is a metric. No primary evidence proves the role: the one
  // open question is missing primary evidence, which the Canonical ledger
  // delivers first and flags "Lead unverified" rather than passing.
  const { service, projectId, refs } = await project('decision citation metric only');
  const candidateId = await applied(service, projectId, promote('chord3-1', { scoreRef: refs.thirdParty, audioRef: refs.recording }));

  const { review } = await service.reviewCandidate(OWNER, projectId, { candidateId });
  const report = reportFor(review.lead_promotion, 'chord3-1');
  assert.equal(report.status, 'PENDING');
  assert.deepEqual([...report.blockers], ['POSITIVE_LEAD_EVIDENCE_MISSING']);
  assert.equal(report.evidence.score.sourceAuthority, 'supporting');
  assert.equal(report.evidence.audio.sourceAuthority, 'primary');
  assert.equal(report.evidence.audio.basis, 'machine-metric');
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
  assert.ok(review.readiness.gates.leadPromotion.blockers.includes('LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING'));

  const finalized = await service.finalize(OWNER, projectId, { candidateId });
  assert.equal(finalized.readiness.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual([...finalized.readiness.gates.leadPromotion.unverifiedLeadEventIds], ['chord3-1']);
});

test('a decision cannot certify its own citation by declaring sourceAuthority or an audio basis', async () => {
  // The grader's two inputs are the preparation's to set, never the caller's.
  const { service, projectId } = await project('decision citation self-certified');
  const decision = promote('chord3-1', {
    score: { sourceAuthority: 'primary' },
    audio: { sourceAuthority: 'primary', basis: 'listening' },
  });
  const candidateId = await applied(service, projectId, decision);

  const { review } = await service.reviewCandidate(OWNER, projectId, { candidateId });
  const report = reportFor(review.lead_promotion, 'chord3-1');
  assert.equal(report.status, 'PENDING');
  assert.equal(report.evidence.score.sourceAuthority, 'unresolved', 'a declared authority is replaced by the resolved one');
  assert.equal(report.evidence.audio.basis, 'machine-metric', 'a decision states no method, whatever its evidence says');
  assert.equal(review.readiness.gates.leadPromotion.status, 'PENDING');
});

// ─── 2. the demotion axis ───────────────────────────────────────────────────

test('a decision citing a third-party score and an audio metric does not pass Lead demotion through review or finalize', async () => {
  const { service, projectId, refs } = await project('decision demotion citation');
  const candidateId = await applied(service, projectId, demote('melody-1', { scoreRef: refs.thirdParty }));

  const { review } = await service.reviewCandidate(OWNER, projectId, { candidateId });
  const report = reportFor(review.lead_demotion, 'melody-1');
  assert.equal(report.evidenceSource, 'revision');
  assert.equal(report.status, 'PENDING');
  assert.ok(report.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'), report.blockers.join(', '));
  assert.equal(report.evidence.score.sourceAuthority, 'supporting');
  assert.equal(report.evidence.audio.basis, 'machine-metric');
  assert.equal(review.readiness.gates.leadDemotion.status, 'PENDING');

  const finalized = await service.finalize(OWNER, projectId, { candidateId });
  assert.equal(finalized.readiness.gates.leadDemotion.status, 'PENDING');
  assert.ok(finalized.blockers.includes('leadDemotion'), finalized.blockers.join(', '));
});

// ─── 3. a sound decision-time citation still passes ─────────────────────────

test('a decision citing an official score the project holds still passes both Lead axes, graded on the resolved source', async () => {
  const { service, projectId, refs } = await project('decision citation primary');
  // The recording is cited too; a decision states no audio method, so it is a
  // locator here and the official score is what proves the role.
  const primary = { scoreRef: refs.officialScore, audioRef: refs.recording };

  const promoted = await applied(service, projectId, promote('chord3-1', primary));
  const promotion = (await service.reviewCandidate(OWNER, projectId, { candidateId: promoted })).review;
  const promotionReport = reportFor(promotion.lead_promotion, 'chord3-1');
  assert.equal(promotionReport.status, 'PASS', JSON.stringify(promotionReport.blockers));
  assert.equal(promotionReport.evidence.score.sourceAuthority, 'primary');
  assert.equal(promotionReport.evidence.audio.basis, 'machine-metric');
  assert.equal(promotion.readiness.gates.leadPromotion.status, 'PASS');
  const promotionFinal = await service.finalize(OWNER, projectId, { candidateId: promoted });
  assert.equal(promotionFinal.readiness.gates.leadPromotion.status, 'PASS');

  const demoted = await applied(service, projectId, demote('melody-1', primary));
  const demotion = (await service.reviewCandidate(OWNER, projectId, { candidateId: demoted })).review;
  const demotionReport = reportFor(demotion.lead_demotion, 'melody-1');
  assert.equal(demotionReport.status, 'PASS', JSON.stringify(demotionReport.blockers));
  assert.equal(demotionReport.evidence.score.sourceAuthority, 'primary');
  assert.equal(demotionReport.evidence.audio.basis, 'machine-metric');
  assert.equal(demotion.readiness.gates.leadDemotion.status, 'PASS');
  const demotionFinal = await service.finalize(OWNER, projectId, { candidateId: demoted });
  assert.equal(demotionFinal.readiness.gates.leadDemotion.status, 'PASS');
});

// ─── 4. reviewLeadEvidence sees the same grade ──────────────────────────────

test('reviewLeadEvidence answers a decision-time citation the grader no longer passes, without a supersede reason', async () => {
  // Before, the re-review path graded the lineage as stored too, so it called
  // the unsound citation "already answered" and refused a primary one.
  const { service, projectId, refs } = await project('decision citation re-review');
  const candidateId = await applied(service, projectId, promote('chord3-1', { scoreRef: refs.thirdParty }));

  const recorded = await service.reviewLeadEvidence(OWNER, projectId, {
    candidateId,
    review: {
      attestation: { reviewer: 'reviewer:fixture', reviewer_kind: 'human', audio_basis: 'listening' },
      event_id: 'chord3-1', axis: 'promotion',
      reason: 'Re-reviewed against the official score and the recording.',
      evidence: ['official score bar 1', 'recording 0:00'],
      lead_evidence: citation('chord3-1', { scoreClass: 'lead', audioClass: 'foreground', scoreRef: refs.officialScore, audioRef: refs.recording }),
    },
  });
  assert.equal(recorded.report.status, 'PASS');
  assert.equal(recorded.report.evidenceSource, 'candidate-review');

  const { review } = await service.reviewCandidate(OWNER, projectId, { candidateId });
  assert.equal(reportFor(review.lead_promotion, 'chord3-1').status, 'PASS');
  assert.equal(review.readiness.gates.leadPromotion.status, 'PASS');
});

// ─── 5. discovery names the path that answers with resolved evidence ────────

test('capabilities name reviewLeadEvidence for Gate 3 and say how a decision-time citation is graded', async () => {
  const caps = await createStudioApplication().capabilities();
  const axes = Object.fromEntries(caps.gates.review_axes_settable_by_this_service.map(entry => [entry.axis, entry]));
  for (const axis of ['lead_promotion', 'lead_demotion']) {
    assert.equal(axes[axis].operation, 'reviewLeadEvidence', axis);
    assert.match(axes[axis].decision_time_citation, /applyDecisions\.leadEvidence/, axis);
    assert.match(axes[axis].decision_time_citation, /machine metric/, axis);
    assert.match(axes[axis].decision_time_citation, /official score the project holds/, axis);
  }
  assert.equal(caps.capabilities.lead_decision_citation_source_resolution, true);
});
