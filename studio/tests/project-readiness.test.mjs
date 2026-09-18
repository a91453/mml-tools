import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalProject,
  createArbitrationDecision,
} from '../backend/canonical/index.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';

function project({
  sourceComplete = true,
  baseline = 'snapshot',
  audioEvidence = true,
  audioWarnings = [],
  pendingDecision = false,
  removeLead = false,
} = {}) {
  const source = createSource({
    id: 'official',
    label: 'Official score',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
  });
  const event = createCanonicalNoteEvent({
    id: 'official:n1',
    pitch: 60,
    start: '0',
    end: '1',
    sourceIds: ['official'],
    role: 'Melody',
  });
  const baselineProject = createCanonicalProject({
    id: 'baseline:source-faithful',
    title: 'Source-Faithful Baseline',
    sources: [source],
    events: [event],
    metadata: { sourceComplete: true, baselineKind: 'source-faithful' },
  });
  const decisions = pendingDecision
    ? [createArbitrationDecision({
        id: 'decision:1',
        eventIds: ['official:n1'],
        action: 'review',
        status: 'pending',
        reason: 'Needs source arbitration',
        evidence: ['official'],
      })]
    : [];

  const baselineMetadata = baseline === 'snapshot'
    ? { sourceFaithfulBaseline: { snapshot: baselineProject } }
    : baseline === 'flags-only'
      ? { sourceFaithfulBaseline: { id: 'fake', diffable: true, eventDiffAvailable: true } }
      : {};

  return createCanonicalProject({
    id: 'song-1',
    title: 'Song 1',
    sources: [source],
    events: removeLead ? [] : [event],
    decisions,
    metadata: {
      sourceComplete,
      ...baselineMetadata,
      ...(audioEvidence ? {
        audioAlignmentEvidence: [{
          sourceId: 'original-audio',
          warnings: [...audioWarnings],
          metrics: { confidence: audioWarnings.length ? 0.4 : 0.9 },
        }],
      } : {}),
    },
  });
}

function promotionProject() {
  const source = createSource({
    id: 'official',
    label: 'Official score',
    kind: 'official-musicxml',
    authority: 'primary-symbolic',
  });
  const before = createCanonicalNoteEvent({
    id: 'official:p1',
    pitch: 67,
    start: '0',
    end: '1',
    sourceIds: ['official'],
    sourceEventIds: ['official#p1'],
    role: 'Chord1',
  });
  const after = createCanonicalNoteEvent({
    id: 'official:p1',
    pitch: 67,
    start: '0',
    end: '1',
    sourceIds: ['official'],
    sourceEventIds: ['official#p1'],
    role: 'Melody',
  });
  const baselineProject = createCanonicalProject({
    id: 'baseline:promotion',
    title: 'Promotion baseline',
    sources: [source],
    events: [before],
    metadata: { sourceComplete: true, baselineKind: 'source-faithful' },
  });
  return createCanonicalProject({
    id: 'song:promotion',
    title: 'Promotion candidate',
    sources: [source],
    events: [after],
    metadata: {
      sourceComplete: true,
      sourceFaithfulBaseline: { snapshot: baselineProject },
      audioAlignmentEvidence: [{ sourceId: 'original-audio', warnings: [], metrics: { confidence: 0.9 } }],
    },
  });
}

function readyInput(overrides = {}) {
  return {
    project: project(),
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    core3CompletenessReport: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    leadDemotionReports: [],
    leadPromotionReports: [],
    lineageReport: null,
    versionDriftReviewed: false,
    playerReadback: 'PASS',
    originalAudioRequired: true,
    mobileAdaptation: 'PASS',
    regressionReviewed: true,
    inGameAcceptance: 'PENDING',
    ...overrides,
  };
}

test('candidate readiness can pass before in-game acceptance, but finalAccepted cannot', () => {
  const result = evaluateProjectReadiness(readyInput());
  assert.equal(result.candidateReady, true);
  assert.equal(result.finalAccepted, false);
  assert.deepEqual(result.preGameBlocking, []);
  assert.equal(result.gates.implementation.status, 'PASS');
  assert.equal(result.gates.baseline.status, 'PASS');
  assert.equal(result.gates.baseline.baselineId, 'baseline:source-faithful');
  assert.equal(result.gates.baseline.eventDiff.structurallyIdentical, true);
  assert.deepEqual(result.gates.baseline.leadEventDiff.added, []);
  assert.deepEqual(result.gates.baseline.leadEventDiff.removed, []);
  assert.equal(result.gates.inGameAcceptance.status, 'PENDING');
});

