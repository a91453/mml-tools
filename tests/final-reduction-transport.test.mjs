import test from 'node:test';
import assert from 'node:assert/strict';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { applyKeepOnlyCandidate, canonicalProjectBytes, keepEveryRole } from '../studio/tests/fixtures/application-fixtures.mjs';
import { baselineWithUnassignedRole } from '../studio/tests/fixtures/g12-fixtures.mjs';

const planPayload = (candidateId, extra = {}) => ({ candidate_id: candidateId, accepted_by: 'transport-test', ...extra });

async function reducibleProject(application, owner) {
  // A baseline whose Chord5 material carries no role, so the reduction has
  // something real to place rather than an empty plan.
  const project = baselineWithUnassignedRole();
  const created = (await application.createProject(owner, { title: 'Reduction transport' })).project;
  await application.uploadAsset(owner, created.project_id, { kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project) });
  await application.analyzeSources(owner, created.project_id);
  const applied = await application.applyDecisions(owner, created.project_id, { decisions: keepEveryRole(project).filter(decision => decision.fromRole !== 'Chord5') });
  return { project, projectId: created.project_id, candidateId: applied.decisions.candidate_id };
}

const REDISTRIBUTE = {
  id: 'place-chord5',
  action: 'REDISTRIBUTE',
  eventIds: ['chord5-1', 'chord5-2', 'chord5-3'],
  toRole: 'Chord5',
  reason: 'The source declares this lane as secondary bass reinforcement; it is placed in the one free enrichment role.',
  evidence: ['fixture:official-midi#Chord5'],
};

