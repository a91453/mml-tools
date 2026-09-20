// Browser HTTP client over the existing service. No music logic or IndexedDB.
const FLOW = 'mml-studio-service-oauth';
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));

export function createServiceClient({ origin = location.origin, storage = sessionStorage, fetchImpl = fetch } = {}) {
  let grant = null;
  const redirect = origin + '/studio/';
  async function request(path, { body, form = false, authenticated = true, method = body === undefined ? 'GET' : 'POST' } = {}) {
    if (authenticated && !grant) throw Error('請先登入服務');
    const headers = {};
    if (authenticated) headers.authorization = `Bearer ${grant.access_token}`;
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    let response;
    try {
      response = await fetchImpl(origin + path, { method, headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(120000),
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : form ? new URLSearchParams(body) : JSON.stringify(body) }) });
    } catch { throw Object.assign(Error('未能取得服務回應；操作可能已執行。請先重新讀取專案狀態，不要重複上傳或建立專案。'), { uncertain: true }); }
    if (response.status === 401) { grant = null; throw Object.assign(Error('登入已過期，請重新登入；服務專案仍保留。'), { authentication: true }); }
    let result;
    try { result = await response.json(); } catch { throw Object.assign(Error('服務未回傳有效 JSON；請確認服務網址並讀回狀態。'), { uncertain: method !== 'GET' }); }
    if (!response.ok || result.error) {
      const error = result.error;
      throw Object.assign(Error(typeof error === 'object' ? `${error.code}: ${error.message}` : result.error_description || '服務拒絕請求'), { result });
    }
    return result;
  }
  return {
    origin,
    authenticated: () => grant !== null,
    async discover() {
      const metadata = await request('/.well-known/oauth-authorization-server', { authenticated: false });
      if (metadata.issuer !== origin || metadata.authorization_endpoint !== origin + '/oauth/authorize'
        || metadata.token_endpoint !== origin + '/oauth/token' || metadata.registration_endpoint !== origin + '/oauth/register') throw Error('登入端點與目前服務來源不一致');
      return metadata;
    },
    async loginURL() {
      await this.discover();
      const client = await request('/oauth/register', { authenticated: false, body: {
        client_name: 'MML Studio 服務工作區', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
      } });
      const verifier = random(), state = random();
      const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      storage.setItem(FLOW, JSON.stringify({ verifier, state, client_id: client.client_id, origin, started: Date.now() }));
      return origin + '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
        response_type: 'code', scope: 'mml:read', resource: origin + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state });
    },
    async completeLogin(url) {
      const parsed = new URL(url), params = parsed.searchParams;
      if (!params.has('code') && !params.has('error')) return false;
      const raw = storage.getItem(FLOW); storage.removeItem(FLOW);
      const flow = raw ? JSON.parse(raw) : null;
      if (!flow || flow.origin !== origin || parsed.origin !== origin || parsed.pathname !== '/studio/'
        || params.get('iss') !== origin || params.get('state') !== flow.state || Date.now() - flow.started > 600000
        || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) throw Error('登入回傳不符合本分頁的請求，請重新登入');
      if (params.has('error')) throw Error('登入未完成');
      grant = await request('/oauth/token', { authenticated: false, form: true, body: {
        grant_type: 'authorization_code', client_id: flow.client_id, code: params.get('code'), redirect_uri: redirect,
        code_verifier: flow.verifier, resource: origin + '/mcp',
      } });
      grant.client_id = flow.client_id;
      return true;
    },
    async logout() {
      const previous = grant; grant = null; storage.removeItem(FLOW);
      if (previous) await request('/oauth/revoke', { authenticated: false, form: true, body: { client_id: previous.client_id, token: previous.refresh_token } });
    },
    request,
    async upload(projectId, file, kind) {
      if (!/^prj_[0-9a-f]{32}$/.test(projectId)) throw Error('無效的專案身分');
      if (!file || file.size > 64 * 1024 * 1024) throw Error('請選擇不超過 64 MiB 的檔案');
      const body = new FormData(); body.set('kind', kind); body.set('filename', file.name); body.set('file', file, file.name);
      return request(`/api/v1/projects/${projectId}/assets`, { body });
    },
  };
}
