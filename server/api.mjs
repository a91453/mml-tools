// HTTP adapter for the Studio Application Service.
//
// Status: IMPLEMENTATION NOTES. A transport and nothing else. It parses a
// request, names one Application Service operation, and renders the result. It
// holds no MML logic, no arrangement logic, no Canonical logic and no gate
// logic. Every route below is one Application Service operation.
//
// This surface is wider than the MCP one, not narrower: the binary plane and
// the technical-validation routes are reachable only here. See the transport
// note in `studio/backend/application/index.mjs` for which operations each
// transport reaches and why.
//
// `/api/v1/*` is this repository's own interface, served by this process. It is
// not a call to a third-party API, and nothing here acquires a credential,
// contacts an external service, or depends on a paid provider.
//
// The binary data plane lives here on purpose. A recording is uploaded once,
// over HTTP, as bytes — multipart for a browser form, or a raw body for a CLI —
// and becomes an `asset_id`. Every later step names that id. MCP has no route
// that can carry the bytes, which is what keeps a 30 MB file out of a model's
// context.

import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  LIMITS,
  StudioApplicationError,
} from '../studio/backend/application/index.mjs';

export const API_PREFIX = '/api/v1';

// Slack over the asset ceiling for multipart framing (boundaries, part headers).
const MAX_UPLOAD_ENVELOPE = LIMITS.maxAssetBytes + 64 * 1024;
const MAX_MULTIPART_PARTS = 8;

const noStore = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...noStore, ...headers } });

const errorResponse = (error, canonical = null) => {
  if (error instanceof StudioApplicationError) {
    return json({ error: { code: error.code, message: error.message, details: error.details }, ...(canonical ? { canonical } : {}) }, ERROR_HTTP_STATUS[error.code] ?? 400);
  }
  // An unexpected failure must not leak an internal message, a path or a stack.
  return json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }, 500);
};

async function readBody(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new StudioApplicationError(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Request body is too large', { max_bytes: limit });
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new StudioApplicationError(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Request body is too large', { max_bytes: limit });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(request) {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Content-Type must be application/json');
  }
  const bytes = await readBody(request, LIMITS.maxJsonBodyBytes);
  if (!bytes.byteLength) return {};
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Request body is not valid UTF-8'); }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Request body is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Request body must be a JSON object');
  }
  return value;
}

// ─── multipart ──────────────────────────────────────────────────────────────
//
// A deliberately small reader for exactly the shape a browser or a phone sends
// for one file plus a couple of text fields. It works on bytes throughout: a
// UTF-8 round trip over an audio file would replace invalid sequences and hand
// intake different bytes than the ones the digest names.

const indexOfBytes = (haystack, needle, from = 0) => {
  outer: for (let index = from; index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
};

function parseMultipart(bytes, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'multipart/form-data requires a boundary');
  const boundary = (match[1] ?? match[2]).trim();
  if (!boundary || boundary.length > 200) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Invalid multipart boundary');

  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const headerEnd = encoder.encode('\r\n\r\n');
  const parts = [];

  let cursor = indexOfBytes(bytes, delimiter, 0);
  if (cursor === -1) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Malformed multipart body');

  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    // `--` after the delimiter closes the body.
    if (bytes[afterDelimiter] === 0x2d && bytes[afterDelimiter + 1] === 0x2d) break;
    const partStart = afterDelimiter + 2; // CRLF
    const next = indexOfBytes(bytes, delimiter, partStart);
    if (next === -1) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Unterminated multipart body');

    const separator = indexOfBytes(bytes, headerEnd, partStart);
    if (separator === -1 || separator > next) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Multipart part has no headers');

    let headerText;
    try { headerText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(partStart, separator)); }
    catch { throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Multipart part headers are not valid UTF-8'); }

    const disposition = /content-disposition:([^\r\n]*)/i.exec(headerText)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const partType = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1]?.trim().toLowerCase() ?? null;

    // The trailing CRLF before the next delimiter belongs to the framing.
    parts.push({ name, filename, contentType: partType, bytes: bytes.subarray(separator + headerEnd.length, Math.max(separator + headerEnd.length, next - 2)) });
    if (parts.length > MAX_MULTIPART_PARTS) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Too many multipart parts', { max_parts: MAX_MULTIPART_PARTS });
    cursor = next;
  }
  return parts;
}

