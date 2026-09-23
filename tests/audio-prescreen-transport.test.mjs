// The audio prescreen over MCP and HTTP: tool shape, parity, size bounds,
// shadow mode, and the cost of a song-length prescreen.
//
// Renders with the synthetic in-memory bank; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleMcp } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { PAGED_REPORT_TOOLS } from '../server/report-page.mjs';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { GAME_INSTRUMENT_IDS } from '../studio/backend/audio/instruments.mjs';
import { applyKeepOnlyCandidate } from '../studio/tests/fixtures/application-fixtures.mjs';
import { syntheticSoundBank } from '../studio/tests/support/synthetic-render-bank.mjs';
import { syntheticSongMml, SYNTHETIC_METER } from '../studio/tests/support/prescreen-fixtures.mjs';

const OWNER = 'owner:prescreen-transport';
const ORIGIN = 'https://mml.example';
const MCP_RESULT_CAP = 524288;
const { bytes: BANK_BYTES, descriptor: BANK } = syntheticSoundBank();
const hash = text => createHash('sha256').update(text).digest('hex');
const tool = name => STUDIO_MCP_TOOLS.find(entry => entry.name === name);
const application = createStudioApplication({ transports: ['http', 'mcp'], audioPrescreen: { bank: BANK, bytes: BANK_BYTES } });
test.after(() => application.releaseAudioWorkers());

