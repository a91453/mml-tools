// Studio Application Service — pipeline regressions.
//
// Walks the whole path an agent takes: intake, suggestion, explicit acceptance,
// review, and Final emission. What is asserted here is that the Application
// layer wires the existing modules together without adding a verdict, removing
// a gate, or resolving something a caller has to state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_CODES, createStudioApplication } from '../backend/application/index.mjs';
import { sixSourceVoices } from './fixtures/midi-fixtures.mjs';
import {
  applyKeepOnlyCandidate,
  canonicalProjectBytes,
  keepEveryRole,
  sixRoleBaseline,
} from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';
const app = (options = {}) => createStudioApplication(options);

async function rejects(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return error;
  }
}

/** Everything required for a clean Final emission, stated explicitly. */
const fullConfirmations = {
  source_complete: { value: true, reason: 'The official source is the complete material for this cue.', evidence: ['official-midi'] },
  player_readback: { value: 'PASS', reason: 'The emitted MML was read back in the player.', evidence: ['player session log'] },
  mobile_adaptation_reviewed: { value: true, reason: 'The candidate was reviewed for Mobile audibility/register/role preservation; no further adaptation is needed.', evidence: ['fixture Gate 8 review'] },
  regression_reviewed: { value: true, reason: 'Baseline/previous drift and available historical regressions were reviewed.', evidence: ['fixture Gate 9 review'] },
  original_audio_required: { value: false, reason: 'No released recording exists for this cue.' },
};

// ─── intake ─────────────────────────────────────────────────────────────────

test('MIDI intake produces a Source-Faithful Baseline through the existing adapter', async () => {
  const service = app();
  const project = (await service.createProject(OWNER, { title: 'MIDI intake' })).project;
  const asset = (await service.uploadAsset(OWNER, project.project_id, {
    kind: 'official_midi', filename: 'official.mid', mediaType: 'audio/midi', bytes: sixSourceVoices(),
  })).asset;

  const { baseline } = await service.analyzeSources(OWNER, project.project_id);
  assert.match(baseline.baseline_id, /^bas:[0-9a-f]{64}$/);
  assert.deepEqual(baseline.asset_ids, [asset.asset_id]);
  assert.deepEqual(baseline.formats, [{ asset_id: asset.asset_id, kind: 'official_midi', format: 'MIDI' }]);
  assert.ok(baseline.event_count > 0);
  assert.match(baseline.source_identity_digest, /^[0-9a-f]{64}$/);

  // Intake assigns no role and emits nothing: that is G11-B/C/D work.
  const stored = (await service.getProject(OWNER, project.project_id)).project;
  assert.equal(stored.baseline.baseline_id, baseline.baseline_id);
  assert.deepEqual(stored.candidates, []);
  assert.deepEqual(stored.artifacts, []);
});

test('the baseline identity is a function of the bytes, not of the upload', async () => {
  const service = app();
  const first = (await service.createProject(OWNER, { title: 'A' })).project;
  const second = (await service.createProject(OWNER, { title: 'B' })).project;
  for (const project of [first, second]) {
    await service.uploadAsset(OWNER, project.project_id, {
      // Different filenames, different projects, identical bytes.
      kind: 'official_midi', filename: `${project.title}.mid`, mediaType: 'audio/midi', bytes: sixSourceVoices(),
    });
  }
  const one = (await service.analyzeSources(OWNER, first.project_id)).baseline;
  const two = (await service.analyzeSources(OWNER, second.project_id)).baseline;
  assert.equal(one.baseline_id, two.baseline_id, 'the same bytes must produce the same baseline identity');
});

