// `studio_listen` and its UI resource over the MCP transport.
//
// Pins: the resource capability and the two host shapes (MCP Apps
// `text/html;profile=mcp-app` via `_meta.ui.resourceUri`, and the Apps SDK
// template alias), a self-contained player page, markers read from a Final's
// machine-delivery ledger, a listen link that decodes back to what was sent
// through the Studio Web's own contract (byte-for-byte its golden vectors),
// the text fallback, and that nothing here writes. All MML is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { handleMcp } from '../server/mcp.mjs';
import {
  LISTEN_MCP_TOOLS, LISTEN_VIEW_SCHEMA, MCP_APP_MIME_TYPE, LEGACY_WIDGET_MIME_TYPE, PLAYER_RESOURCE_URI, PLAYER_LEGACY_RESOURCE_URI,
  LISTEN_RESPONSE, NODE_LISTEN_CODEC, createListenConfig, encodeListenPayload, listenConfigFromEnv, listenLinkUrl, mergeListenMarkers, parseStudioWebOrigin,
} from '../server/mcp-listen.mjs';
import { RESPONSE_COMPACTION } from '../server/mcp-compaction.mjs';
import { LISTEN_LIMITS, ListenLinkError, decodeListenLink, streamCodec } from '../studio/web/listen-link.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { sha256Hex } from '../studio/backend/source/sha256.mjs';
import { canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from '../studio/tests/fixtures/application-fixtures.mjs';
import { OWNER as RELEASE_OWNER, assign, oneTickEarlyBaseline, roleDecisions } from '../studio/tests/fixtures/release-fixtures.mjs';
import { DELIVERY_FLAG, MACHINE_DELIVERY_SCHEMA_V2 } from '../studio/backend/final/delivery-evaluator.mjs';
import { finalListeningMarkers, groupRuns, PROVISIONAL_MARKER_BUDGET, LEAD_MARKER_BUDGET } from '../server/listen/final-markers.mjs';
import { parseListenMml } from '../server/listen/mml-events.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:service';
const STUDIO_WEB = 'https://studio.example';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const SONG = 'MML@t120o5c4e4d4f4e2g2f4a4g4b4a1,t120o4l2cegcfaec1,t120o3c1f1c1c1,,,t120o2c1f1g1c1;';

function surface({ application = createStudioApplication({}), listen = createListenConfig({ studioWebOrigin: STUDIO_WEB }) } = {}) {
  const send = async (method, params) => (await (await handleMcp(new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  }), application ? { application, owner: OWNER, listen } : { listen })).json());
  return {
    application,
    send,
    call: async args => (await send('tools/call', { name: 'studio_listen', arguments: args })),
  };
}

const initialize = { protocolVersion: '2025-11-25', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME_TYPE] } } }, clientInfo: { name: 'test', version: '1' } };
// Decoded exactly as the Studio Web decodes a link.
const linkPayload = url => decodeListenLink(url.slice(url.indexOf('#listen=') + '#listen='.length), NODE_LISTEN_CODEC);
const { vectors: GOLDEN } = JSON.parse(await readFile(new URL('../studio/tests/fixtures/listen-link-vectors.json', import.meta.url), 'utf8'));

// ─── the listen-link contract, from the sending side ────────────────────────

test('links are encoded through the Studio Web contract, byte-for-byte its golden vectors', async () => {
  assert.equal(GOLDEN.length, 2);
  for (const vector of GOLDEN) {
    assert.equal(await encodeListenPayload(vector.json), vector.payload, `${vector.name}: the MCP side writes the vector's exact payload`);
    assert.equal(await listenLinkUrl(`${STUDIO_WEB}/`, vector.json), `${STUDIO_WEB}/#listen=${vector.payload}`);
    // And the Studio Web's browser path reads what this side writes.
    assert.deepEqual(await decodeListenLink(await encodeListenPayload(vector.json), streamCodec), vector.json, vector.name);
  }
  // Key order is the contract's, whatever order a caller builds a document in.
  const full = GOLDEN.find(vector => vector.name === 'full');
  const shuffled = Object.fromEntries(Object.entries(full.json).reverse());
  shuffled.markers = full.json.markers.map(marker => Object.fromEntries(Object.entries(marker).reverse()));
  assert.equal(await encodeListenPayload(shuffled), full.payload);
  // The contract's refusals reach this side unchanged.
  await assert.rejects(encodeListenPayload({ ...GOLDEN[0].json, schema: 'mml-studio/listen-link@2' }), error => error instanceof ListenLinkError && error.code === 'LISTEN_LINK_UNKNOWN_SCHEMA');
  await assert.rejects(encodeListenPayload({ ...GOLDEN[0].json, title: 'a\u2028b' }), error => error instanceof ListenLinkError && error.code === 'LISTEN_LINK_INVALID');
});

test('the Studio Web origin must be a bare https origin', async () => {
  assert.deepEqual(parseStudioWebOrigin(undefined), { origin: null, status: 'ORIGIN_NOT_CONFIGURED' });
  assert.deepEqual(parseStudioWebOrigin(' '), { origin: null, status: 'ORIGIN_NOT_CONFIGURED' });
  assert.deepEqual(parseStudioWebOrigin('https://studio.example'), { origin: 'https://studio.example', status: 'OK' });
  assert.deepEqual(parseStudioWebOrigin('https://studio.example/'), { origin: 'https://studio.example', status: 'OK' });
  assert.deepEqual(parseStudioWebOrigin('https://studio.example:8443'), { origin: 'https://studio.example:8443', status: 'OK' });
  for (const bad of ['http://studio.example', 'https://user:pw@studio.example', 'https://studio.example/app', 'https://studio.example/?x=1', 'https://studio.example/#x', 'javascript:alert(1)', 'studio.example', 'https://STUDIO.example']) {
    assert.equal(parseStudioWebOrigin(bad).origin, null, bad);
    assert.equal(parseStudioWebOrigin(bad).status, 'ORIGIN_INVALID', bad);
  }
  await assert.rejects(listenLinkUrl('http://studio.example', GOLDEN[0].json), error => error instanceof ListenLinkError && error.code === 'ORIGIN_INVALID');
});

// ─── discovery ───────────────────────────────────────────────────────────────

