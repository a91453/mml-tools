import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApplication, createHttpServer } from '../railway/server.mjs';

const origin = 'https://mml.example';
const password = 'SYNTHETIC_TEST_PASSWORD_ONLY_01234567890123456789';
const verifier = 'synthetic_pkce_verifier_012345678901234567890123456789';
const redirectUri = 'https://chatgpt.com/connector_platform/oauth_redirect';
const pkce = createHash('sha256').update(verifier).digest('base64url');
const options = { origin, ownerPassword: password, database: ':memory:' };
const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
function setup(t, extra = {}) { const app = createApplication({ ...options, ...extra }); t.after(() => app.close()); return request => app.fetch(request); }
function req(path, method = 'GET', body, headers = {}) { return new Request(origin + path, { method, headers, ...(body === undefined ? {} : { body }) }); }
const form = (path, body, headers = {}) => req(path, 'POST', new URLSearchParams(body), { 'content-type': 'application/x-www-form-urlencoded', ...headers });
async function register(send, extra = {}) {
  const response = await send(req('/oauth/register', 'POST', JSON.stringify({ client_name: 'Synthetic test client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', ...extra }), { 'content-type': 'application/json' }));
  assert.equal(response.status, 201); return response.json();
}
async function begin(send, clientId, extra = {}) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'mml:read', resource: origin + '/mcp', code_challenge: pkce, code_challenge_method: 'S256', state: 'synthetic-state', ...extra });
  return send(req('/oauth/authorize?' + params));
}
async function authorizedCode(send, clientId, usePassword = password) {
  const response = await begin(send, clientId); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const html = await response.text(), csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  const login = await send(form('/oauth/authorize', { csrf, password: usePassword, decision: 'allow' }, { cookie, origin }));
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get('location'));
  assert.equal(location.origin + location.pathname, redirectUri); assert.equal(location.searchParams.get('state'), 'synthetic-state'); assert.equal(location.searchParams.get('iss'), origin);
  return location.searchParams.get('code');
}
async function exchange(send, clientId, code, extra = {}) {
  return send(form('/oauth/token', { client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, resource: origin + '/mcp', ...extra }));
}
async function tokens(send) { const client = await register(send); const code = await authorizedCode(send, client.client_id); const response = await exchange(send, client.client_id, code); assert.equal(response.status, 200); return { client, code, ...(await response.json()) }; }
const mcpRequest = (token, extra = {}) => req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mml_validate', arguments: { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' } } }), { ...rpcHeaders, ...(token ? { authorization: 'Bearer ' + token } : {}), ...extra });

