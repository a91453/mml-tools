// Lead evidence review authority: the evidence decides, never the submitter.
//
// A lower evidence layer must not impersonate a higher one (MASTER_RULES §11),
// an audio metric is a locator, never role evidence by itself (SOURCE_POLICY
// §6), and a third-party file is supporting evidence only (§1C). None of that
// depends on who submits a review: Published Canonical names no reviewer
// species for Lead evidence (only ACCEPTANCE Gate 10 binds an actor, and this
// path cannot touch it). A first fix keyed authority on `reviewer_kind ===
// 'human'`; that is gone.
//
// What these pin:
//   * a review must say who submitted it and how its audio classification was
//     established, or it is refused and nothing is stored (LRA-1, LRA-2);
//   * the same evidence grades the same for every submitter kind, strong
//     (LRA-3) or weak (LRA-4);
//   * the original recording is primary evidence by a direct review of it, and
//     a machine metric computed from it is not, for anyone (LRA-5);
//   * a stored historical review with no attestation is kept, unchanged, and is
//     not graded (LRA-6);
//   * the grader refuses supporting/unresolved sources and metrics as positive
//     evidence but lets them raise a conflict (LRA-7);
//   * demotion still needs positive evidence and fails closed (LRA-8);
//   * MCP, HTTP and a direct call converge (LRA-9); nothing here sets in-game
//     (LRA-10); no human-only condition remains in the sources (LRA-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioApplication } from '../backend/application/index.mjs';
import { createStore } from '../backend/application/store.mjs';
import { LEAD_REVIEW_AUTHORITY, LEAD_REVIEW_REVIEWER_KINDS, LEAD_EVIDENCE_SOURCE_REFUSAL } from '../backend/application/lead-review-authority.mjs';
import { leadContextDigestOf } from '../backend/arrangement/decision-application.mjs';
import {
  evaluateLeadPromotion,
  evaluateLeadDemotion,
  AUDIO_METRIC_NOT_ROLE_EVIDENCE,
  LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE,
} from '../backend/arbitration/lead-demotion.mjs';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleMcp } from '../../server/mcp.mjs';
import { createApiRouter } from '../../server/api.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const SOURCE_ID = 'fixture:official-midi';
const HUMAN = Object.freeze({ reviewer: 'human:alice', reviewer_kind: 'human', audio_basis: 'listening' });
const submitter = (reviewer_kind, audio_basis = 'direct-source-review') => Object.freeze({ reviewer: `${reviewer_kind}:fixture`, reviewer_kind, audio_basis });
// The project sources a review cites, uploaded by `stalePromotion()`: an
// official score and the recording (primary), a third-party MIDI (supporting)
// and an "official" upload of the third-party bytes (a relabelled copy).
const CITED = { score: null, audio: null, thirdParty: null, relabelled: null };

