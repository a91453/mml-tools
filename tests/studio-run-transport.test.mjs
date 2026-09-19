// The run over both transports, and the security boundary around it.
//
// One workflow, two adapters. A run started over HTTP and the same run started
// over MCP have to agree on the state, the gates, the raw blockers, the
// candidate identities and the provenance — not approximately, but field for
// field once the timestamps and the server-generated ids are removed. A second
// workflow hiding behind one of the adapters is exactly the failure this
// assertion exists to rule out.
//
// Then the refusals: a read-only plan and a read-only status must write
// nothing at all, and an ownership mismatch, a malformed payload, an
// oversized input, an unknown or stale run id and a caller-supplied binding
// must each be refused rather than interpreted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { LIMITS, PLAN_INPUT_KEYS, RESUME_INPUT_KEYS, START_INPUT_KEYS, createStudioApplication } from '../studio/backend/application/index.mjs';
import { FIXTURE_CONFIRMATIONS, RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor, sixRoleBaseline } from '../studio/tests/fixtures/run-fixtures.mjs';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:service';
const OTHER = 'owner:intruder';
const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function transports({ owner = OWNER, ...options } = {}) {
  const application = createStudioApplication({ transports: ['http', 'mcp'], ...options });
  const route = createApiRouter({ application, ownerOf: () => owner });
  const http = async (method, path, payload) => {
    const response = await route(new Request(`${ORIGIN}${API_PREFIX}${path}`, {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }), { authenticated: true });
    return { status: response.status, body: await response.json() };
  };
  const mcp = async (name, args = {}) => {
    const response = await handleMcp(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: rpcHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), { application, owner });
    return (await response.json()).result;
  };
  return { application, route, http, mcp };
}

// Everything a run legitimately differs on between two independent executions:
// server-generated ids and wall-clock time. Nothing else may differ.
const VOLATILE = new Set(['run_id', 'project_id', 'asset_id', 'asset_ids', 'asset_digests', 'job_id', 'job_ids',
  'created_at', 'updated_at', 'at', 'attached_at', 'artifact_id', 'artifact_ids', 'final_artifact_id',
  'report_artifact_id', 'result_reference', 'baseline_asset_ids', 'run_ids', 'candidate_ids', 'receipts',
  // Scoped to the project id, or fingerprinted over the selected asset ids:
  // per-project by construction. The fingerprints that must NOT vary by
  // transport — the decision set and the confirmations — are compared
  // explicitly below and are deliberately not listed here.
  'scope', 'request_fingerprint', 'input_fingerprint']);

const comparable = value => JSON.parse(JSON.stringify(value, (key, entry) => (VOLATILE.has(key) ? undefined : entry)));

/** A digest of everything the store has written, for a "wrote nothing" check. */
async function storeDigest(directory) {
  const hash = createHash('sha256');
  const walk = async path => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const info = await stat(child);
      if (info.isDirectory()) { await walk(child); continue; }
      hash.update(name).update(String(info.size)).update(await readFile(child));
    }
  };
  await walk(directory);
  return hash.digest('hex');
}

const withDirectory = async body => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-run-transport-'));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
};

// ─── parity ─────────────────────────────────────────────────────────────────

