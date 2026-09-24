import test from 'node:test';
import assert from 'node:assert/strict';
import * as mcpModule from '../server/mcp.mjs';
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
// 2025-03-26 requires a server to receive JSON-RPC batches and forbids
// initialize inside one; 2025-06-18 removed batching. A request without the
// version header speaks 2025-03-26.
const at2025_03_26 = { 'mcp-protocol-version': '2025-03-26' };
test('a 2025-03-26 batch of a request and a notification answers the request alone', async () => {
  const batch = [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }];
  for (const extra of [at2025_03_26, {}]) {
    const response = await handleMcp(req(batch, extra));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await response.json(), [{ jsonrpc: '2.0', id: 2, result: { tools: MCP_TOOLS } }]);
  }
  // Each element takes the path a single message takes: the same tool report.
  const single = (await call('mml_validate', simple)).result;
  const [batched] = await (await handleMcp(req([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mml_validate', arguments: simple } }], at2025_03_26))).json();
  assert.deepEqual(batched.result, single);
  // The batch passes the same gateway identity check a single message does.
  const worker = createWorker({});
  assert.equal((await worker.fetch(req(batch, at2025_03_26))).status, 401);
  const viaWorker = await worker.fetch(req(batch, { ...at2025_03_26, 'oai-authenticated-user-email': 'synthetic@example.com' }));
  assert.equal(viaWorker.status, 200);
  assert.deepEqual((await viaWorker.json()).map(response => response.id), [2]);
});
test('a 2025-03-26 batch of notifications alone is accepted with 202 and no body', async () => {
  const response = await handleMcp(req([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }], at2025_03_26));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
  // Input of notifications alone that the server cannot accept is refused with
  // 400 and a JSON-RPC error without an id, as a single refused one is.
  const refused = await handleMcp(req([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'mml_validate', arguments: simple } }], at2025_03_26));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported notification' } });
});
test('a notification the server does not accept adds no entry to a batch that carries requests', async () => {
  // JSON-RPC 2.0 never answers a notification, inside a batch or not, so the
  // reply holds the request's response alone; the refusal is still logged.
  const rejected = [];
  const response = await handleMcp(req([
    { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'mml_validate', arguments: simple } },
  ], at2025_03_26), { rejectLog: entry => rejected.push(entry) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ jsonrpc: '2.0', id: 7, result: {} }]);
  assert.deepEqual(rejected.map(entry => [entry.reason, entry.method, entry.batch_index]), [
    ['Unsupported notification', 'notifications/roots/list_changed', 0],
    ['Unsupported notification', 'tools/call', 2],
  ]);
  // A malformed element is still answered, with id null, as JSON-RPC requires.
  const malformed = await handleMcp(req([{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', method: 5 }], at2025_03_26));
  assert.deepEqual(await malformed.json(), [{ jsonrpc: '2.0', id: 8, result: {} }, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } }]);
});
test('batch elements run one after another in their order', async () => {
  // A tool call may write, so an element starts only once the one before it
  // has finished, even when the earlier one is the slower.
  const events = [];
  const application = { getArtifact: async (_owner, id) => {
    events.push(`start ${id[0]}`);
    await new Promise(resolve => setTimeout(resolve, id[0] === 'a' ? 30 : 0));
    events.push(`end ${id[0]}`);
    return { artifact: { artifact_id: id } };
  } };
  const call = (id, artifact_id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'studio_artifact_get', arguments: { artifact_id } } });
  const response = await handleMcp(req([call(1, 'a'.repeat(68)), call(2, 'b'.repeat(68))], at2025_03_26), { application, owner: 'owner:batch-order' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map(reply => [reply.id, reply.result.isError ?? false]), [[1, false], [2, false]]);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b']);
});
test('a batch carrying initialize is refused whole', async () => {
  const rejected = [];
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
  for (const batch of [[init], [{ jsonrpc: '2.0', id: 2, method: 'ping' }, init]]) {
    const response = await handleMcp(req(batch), { rejectLog: entry => rejected.push(entry) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'initialize must not be part of a JSON-RPC batch' } });
  }
  assert.deepEqual(rejected.map(entry => [entry.status, entry.method]), [[400, 'initialize'], [400, 'initialize']]);
});
test('batches are refused at 2025-06-18 and later, when empty, at an unknown version and past the size cap', async () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  for (const version of ['2025-11-25', '2025-06-18']) {
    const response = await handleMcp(req([ping], { 'mcp-protocol-version': version }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC batches are not supported at this MCP protocol version' } });
  }
  // The single message is still answered at those versions.
  assert.equal((await handleMcp(req(ping, { 'mcp-protocol-version': '2025-11-25' }))).status, 200);
  for (const extra of [at2025_03_26, {}]) {
    const empty = await handleMcp(req([], extra));
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, -32600);
  }
  const future = await handleMcp(req([ping], { 'mcp-protocol-version': '2026-07-28' }));
  assert.equal(future.status, 400);
  assert.deepEqual((await future.json()).error, { code: UNSUPPORTED_PROTOCOL_VERSION, message: 'Unsupported MCP protocol version', data: { supported: MCP_VERSIONS, requested: '2026-07-28' } });
  const { MAX_BATCH_MESSAGES } = mcpModule;
  assert.ok(Number.isSafeInteger(MAX_BATCH_MESSAGES) && MAX_BATCH_MESSAGES > 1);
  const full = Array.from({ length: MAX_BATCH_MESSAGES }, (_, id) => ({ ...ping, id }));
  assert.equal((await (await handleMcp(req(full, at2025_03_26))).json()).length, MAX_BATCH_MESSAGES);
  const over = await handleMcp(req([...full, { ...ping, id: MAX_BATCH_MESSAGES }], at2025_03_26));
  assert.equal(over.status, 400);
  assert.deepEqual((await over.json()).error.data, { max_messages: MAX_BATCH_MESSAGES });
});
test('an element that fails inside a batch answers with its own error while the others succeed', async () => {
  const rejected = [];
  const response = await handleMcp(req([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'unknown' } },
    { jsonrpc: '2.0', id: { bad: true }, method: 'ping' },
    'not a message',
    { jsonrpc: '2.0', id: 'u', method: 'unknown' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mml_validate', arguments: simple } },
  ], { ...at2025_03_26, 'user-agent': 'batcher' }), { rejectLog: entry => rejected.push(entry) });
  assert.equal(response.status, 200);
  const replies = await response.json();
  assert.equal(replies.length, 6);
  assert.deepEqual(replies.slice(0, 5), [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request id' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } },
    { jsonrpc: '2.0', id: 'u', error: { code: -32601, message: 'Method not found' } },
  ]);
  assert.equal(replies[5].id, 3);
  assert.equal(replies[5].result.structuredContent.technical_ok, true);
  // The elements refused before dispatch are logged one by one, as a single
  // refused message is, with their place in the batch.
  assert.deepEqual(rejected, [
    { status: 400, reason: 'Invalid request id', method: 'ping', protocol_version_header: '2025-03-26', user_agent: 'batcher', batch_index: 2 },
    { status: 400, reason: 'Invalid JSON-RPC request', method: null, protocol_version_header: '2025-03-26', user_agent: 'batcher', batch_index: 3 },
  ]);
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