test('initialize advertises resources only where the listening tool exists', async () => {
  const withStudio = (await surface().send('initialize', initialize)).result;
  assert.deepEqual(withStudio.capabilities, { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } });
  assert.match(withStudio.instructions, /studio_listen/);
  assert.match(withStudio.instructions, /never a gate confirmation, evidence or acceptance/);
  const bare = surface({ application: null });
  assert.deepEqual((await bare.send('initialize', initialize)).result.capabilities, { tools: { listChanged: false } });
  assert.equal((await bare.send('resources/list')).error.code, -32601);
  assert.equal((await bare.send('resources/read', { uri: PLAYER_RESOURCE_URI })).error.code, -32601);
  assert.equal((await bare.call({ mml: SONG })).error.code, -32602, 'no studio, no studio_listen');
});

test('resources/list and resources/read serve the player in both host shapes', async () => {
  const mcp = surface();
  const { resources } = (await mcp.send('resources/list')).result;
  assert.deepEqual(resources.map(resource => [resource.uri, resource.mimeType]), [
    [PLAYER_RESOURCE_URI, 'text/html;profile=mcp-app'],
    [PLAYER_LEGACY_RESOURCE_URI, 'text/html+skybridge'],
  ]);
  assert.deepEqual(resources[0]._meta, { ui: { prefersBorder: true, permissions: { clipboardWrite: {} } } }, 'no network origin is declared by default');
  assert.deepEqual(resources[1]._meta['openai/widgetCSP'], { connect_domains: [], resource_domains: [] });

  const pages = [];
  for (const [uri, mimeType] of [[PLAYER_RESOURCE_URI, MCP_APP_MIME_TYPE], [PLAYER_LEGACY_RESOURCE_URI, LEGACY_WIDGET_MIME_TYPE]]) {
    const { contents } = (await mcp.send('resources/read', { uri })).result;
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, uri);
    assert.equal(contents[0].mimeType, mimeType);
    assert.deepEqual(contents[0]._meta, resources.find(resource => resource.uri === uri)._meta, 'read carries the same _meta as list');
    pages.push(contents[0].text);
  }
  assert.equal(pages[0], pages[1], 'one page serves both shapes');
  const html = pages[0];
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.length < 200000, `the player stays small (${html.length} chars)`);
  // Self-contained: nothing to fetch, no external script, style or frame.
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[\s>]/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /\bimport\s*[({'"*]/, 'no module imports');
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/i, 'no absolute URL of any kind is embedded');
  assert.doesNotMatch(html, /\beval\s*\(|new Function\s*\(/, 'no dynamic code');
  assert.match(html, /"samples":null/, 'no sample library unless the deployment configures one');
  assert.match(html, /不是遊戲內音色/, 'the preview label is always on the page');
  assert.equal((html.match(/<script type="module">/g) ?? []).length, 1);

  assert.equal((await mcp.send('resources/read', { uri: 'ui://mml-studio/other.html' })).error.code, -32002);
  assert.equal((await mcp.send('resources/read', {})).error.code, -32602);
  assert.deepEqual((await mcp.send('resources/templates/list')).result, { resourceTemplates: [] });
});

test('a configured sample library is the one origin the player may reach, declared in both shapes', async () => {
  const listen = createListenConfig({ studioWebOrigin: STUDIO_WEB, samplesUrl: 'https://samples.example/banks/gm/', samplesCredit: 'Synthetic credit line' });
  const mcp = surface({ listen });
  const { resources } = (await mcp.send('resources/list')).result;
  assert.deepEqual(resources[0]._meta.ui.csp, { connectDomains: ['https://samples.example'], resourceDomains: [] });
  assert.deepEqual(resources[1]._meta['openai/widgetCSP'], { connect_domains: ['https://samples.example'], resource_domains: [] });
  const html = (await mcp.send('resources/read', { uri: PLAYER_RESOURCE_URI })).result.contents[0].text;
  assert.match(html, /"url":"https:\/\/samples\.example\/banks\/gm\/"/);
  // Anything but an https directory prefix is ignored rather than trusted.
  for (const samplesUrl of ['http://samples.example/', 'https://samples.example/file.js', 'https://u:p@samples.example/', 'https://samples.example/?q=1']) {
    assert.equal(createListenConfig({ samplesUrl }).samples, null, samplesUrl);
  }
  const env = listenConfigFromEnv({ STUDIO_WEB_ORIGIN: STUDIO_WEB });
  assert.equal(env.studioWebOrigin, STUDIO_WEB);
  assert.equal(env.samples, null);
  assert.equal(listenConfigFromEnv({}).studioWebOriginStatus, 'ORIGIN_NOT_CONFIGURED');
});

test('tools/list links studio_listen to the player for each host shape', async () => {
  const mcp = surface();
  const { tools } = (await mcp.send('tools/list')).result;
  const tool = tools.find(entry => entry.name === 'studio_listen');
  assert.deepEqual(tool, LISTEN_MCP_TOOLS[0]);
  assert.equal(tool._meta.ui.resourceUri, PLAYER_RESOURCE_URI);
  assert.deepEqual(tool._meta.ui.visibility, ['model', 'app']);
  assert.equal(tool._meta['openai/outputTemplate'], PLAYER_LEGACY_RESOURCE_URI);
  assert.equal(tool._meta['openai/widgetAccessible'], false, 'the player never calls tools');
  assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.markers.items.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.markers.items.properties.kind.enum, ['changed', 'note'], 'a caller cannot mint ledger kinds');
  // The description and schema name no model provider; only host `_meta` keys do.
  const described = JSON.stringify({ ...tool, _meta: undefined }).toLowerCase();
  for (const provider of ['openai', 'anthropic', 'chatgpt', 'claude', 'gpt-']) assert.ok(!described.includes(provider), provider);
});

// ─── inline MML ────────────────────────────────────────────────────────────

test('inline MML: markers, listen link and a text fallback a person can act on', async () => {
  const mcp = surface();
  const result = (await mcp.call({
    mml: SONG, meter_text: '0 4/4', title: 'Synthetic <b>song</b>', start_bar: 2,
    markers: [
      { bar: 3, role: 'Melody', kind: 'changed', label: 'raised the ending' },
      { beat: '9/2', end_beat: '6', kind: 'note', label: 'listen to the bass' },
    ],
  })).result;
  assert.equal(result.isError, false);
  const view = result.structuredContent;
  assert.equal(view.schema, LISTEN_VIEW_SCHEMA);
  assert.equal(view.title, 'Synthetic <b>song</b>', 'text is carried as text; the player renders it with textContent');
  assert.equal(view.mml, SONG);
  assert.equal(view.mml_sha256, sha256Hex(new TextEncoder().encode(SONG)));
  assert.deepEqual(view.source, { kind: 'inline' });
  // Chord1 is the longest role (18 beats), so the last 4/4 bar is partial.
  assert.equal(view.total_beats, '18');
  assert.equal(view.bar_count, 5);
  assert.equal(view.duration_seconds, 9);
  assert.deepEqual(view.start, { bar: 2 });
  assert.deepEqual(view.markers.map(marker => [marker.kind, marker.beat, marker.end_beat ?? null, marker.bar, marker.seconds, marker.role]), [
    ['note', '9/2', '6', 2, 2.25, null],
    ['changed', '8', null, 3, 4, 'Melody'],
  ]);
  const text = result.content[0].text;
  assert.equal(result.content.length, 1);
  assert.match(text, /^試聽：Synthetic <b>song<\/b>｜內嵌 MML｜MML sha256 [0-9a-f]{12}/);
  assert.match(text, /第3小節（0:04\.0） Melody \[changed\] raised the ending/);
  assert.match(text, /不是遊戲內音色/);
  assert.match(text, /不是任何 Gate 的確認、證據或接受/);
  assert.ok(text.includes(view.listen_link.url), 'the text fallback carries the listen link');
  assert.ok(!text.includes(SONG), 'the MML itself is not repeated into the text');

  assert.equal(view.listen_link.origin, STUDIO_WEB);
  assert.ok(view.listen_link.url.startsWith(`${STUDIO_WEB}/#listen=`));
  assert.deepEqual(await linkPayload(view.listen_link.url), {
    schema: 'mml-studio/listen-link@1', mml: SONG, title: 'Synthetic <b>song</b>', meter_text: '0 4/4', start: { bar: 2 },
    markers: [
      { beat: '9/2', end_beat: '6', kind: 'note', label: 'listen to the bass' },
      { beat: '8', role: 'Melody', kind: 'changed', label: 'raised the ending' },
    ],
  });
});

test('without a meter map positions stay in beats and nothing assumes 4/4', async () => {
  const mcp = surface();
  const view = (await mcp.call({ mml: SONG, markers: [{ beat: '8', kind: 'note', label: 'x' }] })).result.structuredContent;
  assert.equal(view.meter_text, null);
  assert.equal(view.bar_count, null);
  assert.equal(view.markers[0].bar, null);
  assert.equal((await linkPayload(view.listen_link.url)).meter_text, undefined);
  for (const args of [{ mml: SONG, start_bar: 1 }, { mml: SONG, markers: [{ bar: 1, kind: 'note', label: 'x' }] }]) {
    const refused = (await mcp.call(args)).result;
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error.code, 'INVALID_REQUEST');
    assert.equal(refused.structuredContent.error.details.reason, 'LISTEN_BAR_WITHOUT_METER');
  }
});

