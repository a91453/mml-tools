// Studio Application Service — a candidate's confirmations are its own.
//
// Candidate-scoped confirmations (version drift, player readback, Gate 8, Gate
// 9, Gate 4 completeness, Gate 7 review) were stored in one map keyed by name
// alone. Recording one for candidate B therefore replaced candidate A's entry
// of the same kind -- its reason, evidence and time -- and A's next review read
// B's entry as a CANDIDATE_MISMATCH stale confirmation and fell back to
// PENDING. The module promises a non-matching confirmation is kept for the
// audit trail and reported as stale; A's own statement was destroyed instead.
//
// Candidate-scoped confirmations are now stored per candidate
// (`candidate_confirmations[candidateId][name]`), the way Core3 approvals and
// Lead evidence reviews already are. Baseline-scoped ones stay one statement
// per project. A record written in the old shape still reads: a legacy entry
// counts for the candidate it names, is stale for any other, and is replaced
// only by a new statement about that same candidate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication } from '../backend/application/index.mjs';
import { canonicalProjectBytes, sixRoleBaseline } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';

async function withDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'mml-confirmations-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

const keep = (id, eventId, reason) => ({ id, type: 'KEEP', target: { eventIds: [eventId] }, reason, evidence: [`fixture#${eventId}`], acceptedBy: 'reviewer:test' });

/** A project with two sibling KEEP candidates, A and B. */
async function siblings(service) {
  const { project } = await service.createProject(OWNER, { title: 'sibling candidates' });
  const projectId = project.project_id;
  await service.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(sixRoleBaseline()) });
  const baselineId = (await service.analyzeSources(OWNER, projectId)).baseline.baseline_id;
  const A = (await service.applyDecisions(OWNER, projectId, { decisions: [keep('k:a', 'chord3-1', 'Keep A.')] })).decisions.candidate_id;
  const B = (await service.applyDecisions(OWNER, projectId, { decisions: [keep('k:b', 'chord2-1', 'Keep B.')] })).decisions.candidate_id;
  assert.ok(A && B && A !== B);
  return { projectId, baselineId, A, B };
}

// The candidate-scoped kinds this regression records, stated per candidate so
// each candidate's own entry can be told apart from the other's.
const reviewedBy = label => ({
  regression_reviewed: { value: true, reason: `${label}: compared against the baseline.`, evidence: [`${label} diff report`] },
  mobile_adaptation_reviewed: { value: true, reason: `${label}: Gate 8 reviewed.`, evidence: [`${label} Gate 8 notes`] },
  version_drift_reviewed: { value: true, reason: `${label}: drift reviewed.` },
  player_readback: { value: 'N/A', reason: `${label}: no preview assets are used for this cue.` },
});
const CANDIDATE_KINDS = Object.keys(reviewedBy('x'));

const review = async (service, projectId, candidateId, confirmations = null) => (await service.reviewCandidate(OWNER, projectId, { candidateId, confirmations })).review;

async function storedRecord(directory) {
  const records = join(directory, 'records');
  const [name] = await readdir(records);
  const path = join(records, name);
  return { path, record: JSON.parse(await readFile(path, 'utf8')) };
}

// ─── 1. the reproduction ────────────────────────────────────────────────────