const textPart = parts => name => {
  const part = parts.find(entry => entry.name === name);
  if (!part) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(part.bytes); }
  catch { throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, `Multipart field ${name} is not valid UTF-8`); }
};

/**
 * Read an asset upload from either accepted framing.
 *
 * multipart/form-data for a browser or phone form; a raw body with
 * `x-mml-asset-kind` for a CLI or an agent's HTTP client. Both land on the same
 * Application Service call: neither is a second upload path with its own rules.
 */
async function readUpload(request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (/^multipart\/form-data/i.test(contentType)) {
    const bytes = await readBody(request, MAX_UPLOAD_ENVELOPE);
    const parts = parseMultipart(bytes, contentType);
    const field = textPart(parts);
    const file = parts.find(part => part.filename !== null) ?? parts.find(part => part.name === 'file');
    if (!file) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'multipart upload must contain a file part');
    return {
      kind: field('kind'),
      // The client's filename is metadata. The Application Service stores it and
      // never opens, joins or resolves it.
      filename: field('filename') ?? file.filename,
      mediaType: field('media_type') ?? file.contentType ?? 'application/octet-stream',
      bytes: Uint8Array.from(file.bytes),
    };
  }
  return {
    kind: request.headers.get('x-mml-asset-kind'),
    filename: request.headers.get('x-mml-asset-filename'),
    mediaType: (contentType.split(';')[0].trim() || 'application/octet-stream').toLowerCase(),
    bytes: await readBody(request, MAX_UPLOAD_ENVELOPE),
  };
}

// ─── routing ────────────────────────────────────────────────────────────────

/**
 * Build the `/api/v1` router.
 *
 * `ownerOf` maps an authenticated request to a stable owner subject. It is a
 * parameter because ownership is the transport's question, not the Application
 * Service's: the service takes a subject string and isolates records by it,
 * whatever the deployment's identity model happens to be.
 */