test('no Studio Web origin, no link -- and the text says why', async () => {
  for (const [studioWebOrigin, status] of [[null, 'ORIGIN_NOT_CONFIGURED'], ['http://studio.example', 'ORIGIN_INVALID']]) {
    const mcp = surface({ listen: createListenConfig({ studioWebOrigin }) });
    const result = (await mcp.call({ mml: SONG, meter_text: '0 4/4' })).result;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.listen_link, null);
    assert.equal(result.structuredContent.listen_link_status, status);
    assert.match(result.content[0].text, /STUDIO_WEB_ORIGIN/);
    assert.doesNotMatch(result.content[0].text, /#listen=/);
  }
});

test('inputs are bounded and a malformed request is refused before anything runs', async () => {
  const mcp = surface();
  const schemaRefusals = [
    {},
    { mml: `MML@${'c'.repeat(40000)},,,,,;` },
    { mml: SONG, compare_mml: `MML@${'c'.repeat(40000)},,,,,;` },
    { mml: SONG, title: 'x'.repeat(121) },
    { mml: SONG, markers: Array.from({ length: 101 }, () => ({ beat: '0', kind: 'note', label: 'x' })) },
    { mml: SONG, markers: [{ beat: '0', kind: 'pending', label: 'a caller cannot claim a ledger kind' }] },
    { mml: SONG, markers: [{ beat: '0', kind: 'note', label: 'x', gate: 'leadPromotion' }] },
    { mml: SONG, url: 'https://example.com' },
  ];
  for (const args of schemaRefusals.slice(1)) assert.equal((await mcp.call(args)).error?.code, -32602, JSON.stringify(args).slice(0, 100));
  const refusals = [
    [{}, 'LISTEN_SOURCE_REQUIRED'],
    [{ mml: SONG, artifact_id: `art_${'0'.repeat(64)}` }, 'LISTEN_SOURCE_REQUIRED'],
    [{ mml: SONG, project_id: `prj_${'0'.repeat(32)}` }, 'LISTEN_PROJECT_WITHOUT_ARTIFACT'],
    [{ mml: 'c4d4e4' }, 'LISTEN_MML_INVALID'],
    [{ mml: 'MML@,,,,,;' }, 'LISTEN_MML_EMPTY'],
    [{ mml: 'MML@t1200o4c4,,,,,;' }, 'LISTEN_NUMERIC_BOUND'],
    [{ mml: SONG, meter_text: '0 4/4', start_bar: 6 }, 'LISTEN_BAR_OUT_OF_RANGE'],
    [{ mml: SONG, markers: [{ bar: 1, beat: '0', kind: 'note', label: 'x' }] }, 'LISTEN_MARKER_POSITION'],
    [{ mml: SONG, markers: [{ beat: '4', end_beat: '2', kind: 'note', label: 'x' }] }, 'LISTEN_MARKER_POSITION'],
    [{ mml: SONG, markers: [{ beat: '-1', kind: 'note', label: 'x' }] }, 'LISTEN_MARKER_POSITION'],
  ];
  for (const [args, reason] of refusals) {
    const result = (await mcp.call(args)).result;
    assert.equal(result.isError, true, JSON.stringify(args).slice(0, 80));
    assert.equal(result.structuredContent.error.code, 'INVALID_REQUEST');
    assert.equal(result.structuredContent.error.details.reason, reason, JSON.stringify(args).slice(0, 80));
  }
});

// ─── stored Finals ─────────────────────────────────────────────────────────