async function rpc(name, args, { app = application } = {}) {
  const response = await handleMcp(new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { application: app, owner: OWNER });
  const text = await response.text();
  return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

const route = createApiRouter({ application, ownerOf: () => OWNER });
async function http(method, path, payload) {
  const response = await route(new Request(`${ORIGIN}${API_PREFIX}${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), { authenticated: true });
  return { status: response.status, body: await response.json() };
}

test('APT-1 the prescreen tools say what they are: machine evidence, no gate, not the game timbre', () => {
  const prescreen = tool('studio_audio_prescreen');
  const shadow = tool('studio_prescreen_shadow_record');
  assert.equal(prescreen.annotations.readOnlyHint, true);
  assert.equal(shadow.annotations.readOnlyHint, false);
  for (const entry of [prescreen, shadow]) {
    for (const fact of ['機器證據', 'Gate 7', '玩家回讀', 'in_game', '不是遊戲音色']) assert.ok(entry.description.includes(fact), `${entry.name}: ${fact}`);
    assert.equal(entry.inputSchema.additionalProperties, false);
  }
  const alternatives = prescreen.inputSchema.properties.alternatives;
  assert.deepEqual([alternatives.minItems, alternatives.maxItems], [2, 4]);
  assert.equal(alternatives.items.additionalProperties, false);
  assert.equal(alternatives.items.properties.mml.maxLength, 16384, 'a Final is at most 6 x 2,400 characters');
  assert.deepEqual(prescreen.inputSchema.properties.instruments.items.enum, [...GAME_INSTRUMENT_IDS]);
  assert.deepEqual(shadow.inputSchema.required, ['project_id', 'entry']);
  assert.ok(PAGED_REPORT_TOOLS.has('studio_audio_prescreen'));
  assert.ok(!PAGED_REPORT_TOOLS.has('studio_prescreen_shadow_record'), 'paging never repeats a write');
});

test('APT-2 MCP refuses a malformed prescreen before it runs', async () => {
  const one = await rpc('studio_audio_prescreen', { alternatives: [{ mml: 'MML@t120o4c1,,,,,;' }], meter_text: '0 4/4' });
  assert.equal(one.body.error.code, -32602);
  const kazoo = await rpc('studio_audio_prescreen', { alternatives: [{ mml: 'MML@t120o4c1,,,,,;' }, { mml: 'MML@t120o4d1,,,,,;' }], meter_text: '0 4/4', instruments: Array(6).fill('kazoo') });
  assert.equal(kazoo.body.error.code, -32602);
  const extra = await rpc('studio_audio_prescreen', { alternatives: [{ mml: 'MML@t120o4c1,,,,,;', bytes: 'x' }, { mml: 'MML@t120o4d1,,,,,;' }], meter_text: '0 4/4' });
  assert.equal(extra.body.error.code, -32602);
  const noMeter = await rpc('studio_audio_prescreen', { alternatives: [{ mml: 'MML@t120o4c1,,,,,;' }, { mml: 'MML@t120o4d1,,,,,;' }] });
  assert.equal(noMeter.body.result.isError, true);
  assert.equal(noMeter.body.result.structuredContent.error.code, 'INVALID_REQUEST');
});

test('APT-3 MCP and HTTP return the same report for the same request', async () => {
  const base = syntheticSongMml({ bars: 4 });
  const request = { alternatives: [{ mml: base }, { mml: syntheticSongMml({ bars: 4, variant: 'crunch' }) }], meter_text: SYNTHETIC_METER, reference: { mml: base } };
  const overMcp = await rpc('studio_audio_prescreen', request);
  assert.equal(overMcp.body.result.isError, false, JSON.stringify(overMcp.body.result.structuredContent?.error ?? null));
  const overHttp = await http('POST', '/audio-prescreen', request);
  assert.equal(overHttp.status, 200);
  const mcpReport = overMcp.body.result.structuredContent.prescreen;
  assert.equal(overHttp.body.prescreen.report_id, mcpReport.report_id);
  assert.deepEqual(overHttp.body.prescreen, mcpReport, 'a small report is not compacted: byte-identical on both transports');
  assert.equal(mcpReport.schema, 'mml-studio/audio-prescreen-report@1');
  assert.ok(overHttp.body.canonical, 'the provenance envelope travels with the report');
  const refused = await http('POST', '/audio-prescreen', { alternatives: request.alternatives });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'INVALID_REQUEST');
});

test('APT-4 a 220 s six-role song with three alternatives stays inside the MCP bounds; report_page returns the full bar list', async t => {
  const base = syntheticSongMml({ bars: 110 });
  const args = {
    alternatives: [{ mml: base }, { mml: syntheticSongMml({ bars: 110, variant: 'crunch' }) }, { mml: syntheticSongMml({ bars: 110, variant: 'thin' }) }],
    meter_text: SYNTHETIC_METER,
    instruments: ['flute', 'piano', 'piano', 'harp', 'violin', 'lute'],
    reference: { mml: base },
  };
  const cpu = process.cpuUsage();
  const started = performance.now();
  const { body, bytes } = await rpc('studio_audio_prescreen', args);
  const used = process.cpuUsage(cpu);
  t.diagnostic(`220 s x 3 alternatives: wall ${Math.round(performance.now() - started)} ms, CPU ${Math.round((used.user + used.system) / 1000)} ms (all threads, synthetic bank)`);
  assert.equal(body.result.isError, false, JSON.stringify(body.result.structuredContent?.error ?? null));
  assert.ok(bytes < MCP_RESULT_CAP, `${bytes} bytes`);
  const view = body.result.structuredContent;
  assert.equal(view.prescreen.summary.bars, 110);
  assert.equal(view.prescreen.alternatives[0].duration_seconds, 220);
  assert.ok(view.response_compaction, 'a song-length report is summarized, not truncated');
  const bars = view.prescreen.bars;
  assert.equal(bars.compacted, true);
  assert.equal(bars.total, 110);
  assert.deepEqual(bars.report_page.path, ['prescreen', 'bars']);
  assert.equal(bars.report_page.tool, 'studio_audio_prescreen');
  // Page the full list back with the same arguments; the report is cached, so
  // no page re-renders anything, and the pages concatenate to the summarized list.
  let offset = 0, text = '', expected;
  do {
    const page = await rpc('studio_audio_prescreen', { ...args, report_page: { path: ['prescreen', 'bars'], offset, ...(expected ? { expected_sha256: expected } : {}) } });
    assert.ok(page.bytes < MCP_RESULT_CAP);
    const fragment = page.body.result.structuredContent.report_page;
    expected = fragment.report_sha256;
    text += fragment.json_fragment;
    offset = fragment.next_offset;
  } while (offset !== null);
  assert.equal(hash(text), bars.sha256);
  assert.equal(JSON.parse(text).length, 110);
  // The long-tail regions are human review items with the listen-link hook.
  assert.ok(Array.isArray(view.prescreen.human_review) || view.prescreen.human_review.compacted);
});

test('APT-5 shadow mode over MCP and HTTP: record a prediction, the owner\'s choice, and read agreement', async () => {
  const run = await applyKeepOnlyCandidate(application, OWNER);
  const rough = 'MML@t120o5c4c4c2,t120o4g4g4g2,t120o4e4e4e2,t120o4c4c4c2,t120o3g4g4g2,t120o3c+4c+4c+2;';
  const empty = await rpc('studio_audio_prescreen', { project_id: run.projectId });
  assert.deepEqual(empty.body.result.structuredContent.shadow.predictions, [], 'only a project id: the shadow record is read');
  const recorded = await rpc('studio_prescreen_shadow_record', { project_id: run.projectId, entry: 'prediction', alternatives: [{ candidate_id: run.candidateId }, { mml: rough }], meter_text: '0 4/4' });
  assert.equal(recorded.body.result.isError, false, JSON.stringify(recorded.body.result.structuredContent?.error ?? null));
  const prediction = recorded.body.result.structuredContent.shadow.prediction;
  const missing = await rpc('studio_prescreen_shadow_record', { project_id: run.projectId, entry: 'owner_choice', prediction_id: prediction.prediction_id, region_id: prediction.regions[0].region_id, chosen: 'A' });
  assert.equal(missing.body.result.structuredContent.error.code, 'INVALID_REQUEST', 'accepted_by is required');
  const chosen = await http('POST', `/projects/${run.projectId}/audio-prescreen/shadow`, { entry: 'owner_choice', prediction_id: prediction.prediction_id, region_id: prediction.regions[0].region_id, chosen: 'A', accepted_by: 'owner' });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body).slice(0, 300));
  const overHttp = await http('GET', `/projects/${run.projectId}/audio-prescreen/shadow`);
  const overMcp = (await rpc('studio_audio_prescreen', { project_id: run.projectId })).body.result.structuredContent;
  assert.deepEqual(overHttp.body.shadow, overMcp.shadow);
  assert.equal(overHttp.body.shadow.agreement.obvious.choices, 1);
  assert.equal(overHttp.body.shadow.agreement.obvious.agreement_rate, 1);
  // Project mode over HTTP is the same operation.
  const projectReport = await http('POST', `/projects/${run.projectId}/audio-prescreen`, { alternatives: [{ candidate_id: run.candidateId }, { mml: rough }], meter_text: '0 4/4' });
  assert.equal(projectReport.body.prescreen.report_id, prediction.report_id);
  // Nothing about the prescreen or its shadow record moved a gate.
  const review = (await application.reviewCandidate(OWNER, run.projectId, { candidateId: run.candidateId })).review;
  assert.equal(review.gates.in_game, 'PENDING');
  assert.notEqual(review.gates.audio, 'PASS');
});

test('APT-6 capability discovery states the prescreen as a fact and automatic selection as absent', async () => {
  const capabilities = await application.capabilities();
  assert.equal(capabilities.capabilities.audio_prescreen, true);
  assert.equal(capabilities.capabilities.automatic_prescreen_selection, false);
  assert.equal(capabilities.audio_prescreen.sets_gates, false);
  assert.equal(capabilities.audio_prescreen.sound_bank.is_game_timbre, false);
  assert.equal(capabilities.audio_prescreen.sound_bank.stored_in_repository_or_image, false);
  assert.deepEqual(capabilities.audio_prescreen.never_sets, ['audio (Gate 7)', 'player_readback (Gate 6)', 'in_game']);
});