test('the same fixture run answers identically over HTTP and MCP', async () => {
  const project = sixRoleBaseline();
  const decisions = runDecisionsFor(project);

  const overHttp = transports();
  const httpFixture = await projectWithSymbolicAsset(overHttp.application, OWNER, { project });
  const started = await overHttp.http('POST', `/projects/${httpFixture.projectId}/runs`, {
    asset_ids: [httpFixture.assetId], decisions, accepted_by: RUN_REVIEWER,
  });
  assert.equal(started.status, 201, JSON.stringify(started.body).slice(0, 300));

  const overMcp = transports();
  const mcpFixture = await projectWithSymbolicAsset(overMcp.application, OWNER, { project });
  const mcpStarted = await overMcp.mcp('studio_run_start', {
    project_id: mcpFixture.projectId, asset_ids: [mcpFixture.assetId], decisions, accepted_by: RUN_REVIEWER,
  });

  // The whole run projection agrees, field for field.
  assert.deepEqual(comparable(mcpStarted.structuredContent.run), comparable(started.body.run));
  // Including the things it would be most convenient to let drift.
  const http = started.body.run;
  const mcp = mcpStarted.structuredContent.run;
  assert.equal(http.state, mcp.state);
  assert.deepEqual(http.halt.reason, mcp.halt.reason);
  assert.deepEqual(http.blockers, mcp.blockers);
  assert.deepEqual(http.gates, mcp.gates);
  assert.deepEqual(http.readiness_blockers, mcp.readiness_blockers);
  assert.deepEqual(http.review_requests.map(entry => [entry.code, entry.gate, entry.blockers]),
    mcp.review_requests.map(entry => [entry.code, entry.gate, entry.blockers]));
  // Content-addressed identities really are equal, not merely both present.
  assert.equal(http.baseline_id, mcp.baseline_id);
  assert.equal(http.candidate_id, mcp.candidate_id);
  assert.deepEqual(http.candidate_lineage, mcp.candidate_lineage);
  assert.deepEqual(started.body.canonical, mcpStarted.structuredContent.canonical);
  // The input fingerprints that describe caller-supplied content rather than
  // per-project identities are equal, so the two transports normalized the same
  // request to the same thing.
  assert.equal(http.inputs.decision_set_fingerprint, mcp.inputs.decision_set_fingerprint);
  assert.ok(http.inputs.decision_set_fingerprint);
  assert.equal(http.inputs.confirmation_fingerprint, mcp.inputs.confirmation_fingerprint);

  // And resuming to a Final agrees on the delivered artifact's identity.
  const httpDone = await overHttp.http('POST', `/projects/${httpFixture.projectId}/runs/${http.run_id}/resume`, { confirmations: FIXTURE_CONFIRMATIONS });
  const mcpDone = await overMcp.mcp('studio_run_resume', { project_id: mcpFixture.projectId, run_id: mcp.run_id, confirmations: FIXTURE_CONFIRMATIONS });
  assert.equal(httpDone.body.run.state, 'completed', JSON.stringify(httpDone.body.run.blockers));
  assert.equal(mcpDone.structuredContent.run.state, 'completed');
  assert.equal(httpDone.body.run.candidate_id, mcpDone.structuredContent.run.candidate_id);
  const httpArtifact = (await overHttp.http('GET', `/artifacts/${httpDone.body.run.final_artifact_id}`)).body.artifact;
  const mcpArtifact = (await overMcp.mcp('studio_artifact_get', { artifact_id: mcpDone.structuredContent.run.final_artifact_id })).structuredContent.artifact;
  assert.equal(httpArtifact.mml, mcpArtifact.mml, 'the same fixture delivers the same MML on both transports');
  assert.deepEqual(httpArtifact.gates, mcpArtifact.gates);
  assert.equal(httpArtifact.gates.in_game, 'PENDING');

  // The status read agrees too, and both are read-only.
  const httpStatus = await overHttp.http('GET', `/projects/${httpFixture.projectId}/runs/${http.run_id}`);
  const mcpStatus = await overMcp.mcp('studio_run_status', { project_id: mcpFixture.projectId, run_id: mcp.run_id });
  assert.deepEqual(comparable(httpStatus.body.run), comparable(mcpStatus.structuredContent.run));
  assert.equal(httpStatus.body.read_only, true);
  assert.equal(mcpStatus.structuredContent.read_only, true);
});

test('the read-only plan and status write nothing to the store', async () => {
  await withDirectory(async directory => {
    const { application, http, mcp } = transports({ dataDirectory: directory, durability: 'persistent' });
    const fixture = await projectWithSymbolicAsset(application, OWNER, { project: sixRoleBaseline() });
    const started = await application.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });

    const before = await storeDigest(directory);
    const planned = await http('POST', `/projects/${fixture.projectId}/runs/plan`, {
      asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project), accepted_by: RUN_REVIEWER,
    });
    assert.equal(planned.status, 200, JSON.stringify(planned.body).slice(0, 300));
    assert.equal(planned.body.plan.read_only, true);
    await mcp('studio_run_plan', { project_id: fixture.projectId });
    await http('GET', `/projects/${fixture.projectId}/runs/${started.run.run_id}`);
    await http('GET', `/projects/${fixture.projectId}/runs`);
    await mcp('studio_run_status', { project_id: fixture.projectId, run_id: started.run.run_id });
    await mcp('studio_run_status', { project_id: fixture.projectId });
    const after = await storeDigest(directory);

    assert.equal(after, before, 'a read-only plan or status must not change one byte of the store');
    // It reported a plan rather than refusing to answer, and named what it
    // would do without doing any of it.
    assert.ok(planned.body.plan.planned_steps.length);
    assert.match(planned.body.plan.plan_only_notice, /created no run, no baseline, no suggestion cache entry, no candidate and no artifact/);
    assert.equal((await application.getRun(OWNER, fixture.projectId)).runs.length, 1, 'planning created no second run');
    assert.equal((await application.getRun(OWNER, fixture.projectId, started.run.run_id)).run.revision, started.run.revision);
  });
});

