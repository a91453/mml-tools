import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createAuth } from './auth.mjs';
import { handleMcp, SERVICE_VERSION } from '../server/mcp.mjs';
import { createListenConfig } from '../server/mcp-listen.mjs';
import { createApiRouter, faultRecord } from '../server/api.mjs';
import { studioWebResponse } from '../server/studio-web.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { createAgentDriver } from '../server/studio-agent-driver.mjs';
import { createCodexDecider } from '../server/studio-agent-codex.mjs';
import { join } from 'node:path';
import { scrubBuildCredentialVariables } from '../studio/backend/bootstrap/index.mjs';

// Railway provides a service variable to the build AND to the running
// deployment -- there is no build-only scope, and sealing a variable changes who
// can read it back, not where it is injected. The credential the image build
// uses to fetch the published history therefore arrives here too, where nothing
// needs it: the Canonical view is pinned at build and the runtime loader reads
// local objects only. These are credentials the build consumes, not variables
// the platform scopes to it -- the naming says so, because calling them
// "build-only" is what made this removal look unnecessary in the first place.
//
// So it is removed before this process serves anything, which also keeps it out
// of every child process spawned from `process.env`. Done at module scope
// deliberately: nothing imported above reads the environment while it evaluates,
// and everything that does read it runs later.
scrubBuildCredentialVariables();

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
// One deployment-log line per MCP request the transport turns away: status,
// reason, the protocol-version header and the user agent, never a body. The
// platform HTTP log shows the 400 but not why (see handleMcp).
export const mcpRejectLog = entry => console.warn(JSON.stringify({ event: 'MCP_REQUEST_REJECTED', ...entry }));
// One deployment-log line per request that ends in an unexpected fault. The
// caller's response stays the generic INTERNAL_ERROR; headers, bodies and
// tokens are never logged.
export const serverFaultLog = entry => console.error(JSON.stringify({ event: 'UNEXPECTED_SERVER_ERROR', at: new Date().toISOString(), ...entry }));

// The connector hosts whose exact HTTPS callbacks Dynamic Client Registration
// accepts by default: the ChatGPT and Claude web connectors. Native clients use
// RFC 8252 loopback redirects, accepted separately. An operator narrows or
// widens this with MML_OAUTH_REDIRECT_HOSTS (a comma-separated list of bare
// host names, which REPLACES the default) and switches loopback off with
// MML_OAUTH_LOOPBACK_REDIRECTS=0. The authorization flow itself — exact
// registered callback, PKCE S256, CSRF, the owner password — is the same for
// every client.
export const DEFAULT_REDIRECT_HOSTS = Object.freeze(['chatgpt.com', 'chat.openai.com', 'claude.ai', 'claude.com']);

// A host name and nothing else: no scheme, no port, no path, no userinfo, no
// wildcard, no whitespace. Shared by every variable that names a host so the
// two validators cannot drift apart.
const BARE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function parseRedirectHosts(env = process.env) {
  const raw = env.MML_OAUTH_REDIRECT_HOSTS;
  if (raw === undefined) return [...DEFAULT_REDIRECT_HOSTS];
  const hosts = String(raw).split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) throw Error('MML_OAUTH_REDIRECT_HOSTS must list at least one bare host name');
  for (const host of hosts) {
    if (!BARE_HOST.test(host)) throw Error(`MML_OAUTH_REDIRECT_HOSTS entry is not a bare host name: ${host}`);
  }
  return [...new Set(hosts)];
}

