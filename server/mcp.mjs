import { VERSION, PROFILE, ROLES, validateMML, secondsAt } from '../dist/core.js';

// A deliberately small, stateless Streamable HTTP implementation. No sessions,
// background work, network requests, file writes, model calls or song repair.
export const SERVICE_VERSION = '0.2.0';
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
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
export const MCP_TOOLS = [
  {
    name: 'mml_service_info', title: 'MML 工具服務資訊',
    description: '查看服務版本、能力、限制與驗證範圍。不讀取對話歷史或網站中的歌曲。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: mcpAnnotations,
  },
  {
    name: 'mml_validate', title: '六軌 MML 技術檢查',
    description: '以工作台相同核心檢查六軌、每軌 2400 字、語法、精確拍長、Tempo Map、小節與全部 15 對重疊。只回報，不改寫。technical_ok 不代表原曲相似、已聽驗、播放器回讀或遊戲驗收通過。',
    inputSchema: { type: 'object', properties: { ...mcpSongProperties, error_offset: mcpPageProperty }, required: ['mml', 'meter_text'], additionalProperties: false },
    annotations: mcpAnnotations,
  },
  {
    name: 'mml_overlap_details', title: 'MML 重疊區間明細',
    description: '對技術檢查通過的同一份六軌 MML，分頁回傳持續同音及低中音小二度／大七度區間；全部 15 對摘要保留。這些是需審核的提醒，不是刪音指令。',
    inputSchema: { type: 'object', properties: { ...mcpSongProperties, offset: mcpPageProperty, limit: { type: 'integer', minimum: 1, maximum: 200 }, kind: { type: 'string', enum: ['all', 'same_pitch', 'low_mid_intervals'] } }, required: ['mml', 'meter_text'], additionalProperties: false },
    annotations: mcpAnnotations,
  },
];

