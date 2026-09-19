// MCP adapter — a refusal still says which rules snapshot answered.
//
// The HTTP adapter attaches the Canonical provenance envelope to every error
// response. An agent working over MCP needs the same fact for the same reason:
// a blocked or refused call has to be read against the right rules release.

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMcp } from '../server/mcp.mjs';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:service';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const call = (application, name, args) => handleMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { application, owner: OWNER });

test('a structured MCP refusal carries the same Canonical envelope as the HTTP refusal', async () => {
  const application = createStudioApplication({});
  const missing = `prj_${'0'.repeat(32)}`;
  const mcp = (await (await call(application, 'studio_project_get', { project_id: missing })).json()).result;
  assert.equal(mcp.isError, true);
  assert.equal(mcp.structuredContent.error.code, 'PROJECT_NOT_FOUND');
  assert.equal(mcp.structuredContent.canonical?.status, 'CANONICAL_LOADED');
  assert.match(mcp.structuredContent.canonical.rules_snapshot_sha, /^[0-9a-f]{40}$/);

  const route = createApiRouter({ application, ownerOf: () => OWNER });
  const http = await (await route(new Request(`${ORIGIN}${API_PREFIX}/projects/${missing}`), { authenticated: true })).json();
  assert.deepEqual(mcp.structuredContent.canonical, http.canonical, 'both transports must name the same provenance on failure');
  assert.deepEqual(mcp.structuredContent.error, http.error);
  // The text content mirrors the structured content, as for every other result.
  assert.deepEqual(JSON.parse(mcp.content[0].text), mcp.structuredContent);
});

test('the envelope is honest when Published Canonical is unavailable, and absent for the bare technical tools', async () => {
  const unavailable = createStudioApplication({ loadEngines: async () => { throw Error('no published history'); } });
  const project = (await unavailable.createProject(OWNER, { title: 'x' })).project;
  const refused = (await (await call(unavailable, 'studio_sources_analyze', { project_id: project.project_id })).json()).result;
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'CANONICAL_NOT_LOADED');
  assert.equal(refused.structuredContent.canonical.status, 'CANONICAL_NOT_LOADED');
  assert.equal(refused.structuredContent.canonical.legacy_fallback_allowed, false);

  // A sanitized internal fault still carries the envelope and nothing else.
  const faulty = Object.freeze({ ...createStudioApplication({}), getProject: async () => { throw Error('ENOENT /data/private'); } });
  const fault = (await (await call(faulty, 'studio_project_get', { project_id: `prj_${'1'.repeat(32)}` })).json()).result;
  assert.equal(fault.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.equal(fault.structuredContent.canonical.status, 'CANONICAL_LOADED');
  assert.doesNotMatch(JSON.stringify(fault), /ENOENT|\/data\/private/);

  // Without an Application Service there is no provenance to report, and the
  // legacy tools' refusals keep their original shape.
  const legacy = (await (await handleMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mml_validate', arguments: { mml: 'MML@c1234,,,,,;', meter_text: '0 4/4' } } }) }))).json()).result;
  assert.equal(legacy.isError, true);
  assert.equal(legacy.structuredContent.canonical, undefined);
});

test('an oversized result preserves completed operation references instead of inviting a blind retry', async () => {
  const app = createStudioApplication({});
  const project = (await app.createProject(OWNER, { title: 'Synthetic oversized run response' })).project;
  let calls = 0;
  const application = { ...app, startRun: async (...args) => {
    calls++;
    const result = await app.startRun(...args);
    return { ...result, diagnostics: 'x'.repeat(600_000) };
  } };
  const result = (await (await call(application, 'studio_run_start', { project_id: project.project_id, idempotency_key: 'oversized-start' })).json()).result;
  assert.equal(result.isError, true);
  const error = result.structuredContent.error;
  assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(error.details.operation_returned, true);
  assert.equal(error.details.tool_name, 'studio_run_start');
  assert.equal(error.details.max_bytes, 524288);
  assert.ok(error.details.response_bytes > error.details.max_bytes);
  assert.equal(calls, 1);
  const runs = (await app.getRun(OWNER, project.project_id)).runs;
  assert.equal(runs.length, 1, 'the service already created the run');
  assert.deepEqual(error.details.result_references, { project_id: project.project_id, run_id: runs[0].run_id });
  assert.ok(error.details.recovery_reads.some(entry => entry.path === `/api/v1/projects/${project.project_id}/runs/${runs[0].run_id}` && entry.method === 'GET'));
  assert.match(error.message, /already returned/);
  assert.match(error.details.recovery_notice, /Do not repeat/);
  const recovered = (await (await call(app, 'studio_run_status', { project_id: project.project_id, run_id: runs[0].run_id })).json()).result;
  assert.equal(recovered.isError, false);
  assert.equal(recovered.structuredContent.run.state, 'awaiting_review');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(JSON.stringify(result).length < 12000, 'the recovery envelope itself is bounded');
});

test('oversized blocked finalize keeps the business refusal and only bounded, known recovery fields', async () => {
  const project_id = 'prj_' + '1'.repeat(32), candidate_id = 'g11d:rev:' + '2'.repeat(64), job_id = 'job_' + '3'.repeat(32);
  const application = { ...createStudioApplication({}), finalize: async () => ({
    operation: 'blocked', code: 'FINALIZATION_BLOCKED', candidate_id,
    job: { job_id }, diagnostics: 'x'.repeat(600_000), secret: 'never-copy-this',
  }) };
  const result = (await (await call(application, 'studio_finalize', { project_id, candidate_id })).json()).result;
  const { details } = result.structuredContent.error;
  assert.equal(details.operation_returned, true, 'a returned operation is not necessarily successful');
  assert.equal(details.operation, 'blocked');
  assert.equal(details.result_code, 'FINALIZATION_BLOCKED');
  assert.deepEqual(details.result_references, { project_id, candidate_id, job_id });
  assert.doesNotMatch(JSON.stringify(result), /never-copy-this/);
  assert.ok(details.recovery_reads.every(entry => entry.method === 'GET'));
});