test('standalone MCP rejects anonymous and spoofed Sites identities; metadata discovers PKCE', async t => {
  const send = setup(t);
  for (const headers of [{}, { 'oai-authenticated-user-email': 'owner@example.com', 'oai-authenticated-user-id': 'fake' }]) {
    const response = await send(mcpRequest(null, headers)); assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  }
  const resource = await (await send(req('/.well-known/oauth-protected-resource/mcp'))).json();
  assert.equal(resource.resource, origin + '/mcp'); assert.deepEqual(resource.authorization_servers, [origin]);
  const metadata = await (await send(req('/.well-known/oauth-authorization-server'))).json();
  assert.equal(metadata.issuer, origin); assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']); assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
});
test('complete DCR, owner consent, token exchange, and MML validation', async t => {
  const send = setup(t), grant = await tokens(send);
  const response = await send(mcpRequest(grant.access_token)); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.result.structuredContent.technical_ok, true); assert.equal(data.result.structuredContent.pair_count, 15); assert.equal(data.result.structuredContent.gates.in_game_acceptance, 'PENDING');
});
test('login HTML preserves same-origin form Origin without leaking referrers cross-origin', async t => {
  const send = setup(t), client = await register(send), response = await begin(send, client.client_id);
  assert.equal(response.status, 200);
  // HTML navigation-mode POST uses the document policy. no-referrer makes
  // Origin null even for this same-origin form; Node fetch does not model it.
  // https://fetch.spec.whatwg.org/#append-a-request-origin-header
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/oauth\/authorize">/);
  assert.doesNotMatch(html, /<meta[^>]+name=["']referrer["']/i);
  const metadata = await send(req('/.well-known/oauth-authorization-server'));
  assert.equal(metadata.headers.get('referrer-policy'), 'no-referrer');
});
test('callbacks must be exact registered HTTPS addresses on approved hosts', async t => {
  const send = setup(t);
  for (const uri of ['https://evil.example/callback', 'http://chatgpt.com/callback', 'https://chatgpt.com.evil.example/callback', 'https://user:secret@chatgpt.com/callback', 'https://chatgpt.com/callback#fragment', 'https://chatgpt.com:8443/callback']) {
    const response = await send(req('/oauth/register', 'POST', JSON.stringify({ redirect_uris: [uri] }), { 'content-type': 'application/json' })); assert.equal(response.status, 400);
  }
  const client = await register(send);
  const response = await begin(send, client.client_id, { redirect_uri: redirectUri + '?changed=true' }); assert.equal(response.status, 400); assert.equal(response.headers.get('location'), null);
});
test('PKCE, scope, resource, and repeated parameters are checked', async t => {
  const send = setup(t), client = await register(send);
  for (const extra of [{ code_challenge_method: 'plain' }, { code_challenge: 'short' }, { scope: 'mml:write' }, { resource: 'https://another.example/mcp' }]) assert.equal((await begin(send, client.client_id, extra)).status, 400);
  const code = await authorizedCode(send, client.client_id);
  for (const extra of [{ code_verifier: 'wrong'.repeat(10) }, { resource: 'https://another.example/mcp' }, { redirect_uri: redirectUri + '/changed' }]) assert.equal((await exchange(send, client.client_id, code, extra)).status, 400);
  const duplicate = await send(form('/oauth/token', 'client_id=a&client_id=b&grant_type=authorization_code')); assert.equal(duplicate.status, 400);
  assert.equal((await exchange(send, client.client_id, code)).status, 200);
});
test('owner consent requires correct password, matching CSRF cookie and same origin', async t => {
  const send = setup(t), client = await register(send), response = await begin(send, client.client_id);
  const cookie = response.headers.get('set-cookie').split(';')[0]; const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())[1];
  for (const [body, headers] of [
    [{ csrf, password: 'wrong', decision: 'allow' }, { cookie, origin }],
    [{ csrf: 'wrong', password, decision: 'allow' }, { cookie, origin }],
    [{ csrf, password, decision: 'allow' }, { origin }],
    [{ csrf, password, decision: 'allow' }, { cookie, origin: 'https://evil.example' }],
  ]) assert.equal((await send(form('/oauth/authorize', body, headers))).status, 403);
});
test('login still rejects missing, null, and foreign Origins with otherwise valid consent', async t => {
  const send = setup(t), client = await register(send), response = await begin(send, client.client_id);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())[1];
  const body = { csrf, password, decision: 'allow' };
  for (const attemptedOrigin of [undefined, 'null', 'https://evil.example', 'https://mml.example.evil.example', 'http://mml.example', 'https://mml.example:8443']) {
    const rejected = await send(form('/oauth/authorize', body, {
      cookie, referer: origin + '/oauth/authorize', 'sec-fetch-site': 'same-origin',
      'x-forwarded-host': 'mml.example',
      ...(attemptedOrigin === undefined ? {} : { origin: attemptedOrigin }),
    }));
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error_description, 'Invalid form origin');
  }
  const accepted = await send(form('/oauth/authorize', body, { cookie, origin }));
  assert.equal(accepted.status, 302);
  assert.equal(accepted.headers.get('referrer-policy'), 'no-referrer');
  const code = new URL(accepted.headers.get('location')).searchParams.get('code');
  const exchanged = await exchange(send, client.client_id, code);
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.headers.get('referrer-policy'), 'no-referrer');
});
test('replaying an exchanged code revokes its token family', async t => {
  const send = setup(t), grant = await tokens(send);
  assert.equal((await exchange(send, grant.client.client_id, grant.code)).status, 400);
  assert.equal((await send(mcpRequest(grant.access_token))).status, 401);
});
test('refresh rotates; reuse revokes both old and new access tokens', async t => {
  const send = setup(t), grant = await tokens(send);
  const body = { client_id: grant.client.client_id, grant_type: 'refresh_token', refresh_token: grant.refresh_token, resource: origin + '/mcp' };
  const response = await send(form('/oauth/token', body)); assert.equal(response.status, 200); const updated = await response.json();
  assert.notEqual(updated.refresh_token, grant.refresh_token); assert.equal((await send(mcpRequest(updated.access_token))).status, 200);
  assert.equal((await send(form('/oauth/token', body))).status, 400);
  for (const token of [grant.access_token, updated.access_token]) assert.equal((await send(mcpRequest(token))).status, 401);
});
test('code and access expiry enforce lifetime while refresh remains usable', async t => {
  let clock = 100000; const send = setup(t, { now: () => clock });
  const client = await register(send), code = await authorizedCode(send, client.client_id); clock += 91;
  assert.equal((await exchange(send, client.client_id, code)).status, 400);
  const grant = await tokens(send); clock += 901;
  assert.equal((await send(mcpRequest(grant.access_token))).status, 401);
  assert.equal((await send(form('/oauth/token', { client_id: grant.client.client_id, grant_type: 'refresh_token', refresh_token: grant.refresh_token }))).status, 200);
});
test('revocation invalidates the grant without disclosing other tokens', async t => {
  const send = setup(t), grant = await tokens(send);
  assert.equal((await send(form('/oauth/revoke', { client_id: grant.client.client_id, token: 'not-a-token' }))).status, 200);
  assert.equal((await send(form('/oauth/revoke', { client_id: grant.client.client_id, token: grant.refresh_token }))).status, 200);
  assert.equal((await send(mcpRequest(grant.access_token))).status, 401);
});
test('database restart retains client and token state; password rotation revokes grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-auth-test-')), database = join(directory, 'auth.sqlite');
  let app;
  try {
    app = createApplication({ ...options, database }); const grant = await tokens(r => app.fetch(r)); app.close(); app = undefined;
    app = createApplication({ ...options, database }); assert.equal((await app.fetch(mcpRequest(grant.access_token))).status, 200); app.close(); app = undefined;
    const bytes = await readFile(database);
    for (const secret of [password, grant.access_token, grant.refresh_token, grant.code]) assert.equal(bytes.includes(Buffer.from(secret)), false);
    app = createApplication({ ...options, database, ownerPassword: password + '_rotated' });
    assert.equal((await app.fetch(mcpRequest(grant.access_token))).status, 401);
    await authorizedCode(r => app.fetch(r), grant.client.client_id, password + '_rotated');
  } finally { app?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('oversized auth input and repeated login requests are bounded', async t => {
  const send = setup(t);
  assert.equal((await send(req('/oauth/register', 'POST', ' '.repeat(16385), { 'content-type': 'application/json' }))).status, 413);
  for (let i = 0; i < 12; i++) await send(form('/oauth/authorize', {}, { origin }));
  assert.equal((await send(form('/oauth/authorize', {}, { origin }))).status, 429);
});
test('real loopback HTTP carries the complete OAuth and MCP sequence without external requests', async () => {
  const app = createApplication(options), server = createHttpServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = 'http://127.0.0.1:' + server.address().port;
  const send = async request => {
    const path = new URL(request.url).pathname + new URL(request.url).search;
    return fetch(local + path, { method: request.method, headers: request.headers, ...(request.method === 'GET' ? {} : { body: await request.text() }), redirect: 'manual' });
  };
  try {
    const grant = await tokens(send);
    for (const [id, method, params] of [[1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Synthetic HTTP test', version: '1' } }], [2, 'tools/list', {}], [3, 'tools/call', { name: 'mml_service_info', arguments: {} }]]) {
      const response = await send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id, method, params }), { ...rpcHeaders, authorization: 'Bearer ' + grant.access_token }));
      assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.id, id); assert.ok(data.result);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.close(); }
});
test('production configuration fails closed without credentials or HTTPS', () => {
  assert.throws(() => createApplication({ ...options, ownerPassword: 'short' }), /MML_OWNER_PASSWORD/);
  assert.throws(() => createApplication({ ...options, origin: 'http://example.com' }), /HTTPS/);
  assert.throws(() => createApplication({ ...options, database: undefined }), /Persistent/);
});
