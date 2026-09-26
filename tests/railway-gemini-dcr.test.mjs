// Google Gemini custom MCP connectors — Dynamic Client Registration.
//
// Gemini calls back through Google's OAuth relay with a per-user, per-connector
// path, and registers the way a server-side RFC 7591 client does: it may ask
// for a secret-based token_endpoint_auth_method (RFC 7591 §2 makes
// client_secret_basic the default a client assumes) and for offline_access.
// This server answers with the public PKCE client it always issues: no secret,
// token_endpoint_auth_method `none`, scope mml:read. Google's relay host is
// admitted only when the operator lists it in MML_OAUTH_REDIRECT_HOSTS; every
// other callback rule, PKCE S256 and the public-client token exchange are
// unchanged and re-asserted here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication, DEFAULT_REDIRECT_HOSTS, parseRedirectHosts } from '../railway/server.mjs';

const origin = 'https://mml.example';
const password = 'SYNTHETIC_TEST_PASSWORD_ONLY_01234567890123456789';
const verifier = 'synthetic_pkce_verifier_012345678901234567890123456789';
const pkce = createHash('sha256').update(verifier).digest('base64url');
const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
// The production host list, as the operator set it (with the line break the
// dashboard value carried).
const productionHosts = parseRedirectHosts({ MML_OAUTH_REDIRECT_HOSTS: '\nchatgpt.com,chat.openai.com,claude.ai,claude.com,oauth-redirect.googleusercontent.com' });
// Synthetic connector ids in Gemini's callback shape; no real account id.
const gemini = (id = '000000000000000000001') => `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-${id}-mml_example`;
const chatgpt = 'https://chatgpt.com/connector_platform/oauth_redirect';
const claude = 'https://claude.ai/api/mcp/auth_callback';
// What a server-side RFC 7591 client such as Google's connector registers with.
const geminiMetadata = redirect => ({ client_name: 'Gemini', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic', scope: 'mml:read offline_access', application_type: 'web' });

// Registration is rate limited to 12 a minute; the clock moves 6 s per
// registration so a test can register more than that without waiting.
function setup(t, extra = {}) {
  const rejected = []; let clock = 1_800_000_000;
  const app = createApplication({ origin, ownerPassword: password, database: ':memory:', allowedRedirectHosts: productionHosts, oauthRejectLog: entry => rejected.push(entry), now: () => clock, ...extra });
  t.after(() => app.close());
  return { send: request => { if (new URL(request.url).pathname === '/oauth/register') clock += 6; return app.fetch(request); }, rejected };
}
const req = (path, method = 'GET', body, headers = {}) => new Request(origin + path, { method, headers, ...(body === undefined ? {} : { body }) });
const form = (path, body, headers = {}) => req(path, 'POST', new URLSearchParams(body), { 'content-type': 'application/x-www-form-urlencoded', ...headers });
const registerRaw = (send, metadata) => send(req('/oauth/register', 'POST', JSON.stringify(metadata), { 'content-type': 'application/json' }));
async function register(send, metadata) {
  const response = await registerRaw(send, metadata), text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}
async function refused(send, metadata, error) {
  const response = await registerRaw(send, metadata);
  assert.equal(response.status, 400, JSON.stringify(metadata));
  assert.equal((await response.json()).error, error, JSON.stringify(metadata));
}
const authorizeParams = (clientId, redirect, extra = {}) => new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'mml:read', resource: origin + '/mcp', code_challenge: pkce, code_challenge_method: 'S256', state: 'synthetic-state', ...extra });

