import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const SCOPE = 'mml:read';
const opaque = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const challenge = value => createHash('sha256').update(value).digest('base64url');
const equals = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const noCache = { 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { ...noCache, ...extra } });
const problem = (error, description, status = 400) => json({ error, error_description: description }, status);
const expiredLoginPage = () => new Response(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>請重新連線｜MML 工具服務</title><style>body{font:17px system-ui,sans-serif;background:#101726;color:#edf2fc;margin:0;padding:32px 20px}main{max-width:440px;margin:5vh auto}p{line-height:1.7;color:#c1cbdc}</style><main><h1>請重新連線</h1><p>這個登入程序已結束、逾時，或與目前開啟的登入頁不相符。</p><p>請關閉此頁，回到 ChatGPT 按「重新連線」，再使用新開的登入頁。</p><p>請只保留一個登入頁，不要重新整理或再次送出舊表單。</p></main></html>`, { status: 403, headers: { ...noCache, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" } });

class OAuthFault extends Error {
  constructor(code, description, status = 400) { super(description); this.code = code; this.status = status; }
}
function requireValue(ok, code = 'invalid_request', description = 'Invalid request', status = 400) { if (!ok) throw new OAuthFault(code, description, status); }
function uniqueParams(params) { for (const key of new Set(params.keys())) requireValue(params.getAll(key).length === 1, 'invalid_request', 'Repeated parameter'); return params; }
async function readBody(request, type) {
  requireValue((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === type, 'invalid_request', 'Unsupported content type', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new OAuthFault('invalid_request', 'Empty body');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new OAuthFault('invalid_request', 'Body too large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return type === 'application/json' ? JSON.parse(text) : uniqueParams(new URLSearchParams(text));
}

// Persist only OAuth client records and hashed credentials, never MML input.
// One process/replica owns this SQLite database on a mounted Railway volume.
class AuthStore {
  constructor(filename, now) {
    if (filename !== ':memory:') {
      if (!isAbsolute(filename)) throw Error('MML_AUTH_DB must be an absolute path');
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.now = now; this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS auth_records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(kind,id));');
  }
  get(kind, id) {
    if (typeof id !== 'string' || id.length > 4096) return null;
    const row = this.db.prepare('SELECT value FROM auth_records WHERE kind=? AND id=? AND expires>?').get(kind, id, this.now());
    return row ? JSON.parse(row.value) : null;
  }
  put(kind, id, value, expires) { this.db.prepare('INSERT OR REPLACE INTO auth_records(kind,id,value,expires) VALUES(?,?,?,?)').run(kind, id, JSON.stringify(value), expires); }
  remove(kind, id) { this.db.prepare('DELETE FROM auth_records WHERE kind=? AND id=?').run(kind, id); }
  prune() { this.db.prepare('DELETE FROM auth_records WHERE expires<=?').run(this.now()); }
  count(kind) { return this.db.prepare('SELECT count(*) AS n FROM auth_records WHERE kind=? AND expires>?').get(kind, this.now()).n; }
  list(kind) { return this.db.prepare('SELECT id, value FROM auth_records WHERE kind=? AND expires>?').all(kind, this.now()).map(row => ({ id: row.id, value: JSON.parse(row.value) })); }
  atomic(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
}

// RFC 8252 §7.3 loopback redirects for native clients (a CLI, a desktop app, an
// inspector): plain http to the machine's own loopback address on any port. The
// authorization code is delivered only to a listener on the owner's own host.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function createAuth({ origin, ownerPassword, database, allowedRedirectHosts = ['chatgpt.com', 'chat.openai.com'], allowLoopbackRedirects = true, now = () => Math.floor(Date.now() / 1000), allowHttpForTests = false }) {
  // An unparseable value is the same configuration error as a malformed one and
  // is reported as one: the raw `Invalid URL` a bare parse throws names nothing
  // an operator can act on, and this is the first thing a misconfigured
  // deployment hits.
  let base;
  try { base = new URL(origin); } catch { throw Error('MML_PUBLIC_ORIGIN must be an HTTPS origin'); }
  if ((base.protocol !== 'https:' && !allowHttpForTests) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('MML_PUBLIC_ORIGIN must be an HTTPS origin');
  if (typeof ownerPassword !== 'string' || ownerPassword.length < 32 || ownerPassword.length > 256) throw Error('MML_OWNER_PASSWORD must be a generated secret of 32–256 characters');
  if (!database) throw Error('Persistent MML_AUTH_DB is required');
  const issuer = base.origin, resource = issuer + '/mcp', store = new AuthStore(database, now), flows = new Map(), limits = new Map();
  let lastPrune = now();
  const passwordHash = hash(ownerPassword);
  const config = store.get('config', 'owner');
  // Changing the owner password revokes prior authorizations while retaining
  // registered client IDs, so ChatGPT does not lose its DCR registration.
  if (config && config.fingerprint !== passwordHash) store.db.exec("DELETE FROM auth_records WHERE kind NOT IN ('client','config')");
  store.put('config', 'owner', { fingerprint: passwordHash }, 2147483647);
  function rate(key, max) {
    const bucket = Math.floor(now() / 60), prior = limits.get(key), count = prior?.bucket === bucket ? prior.count + 1 : 1;
    limits.set(key, { bucket, count });
    requireValue(count <= max, 'temporarily_unavailable', 'Too many requests; try again shortly', 429);
  }
  function clientFor(id) { const client = store.get('client', id); requireValue(client, 'invalid_client', 'Unknown client', 401); return client; }
  function checkResource(value) { requireValue(!value || value === resource, 'invalid_target', 'Resource does not match this server'); }
  function checkScope(value) { requireValue(!value || value === SCOPE, 'invalid_scope', 'Only mml:read is available'); }
  // Exact HTTPS callbacks on the approved connector hosts with no userinfo, no
  // fragment and no custom port; or a loopback redirect for a native client.
  function redirectAllowed(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const u = new URL(value);
      if (u.username || u.password || u.hash) return false;
      // The service's own browser workspace has exactly one callback. This
      // admits no other path, query, port or arbitrary same-origin redirect.
      if (u.href === issuer + '/studio/') return true;
      if (u.protocol === 'https:') return allowedRedirectHosts.includes(u.hostname) && (!u.port || u.port === '443');
      if (u.protocol === 'http:') return allowLoopbackRedirects && LOOPBACK_HOSTS.has(u.hostname);
      return false;
    } catch { return false; }
  }
  // Browser origins that may call /mcp with an Origin header: this server and
  // the approved callback hosts. Derived from the same list so the two cannot
  // drift apart.
  const allowedOrigins = Object.freeze([issuer, ...allowedRedirectHosts.map(host => `https://${host}`)]);
  function issue(grantId, clientId) {
    const grant = store.get('grant', grantId);
    requireValue(grant && !grant.revoked && grant.clientId === clientId && grant.resource === resource, 'invalid_grant', 'Authorization no longer valid');
    const access = opaque(), refresh = opaque();
    store.put('access', hash(access), { grantId, clientId, resource, scope: SCOPE }, now() + 900);
    store.put('refresh', hash(refresh), { grantId, clientId, consumed: false }, grant.expires);
    return { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: SCOPE };
  }
  function revokeGrant(grantId) { const grant = store.get('grant', grantId); if (grant) store.put('grant', grantId, { ...grant, revoked: true }, grant.expires); }
  function clearFlowCookie() { return '__Host-mml_flow=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'; }
  function startFlow(params) {
    uniqueParams(params); rate('authorize', 60);
    const clientId = params.get('client_id'), client = clientFor(clientId), redirect = params.get('redirect_uri');
    requireValue(client.redirect_uris.includes(redirect) && redirectAllowed(redirect), 'invalid_request', 'Redirect URI is not registered');
    const callbackOrigin = new URL(redirect).origin;
    requireValue(params.get('response_type') === 'code', 'unsupported_response_type', 'Only authorization code flow is supported');
    requireValue(params.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? ''), 'invalid_request', 'PKCE S256 is required');
    checkResource(params.get('resource')); checkScope(params.get('scope'));
    const state = params.get('state') ?? '';
    requireValue(state.length <= 1024, 'invalid_request', 'State too long');
    for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id);
    requireValue(flows.size < 128, 'temporarily_unavailable', 'Too many pending logins', 429);
    const flowId = opaque(), csrf = opaque();
    flows.set(flowId, { clientId, redirect, challenge: params.get('code_challenge'), state, csrf, expires: now() + 300 });
    const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MML 工具服務登入</title><style>body{font:17px system-ui,sans-serif;background:#101726;color:#edf2fc;margin:0;padding:32px 20px}main{max-width:440px;margin:5vh auto}p{line-height:1.7;color:#c1cbdc}label,input,button{display:block;box-sizing:border-box;width:100%}input{font:inherit;padding:14px;margin:10px 0 22px;border:1px solid #6d7d99;border-radius:8px}button{font:inherit;padding:15px;border:0;border-radius:8px;background:#70e2d0;color:#10241f}small{overflow-wrap:anywhere}a{color:#70e2d0}</style><main><h1>MML 工具服務</h1><p>允許「${escapeHtml(client.client_name)}」讀取及保存來源與專案、提交編曲決策、執行檢查並產生 MML。各項接受與審查仍須依操作要求提供證據。</p><p><small>授權完成後返回：${escapeHtml(new URL(redirect).origin)}</small></p><form method="post" action="/oauth/authorize"><input type="hidden" name="csrf" value="${csrf}"><label for="password">服務登入密碼</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button name="decision" value="allow">登入並允許</button></form><p><small>這是你在 Railway 設定的 MML 服務密碼。</small></p></main></html>`;
    // no-referrer turns Origin into null for a browser's navigation-mode form
    // POST, even to this same origin. Preserve that Origin on the login page
    // while still suppressing cross-origin referrers. Keep the exact Origin,
    // CSRF cookie and token checks below; never allow null/missing Origins.
    // Browsers may also enforce form-action on the post-consent redirect.
    // Permit only self and this validated client's selected callback origin;
    // never interpolate the raw callback URL or allow arbitrary destinations.
    return new Response(html, { headers: { ...noCache, 'referrer-policy': 'same-origin', 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`, 'set-cookie': `__Host-mml_flow=${flowId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300` } });
  }
  async function finishFlow(request) {
    rate('login', 12);
    requireValue(request.headers.get('origin') === issuer, 'access_denied', 'Invalid form origin', 403);
    const body = await readBody(request, 'application/x-www-form-urlencoded');
    const cookie = /(?:^|;\s*)__Host-mml_flow=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('cookie') ?? '');
    const flowId = cookie?.[1], flow = flows.get(flowId);
    requireValue(flow && flow.expires > now() && equals(body.get('csrf') ?? '', flow.csrf), 'access_denied', 'Login request expired or invalid', 403);
    requireValue(body.get('decision') === 'allow', 'access_denied', 'Permission not granted', 403);
    const password = body.get('password') ?? '';
    requireValue(password.length <= 256 && equals(hash(password), passwordHash), 'access_denied', 'Incorrect service password', 403);
    flows.delete(flowId);
    const code = opaque(), grantId = opaque();
    store.atomic(() => {
      const client = clientFor(flow.clientId);
      store.put('client', flow.clientId, client, now() + 366 * 86400);
      store.put('grant', grantId, { clientId: flow.clientId, resource, scope: SCOPE, revoked: false, expires: now() + 30 * 86400 }, now() + 30 * 86400);
      store.put('code', hash(code), { ...flow, csrf: undefined, grantId, consumed: false, expires: now() + 90 }, now() + 600);
    });
    const target = new URL(flow.redirect);
    target.searchParams.set('code', code); target.searchParams.set('state', flow.state); target.searchParams.set('iss', issuer);
    // RFC 9700 section 4.12: 303 explicitly turns the credential POST into GET.
    return new Response(null, { status: 303, headers: { ...noCache, location: target.href, 'set-cookie': clearFlowCookie() } });
  }
  // Clients no live grant uses, registered over a day ago: an abandoned
  // registration or one whose grants all expired or were revoked. Evicted
  // oldest first, and only when the registration cap is reached, so a
  // connector holding a live grant never loses its client to capacity.
  function evictIdleClients() {
    const live = new Set(store.list('grant').filter(entry => !entry.value.revoked).map(entry => entry.value.clientId));
    const idle = store.list('client')
      .filter(entry => !live.has(entry.id) && (entry.value.client_id_issued_at ?? 0) < now() - 86400)
      .sort((a, b) => (a.value.client_id_issued_at ?? 0) - (b.value.client_id_issued_at ?? 0));
    for (const entry of idle) {
      if (store.count('client') < 128) break;
      store.remove('client', entry.id);
    }
  }
  async function register(request) {
    rate('register', 12); store.prune();
    const body = await readBody(request, 'application/json');
    requireValue(body && typeof body === 'object' && !Array.isArray(body), 'invalid_client_metadata', 'Expected an object');
    requireValue(Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0 && body.redirect_uris.length <= 5 && body.redirect_uris.every(redirectAllowed), 'invalid_redirect_uri', 'Only approved HTTPS callback hosts are accepted');
    requireValue(body.token_endpoint_auth_method === undefined || body.token_endpoint_auth_method === 'none', 'invalid_client_metadata', 'This server uses public clients with PKCE');
    requireValue(body.grant_types === undefined || (Array.isArray(body.grant_types) && body.grant_types.includes('authorization_code') && body.grant_types.every(v => ['authorization_code', 'refresh_token'].includes(v))), 'invalid_client_metadata', 'Unsupported grant types');
    requireValue(body.response_types === undefined || (Array.isArray(body.response_types) && body.response_types.length === 1 && body.response_types[0] === 'code'), 'invalid_client_metadata', 'Unsupported response type');
    const name = body.client_name ?? 'ChatGPT';
    requireValue(typeof name === 'string' && name.length > 0 && name.length <= 100, 'invalid_client_metadata', 'Invalid client name');
    checkScope(body.scope);
    const redirectUris = [...new Set(body.redirect_uris)];
    // The service page registers on every login, and a consented client is kept
    // for a year, so its logins alone used up the 128 registrations and then
    // every connector's registration was refused. A registration whose only
    // callback is this server's own page is answered with the page's existing
    // client: it is a public PKCE client with no secret, and the callback, the
    // owner's consent and the PKCE check per login are unchanged.
    if (redirectUris.length === 1 && redirectUris[0] === issuer + '/studio/') {
      const existing = store.list('client').find(entry => entry.value.client_name === name && entry.value.redirect_uris?.length === 1 && entry.value.redirect_uris[0] === redirectUris[0]);
      if (existing) return json(existing.value, 201);
    }
    if (store.count('client') >= 128) store.atomic(evictIdleClients);
    requireValue(store.count('client') < 128, 'temporarily_unavailable', 'Client registration capacity reached', 429);
    const clientId = opaque(), client = { client_id: clientId, client_id_issued_at: now(), client_name: name, redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE };
    store.put('client', clientId, client, now() + 86400);
    return json(client, 201);
  }
  async function token(request) {
    rate('token', 120);
    const body = await readBody(request, 'application/x-www-form-urlencoded'), clientId = body.get('client_id');
    clientFor(clientId);
    requireValue(!request.headers.has('authorization') && !body.has('client_secret'), 'invalid_client', 'Use public-client PKCE exchange', 401);
    checkResource(body.get('resource')); checkScope(body.get('scope'));
    let result;
    store.atomic(() => {
      if (body.get('grant_type') === 'authorization_code') {
        const codeHash = hash(body.get('code') ?? ''), code = store.get('code', codeHash), verifier = body.get('code_verifier') ?? '';
        requireValue(code && code.clientId === clientId && code.redirect === body.get('redirect_uri'), 'invalid_grant', 'Invalid authorization code');
        requireValue(/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && equals(challenge(verifier), code.challenge), 'invalid_grant', 'Invalid PKCE verifier');
        if (code.consumed) { revokeGrant(code.grantId); result = problem('invalid_grant', 'Authorization code was already used'); return; }
        requireValue(code.expires > now(), 'invalid_grant', 'Authorization code expired');
        store.put('code', codeHash, { ...code, consumed: true }, now() + 600);
        result = json(issue(code.grantId, clientId));
      } else if (body.get('grant_type') === 'refresh_token') {
        const refreshHash = hash(body.get('refresh_token') ?? ''), refresh = store.get('refresh', refreshHash);
        requireValue(refresh && refresh.clientId === clientId, 'invalid_grant', 'Invalid refresh token');
        if (refresh.consumed) { revokeGrant(refresh.grantId); result = problem('invalid_grant', 'Refresh token was already used'); return; }
        const grant = store.get('grant', refresh.grantId);
        requireValue(grant && !grant.revoked, 'invalid_grant', 'Authorization expired or revoked');
        store.put('refresh', refreshHash, { ...refresh, consumed: true }, grant.expires);
        result = json(issue(refresh.grantId, clientId));
      } else throw new OAuthFault('unsupported_grant_type', 'Unsupported grant type');
    });
    return result;
  }
  function authenticated(request) {
    // The scheme name is case-insensitive (RFC 9110 11.1); the token is not,
    // and its character class already spans both cases.
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') ?? '');
    if (!match) return false;
    const access = store.get('access', hash(match[1]));
    if (!access || access.resource !== resource || access.scope !== SCOPE) return false;
    const grant = store.get('grant', access.grantId);
    return Boolean(grant && !grant.revoked && grant.clientId === access.clientId && grant.resource === resource);
  }
  async function revoke(request) {
    const body = await readBody(request, 'application/x-www-form-urlencoded'), clientId = body.get('client_id');
    clientFor(clientId); rate('revoke', 60);
    const tokenHash = hash(body.get('token') ?? ''), record = store.get('refresh', tokenHash) ?? store.get('access', tokenHash);
    if (record?.clientId === clientId) revokeGrant(record.grantId);
    return new Response(null, { status: 200, headers: noCache });
  }
  return {
    issuer, resource, authenticated, allowedOrigins,
    close: () => store.close(),
    unauthorized: () => json({ error: 'unauthorized', message: 'MML service sign-in required' }, 401, { 'www-authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"` }),
    async route(request) {
      const url = new URL(request.url);
      try {
        if (now() - lastPrune >= 60) { store.prune(); lastPrune = now(); }
        if (request.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) return json({ resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'] });
        if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token', registration_endpoint: issuer + '/oauth/register', revocation_endpoint: issuer + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], scopes_supported: [SCOPE], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false });
        if (url.pathname === '/oauth/register' && request.method === 'POST') return await register(request);
        if (url.pathname === '/oauth/authorize' && request.method === 'GET') return startFlow(url.searchParams);
        if (url.pathname === '/oauth/authorize' && request.method === 'POST') return await finishFlow(request);
        if (url.pathname === '/oauth/token' && request.method === 'POST') return await token(request);
        if (url.pathname === '/oauth/revoke' && request.method === 'POST') return await revoke(request);
        return null;
      } catch (error) {
        if (error instanceof OAuthFault) {
          const acceptsHtml = (request.headers.get('accept') ?? '').split(',').some(value => value.trim().split(';')[0].toLowerCase() === 'text/html');
          if (request.method === 'POST' && url.pathname === '/oauth/authorize' && error.message === 'Login request expired or invalid' && acceptsHtml) return expiredLoginPage();
          return problem(error.code, error.message, error.status);
        }
        if (error instanceof SyntaxError || error instanceof TypeError) return problem('invalid_request', 'Malformed request');
        // Never return or log token values, password input, database contents,
        // request headers or internal exceptions to clients.
        return problem('server_error', 'Authorization could not be completed', 500);
      }
    },
  };
}