async function deliveredFinal(application) {
  const project = sixRoleBaseline();
  const projectId = (await application.createProject(OWNER, { title: 'Synthetic listening fixture' })).project.project_id;
  await application.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(project) });
  await application.analyzeSources(OWNER, projectId);
  const candidateId = (await application.applyDecisions(OWNER, projectId, { decisions: keepEveryRole(project) })).decisions.candidate_id;
  const final = await application.finalize(OWNER, projectId, {
    candidateId,
    confirmations: {
      source_complete: { value: true, reason: 'Complete.' },
      player_readback: { value: 'PASS', reason: 'Read back.' },
      mobile_adaptation_reviewed: { value: true, reason: 'Gate 8 reviewed.', evidence: ['synthetic Gate 8 review'] },
      regression_reviewed: { value: true, reason: 'Gate 9 reviewed.', evidence: ['synthetic Gate 9 review'] },
      original_audio_required: { value: false, reason: 'No recording.' },
    },
  });
  assert.equal(final.operation, 'succeeded', JSON.stringify(final.blockers));
  return { projectId, artifactId: final.artifact_id, mml: final.mml };
}

test('a delivered Final: its MML, meter, ledger notes and a link back to its identity, without writing anything', async () => {
  const application = createStudioApplication({});
  const mcp = surface({ application });
  const { projectId, artifactId, mml } = await deliveredFinal(application);
  const before = JSON.stringify(await application.getProject(OWNER, projectId));

  const result = (await mcp.call({ artifact_id: artifactId, project_id: projectId })).result;
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent).slice(0, 300));
  const view = result.structuredContent;
  assert.equal(view.mml, mml);
  assert.equal(view.title, 'Synthetic listening fixture');
  assert.equal(view.meter_text, '0 4/4');
  assert.equal(view.source.kind, 'final_artifact');
  assert.equal(view.source.artifact_id, artifactId);
  assert.equal(view.source.project_id, projectId);
  assert.equal(view.canonical.status, 'CANONICAL_LOADED');
  // The fixture's ledger holds only in-game acceptance: after delivery, with
  // no position, so it is a song-level note rather than a marker.
  assert.deepEqual(view.markers, []);
  assert.deepEqual(view.song_notes.map(note => [note.gate, note.classification, note.status]), [['inGameAcceptance', 'POST_DELIVERY', 'PENDING']]);
  assert.match(result.content[0].text, /整曲待確認：遊戲內驗收：PENDING/);
  const payload = await linkPayload(view.listen_link.url);
  assert.deepEqual(payload.source, { project_id: projectId, artifact_id: artifactId });
  assert.equal(payload.mml, mml);

  // Read-only: the project record is byte-identical afterwards.
  assert.equal(JSON.stringify(await application.getProject(OWNER, projectId)), before);

  // Scoping and refusals keep the existing error envelope.
  const wrongProject = (await mcp.call({ artifact_id: artifactId, project_id: `prj_${'0'.repeat(32)}` })).result;
  assert.equal(wrongProject.structuredContent.error.code, 'ARTIFACT_NOT_FOUND');
  const unknown = (await mcp.call({ artifact_id: `art_${'0'.repeat(64)}` })).result;
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, 'ARTIFACT_NOT_FOUND');
  const withMeter = (await mcp.call({ artifact_id: artifactId, meter_text: '0 3/4' })).result;
  assert.equal(withMeter.structuredContent.error.details.reason, 'LISTEN_METER_NOT_ALLOWED');
});

// ─── Canonical v3 (@2) Finals: the real shapes ─────────────────────────────
//
// A Final delivered through the real v3 path -- readiness, provisional release
// rendering, the Final service -- under an injected @2 identity, the way
// studio/tests/provisional-release-emission.test.mjs does it, so the markers
// are read from exactly what a v3 Final files. The fixture is synthetic
// (studio/tests/fixtures/release-fixtures.mjs): every release one 480-tpq tick
// before the grid, Melody reached by Lead promotions.

const AT2 = Object.freeze({ canonical_version: '2026-09-23-v3', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'd'.repeat(40), machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V2 });
const V3_CONFIRMATIONS = Object.freeze({
  source_complete: { value: true, reason: 'The synthetic baseline is the complete material.' },
  version_drift_reviewed: { value: true, reason: 'No earlier version exists for this synthetic fixture.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification player is used for this synthetic cue.' },
  core3_completeness_reviewed: { value: true, reason: 'Melody, Chord1 and Chord2 stand as a one-player arrangement in the fixture.', evidence: ['fixture:gate-4'] },
  mobile_adaptation_reviewed: { value: true, reason: 'The fixture needs no Mobile adaptation beyond the listed releases.', evidence: ['fixture:gate-8'] },
  regression_reviewed: { value: true, reason: 'Compared against the Source-Faithful Baseline.', evidence: ['fixture:gate-9'] },
  original_audio_required: { value: false, reason: 'The synthetic workflow has no recording.' },
});

async function serviceUnderAt2(directory) {
  const engines = await createStudioApplication({}).canonical.engines();
  return createStudioApplication({
    dataDirectory: directory,
    durability: 'persistent',
    loadEngines: async () => ({
      ...engines,
      final: {
        ...engines.final,
        evaluateProjectReadiness: input => engines.final.evaluateProjectReadiness({ ...input, canonical: AT2 }),
        emitFinalMml: (project, options = {}) => engines.final.emitFinalMml(project, { ...options, canonical: AT2 }),
      },
    }),
  });
}

async function v3Final(t, decisions) {
  const directory = await mkdtemp(join(tmpdir(), 'mml-listen-v3-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const service = await serviceUnderAt2(directory);
  const created = (await service.createProject(RELEASE_OWNER, { title: 'Synthetic v3 listening fixture' })).project;
  await service.uploadAsset(RELEASE_OWNER, created.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(oneTickEarlyBaseline())) });
  await service.analyzeSources(RELEASE_OWNER, created.project_id);
  const applied = await service.applyDecisions(RELEASE_OWNER, created.project_id, { decisions });
  assert.equal(applied.decisions.applied, true, JSON.stringify(applied.decisions.rejected ?? null));
  const final = await service.finalize(RELEASE_OWNER, created.project_id, { candidateId: applied.decisions.candidate_id, confirmations: V3_CONFIRMATIONS });
  assert.equal(final.operation, 'succeeded', JSON.stringify(final.blockers));
  const { artifact } = await service.getArtifact(RELEASE_OWNER, final.artifact_id);
  assert.equal(artifact.machine_delivery.schema, MACHINE_DELIVERY_SCHEMA_V2);
  return { service, artifact, projectId: created.project_id };
}

const listenOn = (application, owner = RELEASE_OWNER) => async args => (await (await handleMcp(new Request(`${ORIGIN}/mcp`, {
  method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_listen', arguments: args } }),
}), { application, owner, listen: createListenConfig({ studioWebOrigin: STUDIO_WEB }) })).json()).result;