test('recording a candidate-scoped confirmation for one candidate keeps another candidate\'s', async () => {
  const service = createStudioApplication();
  const { projectId, A, B } = await siblings(service);

  const first = await review(service, projectId, A, { ...reviewedBy('A'), source_complete: { value: true, reason: 'The fixture is the complete material.' } });
  assert.equal(first.gates.regression, 'PASS');
  assert.equal(first.gates.mobile_adaptation, 'PASS');

  const second = await review(service, projectId, B, reviewedBy('B'));
  assert.equal(second.gates.regression, 'PASS');
  assert.equal(second.gates.mobile_adaptation, 'PASS');

  // A again, recording nothing. Its own statements still stand, word for word.
  const again = await review(service, projectId, A);
  assert.equal(again.gates.regression, 'PASS');
  assert.equal(again.gates.mobile_adaptation, 'PASS');
  assert.equal(again.gates.player_readback, 'N/A');
  assert.equal(again.readiness.gates.versionDrift.status, first.readiness.gates.versionDrift.status);
  for (const name of CANDIDATE_KINDS) {
    assert.equal(again.confirmations[name].candidate_id, A, name);
    assert.equal(again.confirmations[name].reason, first.confirmations[name].reason, name);
    assert.deepEqual(again.confirmations[name].evidence, first.confirmations[name].evidence, name);
    assert.equal(again.confirmations[name].at, first.confirmations[name].at, name);
  }
  // B's statements are on record for B, and reported here as what they are.
  for (const name of CANDIDATE_KINDS) {
    assert.ok(again.stale_confirmations.some(entry => entry.name === name && entry.reason === 'CANDIDATE_MISMATCH' && entry.bound_candidate_id === B), name);
  }
  assert.equal(again.stale_confirmations.some(entry => entry.bound_candidate_id === A), false, 'none of A\'s own statements is stale for A');

  // And B still reads B's, with A's reported stale.
  const other = await review(service, projectId, B);
  for (const name of CANDIDATE_KINDS) {
    assert.equal(other.confirmations[name].candidate_id, B, name);
    assert.equal(other.confirmations[name].reason, second.confirmations[name].reason, name);
    assert.ok(other.stale_confirmations.some(entry => entry.name === name && entry.reason === 'CANDIDATE_MISMATCH' && entry.bound_candidate_id === A), name);
  }

  // Baseline-scoped confirmations are one statement per project, as before:
  // recorded through A's review, they hold for B, and a new one replaces it.
  assert.equal(other.confirmations.source_complete.value, true);
  assert.equal(other.confirmations.source_complete.candidate_id, null);
  await review(service, projectId, B, { source_complete: { value: true, reason: 'Re-confirmed through B.' } });
  const baselineStatement = (await review(service, projectId, A)).confirmations.source_complete;
  assert.equal(baselineStatement.reason, 'Re-confirmed through B.');
  assert.equal((await review(service, projectId, A)).stale_confirmations.some(entry => entry.name === 'source_complete'), false);
});

// ─── 2. records written in the old shape ────────────────────────────────────

