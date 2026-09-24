// The audio prescreen over MCP and HTTP: tool shape, parity, size bounds,
// shadow mode, and the cost of a song-length prescreen.
//
// Renders with the synthetic in-memory bank; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { handleMcp } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS, runStudioTool } from '../server/mcp-studio.mjs';
import { PAGED_REPORT_TOOLS } from '../server/report-page.mjs';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { GAME_INSTRUMENT_IDS } from '../studio/backend/audio/instruments.mjs';
import { applyKeepOnlyCandidate } from '../studio/tests/fixtures/application-fixtures.mjs';
import { syntheticSoundBank } from '../studio/tests/support/synthetic-render-bank.mjs';
import { syntheticSongMml, SYNTHETIC_METER } from '../studio/tests/support/prescreen-fixtures.mjs';
import { createListenConfig, NODE_LISTEN_CODEC } from '../server/mcp-listen.mjs';
import { PRESCREEN_LISTEN_LIMITS, PRESCREEN_LISTEN_SCHEMA, prescreenListenLinks } from '../server/prescreen-listen.mjs';
import { decodeListenLink, listenPayloadFromUrl } from '../studio/web/listen-link.mjs';

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
  // The render-length limit is stated where the request is chosen, with the
  // refusal it gives and the way around it.
  for (const fact of ['1200 秒', '20 分鐘', 'RENDER_TOO_LONG', 'suggested_bar_range', 'bar_range 分段']) assert.ok(prescreen.description.includes(fact), fact);
  const barRange = prescreen.inputSchema.properties.bar_range;
  assert.deepEqual([barRange.properties.from.maximum, barRange.properties.to.maximum], [10000, 10000]);
  assert.ok(barRange.description.includes('1200 秒'));
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
  const { render_seconds_are: measured, ...limits } = capabilities.audio_prescreen.limits;
  assert.deepEqual(limits, { max_mml_characters: 40000, max_bars: 10000, max_render_seconds_per_alternative: 1200 });
  assert.match(measured, /bar_range/);
});

