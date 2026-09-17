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
  assert.equal(login.status, 303);
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
test('login CSP permits the selected registered callback origin and no unrelated destinations', async t => {
  const send = setup(t);
  const callbacks = [redirectUri + '?label=%3Bform-action%20*&next=https%3A%2F%2Fevil.example', 'https://chat.openai.com/connector_platform/oauth_redirect'];
  const client = await register(send, { redirect_uris: callbacks });
  for (const callback of callbacks) {
    const response = await begin(send, client.client_id, { redirect_uri: callback });
    assert.equal(response.status, 200);
    const directives = new Map(response.headers.get('content-security-policy').split(';').map(part => {
      const [name, ...values] = part.trim().split(/\s+/); return [name, values];
    }));
    assert.deepEqual(directives.get('form-action'), ["'self'", new URL(callback).origin]);
    assert.deepEqual(directives.get('default-src'), ["'none'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    assert.match(await response.text(), /<form method="post" action="\/oauth\/authorize">/);
  }
});
test('completed consent uses 303, contains no credentials, and cannot be submitted twice', async t => {
  const send = setup(t), client = await register(send), page = await begin(send, client.client_id);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  const body = { csrf, password, decision: 'allow' };
  const response = await send(form('/oauth/authorize', body, { cookie, origin }));
  assert.equal(response.status, 303);
  const location = response.headers.get('location'), target = new URL(location);
  assert.equal(target.origin + target.pathname, redirectUri);
  for (const secret of [password, csrf, cookie.split('=')[1]]) assert.equal(location.includes(secret), false);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const repeated = await send(form('/oauth/authorize', body, { cookie, origin }));
  assert.equal(repeated.status, 403);
  assert.equal((await repeated.json()).error_description, 'Login request expired or invalid');
  assert.equal(repeated.headers.get('location'), null);
  assert.equal((await exchange(send, client.client_id, target.searchParams.get('code'))).status, 200);
});
test('expired browser login gives recovery instructions while API errors remain JSON', async t => {
  let clock = 100000;
  const send = setup(t, { now: () => clock }), client = await register(send), page = await begin(send, client.client_id);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];
  clock += 301;
  for (const accept of ['text/html,application/xhtml+xml', 'application/json']) {
    const response = await send(form('/oauth/authorize', { csrf, password, decision: 'allow' }, { cookie, origin, accept }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (accept.startsWith('text/html')) {
      assert.match(response.headers.get('content-type'), /^text\/html/);
      const html = await response.text();
      assert.match(html, /回到 ChatGPT/);
      assert.match(html, /重新連線/);
      for (const secret of [password, csrf, cookie.split('=')[1]]) assert.equal(html.includes(secret), false);
      assert.doesNotMatch(html, /<form\b/);
    } else assert.equal((await response.json()).error_description, 'Login request expired or invalid');
  }
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
  assert.equal(accepted.status, 303);
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

// ─── the Studio Agent Interface on the deployed service ─────────────────────

test('the Application HTTP API sits behind the same OAuth check as /mcp', async t => {
  const send = setup(t);
  // Unauthenticated, every /api/v1 route is refused before it reaches the
  // Application Service, and nothing about the owner's records is disclosed.
  for (const [path, method] of [['/api/v1/capabilities', 'GET'], ['/api/v1/projects', 'GET'], ['/api/v1/projects', 'POST'], ['/api/v1/artifacts/art_' + '0'.repeat(64), 'GET']]) {
    const response = await send(req(path, method, method === 'POST' ? '{}' : undefined, { 'content-type': 'application/json' }));
    assert.equal(response.status, 401, `${method} ${path} must require authentication`);
    assert.equal((await response.json()).error.code, 'NOT_AUTHENTICATED');
  }

  const grant = await tokens(send);
  const authorized = await send(req('/api/v1/capabilities', 'GET', undefined, { authorization: 'Bearer ' + grant.access_token }));
  assert.equal(authorized.status, 200);
  const capabilities = await authorized.json();
  assert.equal(capabilities.interface, 'studio-application/v1');
  assert.deepEqual(capabilities.transports, ['http', 'mcp']);
  assert.equal(capabilities.cost.additional_recurring_cost, 'NONE');
  assert.equal(capabilities.cost.llm_api_dependency, 'NONE');
});

test('an authorized session sees the studio control surface and reports one service version', async t => {
  const send = setup(t);
  const grant = await tokens(send);
  const authorization = { authorization: 'Bearer ' + grant.access_token };

  const list = await (await send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { ...rpcHeaders, ...authorization }))).json();
  const names = list.result.tools.map(tool => tool.name);
  assert.ok(names.includes('mml_validate'), 'the original tools must survive');
  assert.ok(names.includes('studio_finalize'), 'the studio surface must be advertised to an authorized session');

  // The same deployed service answers on both transports, so the version it
  // reports must not depend on which door the caller used.
  const overMcp = await (await send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mml_validate', arguments: { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' } } }), { ...rpcHeaders, ...authorization }))).json();
  const overHttp = await (await send(req('/api/v1/technical/validate', 'POST', JSON.stringify({ mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' }), { 'content-type': 'application/json', ...authorization }))).json();
  assert.equal(overHttp.service_version, overMcp.result.structuredContent.service_version);
  assert.deepEqual(overHttp, overMcp.result.structuredContent);
});

test('a project created over HTTP is the same project the MCP tools see', async t => {
  const send = setup(t);
  const grant = await tokens(send);
  const authorization = { authorization: 'Bearer ' + grant.access_token };

  const created = await (await send(req('/api/v1/projects', 'POST', JSON.stringify({ title: 'Shared' }), { 'content-type': 'application/json', ...authorization }))).json();
  const projectId = created.project.project_id;

  const overMcp = await (await send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_project_get', arguments: { project_id: projectId } } }), { ...rpcHeaders, ...authorization }))).json();
  assert.equal(overMcp.result.isError, false);
  assert.equal(overMcp.result.structuredContent.project.project_id, projectId);
  assert.equal(overMcp.result.structuredContent.project.title, 'Shared');
});

// ─── deployment readiness, verifiable without a credential ──────────────────

test('the public root endpoint reports the Published Canonical bootstrap status', async t => {
  // The deployment's Canonical status has to be checkable without submitting
  // the owner's service password, or confirming a deploy would require
  // production credentials. /api/v1/capabilities is behind OAuth; this is not.
  const send = setup(t);
  const response = await send(req('/'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.canonical.status, 'CANONICAL_LOADED');
  assert.equal(body.canonical.canonical_version, '2026-09-13-v1');
  assert.equal(body.canonical.canonical_status, 'PUBLISHED');
  // The five identities stay five fields, and none stands in for another.
  assert.match(body.canonical.rules_snapshot_sha, /^[0-9a-f]{40}$/);
  assert.match(body.canonical.manifest_commit, /^[0-9a-f]{40}$/);
  assert.match(body.canonical.published_main_head, /^[0-9a-f]{40}$/);
  assert.match(body.canonical.repository_head, /^[0-9a-f]{40}$/);
  assert.notEqual(body.canonical.rules_snapshot_sha, body.canonical.manifest_commit);
  assert.notEqual(body.canonical.rules_snapshot_sha, body.canonical.published_main_head);
  assert.ok(!Object.hasOwn(body.canonical, 'version'), 'the identities must not collapse into one field');
  assert.match(body.canonical_notice, /Published Canonical loaded/);

  // It is a status page, not a data leak: no song, project or credential.
  const text = JSON.stringify(body);
  assert.ok(!text.includes(password));
  assert.ok(!/MML@/.test(text));
});

test('an unloadable Canonical is visible publicly and names the remedy', async t => {
  const send = setup(t, { studioLoadEngines: async () => { throw Error('no published history in this image'); } });
  const response = await send(req('/'));
  assert.equal(response.status, 200, 'the service still answers; only Canonical-aware work refuses');
  const body = await response.json();

  assert.equal(body.canonical.status, 'CANONICAL_NOT_LOADED');
  assert.equal(body.canonical.legacy_fallback_allowed, false);
  assert.equal(body.canonical.rules_snapshot_sha, null, 'a failed load must not report a snapshot');
  assert.match(body.canonical_notice, /NOT loaded/);

  // The remedy has to match the architecture that is actually deployed. This
  // notice used to tell an operator the build context had to arrive carrying
  // `.git`, `refs/remotes/origin/main` and the pinned snapshot commit — advice
  // that can never be acted on, because Railway's source snapshot does not carry
  // Git metadata and that is precisely the defect the image build now fixes for
  // itself. Sending an operator after an impossible precondition is worse than
  // saying nothing.
  for (const stale of [/refs\/remotes\/origin\/main/, /pinned rules snapshot commit/, /build context/, /Git metadata/]) {
    assert.doesNotMatch(body.canonical_notice, stale, 'the notice still names the superseded build-context remedy');
  }
  // What it must say instead: which step failed, what to check, and that there
  // is no fallback.
  assert.match(body.canonical_notice, /materialization and build gate/);
  assert.match(body.canonical_notice, /\[canonical-bootstrap\]/, 'the notice must point at the build log lines that name the failure');
  assert.match(body.canonical_notice, /published source/);
  assert.match(body.canonical_notice, /no working-tree, cached or legacy fallback/);
  assert.match(body.canonical_notice, /railway\/README\.md/);

  // Public and unauthenticated: it may name what to check, never a credential,
  // a value, or an internal path.
  assert.doesNotMatch(body.canonical_notice, /MML_CANONICAL_SOURCE_TOKEN|ghp_|github_pat_|token=/i, 'the public notice must not name or carry a credential');
  assert.doesNotMatch(body.canonical_notice, /\/app\/|\/data\//, 'the public notice must not disclose container paths');

  // The legacy technical tools are unaffected by a Canonical failure.
  const grant = await tokens(send);
  const legacy = await (await send(req('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mml_validate', arguments: { mml: 'MML@t120o4c1,,,,,;', meter_text: '0 4/4' } } }), { ...rpcHeaders, authorization: 'Bearer ' + grant.access_token }))).json();
  assert.equal(legacy.result.isError, false);
  assert.equal(legacy.result.structuredContent.technical_ok, true);
});

test('the healthcheck is not coupled to the Canonical bootstrap', async t => {
  // Railway health-checks /healthz. A Canonical problem must never be able to
  // fail it and roll back a deploy that is otherwise serving correctly.
  const broken = setup(t, { studioLoadEngines: async () => { throw Error('no published history'); } });
  const response = await broken(req('/healthz'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.ok(!Object.hasOwn(body, 'canonical'), '/healthz must not gate on, or report, the Canonical load');
});

test('the deployment image still runs the Canonical build gate', async () => {
  // The image contract moved to tests/railway-canonical-image.test.mjs, which
  // reproduces the real production condition — the allowlisted source tree with
  // no `.git` — rather than asserting on the descriptor text alone, and covers
  // what this test used to: git installed, the allowlist entries, the pinned
  // snapshot check. The one claim worth repeating beside the OAuth service is
  // that the build still refuses to ship an image that cannot load the
  // Published Canonical. It shipped one once, operationally green, with every
  // Canonical-aware operation refusing.
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const dockerfile = await readFile(new URL('railway/Dockerfile', root), 'utf8');
  const probe = await readFile(new URL('railway/canonical-probe.sh', root), 'utf8');

  assert.match(dockerfile, /canonical-probe\.sh/, 'the build must prove the bootstrap outcome');
  assert.match(probe, /exit 1/, 'the probe must be able to fail the build');
});
