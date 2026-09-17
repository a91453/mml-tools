// Which origin a deployment serves under, and why a preview must not borrow
// production's.
//
// Every externally meaningful identity this service issues is derived from one
// string: the OAuth issuer, the resource it is bound to, the registration and
// token endpoints, the consent form's own Origin check, the callback CSP and
// the `WWW-Authenticate` challenge. Get it wrong and the deployment is not
// merely mislabelled — it hands clients metadata that points somewhere else.
//
// Railway PR environments made that reachable. A PR environment is served on
// its own generated domain but inherits the service's variables, so an
// inherited `MML_PUBLIC_ORIGIN` points the preview's whole OAuth surface at
// production, and an unset one used to leave the origin empty. Neither is a
// preview of anything.
//
// The contract asserted here:
//   * an explicitly stated origin always wins — production names its own and
//     is never silently re-pointed at a platform-injected domain;
//   * with none stated, the domain the deployment is actually served on
//     (`RAILWAY_PUBLIC_DOMAIN`) is used, over HTTPS, and only if it is a bare
//     host;
//   * with neither, startup fails closed. No localhost, no guess, no default.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read through the module namespace rather than as a named import, so that a
// build without the resolver fails each assertion below on its behaviour
// instead of failing to link.
import * as railway from '../railway/server.mjs';

const { createApplication } = railway;
const parsePublicOrigin = environment => railway.parsePublicOrigin(environment);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'railway/server.mjs');
const PASSWORD = 'SYNTHETIC_TEST_PASSWORD_ONLY_01234567890123456789';
const PRODUCTION = 'https://mml-tools-production.up.railway.app';
const PREVIEW_DOMAIN = 'mml-tools-mml-tools-pr-37.up.railway.app';

// Railway always injects these beside whatever the operator set, so every case
// is exercised against an environment that really does advertise a domain.
const railwayEnvironment = (domain = PREVIEW_DOMAIN) => ({
  RAILWAY_PUBLIC_DOMAIN: domain,
  RAILWAY_ENVIRONMENT_NAME: 'mml-tools-pr-37',
  RAILWAY_SERVICE_NAME: 'mml-tools',
  RAILWAY_STATIC_URL: `https://${domain}`,
});

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/**
 * Start the real entry point with a given environment.
 *
 * The entry point is what reads the environment, so it is what has to be
 * observed: importing the module and calling `createApplication` directly would
 * assert the helper and skip the wiring that was actually wrong.
 */
async function startService(t, environment) {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { PATH: process.env.PATH, PORT: String(port), MML_OWNER_PASSWORD: PASSWORD, MML_AUTH_DB: ':memory:', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });

  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (out.includes('MML OAuth service is ready')) resolve({ started: true, port }); });
    child.once('exit', code => resolve({ started: false, code, stderr: err }));
    child.once('error', reject);
  });
  return started;
}

const get = async (port, path) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
};

test('an explicitly stated origin wins, even where the platform advertises another domain', async t => {
  assert.equal(parsePublicOrigin({ MML_PUBLIC_ORIGIN: PRODUCTION, ...railwayEnvironment() }), PRODUCTION);

  const service = await startService(t, { MML_PUBLIC_ORIGIN: PRODUCTION, ...railwayEnvironment() });
  assert.equal(service.started, true, `service did not start: ${service.stderr ?? ''}`);
  const metadata = await get(service.port, '/.well-known/oauth-authorization-server');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.issuer, PRODUCTION, 'a stated origin is never replaced by RAILWAY_PUBLIC_DOMAIN');
  assert.equal(metadata.body.registration_endpoint, `${PRODUCTION}/oauth/register`);
});

