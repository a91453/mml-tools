import { VERSION, PROFILE, ROLES } from '../dist/core.js';
import { createTechnicalService } from '../studio/backend/application/technical-service.mjs';
import { ERROR_CODES, StudioApplicationError } from '../studio/backend/application/contracts.mjs';
import { createCanonicalGate } from '../studio/backend/application/provenance.mjs';
import { STUDIO_MCP_TOOLS, UPLOAD_INSTRUCTION, runStudioTool } from './mcp-studio.mjs';
import { DEFAULT_LISTEN_CONFIG, LISTEN_MCP_TOOLS, LISTEN_TOOL_NAME, listenResources, readListenResource, runListenTool } from './mcp-listen.mjs';

// A deliberately small, stateless Streamable HTTP implementation. No sessions,
// background work, network requests, file writes, model calls or song repair.
//
// This transport is an adapter. It validates a JSON-RPC envelope, checks the
// declared input schema, names one Application Service operation and renders
// what comes back. It holds no MML logic of its own: the three original tools
// now call the same `technical-service.mjs` the HTTP surface calls, and the
// `studio_*` tools call the Application Service, so no workflow exists here
// that exists nowhere else.
//
// Nothing large travels through it. The 128 KiB body ceiling below is what
// keeps a recording out of a model's context: an agent that needs bytes in a
// project uploads them over the HTTP asset endpoint and passes the `asset_id`.
export const SERVICE_VERSION = '0.3.0';
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
// The revision a request speaks when it carries no MCP-Protocol-Version
// header. The header arrived with 2025-06-18, whose transport tells a server
// with no other way to know the version to assume 2025-03-26; a stateless
// server never has another way.
export const MCP_DEFAULT_PROTOCOL_VERSION = '2025-03-26';
// JSON-RPC batches exist in 2025-03-26 alone: that revision requires a server
// to receive them, and 2025-06-18 removed them.
export const MCP_BATCH_VERSIONS = Object.freeze(['2025-03-26']);
// A batch arrives in one body, so MAX_BODY_BYTES bounds it as it bounds a
// single message. This bounds the work one request can start and the reply,
// which holds one response per element, each under the per-call response cap.
export const MAX_BATCH_MESSAGES = 16;
export const MAX_BODY_BYTES = 131072;
const mcpTextEncoder = new TextEncoder();
const mcpAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mcpSongProperties = {
  mml: { type: 'string', minLength: 1, maxLength: 40000, description: '完整六軌 MML@...,...,...,...,...,...; 原文；不要為了通過檢查自動改音。' },
  meter_text: { type: 'string', minLength: 1, maxLength: 2048, description: '依來源指定拍號圖，每行「起拍 拍號」，例如 0 4/4。未知時先詢問，不可假定。' },
  pickup: { type: 'string', maxLength: 32, description: '來源確認的弱起拍長，整數、小數或分數；沒有時省略。' },
  final_partial: { type: 'string', maxLength: 32, description: '來源確認的末小節拍長；沒有時省略，不可裁尾湊合。' },
  drum_profile: { type: 'string', maxLength: 4096, description: '可選 JSON 鼓面表，包含 role、instrument、evidence、mapping；文字 evidence 不代表證據已核實。' },
  programs: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'integer', minimum: 0, maximum: 127 } },
  title: { type: 'string', maxLength: 120 },
};
const mcpPageProperty = { type: 'integer', minimum: 0, maximum: 100000 };

