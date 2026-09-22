import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioApplication } from '../backend/application/index.mjs';
import { projectWithSymbolicAsset, runDecisionsFor } from './fixtures/run-fixtures.mjs';
import { handleMcp } from '../../server/mcp.mjs';
import { STUDIO_MCP_TOOLS, runStudioTool } from '../../server/mcp-studio.mjs';
import { createApiRouter } from '../../server/api.mjs';
import { compareContinuationSurface } from '../../server/continuation-surface.mjs';

const OWNER = 'owner:portable-transport';
const request = (method, params = {}) => new Request('https://studio.test/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
const rpc = async (app, method, params) => (await (await handleMcp(request(method, params), { application: app, owner: OWNER })).json());
const call = (app, name, args) => rpc(app, 'tools/call', { name, arguments: args });
async function fixture() {
  const app = createStudioApplication(); const f = await projectWithSymbolicAsset(app, OWNER);
  const { run } = await app.startRun(OWNER, f.projectId, {});
  return { app, ...f, run, args: { project_id: f.projectId, run_id: run.run_id } };
}

test('actual server tools/list exposes next with a closed read-only schema and matching capabilities', async () => {
  const app = createStudioApplication(); const listed = (await rpc(app, 'tools/list')).result.tools;
  const tool = listed.find(tool => tool.name === 'studio_run_next');
  assert.ok(tool); assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['project_id', 'run_id']);
  assert.ok(tool.inputSchema.properties.expected_run_revision);
  assert.ok(tool.inputSchema.properties.report_page);
  const caps = await app.capabilities();
  assert.ok(caps.runs.read_only_operations.includes('nextRun'));
  assert.equal(caps.capabilities.server_side_model_calls, false);
  assert.equal(caps.capabilities.automatic_run_continuation, false);
  assert.equal(caps.capabilities.automatic_proposal_acceptance, false);
});

test('MCP and HTTP return the same read-only application snapshot under the existing owner', async () => {
  const f = await fixture(); const direct = await f.app.nextRun(OWNER, f.projectId, f.run.run_id);
  const mcp = await call(f.app, 'studio_run_next', f.args);
  assert.equal(mcp.result.isError, false); assert.deepEqual(mcp.result.structuredContent, direct);
  const api = createApiRouter({ application: f.app, ownerOf: request => request.headers.get('x-test-owner') ?? OWNER });
  const path = `https://studio.test/api/v1/projects/${f.projectId}/runs/${f.run.run_id}/next`;
  const http = await api(new Request(path), { authenticated: true });
  assert.equal(http.status, 200); assert.deepEqual(await http.json(), direct);
  const forbidden = await api(new Request(path, { headers: { 'x-test-owner': 'other-owner' } }), { authenticated: true });
  assert.equal(forbidden.status, 404);
  const missingOwner = await api(new Request(path), { authenticated: false }); assert.equal(missingOwner.status, 401);
  const malformed = await api(new Request(`${path}?expected_run_revision=1&expected_run_revision=2`), { authenticated: true });
  assert.equal(malformed.status, 400);
});

test('MCP rejects stale revisions and forged PASS rather than mutating or dropping inputs', async () => {
  const f = await fixture(); const before = await f.app.nextRun(OWNER, f.projectId, f.run.run_id);
  for (const extra of [{ gates: { source: 'PASS' } }, { confirmations: {} }, { accepted_by: 'agent' }, { reconcile: true }]) {
    const answer = await call(f.app, 'studio_run_next', { ...f.args, ...extra });
    assert.ok(answer.error || answer.result?.isError);
    await assert.rejects(runStudioTool('studio_run_next', { ...f.args, ...extra }, { application: f.app, owner: OWNER }));
  }
  assert.deepEqual(await f.app.nextRun(OWNER, f.projectId, f.run.run_id), before);
  await f.app.resumeRun(OWNER, f.projectId, f.run.run_id, {});
  const answer = await call(f.app, 'studio_run_next', { ...f.args, expected_run_revision: before.run_revision });
  assert.equal(answer.result.isError, true);
  assert.match(JSON.stringify(answer.result), /RUN_CONFLICT/);
});