// Owner consent through the real login page; returns the authorization code.
async function consent(send, clientId, redirect, extra = {}) {
  const page = await send(req('/oauth/authorize?' + authorizeParams(clientId, redirect, extra)));
  assert.equal(page.status, 200, await page.clone().text());
  assert.match(page.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${new URL(redirect).origin.replace(/[.:/]/g, '\\$&')};`));
  const cookie = page.headers.get('set-cookie').split(';')[0], csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  const approved = await send(form('/oauth/authorize', { csrf, password, decision: 'allow' }, { cookie, origin }));
  assert.equal(approved.status, 303);
  const location = new URL(approved.headers.get('location'));
  assert.equal(location.origin + location.pathname, redirect);
  assert.equal(location.searchParams.get('state'), extra.state ?? 'synthetic-state');
  return location.searchParams.get('code');
}
const exchange = (send, clientId, code, extra = {}, headers = {}) => send(form('/oauth/token', { client_id: clientId, grant_type: 'authorization_code', code, code_verifier: verifier, resource: origin + '/mcp', ...extra }, headers));
const ping = (send, token) => send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { ...rpcHeaders, authorization: 'Bearer ' + token }));

test('Google\'s relay is opt-in: the defaults are unchanged and the production host list admits it', t => {
  assert.deepEqual(DEFAULT_REDIRECT_HOSTS, ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com']);
  assert.deepEqual(productionHosts, [...DEFAULT_REDIRECT_HOSTS, 'oauth-redirect.googleusercontent.com']);
  // Wildcards and whole-domain forms are not bare hosts and refuse to start.
  for (const value of ['*.googleusercontent.com', 'https://oauth-redirect.googleusercontent.com', 'oauth-redirect.googleusercontent.com/r']) {
    assert.throws(() => parseRedirectHosts({ MML_OAUTH_REDIRECT_HOSTS: value }), /host/, value);
  }
});

test('a Gemini connector registers as a public PKCE client and completes the whole flow', async t => {
  const { send } = setup(t), redirect = gemini();
  const client = await register(send, geminiMetadata(redirect));
  // The requested secret-based method is replaced, not honoured: no secret.
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in client, false);
  assert.equal('client_secret_expires_at' in client, false);
  assert.deepEqual(client.redirect_uris, [redirect]);
  assert.deepEqual(client.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(client.response_types, ['code']);
  assert.equal(client.scope, 'mml:read');
  // Gemini may ask for offline_access at authorize too; mml:read is granted.
  const code = await consent(send, client.client_id, redirect, { scope: 'mml:read offline_access' });
  const token = await exchange(send, client.client_id, code);
  assert.equal(token.status, 200);
  const grant = await token.json();
  assert.equal(grant.scope, 'mml:read');
  assert.equal((await ping(send, grant.access_token)).status, 200);
  const refreshed = await send(form('/oauth/token', { client_id: client.client_id, grant_type: 'refresh_token', refresh_token: grant.refresh_token }));
  assert.equal(refreshed.status, 200);
  assert.equal((await ping(send, (await refreshed.json()).access_token)).status, 200);
});

test('each registrable token endpoint auth method yields `none`; key- and TLS-bound methods are refused', async t => {
  const { send } = setup(t);
  for (const method of [undefined, 'none', 'client_secret_basic', 'client_secret_post']) {
    const client = await register(send, { ...geminiMetadata(gemini()), token_endpoint_auth_method: method });
    assert.equal(client.token_endpoint_auth_method, 'none', String(method));
    assert.equal('client_secret' in client, false, String(method));
  }
  for (const method of ['private_key_jwt', 'client_secret_jwt', 'tls_client_auth', 'self_signed_tls_client_auth', 'NONE', '', 1, ['none'], null]) {
    await refused(send, { ...geminiMetadata(gemini()), token_endpoint_auth_method: method }, 'invalid_client_metadata');
  }
});

test('a registration may list up to ten callbacks, each one still checked', async t => {
  const { send } = setup(t);
  const ten = Array.from({ length: 10 }, (_, i) => gemini(String(i).padStart(21, '0')));
  const client = await register(send, { ...geminiMetadata(ten[0]), redirect_uris: ten });
  assert.deepEqual(client.redirect_uris, ten);
  // Any listed callback can then be used, and only a listed one.
  await consent(send, client.client_id, ten[9]);
  assert.equal((await send(req('/oauth/authorize?' + authorizeParams(client.client_id, gemini('999999999999999999999'))))).status, 400);
  // Gemini alongside the other connectors in one registration.
  await register(send, { ...geminiMetadata(ten[0]), redirect_uris: [ten[0], chatgpt, claude] });
  // Still bounded, never empty, and one unapproved callback refuses them all.
  await refused(send, { ...geminiMetadata(ten[0]), redirect_uris: [...ten, gemini('100000000000000000000')] }, 'invalid_redirect_uri');
  await refused(send, { ...geminiMetadata(ten[0]), redirect_uris: [] }, 'invalid_redirect_uri');
  await refused(send, { ...geminiMetadata(ten[0]), redirect_uris: [ten[0], 'https://evil.example/callback'] }, 'invalid_redirect_uri');
  await refused(send, { ...geminiMetadata(ten[0]), redirect_uris: ten[0] }, 'invalid_redirect_uri');
});

test('only the exact relay host is admitted: other Google hosts and lookalikes are refused', async t => {
  const { send } = setup(t);
  for (const redirect of [
    'https://googleusercontent.com/r/user_bound_custom-mcp-1-mml_example',
    'https://lh3.googleusercontent.com/r/user_bound_custom-mcp-1-mml_example',
    'https://evil.googleusercontent.com/r/user_bound_custom-mcp-1-mml_example',
    'https://oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-1-mml_example',
    'https://oauth-redirect.googleusercontent.com.evil.example/r/user_bound_custom-mcp-1-mml_example',
    'https://evil.example/r/user_bound_custom-mcp-1-mml_example',
    'https://accounts.google.com/o/oauth2/callback',
  ]) await refused(send, geminiMetadata(redirect), 'invalid_redirect_uri');
  // Without the operator opt-in, the defaults refuse Gemini's callback outright.
  const defaults = setup(t, { allowedRedirectHosts: undefined });
  await refused(defaults.send, geminiMetadata(gemini()), 'invalid_redirect_uri');
});

test('a Gemini callback must be exact HTTPS: no http, port, userinfo or fragment', async t => {
  const { send } = setup(t);
  for (const redirect of [
    gemini().replace('https:', 'http:'),
    gemini().replace('googleusercontent.com/', 'googleusercontent.com:8443/'),
    gemini().replace('https://', 'https://user:secret@'),
    gemini() + '#fragment',
    'http://evil.example/callback',
    'javascript:alert(1)',
  ]) await refused(send, geminiMetadata(redirect), 'invalid_redirect_uri');
});

test('ChatGPT and Claude callbacks still register and complete the flow beside Gemini', async t => {
  const { send } = setup(t);
  for (const redirect of [chatgpt, 'https://chat.openai.com/connector_platform/oauth_redirect', claude, 'https://claude.com/api/mcp/auth_callback']) {
    // The request shapes those connectors send today, unchanged.
    const client = await register(send, { client_name: 'connector', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
    assert.equal(client.token_endpoint_auth_method, 'none');
    const code = await consent(send, client.client_id, redirect);
    const token = await exchange(send, client.client_id, code, { redirect_uri: redirect });
    assert.equal(token.status, 200, redirect);
    assert.equal((await ping(send, (await token.json()).access_token)).status, 200, redirect);
  }
});

test('client secrets stay refused: none is issued, none may be registered, none is accepted', async t => {
  const { send } = setup(t), redirect = gemini();
  await refused(send, { ...geminiMetadata(redirect), client_secret: 'chosen-by-client' }, 'invalid_client_metadata');
  const client = await register(send, geminiMetadata(redirect));
  const code = await consent(send, client.client_id, redirect);
  for (const [extra, headers] of [
    [{ client_secret: 'anything' }, {}],
    [{ client_secret: '' }, {}],
    [{}, { authorization: 'Basic ' + Buffer.from(client.client_id + ':anything').toString('base64') }],
    [{}, { authorization: 'Basic ' + Buffer.from(client.client_id + ':').toString('base64') }],
  ]) {
    const response = await exchange(send, client.client_id, code, extra, headers);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'invalid_client');
  }
  // The refused attempts did not consume the code: the public exchange works.
  assert.equal((await exchange(send, client.client_id, code)).status, 200);
  const metadata = await (await send(req('/.well-known/oauth-authorization-server'))).json();
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
});

test('PKCE S256 is still required of a Gemini client', async t => {
  const { send } = setup(t), redirect = gemini();
  const client = await register(send, geminiMetadata(redirect));
  for (const extra of [{ code_challenge_method: 'plain', code_challenge: verifier }, { code_challenge: 'short' }, { code_challenge_method: '' }]) {
    assert.equal((await send(req('/oauth/authorize?' + authorizeParams(client.client_id, redirect, extra)))).status, 400, JSON.stringify(extra));
  }
  const withoutPkce = authorizeParams(client.client_id, redirect); withoutPkce.delete('code_challenge'); withoutPkce.delete('code_challenge_method');
  assert.equal((await send(req('/oauth/authorize?' + withoutPkce))).status, 400);
  const code = await consent(send, client.client_id, redirect);
  for (const code_verifier of ['', 'wrong_verifier_0123456789012345678901234567890123', verifier + 'x']) {
    const response = await exchange(send, client.client_id, code, { code_verifier });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
  }
  assert.equal((await exchange(send, client.client_id, code)).status, 200);
  const metadata = await (await send(req('/.well-known/oauth-authorization-server'))).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
});

test('scope: only mml:read and offline_access are tolerated, and mml:read is all that is granted', async t => {
  const { send } = setup(t), redirect = gemini();
  for (const scope of [undefined, '', 'mml:read', 'offline_access', 'mml:read offline_access', 'offline_access mml:read']) {
    assert.equal((await register(send, { ...geminiMetadata(redirect), scope })).scope, 'mml:read', String(scope));
  }
  for (const scope of ['mml:write', 'mml:read mml:write', 'openid', 'mml:read\toffline_access', ['mml:read'], 7, 'x'.repeat(257)]) {
    await refused(send, { ...geminiMetadata(redirect), scope }, 'invalid_scope');
  }
  const client = await register(send, geminiMetadata(redirect));
  for (const scope of ['mml:write', 'openid mml:read', 'admin']) {
    assert.equal((await send(req('/oauth/authorize?' + authorizeParams(client.client_id, redirect, { scope })))).status, 400, scope);
  }
});

test('a refused registration is logged with its metadata shape, never a callback path or credential', async t => {
  const { send, rejected } = setup(t, { allowedRedirectHosts: undefined });
  const redirect = gemini('123456789012345678901');
  await refused(send, geminiMetadata(redirect), 'invalid_redirect_uri');
  assert.equal(rejected.length, 1);
  const [entry] = rejected;
  assert.equal(entry.endpoint, '/oauth/register');
  assert.equal(entry.status, 400);
  assert.equal(entry.error, 'invalid_redirect_uri');
  assert.deepEqual(entry.registration.redirect_origins, ['https://oauth-redirect.googleusercontent.com']);
  assert.equal(entry.registration.redirect_uri_count, 1);
  assert.equal(entry.registration.token_endpoint_auth_method, 'client_secret_basic');
  assert.equal(entry.registration.scope, 'mml:read offline_access');
  assert.deepEqual(entry.registration.fields, Object.keys(geminiMetadata(redirect)));
  const logged = JSON.stringify(rejected);
  assert.equal(logged.includes('123456789012345678901'), false);
  assert.equal(logged.includes('/r/'), false);

  // A refused token exchange logs the reason, never the code or verifier.
  const opted = setup(t);
  const client = await register(opted.send, geminiMetadata(redirect));
  const code = await consent(opted.send, client.client_id, redirect);
  assert.equal((await exchange(opted.send, client.client_id, code, { client_secret: 'synthetic-secret-value' })).status, 401);
  assert.equal((await opted.send(form('/oauth/authorize', { csrf: 'x', password: 'synthetic-wrong-password', decision: 'allow' }, { origin }))).status, 403);
  assert.deepEqual(opted.rejected.map(entry => [entry.endpoint, entry.error]), [['/oauth/token', 'invalid_client'], ['/oauth/authorize', 'access_denied']]);
  const tokenLog = JSON.stringify(opted.rejected);
  for (const secret of [code, verifier, 'synthetic-secret-value', 'synthetic-wrong-password', password]) assert.equal(tokenLog.includes(secret), false);
});

// What production logged (OAUTH_REQUEST_REJECTED, 2026-09-26) for Gemini's
// registration: six callbacks over Google's production, sandbox and test
// relays, token_endpoint_auth_method `none`, no scope. Its authorize request
// then carried a 1314-character state.
test('Gemini\'s observed registration and long state complete the flow once all three relays are listed', async t => {
  const relays = ['oauth-redirect.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com'];
  const hosts = parseRedirectHosts({ MML_OAUTH_REDIRECT_HOSTS: ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com', ...relays].join(',') });
  const callbacks = relays.flatMap(host => [1, 2].map(n => `https://${host}/r/user_bound_custom-mcp-00000000000000000000${n}-mml_example`));
  const observed = { client_name: 'Gemini', redirect_uris: callbacks, response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' };
  // With only the production relay listed, the sandbox and test callbacks refuse the whole registration.
  await refused(setup(t).send, observed, 'invalid_redirect_uri');
  const { send } = setup(t, { allowedRedirectHosts: hosts });
  const client = await register(send, observed);
  assert.deepEqual(client.redirect_uris, callbacks);
  for (const length of [1314, 4096]) {
    const state = 'A'.repeat(length - 1) + '_';
    const code = await consent(send, client.client_id, callbacks[0], { state });
    const token = await exchange(send, client.client_id, code);
    assert.equal(token.status, 200, String(length));
    assert.equal((await ping(send, (await token.json()).access_token)).status, 200, String(length));
  }
  const tooLong = await send(req('/oauth/authorize?' + authorizeParams(client.client_id, callbacks[0], { state: 'A'.repeat(4097) })));
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error_description, 'State too long');
});