test('reduction preview/apply have HTTP/MCP parity and enforce owner isolation', async () => {
  const application = createStudioApplication(), owner = 'reduction-transport';
  const run = await reducibleProject(application, owner);
  const route = createApiRouter({ application, ownerOf: () => owner });
  const http = async (action, body, authenticated = true) => route(new Request(`https://mml.example${API_PREFIX}/projects/${run.projectId}/final-reduction/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { authenticated });
  const mcp = async (action, args, callOwner = owner) => {
    const response = await handleMcp(new Request('https://mml.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `studio_final_reduction_${action}`, arguments: { project_id: run.projectId, ...args } } }) }), { application, owner: callOwner });
    return (await response.json()).result;
  };

  const payload = planPayload(run.candidateId, { decisions: [REDISTRIBUTE] });
  const previewHttp = await (await http('plan', payload)).json();
  const previewMcp = await mcp('plan', payload);
  assert.equal(previewMcp.isError, false);
  assert.deepEqual(previewHttp.reduction, previewMcp.structuredContent.reduction);
  assert.equal(previewHttp.reduction.plan.status, 'PASS');
  assert.equal(previewHttp.reduction.plan.accounting.redistributed, 3);

  // Preview is read-only: two previews and no candidate.
  const before = (await application.getProject(owner, run.projectId)).project.candidates.length;
  await http('plan', payload);
  assert.equal((await application.getProject(owner, run.projectId)).project.candidates.length, before);

  const input = { ...payload, expected_plan_id: previewHttp.reduction.plan.id };
  const appliedHttp = await (await http('apply', input)).json();
  assert.equal(appliedHttp.reduction.applied, true);
  assert.equal(appliedHttp.reduction.status, 'PASS');
  // Applying certifies nothing: the fresh review still reports the gates open.
  assert.equal(appliedHttp.review.gates.mobile_adaptation, 'PENDING');
  assert.notEqual(appliedHttp.reduction.candidate_id, run.candidateId);
  assert.equal(appliedHttp.reduction.parent_candidate_id, run.candidateId);

  // Re-applying the same reviewed plan to the same parent is idempotent, not a
  // second sibling: the revision is content-addressed over the same inputs, so
  // it resolves to the same id on both transports and files no new candidate.
  const againMcp = await mcp('apply', input);
  const againHttp = await (await http('apply', input)).json();
  assert.deepEqual(againHttp.reduction, againMcp.structuredContent.reduction);
  assert.equal(againHttp.reduction.candidate_id, appliedHttp.reduction.candidate_id);
  assert.equal((await application.getProject(owner, run.projectId)).project.candidates.length, 2);

  // The reduction candidate cannot be reduced again by the same decision: the
  // move it describes has already happened.
  const replay = await application.planFinalReduction(owner, run.projectId, { candidateId: appliedHttp.reduction.candidate_id, decisions: [REDISTRIBUTE], acceptedBy: 'transport-test' });
  assert.equal(replay.reduction.plan.status, 'PENDING');

  // Owner isolation: another account cannot see or reduce this project.
  const other = await mcp('plan', payload, 'someone-else');
  assert.equal(other.isError, true);
  assert.equal((await http('apply', input, false)).status, 401);
});

test('a stale or malformed reduction request is refused identically on both transports', async () => {
  const application = createStudioApplication(), owner = 'reduction-stale';
  const run = await reducibleProject(application, owner);
  const route = createApiRouter({ application, ownerOf: () => owner });
  const http = async (action, body) => route(new Request(`https://mml.example${API_PREFIX}/projects/${run.projectId}/final-reduction/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { authenticated: true });
  const mcp = async (action, args) => {
    const response = await handleMcp(new Request('https://mml.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `studio_final_reduction_${action}`, arguments: { project_id: run.projectId, ...args } } }) }), { application, owner });
    return (await response.json()).result;
  };
  const payload = planPayload(run.candidateId, { decisions: [REDISTRIBUTE] });

  // A plan id that never described these inputs.
  const stale = { ...payload, expected_plan_id: 'g12:plan:' + 'f'.repeat(64) };
  const staleHttp = await (await http('apply', stale)).json();
  const staleMcp = await mcp('apply', stale);
  assert.deepEqual(staleHttp.reduction, staleMcp.structuredContent.reduction);
  assert.equal(staleHttp.reduction.blockers[0].code, 'STALE_FINAL_REDUCTION_PLAN');
  assert.equal((await application.getProject(owner, run.projectId)).project.candidates.length, 1);

  // A malformed decision is a refusal, not a partial application. MCP refuses
  // the short plan id at the schema boundary and the decision inside the tool;
  // either way the answer is a refusal and no candidate is filed.
  const malformed = { ...payload, decisions: [{ id: 'bad', action: 'DELETE_EVERYTHING', eventIds: ['chord5-1'], reason: 'no' }], expected_plan_id: 'x' };
  assert.equal((await http('apply', malformed)).status, 400);
  assert.equal(await mcp('apply', malformed), undefined, 'MCP refuses the short plan id at the schema boundary');
  const wellFormedId = { ...malformed, expected_plan_id: 'g12:plan:' + '0'.repeat(64) };
  assert.equal((await mcp('apply', wellFormedId)).isError, true);
  assert.equal((await http('apply', wellFormedId)).status, 400);
  assert.equal((await application.getProject(owner, run.projectId)).project.candidates.length, 1);

  // An unknown candidate is refused before anything is computed.
  assert.equal((await http('plan', planPayload('g11d:rev:' + '0'.repeat(64)))).status, 404);
  // A decision naming an event that is not in the candidate blocks the plan.
  const ghost = await (await http('plan', planPayload(run.candidateId, { decisions: [{ ...REDISTRIBUTE, eventIds: ['no-such-event'] }] }))).json();
  assert.equal(ghost.reduction.plan.status, 'PENDING');
  assert.ok(ghost.reduction.plan.blockers.some(blocker => blocker.code === 'REDUCTION_DECISION_TARGET_NOT_FOUND'));
});

test('an instrument profile crossing the transport changes no reduction outcome', async () => {
  const application = createStudioApplication(), owner = 'reduction-timbre';
  const run = await reducibleProject(application, owner);
  const route = createApiRouter({ application, ownerOf: () => owner });
  const http = async body => (await route(new Request(`https://mml.example${API_PREFIX}/projects/${run.projectId}/final-reduction/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { authenticated: true })).json();
  const payload = planPayload(run.candidateId, { decisions: [REDISTRIBUTE] });
  const without = await http(payload);
  const withProfile = await http({
    ...payload,
    instrument_profile: {
      schema: 'mml-studio/instrument-profile@1',
      instrumentId: 'pack:lute',
      targetClient: 'unverified third-party sound pack',
      evidence: ['research:sound-pack/regions'],
      verificationStatus: 'VERIFIED',
      pitch: { testedRange: [36, 96], usableRange: [55, 79], weakRegions: [[36, 47]] },
      dynamics: { volumeResponse: null },
      timbre: { attack: 'fast', sustain: 'short', decay: 'medium' },
    },
  });
  assert.equal(without.reduction.plan.id, withProfile.reduction.plan.id);
  assert.deepEqual(without.reduction.plan.items, withProfile.reduction.plan.items);
  assert.deepEqual(without.reduction.plan.blockers, withProfile.reduction.plan.blockers);
  assert.equal(withProfile.reduction.plan.timbre.influencedOutcomes, false);
});

test('a reduction candidate is a first-class candidate for every downstream operation', async () => {
  const application = createStudioApplication(), owner = 'reduction-downstream';
  const run = await reducibleProject(application, owner);
  const plan = await application.planFinalReduction(owner, run.projectId, { candidateId: run.candidateId, decisions: [REDISTRIBUTE], acceptedBy: 'downstream' });
  const applied = await application.applyFinalReduction(owner, run.projectId, { candidateId: run.candidateId, decisions: [REDISTRIBUTE], expectedPlanId: plan.reduction.plan.id, acceptedBy: 'downstream' });
  const reducedId = applied.reduction.candidate_id;
  const record = (await application.getProject(owner, run.projectId)).project;
  const entry = record.candidates.find(candidate => candidate.candidate_id === reducedId);
  assert.equal(entry.stage, 'FINAL_SIX_ROLE_REDUCTION_V1');
  assert.equal(entry.parent_candidate_id, run.candidateId);

  // Mobile Adaptation takes the reduction candidate directly.
  const mobile = await application.planMobileAdaptation(owner, run.projectId, { candidateId: reducedId, profile: { schema: 'mml-studio/mobile-adaptation-profile@1', id: 'fixture', reason: 'Synthetic calibrated default for the reduced candidate.', evidence: ['fixture:client'], roles: { Chord5: { defaultVolume: 9 } } } });
  assert.equal(mobile.adaptation.plan.status, 'PASS', JSON.stringify(mobile.adaptation.plan.blockers));
  const mobileApplied = await application.applyMobileAdaptation(owner, run.projectId, { candidateId: reducedId, profile: mobile.adaptation.plan.profile, expectedPlanId: mobile.adaptation.plan.id, acceptedBy: 'downstream' });
  assert.equal(mobileApplied.adaptation.applied, true);

  // And the reduction candidate can itself be reduced again.
  const second = await application.planFinalReduction(owner, run.projectId, { candidateId: reducedId, acceptedBy: 'downstream' });
  assert.equal(second.reduction.plan.parentRevisionId, reducedId);
  assert.equal(second.reduction.plan.accounting.pending, 0);
  assert.equal(second.reduction.plan.accounting.retained + second.reduction.plan.accounting.redistributed, 18);
});

test('reduction over a KEEP-only candidate accounts for every event and applies nothing', async () => {
  const application = createStudioApplication(), owner = 'reduction-noop';
  const run = await applyKeepOnlyCandidate(application, owner);
  const plan = await application.planFinalReduction(owner, run.projectId, { candidateId: run.candidateId, acceptedBy: 'noop' });
  assert.equal(plan.reduction.plan.status, 'PASS');
  assert.equal(plan.reduction.plan.accounting.total, 18);
  assert.equal(plan.reduction.plan.accounting.retained, 18);
  const applied = await application.applyFinalReduction(owner, run.projectId, { candidateId: run.candidateId, decisions: [], expectedPlanId: plan.reduction.plan.id, acceptedBy: 'noop' });
  assert.equal(applied.reduction.applied, false);
  assert.equal(applied.reduction.blockers[0].code, 'REDUCTION_NOTHING_TO_APPLY');
  assert.equal((await application.getProject(owner, run.projectId)).project.candidates.length, 1);
});