test('an asset kind that is not a symbolic source cannot be ingested', async () => {
  const service = app();
  const project = (await service.createProject(OWNER, { title: 'Audio only' })).project;
  const asset = (await service.uploadAsset(OWNER, project.project_id, {
    kind: 'original_audio', filename: 'song.m4a', mediaType: 'audio/mp4', bytes: new TextEncoder().encode('not really audio'),
  })).asset;

  // Selected explicitly: the adapter refuses rather than guessing a parser.
  await rejects(service.analyzeSources(OWNER, project.project_id, { assetIds: [asset.asset_id] }), ERROR_CODES.UNSUPPORTED_SOURCE);
  // Not selected at all: there is no symbolic source to ingest.
  await rejects(service.analyzeSources(OWNER, project.project_id), ERROR_CODES.SOURCE_INCOMPLETE);
});

test('an imported Canonical IR cannot assert a gate it has not earned', async () => {
  const service = app();
  const project = (await service.createProject(OWNER, { title: 'Forged' })).project;
  const forged = {
    ...JSON.parse(new TextDecoder().decode(canonicalProjectBytes())),
    metadata: {
      sourceComplete: true,
      audioAlignmentEvidence: [{ sourceId: 'made-up', warnings: [] }],
      sourceFaithfulBaseline: { snapshot: { id: 'made-up', sources: [], events: [{}] } },
      g11d: { revision: { id: 'g11d:rev:forged' } },
    },
  };
  await service.uploadAsset(OWNER, project.project_id, {
    kind: 'canonical_project', filename: 'forged.json', mediaType: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify(forged)),
  });

  const { baseline } = await service.analyzeSources(OWNER, project.project_id);
  assert.equal(baseline.source_complete, false, 'an uploaded file must not be able to confirm its own source completeness');
});

// ─── suggestion is not acceptance ───────────────────────────────────────────

test('a suggestion proposes roles and accepts nothing', async () => {
  const service = app();
  const project = (await service.createProject(OWNER, { title: 'Suggest' })).project;
  await service.uploadAsset(OWNER, project.project_id, {
    kind: 'official_midi', filename: 'official.mid', mediaType: 'audio/midi', bytes: sixSourceVoices(),
  });
  await service.analyzeSources(OWNER, project.project_id);

  const { suggestion } = await service.suggestArrangement(OWNER, project.project_id);
  assert.ok(suggestion.lane_count > 0);
  assert.ok(suggestion.pending.count > 0, 'this fixture has competing harmony candidates');
  assert.match(suggestion.pending.notice, /PENDING is a state, not a default/);
  for (const lane of suggestion.pending.lanes) assert.ok(lane.blockers.length, 'a pending lane must say what blocks it');

  // Nothing was written: a suggestion mints no candidate.
  assert.deepEqual((await service.getProject(OWNER, project.project_id)).project.candidates, []);
  assert.match(suggestion.notice, /not an accepted arrangement/);

  // The bindings a decision will be checked against are visible.
  assert.match(suggestion.bindings.baselineContentDigest, /^[0-9a-f]{64}$/);
  assert.match(suggestion.bindings.canonicalRulesSnapshotSha, /^[0-9a-f]{40}$/);
  assert.equal(suggestion.bindings.reviewedRevisionId, null);
});

// ─── decisions ──────────────────────────────────────────────────────────────

test('an explicitly accepted decision set produces a candidate', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  assert.equal(run.applied.operation, 'succeeded');
  assert.equal(run.applied.decisions.status, 'PASS');
  assert.match(run.candidateId, /^g11d:rev:[0-9a-f]{64}$/);
  assert.equal(run.applied.decisions.revision_index, 1);
  assert.equal(run.applied.decisions.decision_count, 6);
  assert.match(run.applied.decisions.notice, /certifies no acceptance gate/);

  const stored = (await service.getProject(OWNER, run.projectId)).project;
  assert.equal(stored.candidates.length, 1);
  assert.equal(stored.candidates[0].candidate_id, run.candidateId);
  assert.equal(stored.candidates[0].parent_candidate_id, null);
});