// The three original tools, unchanged. Their names, descriptions, schemas,
// annotations and report shape are a published contract that existing clients
// and the existing regression suite read; a rename dressed up as a cleanup
// would be a breaking change. They are listed on their own so that a server
// with no Application Service attached advertises exactly these three.
export const MCP_TOOLS = [
  {
    name: 'mml_service_info', title: 'MML 工具服務資訊',
    description: '查看服務版本、能力、限制與驗證範圍。不讀取對話歷史或網站中的歌曲。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: mcpAnnotations,
  },
  {
    name: 'mml_validate', title: '六軌 MML 技術檢查',
    description: '以 Published Canonical 驗證器檢查六軌、每軌 2400 字、語法、精確拍長、Tempo Map、小節與全部 15 對重疊。只回報，不改寫。Canonical 無法載入時直接拒絕，不退回 legacy 引擎。technical_ok 不代表原曲相似、已聽驗、播放器回讀或遊戲驗收通過。',
    inputSchema: { type: 'object', properties: { ...mcpSongProperties, error_offset: mcpPageProperty }, required: ['mml', 'meter_text'], additionalProperties: false },
    annotations: mcpAnnotations,
  },
  {
    name: 'mml_overlap_details', title: 'MML 重疊區間明細',
    description: '對 Published Canonical 技術檢查通過的同一份六軌 MML，分頁回傳持續同音及低中音小二度／大七度區間；全部 15 對摘要保留。這些是需審核的提醒，不是刪音指令。',
    inputSchema: { type: 'object', properties: { ...mcpSongProperties, offset: mcpPageProperty, limit: { type: 'integer', minimum: 1, maximum: 200 }, kind: { type: 'string', enum: ['all', 'same_pitch', 'low_mid_intervals'] } }, required: ['mml', 'meter_text'], additionalProperties: false },
    annotations: mcpAnnotations,
  },
];

function mcpReply(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
// The reply to input that produces no JSON-RPC response: accepted
// notifications only.
function mcpAccepted() {
  return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
}
// One message's outcome: its JSON-RPC response object and the HTTP status that
// response carries when it is the whole reply. A JSON-RPC error from a
// dispatched method is an ordinary 200 answer; a refusal before dispatch is a
// 4xx.
function mcpRpcError(id, code, message, status = 200, data = undefined) {
  return { status, body: { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } } };
}
// Shared with the local file-output adapter; network response bounds below
// remain unchanged. There is one tool-input schema checker on both paths.
export function mcpCheckSchema(schema, value, path = 'arguments') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${path} must be an object`);
    // An object schema with no declared properties and `additionalProperties`
    // open is a structured payload the Application Service validates itself: a
    // decision set, a confirmation block, an alignment report. That is ordinary
    // JSON Schema, and it is what `tools/list` advertises — no private type
    // value an external MCP host would have to understand.
    //
    // Reading it here as "any JSON object" is exactly what the schema says. The
    // additional plain-JSON check below is a transport safety property, not a
    // schema claim: it refuses anything JSON.parse can produce that is not
    // plain data, bounds depth and width, and rejects prototype-polluting keys.
    // The real vocabulary check belongs to the module that owns the vocabulary,
    // and duplicating it here would create a second contract to keep in step.
    if (!schema.properties) {
      mcpCheckPlainJson(value, path);
      return;
    }
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw Error(`${path}.${key} is required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw Error(`${path}: unknown property`);
      mcpCheckSchema(schema.properties[key], value[key], `${path}.${key}`);
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > schema.maxLength) throw Error(`${path}: invalid string length or type`);
    if (schema.enum && !schema.enum.includes(value)) throw Error(`${path}: invalid choice`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) throw Error(`${path}: integer out of range`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw Error(`${path}: invalid array length or type`);
    for (const item of value) mcpCheckSchema(schema.items, item, path);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw Error(`${path}: must be true or false`);
  } else throw Error('Unsupported schema');
}
// Rejects anything JSON.parse can produce that is not plain data, and any
// attempt to smuggle a prototype through a passthrough field.
function mcpCheckPlainJson(value, path, depth = 0) {
  if (depth > 12) throw Error(`${path}: nested too deeply`);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Array.isArray(value)) {
    if (value.length > 5000) throw Error(`${path}: array too long`);
    for (const item of value) mcpCheckPlainJson(item, path, depth + 1);
    return;
  }
  if (typeof value !== 'object') throw Error(`${path}: unsupported value`);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw Error(`${path}: forbidden property name`);
    mcpCheckPlainJson(value[key], `${path}.${key}`, depth + 1);
  }
}