test('finalAccepted requires both candidate readiness and explicit in-game PASS', () => {
  const result = evaluateProjectReadiness(readyInput({ inGameAcceptance: 'PASS' }));
  assert.equal(result.candidateReady, true);
  assert.equal(result.finalAccepted, true);
});

test('missing required original-audio evidence blocks candidate readiness', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ audioEvidence: false }) }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.originalAudio.status, 'PENDING');
  assert.deepEqual(result.gates.originalAudio.blockers, ['AUDIO_ALIGNMENT_EVIDENCE_MISSING']);
  assert.ok(result.preGameBlocking.includes('originalAudio'));
});

test('weak or warned audio evidence remains review-required instead of becoming PASS', () => {
  const result = evaluateProjectReadiness(readyInput({
    project: project({ audioWarnings: ['LOW_ALIGNMENT_CONFIDENCE'] }),
  }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.originalAudio.status, 'PENDING');
  assert.ok(result.gates.originalAudio.warnings.includes('LOW_ALIGNMENT_CONFIDENCE'));
});

test('original audio may be N/A only when the song workflow explicitly marks it not applicable', () => {
  const result = evaluateProjectReadiness(readyInput({
    project: project({ audioEvidence: false }),
    originalAudioRequired: false,
  }));
  assert.equal(result.gates.originalAudio.status, 'N/A');
  assert.equal(result.candidateReady, true);
});

test('Mobile adaptation is a required pre-game gate and N/A does not bypass review', () => {
  for (const mobileAdaptation of ['PENDING', 'NOT_RUN', 'N/A']) {
    const result = evaluateProjectReadiness(readyInput({ mobileAdaptation }));
    assert.equal(result.candidateReady, false, mobileAdaptation);
    assert.equal(result.gates.mobileAdaptation.status, 'PENDING', mobileAdaptation);
    assert.ok(result.gates.mobileAdaptation.blockers.includes('MOBILE_ADAPTATION_REVIEW_REQUIRED'), mobileAdaptation);
    assert.ok(result.preGameBlocking.includes('mobileAdaptation'), mobileAdaptation);
  }
  const passed = evaluateProjectReadiness(readyInput({ mobileAdaptation: 'PASS' }));
  assert.equal(passed.gates.mobileAdaptation.status, 'PASS');
  assert.equal(passed.candidateReady, true);
});

test('source completeness is a hard per-song readiness condition', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ sourceComplete: false }) }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.source.status, 'PENDING');
  assert.ok(result.gates.source.blockers.includes('SOURCE_COMPLETENESS_NOT_CONFIRMED'));
});

test('Source-Faithful Baseline snapshot is mandatory before candidate readiness', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ baseline: false }) }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.baseline.status, 'PENDING');
  assert.deepEqual(result.gates.baseline.blockers, ['SOURCE_FAITHFUL_BASELINE_MISSING']);
  assert.ok(result.preGameBlocking.includes('baseline'));
});

test('boolean-only baseline metadata cannot forge a PASS', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ baseline: 'flags-only' }) }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.baseline.status, 'PENDING');
  assert.deepEqual(result.gates.baseline.blockers, ['SOURCE_FAITHFUL_BASELINE_ARTIFACT_MISSING']);
  assert.ok(result.preGameBlocking.includes('baseline'));
});

test('baseline Lead removal without a matching demotion report blocks readiness', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ removeLead: true }) }));
  assert.equal(result.gates.baseline.status, 'PASS');
  assert.deepEqual(result.gates.baseline.leadEventDiff.removed, ['official:n1']);
  assert.equal(result.gates.leadDemotion.status, 'PENDING');
  assert.deepEqual(result.gates.leadDemotion.blockers, ['LEAD_DEMOTION_EVIDENCE_REQUIRED']);
  assert.deepEqual(result.gates.leadDemotion.pendingEventIds, ['official:n1']);
  assert.equal(result.candidateReady, false);
  assert.ok(result.preGameBlocking.includes('leadDemotion'));
});

test('baseline Lead removal can pass only with a matching evidence-backed PASS report', () => {
  const result = evaluateProjectReadiness(readyInput({
    project: project({ removeLead: true }),
    leadDemotionReports: [{ eventId: 'official:n1', status: 'PASS' }],
  }));
  assert.equal(result.gates.leadDemotion.status, 'PASS');
  assert.deepEqual(result.gates.leadDemotion.requiredEventIds, ['official:n1']);
  assert.equal(result.candidateReady, true);
});

