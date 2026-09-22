// Synthetic API/MCP integration, not real-client conversation or listening E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { AUDIO_REVISION_SCHEMA } from '../studio/backend/application/audio-report-history.mjs';
import { applyKeepOnlyCandidate, audioAlignmentReport } from '../studio/tests/fixtures/application-fixtures.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';

const OWNER = 'owner:service';
const ORIGIN = 'https://mml.example';
async function fixture(app = createStudioApplication()) {
  const f = await applyKeepOnlyCandidate(app, OWNER);
  // Deliberately synthetic bytes: attachment tests do not invoke the worker.
  const audio = (await app.uploadAsset(OWNER, f.projectId, {
    kind: 'original_audio', filename: 'synthetic.wav', mediaType: 'audio/wav', bytes: new Uint8Array([0, 1, 2, 3]),
  })).asset;
  const report = audioAlignmentReport({ id: `${f.project.id}#g11d-r1` }, { sha256: audio.sha256, confidence: .45 });
  return { ...f, app, report };
}
const revision = (report, expected, confidence = .50) => ({
  schema: AUDIO_REVISION_SCHEMA, expected_previous_report_sha256: expected,
  reason: 'Synthetic revised diagnostic; not musical acceptance.', submitted_by: 'agent:fixture',
  report: { ...structuredClone(report), alignment: { ...structuredClone(report.alignment), metrics: { ...report.alignment.metrics, confidence } } },
});
async function review(f) { return (await f.app.reviewCandidate(OWNER, f.projectId, { candidateId: f.candidateId })).review; }
async function attach(f, report) { return f.app.attachAudioAlignment(OWNER, f.projectId, { candidateId: f.candidateId, report }); }

test('real service retains warning history and recomputes rather than promotes pending audio', async () => {
  const f = await fixture(); const first = await attach(f, f.report);
  const second = await attach(f, revision(f.report, first.report_sha256));
  const result = await review(f);
  assert.equal(result.audio.reports, 1);
  assert.equal(result.audio.history.entries.length, 2);
  assert.deepEqual(result.audio.history.entries[0].report, f.report);
  assert.deepEqual(result.audio.history.entries.map(e => e.active), [false, true]);
  assert.ok(result.audio.history.entries.every(e => e.warnings.includes('LOW_ALIGNMENT_CONFIDENCE')));
  assert.equal(result.gates.audio, 'PENDING'); assert.equal(result.gates.in_game, 'PENDING');
  assert.equal(result.integrity.ok, true);
  assert.equal(result.audio.evidence[1].authenticated_owner, OWNER);
  assert.equal(result.audio.evidence[1].submitted_by, 'agent:fixture');
  assert.equal(second.evidence.active, true);
  assert.equal((await f.app.getProject(OWNER, f.projectId)).project.candidates.length, 1);
  assert.deepEqual(result.confirmations, {});
});
test('a lower-quality revision reopens the existing audio gate; final still blocks', async () => {
  const f = await fixture();
  const initial = revision(f.report, 'f'.repeat(64), .9).report;
  const first = await attach(f, initial);
  assert.equal((await review(f)).gates.audio, 'PASS');
  await attach(f, revision(f.report, first.report_sha256, .4));
  assert.equal((await review(f)).gates.audio, 'PENDING');
  const final = await f.app.finalize(OWNER, f.projectId, { candidateId: f.candidateId });
  assert.equal(final.operation, 'blocked');
  assert.equal((await f.app.getProject(OWNER, f.projectId)).project.artifacts.length, 0);
});
test('stale concurrent replacement is refused and exact retry adds no revision', async () => {
  const f = await fixture(); const first = await attach(f, f.report);
  const input = revision(f.report, first.report_sha256);
  const outcomes = await Promise.allSettled([attach(f, input), attach(f, revision(f.report, first.report_sha256, .51))]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  const winner = outcomes[0].status === 'fulfilled' ? input : revision(f.report, first.report_sha256, .51);
  const replay = await attach(f, winner);
  assert.equal(replay.replayed, true);
  assert.equal((await review(f)).audio.history.entries.length, 2);
});
test('wrong owner, missing source and malformed revision cannot change active evidence', async () => {
  const f = await fixture(); const first = await attach(f, f.report);
  const input = revision(f.report, first.report_sha256);
  await assert.rejects(f.app.attachAudioAlignment('owner:other', f.projectId, { candidateId: f.candidateId, report: input }), /Unknown project/);
  await assert.rejects(attach(f, { ...input, pass: true }), /unknown revision field/);
  const otherAudio = structuredClone(input); otherAudio.report.audio.sha256 = 'f'.repeat(64);
  await assert.rejects(attach(f, otherAudio), /original_audio asset/);
  const badProject = structuredClone(input); badProject.report.symbolic.project_id = 'wrong';
  await assert.rejects(attach(f, badProject), /does not match/);
  assert.equal((await review(f)).audio.history.entries.length, 1);
});
test('reviewed candidates require coordinated invalidation, not silently retained approval', async () => {
  const f = await fixture(); const first = await attach(f, f.report);
  await f.app.recordConfirmations(OWNER, f.projectId, {
    core3_completeness_reviewed: { value: true, reason: 'Synthetic Gate 4 test review.', evidence: ['fixture:review'], candidate_id: f.candidateId },
  });
  await assert.rejects(attach(f, revision(f.report, first.report_sha256)), /coordinated invalidation/);
  assert.equal((await review(f)).audio.history.entries.length, 1);
});
test('durable restart exports the exact raw reports and keeps the explicit active head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-audio-history-'));
  try {
    const f = await fixture(createStudioApplication({ dataDirectory: directory, durability: 'persistent' }));
    const first = await attach(f, f.report);
    await attach(f, revision(f.report, first.report_sha256));
    const before = (await review(f)).audio.history;
    f.app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    assert.deepEqual((await review(f)).audio.history, before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('HTTP and MCP use the same revision contract; paged MCP exports raw history without writing', async () => {
  const f = await fixture();
  const route = createApiRouter({ application: f.app, ownerOf: () => OWNER });
  const response = await route(new Request(`${ORIGIN}${API_PREFIX}/projects/${f.projectId}/audio-alignment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidate_id: f.candidateId, report: f.report }),
  }), { authenticated: true });
  assert.equal(response.status, 200);
  const first = await response.json();
  const rpc = async (name, args) => {
    const response = await handleMcp(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), { application: f.app, owner: OWNER });
    const payload = await response.json();
    assert.equal(payload.result.isError, false, JSON.stringify(payload));
    return payload.result.structuredContent;
  };
  const revised = await rpc('studio_audio_alignment', {
    project_id: f.projectId, candidate_id: f.candidateId, report: revision(f.report, first.report_sha256),
  });
  assert.equal(revised.operation, 'succeeded');
  const projectBefore = (await f.app.getProject(OWNER, f.projectId)).project;
  let offset = 0; let hash; let text = '';
  do {
    const result = await rpc('studio_candidate_review', {
      project_id: f.projectId, candidate_id: f.candidateId,
      report_page: { path: ['review', 'audio', 'history'], offset, length: 512, ...(hash ? { expected_sha256: hash } : {}) },
    });
    hash ??= result.report_page.report_sha256;
    assert.equal(result.report_page.report_sha256, hash);
    text += result.report_page.json_fragment;
    offset = result.report_page.next_offset;
  } while (offset !== null);
  const history = JSON.parse(text);
  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.entries[0].report, f.report);
  assert.equal(history.entries[1].active, true);
  assert.deepEqual((await f.app.getProject(OWNER, f.projectId)).project, projectBefore);
});