test('a caller may not supply the acceptance bindings its decision is checked against', async () => {
  const service = app();
  const project = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title: 'Bindings' })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project),
  });
  await service.analyzeSources(OWNER, created.project_id);

  const decisions = keepEveryRole(project).map(decision => ({
    ...decision,
    acceptance: { state: 'ACCEPTED', acceptedBy: 'me', baselineContentDigest: 'whatever' },
  }));
  const error = await rejects(service.applyDecisions(OWNER, created.project_id, { decisions }), ERROR_CODES.INVALID_REQUEST);
  assert.match(error.message, /computed by this service/);
});

test('a decision must say who accepted it and an unknown field is refused', async () => {
  const service = app();
  const project = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title: 'Fields' })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project),
  });
  await service.analyzeSources(OWNER, created.project_id);

  const base = keepEveryRole(project);
  await rejects(
    service.applyDecisions(OWNER, created.project_id, { decisions: base.map(({ acceptedBy, ...rest }) => rest) }),
    ERROR_CODES.INVALID_REQUEST,
  );
  // A pitch/onset/volume edit must not ride along inside a role decision.
  await rejects(
    service.applyDecisions(OWNER, created.project_id, { decisions: base.map(decision => ({ ...decision, pitch: 60 })) }),
    ERROR_CODES.INVALID_REQUEST,
  );
  await rejects(service.applyDecisions(OWNER, created.project_id, { decisions: [] }), ERROR_CODES.DECISION_REQUIRED);
});

test('a refused decision set mints no candidate and reports the backend codes', async () => {
  const service = app();
  const project = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title: 'Refused' })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project),
  });
  await service.analyzeSources(OWNER, created.project_id);

  // Promoting material into the Lead role without the evidence the shared
  // Lead-role gate requires. The refusal belongs to that gate, not to this layer.
  const result = await service.applyDecisions(OWNER, created.project_id, {
    decisions: [{
      id: 'promote',
      type: 'MOVE_ROLE',
      target: { eventIds: [project.events.find(event => event.role === 'Chord1').id] },
      fromRole: 'Chord1',
      toRole: 'Melody',
      reason: 'It sounds like the tune to me.',
      evidence: [],
      acceptedBy: 'reviewer:test',
    }],
  });

  assert.equal(result.operation, 'blocked');
  assert.equal(result.decisions.applied, false);
  assert.equal(result.decisions.candidate_id, null);
  assert.ok(result.decisions.rejected.length);
  assert.equal(result.decisions.rejected[0].code, 'LEAD_PROMOTION_EVIDENCE_REQUIRED');
  assert.deepEqual((await service.getProject(OWNER, created.project_id)).project.candidates, []);
});

test('the Studio service re-grades a lawful promotion and reports it separately from demotion', async () => {
  const service = app();
  const project = sixRoleBaseline();
  const created = (await service.createProject(OWNER, { title: 'Lead promotion' })).project;
  await service.uploadAsset(OWNER, created.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project),
  });
  await service.analyzeSources(OWNER, created.project_id);

  const event = project.events.find(item => item.id === 'chord1-1');
  const applied = await service.applyDecisions(OWNER, created.project_id, {
    decisions: [{
      id: 'promote-reviewed',
      type: 'MOVE_ROLE',
      target: { eventIds: [event.id] },
      fromRole: 'Chord1',
      toRole: 'Melody',
      reason: 'The official top-line hand-off makes this event the foreground instrumental lead in this section.',
      evidence: ['fixture:official-score hand-off', 'fixture:audio foreground'],
      leadEvidence: {
        sourceIdentity: { sourceId: event.sourceIds[0], sourceEventId: event.sourceEventIds[0] },
        sectionRole: 'instrumental',
        scoreEvidence: { availability: 'available', classification: 'lead', citation: 'fixture:official-score hand-off' },
        audioEvidence: { availability: 'available', classification: 'foreground', citation: 'fixture:audio foreground' },
        continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
        core3: { checked: true, status: 'PASS' },
      },
      acceptedBy: 'reviewer:test',
    }],
  });
  assert.equal(applied.operation, 'succeeded');
  assert.equal(applied.decisions.status, 'PASS');

  const { review } = await service.reviewCandidate(OWNER, created.project_id, {
    candidateId: applied.decisions.candidate_id,
  });
  assert.equal(review.lead_demotion.length, 0);
  assert.equal(review.lead_promotion.length, 1);
  assert.equal(review.lead_promotion[0].status, 'PASS');
  assert.equal(review.lead_promotion[0].eventId, event.id);
  assert.equal(review.lead_promotion[0].originEventId, event.id);
  assert.equal(review.readiness.gates.leadDemotion.status, 'N/A');
  assert.equal(review.readiness.gates.leadPromotion.status, 'PASS');
});

