import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createAuth } from './auth.mjs';
import { handleMcp, SERVICE_VERSION } from '../server/mcp.mjs';

export function createApplication(options) {
  const auth = createAuth(options);
  return {
    close: auth.close,
    origin: auth.issuer,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== auth.issuer) return new Response('Unexpected server origin', { status: 400 });
      if (url.pathname === '/healthz' && request.method === 'GET') return Response.json({ status: 'ok', service: 'mml-tools', version: SERVICE_VERSION }, { headers: { 'cache-control': 'no-store' } });
      const oauthResponse = await auth.route(request);
      if (oauthResponse) return oauthResponse;
      if (url.pathname === '/mcp') {
        // Only locally issued, audience-bound OAuth access tokens authorize this
        // standalone service. Sites identity headers have no authority here.
        if (!auth.authenticated(request)) return auth.unauthorized();
        return handleMcp(request);
      }
      if (url.pathname === '/' && request.method === 'GET') return Response.json({ service: 'MML Tools', authentication: 'OAuth with PKCE', status: 'Sign in from your ChatGPT plugin connection to use this service.' }, { headers: { 'cache-control': 'no-store' } });
      return new Response('Not found', { status: 404 });
    },
  };
}

export function createHttpServer(application) {
  return createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 8192) { res.writeHead(400); res.end(); return; }
      const request = new Request(application.origin + req.url, { method: req.method, headers: req.headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
      const response = await application.fetch(request);
      const headers = Object.fromEntries(response.headers);
      if (response.headers.getSetCookie().length) headers['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('Request could not be completed'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT');
  const application = createApplication({ origin: process.env.MML_PUBLIC_ORIGIN ?? '', ownerPassword: process.env.MML_OWNER_PASSWORD, database: process.env.MML_AUTH_DB });
  const server = createHttpServer(application);
  server.listen(port, '0.0.0.0', () => console.log('MML OAuth service is ready'));
  const shutdown = () => server.close(() => { application.close(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
