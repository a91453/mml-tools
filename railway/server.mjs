import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createAuth } from './auth.mjs';
import { handleMcp, SERVICE_VERSION } from '../server/mcp.mjs';
import { createApiRouter } from '../server/api.mjs';
import { studioWebResponse } from '../server/studio-web.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { createAgentDriver } from '../server/studio-agent-driver.mjs';
import { createCodexDecider } from '../server/studio-agent-codex.mjs';
import { createOpenAIResponsesDecider } from '../server/studio-agent-openai.mjs';
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

export const PRODUCTION_AGENT_HARD_LIMITS = Object.freeze({
  maxSteps: 8,
  maxCallsPerRun: 12,
  maxCallsPerDay: 24,
  maxConcurrentRuns: 1,
  maxInputBytes: 393216,
  maxOutputTokens: 1200,
  timeoutMs: 60000,
});

const PRODUCTION_AGENT_DEFAULTS = Object.freeze({
  maxSteps: 6,
  maxCallsPerRun: 10,
  maxCallsPerDay: 16,
  maxConcurrentRuns: 1,
  maxInputBytes: 262144,
  maxOutputTokens: 900,
  timeoutMs: 60000,
});

function agentBudgetInteger(env, key, fallback, minimum, maximum) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^\\d+$/.test(String(raw))) throw Error(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function productionAgentBudget(env) {
  return {
    agentMaxSteps: agentBudgetInteger(env, 'MML_AGENT_MAX_STEPS', PRODUCTION_AGENT_DEFAULTS.maxSteps, 1, PRODUCTION_AGENT_HARD_LIMITS.maxSteps),
    agentMaxCallsPerRun: agentBudgetInteger(env, 'MML_AGENT_MAX_CALLS_PER_RUN', PRODUCTION_AGENT_DEFAULTS.maxCallsPerRun, 1, PRODUCTION_AGENT_HARD_LIMITS.maxCallsPerRun),
    agentMaxCallsPerDay: agentBudgetInteger(env, 'MML_AGENT_MAX_CALLS_PER_DAY', PRODUCTION_AGENT_DEFAULTS.maxCallsPerDay, 1, PRODUCTION_AGENT_HARD_LIMITS.maxCallsPerDay),
    agentMaxConcurrentRuns: PRODUCTION_AGENT_HARD_LIMITS.maxConcurrentRuns,
    agentMaxInputBytes: agentBudgetInteger(env, 'MML_AGENT_MAX_INPUT_BYTES', PRODUCTION_AGENT_DEFAULTS.maxInputBytes, 4096, PRODUCTION_AGENT_HARD_LIMITS.maxInputBytes),
    agentMaxOutputTokens: agentBudgetInteger(env, 'MML_AGENT_MAX_OUTPUT_TOKENS', PRODUCTION_AGENT_DEFAULTS.maxOutputTokens, 64, PRODUCTION_AGENT_HARD_LIMITS.maxOutputTokens),
    agentTimeoutMs: agentBudgetInteger(env, 'MML_AGENT_TIMEOUT_MS', PRODUCTION_AGENT_DEFAULTS.timeoutMs, 1000, PRODUCTION_AGENT_HARD_LIMITS.timeoutMs),
  };
}

export function productionAgentConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const executable = env.MML_AGENT_CODEX ?? null;
  const provider = (env.MML_AGENT_PROVIDER ?? '').trim();
  const model = (env.MML_AGENT_MODEL ?? '').trim() || null;

  if (!production) {
    if (provider && provider !== 'openai-responses') throw Error('Unsupported MML_AGENT_PROVIDER');
    return {
      agentCodexExecutable: executable,
      agentProvider: provider || null,
      agentApiKey: provider === 'openai-responses' ? (env.OPENAI_API_KEY ?? null) : null,
      agentModel: model,
      ...productionAgentBudget(env),
    };
  }

  if (executable) {
    throw Error('MML_AGENT_CODEX child-process runner is prohibited in production; use the bounded openai-responses provider instead');
  }
  if (!provider) {
    if (model) throw Error('MML_AGENT_MODEL requires MML_AGENT_PROVIDER=openai-responses in production');
    return {
      agentCodexExecutable: null,
      agentProvider: null,
      agentApiKey: null,
      agentModel: null,
      ...productionAgentBudget(env),
    };
  }
  if (provider !== 'openai-responses') throw Error('Production MML_AGENT_PROVIDER must be openai-responses');
  if (!model) throw Error('MML_AGENT_MODEL is required when production agent continuation is enabled');
  const apiKey = env.OPENAI_API_KEY ?? null;
  if (typeof apiKey !== 'string' || apiKey.trim().length < 20) {
    throw Error('OPENAI_API_KEY is required when production agent continuation is enabled');
  }
  return {
    agentCodexExecutable: null,
    agentProvider: provider,
    agentApiKey: apiKey,
    agentModel: model,
    ...productionAgentBudget(env),
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
  const externalDecide = options.agentDecide ?? (options.agentProvider === 'openai-responses'
    ? createOpenAIResponsesDecider({
      apiKey: options.agentApiKey,
      model: options.agentModel,
      timeoutMs: options.agentTimeoutMs ?? PRODUCTION_AGENT_DEFAULTS.timeoutMs,
      maxInputBytes: options.agentMaxInputBytes ?? PRODUCTION_AGENT_DEFAULTS.maxInputBytes,
      maxOutputTokens: options.agentMaxOutputTokens ?? PRODUCTION_AGENT_DEFAULTS.maxOutputTokens,
    })
    : options.agentCodexExecutable
      ? createCodexDecider({ executable: options.agentCodexExecutable, model: options.agentModel })
      : null);
  const agent = createAgentDriver({
    application: studio,
    decide: externalDecide,
    directory: options.studioDataDirectory ? join(options.studioDataDirectory, 'agent-dispatch') : null,
    maxSteps: options.agentMaxSteps ?? 12,
    maxCallsPerRun: options.agentMaxCallsPerRun ?? 24,
    maxCallsPerDay: options.agentMaxCallsPerDay ?? 96,
    maxConcurrentRuns: options.agentMaxConcurrentRuns ?? 2,
  });
  // Host-level cost/privacy statements must include the optional model runner;
  // the underlying provider-independent music engine still calls no model.
  const exposedStudio = Object.freeze({ ...studio, async capabilities() {
    const base = await studio.capabilities();
    const provider = agent.enabled ? (options.agentProvider ?? (options.agentCodexExecutable ? 'codex-cli' : 'in-process')) : null;
    return { ...base, external_agent: { enabled: agent.enabled, provider, execution: 'explicitly-authorized-bounded-continuation',
      automatic_restart: false, native_tool_results_accepted: false, automatic_provider_retry: false,
      max_concurrent_runs: agent.limits.max_concurrent_runs,
      limits: {
        ...agent.limits,
        max_input_bytes: options.agentMaxInputBytes ?? null,
        max_output_tokens: options.agentMaxOutputTokens ?? null,
        timeout_ms: options.agentTimeoutMs ?? null,
      } },
      ...(agent.enabled ? {
        cost: { ...base.cost, additional_recurring_cost: 'BOUNDED_OPERATOR_CONFIGURED', external_paid_services: provider,
          llm_api_dependency: provider === 'openai-responses' ? 'OPENAI_RESPONSES_API' : 'OPERATOR_CONFIGURED',
          notice: 'The optional external agent is limited by persistent per-run and per-day inference-call budgets, per-request input/output ceilings, one production concurrent run, timeout, and no automatic provider retry. Core musical operations do not require a model.' },
        privacy: { ...base.privacy, uploaded_assets_leave_this_service: true, raw_asset_bytes_sent: false, derived_symbolic_data_sent: true,
          calls_external_analysis_services: true, provider_response_storage: provider === 'openai-responses' ? false : null,
          notice: 'The enabled agent sends run metadata, derived symbolic events, cited evidence and reports to its configured model. Raw audio/MIDI bytes are not sent. The OpenAI Responses provider requests store:false.' },
      } : {}),
    };
  } });
  const api = createApiRouter({ application: exposedStudio, ownerOf: () => SERVICE_OWNER, challenge: auth.unauthorized().headers.get('www-authenticate'), agentDriver: agent });
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
        return handleMcp(request, { application: exposedStudio, owner: SERVICE_OWNER, allowedOrigins: auth.allowedOrigins });
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
  });
  const server = createHttpServer(application);
  server.listen(port, '0.0.0.0', () => console.log('MML OAuth service is ready'));
  const shutdown = () => server.close(() => { application.close(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
