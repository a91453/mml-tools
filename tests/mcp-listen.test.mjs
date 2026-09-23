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
  NODE_LISTEN_CODEC, createListenConfig, encodeListenPayload, listenConfigFromEnv, listenLinkUrl, parseStudioWebOrigin,
} from '../server/mcp-listen.mjs';
import { ListenLinkError, decodeListenLink, streamCodec } from '../studio/web/listen-link.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { sha256Hex } from '../studio/backend/source/sha256.mjs';
import { canonicalProjectBytes, keepEveryRole, sixRoleBaseline } from '../studio/tests/fixtures/application-fixtures.mjs';

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

// A stand-in Application Service holding one synthetic artifact, so the
// ledger shapes a later release may carry can be exercised directly.
function stubApplication(artifact) {
  return {
    async getArtifact(owner, artifactId) {
      if (artifactId !== artifact.artifact_id) {
        const error = Object.assign(new Error('Unknown artifact'), { name: 'StudioApplicationError', code: 'ARTIFACT_NOT_FOUND', details: {} });
        throw error;
      }
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

test('ledger entries with a position become markers; the rest are song-level notes', async () => {
  const artifact = syntheticArtifact({
    machine_delivery: {
      lifecycle: 'CANDIDATE',
      unresolved_evidence_ledger: [
        { gate: 'mobileAdaptation', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: ['X'], locations: [{ beat: '8', end_beat: '10', role: 'Chord1', finding: 'range check' }] },
        { gate: 'leadPromotion', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], events: [{ start: '4', role: 'Melody' }, { bar: 5, role: 'Melody', label: 'second promotion' }] },
        { gate: 'originalAudio', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], positions: [{ beat: '400' }] },
        { gate: 'inGameAcceptance', classification: 'POST_DELIVERY', status: 'PENDING', blockers: [] },
        { gate: 'core3', classification: 'BLOCKING', status: 'FAIL', blockers: ['CORE3'], locations: [{ beat: '2' }] },
        { gate: 'regression', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], locations: [{ beat: 'nonsense' }, { beat: 3.5 }] },
      ],
    },
    provisional_releases: [
      { bar: 3, role: 'Chord2', representation: 'EXTEND_TO_NEXT_GRID' },
      { event_id: 'no position at all' },
    ],
  });
  const mcp = surface({ application: stubApplication(artifact) });
  const result = (await mcp.call({ artifact_id: ARTIFACT_ID })).result;
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent).slice(0, 400));
  const view = result.structuredContent;
  assert.deepEqual(view.markers.map(marker => [marker.kind, marker.beat, marker.end_beat ?? null, marker.bar, marker.role, marker.gate, marker.source]), [
    ['pending', '7/2', null, 1, null, 'regression', 'machine-delivery-ledger'],
    ['lead-unverified', '4', null, 2, 'Melody', 'leadPromotion', 'machine-delivery-ledger'],
    ['pending', '8', '10', 3, 'Chord1', 'mobileAdaptation', 'machine-delivery-ledger'],
    ['provisional-release', '8', null, 3, 'Chord2', null, 'provisional-release'],
    ['lead-unverified', '16', null, 5, 'Melody', 'leadPromotion', 'machine-delivery-ledger'],
  ]);
  assert.match(view.markers.find(marker => marker.kind === 'provisional-release').label, /EXTEND_TO_NEXT_GRID/);
  assert.match(view.markers[2].label, /Mobile 適配審查：range check/);
  // A position past the end of the song and a gate with none are notes, not guesses.
  assert.deepEqual(view.song_notes.map(note => note.gate), ['inGameAcceptance', 'originalAudio']);
  assert.ok(!view.markers.some(marker => marker.gate === 'core3'), 'a BLOCKING entry is not a listening marker');
  assert.equal(view.source.lifecycle, 'CANDIDATE');
  assert.deepEqual((await linkPayload(view.listen_link.url)).markers.map(marker => marker.kind), ['pending', 'lead-unverified', 'pending', 'provisional-release', 'lead-unverified']);

  // The other name a later release may use, as an object.
  const renamed = syntheticArtifact({ provisional_release_representation: { decisions: [{ id: 'd1', eventIds: ['e'], locations: [{ beat: '12', role: 'Chord3' }] }] } });
  const other = (await surface({ application: stubApplication(renamed) }).call({ artifact_id: ARTIFACT_ID })).result.structuredContent;
  assert.deepEqual(other.markers.map(marker => [marker.kind, marker.beat, marker.role]), [['provisional-release', '12', 'Chord3']]);

  const notFinal = (await surface({ application: stubApplication({ ...artifact, type: 'report' }) }).call({ artifact_id: ARTIFACT_ID })).result;
  assert.equal(notFinal.structuredContent.error.details.reason, 'LISTEN_ARTIFACT_NOT_FINAL');
});

test('markers are capped at 500 and an oversized link is withheld, not truncated', async () => {
  const label = '聽'.repeat(190);
  const artifact = syntheticArtifact({
    mml: `MML@t120${'o4c4'.repeat(500)},,,,,;`,
    machine_delivery: {
      unresolved_evidence_ledger: [{ gate: 'mobileAdaptation', classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [], locations: Array.from({ length: 499 }, (_, i) => ({ beat: String(i), finding: label })) }],
    },
    provisional_releases: Array.from({ length: 30 }, (_, i) => ({ beat: String(i), representation: label })),
  });
  const result = (await surface({ application: stubApplication(artifact) }).call({ artifact_id: ARTIFACT_ID })).result;
  const view = result.structuredContent;
  assert.equal(view.markers.length, 500);
  assert.equal(view.truncated_markers, 29);
  assert.equal(view.listen_link, null);
  assert.equal(view.listen_link_status, 'PAYLOAD_TOO_LARGE');
  assert.match(result.content[0].text, /256 KB/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 524288);
});