test('a v3 Final: every provisionally rendered release is a marker at its source release, with the counts and per-source figures as notes', async t => {
  const { service, artifact } = await v3Final(t, roleDecisions());
  assert.deepEqual(artifact.delivery.flags, [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY]);
  assert.equal(artifact.provisional_release_rendering.renderings.length, 8);

  const result = await listenOn(service)({ artifact_id: artifact.artifact_id });
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent).slice(0, 300));
  const view = result.structuredContent;
  assert.deepEqual(view.delivery_flags, ['RELEASES_RENDERED_PROVISIONALLY']);
  assert.equal(view.source.machine_delivery_schema, MACHINE_DELIVERY_SCHEMA_V2);
  // One marker per held release: from the source release (one tick before the
  // grid) to the rendered release, on the role the rendering names.
  const expected = [...artifact.provisional_release_rendering.renderings]
    .map(item => [item.role, item.release, item.renderedRelease])
    .sort((a, b) => listenBeat(a[1]) - listenBeat(b[1]) || ['Melody', 'Chord1', 'Chord2'].indexOf(a[0]) - ['Melody', 'Chord1', 'Chord2'].indexOf(b[0]));
  assert.deepEqual(view.markers.map(marker => [marker.role, marker.beat, marker.end_beat]), expected);
  assert.ok(view.markers.every(marker => marker.kind === 'provisional-release' && marker.gate === 'microTiming' && marker.count === 1 && marker.source === 'provisional_release_rendering'));
  assert.equal(view.markers[0].beat, '479/480');
  assert.equal(view.markers[0].end_beat, '1');
  assert.deepEqual(view.provisional_releases, { held: 8, closed_intervals: artifact.provisional_release_rendering.closedIntervalCount, placed: 8, unplaced: 0, markers: 8, source: 'provisional_release_rendering' });
  assert.match(view.song_notes[0].label, /共 8 個 release 暫時延到下一格（Melody 4、Chord1 2、Chord2 2）/);
  assert.match(view.song_notes[1].label, /來源 fixture:third-party-midi：主要偏移 1 tick\(s\)，占 8\/8（100\.0%），門檻 95\/100，符合；暫定 8、未解決 0/);
  assert.match(result.content[0].text, /交付旗標：RELEASES_RENDERED_PROVISIONALLY（release 暫定表示）/);
  // The link carries the same markers for the Studio Web.
  assert.deepEqual((await linkPayload(view.listen_link.url)).markers.map(marker => [marker.kind, marker.beat, marker.end_beat]), view.markers.map(marker => ['provisional-release', marker.beat, marker.end_beat]));
});

test('a v3 Final with an unverified Lead: the ledger ids are placed on the delivered Melody and grouped, from the renderings or the baseline projection', async t => {
  const decisions = [
    ...['lead-1', 'lead-2', 'lead-3', 'lead-4'].map(id => assign(id, 'Melody', { leadEvidence: null })),
    ...['harm-1', 'harm-2'].map(id => assign(id, 'Chord1')),
    ...['bass-1', 'bass-2'].map(id => assign(id, 'Chord2')),
  ];
  const { service, artifact, projectId } = await v3Final(t, decisions);
  assert.deepEqual(artifact.delivery.flags, [DELIVERY_FLAG.RELEASES_RENDERED_PROVISIONALLY, DELIVERY_FLAG.LEAD_UNVERIFIED]);
  const ledgerLead = artifact.machine_delivery.non_blocking_pending.find(entry => entry.gate === 'leadPromotion');
  assert.deepEqual([...ledgerLead.unverified_lead_event_ids].sort(), ['lead-1', 'lead-2', 'lead-3', 'lead-4']);
  assert.ok(ledgerLead.blockers.includes('LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING'));

  const view = (await listenOn(service)({ artifact_id: artifact.artifact_id, project_id: projectId })).structuredContent;
  const lead = view.markers.filter(marker => marker.kind === 'lead-unverified');
  // Four consecutive Melody notes, one range over the delivered Melody.
  assert.deepEqual(lead.map(marker => [marker.role, marker.beat, marker.end_beat, marker.count, marker.gate]), [['Melody', '0', '4', 4, 'leadPromotion']]);
  assert.deepEqual(view.unverified_lead, { unverified: 4, placed: 4, unplaced: 0, markers: 1 });
  assert.deepEqual(view.delivery_flags, ['RELEASES_RENDERED_PROVISIONALLY', 'LEAD_UNVERIFIED']);
  assert.ok(view.song_notes.some(note => /主旋律未驗證：4 個 Melody 音缺主要 Lead 證據/.test(note.label)));
  assert.equal(view.markers.filter(marker => marker.kind === 'provisional-release').length, 8);

  // Without rendering records the Lead ids are placed from the read-only
  // baseline projection, and the releases from the ledger's own list.
  const withoutRendering = { ...artifact, provisional_release_rendering: null };
  const application = {
    getArtifact: async (owner, id) => ({ ...(await service.getArtifact(owner, id)), artifact: withoutRendering }),
    getProject: (...args) => service.getProject(...args),
    listBaselineEvents: (...args) => service.listBaselineEvents(...args),
    canonical: service.canonical,
  };
  const fallback = (await listenOn(application)({ artifact_id: artifact.artifact_id })).structuredContent;
  assert.deepEqual(fallback.markers.filter(marker => marker.kind === 'lead-unverified').map(marker => [marker.beat, marker.end_beat, marker.count]), [['0', '4', 4]]);
  const fromLedger = fallback.markers.filter(marker => marker.kind === 'provisional-release');
  assert.equal(fromLedger.length, 8);
  assert.ok(fromLedger.every(marker => marker.source === 'machine-delivery-ledger'));
  assert.equal(fallback.provisional_releases.source, 'machine-delivery-ledger');

  // With nothing to place them on, the ids stay a song-level count.
  const blind = { ...application, listBaselineEvents: undefined };
  const unplaced = (await listenOn(blind)({ artifact_id: artifact.artifact_id })).structuredContent;
  assert.equal(unplaced.markers.filter(marker => marker.kind === 'lead-unverified').length, 0);
  assert.deepEqual(unplaced.unverified_lead, { unverified: 4, placed: 0, unplaced: 4, markers: 0 });
  assert.ok(unplaced.song_notes.some(note => /4 個無法在交付的 Melody 上定位/.test(note.label)));
});

const listenBeat = text => { const [n, d = '1'] = String(text).split('/'); return Number(n) / Number(d); };