test('paged next reads are stable and reject mixed snapshots after a proposal-only change', async () => {
  const f = await fixture();
  const page = (await call(f.app, 'studio_run_next', { ...f.args, report_page: { length: 300 } })).result.structuredContent.report_page;
  assert.equal(page.format, 'json-text-fragment');
  const same = (await call(f.app, 'studio_run_next', { ...f.args, report_page: { length: 300 } })).result.structuredContent.report_page;
  assert.deepEqual(same, page);
  const next = await f.app.nextRun(OWNER, f.projectId, f.run.run_id);
  const events = await f.app.listBaselineEvents(OWNER, f.projectId, { limit: 2 });
  await f.app.proposeDecision(OWNER, f.projectId, {
    run_id: f.run.run_id, expected_run_revision: next.run_revision,
    request_key: next.proposal_targets.find(t => t.admissible_kinds.includes('arrangement_decision')).request_key,
    kind: 'arrangement_decision', proposed_by: 'fixture-agent', rationale: 'Keep the fixture source roles without changes.',
    action: { decisions: runDecisionsFor(f.project).map(({ acceptedBy, note, ...rest }) => rest) },
    cites: { event_ids: events.events.map(e => e.event_id) },
  });
  assert.equal((await f.app.nextRun(OWNER, f.projectId, f.run.run_id)).run_revision, next.run_revision);
  const changed = await call(f.app, 'studio_run_next', { ...f.args, report_page: { length: 300, offset: 300, expected_sha256: page.report_sha256 } });
  assert.equal(changed.result.isError, true); assert.match(JSON.stringify(changed.result), /REPORT_CHANGED/);
});

test('server discovery never impersonates client exposure, schema compatibility or real conversation E2E', () => {
  assert.equal(compareContinuationSurface(STUDIO_MCP_TOOLS).status, 'CLIENT_EXPOSURE_UNVERIFIED');
  const observedLegacy = ['studio_capabilities', 'studio_project_create', 'studio_project_get', 'studio_audio_alignment',
    'studio_arrangement_suggest', 'studio_job_status', 'studio_artifact_get', 'studio_sources_analyze', 'studio_baseline_events',
    'studio_finalize', 'studio_candidate_review', 'studio_decisions_apply', 'studio_core3_change_approve', 'studio_lead_evidence_review',
    'mml_service_info', 'mml_validate', 'mml_overlap_details'];
  const missing = compareContinuationSurface(STUDIO_MCP_TOOLS, observedLegacy);
  assert.equal(missing.status, 'CLIENT_TOOLS_MISSING');
  assert.ok(missing.client_missing.includes('studio_run_next'));
  assert.ok(missing.client_missing.includes('studio_proposal_resolve'));
  const names = STUDIO_MCP_TOOLS.map(tool => tool.name);
  assert.equal(compareContinuationSurface(STUDIO_MCP_TOOLS, names).status, 'CLIENT_SCHEMAS_UNVERIFIED');
  const staleSchema = structuredClone(STUDIO_MCP_TOOLS);
  delete staleSchema.find(tool => tool.name === 'studio_run_next').inputSchema.properties.expected_run_revision;
  assert.equal(compareContinuationSurface(STUDIO_MCP_TOOLS, staleSchema).status, 'CLIENT_SCHEMA_MISMATCH');
  const matched = compareContinuationSurface(STUDIO_MCP_TOOLS, STUDIO_MCP_TOOLS);
  assert.equal(matched.status, 'DISCOVERY_MATCH'); assert.equal(matched.behavioral_e2e, 'NOT_RUN');
});

test('schema annotations are ignored without dropping input properties named title or description', () => {
  const annotationOnly = structuredClone(STUDIO_MCP_TOOLS);
  for (const tool of annotationOnly) tool.inputSchema.description = 'different display text';
  assert.equal(compareContinuationSurface(STUDIO_MCP_TOOLS, annotationOnly).status, 'DISCOVERY_MATCH');
  const changed = structuredClone(STUDIO_MCP_TOOLS);
  changed.find(tool => tool.name === 'studio_run_next').inputSchema.properties.description = { type: 'string' };
  assert.equal(compareContinuationSurface(STUDIO_MCP_TOOLS, changed).status, 'CLIENT_SCHEMA_MISMATCH');
  assert.throws(() => compareContinuationSurface(STUDIO_MCP_TOOLS, ['duplicate', 'duplicate']), /Duplicate/);
});
