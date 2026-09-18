// MCP control surface — adapter regressions and transport parity.
//
// The MCP server is an adapter over the Application Service. These tests pin
// three things: the three original tools still behave exactly as they did, the
// `studio_*` tools carry no workflow of their own, and the same input produces
// the same semantic answer whether it arrives directly, over HTTP or over MCP.

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMcp, MCP_TOOLS, MAX_BODY_BYTES, SERVICE_VERSION } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { sixRoleBaseline, canonicalProjectBytes, keepEveryRole } from '../studio/tests/fixtures/application-fixtures.mjs';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:service';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const rpc = (body, extra = {}) => new Request(`${ORIGIN}/mcp`, {
  method: 'POST',
  headers: { ...headers, ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function mcp(application = null) {
  const context = application ? { application, owner: OWNER } : {};
  return {
    async list() {
      return (await (await handleMcp(rpc({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }), context)).json()).result.tools;
    },
    async call(name, args = {}) {
      const response = await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), context);
      return (await response.json()).result;
    },
    async initialize() {
      return (await (await handleMcp(rpc({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }), context)).json()).result;
    },
  };
}

// ─── backward compatibility ─────────────────────────────────────────────────

test('without an Application Service the surface is exactly the three original tools', async () => {
  const tools = await mcp().list();
  assert.deepEqual(tools, MCP_TOOLS);
  assert.deepEqual(tools.map(tool => tool.name), ['mml_service_info', 'mml_validate', 'mml_overlap_details']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('the three original tools keep their report shape after moving to the Application Service', async () => {
  const withoutApp = await mcp().call('mml_validate', { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' });
  const withApp = await mcp(createStudioApplication({})).call('mml_validate', { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' });

  for (const result of [withoutApp, withApp]) {
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.technical_ok, true);
    assert.equal(result.structuredContent.pair_count, 15);
    assert.equal(result.structuredContent.tracks.length, 6);
    assert.equal(result.structuredContent.changed_input, false);
    assert.equal(result.structuredContent.gates.strict_mobile_technical, 'PASS');
    assert.equal(result.structuredContent.gates.in_game_acceptance, 'PENDING');
  }
  // Attaching an Application Service must not change the legacy answer.
  assert.deepEqual(withApp.structuredContent, withoutApp.structuredContent);
});

test('mml_overlap_details still pages and still reports all fifteen pairs', async () => {
  const args = { mml: 'MML@t120o4c1,t120o4c1,,,,;', meter_text: '0 4/4' };
  const legacy = (await mcp().call('mml_overlap_details', args)).structuredContent;
  const routed = (await mcp(createStudioApplication({})).call('mml_overlap_details', args)).structuredContent;
  assert.equal(legacy.pair_count, 15);
  assert.deepEqual(routed, legacy);
});

test('service info lists the tools that are actually available', async () => {
  const withoutApp = (await mcp().call('mml_service_info')).structuredContent;
  assert.deepEqual(withoutApp.tools, ['mml_service_info', 'mml_validate', 'mml_overlap_details']);
  assert.equal(withoutApp.service_version, SERVICE_VERSION);

  const withApp = (await mcp(createStudioApplication({})).call('mml_service_info')).structuredContent;
  assert.ok(withApp.tools.includes('studio_finalize'));
  assert.match(withApp.binary_data_plane, /uploaded over HTTP, never through MCP/);
});

// ─── the studio surface ─────────────────────────────────────────────────────

test('with an Application Service the studio control surface is advertised', async () => {
  const tools = await mcp(createStudioApplication({})).list();
  assert.deepEqual(tools.slice(0, 3), MCP_TOOLS);
  assert.deepEqual(tools.slice(3), STUDIO_MCP_TOOLS);

  const names = tools.map(tool => tool.name);
  for (const expected of [
    'studio_capabilities', 'studio_project_create', 'studio_project_get', 'studio_sources_analyze',
    'studio_arrangement_suggest', 'studio_decisions_apply', 'studio_candidate_review',
    'studio_finalize', 'studio_job_status', 'studio_artifact_get',
  ]) {
    assert.ok(names.includes(expected), `${expected} must be advertised`);
  }

  // A high-level surface, not one tool per backend function.
  for (const leaked of ['midi_file', 'role_candidates', 'readiness', 'technical_timing_repair', 'mml_emitter', 'micro_gap']) {
    assert.ok(!names.some(name => name.includes(leaked)), `${leaked} is an implementation detail and must not be a tool`);
  }
  assert.ok(tools.length < 16, 'the surface must stay small enough for a model to reason about');
});

test('studio tool schemas are closed and carry no file content field', async () => {
  for (const tool of STUDIO_MCP_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown properties`);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(!/(^|_)(bytes|base64|content|file|data|blob|audio_data)$/.test(name), `${tool.name}.${name} looks like a byte carrier`);
      assert.ok(schema.type !== 'string' || (schema.maxLength ?? 0) <= 2048, `${tool.name}.${name} allows too much inline text`);
    }
  }
});

test('the studio tools describe themselves without naming any model provider', async () => {
  const text = JSON.stringify(STUDIO_MCP_TOOLS) + JSON.stringify(await mcp(createStudioApplication({})).initialize());
  for (const provider of ['openai', 'anthropic', 'gemini', 'chatgpt', 'claude', 'codex', 'gpt-4', 'llm']) {
    assert.ok(!text.toLowerCase().includes(provider), `the surface must not mention ${provider}`);
  }
});

test('server instructions tell an agent how to get bytes into a project', async () => {
  const withApp = await mcp(createStudioApplication({})).initialize();
  assert.match(withApp.instructions, /studio_capabilities/);
  assert.match(withApp.instructions, /never through MCP/);
  assert.match(withApp.instructions, /nothing you can call sets in_game/);

  const withoutApp = await mcp().initialize();
  assert.match(withoutApp.instructions, /Only technical MML checks/);
});

test('a studio tool refuses an unknown argument and a malformed identifier', async () => {
  const surface = mcp(createStudioApplication({}));
  const bad = await handleMcp(rpc({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'studio_project_get', arguments: { project_id: 'prj_00000000000000000000000000000000', extra: 1 } },
  }), { application: createStudioApplication({}), owner: OWNER });
  assert.equal((await bad.json()).error.code, -32602);

  const missing = await surface.call('studio_project_get', { project_id: 'prj_00000000000000000000000000000000' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'PROJECT_NOT_FOUND');
});

test('a structured refusal keeps its code so an agent does not retry the wrong thing', async () => {
  const application = createStudioApplication({});
  const surface = mcp(application);
  const projectId = (await surface.call('studio_project_create', { title: 'Codes' })).structuredContent.project.project_id;
  const result = await surface.call('studio_sources_analyze', { project_id: projectId });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'SOURCE_INCOMPLETE');
  assert.ok(result.structuredContent.error.message.length > 0);
});

test('MCP cannot carry a file: a large inline payload is refused by the body ceiling', async () => {
  const application = createStudioApplication({});
  // A modest recording base64-encoded is already far past the ceiling.
  const oversized = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'studio_decisions_apply', arguments: { project_id: 'prj_00000000000000000000000000000000', decisions: ['A'.repeat(MAX_BODY_BYTES)] } },
  });
  const response = await handleMcp(rpc(oversized), { application, owner: OWNER });
  assert.equal(response.status, 413);
});

test('a passthrough payload cannot smuggle a prototype', async () => {
  const application = createStudioApplication({});
  const response = await handleMcp(rpc(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"studio_decisions_apply","arguments":{"project_id":"prj_00000000000000000000000000000000","decisions":[{"__proto__":{"polluted":true}}]}}}`), { application, owner: OWNER });
  assert.equal((await response.json()).error.code, -32602);
  assert.equal({}.polluted, undefined);
});

test('studio_capabilities answers even when Published Canonical is unavailable', async () => {
  const application = createStudioApplication({ loadEngines: async () => { throw Error('no published history'); } });
  const result = await mcp(application).call('studio_capabilities');
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.canonical.status, 'CANONICAL_NOT_LOADED');
  assert.equal(result.structuredContent.canonical.legacy_fallback_allowed, false);
});

// ─── transport parity ───────────────────────────────────────────────────────

/** Run the same fixture through one transport and return the semantic result. */
async function walk(runner) {
  const project = sixRoleBaseline();
  const projectId = await runner.createProject('Parity');
  await runner.upload(projectId, canonicalProjectBytes(project));
  const baseline = await runner.intake(projectId);
  const suggestion = await runner.suggest(projectId);
  const decisions = await runner.decisions(projectId, keepEveryRole(project));
  const review = await runner.review(projectId, decisions.candidate_id);
  const finalized = await runner.finalize(projectId, decisions.candidate_id);
  const artifact = await runner.artifact(finalized.artifact_id);

  return {
    baseline_id: baseline.baseline_id,
    baseline_event_count: baseline.event_count,
    baseline_source_complete: baseline.source_complete,
    lane_count: suggestion.lane_count,
    pending_count: suggestion.pending.count,
    applied: decisions.applied,
    candidate_id: decisions.candidate_id,
    revision_index: decisions.revision_index,
    integrity_ok: review.integrity.ok,
    review_gates: review.gates,
    review_blockers: review.blockers,
    operation: finalized.operation,
    emit_status: finalized.emit_status,
    mml: finalized.mml,
    gates: finalized.gates,
    blockers: finalized.blockers,
    repair: finalized.technical_timing_repair,
    artifact_id: finalized.artifact_id,
    artifact_mml: artifact.mml,
    artifact_gates: artifact.gates,
    artifact_remaining: artifact.remaining_pending_gates,
    canonical: finalized.canonical,
  };
}

const CONFIRMATIONS = {
  source_complete: { value: true, reason: 'Complete.' },
  player_readback: { value: 'PASS', reason: 'Read back.' },
  mobile_adaptation_reviewed: { value: true, reason: 'Gate 8 reviewed.', evidence: ['transport parity Gate 8 review'] },
  original_audio_required: { value: false, reason: 'No recording.' },
};

const directRunner = application => ({
  createProject: async title => (await application.createProject(OWNER, { title })).project.project_id,
  upload: async (projectId, bytes) => application.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes }),
  intake: async projectId => (await application.analyzeSources(OWNER, projectId)).baseline,
  suggest: async projectId => (await application.suggestArrangement(OWNER, projectId)).suggestion,
  decisions: async (projectId, decisions) => (await application.applyDecisions(OWNER, projectId, { decisions })).decisions,
  review: async (projectId, candidateId) => (await application.reviewCandidate(OWNER, projectId, { candidateId })).review,
  finalize: async (projectId, candidateId) => application.finalize(OWNER, projectId, { candidateId, confirmations: CONFIRMATIONS }),
  artifact: async artifactId => (await application.getArtifact(OWNER, artifactId)).artifact,
});

const httpRunner = application => {
  const route = createApiRouter({ application, ownerOf: () => OWNER });
  const call = async (method, path, payload, extraHeaders = {}) => {
    const response = await route(new Request(`${ORIGIN}${API_PREFIX}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...extraHeaders },
      ...(payload === undefined ? {} : { body: payload instanceof Uint8Array ? payload : JSON.stringify(payload) }),
    }), { authenticated: true });
    return response.json();
  };
  return {
    createProject: async title => (await call('POST', '/projects', { title })).project.project_id,
    upload: (projectId, bytes) => call('POST', `/projects/${projectId}/assets`, bytes, { 'x-mml-asset-kind': 'canonical_project', 'x-mml-asset-filename': 'b.json' }),
    intake: async projectId => (await call('POST', `/projects/${projectId}/intake`, {})).baseline,
    suggest: async projectId => (await call('POST', `/projects/${projectId}/arrangement/suggest`, {})).suggestion,
    decisions: async (projectId, decisions) => (await call('POST', `/projects/${projectId}/decisions`, { decisions })).decisions,
    review: async (projectId, candidate_id) => (await call('POST', `/projects/${projectId}/review`, { candidate_id })).review,
    finalize: (projectId, candidate_id) => call('POST', `/projects/${projectId}/finalize`, { candidate_id, confirmations: CONFIRMATIONS }),
    artifact: async artifactId => (await call('GET', `/artifacts/${artifactId}`)).artifact,
  };
};

const mcpRunner = application => {
  const surface = mcp(application);
  const call = async (name, args) => {
    const result = await surface.call(name, args);
    assert.equal(result.isError, false, `${name} failed: ${result.content?.[0]?.text}`);
    return result.structuredContent;
  };
  return {
    createProject: async title => (await call('studio_project_create', { title })).project.project_id,
    // MCP deliberately has no upload tool: bytes arrive over HTTP. The parity
    // walk uses the same HTTP endpoint an MCP client would be told to use.
    upload: (projectId, bytes) => httpRunner(application).upload(projectId, bytes),
    intake: async projectId => (await call('studio_sources_analyze', { project_id: projectId })).baseline,
    suggest: async projectId => (await call('studio_arrangement_suggest', { project_id: projectId })).suggestion,
    decisions: async (projectId, decisions) => (await call('studio_decisions_apply', { project_id: projectId, decisions })).decisions,
    review: async (projectId, candidate_id) => (await call('studio_candidate_review', { project_id: projectId, candidate_id })).review,
    finalize: (projectId, candidate_id) => call('studio_finalize', { project_id: projectId, candidate_id, confirmations: CONFIRMATIONS }),
    artifact: async artifactId => (await call('studio_artifact_get', { artifact_id: artifactId })).artifact,
  };
};

test('direct, HTTP and MCP produce the same semantic result for one fixture', async () => {
  const direct = await walk(directRunner(createStudioApplication({})));
  const http = await walk(httpRunner(createStudioApplication({})));
  const surface = await walk(mcpRunner(createStudioApplication({})));

  // Identities are content-addressed, so they must agree across transports too:
  // the same input through a different door is the same candidate.
  assert.equal(http.baseline_id, direct.baseline_id);
  assert.equal(surface.baseline_id, direct.baseline_id);
  assert.equal(http.candidate_id, direct.candidate_id);
  assert.equal(surface.candidate_id, direct.candidate_id);
  // An artifact id is deliberately NOT expected to match: it is content
  // addressed over the artifact body, which names the project it belongs to and
  // when it was produced. Three transports here run three separate services
  // over three separate projects, so equal artifact ids would mean the identity
  // had stopped describing the artifact.
  for (const id of [direct.artifact_id, http.artifact_id, surface.artifact_id]) assert.match(id, /^art_[0-9a-f]{64}$/);

  for (const [name, result] of [['http', http], ['mcp', surface]]) {
    assert.deepEqual(result.gates, direct.gates, `${name} gates diverged`);
    assert.deepEqual(result.review_gates, direct.review_gates, `${name} review gates diverged`);
    assert.deepEqual(result.blockers, direct.blockers, `${name} blockers diverged`);
    assert.deepEqual(result.review_blockers, direct.review_blockers, `${name} review blockers diverged`);
    assert.equal(result.operation, direct.operation, `${name} operation diverged`);
    assert.equal(result.emit_status, direct.emit_status, `${name} emit status diverged`);
    assert.equal(result.mml, direct.mml, `${name} Final MML diverged`);
    assert.equal(result.artifact_mml, direct.artifact_mml, `${name} artifact MML diverged`);
    assert.deepEqual(result.artifact_gates, direct.artifact_gates, `${name} artifact gates diverged`);
    assert.deepEqual(result.artifact_remaining, direct.artifact_remaining, `${name} remaining gates diverged`);
    assert.deepEqual(result.repair, direct.repair, `${name} repair report diverged`);
    assert.equal(result.integrity_ok, direct.integrity_ok, `${name} integrity diverged`);
    assert.equal(result.lane_count, direct.lane_count, `${name} lane count diverged`);
    assert.equal(result.pending_count, direct.pending_count, `${name} pending count diverged`);
    assert.equal(result.baseline_event_count, direct.baseline_event_count, `${name} event count diverged`);
    assert.equal(result.baseline_source_complete, direct.baseline_source_complete, `${name} source completeness diverged`);
    assert.deepEqual(result.canonical, direct.canonical, `${name} Canonical provenance diverged`);
  }

  // The emitted MML is real, not an empty agreement between three nulls.
  assert.match(direct.mml, /^MML@.*;$/);
  assert.equal(direct.emit_status, 'PASS');
  assert.equal(direct.gates.in_game, 'PENDING');
});

test('a blocked finalize blocks identically on every transport', async () => {
  // The same candidate, with none of the confirmations its gates require. Every
  // transport must refuse in the same words, emit nothing and file nothing.
  const prepare = async runner => {
    const project = sixRoleBaseline();
    const projectId = await runner.createProject('Blocked');
    await runner.upload(projectId, canonicalProjectBytes(project));
    await runner.intake(projectId);
    const decisions = await runner.decisions(projectId, keepEveryRole(project));
    return { projectId, candidateId: decisions.candidate_id };
  };

  const directApp = createStudioApplication({});
  const directIds = await prepare(directRunner(directApp));
  const direct = await directApp.finalize(OWNER, directIds.projectId, { candidateId: directIds.candidateId });

  const httpApp = createStudioApplication({});
  const httpIds = await prepare(httpRunner(httpApp));
  const httpRoute = createApiRouter({ application: httpApp, ownerOf: () => OWNER });
  const http = await (await httpRoute(new Request(`${ORIGIN}${API_PREFIX}/projects/${httpIds.projectId}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidate_id: httpIds.candidateId }),
  }), { authenticated: true })).json();

  const mcpApp = createStudioApplication({});
  const mcpIds = await prepare(mcpRunner(mcpApp));
  const surface = (await mcp(mcpApp).call('studio_finalize', { project_id: mcpIds.projectId, candidate_id: mcpIds.candidateId })).structuredContent;

  assert.equal(direct.operation, 'blocked');
  assert.equal(direct.code, 'FINALIZATION_BLOCKED');
  for (const [name, result] of [['http', http], ['mcp', surface]]) {
    assert.equal(result.operation, direct.operation, `${name} operation diverged`);
    assert.equal(result.code, direct.code, `${name} code diverged`);
    assert.deepEqual(result.blockers, direct.blockers, `${name} blockers diverged`);
    assert.deepEqual(result.gates, direct.gates, `${name} gates diverged`);
    assert.equal(result.mml, null, `${name} must emit nothing`);
    assert.equal(result.artifact_id, null, `${name} must file no artifact`);
    assert.equal(result.emit_status, null, `${name} must not report an emitter verdict`);
  }
});