test('a real-sized Final (1,500 held releases, 400 unverified Lead notes) stays within the marker budgets with the full counts kept', async () => {
  const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
  const renderings = [];
  for (let i = 0; i < 1500; i++) {
    const role = roles[i % 6];
    const beat = Math.floor(i / 6) + 1;
    renderings.push({ eventId: `e${i}`, role, onset: String(beat - 1), release: `${beat * 480 - 1}/480`, renderedRelease: String(beat), intervalKeys: [`k${i}`] });
  }
  const mml = `MML@t120o4${'c4'.repeat(800)},,,,,;`;
  const parsed = parseListenMml(mml);
  const artifact = {
    provisional_release_rendering: { applied: true, renderings, heldEventCount: 1500, closedIntervalCount: 1500, releaseOffsetSources: [] },
    machine_delivery: {
      unresolved_evidence_ledger: [
        { gate: 'microTiming', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: ['MICRO_TIMING_RELEASE_PROVISIONAL'], delivery_flag: 'RELEASES_RENDERED_PROVISIONALLY', provisional_releases: [] },
        // Every other Melody note: 400 separate notes until neighbours are merged.
        { gate: 'leadPromotion', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: ['LEAD_PROMOTION_EVIDENCE_REQUIRED', 'LEAD_PROMOTION_PRIMARY_EVIDENCE_MISSING'], delivery_flag: 'LEAD_UNVERIFIED', unverified_lead_event_ids: Array.from({ length: 400 }, (_, i) => `m${i * 2}`) },
        { gate: 'inGameAcceptance', classification: 'POST_DELIVERY', status: 'PENDING', blockers: [] },
      ],
    },
    delivery: { flags: ['RELEASES_RENDERED_PROVISIONALLY', 'LEAD_UNVERIFIED'] },
  };
  const lookup = async ids => ids.map(id => ({ event_id: id, start: id.slice(1) }));
  const result = await finalListeningMarkers(artifact, { parsedTracks: parsed.tracks, totalBeats: 800, lookupBaselineEvents: lookup });
  const provisional = result.markers.filter(marker => marker.kind === 'provisional-release');
  const lead = result.markers.filter(marker => marker.kind === 'lead-unverified');
  assert.ok(provisional.length <= PROVISIONAL_MARKER_BUDGET && provisional.length > 0, String(provisional.length));
  assert.equal(provisional.reduce((sum, marker) => sum + marker.count, 0), 1500, 'every release is inside exactly one range');
  assert.ok(lead.length <= LEAD_MARKER_BUDGET && lead.length > 0);
  assert.equal(lead.reduce((sum, marker) => sum + marker.count, 0), 400);
  assert.ok(result.markers.length <= 500);
  assert.match(result.notes[0].label, /共 1,500 個 release/);
  assert.match(result.notes[0].label, /合併成 \d+ 個區段標記/);
  assert.equal(result.provisional_releases.held, 1500);
  assert.deepEqual(result.unverified_lead, { unverified: 400, placed: 400, unplaced: 0, markers: lead.length });
  assert.deepEqual(result.notes.at(-1), { gate: 'inGameAcceptance', classification: 'POST_DELIVERY', status: 'PENDING', blockers: [], label: '遊戲內驗收：PENDING' });
  // Ranges stay on one role and never overlap within it.
  for (const role of roles) {
    const ranges = provisional.filter(marker => marker.role === role).map(marker => [listenBeat(marker.beat), listenBeat(marker.end_beat ?? marker.beat)]);
    for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1], `${role} ranges overlap`);
  }

  // The grouping itself: the smallest merge that fits, deterministic.
  const items = Array.from({ length: 10 }, (_, i) => ({ role: 'Chord1', start: i * 2, end: i * 2 + 1, beat: String(i * 2), endBeat: String(i * 2 + 1) }));
  assert.equal(groupRuns(items, 10).groups.length, 10);
  assert.deepEqual(groupRuns(items, 9).groups.map(group => [group.beat, group.endBeat, group.items.length]), [['0', '19', 10]]);
});

test('ledger entries without a real position field stay song-level notes; a positioned one is still read', async () => {
  const artifact = syntheticArtifact({
    machine_delivery: {
      unresolved_evidence_ledger: [
        { gate: 'mobileAdaptation', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], locations: [{ beat: '8', end_beat: '10', role: 'Chord1', finding: 'range check' }] },
        { gate: 'originalAudio', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], positions: [{ beat: '400' }] },
        { gate: 'inGameAcceptance', classification: 'POST_DELIVERY', status: 'PENDING', blockers: [] },
        { gate: 'core3', classification: 'BLOCKING', status: 'FAIL', blockers: ['CORE3'], locations: [{ beat: '2' }] },
      ],
    },
  });
  const view = (await surface({ application: stubApplication(artifact) }).call({ artifact_id: ARTIFACT_ID })).result.structuredContent;
  assert.deepEqual(view.markers.map(marker => [marker.kind, marker.beat, marker.end_beat ?? null, marker.role, marker.gate]), [['pending', '8', '10', 'Chord1', 'mobileAdaptation']]);
  assert.match(view.markers[0].label, /Mobile 適配審查：range check/);
  assert.deepEqual(view.song_notes.map(note => note.gate), ['inGameAcceptance', 'originalAudio'], 'past the end of the song is a note, not a guess');
  assert.deepEqual(view.delivery_flags, []);
  assert.equal(view.provisional_releases, null);
  assert.equal(view.unverified_lead, null);

  const notFinal = (await surface({ application: stubApplication({ ...artifact, type: 'report' }) }).call({ artifact_id: ARTIFACT_ID })).result;
  assert.equal(notFinal.structuredContent.error.details.reason, 'LISTEN_ARTIFACT_NOT_FINAL');
});

// A stand-in Application Service holding one synthetic artifact.
function stubApplication(artifact) {
  return {
    async getArtifact(owner, artifactId) {
      if (artifactId !== artifact.artifact_id) throw Object.assign(new Error('Unknown artifact'), { name: 'StudioApplicationError', code: 'ARTIFACT_NOT_FOUND', details: {} });
      return { canonical: { status: 'CANONICAL_LOADED' }, operation: 'succeeded', artifact };
    },
    async getProject() { return { project: { title: 'Synthetic ledger fixture' } }; },
    canonical: { async provenance() { return { status: 'CANONICAL_LOADED' }; } },
  };
}

const ARTIFACT_ID = `art_${'ab'.repeat(32)}`;
const PROJECT_ID = `prj_${'cd'.repeat(16)}`;
const syntheticArtifact = extra => ({
  type: 'final_mml', artifact_id: ARTIFACT_ID, project_id: PROJECT_ID, candidate_id: 'g11d:rev:synthetic', song_state: 'VALIDATED',
  mml: SONG, final_bar: { pickup: null, final_partial: null, meter_text: '0 4/4' },
  ...extra,
});