// ─── refusals ───────────────────────────────────────────────────────────────

test('a run in another owner\'s project is not found rather than refused', async () => {
  const mine = transports();
  const fixture = await projectWithSymbolicAsset(mine.application, OWNER, { project: sixRoleBaseline() });
  const started = await mine.application.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });

  // The same service, reached by a different owner subject.
  const theirs = createApiRouter({ application: mine.application, ownerOf: () => OTHER });
  const asOther = async (method, path, payload) => {
    const response = await theirs(new Request(`${ORIGIN}${API_PREFIX}${path}`, {
      method, headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }), { authenticated: true });
    return { status: response.status, body: await response.json() };
  };

  for (const [method, path, payload] of [
    ['GET', `/projects/${fixture.projectId}/runs`, undefined],
    ['GET', `/projects/${fixture.projectId}/runs/${started.run.run_id}`, undefined],
    ['POST', `/projects/${fixture.projectId}/runs/plan`, {}],
    ['POST', `/projects/${fixture.projectId}/runs`, {}],
    ['POST', `/projects/${fixture.projectId}/runs/${started.run.run_id}/resume`, {}],
  ]) {
    const { status, body } = await asOther(method, path, payload);
    assert.equal(status, 404, `${method} ${path} answered ${status}`);
    assert.equal(body.error.code, 'PROJECT_NOT_FOUND', `${method} ${path}: ${JSON.stringify(body.error)}`);
  }

  // Over MCP too, and the run is untouched by any of it.
  const overMcp = await handleMcp(new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers: rpcHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_run_status', arguments: { project_id: fixture.projectId, run_id: started.run.run_id } } }),
  }), { application: mine.application, owner: OTHER });
  assert.equal((await overMcp.json()).result.structuredContent.error.code, 'PROJECT_NOT_FOUND');
  assert.equal((await mine.application.getRun(OWNER, fixture.projectId, started.run.run_id)).run.revision, started.run.revision);
});

