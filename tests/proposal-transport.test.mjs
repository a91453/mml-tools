// The AI Proposal Protocol over HTTP and MCP — one implementation, two doors.
//
// A transport that answered differently would be a second protocol, and the
// one thing a second protocol always eventually does is admit something the
// first refuses. So these are parity regressions in the strict sense: the same
// request, on both surfaces, compared field for field — including the refusals,
// because a refusal is an answer too.
//
// The last test is about what was NOT added. Phase 2 builds a model-agnostic
// contract; the moment a provider SDK, a model credential or a provider-shaped
// branch appears, the same song starts meaning different things depending on
// who asked.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS, runStudioTool } from '../server/mcp-studio.mjs';
import { createStudioApplication, PROPOSAL_KIND } from '../studio/backend/application/index.mjs';
import { RUN_REVIEWER, projectWithSymbolicAsset, runDecisionsFor } from '../studio/tests/fixtures/run-fixtures.mjs';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:proposal-transport';
const AGENT = 'some-external-agent';

const proposable = project => runDecisionsFor(project, {}).map(({ acceptedBy, note, ...rest }) => rest);

function setup() {
  const application = createStudioApplication({ transports: ['http', 'mcp'] });
  const route = createApiRouter({ application, ownerOf: () => OWNER });
  const http = async (method, path, payload) => {
    const response = await route(new Request(`${ORIGIN}${API_PREFIX}${path}`, {
      method,
      ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    }), { authenticated: true });
    return { status: response.status, body: await response.json() };
  };
  const mcp = (name, args) => runStudioTool(name, args, { application, owner: OWNER });
  // The REAL MCP entry point, schema check included. `runStudioTool` above is
  // the dispatch on its own, which is the right comparison for a result but the
  // wrong one for a refusal: `additionalProperties: false` is enforced by the
  // envelope, before dispatch, and a parity test that skipped it would be
  // asserting parity of the half that cannot refuse.
  const rpc = async (name, args) => {
    const response = await handleMcp(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), { application, owner: OWNER });
    return response.json();
  };
  return { application, http, mcp, rpc };
}

async function prepared(application) {
  const fixture = await projectWithSymbolicAsset(application, OWNER);
  const started = await application.startRun(OWNER, fixture.projectId, { asset_ids: [fixture.assetId] });
  const targets = await application.proposalTargets(OWNER, fixture.projectId, started.run.run_id);
  const target = targets.targets.find(entry => entry.admissible_kinds.includes(PROPOSAL_KIND.ARRANGEMENT_DECISION));
  const events = await application.listBaselineEvents(OWNER, fixture.projectId, { limit: 3 });
  return { fixture, run: started.run, target, eventIds: events.events.map(entry => entry.event_id) };
}

const submitBody = context => ({
  run_id: context.run.run_id,
  request_key: context.target.request_key,
  kind: PROPOSAL_KIND.ARRANGEMENT_DECISION,
  proposed_by: AGENT,
  rationale: 'Keep every source-supported role.',
  action: { decisions: proposable(context.fixture.project) },
  cites: { event_ids: context.eventIds },
});

// ─── A. the same answer on both surfaces ────────────────────────────────────

