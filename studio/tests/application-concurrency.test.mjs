// Studio Application Service — concurrency regressions.
//
// The service runs in one Node process, but its operations await the
// Canonical engines and the stored baseline before they write the project
// record back. Two overlapping writes to one project must not lose each
// other's entries: a candidate that was applied and answered `applied: true`
// has to be there afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication } from '../backend/application/index.mjs';
import { audioAlignmentReport, canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';

async function prepared() {
  const service = createStudioApplication({});
  const project = (await service.createProject(OWNER, { title: 'Concurrent' })).project;
  await service.uploadAsset(OWNER, project.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes() });
  await service.analyzeSources(OWNER, project.project_id);
  await service.suggestArrangement(OWNER, project.project_id);
  return { service, projectId: project.project_id };
}

test('concurrent decision applications on one project keep every applied candidate', async () => {
  const { service, projectId } = await prepared();
  const results = await Promise.all(['reviewer-a', 'reviewer-b', 'reviewer-c'].map(acceptedBy =>
    service.applyDecisions(OWNER, projectId, { decisions: keepEveryRole(sixRoleBaseline(), { acceptedBy }) })));
  const ids = results.map(result => result.decisions.candidate_id);
  assert.deepEqual(results.map(result => result.decisions.applied), [true, true, true]);
  assert.equal(new Set(ids).size, 3, 'each acceptance mints its own revision');

  const listed = (await service.getProject(OWNER, projectId)).project.candidates.map(candidate => candidate.candidate_id);
  for (const id of ids) {
    assert.ok(listed.includes(id), `candidate ${id} answered applied but is not listed`);
    const review = await service.reviewCandidate(OWNER, projectId, { candidateId: id });
    assert.equal(review.review.integrity.ok, true);
  }
});

test('concurrent audio evidence attachments keep the duplicate check honest', async () => {
  const { service, projectId } = await prepared();
  const candidateId = (await service.applyDecisions(OWNER, projectId, { decisions: keepEveryRole(sixRoleBaseline()) })).decisions.candidate_id;
  const candidate = (await service.reviewCandidate(OWNER, projectId, { candidateId })).review;
  assert.ok(candidate);
  // The report must name the candidate project exactly as the Canonical
  // audio engine identifies it: the baseline id with the G11-D revision.
  const report = audioAlignmentReport({ id: `${sixRoleBaseline().id}#g11d-r1` });
  const outcomes = await Promise.allSettled([
    service.attachAudioAlignment(OWNER, projectId, { candidateId, report }),
    service.attachAudioAlignment(OWNER, projectId, { candidateId, report }),
  ]);
  const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'the same recording attaches once');
  const evidence = (await service.getProject(OWNER, projectId)).project.audio_evidence.filter(entry => entry.candidate_id === candidateId);
  assert.equal(evidence.length, 1);
});
