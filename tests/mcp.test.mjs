import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, MCP_TOOLS, MCP_VERSIONS, MAX_BODY_BYTES, UNSUPPORTED_PROTOCOL_VERSION } from '../server/mcp.mjs';
import { createWorker } from '../server/worker.mjs';
import { DEMO, validateMML } from '../dist/core.js';

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const req = (body, extra = {}) => new Request('https://mml.example/mcp', { method: 'POST', headers: { ...headers, ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const call = async (name, args = {}) => (await (await handleMcp(req({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))).json());
const simple = { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' };

test('initialize negotiates supported protocol and advertises only implemented capability', async () => {
  for (const protocolVersion of [...MCP_VERSIONS, 'future']) {
    const response = await handleMcp(req({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } } }));
    const data = await response.json();
    assert.equal(data.id, 0); assert.equal(data.result.protocolVersion, protocolVersion === 'future' ? MCP_VERSIONS[0] : protocolVersion);
    assert.deepEqual(data.result.capabilities, { tools: { listChanged: false } });
    assert.equal(response.headers.get('mcp-session-id'), null);
  }
});
test('list has exactly three read-only closed-world tools', async () => {
  const data = await (await handleMcp(req({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }))).json();
  assert.deepEqual(data.result.tools, MCP_TOOLS);
  for (const t of data.result.tools) { assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.openWorldHint, false); assert.equal(t.inputSchema.additionalProperties, false); }
});
test('valid MML uses existing core and leaves evidence gates unverified', async () => {
  const data = (await call('mml_validate', simple)).result;
  assert.equal(data.isError, false); assert.equal(data.structuredContent.technical_ok, true);
  assert.equal(data.structuredContent.pair_count, 15); assert.equal(data.structuredContent.tracks.length, 6);
  assert.equal(data.structuredContent.estimated_seconds, 2);
  assert.equal(data.structuredContent.gates.in_game_acceptance, 'PENDING');
  assert.equal(data.structuredContent.gates.player_readback, 'NOT_RUN');
  assert.equal(data.structuredContent.changed_input, false);
  assert.deepEqual(JSON.parse(data.content[0].text), data.structuredContent);
});
test('synthetic mixed-meter demo matches core counts', async () => {
  const args = { mml: DEMO, meter_text: '0 4/4\n8 2/4\n10 4/4' };
  const data = (await call('mml_validate', args)).result.structuredContent;
  const expected = validateMML(DEMO, { meterText: args.meter_text });
  assert.equal(data.technical_ok, expected.ok); assert.equal(data.total_beats, expected.song.total);
  assert.deepEqual(data.tracks.map(t => t.note_events), expected.song.tracks.map(t => t.events.length));
});
test('invalid MML is a normal validation failure, never music approval', async () => {
  for (const mml of ['MML@t120c1,,,,,;', 'MML@t120o4n60,,,,,;', 'MML@t120o4c48,,,,,;', 'MML@t120o4c1,t121o4c1,,,,;', 'MML@t120o4c1&,,,,,;']) {
    const data = (await call('mml_validate', { ...simple, mml })).result;
    assert.equal(data.isError, false); assert.equal(data.structuredContent.technical_ok, false); assert.ok(data.structuredContent.error_count > 0);
  }
});
test('all 15 overlap pairs retain total counts while details paginate', async () => {
  const mml = 'MML@' + Array(6).fill('t120o4c4c4c4c4').join(',') + ';';
  const first = (await call('mml_overlap_details', { ...simple, mml, limit: 7 })).result.structuredContent;
  assert.equal(first.pair_count, 15); assert.equal(first.total_items, 60); assert.equal(first.items.length, 7); assert.equal(first.next_offset, 7);
  assert.equal(first.pairs.reduce((n, p) => n + p.overlap_count, 0), 60);
  const last = (await call('mml_overlap_details', { ...simple, mml, offset: 56, limit: 7 })).result.structuredContent;
  assert.equal(last.items.length, 4); assert.equal(last.next_offset, null);
});
test('meter is required, unknown fields and invalid types are rejected', async () => {
  for (const args of [{ mml: simple.mml }, { ...simple, fetch_url: 'https://example.com' }, { ...simple, programs: [0] }, { ...simple, error_offset: -1 }, { ...simple, meter_text: 4 }, { ...simple, title: 'x'.repeat(121) }]) assert.equal((await call('mml_validate', args)).error.code, -32602);
  assert.equal((await call('mml_validate', JSON.parse('{"__proto__":{}}'))).error.code, -32602);
  assert.equal((await call('unknown')).error.code, -32602);
});
test('pathological numeric inputs stop before rational parsing', async () => {
  for (const args of [{ ...simple, mml: 'MML@t' + '9'.repeat(1000) + 'o4c1,,,,,;' }, { ...simple, pickup: '9'.repeat(30) }, { ...simple, meter_text: '0 4/4\n' + '9'.repeat(1000) + ' 4/4' }]) assert.equal((await call('mml_validate', args)).result.isError, true);
});
test('protocol errors, notifications, and method handling are explicit', async () => {
  assert.equal((await handleMcp(req('{'))).status, 400);
  assert.equal((await handleMcp(req([]))).status, 400);
  assert.equal((await handleMcp(req({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
  assert.equal((await handleMcp(req({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'mml_validate', arguments: simple } }))).status, 400);
  assert.equal((await (await handleMcp(req({ jsonrpc: '2.0', id: 1, method: 'unknown' }))).json()).error.code, -32601);
  assert.equal((await (await handleMcp(req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))).json()).error.code, -32602);
  assert.equal((await handleMcp(new Request('https://mml.example/mcp'))).status, 405);
  assert.equal((await handleMcp(req('{}', { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handleMcp(req('{}', { accept: 'application/json' }))).status, 406);
  assert.equal((await handleMcp(req('{}', { 'mcp-protocol-version': 'bogus' }))).status, 400);
  assert.equal((await handleMcp(req('{}', { origin: 'https://evil.example' }))).status, 403);
});
test('a request at a protocol version this server does not speak is refused with the versions it does', async () => {
  // The MCP SDK's default connect policy probes server/discover at its newest
  // version (2026-07-28) before anything else. The refusal names the versions
  // this server speaks, in the -32022 shape that client reads, so it falls
  // back to the initialize handshake; the refusal is logged with what the
  // platform HTTP log cannot show, and never with a body.
  const rejected = [];
  const rejectLog = entry => rejected.push(entry);
  const probe = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
  const response = await handleMcp(req(probe, { 'mcp-protocol-version': '2026-07-28', 'user-agent': 'python-httpx2/2.13.1' }), { rejectLog });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    jsonrpc: '2.0', id: 1,
    error: { code: UNSUPPORTED_PROTOCOL_VERSION, message: 'Unsupported MCP protocol version', data: { supported: MCP_VERSIONS, requested: '2026-07-28' } },
  });
  assert.deepEqual(rejected, [{ status: 400, reason: 'Unsupported MCP protocol version', method: 'server/discover', protocol_version_header: '2026-07-28', user_agent: 'python-httpx2/2.13.1' }]);
  // The fallback handshake that follows carries no header and negotiates.
  const init = await handleMcp(req({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: MCP_VERSIONS[0], capabilities: {}, clientInfo: { name: 'mcp', version: '2' } } }), { rejectLog });
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.protocolVersion, MCP_VERSIONS[0]);
  // A notification at an unsupported version is refused the same way, with a
  // null id; a supported header is not logged; other refusals are.
  const note = await handleMcp(req({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2099-01-01' }), { rejectLog });
  assert.equal(note.status, 400);
  assert.equal((await note.json()).id, null);
  assert.equal((await handleMcp(req({ jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-protocol-version': MCP_VERSIONS[1] }), { rejectLog })).status, 200);
  assert.equal(rejected.length, 2);
  await handleMcp(req('{', { 'user-agent': 'Broken' }), { rejectLog });
  assert.deepEqual(rejected.at(-1), { status: 400, reason: 'Invalid JSON', method: null, protocol_version_header: null, user_agent: 'Broken' });
  // A logger that throws never turns a refusal into a crash.
  assert.equal((await handleMcp(req('{'), { rejectLog: () => { throw Error('log sink down'); } })).status, 400);
});
test('content-length and streaming byte limits both enforced', async () => {
  assert.equal((await handleMcp(req('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }))).status, 413);
  assert.equal((await handleMcp(req(' '.repeat(MAX_BODY_BYTES + 1)))).status, 413);
  assert.equal((await handleMcp(req('中'.repeat(MAX_BODY_BYTES / 2)))).status, 413);
});
test('worker requires gateway identity, retains assets, and rejects missing routes', async () => {
  const worker = createWorker({ '/index.html': { type: 'text/html', body: '<h1>Workbench</h1>', encoding: 'utf8' } });
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mml_service_info', arguments: {} } };
  assert.equal((await worker.fetch(req(body))).status, 401);
  assert.equal((await worker.fetch(req(body, { 'oai-authenticated-user-email': 'synthetic@example.com' }))).status, 200);
  assert.equal(await (await worker.fetch(new Request('https://mml.example/'))).text(), '<h1>Workbench</h1>');
  assert.equal((await worker.fetch(new Request('https://mml.example/not-found'))).status, 404);
  assert.equal(await (await worker.fetch(new Request('https://mml.example/', { method: 'HEAD' }))).text(), '');
});
