// Deterministic persistence fault injection. Engine functions here are test
// doubles, not musical validation and not real-client E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../backend/application/review-service.mjs';
import { AUDIO_REVISION_SCHEMA, audioReportHash, readAudioHistory } from '../backend/application/audio-report-history.mjs';

const owner = 'owner:fixture';
const projectId = 'prj_' + '1'.repeat(32);
const candidateId = 'g11d:rev:' + '2'.repeat(64);
const audioSha = '3'.repeat(64);
const rules = '4'.repeat(40);
const key = `audio:${projectId}:${candidateId}`;
const raw = confidence => ({
  schema: 'mabinogi-mobile-mml-studio/audio-alignment@1',
  audio: { sha256: audioSha }, symbolic: { project_id: 'fixture-symbolic' },
  alignment: { metrics: { confidence, score_frame_coverage: .8, audio_frame_coverage: .8 },
    control_points: [{ beat: 0, seconds: 0 }, { beat: 4, seconds: 2 }] },
  evidence_policy: { changes_symbolic_truth: false },
});
function fixture() {
  let record = { project_id: projectId, owner, assets: [{ kind: 'original_audio', sha256: audioSha }],
    candidates: [{ candidate_id: candidateId }], audio_evidence: [], confirmations: {}, artifacts: [] };
  const data = new Map();
  const faults = { store: false, projection: false, lineage: false, staleRules: false };
  const store = {
    getJson: id => data.has(id) ? structuredClone(data.get(id)) : null,
    putJson: (id, body) => {
      if (faults.store) { faults.store = false; throw Error('injected atomic store failure'); }
      data.set(id, structuredClone(body));
    },
  };
  const projects = {
    load: (subject, id) => {
      if (subject !== owner || id !== projectId) throw Error('Unknown project');
      return structuredClone(record);
    },
    save: value => {
      if (faults.projection) { faults.projection = false; throw Error('injected projection failure'); }
      record = structuredClone(value);
    },
  };
  const deps = {
    store, projects, intake: {},
    arrangement: {
      loadCandidate: (_record, id) => {
        if (id !== candidateId) throw Error('Unknown candidate');
        return { application: { candidate: { id: 'fixture-symbolic' },
          revision: { canonicalIdentity: { rules_snapshot_sha: faults.staleRules ? '5'.repeat(40) : rules } } } };
      },
      loadCandidateLineage: () => faults.lineage ? [{ decisions: [{ leadEvidence: { sourceIdentity: 'test' } }] }] : [],
    },
    canonical: { engines: async () => ({
      audio: { validateAudioAlignmentReport: report => ({ warnings: ['LOW_SCORE_FRAME_COVERAGE'], metrics: report.alignment.metrics }) },
      emitterContract: { canonicalIdentity: () => ({ rules_snapshot_sha: rules }) },
    }) },
  };
  const service = createReviewService(deps);
  const attach = report => service.attachAudioAlignment(owner, projectId, { candidateId, report });
  const revise = (previous, value = .50) => ({ schema: AUDIO_REVISION_SCHEMA,
    expected_previous_report_sha256: previous, reason: 'Synthetic recomputation', submitted_by: 'agent:fixture', report: raw(value) });
  return { data, faults, store, projects, attach, revise };
}

test('failed authoritative append leaves previous history and index unchanged', async () => {
  const f = fixture(); const first = await f.attach(raw(.4));
  const history = f.store.getJson(key); const record = f.projects.load(owner, projectId);
  f.faults.store = true;
  await assert.rejects(f.attach(f.revise(first.report_sha256)), /atomic store failure/);
  assert.deepEqual(f.store.getJson(key), history);
  assert.deepEqual(f.projects.load(owner, projectId), record);
});
test('interrupted projection is repaired by exact retry without another history entry', async () => {
  const f = fixture(); const first = await f.attach(raw(.4));
  const input = f.revise(first.report_sha256); f.faults.projection = true;
  await assert.rejects(f.attach(input), /projection failure/);
  const committed = f.store.getJson(key);
  assert.equal(committed.entries.length, 2);
  assert.equal(f.projects.load(owner, projectId).audio_evidence.length, 1);
  const retry = await f.attach(input);
  assert.equal(retry.replayed, true);
  assert.deepEqual(f.store.getJson(key), committed);
  assert.deepEqual(f.projects.load(owner, projectId).audio_evidence.map(e => e.active), [false, true]);
});
test('legacy attachment migrates losslessly on first explicit revision', async () => {
  const f = fixture(); const report = raw(.4); f.data.set(key, [report]);
  const record = f.projects.load(owner, projectId);
  record.audio_evidence = [{ candidate_id: candidateId, audio_sha256: audioSha, warnings: ['ORIGINAL_WARNING'], attached_at: '2026-09-01T00:00:00Z' }];
  f.projects.save(record);
  await f.attach(f.revise(audioReportHash(report)));
  const history = readAudioHistory(f.store.getJson(key), candidateId);
  assert.deepEqual(history.entries[0].report, report);
  assert.deepEqual(history.entries[0].warnings, ['ORIGINAL_WARNING']);
  assert.equal(history.entries[0].authenticated_owner, null);
  assert.equal(history.entries[0].attached_at, '2026-09-01T00:00:00Z');
});
test('old rules or lineage-bound Lead reviews block replacements before writing', async () => {
  const f = fixture(); const first = await f.attach(raw(.4)); const before = f.store.getJson(key);
  f.faults.staleRules = true;
  await assert.rejects(f.attach(f.revise(first.report_sha256)), /different rules snapshot/);
  f.faults.staleRules = false; f.faults.lineage = true;
  await assert.rejects(f.attach(f.revise(first.report_sha256)), /coordinated invalidation/);
  assert.deepEqual(f.store.getJson(key), before);
});
test('stored approvals and project artifacts are not silently invalidated', async () => {
  for (const kind of ['core3-approvals', 'lead-evidence-reviews', 'artifact']) {
    const f = fixture(); const first = await f.attach(raw(.4)); const before = f.store.getJson(key);
    if (kind === 'artifact') { const r = f.projects.load(owner, projectId); r.artifacts = [{ artifact_id: 'existing' }]; f.projects.save(r); }
    else f.data.set(`${kind}:${projectId}:${candidateId}`, [{ evidence: ['synthetic'] }]);
    await assert.rejects(f.attach(f.revise(first.report_sha256)), /coordinated invalidation/);
    assert.deepEqual(f.store.getJson(key), before);
  }
});
test('corrupt raw body cannot be concealed by a later replacement', async () => {
  const f = fixture(); const first = await f.attach(raw(.4));
  const history = f.store.getJson(key); history.entries[0].report.alignment.metrics.confidence = 1; f.data.set(key, history);
  await assert.rejects(f.attach(f.revise(first.report_sha256)), /corrupt report identity/);
  assert.deepEqual(f.store.getJson(key), history);
});