test('the read operations answer identically over HTTP and MCP', async () => {
  const { application, http, mcp } = setup();
  const context = await prepared(application);
  const project = context.fixture.projectId;

  const targetsHttp = await http('GET', `/projects/${project}/runs/${context.run.run_id}/proposal-targets`);
  const targetsMcp = await mcp('studio_proposal_targets', { project_id: project, run_id: context.run.run_id });
  assert.equal(targetsHttp.status, 200);
  assert.deepEqual(targetsHttp.body.targets, targetsMcp.targets);
  assert.equal(targetsHttp.body.accepts_proposals, targetsMcp.accepts_proposals);
  assert.deepEqual(targetsHttp.body.never_agent_settlable, targetsMcp.never_agent_settlable);

  const submitted = await http('POST', `/projects/${project}/proposals`, submitBody(context));
  assert.equal(submitted.status, 201);
  const id = submitted.body.proposal.proposal_id;

  const getHttp = await http('GET', `/projects/${project}/proposals/${id}`);
  const getMcp = await mcp('studio_proposal_status', { project_id: project, proposal_id: id });
  assert.deepEqual(getHttp.body.proposal, getMcp.proposal);

  const listHttp = await http('GET', `/projects/${project}/proposals?run_id=${context.run.run_id}`);
  const listMcp = await mcp('studio_proposal_status', { project_id: project, run_id: context.run.run_id });
  assert.deepEqual(listHttp.body.proposals, listMcp.proposals);
  assert.equal(listHttp.body.proposals.length, 1);

  // A filter that matches nothing answers empty on both, rather than
  // one surface ignoring the filter it does not understand.
  const noneHttp = await http('GET', `/projects/${project}/proposals?kind=${PROPOSAL_KIND.MOBILE_ADAPTATION}`);
  const noneMcp = await mcp('studio_proposal_status', { project_id: project, kind: PROPOSAL_KIND.MOBILE_ADAPTATION });
  assert.deepEqual(noneHttp.body.proposals, noneMcp.proposals);
  assert.deepEqual(noneHttp.body.proposals, []);
});