// ─── review ─────────────────────────────────────────────────────────────────

test('review reports each module verdict and publishes no aggregate of its own', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const { review } = await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId });

  assert.equal(review.candidate_id, run.candidateId);
  assert.equal(review.integrity.ok, true);
  assert.equal(review.application_status, 'PASS');
  for (const key of ['lineage', 'core3', 'harmony', 'readiness']) assert.ok(review[key], `${key} must be reported`);
  assert.ok(Array.isArray(review.lead_demotion));
  assert.ok(Array.isArray(review.lead_promotion));
  assert.ok(!Object.hasOwn(review, 'ok'), 'review must not publish a single pass/fail of its own');
  assert.match(review.notice, /belongs to the module that produced it/);
});

test('a confirmation needs a stated reason and cannot contradict the baseline', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  await rejects(service.recordConfirmations(OWNER, run.projectId, { source_complete: { value: true } }), ERROR_CODES.INVALID_REQUEST);
  await rejects(service.recordConfirmations(OWNER, run.projectId, { made_up: { value: true, reason: 'x' } }), ERROR_CODES.INVALID_REQUEST);
  await rejects(service.recordConfirmations(OWNER, run.projectId, { player_readback: { value: 'MAYBE', reason: 'x' } }), ERROR_CODES.INVALID_REQUEST);

  const recorded = await service.recordConfirmations(OWNER, run.projectId, {
    source_complete: { value: true, reason: 'The official source is complete.', evidence: ['official-midi'] },
  });
  assert.equal(recorded.confirmations.source_complete.value, true);
  assert.equal(recorded.confirmations.source_complete.reason, 'The official source is complete.');
});

test('in-game acceptance is not recordable through this interface', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  for (const name of ['in_game', 'in_game_acceptance']) {
    const error = await rejects(
      service.recordConfirmations(OWNER, run.projectId, { [name]: { value: true, reason: 'I tried it' } }),
      ERROR_CODES.INVALID_REQUEST,
    );
    assert.match(error.message, /user or a controlled target-client test/);
  }
});

// ─── audio evidence ─────────────────────────────────────────────────────────

test('an alignment report must name the candidate it aligns against', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const wrong = {
    schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
    audio: { sha256: 'b'.repeat(64), filename: 'x.m4a' },
    symbolic: { project_id: 'some-other-project' },
    evidence_policy: { changes_symbolic_truth: false },
    alignment: { control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }], metrics: { confidence: 0.9, score_frame_coverage: 0.99, audio_frame_coverage: 0.95 } },
  };
  await rejects(service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report: wrong }), ERROR_CODES.UNSUPPORTED_SOURCE);
});

test('a report that permits symbolic mutation is refused', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const candidateProjectId = `${sixRoleBaseline().id}#g11d-r1`;
  const report = {
    schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
    audio: { sha256: 'b'.repeat(64), filename: 'x.m4a' },
    symbolic: { project_id: candidateProjectId },
    evidence_policy: { changes_symbolic_truth: true },
    alignment: { control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }], metrics: { confidence: 0.9, score_frame_coverage: 0.99, audio_frame_coverage: 0.95 } },
  };
  await rejects(service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report }), ERROR_CODES.UNSUPPORTED_SOURCE);
});