function mcpPreflight(args) {
  // Protect the rational parser from pathological integer inputs before any
  // arithmetic. These bounds do not change the six-track musical rules.
  if (/\d{4}/.test(args.mml)) throw Error('MML 數值超過本服務的三位數安全界限；Strict Mobile 指令不需要四位數數值。');
  for (const key of ['meter_text', 'pickup', 'final_partial']) {
    const s = args[key] ?? '';
    if (/\d{10}/.test(s)) throw Error(`${key} 數值過長。`);
  }
  for (const key of ['pickup', 'final_partial']) {
    const s = args[key] ?? '';
    if (s && !/^\d+(?:\/\d+|\.\d{1,9})?$/.test(s)) throw Error(`${key} 需為非負整數、小數或分數。`);
  }
}
// The two technical tools' business logic lives in the Application Service's
// `technical-service.mjs`, which the HTTP surface calls too, so there is one
// implementation rather than two.
//
// This transport binds its own instance rather than reaching through an
// attached Application Service for these two tools, for one reason: the report
// carries `service_version`, which is a fact about the service answering the
// call, not about the orchestration layer. Routing it through an application
// constructed with a different version string would make the same tool report
// two different versions depending on how the process was wired. The logic is
// identical either way — same module, same factory, same code path.
//
// It is given its own Canonical gate, so `mml_validate` and
// `mml_overlap_details` answer with the Published Canonical validator whether
// or not an Application Service is attached. The gate is lazy and fails closed:
// a transport in an environment without the published Git history refuses these
// two tools with CANONICAL_NOT_LOADED rather than silently answering from the
// legacy engine, whose verdict differs in both directions. Tool discovery,
// `mml_service_info` and the `studio_*` tools are unaffected.
const technical = createTechnicalService({ serviceVersion: SERVICE_VERSION, canonical: createCanonicalGate() });

function mcpServiceInfo(tools) {
  return {
    name: 'MML Workbench Tools', service_version: SERVICE_VERSION, core_version: VERSION, profile: PROFILE,
    transport: 'stateless-streamable-http', protocol_versions: MCP_VERSIONS,
    roles: ROLES, per_track_character_limit: 2400,
    tools: tools.map(t => t.name),
    privacy: '僅處理本次工具呼叫傳入的內容與本服務自有的專案紀錄。服務程式不呼叫任何外部或付費 AI API、不讀取歷史對話；平台自身的資料政策仍適用。',
    limits: '沒有伺服器端音訊播放、MIDI／ABC 轉檔、曲譜自動修復或實機驗收。MCP 不承載檔案位元組；大型素材請改用 HTTP 上傳端點取得 asset_id。',
    binary_data_plane: UPLOAD_INSTRUCTION,
  };
}

async function mcpRunTool(name, args, context) {
  if (name === 'mml_service_info') return mcpServiceInfo(mcpToolsFor(context));
  if (name === 'mml_validate') return technical.validate(args);
  if (name === 'mml_overlap_details') return technical.overlapDetails(args);
  return runStudioTool(name, args, context);
}

// The advertised tool list. The `studio_*` tools require an Application Service
// (project records, asset storage, the Canonical-aware engines), so a transport
// without one advertises exactly the three original tools rather than offering
// tools it cannot run.
//
// `studio_listen` is a read-only listening projection with a UI resource
// (server/mcp-listen.mjs). It is listed after the control surface, and with it
// the `resources` capability, only where the Studio is attached: the Sites
// gateway's contract stays exactly the three technical tools.
function mcpToolsFor(context) {
  return context.application ? [...MCP_TOOLS, ...STUDIO_MCP_TOOLS, ...LISTEN_MCP_TOOLS] : MCP_TOOLS;
}

