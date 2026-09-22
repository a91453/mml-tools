// HTTP adapter — parity with MCP and the authorization challenge.
//
// The same request must be answered with the same class of answer on every
// transport. MCP refuses a malformed technical-check argument set before the
// tool runs; HTTP must refuse it too, rather than grading a request mistake as
// a technical verdict about a song.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { createApplication } from '../railway/server.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';

const ORIGIN = 'https://mml.example';

function setup() {
  const application = createStudioApplication({ transports: ['http'] });
  const route = createApiRouter({ application, ownerOf: () => 'owner:service' });
  const json = async (path, payload) => {
    const response = await route(new Request(`${ORIGIN}${API_PREFIX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), { authenticated: true });
    return { status: response.status, body: await response.json() };
  };
  return { json };
}

const VALID = { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' };

test('a malformed technical-check request is refused over HTTP exactly where MCP refuses it', async () => {
  const { json } = setup();
  const cases = [
    {},
    { meter_text: '0 4/4' },
    { mml: 123, meter_text: '0 4/4' },
    { ...VALID, meter_text: 5 },
    { ...VALID, programs: 'x' },
    { ...VALID, programs: [1, 2, 3] },
    { ...VALID, error_offset: 'x' },
    { ...VALID, title: 'x'.repeat(121) },
    { mml: 'MML@' + 'c'.repeat(40001) + ',,,,,;', meter_text: '0 4/4' },
    { ...VALID, unexpected: true },
    JSON.parse('{"mml":"MML@t120o4c1,,,,,;","meter_text":"0 4/4","__proto__":{"polluted":true}}'),
    JSON.parse('{"mml":"MML@t120o4c1,,,,,;","meter_text":"0 4/4","constructor":{"polluted":true}}'),
  ];
  for (const [index, payload] of cases.entries()) {
    for (const path of ['/technical/validate', '/technical/overlaps']) {
      const { status, body } = await json(path, payload);
      assert.equal(status, 400, `${path} case ${index} must be a client error, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
      assert.equal(body.error.code, 'INVALID_REQUEST');
      assert.equal(body.technical_ok, undefined, 'a refusal is not a technical verdict');
    }
  }
  for (const payload of [{ ...VALID, kind: 'bogus' }, { ...VALID, limit: 0 }, { ...VALID, offset: -1 }]) {
    const { status, body } = await json('/technical/overlaps', payload);
    assert.equal(status, 400, JSON.stringify(body).slice(0, 200));
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
  // The legacy report for valid input is unchanged.
  const ok = await json('/technical/validate', VALID);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.technical_ok, true);
  assert.equal(ok.body.pair_count, 15);
  const paged = await json('/technical/overlaps', { ...VALID, kind: 'same_pitch', offset: 0, limit: 5 });
  assert.equal(paged.status, 200);
  assert.equal(paged.body.technical_ok, true);
});

test('an unauthenticated Application API request carries the same OAuth challenge as /mcp', async t => {
  const app = createApplication({ origin: ORIGIN, ownerPassword: 'SYNTHETIC_TEST_PASSWORD_ONLY_01234567890123456789', database: ':memory:' });
  t.after(() => app.close());
  const api = await app.fetch(new Request(`${ORIGIN}${API_PREFIX}/capabilities`));
  const mcp = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }));
  assert.equal(api.status, 401);
  assert.equal(mcp.status, 401);
  assert.equal(api.headers.get('www-authenticate'), mcp.headers.get('www-authenticate'));
  assert.match(api.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  assert.equal((await api.json()).error.code, 'NOT_AUTHENTICATED');
});