test('Lead promotion is not misclassified as a demotion and fails closed without its own report', () => {
  const result = evaluateProjectReadiness(readyInput({ project: promotionProject() }));
  assert.equal(result.gates.baseline.status, 'PASS');
  assert.equal(result.gates.baseline.leadEventDiff.roleMoved.length, 1);
  assert.deepEqual(
    result.gates.baseline.leadEventDiff.roleMoved.map(move => [move.beforeRole, move.afterRole]),
    [['Chord1', 'Melody']],
  );
  assert.equal(result.gates.leadDemotion.status, 'N/A');
  assert.equal(result.gates.leadPromotion.status, 'PENDING');
  assert.deepEqual(result.gates.leadPromotion.blockers, ['LEAD_PROMOTION_EVIDENCE_REQUIRED']);
  assert.deepEqual(result.gates.leadPromotion.pendingEventIds, ['official:p1']);
  assert.ok(result.preGameBlocking.includes('leadPromotion'));
  assert.ok(!result.preGameBlocking.includes('leadDemotion'));
});

test('Lead promotion passes readiness only with the matching promotion grader PASS', () => {
  const result = evaluateProjectReadiness(readyInput({
    project: promotionProject(),
    leadPromotionReports: [{ eventId: 'official:p1', status: 'PASS' }],
  }));
  assert.equal(result.gates.leadDemotion.status, 'N/A');
  assert.equal(result.gates.leadPromotion.status, 'PASS');
  assert.deepEqual(result.gates.leadPromotion.requiredEventIds, ['official:p1']);
  assert.equal(result.candidateReady, true);
});

test('technical validation failure blocks readiness even when musical gates pass', () => {
  const result = evaluateProjectReadiness(readyInput({
    mmlValidation: { ok: false, errors: [{ message: 'invalid final syntax' }] },
  }));
  assert.equal(result.gates.technical.status, 'FAIL');
  assert.equal(result.candidateReady, false);
});

test('Core3, Lead Demotion and cross-source harmony stay independently blocking', () => {
  const result = evaluateProjectReadiness(readyInput({
    core3Report: { status: 'PENDING', blockers: ['SOURCE_SUPPORTED_LEAD_GAP'] },
    core3CompletenessReport: { status: 'PASS', blockers: [] },
    leadDemotionReports: [{ eventId: 'official:n1', status: 'PENDING' }],
    harmonyReport: { status: 'PENDING', unresolvedCount: 2 },
  }));
  assert.equal(result.candidateReady, false);
  assert.ok(result.preGameBlocking.includes('core3'));
  assert.ok(result.preGameBlocking.includes('leadDemotion'));
  assert.ok(result.preGameBlocking.includes('crossSourceHarmony'));
  assert.deepEqual(result.gates.leadDemotion.pendingEventIds, ['official:n1']);
  assert.equal(result.gates.crossSourceHarmony.unresolvedCount, 2);
});

test('unreviewed increased version divergence blocks readiness', () => {
  const lineageReport = { reviewRequired: true, divergenceIncreased: true };
  const pending = evaluateProjectReadiness(readyInput({ lineageReport }));
  assert.equal(pending.gates.versionDrift.status, 'PENDING');
  assert.equal(pending.candidateReady, false);

  const reviewed = evaluateProjectReadiness(readyInput({ lineageReport, versionDriftReviewed: true }));
  assert.equal(reviewed.gates.versionDrift.status, 'PASS');
  assert.equal(reviewed.candidateReady, true);
});

test('player readback is required for candidate readiness', () => {
  const result = evaluateProjectReadiness(readyInput({ playerReadback: 'NOT_RUN' }));
  assert.equal(result.candidateReady, false);
  assert.ok(result.preGameBlocking.includes('playerReadback'));
});

test('pending arbitration decisions block readiness even if summary gates were supplied as PASS', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ pendingDecision: true }) }));
  assert.equal(result.gates.pendingDecisions.status, 'PENDING');
  assert.deepEqual(result.gates.pendingDecisions.decisionIds, ['decision:1']);
  assert.equal(result.candidateReady, false);
});

test('missing gate reports fail closed as NOT_RUN instead of silently passing', () => {
  const result = evaluateProjectReadiness({
    project: project(),
    mmlValidation: null,
    core3Report: null,
    core3CompletenessReport: { status: 'PASS', blockers: [] },
    harmonyReport: null,
    playerReadback: 'NOT_RUN',
    originalAudioRequired: true,
  });
  assert.equal(result.gates.technical.status, 'NOT_RUN');
  assert.equal(result.gates.core3.status, 'NOT_RUN');
  assert.equal(result.gates.crossSourceHarmony.status, 'NOT_RUN');
  assert.equal(result.candidateReady, false);
});