// A response cap is checked AFTER dispatch. A write may already have landed,
// so preserve bounded recovery coordinates rather than suggesting a new write.
// No report rows, source prose or arbitrary internal fields enter this envelope.
function oversizedResultDetails(tool, args, data, responseBytes) {
  const objects = [data, data?.run, data?.proposal, data?.artifact, data?.job, data?.project,
    data?.decisions, data?.reduction, data?.adaptation, data?.suggestion, args];
  const result_references = {};
  for (const [key, pattern] of Object.entries({
    project_id: /^prj_[0-9a-f]{32}$/, run_id: /^run_[0-9a-f]{32}$/,
    proposal_id: /^pro_[0-9a-f]{32}$/, artifact_id: /^art_[0-9a-f]{64}$/,
    candidate_id: /^g11d:rev:[0-9a-f]{64}$/, baseline_id: /^bas:[0-9a-f]{64}$/,
    job_id: /^job_[0-9a-f]{32}$/,
  })) {
    const value = objects.map(object => object?.[key]).find(value => typeof value === 'string' && pattern.test(value));
    if (value) result_references[key] = value;
  }
  const { project_id, run_id, proposal_id, artifact_id, job_id } = result_references;
  const recovery_reads = [];
  const add = (path, name, arguments_) => recovery_reads.push({ method: 'GET', path, mcp: { name, arguments: arguments_ } });
  if (project_id && run_id) add(`/api/v1/projects/${project_id}/runs/${run_id}`, 'studio_run_status', { project_id, run_id });
  if (project_id && proposal_id) add(`/api/v1/projects/${project_id}/proposals/${proposal_id}`, 'studio_proposal_status', { project_id, proposal_id });
  if (artifact_id) add(`/api/v1/artifacts/${artifact_id}`, 'studio_artifact_get', { artifact_id });
  if (job_id) add(`/api/v1/jobs/${job_id}`, 'studio_job_status', { job_id });
  if (project_id) add(`/api/v1/projects/${project_id}`, 'studio_project_get', { project_id });
  return {
    max_bytes: 524288, response_bytes: responseBytes, tool_name: tool.name,
    operation_returned: true,
    ...(typeof data?.operation === 'string' && /^(succeeded|blocked)$/.test(data.operation) ? { operation: data.operation } : {}),
    ...(typeof data?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.code) ? { result_code: data.code } : {}),
    result_references, recovery_reads,
    recovery_notice: `The service returned before the response-size check; ${data?.operation === 'succeeded' ? 'the operation succeeded and has already taken effect, so never retry it. That still does not imply gate acceptance.' : 'this does not imply success or gate acceptance.'} Do not repeat a mutating call just because its response was too large. Inspect the referenced state first using the same authenticated owner. For large reads, use report_page on the existing read tool (without confirmations or refresh), or its authenticated HTTP GET equivalent. The full report is not included or newly archived by this envelope.`,
  };
}