// ─── the response bound (server/mcp-compaction.mjs rules) ────────────────────

const MCP_RESULT_CAP = 524288;
const outsideMml = view => { const { mml: _mml, compare_mml: _compare, ...rest } = view; return Buffer.byteLength(JSON.stringify(rest)); };
const listBytes = view => outsideMml({ ...view, listen_link: null });
const sixRoles = track => `MML@${Array.from({ length: 6 }, () => track).join(',')};`;
const responseBytes = result => Buffer.byteLength(JSON.stringify(result.structuredContent)) + Buffer.byteLength(result.content[0].text);

test('a start bar in a Final with a pickup opens the bar this tool resolved, not a bar counted from beat 0', async () => {
  // A one-beat pickup under 4/4: bars run 0-1, 1-5, 5-9, 9-13, 13-16. The link
  // contract has no pickup, so the Studio Web would count bar 3 from beat 8.
  const mml = sixRoles(`t120o4${'c4'.repeat(16)}`);
  const artifact = syntheticArtifact({ mml, final_bar: { pickup: '1', final_partial: null, meter_text: '0 4/4' } });
  const view = (await surface({ application: stubApplication(artifact) }).call({ artifact_id: ARTIFACT_ID, start_bar: 3 })).result.structuredContent;
  assert.deepEqual((await linkPayload(view.listen_link.url)).start, { beat: '5' });
  // Without a pickup the bar number means the same bar on both sides and stays.
  const plain = (await surface({ application: stubApplication(syntheticArtifact({ mml })) }).call({ artifact_id: ARTIFACT_ID, start_bar: 3 })).result.structuredContent;
  assert.deepEqual((await linkPayload(plain.listen_link.url)).start, { bar: 3 });
});

test('the listen bound is the Studio compaction bound', () => {
  assert.equal(LISTEN_RESPONSE.triggerBytes, RESPONSE_COMPACTION.triggerBytes);
  assert.equal(LISTEN_RESPONSE.budgetBytes, RESPONSE_COMPACTION.budgetBytes);
  // Two MML texts, the trigger and the text with its link stay near half the cap.
  const worst = 2 * LISTEN_LIMITS.mmlChars + LISTEN_RESPONSE.triggerBytes + LISTEN_RESPONSE.linkChars + 24 * 1024;
  assert.ok(worst < MCP_RESULT_CAP * 0.55, String(worst));
  assert.match(LISTEN_MCP_TOOLS[0].description, /response_compaction/);
});

test('a v3 Final with a full listening load is returned exactly as built, far under the result cap', async () => {
  // 150 separate provisional releases and 100 separate unverified Lead notes
  // (the Lead budget): a Final a person has a lot to listen to in.
  const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
  const renderings = Array.from({ length: 150 }, (_, i) => ({ eventId: `e${i}`, role: roles[i % 6], onset: String(4 * i), release: `${(4 * i + 1) * 480 - 7}/480`, renderedRelease: String(4 * i + 1), intervalKeys: ['k'] }));
  const mml = sixRoles(`t120o4${'c4'.repeat(900)}`);
  const artifact = syntheticArtifact({
    mml,
    provisional_release_rendering: { applied: true, renderings, heldEventCount: 150, closedIntervalCount: 150, releaseOffsetSources: [] },
    machine_delivery: {
      schema: MACHINE_DELIVERY_SCHEMA_V2,
      unresolved_evidence_ledger: [
        { gate: 'microTiming', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], provisional_releases: [] },
        { gate: 'leadPromotion', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], unverified_lead_event_ids: Array.from({ length: 100 }, (_, i) => `m${i * 7 + 2}`) },
      ],
    },
    delivery: { flags: ['RELEASES_RENDERED_PROVISIONALLY', 'LEAD_UNVERIFIED'] },
  });
  const application = { ...stubApplication(artifact), async listBaselineEvents(owner, projectId, { eventIds }) { return { events: eventIds.map(id => ({ event_id: id, start: id.slice(1) })) }; } };
  const result = (await surface({ application }).call({ artifact_id: ARTIFACT_ID, compare_mml: mml.replace('c4', 'd4') })).result;
  assert.equal(result.isError, false);
  const view = result.structuredContent;
  assert.equal(view.markers.filter(marker => marker.kind === 'provisional-release').length, 150);
  assert.equal(view.markers.filter(marker => marker.kind === 'lead-unverified').length, LEAD_MARKER_BUDGET);
  assert.ok(outsideMml(view) <= LISTEN_RESPONSE.triggerBytes * 0.9, String(outsideMml(view)));
  assert.equal(view.response_compaction, undefined, 'at or below the trigger nothing is touched');
  assert.equal((await linkPayload(view.listen_link.url)).markers.length, 250);
  assert.ok(responseBytes(result) < MCP_RESULT_CAP / 2, String(responseBytes(result)));
});