export function parseLoopbackSetting(env = process.env) {
  const raw = env.MML_OAUTH_LOOPBACK_REDIRECTS;
  if (raw === undefined) return true;
  if (['1', 'true', 'on', 'yes'].includes(String(raw).trim().toLowerCase())) return true;
  if (['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase())) return false;
  throw Error('MML_OAUTH_LOOPBACK_REDIRECTS must be 1 or 0');
}

// The public origin this deployment serves under.
//
// One string decides every externally meaningful identity the service issues:
// the OAuth issuer, the protected resource, the authorization, token,
// registration and revocation endpoints, the consent form's own Origin check,
// the callback CSP, and the `WWW-Authenticate` challenge that tells a client
// where to authenticate. It is not a label; it is where clients are sent.
//
// `MML_PUBLIC_ORIGIN` is the operator's explicit statement and always wins.
// Production names its own origin, and a platform-injected domain must never
// silently re-point it -- that would move a live connector's issuer without
// anyone asking.
//
// A Railway PR environment is the case that had no answer. It is served on its
// own generated domain but inherits the service's variables, so an unset origin
// left this empty and startup died on a validation error, while an inherited
// one pointed the preview's issuer, callbacks and consent form at production.
// When nothing is stated, the domain this deployment is actually served on is
// used instead, over HTTPS, and only when it is a real bare host: a preview is
// then a preview of itself.
//
// With neither, startup fails closed. There is deliberately no localhost or
// invented default: a service that guessed its origin would hand out OAuth
// metadata and callbacks nobody can return to, and would look healthy doing it.
export function parsePublicOrigin(env = process.env) {
  const stated = (env.MML_PUBLIC_ORIGIN ?? '').trim();
  // Returned verbatim. Whether it is a usable HTTPS origin is the authorization
  // server's judgement (`createAuth`), which fails closed on anything else --
  // a stated origin that is wrong is a configuration error to report, never a
  // reason to substitute a different one.
  if (stated) return stated;

  const domain = (env.RAILWAY_PUBLIC_DOMAIN ?? '').trim().toLowerCase();
  if (!domain) {
    throw Error('MML_PUBLIC_ORIGIN must be set to this deployment\'s exact HTTPS origin, and no RAILWAY_PUBLIC_DOMAIN was provided to derive one from');
  }
  // A domain, not an address: an IPv4 literal or a single-label name is not
  // something a connector can be sent back to over public HTTPS.
  if (domain.length > 253 || !BARE_HOST.test(domain) || !/\.[a-z]{2,}$/.test(domain)) {
    throw Error(`RAILWAY_PUBLIC_DOMAIN is not a bare public host name: ${domain.slice(0, 80)}`);
  }
  return `https://${domain}`;
}

export function productionAgentConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const executable = env.MML_AGENT_CODEX ?? null;
  const model = env.MML_AGENT_MODEL ?? null;
  if (production && (executable || model)) {
    throw Error('External model runner is prohibited in production; remove MML_AGENT_CODEX and MML_AGENT_MODEL');
  }
  return {
    agentCodexExecutable: production ? null : executable,
    agentModel: production ? null : model,
  };
}

export function createApplication(options) {
  const auth = createAuth({ ...options, allowedRedirectHosts: options.allowedRedirectHosts ?? [...DEFAULT_REDIRECT_HOSTS] });
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
  const agent = createAgentDriver({ application: studio, decide: options.agentDecide ?? (options.agentCodexExecutable
    ? createCodexDecider({ executable: options.agentCodexExecutable, model: options.agentModel }) : null),
    directory: options.studioDataDirectory ? join(options.studioDataDirectory, 'agent-dispatch') : null });
  // Host-level cost/privacy statements must include the optional model runner;
  // the underlying provider-independent music engine still calls no model.
  const exposedStudio = Object.freeze({ ...studio, async capabilities() {
    const base = await studio.capabilities();
    return { ...base, external_agent: { enabled: agent.enabled, execution: 'explicitly-authorized-bounded-continuation',
      automatic_restart: false, native_tool_results_accepted: false, max_concurrent_runs: 2 },
      ...(agent.enabled ? {
        cost: { ...base.cost, additional_recurring_cost: 'OPERATOR_CONFIGURED', external_paid_services: 'OPERATOR_CONFIGURED',
          notice: 'The optional external agent uses the configured Codex account or provider quota. Core musical operations do not require a model.' },
        privacy: { ...base.privacy, uploaded_assets_leave_this_service: true, raw_asset_bytes_sent: false, derived_symbolic_data_sent: true,
          calls_external_analysis_services: true, notice: 'The enabled agent sends run metadata, derived symbolic events, cited evidence and reports to its configured model. Raw audio/MIDI bytes are not sent.' },
      } : {}),
    };
  } });
  // The in-conversation listening player: which Studio Web a listen link
  // opens, and the optional sample library the player may fetch. Both are
  // optional; unset, there is no link and the player makes no request.
  const listen = createListenConfig({
    studioWebOrigin: options.studioWebOrigin ?? null,
    samplesUrl: options.listenSamplesUrl ?? null,
    samplesCredit: options.listenSamplesCredit ?? null,
  });
  const api = createApiRouter({ application: exposedStudio, ownerOf: () => SERVICE_OWNER, challenge: auth.unauthorized().headers.get('www-authenticate'), agentDriver: agent, faultLog: serverFaultLog });
  return {
    close() { agent.close(); auth.close(); },
    origin: auth.issuer,
    studio: exposedStudio,
    agent,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== auth.issuer) return new Response('Unexpected server origin', { status: 400 });
      const workspace = await studioWebResponse(request);
      if (workspace) return workspace;
      if (url.pathname === '/healthz' && request.method === 'GET') return Response.json({ status: 'ok', service: 'mml-tools', version: SERVICE_VERSION }, { headers: { 'cache-control': 'no-store' } });
      const oauthResponse = await auth.route(request);
      if (oauthResponse) return oauthResponse;
      if (url.pathname === '/mcp') {
        // Only locally issued, audience-bound OAuth access tokens authorize this
        // standalone service. Sites identity headers have no authority here.
        if (!auth.authenticated(request)) return auth.unauthorized();
        return handleMcp(request, { application: exposedStudio, owner: SERVICE_OWNER, allowedOrigins: auth.allowedOrigins, listen, rejectLog: mcpRejectLog, faultLog: serverFaultLog });
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
      // with what this project already publishes: the repository is public, and
      // its Canonical Manifest and Git history carry the same release metadata
      // and provenance. Nothing here is a credential, and no song or project data
      // is exposed.
      if (url.pathname === '/' && request.method === 'GET') {
        const canonical = await studio.canonical.provenance();
        return Response.json({
          service: 'MML Tools',
          version: SERVICE_VERSION,
          authentication: 'OAuth with PKCE',
          status: 'Sign in from your ChatGPT plugin connection to use this service.',
          canonical,
          // The unloaded notice is public and unauthenticated, so it says what to
          // check without naming a credential, a value or an internal path.
          //
          // It used to tell an operator the build context had to arrive carrying
          // .git, refs/remotes/origin/main and the pinned snapshot. That was the
          // old architecture's remedy and it is now unreachable advice: Railway's
          // source snapshot never carries Git metadata, which is the defect this
          // deployment was changed to fix. The image materializes the published
          // history during its build instead, so an unloaded Canonical here means
          // that build step or its gate did not do what it should have.
          canonical_notice: canonical.status === 'CANONICAL_LOADED'
            ? 'Published Canonical loaded. Canonical-aware Studio operations are available to an authenticated caller.'
            : 'Published Canonical is NOT loaded, so every Canonical-aware operation refuses. This image did not complete the Canonical materialization and build gate: check the deployment build log for the [canonical-bootstrap] lines, confirm the build can reach the published source repository with its configured read access, and rebuild. There is no working-tree, cached or legacy fallback, and /healthz is deliberately unaffected. See railway/README.md.',
        }, { headers: { 'cache-control': 'no-store' } });
      }
      return new Response('Not found', { status: 404 });
    },
  };
}