async function mcpReadBody(request) {
  const size = request.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_BODY_BYTES)) throw Error('BODY_TOO_LARGE');
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); throw Error('BODY_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Handle one MCP request.
 *
 * `application` and `owner` are optional: without them this serves exactly the
 * three original read-only tools, which is what the Sites worker needs and what
 * the existing regressions pin. With them, the `studio_*` control surface is
 * advertised and dispatched too.
 */
// Browser-hosted MCP clients send an Origin; hosted connectors and CLI clients
// do not. Only the server's own origin and the origins of the approved OAuth
// callback hosts are accepted. The Sites worker attaches no Application Service
// and keeps the ChatGPT-only default it always had.
export const DEFAULT_MCP_ORIGINS = Object.freeze(['https://chatgpt.com']);

// The JSON-RPC error a 2026-07-28 client expects when it names a protocol
// version this server does not speak: the versions it does speak, so the
// client picks one and retries. The MCP SDK's default connect policy probes
// `server/discover` at its newest version before anything else and falls back
// to the `initialize` handshake on this answer; every Claude and ChatGPT
// connector session therefore opens with one refused request, which is the
// 400-then-200 pair the production HTTP log shows, and not a failure.
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// `rejectLog`, when given, receives one record per request this transport
// refuses before it reaches a JSON-RPC method (the status, the reason, the
// method, the protocol-version header and the user agent; never the body).
// A batch element refused on its own adds its `batch_index`, and its `status`
// is the one it would carry alone; the batch itself may still answer 200.
// The deployed server logs it so a client that is turned away is diagnosable
// from the deployment log alone: the platform's HTTP log records the status
// but not why.
// `faultLog`, when given, receives one record per tool call that ends in an
// unexpected fault (see server/api.mjs faultRecord); the caller still sees only
// INTERNAL_ERROR.
export async function handleMcp(request, { application = null, owner = null, allowedOrigins = DEFAULT_MCP_ORIGINS, listen = DEFAULT_LISTEN_CONFIG, rejectLog = null, faultLog = null } = {}) {
  const context = { application, owner };
  const protocol = request.headers.get('mcp-protocol-version');
  // Builds a refusal outcome and logs it; `extra` joins the log record.
  const refusal = (extra = {}) => (code, message, status, method = null, id = null, data = undefined) => {
    if (typeof rejectLog === 'function') {
      try { rejectLog({ status, reason: message, method, protocol_version_header: protocol ?? null, user_agent: request.headers.get('user-agent') ?? null, ...extra }); } catch {}
    }
    return mcpRpcError(id, code, message, status, data);
  };
  const reject = (...args) => { const { status, body } = refusal()(...args); return mcpReply(body, status); };
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && !allowedOrigins.includes(origin)) return reject(-32000, 'Origin not allowed', 403);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reject(-32600, 'Content-Type must be application/json', 415);
  const accept = (request.headers.get('accept') ?? '').split(',').map(s => s.trim().split(';')[0]);
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return reject(-32600, 'Accept must include application/json and text/event-stream', 406);
  let message;
  try { message = JSON.parse(await mcpReadBody(request)); }
  catch (error) { return reject(error.message === 'BODY_TOO_LARGE' ? -32600 : -32700, error.message === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Invalid JSON', error.message === 'BODY_TOO_LARGE' ? 413 : 400); }
  const env = { context, listen, faultLog, protocol };
  if (Array.isArray(message)) return mcpBatch(message, env, refusal, reject);
  const outcome = await mcpMessage(message, env, refusal());
  return outcome ? mcpReply(outcome.body, outcome.status) : mcpAccepted();
}

// A JSON-RPC batch. 2025-03-26 requires a server to receive one (basic
// protocol), lists an array of requests and/or notifications as a valid POST
// body (transports), and forbids initialize inside one (lifecycle); 2025-06-18
// removed batching, so a batch at a later version is refused. A request without
// the version header speaks the default revision, 2025-03-26.
//
// The batch arrived through the same authenticated request and the same body
// limit as a single message. Each element then passes the same envelope
// checks, dispatch, response cap and refusal log as a single message, one
// after another in order, since a tool call may write. The reply is the array
// of the responses to its requests; notifications are never answered, so a
// batch of notifications alone gets 202, or 400 when one is refused.
async function mcpBatch(messages, env, refusal, reject) {
  if (!messages.length) return reject(-32600, 'Invalid JSON-RPC request', 400);
  const { protocol } = env;
  if (protocol && !MCP_VERSIONS.includes(protocol)) {
    return reject(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported MCP protocol version', 400, null, null, { supported: MCP_VERSIONS, requested: protocol });
  }
  if (!MCP_BATCH_VERSIONS.includes(protocol ?? MCP_DEFAULT_PROTOCOL_VERSION)) return reject(-32600, 'JSON-RPC batches are not supported at this MCP protocol version', 400);
  if (messages.length > MAX_BATCH_MESSAGES) return reject(-32600, 'JSON-RPC batch has too many messages', 400, null, null, { max_messages: MAX_BATCH_MESSAGES });
  // Nothing may run before initialization completes, so a batch carrying
  // initialize is refused whole rather than partly dispatched.
  if (messages.some(message => message?.method === 'initialize')) return reject(-32600, 'initialize must not be part of a JSON-RPC batch', 400, 'initialize');
  const outcomes = [], refusedNotifications = [];
  for (const [index, message] of messages.entries()) {
    const outcome = await mcpMessage(message, env, refusal({ batch_index: index }));
    // JSON-RPC 2.0 never answers a notification, inside a batch or not, so
    // a well-formed element without an id adds no entry to the reply; its
    // refusal is still logged. A malformed element is answered with id null.
    if (outcome) (mcpIsNotification(message) ? refusedNotifications : outcomes).push(outcome);
  }
  // Input of notifications alone is accepted with 202, or refused with 400
  // when one of them is, as the Streamable HTTP transport requires.
  if (!outcomes.length) return refusedNotifications.length ? mcpReply(refusedNotifications[0].body, 400) : mcpAccepted();
  // Any dispatched request makes this an ordinary answer carrying each
  // request's own result or error. Requests all refused before dispatch are
  // refused with 400, as a single refused message is.
  return mcpReply(outcomes.map(outcome => outcome.body), outcomes.some(outcome => outcome.status === 200) ? 200 : 400);
}

function mcpIsNotification(message) {
  return Boolean(message) && typeof message === 'object' && !Array.isArray(message) && message.jsonrpc === '2.0' && typeof message.method === 'string' && !Object.hasOwn(message, 'id');
}

// One JSON-RPC message: its outcome ({ status, body }), or null for an
// accepted notification, which produces no response. `refuse` logs and builds
// a refusal before dispatch.
async function mcpMessage(message, { context, listen, faultLog, protocol }, refuse) {
  const { application } = context;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return refuse(-32600, 'Invalid JSON-RPC request', 400);
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) return refuse(-32600, 'Invalid request id', 400, message.method);
  // A request naming a protocol version this server does not speak is refused
  // with 400, as the Streamable HTTP transport requires, and the refusal names
  // the versions it does speak so a newer client falls back to one of them.
  if (protocol && !MCP_VERSIONS.includes(protocol)) {
    return refuse(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported MCP protocol version', 400, message.method, hasId ? message.id : null, { supported: MCP_VERSIONS, requested: protocol });
  }
  if (!hasId) {
    // Notifications must never invoke tools. Stateless initialized/cancelled
    // notifications are accepted without producing a JSON-RPC response.
    if (!['notifications/initialized', 'notifications/cancelled'].includes(message.method)) return refuse(-32600, 'Unsupported notification', 400, message.method);
    return null;
  }
  const id = message.id, params = message.params;
  let result;
  if (message.method === 'initialize') {
    if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) return mcpRpcError(id, -32602, 'Invalid initialize parameters');
    const instructions = application
      ? `Studio control surface plus the original technical MML checks. For an orchestrated song, discover studio_capabilities and studio_project_get, upload the sources, then studio_run_start with an idempotency_key. Inspect studio_run_status and studio_proposal_targets; submit a cited studio_proposal_submit, read its review, and use studio_proposal_resolve only for an explicitly authorized acceptance. Re-read the run after every operation. Use studio_run_resume for a new authorized advancement; nothing continues in the background after a response. Missing reviewer evidence must stay pending: never invent confirmations, Lead/Core3 evidence or gate acceptance. The direct operation tools remain available for deliberate, source-cited review workflows by any client, not as shortcuts around proposal policy; no evidence is graded on who submits it, so cite only a source you actually reviewed and state the method honestly. A suggestion is never an acceptance and PENDING is never a default. Gate axes are independent: technical success never establishes source, audio, player or in-game acceptance, and nothing you can call sets in_game. To let the user hear a delivered Final or a revision, call the read-only studio_listen; what the user sends back from its player is listening feedback in the conversation, never a gate confirmation, evidence or acceptance. Long lists in a response (for example the per-release records of a machine-delivery ledger) are summarized as {compacted, total, first, sha256, report_page or retrieve}; read the full list with report_page on the named read tool and path. A PAYLOAD_TOO_LARGE error whose details say operation_returned: true (for example operation: "succeeded") means the operation already took effect: never retry it; read the state back through details.recovery_reads, using report_page for large reads. studio_audio_prescreen compares 2-4 alternatives bar by bar and returns machine evidence only: an OBVIOUS bar is not an acceptance, it never sets Gate 7, player readback or in_game, and its free GM bank is not the game timbre; NEEDS_HUMAN bars are for the owner to hear. ${UPLOAD_INSTRUCTION}`
      : 'Only technical MML checks. Pass MML and source-confirmed meter explicitly. Never interpret technical_ok as listening, source, player, or game acceptance. Tools do not rewrite songs or access conversation history.';
    // Resources exist only for the listening player's UI, so they are
    // advertised only where `studio_listen` is.
    const capabilities = application
      ? { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }
      : { tools: { listChanged: false } };
    result = { protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0], capabilities, serverInfo: { name: 'mml-workbench-tools', version: SERVICE_VERSION }, instructions };
  } else if (message.method === 'ping') result = {};
  else if (application && message.method === 'resources/list') {
    if (params?.cursor !== undefined) return mcpRpcError(id, -32602, 'This resource list is not paginated');
    result = { resources: listenResources(listen) };
  } else if (application && message.method === 'resources/templates/list') {
    if (params?.cursor !== undefined) return mcpRpcError(id, -32602, 'This resource template list is not paginated');
    result = { resourceTemplates: [] };
  } else if (application && message.method === 'resources/read') {
    if (!params || typeof params.uri !== 'string' || params.uri.length > 256) return mcpRpcError(id, -32602, 'Invalid resource uri');
    result = readListenResource(params.uri, listen);
    if (!result) return mcpRpcError(id, -32002, 'Resource not found', 200, { uri: params.uri.slice(0, 256) });
  }
  else if (message.method === 'tools/list') {
    if (params?.cursor !== undefined) return mcpRpcError(id, -32602, 'This tool list is not paginated');
    result = { tools: mcpToolsFor(context) };
  } else if (message.method === 'tools/call') {
    const tool = mcpToolsFor(context).find(t => t.name === params?.name);
    if (!tool) return mcpRpcError(id, -32602, 'Unknown tool');
    const args = params.arguments ?? {};
    try { mcpCheckSchema(tool.inputSchema, args); }
    catch (error) { return mcpRpcError(id, -32602, error.message); }
    try {
      // `studio_listen` answers a person as well as a model: its text content
      // is a readable summary with the listen link, for hosts that render no
      // UI. Every other tool's text content stays the serialized report.
      let data, text = null;
      if (tool.name === LISTEN_TOOL_NAME) ({ structuredContent: data, text } = await runListenTool(args, { ...context, listen }));
      else data = await mcpRunTool(tool.name, args, { ...context, listen });
      const serialized = JSON.stringify(data);
      // A deliberate, caller-actionable refusal rather than a fault, so it is
      // raised in the structured form that survives the sanitizer below.
      const responseBytes = mcpTextEncoder.encode(serialized).byteLength + (text === null ? 0 : mcpTextEncoder.encode(text).byteLength);
      if (responseBytes > 524288) {
        throw new StudioApplicationError(ERROR_CODES.PAYLOAD_TOO_LARGE,
          'The operation already returned, but its full response exceeds the MCP size limit. Inspect recovery details before retrying.',
          oversizedResultDetails(tool, args, data, responseBytes));
      }
      result = { content: [{ type: 'text', text: text ?? serialized }], structuredContent: data, isError: false };
    } catch (error) {
      // A structured Application Service refusal keeps its code and details: a
      // model that is told only "failed" cannot tell a blocked gate from a
      // malformed request, and would retry the wrong thing. These messages are
      // written to be read by a caller, and the legacy technical tools' own
      // argument refusals are the same kind of thing.
      //
      // Anything else is an unexpected fault, and its message is not written
      // for a caller: an import failure, a filesystem error or an internal
      // assertion names modules, container paths and dependency internals. It
      // is reduced to a stable generic code here, exactly as the HTTP adapter
      // already does, so the two transports leak the same amount: nothing.
      // Neither the raw message, the cause chain nor the stack is sent.
      //
      // A refusal still says which rules snapshot answered it, exactly as the
      // HTTP adapter's error responses do: an agent that is told a call failed
      // has to read that failure against the right release.
      const canonical = application ? await application.canonical.provenance().catch(() => null) : null;
      if (error?.name !== 'StudioApplicationError' && typeof faultLog === 'function') {
        try {
          faultLog({ transport: 'mcp', tool: tool.name, error_name: typeof error?.name === 'string' ? error.name.slice(0, 64) : typeof error, error_message: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300) });
        } catch {}
      }
      const structured = {
        ...(error?.name === 'StudioApplicationError'
          ? { error: { code: error.code, message: error.message, details: error.details } }
          : { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } }),
        ...(canonical ? { canonical } : {}),
      };
      result = { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: true };
    }
  } else return mcpRpcError(id, -32601, 'Method not found');
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}
