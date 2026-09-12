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
  baseline = true,
  audioEvidence = true,
  audioWarnings = [],
  pendingDecision = false,
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

  return createCanonicalProject({
    id: 'song-1',
    title: 'Song 1',
    sources: [source],
    events: [event],
    decisions,
    metadata: {
      sourceComplete,
      ...(baseline ? {
        sourceFaithfulBaseline: {
          id: 'baseline:source-faithful',
          diffable: true,
          eventDiffAvailable: true,
        },
      } : {}),
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

function readyInput(overrides = {}) {
  return {
    project: project(),
    mmlValidation: { ok: true, errors: [] },
    core3Report: { status: 'PASS', blockers: [] },
    harmonyReport: { status: 'PASS', unresolvedCount: 0 },
    leadDemotionReports: [],
    lineageReport: null,
    versionDriftReviewed: false,
    playerReadback: 'PASS',
    originalAudioRequired: true,
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

test('source completeness is a hard per-song readiness condition', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ sourceComplete: false }) }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.source.status, 'PENDING');
  assert.ok(result.gates.source.blockers.includes('SOURCE_COMPLETENESS_NOT_CONFIRMED'));
});

test('diffable Source-Faithful Baseline is mandatory before candidate readiness', () => {
  const result = evaluateProjectReadiness(readyInput({ project: project({ baseline: false }) }));
  assert.equal(result.candidateReady, false);
  assert.equal(result.gates.baseline.status, 'PENDING');
  assert.deepEqual(result.gates.baseline.blockers, ['SOURCE_FAITHFUL_BASELINE_MISSING']);
  assert.ok(result.preGameBlocking.includes('baseline'));
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
    harmonyReport: null,
    playerReadback: 'NOT_RUN',
    originalAudioRequired: true,
  });
  assert.equal(result.gates.technical.status, 'NOT_RUN');
  assert.equal(result.gates.core3.status, 'NOT_RUN');
  assert.equal(result.gates.crossSourceHarmony.status, 'NOT_RUN');
  assert.equal(result.candidateReady, false);
});