test('a malformed, oversized or fabricated run request is refused rather than interpreted', async () => {
  const { application, http } = transports();
  const fixture = await projectWithSymbolicAsset(application, OWNER, { project: sixRoleBaseline() });
  const base = `/projects/${fixture.projectId}/runs`;

  const refusals = [
    // An unknown field is refused, not ignored: a misspelled `final_reduction`
    // must never look like a caller that accepted no reduction.
    [{ finalReduction: {} }, 'INVALID_REQUEST'],
    [{ decisions: 'not-an-array' }, 'INVALID_REQUEST'],
    [{ asset_ids: 'not-an-array' }, 'INVALID_REQUEST'],
    [{ asset_ids: Array.from({ length: 65 }, (_unused, index) => `ast_${String(index).padStart(32, '0')}`) }, 'INVALID_REQUEST'],
    // A reduction with no accepted decision is not a reduction a run may apply.
    [{ final_reduction: { decisions: [], expected_plan_id: 'x', accepted_by: 'r' } }, 'INVALID_REQUEST'],
    [{ final_reduction: { decisions: [{}] } }, 'INVALID_REQUEST'],
    [{ mobile_adaptation: { profile: {}, accepted_by: 'r' } }, 'INVALID_REQUEST'],
    // No automatic Technical Timing Repair mode, at any transport.
    [{ finalize: { technical_timing_repair: 'auto' } }, 'INVALID_REQUEST'],
    // A caller may not name a candidate that is not a candidate id, and may not
    // pre-declare a run revision on a run that does not exist.
    [{ target_candidate_id: '../../etc/passwd' }, 'CANDIDATE_NOT_FOUND'],
    [{ target_candidate_id: `g11d:rev:${'0'.repeat(64)}` }, 'CANDIDATE_NOT_FOUND'],
    [{ expected_run_revision: 1 }, 'INVALID_REQUEST'],
    [{ adopt_candidate_id: `g11d:rev:${'0'.repeat(64)}` }, 'INVALID_REQUEST'],
    // Structure bounds, spent before the payload reaches anything.
    [{ decisions: [nest(20)] }, 'INVALID_REQUEST'],
    [{ meter_text: 'x'.repeat(5000) }, 'INVALID_REQUEST'],
    // A prototype-polluting key is data, and data that is not an accepted field.
    [JSON.parse('{"__proto__":{"polluted":true}}'), 'INVALID_REQUEST'],
  ];
  for (const [payload, code] of refusals) {
    const { body } = await http('POST', base, payload);
    assert.equal(body.error?.code, code, `${JSON.stringify(payload).slice(0, 80)} answered ${JSON.stringify(body.error ?? body).slice(0, 160)}`);
  }
  assert.equal({}.polluted, undefined, 'no payload may reach Object.prototype');

  // A plan binds no idempotency key, because it writes nothing to be idempotent about.
  assert.equal((await http('POST', `${base}/plan`, { idempotency_key: 'k' })).body.error?.code, 'INVALID_REQUEST');

  // An unknown or malformed run id is not found, and a run id is matched by
  // shape rather than used as a path.
  for (const runId of ['run_00000000000000000000000000000000', 'not-a-run', 'run_zz', '%2e%2e%2f%2e%2e', 'run_../../etc']) {
    const status = await http('GET', `${base}/${runId}`);
    assert.equal(status.body.error?.code, 'RUN_NOT_FOUND', `${runId}: ${JSON.stringify(status.body.error ?? status.body).slice(0, 160)}`);
    const resumed = await http('POST', `${base}/${runId}/resume`, {});
    assert.equal(resumed.body.error?.code, 'RUN_NOT_FOUND', `${runId}: ${JSON.stringify(resumed.body.error ?? resumed.body).slice(0, 160)}`);
  }
  // A dot segment is collapsed by the URL parser before anything is routed, so
  // it is reported as an unknown endpoint rather than reaching a run at all.
  assert.equal((await http('GET', `${base}/..`)).body.error?.code, 'NOT_FOUND');

  // Nothing above created a run.
  assert.deepEqual((await application.getRun(OWNER, fixture.projectId)).runs, []);
});

test('a caller cannot supply the bindings the service computes, or a candidate outside the run lineage', async () => {
  const { application, http } = transports();
  const fixture = await projectWithSymbolicAsset(application, OWNER, { project: sixRoleBaseline() });
  await application.analyzeSources(OWNER, fixture.projectId, { assetIds: [fixture.assetId] });

  // A decision that tries to carry its own acceptance bindings is refused by
  // the arrangement service, through the run exactly as through the direct call.
  const forged = runDecisionsFor(fixture.project).map(decision => ({
    ...decision,
    acceptance: { state: 'ACCEPTED', baselineContentDigest: '0'.repeat(64), canonicalRulesSnapshotSha: '0'.repeat(40) },
  }));
  const refused = await http('POST', `/projects/${fixture.projectId}/runs`, { decisions: forged, accepted_by: RUN_REVIEWER });
  assert.equal(refused.body.error?.code, 'INVALID_REQUEST');
  assert.match(refused.body.error.message, /acceptance is computed by this service/);

  // Two independent candidates on one baseline. Adopting the sibling is refused:
  // it does not descend from the candidate the run is on, so adopting it would
  // silently abandon the run's lineage — and it is certainly not chosen by
  // being the newest.
  const first = (await application.applyDecisions(OWNER, fixture.projectId, { decisions: runDecisionsFor(fixture.project) })).decisions.candidate_id;
  const sibling = (await application.applyDecisions(OWNER, fixture.projectId, {
    decisions: runDecisionsFor(fixture.project).map(decision => ({ ...decision, reason: `${decision.reason} Reviewed again for a sibling revision.` })),
  })).decisions.candidate_id;
  const started = await application.startRun(OWNER, fixture.projectId, { target_candidate_id: first });
  const adopt = await http('POST', `/projects/${fixture.projectId}/runs/${started.run.run_id}/resume`, { adopt_candidate_id: sibling });
  if (first === sibling) {
    // The same accepted set is the same content-addressed revision, so this
    // case only exists when the two really are different revisions.
    assert.equal(adopt.body.operation, 'succeeded');
  } else {
    assert.equal(adopt.body.error?.code, 'INVALID_REQUEST', JSON.stringify(adopt.body).slice(0, 300));
    assert.match(adopt.body.error.message, /does not descend from the candidate this run is currently on/);
    assert.equal((await application.getRun(OWNER, fixture.projectId, started.run.run_id)).run.candidate_id, first);
  }

  // A candidate id that does not exist is not found, whatever it looks like.
  const missing = await http('POST', `/projects/${fixture.projectId}/runs/${started.run.run_id}/resume`, { adopt_candidate_id: `g11d:rev:${'1'.repeat(64)}` });
  assert.equal(missing.body.error?.code, 'CANDIDATE_NOT_FOUND');
});

