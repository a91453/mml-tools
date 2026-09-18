import test from 'node:test';
import assert from 'node:assert/strict';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { applyKeepOnlyCandidate } from '../studio/tests/fixtures/application-fixtures.mjs';

test('Mobile preview/apply have HTTP/MCP parity, preserve identity and enforce authorization', async () => {
  const application = createStudioApplication(), owner = 'mobile-transport';
  const run = await applyKeepOnlyCandidate(application, owner);
  const route = createApiRouter({ application, ownerOf: () => owner });
  const payload = { candidate_id: run.candidateId, profile: { schema: 'mml-studio/mobile-adaptation-profile@1', id: 'fixture', reason: 'Synthetic calibrated default', evidence: ['fixture:client'], roles: { Melody: { defaultVolume: 9 } } } };
  const http = async (action, body, authenticated = true) => route(new Request(`https://mml.example${API_PREFIX}/projects/${run.projectId}/mobile-adaptation/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { authenticated });
  const mcp = async (action, args) => {
    const response = await handleMcp(new Request('https://mml.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `studio_mobile_adaptation_${action}`, arguments: { project_id: run.projectId, ...args } } }) }), { application, owner });
    return (await response.json()).result;
  };
  const previewHttp = await (await http('plan', payload)).json();
  const previewMcp = await mcp('plan', payload);
  assert.equal(previewMcp.isError, false);
  assert.deepEqual(previewHttp.adaptation, previewMcp.structuredContent.adaptation);
  const input = { ...payload, expected_plan_id: previewHttp.adaptation.plan.id, accepted_by: 'transport-test' };
  const appliedHttp = await (await http('apply', input)).json();
  const appliedMcp = await mcp('apply', input);
  assert.equal(appliedHttp.adaptation.applied, true);
  assert.equal(appliedMcp.isError, false);
  assert.deepEqual(appliedHttp.adaptation, appliedMcp.structuredContent.adaptation);
  assert.equal(appliedMcp.structuredContent.review.gates.mobile_adaptation, 'PENDING');
  assert.equal((await http('apply', input, false)).status, 401);
  assert.equal((await http('apply', payload)).status, 400);
});