export function createApiRouter({ application, ownerOf, challenge = null, agentDriver = null }) {
  const routes = [
    ['GET', /^\/agent$/, async () => json({ enabled: Boolean(agentDriver?.enabled) })],
    ['GET', /^\/projects\/([^/]+)\/runs\/([^/]+)\/agent$/, async (m, _r, owner) => {
      if (agentDriver) return json(await agentDriver.status(owner, m[1], m[2]));
      await application.getRun(owner, m[1], m[2]);
      return json({ enabled: false, task: null });
    }],
    ['POST', /^\/projects\/([^/]+)\/runs\/([^/]+)\/agent$/, async (m, request, owner) => {
      if (!agentDriver) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'No agent runner configured');
      return json(await agentDriver.start(owner, m[1], m[2], await readJson(request)), 202);
    }],
    ['POST', /^\/projects\/([^/]+)\/runs\/([^/]+)\/agent\/stop$/, async (m, _r, owner) => {
      if (!agentDriver) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'No agent runner configured');
      return json(await agentDriver.stop(owner, m[1], m[2]));
    }],
    ['POST', /^\/projects\/([^/]+)\/runs\/([^/]+)\/agent\/reconcile$/, async (m, request, owner) => {
      if (!agentDriver) throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'No agent runner configured');
      return json(await agentDriver.reconcile(owner, m[1], m[2], await readJson(request)));
    }],
    ['GET', /^\/capabilities$/, async () => json(await application.capabilities())],

    ['GET', /^\/projects$/, async (_m, request, owner) => json(await application.listProjects(owner))],
    ['POST', /^\/projects$/, async (_m, request, owner) => json(await application.createProject(owner, await readJson(request)), 201)],
    ['GET', /^\/projects\/([^/]+)$/, async (m, _r, owner) => json(await application.getProject(owner, m[1]))],

    ['GET', /^\/projects\/([^/]+)\/assets$/, async (m, _r, owner) => json(await application.listAssets(owner, m[1]))],
    ['POST', /^\/projects\/([^/]+)\/assets$/, async (m, request, owner) =>
      json(await application.uploadAsset(owner, m[1], await readUpload(request)), 201)],
    ['GET', /^\/projects\/([^/]+)\/assets\/([^/]+)$/, async (m, _r, owner) => json(await application.getAsset(owner, m[1], m[2]))],
    ['GET', /^\/projects\/([^/]+)\/assets\/([^/]+)\/content$/, async (m, _r, owner) => {
      const { asset, bytes } = application.readAssetBytes(owner, m[1], m[2]);
      return new Response(bytes, {
        status: 200,
        headers: {
          ...noStore,
          'content-type': asset.media_type,
          'content-length': String(asset.size),
          // `attachment` with no filename: the upload name is untrusted text and
          // is never reflected into a header a browser acts on.
          'content-disposition': 'attachment',
        },
      });
    }],

    ['GET', /^\/projects\/([^/]+)\/baseline\/events$/, async (m, request, owner) => {
      const query = new URL(request.url).searchParams;
      const integer = (name, fallback) => {
        const raw = query.get(name);
        if (raw === null || raw === '') return fallback;
        return /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
      };
      return json(await application.listBaselineEvents(owner, m[1], {
        laneId: query.get('lane_id'),
        eventIds: query.has('event_ids') ? query.get('event_ids').split(',').map(id => id.trim()).filter(Boolean) : null,
        offset: integer('offset', 0),
        limit: integer('limit', LIMITS.maxEventsPerPage),
      }));
    }],
    ['POST', /^\/projects\/([^/]+)\/intake$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.analyzeSources(owner, m[1], { assetIds: body.asset_ids ?? null, meterText: body.meter_text ?? '' }));
    }],
    ['POST', /^\/projects\/([^/]+)\/audio-alignment$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.attachAudioAlignment(owner, m[1], { candidateId: body.candidate_id, report: body.report }));
    }],
    ['POST', /^\/projects\/([^/]+)\/arrangement\/suggest$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.suggestArrangement(owner, m[1], { refresh: body.refresh === true }));
    }],
    ['POST', /^\/projects\/([^/]+)\/decisions$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.applyDecisions(owner, m[1], {
        decisions: body.decisions,
        parentCandidateId: body.parent_candidate_id ?? null,
        acceptedBy: body.accepted_by ?? null,
      }));
    }],
    ['POST', /^\/projects\/([^/]+)\/review$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.reviewCandidate(owner, m[1], {
        candidateId: body.candidate_id,
        confirmations: body.confirmations ?? null,
      }));
    }],
    // The Final Six-Role Reduction, preview and apply on two routes. Never one
    // route with an `apply` flag: the preview writes nothing and the apply
    // mints a revision, and a single flag is one typo away from a mutation
    // nobody previewed.
    ['POST', /^\/projects\/([^/]+)\/final-reduction\/plan$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.planFinalReduction(owner, m[1], {
        candidateId: body.candidate_id,
        decisions: body.decisions ?? [],
        acceptedBy: body.accepted_by ?? null,
        instrumentProfile: body.instrument_profile ?? null,
      }));
    }],
    ['POST', /^\/projects\/([^/]+)\/final-reduction\/apply$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.applyFinalReduction(owner, m[1], {
        candidateId: body.candidate_id,
        decisions: body.decisions ?? [],
        expectedPlanId: body.expected_plan_id,
        acceptedBy: body.accepted_by,
        instrumentProfile: body.instrument_profile ?? null,
      }));
    }],
    ['POST', /^\/projects\/([^/]+)\/mobile-adaptation\/plan$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.planMobileAdaptation(owner, m[1], { candidateId: body.candidate_id, profile: body.profile ?? null, releaseRepresentation: body.release_representation ?? null }));
    }],
    ['POST', /^\/projects\/([^/]+)\/mobile-adaptation\/apply$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.applyMobileAdaptation(owner, m[1], { candidateId: body.candidate_id, profile: body.profile ?? null, releaseRepresentation: body.release_representation ?? null, expectedPlanId: body.expected_plan_id, acceptedBy: body.accepted_by }));
    }],
    // Gate 4's two questions, each on its own route, because each is a
    // different review axis and neither answers the other: one reviewed Core3
    // source change at a time here, and the Core3 musical-completeness review
    // as a candidate-bound confirmation on the routes above.
    ['POST', /^\/projects\/([^/]+)\/core3\/approvals$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.approveCore3SourceChange(owner, m[1], {
        candidateId: body.candidate_id,
        approval: body.approval ?? null,
      }));
    }],
    // Fresh Lead evidence for a move an earlier revision already applied. Not a
    // decision route: nothing moves, and no revision is produced.
    ['POST', /^\/projects\/([^/]+)\/lead-evidence\/reviews$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.reviewLeadEvidence(owner, m[1], {
        candidateId: body.candidate_id,
        review: body.review ?? null,
      }));
    }],
    ['POST', /^\/projects\/([^/]+)\/confirmations$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.recordConfirmations(owner, m[1], body.confirmations ?? body));
    }],
    ['POST', /^\/projects\/([^/]+)\/finalize$/, async (m, request, owner) => {
      const body = await readJson(request);
      return json(await application.finalize(owner, m[1], {
        candidateId: body.candidate_id,
        // Passed through exactly as supplied. Asking to finalize does not turn
        // the repair on, and there is no automatic mode.
        technicalTimingRepair: body.technical_timing_repair ?? false,
        confirmations: body.confirmations ?? null,
        // Source-confirmed bar closure for the authoritative Final parser, as
        // supplied. Never derived.
        pickup: body.pickup ?? null,
        finalPartial: body.final_partial ?? null,
      }));
    }],

    // ── runs ────────────────────────────────────────────────────────────────
    //
    // One traceable, explicitly resumable workflow instance over the operations
    // above. The same run service answers the `studio_run_*` MCP tools: there
    // is one workflow, not one per transport.
    //
    // `plan` is POST because it takes a body, not because it writes: it creates
    // no run and writes nothing at all. `/runs/plan` is listed before the
    // collection route so the more specific path wins.
    ['POST', /^\/projects\/([^/]+)\/runs\/plan$/, async (m, request, owner) =>
      json(await application.planRun(owner, m[1], await readJson(request)))],
    ['POST', /^\/projects\/([^/]+)\/runs$/, async (m, request, owner) =>
      json(await application.startRun(owner, m[1], await readJson(request)), 201)],
    ['GET', /^\/projects\/([^/]+)\/runs$/, async (m, _r, owner) => json(await application.getRun(owner, m[1], null))],
    ['GET', /^\/projects\/([^/]+)\/runs\/([^/]+)\/next$/, async (m, request, owner) => {
      const query = new URL(request.url).searchParams;
      const input = {};
      for (const [key, value] of query) {
        if (key !== 'expected_run_revision' || Object.hasOwn(input, key) || !/^[1-9][0-9]*$/.test(value)) {
          throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'Invalid run-next query');
        }
        input[key] = Number(value);
      }
      return json(await application.nextRun(owner, m[1], m[2], input));
    }],
    ['GET', /^\/projects\/([^/]+)\/runs\/([^/]+)$/, async (m, _r, owner) => json(await application.getRun(owner, m[1], m[2]))],
    ['POST', /^\/projects\/([^/]+)\/runs\/([^/]+)\/resume$/, async (m, request, owner) =>
      json(await application.resumeRun(owner, m[1], m[2], await readJson(request)))],

    // ── proposals ───────────────────────────────────────────────────────────
    //
    // The AI Proposal Protocol. The same proposal service answers the
    // `studio_proposal_*` MCP tools: there is one protocol, not one per
    // transport, and neither adapter holds a policy of its own.
    //
    // Submitting is a POST because it writes a record, and it writes ONLY that
    // record: no candidate, no revision, no confirmation, no gate and no run
    // advancement. Resolving is where an acceptance can reach an operation.
    ['GET', /^\/projects\/([^/]+)\/runs\/([^/]+)\/proposal-targets$/, async (m, _r, owner) =>
      json(await application.proposalTargets(owner, m[1], m[2]))],
    ['POST', /^\/projects\/([^/]+)\/proposals$/, async (m, request, owner) =>
      json(await application.proposeDecision(owner, m[1], await readJson(request)), 201)],
    ['GET', /^\/projects\/([^/]+)\/proposals$/, async (m, request, owner) => {
      const query = new URL(request.url).searchParams;
      // Only the filters the operation accepts, and only when the caller stated
      // them, so a query string cannot smuggle a field past the operation's own
      // closed key set.
      //
      // An unknown parameter IS dropped here rather than refused, and that is
      // worth saying plainly: the MCP tool refuses it (`additionalProperties:
      // false`), so the two surfaces differ on this one point. It is a
      // read-only filter over records the caller already owns, so dropping one
      // narrows nothing and reaches nothing -- but a comment claiming the
      // stricter behaviour would be the kind of stated-but-untrue thing this
      // protocol refuses elsewhere.
      const filter = {};
      for (const name of ['run_id', 'request_key', 'state', 'kind']) {
        if (query.has(name)) filter[name] = query.get(name);
      }
      return json(await application.listProposals(owner, m[1], filter));
    }],
    ['GET', /^\/projects\/([^/]+)\/proposals\/([^/]+)$/, async (m, _r, owner) =>
      json(await application.getProposal(owner, m[1], m[2]))],
    ['POST', /^\/projects\/([^/]+)\/proposals\/([^/]+)\/resolve$/, async (m, request, owner) =>
      json(await application.resolveProposal(owner, m[1], m[2], await readJson(request)))],

    // ── audio prescreen ─────────────────────────────────────────────────────
    //
    // The same operations the `studio_audio_prescreen` and
    // `studio_prescreen_shadow_record` tools reach. Computing a prescreen is a
    // POST because it takes a body, not because it writes: it writes no record.
    // Only the shadow POST writes, and only the project's calibration record.
    ['POST', /^\/audio-prescreen$/, async (_m, request, owner) =>
      json(await application.audioPrescreen(owner, null, await readJson(request)))],
    ['POST', /^\/projects\/([^/]+)\/audio-prescreen$/, async (m, request, owner) =>
      json(await application.audioPrescreen(owner, m[1], await readJson(request)))],
    ['GET', /^\/projects\/([^/]+)\/audio-prescreen\/shadow$/, async (m, _r, owner) =>
      json(await application.prescreenShadowStatus(owner, m[1]))],
    ['POST', /^\/projects\/([^/]+)\/audio-prescreen\/shadow$/, async (m, request, owner) =>
      json(await application.recordPrescreenShadow(owner, m[1], await readJson(request)))],

    ['GET', /^\/projects\/([^/]+)\/jobs$/, async (m, _r, owner) => json(await application.listJobs(owner, m[1]))],
    ['GET', /^\/jobs\/([^/]+)$/, async (m, _r, owner) => json(await application.getJob(owner, m[1]))],
    ['GET', /^\/artifacts\/([^/]+)$/, async (m, _r, owner) => json(await application.getArtifact(owner, m[1]))],

    // The technical check, over HTTP. MCP reaches the same Canonical service
    // through the original mml_validate / mml_overlap_details tools; it does
    // not need a duplicate `studio_*` tool. Both engines are reachable and
    // named apart: the legacy routes below are an explicitly labelled
    // diagnostic whose PASS is never a Canonical PASS.
    //
    // `/technical/*` is the Published Canonical answer and fails closed when
    // the published rules are unavailable. `/technical/legacy/*` is the legacy
    // `dist/core.js` diagnostic, under its own path so that no caller reaches a
    // legacy verdict while asking for a Canonical one.
    ['POST', /^\/technical\/validate$/, async (_m, request) => json(await application.validateTechnicalMml(await readJson(request)))],
    ['POST', /^\/technical\/overlaps$/, async (_m, request) => json(await application.technicalOverlapDetails(await readJson(request)))],
    ['POST', /^\/technical\/legacy\/validate$/, async (_m, request) => json(application.legacyTechnicalDiagnostic(await readJson(request)))],
    ['POST', /^\/technical\/legacy\/overlaps$/, async (_m, request) => json(application.legacyTechnicalOverlapDetails(await readJson(request)))],
  ];

  return async function handleApi(request, { authenticated }) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) return null;
    const path = url.pathname.slice(API_PREFIX.length) || '/';

    const matched = routes.filter(([, pattern]) => pattern.test(path));
    if (!matched.length) return json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }, 404);
    const route = matched.find(([method]) => method === request.method);
    if (!route) {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported method for this endpoint' } }, 405, {
        allow: [...new Set(matched.map(([method]) => method))].join(', '),
      });
    }

    if (!authenticated) {
      // The same challenge the MCP endpoint issues, so an HTTP client discovers
      // the authorization server the same way (RFC 9728 resource metadata).
      return json({ error: { code: ERROR_CODES.NOT_AUTHENTICATED, message: 'Studio service sign-in required' } }, 401, challenge ? { 'www-authenticate': challenge } : {});
    }

    try {
      return await route[2](route[1].exec(path), request, ownerOf(request));
    } catch (error) {
      // The provenance envelope is attached to failures too: an agent that is
      // told a call failed still has to know which rules snapshot answered.
      let canonical = null;
      try { canonical = await application.canonical.provenance(); } catch { canonical = null; }
      return errorResponse(error, canonical);
    }
  };
}