test('attached audio evidence stays evidence and claims nothing about pitch', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const candidateProjectId = `${sixRoleBaseline().id}#g11d-r1`;
  const report = {
    schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
    audio: { sha256: 'b'.repeat(64), filename: 'x.m4a' },
    symbolic: { project_id: candidateProjectId },
    evidence_policy: { changes_symbolic_truth: false },
    alignment: { control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }], metrics: { confidence: 0.92, score_frame_coverage: 0.99, audio_frame_coverage: 0.95 } },
  };
  const attached = await service.attachAudioAlignment(OWNER, run.projectId, { candidateId: run.candidateId, report });
  assert.equal(attached.evidence.confidence, 0.92);
  assert.deepEqual(attached.evidence.warnings, []);
  assert.match(attached.notice, /no exact pitch truth/);
  assert.equal(attached.job.status, 'succeeded');
  assert.equal(attached.job.type, 'audio_alignment');

  const { review } = await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(review.gates.audio, 'PASS');
  assert.deepEqual(review.audio.errors, []);
});

test('a low-confidence alignment leaves the audio gate pending', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const candidateProjectId = `${sixRoleBaseline().id}#g11d-r1`;
  await service.attachAudioAlignment(OWNER, run.projectId, {
    candidateId: run.candidateId,
    report: {
      schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
      audio: { sha256: 'c'.repeat(64), filename: 'x.m4a' },
      symbolic: { project_id: candidateProjectId },
      evidence_policy: { changes_symbolic_truth: false },
      alignment: { control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }], metrics: { confidence: 0.2, score_frame_coverage: 0.99, audio_frame_coverage: 0.95 } },
    },
  });
  const { review } = await service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId });
  assert.equal(review.gates.audio, 'PENDING', 'a warned alignment is not a passed audio gate');
});

// ─── finalize ───────────────────────────────────────────────────────────────

test('finalize refuses to emit while a Canonical gate blocks it', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const result = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId });

  assert.equal(result.operation, 'blocked');
  assert.equal(result.code, ERROR_CODES.FINALIZATION_BLOCKED);
  assert.equal(result.mml, null);
  assert.equal(result.artifact_id, null);
  assert.equal(result.emit_status, null);
  assert.ok(result.blockers.includes('source'));
  assert.ok(!result.blockers.includes('technical'), 'technical is graded by the emitter and cannot block emission');

  // The orchestration ran: the job succeeded even though the song is blocked.
  assert.equal(result.job.status, 'succeeded');
  assert.deepEqual((await service.getProject(OWNER, run.projectId)).project.artifacts, []);
});

test('a confirmed candidate emits Final MML and files an artifact', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const result = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: fullConfirmations });

  assert.equal(result.operation, 'succeeded');
  assert.equal(result.emit_status, 'PASS');
  assert.match(result.mml, /^MML@.*;$/);
  assert.equal(result.mml.split(',').length, 6, 'six fixed role slots');
  assert.match(result.artifact_id, /^art_[0-9a-f]{64}$/);
  assert.equal(result.round_trip?.status ?? 'PASS', 'PASS');

  const { artifact } = await service.getArtifact(OWNER, result.artifact_id);
  assert.equal(artifact.mml, result.mml);
  assert.equal(artifact.candidate_id, run.candidateId);
  assert.equal(artifact.project_id, run.projectId);
  assert.equal(artifact.baseline_id, run.intake.baseline.baseline_id);
  assert.match(artifact.canonical.rules_snapshot_sha, /^[0-9a-f]{40}$/);
  assert.ok(artifact.readiness_summary.candidate_ready);
  assert.match(artifact.acceptance_notice, /never implies IN_GAME_ACCEPTED/);
});

// ─── gate separation ────────────────────────────────────────────────────────