function mcpReply(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
function mcpRpcError(id, code, message, status = 200) {
  return mcpReply({ jsonrpc: '2.0', id, error: { code, message } }, status);
}
function mcpCheckSchema(schema, value, path = 'arguments') {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${path} must be an object`);
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
  } else throw Error('Unsupported schema');
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
function mcpGates(ok) {
  return {
    strict_mobile_technical: ok ? 'PASS' : 'FAIL',
    original_source_identity: 'PENDING', original_audio_listening: 'PENDING',
    player_readback: 'NOT_RUN', in_game_acceptance: 'PENDING',
  };
}
function mcpPairSummary(review) {
  return review?.pairs.map(p => ({ left: p.left, right: p.right, status: p.status, overlap_count: p.overlaps.length })) ?? [];
}
function mcpReport(validation, offset = 0) {
  const song = validation.song;
  return {
    service_version: SERVICE_VERSION, core_version: VERSION, profile: PROFILE,
    technical_ok: validation.ok, gates: mcpGates(validation.ok),
    error_count: validation.errors.length,
    errors: validation.errors.slice(offset, offset + 200), error_offset: offset,
    next_error_offset: offset + 200 < validation.errors.length ? offset + 200 : null,
    warnings: validation.warnings,
    tracks: song?.tracks.map(t => ({ role: t.role, empty: t.empty, characters: t.characters, character_limit: 2400, total_beats: t.total, note_events: t.events.length, error_count: t.errors.length })) ?? [],
    total_beats: song?.total ?? null,
    estimated_seconds: validation.ok ? secondsAt(song.total, song.tempo) : null,
    tempo_map: song?.tempo ?? [], meter_map: song?.meter ?? [], bar_count: song?.bars.length ?? 0,
    pair_count: song?.review?.pairs.length ?? 0, pairs: mcpPairSummary(song?.review),
    low_mid_interval_count: song?.review?.crowding.length ?? null,
    max_simultaneous_attacks: song?.review?.maxSimultaneousAttacks ?? null,
    changed_input: false,
    evidence_notice: '技術 PASS 只針對本 Strict Mobile profile。來源、鼓面證據、聽驗、播放器回讀及遊戲結果未由此服務確認。',
  };
}
function mcpRunTool(name, args) {
  if (name === 'mml_service_info') return {
    name: 'MML Workbench Tools', service_version: SERVICE_VERSION, core_version: VERSION, profile: PROFILE,
    transport: 'stateless-streamable-http', protocol_versions: MCP_VERSIONS,
    roles: ROLES, per_track_character_limit: 2400,
    tools: MCP_TOOLS.map(t => t.name),
    privacy: '僅處理本次工具呼叫傳入的 MML。服務程式不保存或記錄歌曲、不讀取歷史對話、不呼叫外部服務；平台自身的資料政策仍適用。',
    limits: '沒有伺服器端音訊播放、MIDI／ABC 轉檔、曲譜自動修復或實機驗收。網站原有試聽與匯出仍在瀏覽器執行。',
  };
  mcpPreflight(args);
  const result = validateMML(args.mml, { meterText: args.meter_text, pickup: args.pickup, finalPartial: args.final_partial, drumText: args.drum_profile, programs: args.programs, title: args.title });
  if (name === 'mml_validate' || !result.ok) return mcpReport(result, args.error_offset ?? 0);
  const review = result.song.review;
  const items = [];
  if (args.kind !== 'low_mid_intervals') for (const pair of review.pairs) for (const overlap of pair.overlaps) items.push({ category: 'same_pitch', left: pair.left, right: pair.right, ...overlap });
  if (args.kind !== 'same_pitch') for (const overlap of review.crowding) items.push({ category: 'low_mid_intervals', ...overlap });
  const offset = args.offset ?? 0, limit = args.limit ?? 100;
  return { service_version: SERVICE_VERSION, core_version: VERSION, profile: PROFILE, technical_ok: true, gates: mcpGates(true), pair_count: 15, pairs: mcpPairSummary(review), total_items: items.length, offset, limit, items: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null, changed_input: false };
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

export async function handleMcp(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && origin !== 'https://chatgpt.com') return mcpRpcError(null, -32000, 'Origin not allowed', 403);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return mcpRpcError(null, -32600, 'Content-Type must be application/json', 415);
  const accept = (request.headers.get('accept') ?? '').split(',').map(s => s.trim().split(';')[0]);
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return mcpRpcError(null, -32600, 'Accept must include application/json and text/event-stream', 406);
  const protocol = request.headers.get('mcp-protocol-version');
  if (protocol && !MCP_VERSIONS.includes(protocol)) return mcpRpcError(null, -32600, 'Unsupported MCP protocol version', 400);
  let message;
  try { message = JSON.parse(await mcpReadBody(request)); }
  catch (error) { return mcpRpcError(null, error.message === 'BODY_TOO_LARGE' ? -32600 : -32700, error.message === 'BODY_TOO_LARGE' ? 'Request body too large' : 'Invalid JSON', error.message === 'BODY_TOO_LARGE' ? 413 : 400); }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return mcpRpcError(null, -32600, 'Invalid JSON-RPC request', 400);
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) return mcpRpcError(null, -32600, 'Invalid request id', 400);
  if (!hasId) {
    // Notifications must never invoke tools. Stateless initialized/cancelled
    // notifications are accepted without producing a JSON-RPC response.
    if (!['notifications/initialized', 'notifications/cancelled'].includes(message.method)) return mcpRpcError(null, -32600, 'Unsupported notification', 400);
    return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
  }
  const id = message.id, params = message.params;
  let result;
  if (message.method === 'initialize') {
    if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) return mcpRpcError(id, -32602, 'Invalid initialize parameters');
    result = { protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mml-workbench-tools', version: SERVICE_VERSION }, instructions: 'Only technical MML checks. Pass MML and source-confirmed meter explicitly. Never interpret technical_ok as listening, source, player, or game acceptance. Tools do not rewrite songs or access conversation history.' };
  } else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') {
    if (params?.cursor !== undefined) return mcpRpcError(id, -32602, 'This tool list is not paginated');
    result = { tools: MCP_TOOLS };
  } else if (message.method === 'tools/call') {
    const tool = MCP_TOOLS.find(t => t.name === params?.name);
    if (!tool) return mcpRpcError(id, -32602, 'Unknown tool');
    const args = params.arguments ?? {};
    try { mcpCheckSchema(tool.inputSchema, args); }
    catch (error) { return mcpRpcError(id, -32602, error.message); }
    try {
      const data = mcpRunTool(tool.name, args), serialized = JSON.stringify(data);
      if (mcpTextEncoder.encode(serialized).byteLength > 524288) throw Error('回應超過安全大小限制，請縮小输入或明細範圍。');
      result = { content: [{ type: 'text', text: serialized }], structuredContent: data, isError: false };
    } catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
  } else return mcpRpcError(id, -32601, 'Method not found');
  return mcpReply({ jsonrpc: '2.0', id, result });
}