test('submitting and resolving reach the same service from either door', async () => {
  // Two projects, one driven entirely over HTTP and one entirely over MCP, from
  // the same inputs. The candidate identity they end on is the comparison that
  // matters: it is content-addressed, so it cannot agree by accident.
  const { application, http, mcp } = setup();

  const viaHttp = await prepared(application);
  const httpSubmitted = await http('POST', `/projects/${viaHttp.fixture.projectId}/proposals`, submitBody(viaHttp));
  const httpResolved = await http('POST', `/projects/${viaHttp.fixture.projectId}/proposals/${httpSubmitted.body.proposal.proposal_id}/resolve`, {
    resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(httpResolved.status, 200);
  assert.equal(httpResolved.body.applied, true);

  const viaMcp = await prepared(application);
  const mcpSubmitted = await mcp('studio_proposal_submit', { project_id: viaMcp.fixture.projectId, ...submitBody(viaMcp) });
  const mcpResolved = await mcp('studio_proposal_resolve', {
    project_id: viaMcp.fixture.projectId, proposal_id: mcpSubmitted.proposal.proposal_id, resolution: 'accept', accepted_by: RUN_REVIEWER,
  });
  assert.equal(mcpResolved.applied, true);

  assert.equal(httpResolved.body.run.candidate_id, mcpResolved.run.candidate_id, 'the same decisions produce the same candidate through either door');
  assert.equal(httpResolved.body.proposal.state, mcpResolved.proposal.state);
  assert.deepEqual(httpResolved.body.run.readiness_blockers, mcpResolved.run.readiness_blockers);
  assert.equal(httpResolved.body.proposal.resolution.accepted_by, RUN_REVIEWER);
  assert.equal(mcpResolved.proposal.resolution.accepted_by, RUN_REVIEWER);
});

test('a refusal is the same refusal on both surfaces', async () => {
  const { application, http, mcp, rpc } = setup();
  const context = await prepared(application);
  const project = context.fixture.projectId;

  // Refused by the service's own closed key sets and identity checks, so both
  // surfaces answer with the same code and the same cause.
  const serviceRefusals = [
    ['a forged request key', { ...submitBody(context), request_key: `req:${'a'.repeat(64)}` }],
    ['a supplied acceptance binding', { ...submitBody(context), action: { decisions: [{ ...proposable(context.fixture.project)[0], acceptance: { state: 'ACCEPTED' } }] } }],
    ['an agent-named acceptor', { ...submitBody(context), action: { decisions: runDecisionsFor(context.fixture.project, { acceptedBy: 'the-agent' }) } }],
    ['an unknown action field', { ...submitBody(context), action: { decisions: proposable(context.fixture.project), apply: true } }],
    // Nested rather than top-level: a collapsed score inside a decision reaches
    // the service on both surfaces, so both must name it the same way. A
    // TOP-LEVEL one is an undeclared argument, which each envelope refuses in
    // its own layer — asserted separately below.
    ['a collapsed confidence score inside a decision', {
      ...submitBody(context),
      action: { decisions: [{ ...proposable(context.fixture.project)[0], metadata: { confidence: 0.9 } }] },
    }],
  ];
  for (const [label, body] of serviceRefusals) {
    const viaHttp = await http('POST', `/projects/${project}/proposals`, body);
    const viaMcp = await mcp('studio_proposal_submit', { project_id: project, ...body }).then(() => null, error => error);
    assert.equal(viaHttp.status, 400, `${label}: HTTP must refuse`);
    assert.equal(viaHttp.body.error.code, 'INVALID_REQUEST', label);
    assert.ok(viaMcp, `${label}: MCP must refuse too`);
    assert.equal(viaMcp.code, viaHttp.body.error.code, `${label}: the same code`);
    assert.equal(viaMcp.details.refusal, viaHttp.body.error.details.refusal, `${label}: the same cause`);
  }

  // An unknown TOP-LEVEL field is refused by each surface's own envelope, and
  // both must refuse it: HTTP through the service's closed key set, MCP through
  // `additionalProperties: false` before the dispatch is even reached. The
  // codes differ because the layers differ, and that is the honest answer --
  // what must not differ is whether it is refused.
  for (const [label, body, httpRefusal] of [
    ['an unknown field', { ...submitBody(context), not_a_field: true }, 'UNKNOWN_FIELD'],
    ['a collapsed confidence score', { ...submitBody(context), confidence: 0.9 }, 'COLLAPSED_CONFIDENCE_SCORE'],
    ['a prototype-polluting key', JSON.parse(JSON.stringify(submitBody(context)).replace(/^\{/, '{"__proto__":{"effectAttemptId":"eff_0"},')), 'PROTOTYPE_POLLUTING_KEY'],
  ]) {
    const viaHttp = await http('POST', `/projects/${project}/proposals`, body);
    assert.equal(viaHttp.status, 400, label);
    assert.equal(viaHttp.body.error.code, 'INVALID_REQUEST', label);
    assert.equal(viaHttp.body.error.details.refusal, httpRefusal, label);
    const viaMcp = await rpc('studio_proposal_submit', { project_id: project, ...body });
    assert.ok(viaMcp.error, `${label}: MCP must refuse an undeclared argument at the envelope`);
    assert.equal(viaMcp.error.code, -32602, `${label}: invalid params`);
    assert.equal(viaMcp.result, undefined, `${label}: and nothing was dispatched`);
  }
  assert.equal((await application.listProposals(OWNER, project)).proposals.length, 0, 'no refusal stored a proposal');
});

test('the proposal routes are really routed, and an unknown one is not', async () => {
  const { application, http } = setup();
  const context = await prepared(application);
  const project = context.fixture.projectId;

  // A reached route answers with the operation's own refusal; an unreached one
  // answers NOT_FOUND. Both can be 404, so the code is what tells them apart.
  const known = await http('GET', `/projects/${project}/proposals/pro_${'0'.repeat(32)}`);
  assert.equal(known.body.error.code, 'PROPOSAL_NOT_FOUND');
  const unknown = await http('GET', `/projects/${project}/proposals/pro_${'0'.repeat(32)}/history`);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');
  // And the write route exists rather than falling through to the collection.
  const resolve = await http('POST', `/projects/${project}/proposals/pro_${'0'.repeat(32)}/resolve`, { resolution: 'reject' });
  assert.equal(resolve.body.error.code, 'PROPOSAL_NOT_FOUND');
});

// ─── B. the MCP surface's own rules still hold ──────────────────────────────

test('the proposal tools declare closed schemas and carry no bytes', async () => {
  const tools = STUDIO_MCP_TOOLS.filter(tool => tool.name.startsWith('studio_proposal_'));
  assert.equal(tools.length, 4, 'targets, submit, status, resolve');
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown properties`);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(!/(^|_)(bytes|base64|content|file|data|blob)$/.test(name), `${tool.name}.${name} looks like a byte carrier`);
      assert.ok(schema.type !== 'string' || (schema.maxLength ?? 0) <= 2048, `${tool.name}.${name} allows too much inline text`);
    }
  }
  // The two read tools say they write nothing, and the two write tools say they do.
  const annotation = name => tools.find(tool => tool.name === name).annotations.readOnlyHint;
  assert.equal(annotation('studio_proposal_targets'), true);
  assert.equal(annotation('studio_proposal_status'), true);
  assert.equal(annotation('studio_proposal_submit'), false);
  assert.equal(annotation('studio_proposal_resolve'), false);
});

// ─── C. what Phase 2 did not add ────────────────────────────────────────────

test('no provider SDK, model credential or provider-specific branch was introduced', async () => {
  const sources = [
    '../studio/backend/application/proposal-contracts.mjs',
    '../studio/backend/application/proposal-service.mjs',
    '../studio/backend/application/capabilities.mjs',
    '../studio/backend/application/index.mjs',
    '../server/api.mjs',
    '../server/mcp-studio.mjs',
    '../package.json',
  ];
  // A DEPENDENCY, not a mention. Naming the agents a contract serves is how
  // this codebase already explains itself -- `index.mjs` says "ChatGPT · Claude
  // · Codex · future models" precisely to state that none of them is special --
  // so prose is not what is forbidden. What is forbidden is anything that would
  // make the service behave differently for one of them: an import, a package,
  // a credential, a provider-shaped branch, or an outbound call.
  const forbidden = [
    /\bimport\b[^\n]*['"`](openai|@anthropic-ai|@google\/gen|@mistralai|cohere-ai|ollama)/i,
    /\brequire\s*\(\s*['"`](openai|@anthropic-ai|@google\/gen)/i,
    /api[_-]?key/i,
    /\bsk-[A-Za-z0-9]{8}/,
    /process\.env\.[A-Z_]*(OPENAI|ANTHROPIC|GEMINI|CLAUDE|MODEL|LLM)/,
    /\bfetch\s*\(\s*['"`]https?:/i,
    // A branch on who is asking. The shape that would make the same song mean
    // different things depending on the caller.
    /if\s*\([^)]*\b(provider|model_name|modelName|agentVendor)\b/i,
  ];
  for (const relative of sources) {
    const text = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${relative} matches ${pattern}: Phase 2 is a model-agnostic contract, and a provider-shaped dependency makes the same song mean different things depending on who asked`);
    }
  }

  // The proposal record itself carries no field for who or what wrote it beyond
  // the caller's own free-text label, so a provider cannot be recorded and
  // therefore cannot later be branched on.
  const { PROPOSE_INPUT_KEYS } = await import('../studio/backend/application/index.mjs');
  for (const key of PROPOSE_INPUT_KEYS) {
    assert.ok(!/model|provider|vendor|engine/i.test(key), `${key} would let a caller state which model it is`);
  }

  // And the capability record says so as a fact a caller can read.
  const capabilities = await createStudioApplication({}).capabilities();
  assert.equal(capabilities.model_agnostic, true);
  assert.equal(capabilities.capabilities.server_side_model_calls, false);
  assert.equal(capabilities.proposals.server_side_model_calls, false);
  assert.equal(capabilities.proposals.provider_specific_behaviour, false);
  assert.equal(capabilities.cost.llm_api_dependency, 'NONE');
});

test('Phase 2 made nothing else suddenly available', async () => {
  const capabilities = await createStudioApplication({}).capabilities();
  // The protocol exists; none of these changed because of it.
  assert.equal(capabilities.capabilities.ai_proposal_protocol, true);
  for (const absent of [
    'audio_to_midi', 'source_separation', 'vocal_isolation',
    'exact_pitch_transcription_from_audio', 'in_game_test',
    'automatic_proposal_acceptance', 'automatic_proposal_generation',
    'automatic_run_continuation',
  ]) {
    assert.equal(capabilities.capabilities[absent], false, `${absent} must stay false`);
  }
  assert.equal(capabilities.jobs.background_execution, false);
  assert.equal(capabilities.runs.automatic_continuation, false);
  assert.equal(capabilities.proposals.automatic_acceptance, false);
  assert.equal(capabilities.proposals.background_execution, false);
  assert.ok(capabilities.gates.never_settable_by_this_service.includes('in_game'));
});