const promotionEvidence = (eventId, over = {}) => ({
  sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#${eventId}` },
  sectionRole: 'instrumental',
  scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:score top line bar 1', ref: CITED.score },
  audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio 0:00 foreground', ref: CITED.audio },
  continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
  core3: { checked: true, status: 'PASS' },
  positiveReason: 'The score places this attack on the top staff and the mix carries it in front.',
  ...over,
});
const demotionEvidence = eventId => promotionEvidence(eventId, {
  scoreEvidence: { availability: 'available', classification: 'inner', citation: 'fixture:score inner staff', ref: CITED.score },
  audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture:audio 0:00 behind the lead', ref: CITED.audio },
  positiveReason: 'The score places this attack on the inner staff and the mix keeps it behind the lead.',
});
const promote = eventId => ({
  id: `promote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Chord3', toRole: 'Melody',
  reason: 'Reviewed: this cited voice carries the foreground lead.', evidence: ['fixture:score top line'],
  leadEvidence: promotionEvidence(eventId), acceptedBy: 'reviewer:test',
});
const demote = eventId => ({
  id: `demote:${eventId}`, type: 'MOVE_ROLE', target: { eventIds: [eventId] }, fromRole: 'Melody', toRole: 'Chord3',
  reason: 'Reviewed: inner material.', evidence: ['fixture:score inner staff'],
  leadEvidence: demotionEvidence(eventId), acceptedBy: 'reviewer:test',
});
const reportFor = (reports, eventId) => reports.find(report => report.eventId === eventId);
const review = (attestation, over = {}) => ({
  ...(attestation ? { attestation } : {}),
  event_id: 'chord3-1', axis: 'promotion',
  reason: 'Re-reviewed against the Lead picture as it now stands.',
  evidence: ['fixture:score top line bar 1'],
  lead_evidence: promotionEvidence('chord3-1'),
  ...over,
});

// A candidate whose promotion of chord3-1 is PENDING and waiting on a fresh review.
async function stalePromotion(dataDirectory = null) {
  const service = dataDirectory
    ? createStudioApplication({ dataDirectory, durability: 'persistent' })
    : createStudioApplication();
  const { project } = await service.createProject(OWNER, { title: 'authority' });
  const projectId = project.project_id;
  await service.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()) });
  await service.analyzeSources(OWNER, projectId);
  // Held after intake, so they stay evidence and are not parsed into the baseline.
  const upload = async (kind, filename, text) => (await service.uploadAsset(OWNER, projectId, { kind, filename, mediaType: 'application/octet-stream', bytes: new TextEncoder().encode(text) })).asset.asset_id;
  CITED.score = await upload('official_musicxml', 'score.musicxml', 'fixture official score');
  CITED.audio = await upload('original_audio', 'song.m4a', 'fixture recording');
  CITED.thirdParty = await upload('third_party_midi', 'cover.mid', 'fixture third-party transcription');
  CITED.relabelled = await upload('official_midi', 'cover-official.mid', 'fixture third-party transcription');
  const first = await service.applyDecisions(OWNER, projectId, { decisions: [promote('chord3-1')] });
  const second = await service.applyDecisions(OWNER, projectId, { parentCandidateId: first.decisions.candidate_id, decisions: [demote('melody-1')] });
  const candidateId = second.decisions.candidate_id;
  const stale = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(stale.lead_promotion, 'chord3-1').status, 'PENDING');
  return { service, projectId, candidateId };
}

test('LRA-1 a review without an attestation is refused and nothing is stored', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(null) }), /attestation is required/);
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, reviewer_kind: 'person' }) }), /reviewer_kind/);
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, reviewer: ' ' }) }), /reviewer must name/);
  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(after.lead_evidence_reviews.length, 0);
});

test('LRA-2 audio_basis must agree with the audio evidence it describes', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review({ ...HUMAN, audio_basis: 'not-used' }) }), /cannot be not-used/);
  const noAudio = promotionEvidence('chord3-1', { audioEvidence: { availability: 'unavailable' } });
  await assert.rejects(() => service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(HUMAN, { lead_evidence: noAudio }) }), /must be not-used/);
});

// The grade without its submitter: what must not depend on who submitted.
const gradeOf = report => JSON.stringify({ status: report.status, blockers: report.blockers, warnings: report.warnings, evidence: report.evidence });

test('LRA-3 the same source-cited review grades identically for every kind of submitter', async () => {
  const results = [];
  for (const kind of LEAD_REVIEW_REVIEWER_KINDS) {
    const { service, projectId, candidateId } = await stalePromotion();
    const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(submitter(kind)) });
    assert.equal(recorded.review.attestation.reviewer_kind, kind, 'provenance is recorded as submitted');
    assert.equal(recorded.review.authenticated_owner, OWNER);
    assert.equal(recorded.authority, LEAD_REVIEW_AUTHORITY.GRADED_ON_EVIDENCE);
    assert.equal(recorded.counted_as_reviewer_evidence, true);
    assert.deepEqual([recorded.evidence_sources.score.sourceAuthority, recorded.evidence_sources.audio.sourceAuthority], ['primary', 'primary']);
    const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
    const report = reportFor(after.lead_promotion, 'chord3-1');
    assert.equal(report.status, 'PASS', kind);
    assert.equal(after.readiness.gates.leadPromotion.status, 'PASS', kind);
    results.push(gradeOf(report));
  }
  assert.equal(new Set(results).size, 1, 'one grade, whoever submitted it');
});

test('LRA-4 weak evidence stays weak for every submitter: supporting, relabelled, uncited or unknown sources prove no role', async () => {
  const weak = {
    'third-party score': [{ scoreEvidence: { availability: 'available', classification: 'lead', citation: 'third-party top line', ref: () => CITED.thirdParty }, audioEvidence: { availability: 'unavailable' } }, LEAD_EVIDENCE_SOURCE_REFUSAL.SUPPORTING_ONLY],
    'relabelled copy': [{ scoreEvidence: { availability: 'available', classification: 'lead', citation: '"official" top line', ref: () => CITED.relabelled }, audioEvidence: { availability: 'unavailable' } }, LEAD_EVIDENCE_SOURCE_REFUSAL.NOT_INDEPENDENT],
    'no reference': [{ scoreEvidence: { availability: 'available', classification: 'lead', citation: 'a score somewhere' }, audioEvidence: { availability: 'unavailable' } }, LEAD_EVIDENCE_SOURCE_REFUSAL.NOT_CITED],
    'unknown reference': [{ scoreEvidence: { availability: 'available', classification: 'lead', citation: 'x', ref: () => 'ast_not_in_this_project' }, audioEvidence: { availability: 'unavailable' } }, LEAD_EVIDENCE_SOURCE_REFUSAL.REF_UNKNOWN],
    'audio cited as a score': [{ scoreEvidence: { availability: 'available', classification: 'lead', citation: 'x', ref: () => CITED.audio }, audioEvidence: { availability: 'unavailable' } }, LEAD_EVIDENCE_SOURCE_REFUSAL.KIND_MISMATCH],
  };
  for (const [label, [shape, refusal]] of Object.entries(weak)) {
    const grades = [];
    for (const kind of ['human', 'agent', 'tool']) {
      const { service, projectId, candidateId } = await stalePromotion();
      const resolvedShape = Object.fromEntries(Object.entries(shape).map(([key, item]) => [key, typeof item.ref === 'function' ? { ...item, ref: item.ref() } : item]));
      const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(submitter(kind, 'not-used'), { lead_evidence: promotionEvidence('chord3-1', resolvedShape) }) });
      assert.equal(recorded.report.status, 'PENDING', `${label} / ${kind}`);
      assert.ok(recorded.report.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'), `${label} / ${kind}`);
      assert.ok(recorded.report.warnings.includes(LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE), `${label} / ${kind}`);
      assert.equal(recorded.evidence_sources.score.reason, refusal, `${label} / ${kind}`);
      const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
      assert.equal(after.readiness.gates.leadPromotion.status, 'PENDING', 'the Source-Faithful state stands');
      grades.push(gradeOf(recorded.report));
    }
    assert.equal(new Set(grades).size, 1, `${label}: one grade, whoever submitted it`);
  }
});

test('LRA-5 the original recording is primary evidence by a direct review of it; a metric computed from it is a locator for anyone', async () => {
  const audioOnly = () => promotionEvidence('chord3-1', { scoreEvidence: { availability: 'unavailable' } });
  for (const kind of ['human', 'agent', 'tool']) {
    {
      const { service, projectId, candidateId } = await stalePromotion();
      const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(submitter(kind, 'direct-source-review'), { lead_evidence: audioOnly() }) });
      assert.equal(recorded.report.status, 'PASS', `${kind}: a direct review of the recording is positive evidence`);
      assert.equal(recorded.review.attestation.audio_basis, 'listening', 'direct-source-review and listening grade identically');
    }
    {
      const { service, projectId, candidateId } = await stalePromotion();
      const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: review(submitter(kind, 'machine-metric'), { lead_evidence: audioOnly() }) });
      assert.equal(recorded.report.status, 'PENDING', `${kind}: a metric is not a finding`);
      assert.ok(recorded.report.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'));
      assert.ok(recorded.report.warnings.includes(AUDIO_METRIC_NOT_ROLE_EVIDENCE));
      // And from the stored record, on every later review.
      const reread = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
      assert.equal(reportFor(reread.lead_promotion, 'chord3-1').status, 'PENDING');
      assert.ok(reportFor(reread.lead_promotion, 'chord3-1').warnings.includes(AUDIO_METRIC_NOT_ROLE_EVIDENCE));
    }
  }
});

test('LRA-6 a historical review with no attestation stays on record and is not graded; an attested one is graded on its evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lra-'));
  try {
    const { service, projectId, candidateId } = await stalePromotion(dir);
    const store = createStore({ directory: dir, durability: 'persistent' });
    const record = store.readProjectRecord(projectId);
    const legacy = {
      event_id: 'chord3-1', axis: 'promotion', lead_evidence: promotionEvidence('chord3-1'), reason: 'legacy', evidence: ['legacy citation'],
      lead_context_digest: null, origin_event_id: 'chord3-1', baseline_id: record.baseline.baseline_id, candidate_id: candidateId, at: '2026-09-22T15:00:00.000Z',
    };
    // Written the way a pre-attestation build stored it, bound to this exact
    // candidate's Lead context so that it would PASS if it were graded.
    const key = `lead-evidence-reviews:${projectId}:${candidateId}`;
    legacy.lead_context_digest = leadContextDigestOf(store.getJson(`application:${projectId}:${candidateId}`).candidate);
    // Control: the identical entry with an attestation -- any submitter -- is graded and passes.
    for (const kind of ['agent', 'human']) {
      store.putJson(key, [{ ...legacy, attestation: submitter(kind, 'listening') }]);
      const control = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
      assert.equal(reportFor(control.lead_promotion, 'chord3-1').status, 'PASS', `${kind}: the fixture entry is a passing citation when attested`);
    }
    // An attested entry made under the first, human-only build that the old
    // rule refused: it is graded on its evidence now, and uncited sources prove nothing.
    store.putJson(key, [{ ...legacy, lead_evidence: promotionEvidence('chord3-1', { scoreEvidence: { availability: 'available', classification: 'lead', citation: 'free text' }, audioEvidence: { availability: 'available', classification: 'foreground', citation: 'free text' } }), attestation: submitter('agent', 'listening') }]);
    assert.equal(reportFor((await service.reviewCandidate(OWNER, projectId, { candidateId })).review.lead_promotion, 'chord3-1').status, 'PENDING');
    store.putJson(key, [legacy]);
    const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
    assert.equal(after.lead_evidence_reviews.length, 1);
    assert.equal(after.lead_evidence_reviews[0].authority, LEAD_REVIEW_AUTHORITY.UNATTESTED_LEGACY);
    assert.equal(reportFor(after.lead_promotion, 'chord3-1').status, 'PENDING');
    assert.deepEqual(store.getJson(key), [legacy], 'the stored record is not rewritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LRA-7 grader: a metric is never positive role evidence but can still raise a conflict', () => {
  const event = { id: 'e1', role: 'Chord3', sourceIds: [SOURCE_ID], sourceEventIds: [`${SOURCE_ID}#e1`] };
  const base = {
    event, sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#e1` }, sectionRole: 'vocal-active',
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] }, core3: { checked: true, status: 'PASS' }, positiveReason: 'x',
  };
  const metricForeground = { availability: 'available', classification: 'foreground', citation: 'F0 match', basis: 'machine-metric' };
  const promo = evaluateLeadPromotion({ ...base, scoreEvidence: { availability: 'unavailable' }, audioEvidence: metricForeground });
  assert.equal(promo.status, 'PENDING');
  assert.ok(promo.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'));
  // A metric saying "background" still conflicts with a score saying "lead".
  const conflict = evaluateLeadPromotion({ ...base, scoreEvidence: { availability: 'available', classification: 'lead', citation: 's' }, audioEvidence: { ...metricForeground, classification: 'background' } });
  assert.ok(conflict.blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'));
  const melodyEvent = { ...event, role: 'Melody' };
  const demo = evaluateLeadDemotion({ ...base, event: melodyEvent, destinationRole: 'Chord3', scoreEvidence: { availability: 'unavailable' }, audioEvidence: { ...metricForeground, classification: 'background' } });
  assert.ok(demo.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'), 'a metric cannot demote a Lead');
  assert.throws(() => evaluateLeadPromotion({ ...base, audioEvidence: { ...metricForeground, basis: 'vibes' } }), /audio.basis/);
  // No basis: historical behaviour, byte-identical evidence shape.
  const legacy = evaluateLeadPromotion({ ...base, audioEvidence: { availability: 'available', classification: 'foreground', citation: 'a' } });
  assert.equal(legacy.status, 'PASS');
  assert.equal('basis' in legacy.evidence.audio, false);
});

test('LRA-7b grader: a supporting or unresolved source is never positive role evidence but can still raise a conflict', () => {
  const event = { id: 'e1', role: 'Chord3', sourceIds: [SOURCE_ID], sourceEventIds: [`${SOURCE_ID}#e1`] };
  const base = {
    event, sourceIdentity: { sourceId: SOURCE_ID, sourceEventId: `${SOURCE_ID}#e1` }, sectionRole: 'vocal-active',
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] }, core3: { checked: true, status: 'PASS' }, positiveReason: 'x',
  };
  const score = sourceAuthority => ({ availability: 'available', classification: 'lead', citation: 's', sourceAuthority });
  assert.equal(evaluateLeadPromotion({ ...base, scoreEvidence: score('primary') }).status, 'PASS');
  for (const authority of ['supporting', 'unresolved']) {
    const graded = evaluateLeadPromotion({ ...base, scoreEvidence: score(authority) });
    assert.ok(graded.blockers.includes('POSITIVE_LEAD_EVIDENCE_MISSING'), authority);
    assert.ok(graded.warnings.includes(LEAD_EVIDENCE_SOURCE_NOT_AUTHORITATIVE), authority);
    // Weak evidence can still hold a Lead in place: it conflicts with primary non-Lead evidence.
    const melody = evaluateLeadDemotion({ ...base, event: { ...event, role: 'Melody' }, destinationRole: 'Chord3', scoreEvidence: score(authority), audioEvidence: { availability: 'available', classification: 'background', citation: 'a', basis: 'listening', sourceAuthority: 'primary' } });
    assert.ok(melody.blockers.includes('SOURCE_ROLE_EVIDENCE_CONFLICT'), authority);
  }
  assert.throws(() => evaluateLeadPromotion({ ...base, scoreEvidence: score('trusted') }), /sourceAuthority/);
});