// ─── the advertised schema is JSON Schema ───────────────────────────────────

test('every advertised tool schema is valid JSON Schema, with no private type values', async () => {
  // `inputSchema` is handed to external MCP hosts as JSON Schema. A private
  // type value the local validator happens to understand is an interoperability
  // defect: a conforming host may reject the tool outright even though this
  // server would have accepted the call.
  const JSON_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const tools = await mcp(createStudioApplication({})).list();
  assert.ok(tools.length > MCP_TOOLS.length, 'expected the studio surface to be advertised');

  const walk = (schema, where) => {
    assert.equal(typeof schema, 'object', `${where}: schema must be an object`);
    assert.notEqual(schema, null, `${where}: schema must not be null`);
    if (schema.type !== undefined) {
      const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
      for (const type of declared) {
        assert.ok(JSON_SCHEMA_TYPES.has(type), `${where}: "${type}" is not a JSON Schema type`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, `${where}.properties.${key}`);
    if (schema.items !== undefined) walk(schema.items, `${where}.items`);
    if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
      walk(schema.additionalProperties, `${where}.additionalProperties`);
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      (schema[keyword] ?? []).forEach((child, index) => walk(child, `${where}.${keyword}[${index}]`));
    }
  };
  for (const tool of tools) walk(tool.inputSchema, tool.name);

  // The serialized form is what actually crosses the wire, so the private
  // spelling must be absent from it and not merely absent from the object tree.
  assert.ok(!JSON.stringify(tools).includes('passthrough'), 'the wire schema still carries a private type value');
});

test('structured payloads are still accepted, still bounded and still refuse prototype keys', async () => {
  const application = createStudioApplication({});
  const client = mcp(application);
  const project = (await application.createProject(OWNER, { title: 'schema' })).project;

  // Valid structured input reaches the Application Service, which answers with
  // its own vocabulary rather than a transport schema error.
  const accepted = await client.call('studio_candidate_review', {
    project_id: project.project_id,
    candidate_id: `g11d:rev:${'a'.repeat(64)}`,
    confirmations: { source_complete: { value: true, reason: 'checked against the official release' } },
  });
  assert.equal(accepted.isError, true);
  // It reached the Application Service and came back in that layer's own
  // vocabulary — this project has no baseline yet. What matters here is that
  // the transport schema did not refuse the structured payload on the way in.
  assert.equal(accepted.structuredContent.error.code, 'SOURCE_INCOMPLETE', 'the transport schema must not have refused this');

  // Prototype pollution stays refused inside the open object — at the top
  // level, nested, and inside an array item. It is refused as invalid params
  // before the tool runs at all, which is stricter than a tool-level error:
  // the Application Service never sees the value.
  const raw = async (name, args) => (await (await handleMcp(
    rpc({ jsonrpc: '2.0', id: 'proto', method: 'tools/call', params: { name, arguments: args } }),
    { application, owner: OWNER },
  )).json());

  for (const [name, args] of [
    ['studio_candidate_review', { project_id: project.project_id, candidate_id: `g11d:rev:${'a'.repeat(64)}`, confirmations: JSON.parse('{"__proto__": {"polluted": true}}') }],
    ['studio_candidate_review', { project_id: project.project_id, candidate_id: `g11d:rev:${'a'.repeat(64)}`, confirmations: JSON.parse('{"source_complete": {"constructor": {"value": true}}}') }],
    ['studio_decisions_apply', { project_id: project.project_id, decisions: [JSON.parse('{"__proto__": {"polluted": true}}')] }],
    ['studio_audio_alignment', { project_id: project.project_id, candidate_id: `g11d:rev:${'a'.repeat(64)}`, report: JSON.parse('{"nested": {"prototype": {"x": 1}}}') }],
  ]) {
    const refused = await raw(name, args);
    assert.equal(refused.result, undefined, `${name}: a forbidden key must not reach the tool`);
    assert.equal(refused.error.code, -32602);
    assert.match(refused.error.message, /forbidden property name/);
  }
  assert.equal({}.polluted, undefined, 'nothing may reach Object.prototype');
  assert.equal(Object.prototype.polluted, undefined);

  // An open object is not an escape hatch for bulk data: the body ceiling is
  // unchanged and still enforced ahead of any schema work.
  const oversize = await handleMcp(rpc('x'.repeat(MAX_BODY_BYTES + 1)), { application, owner: OWNER });
  assert.equal(oversize.status, 413);
  // A declared over-large content-length is refused without reading the body.
  const declared = await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'content-length': String(MAX_BODY_BYTES + 1) }), { application, owner: OWNER });
  assert.equal(declared.status, 413);
});