// ─── compatibility and honest capabilities ──────────────────────────────────

test('the run tools are advertised with the same discipline as the rest of the surface', async () => {
  const runTools = STUDIO_MCP_TOOLS.filter(tool => tool.name.startsWith('studio_run_'));
  assert.deepEqual(runTools.map(tool => tool.name), ['studio_run_plan', 'studio_run_start', 'studio_run_status', 'studio_run_resume']);

  for (const tool of runTools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown properties`);
    // No tool carries bytes, and none carries unbounded text.
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(!/(^|_)(bytes|base64|content|file|data|blob|audio_data)$/.test(name), `${tool.name}.${name} looks like a byte carrier`);
      assert.ok(schema.type !== 'string' || (schema.maxLength ?? 0) <= 2048, `${tool.name}.${name} allows too much inline text`);
    }
  }
  // The two read-only tools are annotated read-only; the two that write are not.
  assert.equal(runTools[0].annotations.readOnlyHint, true);
  assert.equal(runTools[2].annotations.readOnlyHint, true);
  assert.equal(runTools[1].annotations.readOnlyHint, false);
  assert.equal(runTools[3].annotations.readOnlyHint, false);
  // The descriptions say the things an agent cannot otherwise learn.
  const text = runTools.map(tool => `${tool.description}${JSON.stringify(tool.inputSchema)}`).join('\n');
  for (const fact of ['idempotency_key', 'expected_run_revision', 'adopt_candidate_id', 'reconcile', 'IN_GAME_ACCEPTED', 'Gate 8']) {
    assert.ok(text.includes(fact), `${fact} must be discoverable from tools/list`);
  }
  // And no provider is named anywhere in them.
  for (const provider of ['openai', 'anthropic', 'gemini', 'chatgpt', 'claude', 'codex', 'gpt-4', 'llm']) {
    assert.ok(!text.toLowerCase().includes(provider), `the surface must not mention ${provider}`);
  }
});

test('capabilities gained a run without gaining a capability it does not have', async () => {
  const { http } = transports();
  const caps = (await http('GET', '/capabilities')).body;

  assert.deepEqual(caps.runs.operations, ['planRun', 'startRun', 'getRun', 'resumeRun']);
  assert.deepEqual(caps.runs.read_only_operations, ['planRun', 'getRun']);
  assert.equal(caps.runs.execution_mode, 'bounded-synchronous-advancement');
  assert.match(caps.runs.execution_notice, /no background queue, no worker pool, no timer and no automatic restart/);
  for (const [name, expected] of [
    ['runs.background_execution', false], ['runs.automatic_continuation', false],
    ['runs.cancellation', false], ['runs.cross_process_run_coordination', false],
  ]) assert.equal(caps.runs[name.split('.')[1]], expected, `${name} must be ${expected}`);
  for (const name of ['background_execution', 'job_cancellation']) assert.equal(caps.jobs[name], false, `jobs.${name} must stay false`);
  for (const name of ['audio_to_midi', 'source_separation', 'vocal_isolation', 'exact_pitch_transcription_from_audio', 'in_game_test', 'automatic_run_continuation', 'cross_process_run_coordination']) {
    assert.equal(caps.capabilities[name], false, `${name} must be false`);
  }
  assert.equal(caps.capabilities.one_click_run_orchestration, true);
  // The cost and privacy position is unchanged: no provider, no paid service.
  assert.equal(caps.cost.llm_api_dependency, 'NONE');
  assert.equal(caps.cost.external_paid_services, 'NONE');
  assert.equal(caps.privacy.calls_external_analysis_services, false);
  // in_game is still the one axis nothing here can set.
  assert.deepEqual(caps.gates.never_settable_by_this_service, ['in_game']);
  assert.ok(caps.runs.refuses.some(entry => entry.includes('no-op revision')));
  assert.ok(caps.runs.refuses.some(entry => entry.includes('readiness blocker it does not recognise')));
});

test('the existing routes and tools still answer exactly as before', async () => {
  const { application, http, mcp } = transports();
  // A route added beside them must not shadow one of them: every pre-existing
  // studio route is still reached, with its own operation's own answer.
  const project = (await http('POST', '/projects', { title: 'Compatibility' })).body.project;
  const id = project.project_id;
  for (const [method, path, payload, expected] of [
    ['GET', `/projects/${id}`, undefined, null],
    ['GET', `/projects/${id}/assets`, undefined, null],
    ['GET', `/projects/${id}/jobs`, undefined, null],
    ['POST', `/projects/${id}/intake`, {}, 'SOURCE_INCOMPLETE'],
    ['POST', `/projects/${id}/arrangement/suggest`, {}, 'SOURCE_INCOMPLETE'],
    ['POST', `/projects/${id}/review`, {}, 'CANDIDATE_NOT_FOUND'],
    ['POST', `/projects/${id}/finalize`, {}, 'CANDIDATE_NOT_FOUND'],
    ['POST', `/projects/${id}/core3/approvals`, {}, 'CANDIDATE_NOT_FOUND'],
    ['POST', `/projects/${id}/lead-evidence/reviews`, {}, 'CANDIDATE_NOT_FOUND'],
    // These two load the Source-Faithful Baseline before they look at the
    // candidate, so a project with no baseline answers about the baseline.
    ['POST', `/projects/${id}/final-reduction/plan`, {}, 'SOURCE_INCOMPLETE'],
    ['POST', `/projects/${id}/mobile-adaptation/plan`, {}, 'SOURCE_INCOMPLETE'],
  ]) {
    const { body } = await http(method, path, payload);
    assert.equal(body.error?.code ?? null, expected, `${method} ${path}: ${JSON.stringify(body.error ?? {}).slice(0, 160)}`);
  }
  // The Canonical technical validation still routes to the Canonical engine.
  const technical = await http('POST', '/technical/validate', { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' });
  assert.equal(technical.status, 200);
  assert.equal(technical.body.technical_ok, true);
  // And the pre-existing MCP tools still dispatch.
  assert.ok((await mcp('studio_capabilities')).structuredContent.interface);
  assert.ok((await mcp('studio_project_get')).structuredContent.projects);
  // An unrouted path under /runs is still a 404 rather than a run operation.
  assert.equal((await http('POST', `/projects/${id}/runs/${'run_' + '0'.repeat(32)}/resume/extra`, {})).body.error?.code, 'NOT_FOUND');
});

test('a run accounts for every source event it delivered, with no silent music loss', async () => {
  const { application } = transports();
  const project = sixRoleBaseline();
  const fixture = await projectWithSymbolicAsset(application, OWNER, { project });
  const started = await application.startRun(OWNER, fixture.projectId, {
    asset_ids: [fixture.assetId], decisions: runDecisionsFor(project), accepted_by: RUN_REVIEWER, confirmations: FIXTURE_CONFIRMATIONS,
  });
  assert.equal(started.run.state, 'completed', JSON.stringify(started.run.blockers));

  // Every source note the baseline holds is a note in the delivered MML. The
  // mapping is checked by count per role against the emitter's own role report,
  // so a role that lost material cannot hide behind a total that still adds up.
  const baselineEvents = await application.listBaselineEvents(OWNER, fixture.projectId, { limit: 500 });
  const sourceNotes = baselineEvents.events.filter(event => event.kind === 'note');
  assert.equal(sourceNotes.length, 18);
  const perRole = sourceNotes.reduce((counts, event) => ({ ...counts, [event.role]: (counts[event.role] ?? 0) + 1 }), {});

  const artifact = (await application.getArtifact(OWNER, started.run.final_artifact_id)).artifact;
  for (const role of artifact.roles) {
    assert.equal(role.attacks, perRole[role.role] ?? 0, `${role.role} delivered ${role.attacks} of ${perRole[role.role] ?? 0} source attacks`);
    assert.equal(role.empty, (perRole[role.role] ?? 0) === 0, `${role.role} empty flag disagrees with its source material`);
  }
  assert.equal(artifact.roles.reduce((total, role) => total + role.attacks, 0), sourceNotes.length);
  // The emitter's own round-trip re-parsed that string and matched attack
  // identity per role, so the counts above are not a serialization coincidence.
  assert.equal(artifact.round_trip.status, 'PASS', JSON.stringify(artifact.round_trip));
  // The run report names the exact candidate and artifact, so the accounting is
  // about this delivery rather than about whatever else the project holds.
  const report = (await application.getArtifact(OWNER, started.run.report_artifact_id)).artifact;
  assert.equal(report.final_candidate_id, started.run.candidate_id);
  assert.equal(report.final_artifact_id, started.run.final_artifact_id);
});

// A deeply nested value, for the structure bound.
function nest(depth) {
  let value = { id: 'deep' };
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

// ─── the input contract is one contract, per operation ──────────────────────
//
// A union of every run field, applied to every run operation, lets one
// transport admit what another rejects and lets a caller send a field the
// operation does not read. These lock the two surfaces to one set per
// operation and to one constant per bound, field for field, in both directions.

const runTool = name => STUDIO_MCP_TOOLS.find(entry => entry.name === name);
const declaredKeys = (name, ...transportOnly) => Object.keys(runTool(name).inputSchema.properties)
  .filter(key => !transportOnly.includes(key)).sort();

test('each run operation accepts exactly one set of fields, on both transports', async () => {
  // What MCP declares and what the service accepts are the same set, per
  // operation — so neither surface can drift without this failing.
  assert.deepEqual(declaredKeys('studio_run_plan', 'project_id'), [...PLAN_INPUT_KEYS].sort());
  assert.deepEqual(declaredKeys('studio_run_start', 'project_id'), [...START_INPUT_KEYS].sort());
  assert.deepEqual(declaredKeys('studio_run_resume', 'project_id', 'run_id'), [...RESUME_INPUT_KEYS].sort());

  // And the sets differ in the ways the operations differ, rather than being
  // one union three times.
  assert.equal(PLAN_INPUT_KEYS.includes('idempotency_key'), false, 'a read-only plan writes nothing');
  assert.equal(START_INPUT_KEYS.includes('expected_run_revision'), false, 'a run that does not exist has no revision');
  assert.equal(START_INPUT_KEYS.includes('adopt_candidate_id'), false, 'a new run has no interrupted step');
  assert.equal(RESUME_INPUT_KEYS.includes('target_candidate_id'), false, 'a resume adopts, it does not target');

  const { http, mcp } = transports();
  const fixture = await projectWithSymbolicAsset(createStudioApplication({}), OWNER, { project: sixRoleBaseline() });
  const project = (await http('POST', '/projects', { title: 'Field contract' })).body.project;

  // A field the operation does not read is refused rather than silently
  // ignored — over HTTP, which has no schema in front of it.
  const planned = await http('POST', `/projects/${project.project_id}/runs/plan`, { reconcile: true });
  assert.equal(planned.status, 400);
  assert.equal(planned.body.error.code, 'INVALID_REQUEST');
  assert.match(planned.body.error.message, /not an accepted field/);

  const started = await http('POST', `/projects/${project.project_id}/runs`, { adopt_candidate_id: `g11d:rev:${'a'.repeat(64)}` });
  assert.equal(started.status, 400);
  assert.equal(started.body.error.code, 'INVALID_REQUEST');

  const created = await http('POST', `/projects/${project.project_id}/runs`, {});
  const runId = created.body.run.run_id;
  const resumed = await http('POST', `/projects/${project.project_id}/runs/${runId}/resume`, { target_candidate_id: `g11d:rev:${'a'.repeat(64)}` });
  assert.equal(resumed.status, 400, 'target_candidate_id is not a resume field, and is not a silent no-op either');
  assert.equal(resumed.body.error.code, 'INVALID_REQUEST');

  // The same payload over MCP is refused too, rather than reaching the service
  // and being dropped there.
  const overMcp = await mcp('studio_run_resume', { project_id: project.project_id, run_id: runId, target_candidate_id: `g11d:rev:${'a'.repeat(64)}` });
  assert.ok(overMcp === undefined || overMcp.isError === true, String(JSON.stringify(overMcp)).slice(0, 200));
  assert.ok(fixture.assetId);
});

test('every shared bound is one constant, and both surfaces sit on it', async () => {
  const properties = runTool('studio_run_resume').inputSchema.properties;
  const planProperties = runTool('studio_run_plan').inputSchema.properties;

  // Declared bounds are the service's own constants, not a second copy.
  assert.equal(properties.asset_ids.maxItems, LIMITS.maxAssetsPerProject);
  assert.equal(properties.meter_text.maxLength, LIMITS.maxMeterTextLength);
  assert.equal(properties.decisions.maxItems, LIMITS.maxDecisionsPerRequest);
  assert.equal(properties.idempotency_key.maxLength, LIMITS.maxIdempotencyKeyLength);
  assert.equal(properties.expected_run_revision.maximum, LIMITS.maxRunRevision);
  assert.equal(planProperties.asset_ids.maxItems, LIMITS.maxAssetsPerProject);
  assert.equal(planProperties.meter_text.maxLength, LIMITS.maxMeterTextLength);

  // The minima MCP declares are minima the service enforces, so an empty value
  // is not accepted on one surface and rejected on the other.
  assert.equal(properties.asset_ids.minItems, 1);
  assert.equal(properties.meter_text.minLength, 1);
  assert.equal(properties.decisions.minItems, 1);
  assert.equal(properties.expected_run_revision.minimum, 1);

  const { http } = transports();
  const project = (await http('POST', '/projects', { title: 'Boundaries' })).body.project;
  const plan = payload => http('POST', `/projects/${project.project_id}/runs/plan`, payload);
  const refused = async (payload, what) => {
    const response = await plan(payload);
    assert.equal(response.status, 400, `${what} must be refused: ${JSON.stringify(response.body).slice(0, 200)}`);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  };

  // empty
  await refused({ asset_ids: [] }, 'an empty asset selection');
  await refused({ meter_text: '' }, 'an explicitly empty meter map');
  await refused({ decisions: [] }, 'an empty decision set');

  // exact max passes normalisation (it may still fail on what the ids resolve
  // to, which is a different answer from "this request is malformed"), and one
  // over is refused as malformed.
  const asset = 'a'.repeat(36);
  const atCap = await plan({ asset_ids: Array.from({ length: LIMITS.maxAssetsPerProject }, (_, index) => `${asset.slice(0, 32)}${String(index).padStart(4, '0')}`) });
  assert.notEqual(atCap.body.error?.code, 'INVALID_REQUEST', 'the cap itself is accepted');
  await refused({ asset_ids: Array.from({ length: LIMITS.maxAssetsPerProject + 1 }, () => asset) }, 'one asset over the cap');
  const atMeter = await plan({ meter_text: '4'.repeat(LIMITS.maxMeterTextLength) });
  assert.notEqual(atMeter.body.error?.code, 'INVALID_REQUEST', 'the meter cap itself is accepted');
  await refused({ meter_text: '4'.repeat(LIMITS.maxMeterTextLength + 1) }, 'one character over the meter cap');

  // the revision bound, on the operation that has one
  const created = await http('POST', `/projects/${project.project_id}/runs`, {});
  const runId = created.body.run.run_id;
  const resume = payload => http('POST', `/projects/${project.project_id}/runs/${runId}/resume`, payload);
  assert.notEqual((await resume({ expected_run_revision: LIMITS.maxRunRevision })).body.error?.code, 'INVALID_REQUEST');
  const overMax = await resume({ expected_run_revision: LIMITS.maxRunRevision + 1 });
  assert.equal(overMax.status, 400);
  assert.equal(overMax.body.error.code, 'INVALID_REQUEST');
  const underMin = await resume({ expected_run_revision: 0 });
  assert.equal(underMin.status, 400);
  assert.equal(underMin.body.error.code, 'INVALID_REQUEST');
});