// A candidate whose demotion of melody-1 is PENDING and waiting on a fresh review.
async function staleDemotion() {
  const service = createStudioApplication();
  const { project } = await service.createProject(OWNER, { title: 'demotion authority' });
  const projectId = project.project_id;
  await service.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()) });
  await service.analyzeSources(OWNER, projectId);
  const upload = async (kind, filename, text) => (await service.uploadAsset(OWNER, projectId, { kind, filename, mediaType: 'application/octet-stream', bytes: new TextEncoder().encode(text) })).asset.asset_id;
  CITED.score = await upload('official_musicxml', 'score.musicxml', 'fixture official score');
  CITED.audio = await upload('original_audio', 'song.m4a', 'fixture recording');
  CITED.thirdParty = await upload('third_party_midi', 'cover.mid', 'fixture third-party transcription');
  const first = await service.applyDecisions(OWNER, projectId, { decisions: [demote('melody-1')] });
  const second = await service.applyDecisions(OWNER, projectId, { parentCandidateId: first.decisions.candidate_id, decisions: [promote('chord3-1')] });
  const candidateId = second.decisions.candidate_id;
  const stale = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(reportFor(stale.lead_demotion, 'melody-1')?.status, 'PENDING');
  return { service, projectId, candidateId };
}

test('LRA-8 a Lead demotion still needs positive evidence from a primary source, and fails closed without it, for every submitter', async () => {
  const demotionReview = (kind, over) => ({ attestation: submitter(kind, over.audioEvidence?.availability === 'unavailable' ? 'not-used' : 'direct-source-review'), event_id: 'melody-1', axis: 'demotion', reason: 'Re-reviewed.', evidence: ['fixture:score inner staff'], lead_evidence: { ...demotionEvidence('melody-1'), ...over } });
  for (const kind of ['human', 'agent']) {
    // "Not proven Vocal" is not evidence: nothing classified at all.
    {
      const { service, projectId, candidateId } = await staleDemotion();
      const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: demotionReview(kind, { scoreEvidence: { availability: 'available', classification: 'unknown' }, audioEvidence: { availability: 'unavailable' } }) });
      assert.equal(recorded.report.status, 'PENDING');
      assert.ok(recorded.report.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'));
    }
    // A third-party file saying "inner" does not demote the Source-Faithful Lead.
    {
      const { service, projectId, candidateId } = await staleDemotion();
      const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: demotionReview(kind, { scoreEvidence: { availability: 'available', classification: 'inner', citation: 'cover inner voice', ref: CITED.thirdParty }, audioEvidence: { availability: 'unavailable' } }) });
      assert.equal(recorded.report.status, 'PENDING');
      assert.ok(recorded.report.blockers.includes('POSITIVE_ROLE_EVIDENCE_MISSING'));
      const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
      assert.equal(after.readiness.gates.leadDemotion.status, 'PENDING');
    }
    // The official score and the recording, directly reviewed: positive evidence.
    {
      const { service, projectId, candidateId } = await staleDemotion();
      const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: demotionReview(kind, {}) });
      assert.equal(recorded.report.status, 'PASS', kind);
    }
  }
});

