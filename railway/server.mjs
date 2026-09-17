import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createAuth } from './auth.mjs';
import { handleMcp, SERVICE_VERSION } from '../server/mcp.mjs';
import { createApiRouter } from '../server/api.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { scrubBuildOnlyVariables } from '../studio/backend/bootstrap/index.mjs';

// Railway provides a service variable to the build AND to the running
// deployment -- there is no build-only scope, and sealing a variable changes who
// can read it back, not where it is injected. The credential the image build
// uses to fetch the published history therefore arrives here too, where nothing
// needs it: the Canonical view is pinned at build and the runtime loader reads
// local objects only.
//
// So it is removed before this process serves anything, which also keeps it out
// of every child process spawned from `process.env`. Done at module scope
// deliberately: nothing imported above reads the environment while it evaluates,
// and everything that does read it runs later.
scrubBuildOnlyVariables();

// The owner subject this deployment isolates records by.
//
// The current authorization model has exactly one principal: whoever holds the
// service password. Every grant it issues therefore represents the same person,
// so the subject is constant — deriving it from a grant or client id instead
// would silently orphan a project the moment the owner reconnected ChatGPT or
// added a second client.
//
// The Application Service takes an arbitrary subject string and isolates
// records by it, so a future deployment with real multi-user identity changes
// this line and nothing below it.
export const SERVICE_OWNER = 'owner:service';

export function createApplication(options) {
  const auth = createAuth(options);
  // Constructing the service performs no Canonical load and touches no engine:
  // a deployment missing the published Git history still starts, serves
  // /healthz and answers capability discovery saying Canonical is unavailable,
  // instead of failing to boot with nothing able to explain why.
  const studio = createStudioApplication({
    dataDirectory: options.studioDataDirectory ?? null,
    durability: options.studioDurability ?? 'unknown',
    serviceVersion: SERVICE_VERSION,
    transports: ['http', 'mcp'],
    // Test seam only, mirroring the one the Application Service already has:
    // it lets a regression prove what this service reports when Published
    // Canonical cannot load, without breaking the repository it runs in.
    // Production passes nothing.
    loadEngines: options.studioLoadEngines,
  });
  const api = createApiRouter({ application: studio, ownerOf: () => SERVICE_OWNER });
  return {
    close: auth.close,
    origin: auth.issuer,
    studio,
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
        return handleMcp(request, { application: studio, owner: SERVICE_OWNER });
      }
      // The Application HTTP surface, behind the same OAuth check. The router
      // is told whether the request is authenticated rather than deciding it:
      // authorization stays in one place, and an unauthenticated request is
      // refused before any owner subject is derived.
      const apiResponse = await api(request, { authenticated: auth.authenticated(request) });
      if (apiResponse) return apiResponse;
      // Deployment readiness, without a credential.
      //
      // The Published Canonical bootstrap reads the Manifest from
      // `refs/remotes/origin/main` and the rule documents from the pinned rules
      // snapshot, both out of Git history. A deployment whose build context
      // arrived without that history -- no `.git`, no `origin/main`, or a
      // shallow clone that truncated the snapshot commit away -- still starts
      // and still serves the legacy technical tools, and reports
      // CANONICAL_NOT_LOADED for everything Canonical-aware.
      //
      // That state used to be observable only through `/api/v1/capabilities`,
      // which is behind OAuth, so confirming a deployment meant submitting the
      // owner's service password. It is reported here instead, on the endpoint
      // that already exists and is already public, so an operator can verify a
      // deploy with one unauthenticated request.
      //
      // `/healthz` is deliberately left alone: it is Railway's healthcheck, and
      // a Canonical problem must not be able to fail it and roll back a deploy
      // that is otherwise serving correctly.
      //
      // The five identities stay five fields. Publishing them is consistent
      // with what this project already publishes: the clean public export ships
      // `canonical/published.json` carrying the same release metadata and Git
      // provenance. Nothing here is a credential, and no song or project data
      // is exposed.
      if (url.pathname === '/' && request.method === 'GET') {
        const canonical = await studio.canonical.provenance();
        return Response.json({
          service: 'MML Tools',
          version: SERVICE_VERSION,
          authentication: 'OAuth with PKCE',
          status: 'Sign in from your ChatGPT plugin connection to use this service.',
          canonical,
          canonical_notice: canonical.status === 'CANONICAL_LOADED'
            ? 'Published Canonical loaded. Canonical-aware Studio operations are available to an authenticated caller.'
            : 'Published Canonical is NOT loaded, so every Canonical-aware operation refuses. The deployment needs a build context carrying this repository\u2019s Git metadata, refs/remotes/origin/main, and the pinned rules snapshot commit. See railway/README.md.',
        }, { headers: { 'cache-control': 'no-store' } });
      }
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
  const application = createApplication({
    origin: process.env.MML_PUBLIC_ORIGIN ?? '',
    ownerPassword: process.env.MML_OWNER_PASSWORD,
    database: process.env.MML_AUTH_DB,
    // Studio records live beside the OAuth database on the volume this service
    // already has. Unset, the store stays in memory and says so; durability is
    // only claimed when the operator declares the mount is persistent.
    studioDataDirectory: process.env.MML_STUDIO_DATA_DIR ?? null,
    studioDurability: process.env.MML_STUDIO_DURABILITY ?? 'unknown',
  });
  const server = createHttpServer(application);
  server.listen(port, '0.0.0.0', () => console.log('MML OAuth service is ready'));
  const shutdown = () => server.close(() => { application.close(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
