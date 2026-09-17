// Agent Control Plane — which MCP clients can complete OAuth.
//
// The interface is advertised to ChatGPT, Claude, Codex and local agents. The
// authorization server therefore has to accept the callback shapes those
// clients actually use: exact HTTPS callbacks on the approved connector hosts,
// and RFC 8252 loopback redirects for native clients. Everything else about
// the flow — exact registered URI, PKCE S256, CSRF, the owner password — is
// unchanged and re-asserted here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication, DEFAULT_REDIRECT_HOSTS, parseRedirectHosts } from '../railway/server.mjs';
import { handleMcp } from '../server/mcp.mjs';

const origin = 'https://mml.example';
const password = 'SYNTHETIC_TEST_PASSWORD_ONLY_01234567890123456789';
const verifier = 'synthetic_pkce_verifier_012345678901234567890123456789';
const pkce = createHash('sha256').update(verifier).digest('base64url');
const options = { origin, ownerPassword: password, database: ':memory:' };
const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function setup(t, extra = {}) { const app = createApplication({ ...options, ...extra }); t.after(() => app.close()); return { app, send: request => app.fetch(request) }; }
const req = (path, method = 'GET', body, headers = {}) => new Request(origin + path, { method, headers, ...(body === undefined ? {} : { body }) });
const form = (path, body, headers = {}) => req(path, 'POST', new URLSearchParams(body), { 'content-type': 'application/x-www-form-urlencoded', ...headers });
const register = (send, redirect) => send(req('/oauth/register', 'POST', JSON.stringify({ client_name: 'client', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }), { 'content-type': 'application/json' }));

async function fullFlow(send, redirect) {
  const registered = await register(send, redirect);
  const registeredBody = await registered.text();
  assert.equal(registered.status, 201, `${redirect}: ${registeredBody}`);
  const client = JSON.parse(registeredBody);
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', resource: origin + '/mcp', code_challenge: pkce, code_challenge_method: 'S256', state: 's' });
  const page = await send(req('/oauth/authorize?' + params));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${new URL(redirect).origin.replace(/[.:/[\]]/g, '\\$&')}(;| )`));
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  const consent = await send(form('/oauth/authorize', { csrf, password, decision: 'allow' }, { cookie, origin }));
  assert.equal(consent.status, 303);
  const location = new URL(consent.headers.get('location'));
  assert.equal(location.origin + location.pathname, redirect);
  const token = await send(form('/oauth/token', { client_id: client.client_id, grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier }));
  assert.equal(token.status, 200);
  return (await token.json()).access_token;
}

test('the default callback allowlist covers the advertised connector hosts', () => {
  assert.deepEqual(DEFAULT_REDIRECT_HOSTS, ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com']);
  assert.deepEqual(parseRedirectHosts({}), DEFAULT_REDIRECT_HOSTS);
  assert.deepEqual(parseRedirectHosts({ MML_OAUTH_REDIRECT_HOSTS: ' chatgpt.com, Example.ORG ,' }), ['chatgpt.com', 'example.org']);
  assert.throws(() => parseRedirectHosts({ MML_OAUTH_REDIRECT_HOSTS: 'https://chatgpt.com' }), /host/);
  assert.throws(() => parseRedirectHosts({ MML_OAUTH_REDIRECT_HOSTS: '' }), /host/);
});

test('Claude and ChatGPT connectors complete the same OAuth flow against the same server', async t => {
  const { send } = setup(t);
  for (const redirect of ['https://chatgpt.com/connector_platform/oauth_redirect', 'https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']) {
    const token = await fullFlow(send, redirect);
    const response = await send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { ...rpcHeaders, authorization: 'Bearer ' + token }));
    assert.equal(response.status, 200, redirect);
  }
});

test('native clients may register RFC 8252 loopback callbacks; nothing else may use http or a port', async t => {
  const { send } = setup(t);
  for (const redirect of ['http://127.0.0.1:53421/callback', 'http://localhost:8123/oauth/callback', 'http://[::1]:9000/cb']) {
    await fullFlow(send, redirect);
  }
  for (const redirect of ['http://chatgpt.com/callback', 'https://chatgpt.com:8443/callback', 'http://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1.evil.example/callback', 'https://localhost:8123/cb#f', 'http://192.168.0.2:8080/cb', 'http://localhost:8123/cb?x=1#frag']) {
    assert.equal((await register(send, redirect)).status, 400, redirect);
  }
});

test('an operator can narrow or widen the callback hosts, and loopback can be switched off', async t => {
  const narrow = setup(t, { allowedRedirectHosts: ['chatgpt.com'], allowLoopbackRedirects: false });
  assert.equal((await register(narrow.send, 'https://claude.ai/api/mcp/auth_callback')).status, 400);
  assert.equal((await register(narrow.send, 'http://127.0.0.1:53421/callback')).status, 400);
  assert.equal((await register(narrow.send, 'https://chatgpt.com/connector_platform/oauth_redirect')).status, 201);
  const wide = setup(t, { allowedRedirectHosts: ['example.org'] });
  assert.equal((await register(wide.send, 'https://example.org/callback')).status, 201);
  assert.equal((await register(wide.send, 'https://chatgpt.com/connector_platform/oauth_redirect')).status, 400);
});

test('the MCP Origin allowlist follows the callback hosts, and the Sites worker default is unchanged', async t => {
  const { send } = setup(t);
  const token = await fullFlow(send, 'https://claude.ai/api/mcp/auth_callback');
  const ping = extra => send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { ...rpcHeaders, authorization: 'Bearer ' + token, ...extra }));
  for (const allowed of ['https://chatgpt.com', 'https://claude.ai', 'https://claude.com', origin]) assert.equal((await ping({ origin: allowed })).status, 200, allowed);
  for (const refused of ['https://evil.example', 'null', 'http://claude.ai', 'https://claude.ai.evil.example']) assert.equal((await ping({ origin: refused })).status, 403, refused);
  // Without an application attached (the Sites worker), only ChatGPT's origin is foreign-allowed, as before.
  const bare = extra => handleMcp(new Request(origin + '/mcp', { method: 'POST', headers: { ...rpcHeaders, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }));
  assert.equal((await bare({ origin: 'https://chatgpt.com' })).status, 200);
  assert.equal((await bare({ origin: 'https://claude.ai' })).status, 403);
});