test('the MCP technical tools keep refusing the same malformed arguments as before', async () => {
  const call = async args => (await (await handleMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mml_validate', arguments: args } }) }))).json());
  assert.equal((await call({})).error.code, -32602);
  assert.equal((await call({ mml: 123, meter_text: '0 4/4' })).error.code, -32602);
  assert.equal((await call(VALID)).result.structuredContent.technical_ok, true);
});

// ─── the two review axes reach the same place on both transports ────────────
//
// `approveCore3SourceChange` existed on the Application Service with no caller
// on either transport, which left the Core3 source-continuity axis unclearable
// from the Agent plane. A route and a tool were added together; this pins that
// both exist, that they dispatch to the same operation, and that a malformed
// request is refused the same way on each -- so the pair cannot drift back into
// one transport knowing an operation the other does not.

test('the Core3 approval and Lead evidence review routes exist and refuse the same inputs MCP refuses', async () => {
  const { json } = setup();
  const project = '/projects/prj_00000000000000000000000000000000';

  // An unreached route answers NOT_FOUND / "Unknown endpoint"; a reached one
  // answers with the operation's own refusal. Both are HTTP 404 here -- an
  // unknown candidate IS a 404 -- so the code is what distinguishes them, and
  // `/review` is the control: a route known to exist, answering identically.
  const control = await json(`${project}/review`, {});
  assert.equal(control.body.error?.code, 'CANDIDATE_NOT_FOUND');

  for (const path of [`${project}/core3/approvals`, `${project}/lead-evidence/reviews`]) {
    const { body } = await json(path, {});
    assert.notEqual(body.error?.code, 'NOT_FOUND', `${path} must be routed`);
    assert.equal(body.error?.code, control.body.error.code, `${path} answered ${JSON.stringify(body.error)}`);
  }

  // A path that really is not routed, so the assertion above can fail.
  const missing = await json(`${project}/core3/approvals/nope`, {});
  assert.equal(missing.body.error?.code, 'NOT_FOUND');
});

test('every studio MCP tool dispatches to an operation the Application Service actually has', async () => {
  const { STUDIO_MCP_TOOLS } = await import('../server/mcp-studio.mjs');
  const application = createStudioApplication({});
  // The operation each tool is documented to call. A tool naming an operation
  // that does not exist would fail only when a caller tried it.
  const operations = {
    studio_capabilities: 'capabilities',
    studio_project_create: 'createProject',
    studio_project_get: 'getProject',
    studio_sources_analyze: 'analyzeSources',
    studio_baseline_events: 'listBaselineEvents',
    studio_arrangement_suggest: 'suggestArrangement',
    studio_decisions_apply: 'applyDecisions',
    studio_final_reduction_plan: 'planFinalReduction',
    studio_final_reduction_apply: 'applyFinalReduction',
    studio_mobile_adaptation_plan: 'planMobileAdaptation',
    studio_mobile_adaptation_apply: 'applyMobileAdaptation',
    studio_audio_alignment: 'attachAudioAlignment',
    studio_candidate_review: 'reviewCandidate',
    studio_core3_change_approve: 'approveCore3SourceChange',
    studio_lead_evidence_review: 'reviewLeadEvidence',
    studio_finalize: 'finalize',
    studio_job_status: 'getJob',
    studio_artifact_get: 'getArtifact',
    studio_run_plan: 'planRun',
    studio_run_start: 'startRun',
    studio_run_status: 'getRun',
    studio_run_next: 'nextRun',
    studio_run_resume: 'resumeRun',
    studio_proposal_targets: 'proposalTargets',
    studio_proposal_submit: 'proposeDecision',
    // One tool, two reads, exactly as `studio_run_status` and
    // `studio_project_get` already work: with an id it is the record, without
    // one it is the project's list. The map names the operation a caller
    // reaches with an id.
    studio_proposal_status: 'getProposal',
    studio_proposal_resolve: 'resolveProposal',
  };
  for (const tool of STUDIO_MCP_TOOLS) {
    const operation = operations[tool.name];
    assert.ok(operation, `${tool.name} is advertised but this test does not know which operation it calls`);
    assert.equal(typeof application[operation], 'function', `${tool.name} dispatches to a missing operation ${operation}`);
  }
  assert.equal(STUDIO_MCP_TOOLS.length, Object.keys(operations).length, 'a tool was added or removed without updating this map');
});

// Advertising a tool is not the same as being able to call it. A dispatch case
// whose name drifted from the advertised one would fail only when an agent
// tried it, and `tools/list` would keep claiming the capability. Every tool is
// therefore actually dispatched here, and the only thing asserted is that it
// was recognised: it must not raise "Unknown studio tool".
test('every advertised studio tool is dispatchable, not just advertised', async () => {
  const { STUDIO_MCP_TOOLS, runStudioTool } = await import('../server/mcp-studio.mjs');
  const application = createStudioApplication({});
  const owner = 'owner:service';
  // Arguments good enough to reach the operation; each is expected to be
  // refused by the operation itself, which is what proves it was reached.
  const args = {
    project_id: 'prj_00000000000000000000000000000000',
    candidate_id: 'g11d:rev:0000000000000000',
    job_id: 'job_00000000000000000000000000000000',
    artifact_id: 'art_00000000000000000000000000000000',
    run_id: 'run_00000000000000000000000000000000',
    approval: {},
    review: {},
    report: {},
    decisions: [],
  };

  for (const tool of STUDIO_MCP_TOOLS) {
    let unknown = false;
    try {
      await runStudioTool(tool.name, args, { application, owner });
    } catch (error) {
      unknown = /Unknown studio tool/.test(error.message);
    }
    assert.equal(unknown, false, `${tool.name} is advertised but not dispatched`);
  }

  // The guard above can fail: a name nobody dispatches is still refused.
  await assert.rejects(
    () => runStudioTool('studio_not_a_tool', args, { application, owner }),
    /Unknown studio tool/,
  );
});