test('a stored record in the single-map shape still counts for its candidate and is never dropped by another candidate\'s review', async () => withDirectory(async directory => {
  const open = () => createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const { projectId, baselineId, A, B } = await siblings(open());

  // Written the way an earlier build stored every confirmation: one map, keyed
  // by name, the candidate-scoped entries carrying the candidate they name.
  const { path, record } = await storedRecord(directory);
  assert.equal(Object.hasOwn(record, 'candidate_confirmations'), false, 'a record that never held one is not reshaped');
  const legacy = {
    regression_reviewed: { value: true, reason: 'Legacy: A compared against the baseline.', evidence: ['legacy diff report'], at: '2026-09-01T00:00:00.000Z', baseline_id: baselineId, candidate_id: A },
    player_readback: { value: 'N/A', reason: 'Legacy: no preview assets for A.', evidence: [], at: '2026-09-01T00:00:00.000Z', baseline_id: baselineId, candidate_id: A },
    source_complete: { value: true, reason: 'Legacy: complete material.', evidence: [], at: '2026-09-01T00:00:00.000Z', baseline_id: baselineId, candidate_id: null },
  };
  await writeFile(path, JSON.stringify({ ...record, confirmations: legacy }));

  // Restored: the legacy entries count for A and are stale for B.
  let service = open();
  let forA = await review(service, projectId, A);
  assert.equal(forA.gates.regression, 'PASS');
  assert.equal(forA.confirmations.regression_reviewed.reason, legacy.regression_reviewed.reason);
  assert.equal(forA.gates.player_readback, 'N/A');
  assert.equal(forA.confirmations.source_complete.reason, legacy.source_complete.reason);
  let forB = await review(service, projectId, B);
  assert.equal(forB.gates.regression, 'PENDING');
  assert.ok(forB.stale_confirmations.some(entry => entry.name === 'regression_reviewed' && entry.reason === 'CANDIDATE_MISMATCH' && entry.bound_candidate_id === A));
  assert.equal(forB.confirmations.source_complete.reason, legacy.source_complete.reason);

  // B's own review, recorded on its own. The response keeps its name-keyed shape.
  const recorded = await service.recordConfirmations(OWNER, projectId, {
    regression_reviewed: { value: true, reason: 'B compared against the baseline.', evidence: ['B diff report'], candidate_id: B },
  });
  assert.equal(recorded.confirmations.regression_reviewed.candidate_id, B);
  assert.equal(recorded.confirmations.source_complete.reason, legacy.source_complete.reason);

  // A's legacy statement survives B's review, and still counts for A.
  service = open();
  forA = await review(service, projectId, A);
  assert.equal(forA.gates.regression, 'PASS');
  assert.equal(forA.confirmations.regression_reviewed.reason, legacy.regression_reviewed.reason);
  assert.ok(forA.stale_confirmations.some(entry => entry.name === 'regression_reviewed' && entry.bound_candidate_id === B));
  forB = await review(service, projectId, B);
  assert.equal(forB.gates.regression, 'PASS');
  assert.equal(forB.confirmations.regression_reviewed.reason, 'B compared against the baseline.');
  assert.ok(forB.stale_confirmations.some(entry => entry.name === 'regression_reviewed' && entry.bound_candidate_id === A));
  let stored = (await storedRecord(directory)).record;
  assert.deepEqual(stored.confirmations.regression_reviewed, legacy.regression_reviewed, 'the legacy entry is kept as it was');
  assert.deepEqual(stored.confirmations.player_readback, legacy.player_readback);
  assert.equal(stored.candidate_confirmations[B].regression_reviewed.reason, 'B compared against the baseline.');

  // A new statement about A replaces A's legacy one of that kind -- as a
  // re-record always did -- and nothing else.
  await review(service, projectId, A, { regression_reviewed: { value: true, reason: 'A re-reviewed.', evidence: ['A diff report v2'] } });
  stored = (await storedRecord(directory)).record;
  assert.equal(Object.hasOwn(stored.confirmations, 'regression_reviewed'), false);
  assert.equal(stored.candidate_confirmations[A].regression_reviewed.reason, 'A re-reviewed.');
  assert.deepEqual(stored.confirmations.player_readback, legacy.player_readback, 'another kind is untouched');
  assert.equal(stored.candidate_confirmations[B].regression_reviewed.reason, 'B compared against the baseline.');
  forA = await review(open(), projectId, A);
  assert.equal(forA.confirmations.regression_reviewed.reason, 'A re-reviewed.');
  assert.equal(forA.stale_confirmations.some(entry => entry.bound_candidate_id === A), false);
}));

test('a restored record that holds a statement about a candidate in both shapes counts the per-candidate one and reports the other', async () => withDirectory(async directory => {
  const open = () => createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
  const { projectId, baselineId, A, B } = await siblings(open());
  const entry = (reason, candidateId) => ({ value: true, reason, evidence: ['notes'], at: '2026-09-01T00:00:00.000Z', baseline_id: baselineId, candidate_id: candidateId });
  const { path, record } = await storedRecord(directory);
  await writeFile(path, JSON.stringify({
    ...record,
    confirmations: { regression_reviewed: entry('Legacy statement about A.', A) },
    candidate_confirmations: {
      [A]: {
        regression_reviewed: entry('Per-candidate statement about A.', A),
        // Filed under A but naming B: bound to nothing provable, so it counts
        // for neither.
        mobile_adaptation_reviewed: entry('Misfiled statement naming B.', B),
      },
    },
  }));

  const forA = await review(open(), projectId, A);
  assert.equal(forA.confirmations.regression_reviewed.reason, 'Per-candidate statement about A.');
  assert.ok(forA.stale_confirmations.some(item => item.name === 'regression_reviewed' && item.reason === 'SUPERSEDED' && item.bound_candidate_id === A));
  assert.equal(forA.confirmations.mobile_adaptation_reviewed, undefined);
  const forB = await review(open(), projectId, B);
  assert.equal(forB.gates.mobile_adaptation, 'PENDING', 'a misfiled statement counts for nobody');
  assert.ok(forB.stale_confirmations.some(item => item.name === 'mobile_adaptation_reviewed' && item.reason === 'CANDIDATE_MISMATCH'));
}));
