// Synthetic audit-chain regression, not listening or conversation E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { AUDIO_REVISION_SCHEMA } from '../studio/backend/application/audio-report-history.mjs';
import { applyKeepOnlyCandidate, audioAlignmentReport } from '../studio/tests/fixtures/application-fixtures.mjs';

test('authenticated owner and declared author survive receipt, history and summary independently', async t => {
  const owner = 'owner:service';
  const app = createStudioApplication();
  const f = await applyKeepOnlyCandidate(app, owner);
  const asset = (await app.uploadAsset(owner, f.projectId, {
    kind: 'original_audio', filename: 'synthetic.wav', mediaType: 'audio/wav', bytes: new Uint8Array([0, 1, 2, 3]),
  })).asset;
  const report = audioAlignmentReport({ id: `${f.project.id}#g11d-r1` }, { sha256: asset.sha256, confidence: .45 });
  const first = await app.attachAudioAlignment(owner, f.projectId, { candidateId: f.candidateId, report });
  const revised = structuredClone(report); revised.alignment.metrics.confidence = .50;
  const second = await app.attachAudioAlignment(owner, f.projectId, {
    candidateId: f.candidateId, report: { schema: AUDIO_REVISION_SCHEMA,
      expected_previous_report_sha256: first.report_sha256, reason: 'Synthetic diagnostic revision', submitted_by: 'agent:fixture', report: revised },
  });
  const { review } = await app.reviewCandidate(owner, f.projectId, { candidateId: f.candidateId });
  const rows = { receipt: second.evidence,
    history: { ...review.audio.history.entries[1], report: undefined }, summary: review.audio.evidence[1] };
  t.diagnostic(`Synthetic audit fields: ${JSON.stringify(rows)}`);
  for (const [kind, entry] of Object.entries(rows)) {
    assert.equal(entry.authenticated_owner, owner, `${kind} authenticated owner`);
    assert.equal(entry.submitted_by, 'agent:fixture', `${kind} declared author`);
  }
});