test('a technical PASS never produces a source, audio, player or in-game PASS', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const result = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: {
      source_complete: { value: true, reason: 'Complete.' },
      original_audio_required: { value: false, reason: 'No recording exists.' },
      mobile_adaptation_reviewed: { value: true, reason: 'Gate 8 reviewed.', evidence: ['fixture Gate 8 review'] },
      regression_reviewed: fullConfirmations.regression_reviewed,
      // Player readback deliberately not confirmed.
    },
  });

  // Player readback is a required pre-emission gate, so nothing is emitted and
  // the technical axis cannot be claimed either.
  assert.equal(result.operation, 'blocked');
  assert.ok(result.blockers.includes('playerReadback'));
  assert.notEqual(result.gates.technical, 'PASS');

  const passing = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: fullConfirmations });
  assert.equal(passing.gates.technical, 'PASS');
  // Gate 8 is a separate evidence-backed review. Serialization cannot set it,
  // but the explicit confirmation above can.
  assert.equal(passing.gates.mobile_adaptation, 'PASS');
  assert.equal(passing.gates.in_game, 'PENDING');
  assert.equal(passing.gates.audio, 'N/A', 'audio was explicitly marked not applicable, not passed');

  const { artifact } = await service.getArtifact(OWNER, passing.artifact_id);
  assert.equal(artifact.gates.in_game, 'PENDING', 'a stored artifact must not record an acceptance nobody gave');
  assert.ok(artifact.remaining_pending_gates.includes('in_game'));
});

test('Gate 8 blocks Final until an evidence-backed candidate review is recorded', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const withoutAdaptation = {
    source_complete: fullConfirmations.source_complete,
    player_readback: fullConfirmations.player_readback,
    regression_reviewed: fullConfirmations.regression_reviewed,
    original_audio_required: fullConfirmations.original_audio_required,
  };
  const blocked = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: withoutAdaptation,
  });
  assert.equal(blocked.operation, 'blocked');
  assert.equal(blocked.gates.mobile_adaptation, 'PENDING');
  assert.ok(blocked.blockers.includes('mobileAdaptation'));
  assert.equal(blocked.mml, null);
  assert.equal(blocked.artifact_id, null);

  await rejects(service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: {
      mobile_adaptation_reviewed: { value: true, reason: 'Claimed reviewed, but no evidence was supplied.' },
    },
  }), ERROR_CODES.INVALID_REQUEST);

  const passed = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: fullConfirmations,
  });
  assert.equal(passed.operation, 'succeeded');
  assert.equal(passed.gates.mobile_adaptation, 'PASS');
});

test('Gate 9 blocks Final until an evidence-backed candidate regression review is recorded', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const withoutRegression = {
    source_complete: fullConfirmations.source_complete,
    player_readback: fullConfirmations.player_readback,
    mobile_adaptation_reviewed: fullConfirmations.mobile_adaptation_reviewed,
    original_audio_required: fullConfirmations.original_audio_required,
  };
  const blocked = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: withoutRegression,
  });
  assert.equal(blocked.operation, 'blocked');
  assert.equal(blocked.gates.regression, 'PENDING');
  assert.ok(blocked.blockers.includes('regression'));
  assert.equal(blocked.mml, null);
  assert.equal(blocked.artifact_id, null);

  await rejects(service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: {
      regression_reviewed: { value: true, reason: 'Claimed reviewed, but no evidence was supplied.' },
    },
  }), ERROR_CODES.INVALID_REQUEST);

  const passed = await service.finalize(OWNER, run.projectId, {
    candidateId: run.candidateId,
    confirmations: fullConfirmations,
  });
  assert.equal(passed.operation, 'succeeded');
  assert.equal(passed.gates.regression, 'PASS');
});

test('operation status and Canonical gates are separate fields', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const blocked = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId });
  // The call worked; the song is not ready. Both facts are visible, and neither
  // is expressible as a single `success` boolean.
  assert.equal(blocked.job.status, 'succeeded');
  assert.equal(blocked.operation, 'blocked');
  assert.ok(!Object.hasOwn(blocked, 'success'));
  assert.equal(typeof blocked.gates, 'object');
});