test('APT-7 MCP and HTTP refuse a render over the limit alike, before anything renders', async () => {
  let loads = 0;
  const app = createStudioApplication({ transports: ['http', 'mcp'], audioPrescreen: { bankProvider: { descriptor: BANK, load: async () => { loads++; throw Error('the sound bank was loaded'); } } } });
  // 161 whole notes at T32 in 4/4: 1,207.5 s.
  const long = pitch => `MML@t32o4l1${pitch.repeat(161)},,,,,;`;
  const request = { alternatives: [{ mml: long('c') }, { mml: long('d') }], meter_text: '0 4/4' };
  const overMcp = (await rpc('studio_audio_prescreen', request, { app })).body.result;
  assert.equal(overMcp.isError, true);
  const overHttp = await createApiRouter({ application: app, ownerOf: () => OWNER })(new Request(`${ORIGIN}${API_PREFIX}/audio-prescreen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }), { authenticated: true });
  assert.equal(overHttp.status, 400);
  const httpError = (await overHttp.json()).error;
  for (const error of [overMcp.structuredContent.error, httpError]) {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(error.details.reason, 'RENDER_TOO_LONG');
    assert.equal(error.details.max_render_seconds, 1200);
    assert.deepEqual(error.details.suggested_bar_range, { from: 1, to: 160 });
  }
  assert.deepEqual(httpError, overMcp.structuredContent.error);
  assert.equal(loads, 0, 'the bank was never loaded');
});

// ── listen links for human_review regions (server/prescreen-listen.mjs) ─────

async function rpcWith(listen, name, args) {
  const response = await handleMcp(new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { application, owner: OWNER, listen });
  return JSON.parse(await response.text()).result.structuredContent;
}

test('APT-L1 each human_review region gets an A/B listen link beside the report, and report_id does not move', async () => {
  const base = syntheticSongMml({ bars: 4 }), crunch = syntheticSongMml({ bars: 4, variant: 'crunch' });
  const request = { alternatives: [{ label: 'A', mml: base }, { label: 'B', mml: crunch }], meter_text: SYNTHETIC_METER };
  const withOrigin = await rpcWith(createListenConfig({ studioWebOrigin: 'https://studio.example' }), 'studio_audio_prescreen', request);
  const without = await rpcWith(createListenConfig(), 'studio_audio_prescreen', request);
  assert.ok(withOrigin.prescreen.human_review.length > 0, 'the fixture has regions for a person to hear');
  assert.equal(withOrigin.prescreen.report_id, without.prescreen.report_id, 'the links are not part of the report');
  assert.ok(withOrigin.prescreen.human_review.every(region => region.listen_link === null));
  assert.equal(withOrigin.listen.schema, PRESCREEN_LISTEN_SCHEMA);
  assert.equal(withOrigin.listen.status, 'OK');
  assert.equal(withOrigin.listen.links.length, withOrigin.prescreen.human_review.length);
  for (const [index, link] of withOrigin.listen.links.entries()) {
    const region = withOrigin.prescreen.human_review[index];
    assert.equal(link.status, 'OK');
    assert.ok(link.url.startsWith('https://studio.example/#listen='));
    const document = await decodeListenLink(listenPayloadFromUrl(link.url).payload, NODE_LISTEN_CODEC);
    assert.equal(document.mml, base);
    assert.equal(document.compare_mml, crunch);
    assert.equal(document.meter_text, SYNTHETIC_METER);
    assert.deepEqual(document.start, { beat: region.beats[0] });
    assert.deepEqual(document.markers.map(marker => [marker.beat, marker.end_beat, marker.kind]), [[region.beats[0], region.beats[1], 'pending']]);
  }
  assert.equal(without.listen.status, 'ORIGIN_NOT_CONFIGURED');
  assert.deepEqual(without.listen.links, []);
});

test('APT-L3 alternatives given without labels get the same links as labelled ones', async () => {
  // The report names alternatives by the labels the service assigned: the
  // caller's, or the positional defaults A, B, C, D. Looking the MML up by the
  // caller's raw label left every link NO_MML_FOR_ALTERNATIVE for the
  // documented default-label request.
  const base = syntheticSongMml({ bars: 4 }), crunch = syntheticSongMml({ bars: 4, variant: 'crunch' });
  const listen = createListenConfig({ studioWebOrigin: 'https://studio.example' });
  const unlabelled = await rpcWith(listen, 'studio_audio_prescreen', { alternatives: [{ mml: base }, { mml: crunch }], meter_text: SYNTHETIC_METER });
  assert.ok(unlabelled.prescreen.human_review.length > 0, 'the fixture has regions for a person to hear');
  assert.equal(unlabelled.listen.status, 'OK');
  assert.equal(unlabelled.listen.links.length, unlabelled.prescreen.human_review.length);
  assert.ok(unlabelled.listen.links.every(link => link.status === 'OK' && link.mml_label === 'A' && link.compare_label === 'B'), JSON.stringify(unlabelled.listen.links.map(link => link.status)));
  const document = await decodeListenLink(listenPayloadFromUrl(unlabelled.listen.links[0].url).payload, NODE_LISTEN_CODEC);
  assert.equal(document.mml, base);
  assert.equal(document.compare_mml, crunch);
  // A caller's own label still wins over the positional default.
  const mixed = await rpcWith(listen, 'studio_audio_prescreen', { alternatives: [{ label: 'base', mml: base }, { mml: crunch }], meter_text: SYNTHETIC_METER });
  assert.ok(mixed.listen.links.every(link => link.status === 'OK' && link.mml_label === 'base' && link.compare_label === 'B'));
});

test('APT-L4 a song-length prescreen keeps every listen link beside its compacted report', async () => {
  // Song-sized alternatives make the links themselves larger than the
  // response budget. Inside the compacted result they were summarized into a
  // report_page pointer at a path the report does not have (the links are not
  // part of the report), so the owner got no link at all; taken after the
  // view, they stay whole, and a page read of the report carries none.
  const notes = 'cdefgab', lens = ['4', '8', '16', '2'];
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const role = () => { let text = 't120o4'; while (text.length < 2300) text += notes[rnd(7)] + (rnd(3) ? '' : '+') + lens[rnd(4)]; return text; };
  const song = () => `MML@${Array.from({ length: 6 }, role).join(',')};`;
  const A = song(), B = song();
  const region = n => ({ region_id: `bars-${n}-${n}`, bars: [n, n], beats: [String(4 * (n - 1)), String(4 * n)], alternatives: ['A', 'B'], reasons: ['MARGIN_TOO_SMALL'], listen_link: null });
  const metrics = i => Object.fromEntries(['roughness', 'masking', 'smear', 'clipping'].map(name => [name, { A: 0.123456 + i, B: 0.234567 + i }]));
  const evidence = { roughness: { low_mid: 0.1, high: 0.2, attribution: ['Chord1:c4', 'Chord2:c+3'] }, audibility: { Melody: 0.9, Chord1: 0.8, Chord2: 0.7, Chord3: 0.6, Chord4: 0.5, Chord5: 0.4 }, smear: { attacks: 3, worst: 0.3 }, peak_dbfs: -3 };
  const report = {
    schema: 'mml-studio/audio-prescreen-report@1', report_id: 'aps:song', inputs: { meter: '0 4/4' }, summary: { bars: 200 },
    human_review: Array.from({ length: 8 }, (_, i) => region(i + 1)),
    bars: Array.from({ length: 200 }, (_, i) => ({ bar: i + 1, beats: [String(4 * i), String(4 * i + 4)], verdict: 'NEEDS_HUMAN', winner: null, reasons: ['MARGIN_TOO_SMALL'], metrics: metrics(i), evidence: { A: evidence, B: evidence } })),
  };
  const stub = { audioPrescreen: async () => ({ prescreen: report, canonical: { rules_snapshot: 'x' } }), getArtifact: async () => ({}) };
  const listen = createListenConfig({ studioWebOrigin: 'https://studio.example' });
  const args = { alternatives: [{ mml: A }, { mml: B }], meter_text: '0 4/4' };
  const view = await runStudioTool('studio_audio_prescreen', args, { application: stub, owner: OWNER, listen });
  assert.ok(view.response_compaction, 'the bar list is over the response budget');
  assert.ok(!Array.isArray(view.prescreen.bars), 'the bar list was summarized');
  assert.ok(Array.isArray(view.listen.links), 'the links are not a summary');
  assert.equal(view.listen.links.filter(link => link.status === 'OK').length, 8);
  assert.ok(view.listen.links.every(link => link.mml_label === 'A' && link.compare_label === 'B'));
  assert.ok(Buffer.byteLength(JSON.stringify(view)) * 2 < MCP_RESULT_CAP, 'carried twice, the response stays under the result cap');
  const page = await runStudioTool('studio_audio_prescreen', { ...args, report_page: view.prescreen.bars.report_page.arguments?.report_page ?? { path: ['prescreen', 'bars'] } }, { application: stub, owner: OWNER, listen });
  assert.equal(page.listen, undefined, 'a page is read from the report itself');
  assert.deepEqual(page.report_page.path, ['prescreen', 'bars']);
  assert.ok(typeof page.report_page.json_fragment === 'string' && page.report_page.json_fragment.length > 0);
});

test('APT-L2 a candidate has no MML to link, and the link count is bounded', async () => {
  const region = n => ({ region_id: `bars-${n}-${n}`, bars: [n, n], beats: [String(4 * (n - 1)), String(4 * n)], alternatives: ['A', 'B', 'C'], reasons: ['MARGIN_TOO_SMALL'], listen_link: null });
  const report = { inputs: { meter: '0 4/4' }, human_review: Array.from({ length: 6 }, (_, i) => region(i + 1)) };
  const mml = 'MML@t120o4c1,,,,,;';
  const listen = createListenConfig({ studioWebOrigin: 'https://studio.example' });
  const result = await prescreenListenLinks(report, { listen, mmlOf: label => (label === 'C' ? null : mml) });
  const ok = result.links.filter(link => link.status === 'OK');
  assert.equal(ok.length, 6, 'A against B in each region');
  assert.ok(result.links.filter(link => link.compare_label === 'C').every(link => link.status === 'NO_MML_FOR_ALTERNATIVE' && link.url === null));
  const many = await prescreenListenLinks({ ...report, human_review: Array.from({ length: 12 }, (_, i) => region(i + 1)) }, { listen, mmlOf: () => mml });
  assert.equal(many.links.filter(link => link.url).length, PRESCREEN_LISTEN_LIMITS.maxLinks);
  assert.equal(many.withheld, 24 - PRESCREEN_LISTEN_LIMITS.maxLinks);
  const none = await prescreenListenLinks({ human_review: [] }, { listen, mmlOf: () => mml });
  assert.equal(none.status, 'NO_HUMAN_REVIEW');
});
