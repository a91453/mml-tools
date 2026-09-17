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