test('an oversized listening view merges markers into fewer ranges, drops none, and says so', async () => {
  // A ledger that files 100 positions with long findings, and 100 caller notes
  // with long labels: well past the trigger.
  const finding = '聽'.repeat(190);
  const artifact = syntheticArtifact({
    mml: sixRoles(`t120o4${'c4'.repeat(500)}`),
    machine_delivery: {
      unresolved_evidence_ledger: [
        { gate: 'mobileAdaptation', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], locations: Array.from({ length: 100 }, (_, i) => ({ beat: String(i * 3), role: 'Chord1', finding })) },
        { gate: 'inGameAcceptance', classification: 'POST_DELIVERY', status: 'PENDING', blockers: [] },
      ],
    },
  });
  const markers = Array.from({ length: 100 }, (_, i) => ({ beat: String(i * 4 + 1), end_beat: String(i * 4 + 2), role: i % 2 ? 'Melody' : 'Chord2', kind: 'note', label: `n${i} `.padEnd(200, '·') }));
  const result = (await surface({ application: stubApplication(artifact) }).call({ artifact_id: ARTIFACT_ID, markers })).result;
  assert.equal(result.isError, false);
  const view = result.structuredContent;
  const compaction = view.response_compaction;
  assert.equal(compaction.schema, RESPONSE_COMPACTION.schema);
  assert.equal(compaction.trigger_bytes, RESPONSE_COMPACTION.triggerBytes);
  assert.equal(compaction.budget_bytes, RESPONSE_COMPACTION.budgetBytes);
  assert.deepEqual(compaction.compacted[0].path, ['markers']);
  assert.equal(compaction.compacted[0].total, 200);
  assert.equal(compaction.compacted[0].kept, view.markers.length);
  assert.deepEqual(compaction.retrieve, [{ tool: 'studio_artifact_get', arguments: { artifact_id: ARTIFACT_ID } }]);
  assert.match(compaction.notice, /nothing was dropped/);
  // Fewer markers, the same items: per kind and role the counts add up.
  assert.ok(view.markers.length < 200 && view.markers.length > 0);
  assert.ok(listBytes(view) <= LISTEN_RESPONSE.budgetBytes, String(listBytes(view)));
  const counted = (kind, role) => view.markers.filter(marker => marker.kind === kind && marker.role === role).reduce((sum, marker) => sum + marker.count, 0);
  assert.equal(counted('pending', 'Chord1'), 100);
  assert.equal(counted('note', 'Melody'), 50);
  assert.equal(counted('note', 'Chord2'), 50);
  assert.ok(view.markers.some(marker => marker.count > 1 && /回應大小上限，合併 \d+ 個標記/.test(marker.label)));
  // The markers stay a list the player renders, ids in order, and the link carries the same ones.
  assert.deepEqual(view.markers.map(marker => marker.id), view.markers.map((_, index) => `m${index + 1}`));
  assert.deepEqual((await linkPayload(view.listen_link.url)).markers.map(marker => [marker.kind, marker.beat, marker.role, marker.label]), view.markers.map(marker => [marker.kind, marker.beat, marker.role ?? undefined, marker.label]));
  assert.deepEqual(view.song_notes.map(note => note.gate), ['inGameAcceptance'], 'notes that fit are all sent');
  assert.match(result.content[0].text, /回應大小上限：標記已依種類與角色合併成 \d+ 個區段/);
  assert.ok(responseBytes(result) < MCP_RESULT_CAP / 4, String(responseBytes(result)));
});

test('marker merging keeps every item in exactly one range, per kind and role', () => {
  const at = (beat, extra = {}) => ({ beat: String(beat), end_beat: null, role: 'Chord3', kind: 'pending', gate: 'regression', source: 'machine-delivery-ledger', count: 1, label: `at ${beat}`, ...extra });
  const markers = [at(0), at(1), at(2, { count: 3 }), at(40), at(41), at(5, { role: 'Melody' }), at(6, { kind: 'changed', gate: null, source: 'caller' })];
  // A budget every marker fits keeps them all, merging only touching neighbours.
  const loose = mergeListenMarkers(markers, 100);
  assert.deepEqual(loose.map(marker => [marker.kind, marker.role, marker.beat, marker.count]), [
    ['pending', 'Chord3', '0', 1], ['pending', 'Chord3', '1', 1], ['pending', 'Chord3', '2', 3], ['pending', 'Melody', '5', 1], ['changed', 'Chord3', '6', 1], ['pending', 'Chord3', '40', 1], ['pending', 'Chord3', '41', 1],
  ]);
  assert.equal(loose[0], markers[0], 'an unmerged marker is the same object');
  const tight = mergeListenMarkers(markers, 1);
  assert.deepEqual(tight.map(marker => [marker.kind, marker.role, marker.beat, marker.end_beat, marker.count, marker.gate, marker.source]), [
    ['pending', 'Chord3', '0', '41', 7, 'regression', 'machine-delivery-ledger'], ['pending', 'Melody', '5', null, 1, 'regression', 'machine-delivery-ledger'], ['changed', 'Chord3', '6', null, 1, null, 'caller'],
  ]);
  assert.match(tight[0].label, /^待聽 ×7：beat 0–41（回應大小上限，合併 5 個標記）$/);
});

test('a link longer than the response allows is withheld with its reason; the player view is complete', async () => {
  // High-entropy synthetic MML and 200 markers with high-entropy labels: a view
  // under the trigger whose link cannot compress below the link bound.
  let seed = 20260923;
  const next = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return Math.floor(((seed >>> 0) / 4294967296) * n); };
  const noise = length => {
    let text = 't120';
    while (text.length < length - 8) text += `${'<>'[next(2)]}${'cdefgab'[next(7)]}${['', '+', '-'][next(3)]}${[1, 2, 4, 8, 16, 32][next(6)]}${next(4) ? '' : '.'}v${next(16)}`;
    return text;
  };
  const ALPHABET = [...Array(94)].map((_, i) => String.fromCharCode(33 + i)).filter(c => c !== '"' && c !== '\\').join('');
  const words = () => Array.from({ length: 200 }, () => ALPHABET[next(ALPHABET.length)]).join('');
  const mml = `MML@${Array.from({ length: 6 }, () => noise(6600)).join(',')};`;
  const compare = `MML@${Array.from({ length: 6 }, () => noise(6600)).join(',')};`;
  const artifact = syntheticArtifact({
    mml,
    machine_delivery: {
      unresolved_evidence_ledger: ['regression', 'versionDrift', 'playerReadback', 'mobileAdaptation'].map((gate, g) => ({
        gate, classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], locations: Array.from({ length: 25 }, (_, i) => ({ beat: String(i * 6 + g), finding: words() })),
      })),
    },
  });
  const markers = Array.from({ length: 100 }, (_, i) => ({ beat: String(i * 5 + 3), kind: 'note', label: words() }));
  const result = (await surface({ application: stubApplication(artifact) }).call({ artifact_id: ARTIFACT_ID, compare_mml: compare, markers })).result;
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent).slice(0, 300));
  const view = result.structuredContent;
  assert.equal(view.markers.length, 200);
  assert.equal(view.response_compaction, undefined, 'the view itself is under the trigger');
  assert.ok(outsideMml(view) <= LISTEN_RESPONSE.triggerBytes);
  assert.equal(view.listen_link, null);
  assert.equal(view.listen_link_status, 'LINK_TOO_LONG');
  assert.match(result.content[0].text, /試聽連結超過這個回應能帶的長度/);
  assert.equal(view.mml, mml, 'the MML is never cut');
  assert.equal(view.compare_mml, compare);
  // The same document is a valid link on its own; only this response withholds it.
  const url = await listenLinkUrl(STUDIO_WEB, {
    schema: 'mml-studio/listen-link@1', mml, title: view.title, meter_text: view.meter_text, compare_mml: compare,
    markers: view.markers.map(marker => ({ beat: marker.beat, kind: marker.kind, label: marker.label })),
  });
  assert.ok(url.length > LISTEN_RESPONSE.linkChars, String(url.length));
  assert.ok(responseBytes(result) < MCP_RESULT_CAP / 2, String(responseBytes(result)));
});