test('a deployment with no stated origin serves the domain it is actually served on', async t => {
  assert.equal(parsePublicOrigin(railwayEnvironment()), `https://${PREVIEW_DOMAIN}`);
  // Blank is not a statement. It used to become an empty origin and crash.
  assert.equal(parsePublicOrigin({ MML_PUBLIC_ORIGIN: '', ...railwayEnvironment() }), `https://${PREVIEW_DOMAIN}`);
  assert.equal(parsePublicOrigin({ MML_PUBLIC_ORIGIN: '   ', ...railwayEnvironment() }), `https://${PREVIEW_DOMAIN}`);
  assert.equal(parsePublicOrigin({ RAILWAY_PUBLIC_DOMAIN: PREVIEW_DOMAIN.toUpperCase() }), `https://${PREVIEW_DOMAIN}`);

  const service = await startService(t, railwayEnvironment());
  assert.equal(service.started, true, `service did not start: ${service.stderr ?? ''}`);
  const expected = `https://${PREVIEW_DOMAIN}`;

  const health = await get(service.port, '/healthz');
  assert.equal(health.status, 200);

  const metadata = await get(service.port, '/.well-known/oauth-authorization-server');
  assert.equal(metadata.body.issuer, expected);
  assert.equal(metadata.body.authorization_endpoint, `${expected}/oauth/authorize`);
  assert.equal(metadata.body.token_endpoint, `${expected}/oauth/token`);
  assert.equal(metadata.body.code_challenge_methods_supported.includes('S256'), true);

  const resource = await get(service.port, '/.well-known/oauth-protected-resource/mcp');
  assert.equal(resource.body.resource, `${expected}/mcp`, 'the protected resource is this deployment, not production');
  assert.deepEqual(resource.body.authorization_servers, [expected]);

  const unauthenticated = await fetch(`http://127.0.0.1:${service.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate'), new RegExp(`resource_metadata="${expected}/.well-known/oauth-protected-resource/mcp"`), 'the challenge sends clients to this deployment');

  const api = await fetch(`http://127.0.0.1:${service.port}/api/v1/capabilities`);
  assert.equal(api.status, 401);
  assert.match(api.headers.get('www-authenticate'), new RegExp(expected.replace(/[.:/]/g, '\\$&')));

  const rootDocument = await get(service.port, '/');
  assert.equal(rootDocument.status, 200);
  assert.ok(!JSON.stringify(rootDocument.body).includes('mml-tools-production'), 'a preview advertises nothing about production');
});

test('neither a stated origin nor a platform domain is a refusal, not a localhost guess', async t => {
  assert.throws(() => parsePublicOrigin({}), /MML_PUBLIC_ORIGIN/);
  assert.throws(() => parsePublicOrigin({ MML_PUBLIC_ORIGIN: '', RAILWAY_PUBLIC_DOMAIN: '' }), /MML_PUBLIC_ORIGIN/);

  const service = await startService(t, {});
  assert.equal(service.started, false, 'a service with no knowable origin must not begin serving');
  assert.notEqual(service.code, 0);
  assert.doesNotMatch(service.stderr, /localhost|127\.0\.0\.1/, 'and must not have invented one');
});

test('a platform domain that is not a bare host is refused', () => {
  for (const domain of [
    `https://${PREVIEW_DOMAIN}`,
    `${PREVIEW_DOMAIN}/callback`,
    `${PREVIEW_DOMAIN}:8443`,
    `user@${PREVIEW_DOMAIN}`,
    `${PREVIEW_DOMAIN} ${PREVIEW_DOMAIN}`,
    `*.up.railway.app`,
    'localhost',
    '127.0.0.1',
    '-leading-hyphen.up.railway.app',
    'a'.repeat(300) + '.up.railway.app',
  ]) {
    assert.throws(() => parsePublicOrigin({ RAILWAY_PUBLIC_DOMAIN: domain }), /RAILWAY_PUBLIC_DOMAIN/, `accepted ${domain}`);
  }
});

test('production configuration is carried through verbatim and still fails closed on its own terms', t => {
  for (const stated of [PRODUCTION, 'https://mml.example', 'https://mml.example:8443']) {
    assert.equal(parsePublicOrigin({ MML_PUBLIC_ORIGIN: stated, ...railwayEnvironment() }), stated, 'no normalization, no trailing slash, no substitution');
  }
  assert.equal(parsePublicOrigin({ MML_PUBLIC_ORIGIN: `  ${PRODUCTION}  `, ...railwayEnvironment() }), PRODUCTION, 'only surrounding whitespace is dropped');

  // A stated origin that is not a valid HTTPS origin is rejected by the
  // authorization server, never quietly swapped for the platform domain.
  for (const invalid of ['http://mml.example', 'https://mml.example/path', 'https://user:pw@mml.example', 'not-a-url']) {
    assert.equal(parsePublicOrigin({ MML_PUBLIC_ORIGIN: invalid, ...railwayEnvironment() }), invalid);
    assert.throws(() => createApplication({ origin: invalid, ownerPassword: PASSWORD, database: ':memory:' }), /MML_PUBLIC_ORIGIN/, `accepted ${invalid}`);
  }

  const application = createApplication({ origin: PRODUCTION, ownerPassword: PASSWORD, database: ':memory:' });
  t.after(() => application.close());
  assert.equal(application.origin, PRODUCTION);
});

test('a derived preview origin carries a complete OAuth flow and an authenticated MCP call', async t => {
  // Everything below is bound to the preview origin: the registered callback is
  // checked against it, the consent form accepts only its own Origin, the code
  // carries it as `iss`, and the access token is audience-bound to its /mcp.
  const origin = parsePublicOrigin(railwayEnvironment());
  assert.equal(origin, `https://${PREVIEW_DOMAIN}`);
  const application = createApplication({ origin, ownerPassword: PASSWORD, database: ':memory:' });
  t.after(() => application.close());

  const send = path => application.fetch(new Request(origin + path));
  const post = (path, body, headers = {}) => application.fetch(new Request(origin + path, { method: 'POST', headers, body }));
  const form = (path, body, headers = {}) => post(path, new URLSearchParams(body), { 'content-type': 'application/x-www-form-urlencoded', ...headers });
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const verifier = 'synthetic_pkce_verifier_012345678901234567890123456789';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const registered = await post('/oauth/register', JSON.stringify({ client_name: 'preview', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }), { 'content-type': 'application/json' });
  assert.equal(registered.status, 201);
  const { client_id: clientId } = await registered.json();

  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', resource: `${origin}/mcp`, code_challenge: challenge, code_challenge_method: 'S256', state: 'preview-state' });
  const page = await send('/oauth/authorize?' + params);
  assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())[1];

  const consent = await form('/oauth/authorize', { csrf, password: PASSWORD, decision: 'allow' }, { cookie, origin });
  assert.equal(consent.status, 303, 'the consent form accepts the preview origin as its own');
  const location = new URL(consent.headers.get('location'));
  assert.equal(location.searchParams.get('iss'), origin, 'the code is issued by this deployment');

  const token = await form('/oauth/token', { client_id: clientId, grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier });
  assert.equal(token.status, 200);
  const access = (await token.json()).access_token;

  const rpc = payload => post('/mcp', JSON.stringify(payload), { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + access });

  const initialized = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'preview-check', version: '1' } } });
  assert.equal(initialized.status, 200);
  assert.ok((await initialized.json()).result.serverInfo.name);

  const listed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = (await listed.json()).result.tools.map(tool => tool.name);
  assert.ok(tools.includes('studio_capabilities'), `studio tools must be advertised: ${tools.join(', ')}`);

  const capabilities = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'studio_capabilities', arguments: {} } });
  const result = (await capabilities.json()).result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.canonical.status, 'CANONICAL_LOADED');
  assert.ok(!JSON.stringify(result.structuredContent).includes('mml-tools-production'), 'a preview reports itself, not production');
});