// How long one request may take to arrive in full. The asset plane accepts
// 64 MiB (contracts.mjs maxAssetBytes) and the service page waits 120 s for an
// upload to finish, so the whole-request limit must cover a large file on a
// phone uplink: at the former 15 s, Node answered 408 to any upload slower than
// about 4 MB/s and the asset was never stored. The byte ceilings in api.mjs and
// mcp.mjs bound what a request may carry; the 10 s header timeout stays the
// slow-loris guard, since a request's headers are small.
export const HTTP_TIMEOUTS = Object.freeze({ requestMs: 300000, headersMs: 10000 });

export function createHttpServer(application) {
  return createServer({ maxHeaderSize: 16384, requestTimeout: HTTP_TIMEOUTS.requestMs, headersTimeout: HTTP_TIMEOUTS.headersMs }, async (req, res) => {
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 8192) { res.writeHead(400); res.end(); return; }
      const request = new Request(application.origin + req.url, { method: req.method, headers: req.headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }) });
      const response = await application.fetch(request);
      const headers = Object.fromEntries(response.headers);
      if (response.headers.getSetCookie().length) headers['set-cookie'] = response.headers.getSetCookie();
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      try { serverFaultLog(faultRecord({ transport: 'http-adapter', method: req.method, path: String(req.url ?? '').split('?')[0].slice(0, 256) }, error)); } catch {}
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('Request could not be completed');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT');
  const application = createApplication({
    // Explicitly stated, or the domain this deployment is served on. Never
    // guessed: see parsePublicOrigin.
    origin: parsePublicOrigin(process.env),
    ownerPassword: process.env.MML_OWNER_PASSWORD,
    database: process.env.MML_AUTH_DB,
    // Studio records live beside the OAuth database on the volume this service
    // already has. Unset, the store stays in memory and says so; durability is
    // only claimed when the operator declares the mount is persistent.
    studioDataDirectory: process.env.MML_STUDIO_DATA_DIR ?? null,
    studioDurability: process.env.MML_STUDIO_DURABILITY ?? 'unknown',
    ...productionAgentConfiguration(process.env),
    allowedRedirectHosts: parseRedirectHosts(process.env),
    allowLoopbackRedirects: parseLoopbackSetting(process.env),
    // Optional; see server/mcp-listen.mjs. An invalid origin yields no link.
    studioWebOrigin: process.env.STUDIO_WEB_ORIGIN ?? null,
    listenSamplesUrl: process.env.STUDIO_LISTEN_SAMPLES_URL ?? null,
    listenSamplesCredit: process.env.STUDIO_LISTEN_SAMPLES_CREDIT ?? null,
  });
  const server = createHttpServer(application);
  server.listen(port, '0.0.0.0', () => console.log('MML OAuth service is ready'));
  const shutdown = () => server.close(() => { application.close(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