// ─── unexpected failures are not a disclosure channel ───────────────────────

test('an unexpected fault is sanitized, while a domain refusal keeps its structure', async () => {
  const secret = '/data/private/secret.sqlite';
  const application = createStudioApplication({});
  // One operation is replaced with something that throws the way an internal
  // fault does: a raw Error naming a path, with a stack.
  const faulty = Object.freeze({
    ...application,
    capabilities: async () => { throw Error(`ENOENT: no such file or directory, open '${secret}'`); },
  });

  const result = await mcp(faulty).call('studio_capabilities', {});
  assert.equal(result.isError, true);
  const serialized = JSON.stringify(result);
  assert.equal(result.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.equal(result.structuredContent.error.message, 'The request could not be completed.');
  assert.ok(!serialized.includes(secret), 'the response leaked a filesystem path');
  assert.ok(!serialized.includes('ENOENT'), 'the response leaked the raw error message');
  assert.ok(!/\bat \w+.*:\d+:\d+/.test(serialized), 'the response leaked a stack frame');
  assert.ok(!serialized.includes('node:'), 'the response leaked an internal module name');

  // A real Application Service refusal is not swept into the generic form: a
  // model has to be able to tell a blocked gate from a broken server.
  const domain = await mcp(application).call('studio_project_get', { project_id: `prj_${'0'.repeat(32)}` });
  assert.equal(domain.isError, true);
  assert.equal(domain.structuredContent.error.code, 'PROJECT_NOT_FOUND');
  assert.equal(typeof domain.structuredContent.error.details, 'object');

  // The legacy tools' own argument refusals are domain errors too, and keep
  // their exact caller-facing message.
  const legacy = await mcp(application).call('mml_validate', { mml: 'MML@t1200o4c1,,,,,;', meter_text: '0 4/4' });
  assert.equal(legacy.isError, true);
  assert.equal(legacy.structuredContent.error.code, 'INVALID_REQUEST');
  assert.match(legacy.structuredContent.error.message, /三位數安全界限/);
});
