// Assertion regressions only: these do NOT claim to execute Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyService, WORKSPACE_ASSETS } from '../scripts/studio-container-smoke.mjs';

const origin = 'https://studio-smoke.invalid';
const baseURL = 'http://127.0.0.1:34567';
const expectedAssets = new Map(WORKSPACE_ASSETS.map(([, file]) => [file, Buffer.from('synthetic asset ' + file)]));
function fixture(override = () => undefined) {
  return async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.ok(url.startsWith(baseURL + '/'));
    const path = new URL(url).pathname;
    const custom = override(path, options);
    if (custom) return custom;
    if (path === '/healthz') return Response.json({ status: 'ok' });
    if (path === '/') return Response.json({ canonical: { status: 'CANONICAL_LOADED', canonical_status: 'PUBLISHED',
      rules_snapshot_sha: '1'.repeat(40), manifest_commit: '2'.repeat(40), published_main_head: '3'.repeat(40) } });
    const asset = WORKSPACE_ASSETS.find(([route]) => route === path);
    if (asset) {
      if (options.method === 'POST') return new Response(null, { status: 405 });
      return new Response(options.method === 'HEAD' ? null : expectedAssets.get(asset[1]), { headers: {
        'content-type': asset[2] + '; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'",
      } });
    }
    if (['/studio', '/studio/index.html'].includes(path)) return new Response(null, { status: 302, headers: { location: '/studio/' } });
    if (path === '/studio/not-an-asset') return new Response(null, { status: 404 });
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', registration_endpoint: origin + '/oauth/register' });
    if (['/api/v1/projects', '/api/v1/capabilities', '/mcp'].includes(path)) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    throw Error('Unexpected fixture request: ' + path);
  };
}
const verify = fetchImpl => verifyService({ baseURL, expectedOrigin: origin, expectedAssets, fetchImpl });

test('container smoke verifier accepts complete synthetic HTTP evidence', async () => {
  const result = await verify(fixture());
  assert.equal(result.assets.length, 4);
  assert.ok(result.checked.includes('unauthenticated-api-and-mcp-denied'));
  assert.ok(result.checked.includes('all-workspace-assets-byte-identical'));
});
test('healthy /healthz cannot mask missing Canonical', async () => {
  await assert.rejects(verify(fixture(path => path === '/' && Response.json({ canonical: { status: 'CANONICAL_NOT_LOADED' } }))), /published Canonical must load/);
});
test('missing packaged workspace asset fails smoke', async () => {
  await assert.rejects(verify(fixture(path => path === '/studio/app.mjs' && new Response(null, { status: 404 }))), /asset HTTP status/);
});
test('wrong bytes fail even when packaged asset returns HTTP 200', async () => {
  await assert.rejects(verify(fixture((path, options) => path === '/studio/client.mjs' && options.method === 'GET' && new Response('wrong image bytes', { headers: {
    'content-type': 'text/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'",
  } }))), /image\/source asset identity/);
});
test('unauthenticated data exposure fails smoke', async () => {
  await assert.rejects(verify(fixture(path => path === '/api/v1/projects' && Response.json({ projects: [] }))), /unauthenticated access denied/);
});
test('wrong OAuth issuer fails smoke', async () => {
  await assert.rejects(verify(fixture(path => path === '/.well-known/oauth-authorization-server' && Response.json({ issuer: 'https://wrong.invalid' }))), /OAuth issuer/);
});
test('unexpected workspace redirect fails smoke', async () => {
  await assert.rejects(verify(fixture(path => path === '/studio' && new Response(null, { status: 302, headers: { location: 'https://wrong.invalid/' } }))), /workspace redirect target/);
});
