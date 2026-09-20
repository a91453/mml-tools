import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../railway/server.mjs';
import { createServiceClient } from '../studio/web/service/client.mjs';
const origin = 'https://studio-service-test.example';
function appFor(t) {
  const app = createApplication({ origin, ownerPassword: 'SYNTHETIC_OWNER_PASSWORD_01234567890123456789', database: ':memory:' });
  t.after(() => app.close()); return app;
}

test('service workspace serves a fixed public shell while project API stays authenticated', async t => {
  const app = appFor(t);
  for (const path of ['/studio/', '/studio/client.mjs', '/studio/app.mjs', '/studio/style.css']) {
    const response = await app.fetch(new Request(origin + path));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await app.fetch(new Request(origin + '/api/v1/projects'))).status, 401);
  assert.equal((await app.fetch(new Request(origin + '/studio/private.json'))).status, 404);
  assert.equal((await app.fetch(new Request(origin + '/studio/app.mjs', { method: 'POST' }))).status, 405);
  assert.equal((await app.fetch(new Request(origin + '/studio/client.mjs', { method: 'HEAD' }))).status, 200);
});

test('OAuth admits only the exact service callback and describes stored-project capabilities honestly', async t => {
  const app = appFor(t);
  const register = callback => app.fetch(new Request(origin + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Studio test', redirect_uris: [callback], token_endpoint_auth_method: 'none' }) }));
  for (const callback of [origin + '/other', origin + '/studio/?next=evil', origin + '/studio/#x', 'https://evil.example/studio/']) {
    assert.equal((await register(callback)).status, 400);
  }
  const response = await register(origin + '/studio/'); assert.equal(response.status, 201);
  const { client_id } = await response.json();
  const params = new URLSearchParams({ client_id, redirect_uri: origin + '/studio/', response_type: 'code',
    code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), resource: origin + '/mcp', state: 'synthetic' });
  const consent = await app.fetch(new Request(origin + '/oauth/authorize?' + params));
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /保存來源與專案/); assert.doesNotMatch(html, /不改寫或保存樂譜/);
});

test('browser OAuth rejects mismatched callback state/issuer before exchanging any code', async () => {
  for (const suffix of ['?code=x&state=wrong&iss=' + encodeURIComponent(origin), '?code=x&state=right&iss=https://wrong.example', '?code=x&state=right&state=right&iss=' + encodeURIComponent(origin)]) {
    const data = new Map([['mml-studio-service-oauth', JSON.stringify({ origin, verifier: 'synthetic', client_id: 'synthetic', state: 'right', started: Date.now() })]]);
    let calls = 0;
    const client = createServiceClient({ origin, storage: { getItem: key => data.get(key), removeItem: key => data.delete(key) }, fetchImpl: async () => { calls++; throw Error('Unexpected exchange'); } });
    await assert.rejects(client.completeLogin(origin + '/studio/' + suffix), /登入回傳不符合/);
    assert.equal(calls, 0); assert.equal(client.authenticated(), false); assert.equal(data.size, 0);
  }
});
