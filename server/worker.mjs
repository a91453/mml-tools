import { handleMcp, SERVICE_VERSION } from './mcp.mjs';

export function createWorker(assets) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/mcp') {
        // Sites dispatch authenticates and authorizes the private audience,
        // strips caller-supplied identity headers and sets these trusted headers.
        // This Worker is not safe to expose directly without that gateway.
        if (!request.headers.get('oai-authenticated-user-email') && !request.headers.get('oai-authenticated-user-id')) return new Response('Authentication required', { status: 401, headers: { 'cache-control': 'no-store' } });
        return handleMcp(request);
      }
      if (url.pathname === '/healthz') return Response.json({ service: 'mml-workbench-tools', version: SERVICE_VERSION, status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
      const asset = assets[url.pathname === '/' ? '/index.html' : url.pathname];
      if (!asset) return new Response('Not found', { status: 404 });
      const bytes = asset.encoding === 'base64' ? Uint8Array.from(atob(asset.body), c => c.charCodeAt(0)) : asset.body;
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-type': asset.type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' } });
    },
  };
}