// ─── Technical Timing Repair ────────────────────────────────────────────────

test('Technical Timing Repair stays an explicit opt-in with no automatic mode', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);

  const off = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: fullConfirmations });
  assert.equal(off.technical_timing_repair.requested, false);
  assert.equal(off.technical_timing_repair.applied, false);

  const on = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, technicalTimingRepair: true });
  assert.equal(on.technical_timing_repair.requested, true);

  // 'auto' would change what an existing finalize call means, so it is refused
  // rather than interpreted.
  for (const value of ['auto', 'on', 1, null]) {
    await rejects(service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, technicalTimingRepair: value }), ERROR_CODES.INVALID_REQUEST);
  }
});

// ─── candidate lineage ──────────────────────────────────────────────────────

test('a second revision chains onto the candidate it was reviewed against', async () => {
  const service = app();
  const project = sixRoleBaseline();
  const run = await applyKeepOnlyCandidate(service, OWNER);

  const second = await service.applyDecisions(OWNER, run.projectId, {
    parentCandidateId: run.candidateId,
    decisions: [{
      id: 'omit:chord5',
      type: 'OMIT_FROM_SIX',
      target: { eventIds: project.events.filter(event => event.role === 'Chord5').map(event => event.id) },
      fromRole: 'Chord5',
      reason: 'Chord5 doubles Chord4 an octave down and adds no source-supported function.',
      evidence: ['reviewer listening note'],
      acceptedBy: 'reviewer:test',
    }],
  });

  assert.equal(second.decisions.applied, true);
  assert.equal(second.decisions.revision_index, 2);
  assert.equal(second.decisions.parent_candidate_id, run.candidateId);
  assert.notEqual(second.decisions.candidate_id, run.candidateId);

  const { review } = await service.reviewCandidate(OWNER, run.projectId, { candidateId: second.decisions.candidate_id });
  assert.equal(review.parent_candidate_id, run.candidateId);
  assert.equal(review.integrity.ok, true);
});

test('an unknown candidate is refused rather than silently ignored', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  for (const bad of [`g11d:rev:${'0'.repeat(64)}`, 'not-a-candidate', '../../etc/passwd']) {
    await rejects(service.reviewCandidate(OWNER, run.projectId, { candidateId: bad }), ERROR_CODES.CANDIDATE_NOT_FOUND);
    await rejects(service.finalize(OWNER, run.projectId, { candidateId: bad }), ERROR_CODES.CANDIDATE_NOT_FOUND);
  }
});

test('a candidate from another project is not reachable', async () => {
  const service = app();
  const mine = await applyKeepOnlyCandidate(service, OWNER, { title: 'Mine' });
  const other = (await service.createProject(OWNER, { title: 'Other' })).project;
  await service.uploadAsset(OWNER, other.project_id, {
    kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(),
  });
  await service.analyzeSources(OWNER, other.project_id);
  await rejects(service.reviewCandidate(OWNER, other.project_id, { candidateId: mine.candidateId }), ERROR_CODES.CANDIDATE_NOT_FOUND);
});

test('a new intake invalidates candidates derived from the old baseline', async () => {
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  assert.equal((await service.getProject(OWNER, run.projectId)).project.candidates.length, 1);

  await service.uploadAsset(OWNER, run.projectId, {
    kind: 'official_midi', filename: 'another.mid', mediaType: 'audio/midi', bytes: sixSourceVoices(),
  });
  await service.analyzeSources(OWNER, run.projectId);

  const after = (await service.getProject(OWNER, run.projectId)).project;
  assert.deepEqual(after.candidates, [], 'a candidate describes sources that are no longer the project’s');
  await rejects(service.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId }), ERROR_CODES.CANDIDATE_NOT_FOUND);
});