test('LRA-9 MCP, HTTP and a direct call file and grade the same review identically', async () => {
  const outcomes = [];
  for (const transport of ['direct', 'mcp', 'http']) {
    const { service, projectId, candidateId } = await stalePromotion();
    const args = { project_id: projectId, candidate_id: candidateId, review: review(submitter(transport === 'direct' ? 'human' : 'mcp-client')) };
    let result;
    if (transport === 'direct') result = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: args.review });
    else if (transport === 'mcp') {
      const response = await handleMcp(new Request('https://studio.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_lead_evidence_review', arguments: args } }) }), { application: service, owner: OWNER });
      const body = await response.json();
      assert.equal(body.result.isError, false, JSON.stringify(body).slice(0, 400));
      result = body.result.structuredContent;
    } else {
      const api = createApiRouter({ application: service, ownerOf: () => OWNER });
      const response = await api(new Request(`https://studio.test/api/v1/projects/${projectId}/lead-evidence/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate_id: candidateId, review: args.review }) }), { authenticated: true });
      assert.equal(response.status, 200);
      result = await response.json();
    }
    const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
    // Asset ids are per project; what each citation may prove is the comparison.
    const sources = Object.fromEntries(Object.entries(result.evidence_sources).map(([kind, item]) => [kind, { sourceAuthority: item.sourceAuthority, reason: item.reason, sourceClass: item.sourceClass, kind: item.kind }]));
    outcomes.push(JSON.stringify({ authority: result.authority, counted: result.counted_as_reviewer_evidence, sources, status: result.report.status, gate: after.readiness.gates.leadPromotion.status }));
  }
  assert.equal(new Set(outcomes).size, 1, outcomes.join('\n'));
  assert.equal(JSON.parse(outcomes[0]).status, 'PASS');
});

test('LRA-10 a Lead review cannot set in-game acceptance, whatever it carries', async () => {
  const { service, projectId, candidateId } = await stalePromotion();
  const recorded = await service.reviewLeadEvidence(OWNER, projectId, { candidateId, review: { ...review(submitter('human')), in_game: 'PASS', inGameAcceptance: 'PASS', gates: { in_game: 'PASS' } } });
  assert.equal(recorded.report.status, 'PASS');
  const after = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.equal(after.readiness.gates.inGameAcceptance.status, 'PENDING');
  assert.notEqual(after.readiness.songState, 'IN_GAME_ACCEPTED');
  assert.equal(after.gates.in_game, 'PENDING');
});

test('LRA-11 no backend or transport source keys evidence authority on a human submitter', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const offenders = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
      if (!/\.mjs$/.test(name)) continue;
      const text = readFileSync(path, 'utf8');
      if (/reviewer_kind\s*[!=]==?\s*['"]human['"]|['"]human['"]\s*[!=]==?\s*[\w.?]*reviewer_kind|HUMAN_ATTESTED/.test(text)) offenders.push(path);
    }
  };
  for (const dir of ['studio/backend', 'server']) if (existsSync(join(repository, dir))) walk(join(repository, dir));
  assert.deepEqual(offenders, []);
});