// ─── the emitter and the parser are two independent facts ───────────────────

test('an emitter PASS that the Final parser contradicts delivers nothing', async () => {
  // The dangerous shape. The emitter serialized the candidate and reported
  // PASS; the authoritative Final parser then read the emitted string back and
  // disagreed. Technical is a required Canonical gate in its own right, and an
  // emitter's opinion of its own output is not that gate's answer.
  //
  // Only `mml/parser.mjs` is replaced, and only its validate entry point. Every
  // other engine — intake, arrangement, arbitration, readiness, the Final
  // emitter itself — is the real module, so what is exercised here is the real
  // pipeline reaching a real emitter PASS.
  const engines = await createStudioApplication({}).canonical.engines();
  const failingValidation = {
    ok: false,
    errors: [{ code: 'ROUNDTRIP_MISMATCH', message: 'the emitted MML did not read back to the same semantics' }],
    warnings: [],
    song: null,
  };
  const service = createStudioApplication({
    loadEngines: async () => ({ ...engines, mml: { ...engines.mml, validateMML: () => failingValidation } }),
  });

  const run = await applyKeepOnlyCandidate(service, OWNER);
  const result = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: fullConfirmations });

  // The emitter really did pass — that is the whole point of the case.
  assert.equal(result.emit_status, 'PASS');

  // Nothing is delivered.
  assert.notEqual(result.operation, 'succeeded');
  assert.equal(result.operation, 'blocked');
  assert.equal(result.code, ERROR_CODES.FINALIZATION_BLOCKED);
  assert.equal(result.artifact_id, null, 'no artifact may be filed for a Final that did not pass');
  assert.equal(result.mml, null, 'the emitted string must not be handed to a caller');

  // The contradiction is visible rather than resolved in the emitter's favour.
  assert.equal(result.gates.technical, 'FAIL');
  assert.ok(result.blockers.includes('technical'), 'technical must appear as a blocker after emission');
  assert.equal(result.technical_validation.run, true);
  assert.equal(result.technical_validation.ok, false);
  assert.equal(result.readiness.candidateReady, false);

  // Nothing leaked into the project, and nothing is retrievable as a Final.
  const project = (await service.getProject(OWNER, run.projectId)).project;
  assert.deepEqual([...project.artifacts], [], 'a blocked Final must add no artifact to the project');
  await rejects(service.getArtifact(OWNER, `art_${'0'.repeat(64)}`), ERROR_CODES.ARTIFACT_NOT_FOUND);

  // The orchestration itself ran to completion: a blocked song is an answer,
  // not a crashed job.
  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.job.result_artifact_id, null);

  // And none of this touches the axis no implementation may set.
  assert.equal(result.gates.in_game, 'PENDING');
});

test('an emitter PASS the Final parser confirms still delivers a Final artifact', async () => {
  // The other half: the normal path is unchanged by the block above, and the
  // artifact it files still records the readiness that actually graded it.
  const service = app();
  const run = await applyKeepOnlyCandidate(service, OWNER);
  const result = await service.finalize(OWNER, run.projectId, { candidateId: run.candidateId, confirmations: fullConfirmations });

  assert.equal(result.emit_status, 'PASS');
  assert.equal(result.operation, 'succeeded');
  assert.equal(result.code, null);
  assert.match(result.artifact_id, /^art_[0-9a-f]{64}$/);
  assert.ok(result.mml.length > 0);
  assert.equal(result.gates.technical, 'PASS');
  assert.ok(!result.blockers.includes('technical'));
  assert.equal(result.technical_validation.run, true);
  assert.equal(result.technical_validation.ok, true);

  const { artifact } = await service.getArtifact(OWNER, result.artifact_id);
  assert.equal(artifact.mml, result.mml);
  assert.equal(artifact.readiness_summary.technical_validation.ok, true);
  assert.equal(artifact.gates.in_game, 'PENDING');
});
