// `studio_listen`: hear a delivered Final (or any six-role MML) inside the
// conversation, and jump straight to the places that still need a human ear.
//
// Read-only. One Application Service read (`getArtifact`, plus the project
// title when there is one) and pure computation: the tool writes nothing, calls
// no other tool, and the player it links writes nothing either. What comes
// back is a listening view -- the MML, meter, tempo, the markers a person
// should listen to, the song-level items no position can be given for -- and,
// when the deployment names its Studio Web origin, a listen link. For a Final
// the markers are read from what it files (server/listen/final-markers.mjs):
// its provisional release renderings, the unverified Lead notes its ledger
// names, and any ledger entry that states a position.
//
// Two ways a host can show it, one tool, one answer:
//
//   * MCP Apps (`io.modelcontextprotocol/ui`, spec 2026-01-26): the tool's
//     `_meta.ui.resourceUri` names a `ui://` resource served with
//     `text/html;profile=mcp-app`; the view talks to the host over the
//     `ui/*` JSON-RPC postMessage bridge.
//   * The older Apps SDK template shape: `_meta["openai/outputTemplate"]`
//     naming a `text/html+skybridge` resource read through `window.openai`.
//     Hosts that implement MCP Apps read the first; the second is kept only as
//     a compatibility alias, isolated in HOST_UI_ADAPTERS so it can be
//     dropped by deleting one entry.
//
// Both resources are the same self-contained HTML (server/listen/widget.mjs):
// no network fetch unless the deployment configures a sample library, whose
// origin is then the only one declared in the resource CSP.
//
// Every host also gets a plain-text `content` summary with the listen link, so
// a host without UI support still has something a person can act on.
//
// The listen link is the Studio Web's own contract, `mml-studio/listen-link@1`
// (studio/web/listen-link.mjs, golden vectors in
// studio/tests/fixtures/listen-link-vectors.json). There is one implementation
// of it: this service and the player page both encode through that module, and
// the Studio Web decodes through it. Only the deployment's origin and the Node
// deflate-raw codec live here.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { ERROR_CODES, fail } from '../studio/backend/application/contracts.mjs';
import { F } from '../dist/core.js';
import { sha256Hex } from '../studio/backend/source/sha256.mjs';
import {
  LISTEN_ROLES, parseListenMml, listenTempoMap, listenSecondsAt, listenBars, listenBarAt, listenBeatNumber,
} from './listen/mml-events.mjs';
import { LISTEN_LIMITS, LISTEN_LINK_SCHEMA, ListenLinkError, encodeListenLink, listenUrl } from '../studio/web/listen-link.mjs';
import { buildListenWidgetHtml, parseSampleLibrary } from './listen/widget.mjs';
import { beatOf, clip, finalListeningMarkers, flagLabel } from './listen/final-markers.mjs';

export const LISTEN_TOOL_NAME = 'studio_listen';
export const LISTEN_VIEW_SCHEMA = 'mml-studio/listen-view@1';
export const PLAYER_RESOURCE_URI = 'ui://mml-studio/player.html';
export const PLAYER_LEGACY_RESOURCE_URI = 'ui://mml-studio/player-skybridge.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const LEGACY_WIDGET_MIME_TYPE = 'text/html+skybridge';
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

const MAX_MARKERS = LISTEN_LIMITS.markers;
const MAX_SONG_NOTES = 60;
const MAX_LABEL = LISTEN_LIMITS.labelChars;
const PREVIEW_NOTICE = '播放器使用內建預覽合成器（或你自己在瀏覽器載入的音色庫），不是遊戲內音色；聽起來的樣子不代表實機。';
const FEEDBACK_NOTICE = '播放器送回對話的只是試聽回饋文字，給 AI 修改參考；它不是任何 Gate 的確認、證據或接受，播放器與本工具都不寫入任何紀錄。';
const PARSE_NOTICE = '這是試聽用的讀取（與 Studio ingest 解析同一套時值），不是技術檢查結論；技術檢查請用 mml_validate。';

// ─── the listen link ────────────────────────────────────────────────────────

/**
 * Node's deflate-raw for the shared contract: zlib with its default options,
 * which is what the golden vectors were written with, so a link this service
 * encodes is byte-for-byte the vector's payload. Inflation stops at the
 * contract's cap, which decodeListenLink checks again.
 */
export const NODE_LISTEN_CODEC = Object.freeze({
  deflateRaw: bytes => new Uint8Array(deflateRawSync(bytes)),
  inflateRaw: (bytes, maxBytes) => {
    try { return new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxBytes })); }
    catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', `decoded JSON exceeds ${maxBytes} bytes`);
      throw error;
    }
  },
});

/** The `#listen=` payload for a listen-link@1 document (validated and normalised by the contract). */
export function encodeListenPayload(document) {
  return encodeListenLink(document, NODE_LISTEN_CODEC);
}

/**
 * The deployment's Studio Web origin, or null. HTTPS only, a bare origin (a
 * trailing slash is tolerated), no credentials, path, query or fragment.
 * An invalid value is reported, never repaired into a different origin.
 */
export function parseStudioWebOrigin(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { origin: null, status: 'ORIGIN_NOT_CONFIGURED' };
  const text = String(value).trim();
  let url;
  try { url = new URL(text); } catch { return { origin: null, status: 'ORIGIN_INVALID' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return { origin: null, status: 'ORIGIN_INVALID' };
  if (text.replace(/\/$/, '') !== url.origin) return { origin: null, status: 'ORIGIN_INVALID' };
  return { origin: url.origin, status: 'OK' };
}

/** `<origin>/#listen=<payload>` for an origin parseStudioWebOrigin accepted. */
export async function listenLinkUrl(origin, document) {
  const parsed = parseStudioWebOrigin(origin);
  if (!parsed.origin) throw new ListenLinkError(parsed.status, 'a valid https Studio Web origin is required');
  return listenUrl(`${parsed.origin}/`, await encodeListenPayload(document));
}

// ─── configuration ──────────────────────────────────────────────────────────

/**
 * Deployment configuration, read once. `STUDIO_WEB_ORIGIN` is the Studio Web
 * the listen link opens (https origin only). `STUDIO_LISTEN_SAMPLES_URL` and
 * `STUDIO_LISTEN_SAMPLES_CREDIT` optionally name an https sample library the
 * player may fetch from; unset, the player never touches the network.
 */
export function createListenConfig({ studioWebOrigin = null, samplesUrl = null, samplesCredit = null } = {}) {
  const origin = parseStudioWebOrigin(studioWebOrigin);
  const samples = parseSampleLibrary(samplesUrl, samplesCredit);
  let html = null;
  return Object.freeze({
    studioWebOrigin: origin.origin,
    studioWebOriginStatus: origin.status,
    samples,
    widgetHtml() {
      html ??= buildListenWidgetHtml({ samples });
      return html;
    },
  });
}

export function listenConfigFromEnv(env = process.env) {
  return createListenConfig({
    studioWebOrigin: env.STUDIO_WEB_ORIGIN ?? null,
    samplesUrl: env.STUDIO_LISTEN_SAMPLES_URL ?? null,
    samplesCredit: env.STUDIO_LISTEN_SAMPLES_CREDIT ?? null,
  });
}

export const DEFAULT_LISTEN_CONFIG = createListenConfig();

// ─── host UI adapters ───────────────────────────────────────────────────────

const connectDomains = config => (config.samples ? [config.samples.origin] : []);

// One entry per host UI shape. The tool `_meta` is the union of every entry's
// tool keys; each entry serves its own resource. Hosts ignore keys they do not
// read, and a host that renders nothing still gets the text summary.
const HOST_UI_ADAPTERS = Object.freeze([
  Object.freeze({
    name: 'mcp-apps',
    uri: PLAYER_RESOURCE_URI,
    mimeType: MCP_APP_MIME_TYPE,
    toolMeta: () => ({ ui: { resourceUri: PLAYER_RESOURCE_URI, visibility: ['model', 'app'] } }),
    resourceMeta: config => ({
      ui: {
        prefersBorder: true,
        permissions: { clipboardWrite: {} },
        ...(config.samples ? { csp: { connectDomains: connectDomains(config), resourceDomains: [] } } : {}),
      },
    }),
  }),
  Object.freeze({
    name: 'apps-sdk-template-alias',
    uri: PLAYER_LEGACY_RESOURCE_URI,
    mimeType: LEGACY_WIDGET_MIME_TYPE,
    toolMeta: () => ({
      'openai/outputTemplate': PLAYER_LEGACY_RESOURCE_URI,
      'openai/toolInvocation/invoking': '準備試聽播放器…',
      'openai/toolInvocation/invoked': '試聽播放器已就緒',
      'openai/widgetAccessible': false,
    }),
    resourceMeta: config => ({
      'openai/widgetDescription': '六軌 MML 試聽播放器：播放、從小節或標記處開始聽、標記問題並送回對話。',
      'openai/widgetPrefersBorder': true,
      'openai/widgetCSP': { connect_domains: connectDomains(config), resource_domains: [] },
    }),
  }),
]);

const toolMeta = () => Object.assign({}, ...HOST_UI_ADAPTERS.map(adapter => adapter.toolMeta()));

export function listenResources(config = DEFAULT_LISTEN_CONFIG) {
  return HOST_UI_ADAPTERS.map(adapter => ({
    uri: adapter.uri,
    name: adapter.name === 'mcp-apps' ? 'mml_studio_player' : 'mml_studio_player_template',
    title: 'MML 六軌試聽播放器',
    description: 'studio_listen 的互動播放器（預覽合成器，不是遊戲內音色）。',
    mimeType: adapter.mimeType,
    _meta: adapter.resourceMeta(config),
  }));
}

/** `resources/read` contents for a player URI, or null for any other URI. */
export function readListenResource(uri, config = DEFAULT_LISTEN_CONFIG) {
  const adapter = HOST_UI_ADAPTERS.find(entry => entry.uri === uri);
  if (!adapter) return null;
  return { contents: [{ uri: adapter.uri, mimeType: adapter.mimeType, text: config.widgetHtml(), _meta: adapter.resourceMeta(config) }] };
}

// ─── the tool ───────────────────────────────────────────────────────────────

const beatString = { type: 'string', minLength: 1, maxLength: 24, description: '從曲首起算的四分音符拍，整數或分數字串，例如 "88" 或 "177/2"。' };

export const LISTEN_MCP_TOOLS = [
  {
    name: LISTEN_TOOL_NAME,
    title: '在對話中試聽 MML',
    description: '唯讀。回傳可在對話裡直接播放的六軌試聽播放器（支援互動 UI 的主機會顯示播放器；其他主機收到文字摘要與 Studio Web 試聽連結）。'
      + '給 artifact_id（已交付的 Final，可附 project_id 限定）時，Final 暫定延長的每個 release（provisional-release）與 ledger 中未驗證的 Lead 音（lead-unverified）會成為播放器標記，數量多時依角色合併成區段、總數列在整曲待確認；沒有位置的 ledger 項目與交付旗標也列在整曲待確認；'
      + '或給 mml（完整六軌 MML@…;）與來源確認的 meter_text（沒有拍號圖時只能用拍與時間定位，不會自行假設 4/4）。'
      + 'markers 可標出你剛修改（changed）或想請使用者注意（note）的位置；start_bar 讓播放器與連結從該小節開始。'
      + '播放器是預覽合成器，不是遊戲內音色。使用者在播放器按「送出給 AI」時，回饋會以使用者訊息出現在對話裡：那只是試聽感受文字，不是 Gate 確認、證據或接受，請依內容修改 MML 後再呼叫本工具讓使用者重聽。本工具不寫入任何資料。',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', minLength: 68, maxLength: 68, description: '已交付 Final 的 artifact_id（art_ 開頭）。與 mml 二擇一。' },
        project_id: { type: 'string', minLength: 36, maxLength: 36, description: '選填：artifact 所屬專案（prj_ 開頭），不符時視為找不到。只能與 artifact_id 一起使用。' },
        mml: { type: 'string', minLength: 1, maxLength: LISTEN_LIMITS.mmlChars, description: '完整六軌 MML@...,...,...,...,...,...; 原文。與 artifact_id 二擇一。' },
        meter_text: { type: 'string', minLength: 1, maxLength: LISTEN_LIMITS.meterChars, description: '只用於 mml：來源確認的拍號圖，每行「起拍 拍號」。省略時播放器以拍與時間定位。' },
        compare_mml: { type: 'string', minLength: 1, maxLength: LISTEN_LIMITS.mmlChars, description: '選填：對照版本（例如修改前），播放器可 A／B 切換。' },
        title: { type: 'string', minLength: 1, maxLength: LISTEN_LIMITS.titleChars },
        start_bar: { type: 'integer', minimum: 1, maximum: 10000, description: '選填：播放器游標與試聽連結的起始小節（需要拍號圖）。' },
        markers: {
          type: 'array', minItems: 1, maxItems: 100,
          description: '選填：要使用者特別聽的位置。每筆需 bar 或 beat 其一。',
          items: {
            type: 'object',
            properties: {
              bar: { type: 'integer', minimum: 1, maximum: 10000 },
              beat: beatString,
              end_beat: beatString,
              role: { type: 'string', enum: [...LISTEN_ROLES] },
              kind: { type: 'string', enum: ['changed', 'note'] },
              label: { type: 'string', minLength: 1, maxLength: MAX_LABEL },
            },
            required: ['kind', 'label'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: toolMeta(),
  },
];

const invalid = (message, reason) => fail(ERROR_CODES.INVALID_REQUEST, message, { reason });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// A bar start as an exact rational. Bar starts are sums of meter lengths, so a
// small search over dyadic and triadic denominators recovers them exactly.
function beatStringOfNumber(value) {
  for (const denominator of [1, 2, 4, 8, 16, 32, 64, 128, 3, 6, 12, 24, 48, 96, 192, 384, 768, 1536]) {
    const scaled = value * denominator;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-7) return new F(Math.round(scaled), denominator).toString();
  }
  return beatOf(Number(value.toFixed(9)));
}

function checkInlineMml(mml, field) {
  // The same guard mml_validate applies before rational arithmetic.
  if (/\d{4}/.test(mml)) invalid(`${field} 數值超過本服務的三位數安全界限；Strict Mobile 指令不需要四位數數值。`, 'LISTEN_NUMERIC_BOUND');
  const parsed = parseListenMml(mml);
  if (!parsed.tracks.length) invalid(`${field}：${parsed.error}`, 'LISTEN_MML_INVALID');
  if (!parsed.ok) invalid(`${field}：${parsed.error}`, 'LISTEN_MML_EMPTY');
  return parsed;
}

const formatTime = seconds => {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
};

/**
 * Run `studio_listen`. Returns the listening view (structuredContent) and the
 * text summary a host without UI shows. Throws StudioApplicationError.
 */
export async function runListenTool(args, { application, owner, listen = DEFAULT_LISTEN_CONFIG }) {
  // Reads only: getArtifact, getProject (title) and, to place unverified Lead
  // ids, listBaselineEvents.
  const fromArtifact = args.artifact_id !== undefined;
  if (fromArtifact === (args.mml !== undefined)) invalid('Pass exactly one of artifact_id (a delivered Final) or mml.', 'LISTEN_SOURCE_REQUIRED');
  if (!fromArtifact && args.project_id !== undefined) invalid('project_id only scopes an artifact_id.', 'LISTEN_PROJECT_WITHOUT_ARTIFACT');
  if (fromArtifact && args.meter_text !== undefined) invalid('A delivered Final carries its own meter map; meter_text applies to inline mml only.', 'LISTEN_METER_NOT_ALLOWED');

  let source;
  let mml;
  let meterText = null;
  let pickup = null;
  let title = args.title ?? null;
  let canonical = null;
  let artifact = null;

  if (fromArtifact) {
    if (!application) invalid('Stored Finals need the Studio service.', 'LISTEN_STUDIO_UNAVAILABLE');
    const read = await application.getArtifact(owner, args.artifact_id);
    artifact = read.artifact;
    canonical = read.canonical ?? null;
    // A project that does not own the artifact cannot see it, exactly as an
    // unknown id.
    if (args.project_id !== undefined && artifact.project_id !== args.project_id) {
      fail(ERROR_CODES.ARTIFACT_NOT_FOUND, 'Unknown artifact', { artifact_id: args.artifact_id });
    }
    if (artifact.type !== 'final_mml' || typeof artifact.mml !== 'string' || !artifact.mml) invalid('This artifact is not a delivered Final MML.', 'LISTEN_ARTIFACT_NOT_FINAL');
    mml = artifact.mml;
    meterText = typeof artifact.final_bar?.meter_text === 'string' && artifact.final_bar.meter_text.trim() ? artifact.final_bar.meter_text : null;
    pickup = beatOf(artifact.final_bar?.pickup ?? null);
    source = {
      kind: 'final_artifact',
      project_id: artifact.project_id,
      artifact_id: artifact.artifact_id ?? args.artifact_id,
      candidate_id: artifact.candidate_id ?? null,
      song_state: artifact.song_state ?? null,
      lifecycle: artifact.machine_delivery?.lifecycle ?? null,
      machine_delivery_schema: typeof artifact.machine_delivery?.schema === 'string' ? artifact.machine_delivery.schema : null,
    };
    if (title === null && application.getProject) {
      try { title = (await application.getProject(owner, artifact.project_id))?.project?.title ?? null; } catch { title = null; }
    }
  } else {
    mml = args.mml;
    meterText = args.meter_text ?? null;
    source = { kind: 'inline' };
  }
  title = clip(title ?? (fromArtifact ? 'Final' : '未命名'), LISTEN_LIMITS.titleChars) || '未命名';

  const parsed = checkInlineMml(mml, 'mml');
  const compare = args.compare_mml === undefined ? null : checkInlineMml(args.compare_mml, 'compare_mml');
  const tempo = listenTempoMap(parsed.tempo);
  const totalBeats = listenBeatNumber(parsed.total);
  const duration = listenSecondsAt(tempo, totalBeats);
  const bars = listenBars(meterText, totalBeats, { pickup });
  const meterUsable = Array.isArray(bars) && bars.length > 0;

  // What the Final itself files about where it still needs a person's ear
  // (server/listen/final-markers.mjs). The baseline projection is read only to
  // place ledger event ids, and every placement is checked against the
  // delivered MML's own Melody.
  const lookupBaselineEvents = artifact && typeof application?.listBaselineEvents === 'function'
    ? async eventIds => {
      const events = [];
      for (let index = 0; index < eventIds.length; index += 500) {
        const page = await application.listBaselineEvents(owner, artifact.project_id, { eventIds: eventIds.slice(index, index + 500), limit: 500 });
        events.push(...(Array.isArray(page?.events) ? page.events : []));
      }
      return events;
    }
    : null;
  const fromFinal = artifact
    ? await finalListeningMarkers(artifact, { parsedTracks: parsed.tracks, totalBeats, lookupBaselineEvents })
    : { markers: [], notes: [], delivery_flags: [], provisional_releases: null, unverified_lead: null };

  const barStart = bar => {
    if (!meterUsable) invalid('A bar position needs a meter map (meter_text); use beat instead.', 'LISTEN_BAR_WITHOUT_METER');
    if (bar > bars.length) invalid(`Bar ${bar} is beyond the last bar (${bars.length}).`, 'LISTEN_BAR_OUT_OF_RANGE');
    return beatStringOfNumber(bars[bar - 1].start);
  };

  const callerMarkers = (args.markers ?? []).map(marker => {
    if ((marker.bar === undefined) === (marker.beat === undefined)) invalid('Each marker needs exactly one of bar or beat.', 'LISTEN_MARKER_POSITION');
    const beat = marker.beat === undefined ? barStart(marker.bar) : beatOf(marker.beat);
    if (beat === null) invalid('marker.beat must be a non-negative integer, decimal or n/d beat.', 'LISTEN_MARKER_POSITION');
    const end = marker.end_beat === undefined ? null : beatOf(marker.end_beat);
    if (marker.end_beat !== undefined && (end === null || listenBeatNumber(end) < listenBeatNumber(beat))) invalid('marker.end_beat must not precede its beat.', 'LISTEN_MARKER_POSITION');
    return { beat, end_beat: end, role: marker.role ?? null, kind: marker.kind, gate: null, source: 'caller', count: 1, label: clip(marker.label) };
  });

  // Positions from a record with only a bar resolve through the meter map; a
  // position no meter can place stays a song-level note rather than a guess.
  const songNotes = [...fromFinal.notes];
  const placed = [];
  for (const marker of [...fromFinal.markers, ...callerMarkers]) {
    let beat = marker.beat;
    if (beat === null && marker.bar !== null && marker.bar !== undefined && meterUsable && marker.bar <= bars.length) beat = beatStringOfNumber(bars[marker.bar - 1].start);
    if (beat === null || listenBeatNumber(beat) > totalBeats) {
      if (songNotes.length < MAX_SONG_NOTES) songNotes.push({ gate: marker.gate, classification: null, status: null, blockers: [], label: marker.label });
      continue;
    }
    placed.push({ ...marker, beat });
  }
  placed.sort((a, b) => listenBeatNumber(a.beat) - listenBeatNumber(b.beat));
  const truncatedMarkers = Math.max(0, placed.length - MAX_MARKERS);
  const markers = placed.slice(0, MAX_MARKERS).map((marker, index) => {
    const beat = listenBeatNumber(marker.beat);
    const bar = meterUsable ? listenBarAt(bars, beat) : null;
    const endBeat = marker.end_beat !== null && listenBeatNumber(marker.end_beat) >= beat ? marker.end_beat : null;
    return {
      id: `m${index + 1}`,
      kind: marker.kind,
      beat: marker.beat,
      ...(endBeat ? { end_beat: endBeat } : {}),
      bar: bar ? bar.index : null,
      seconds: Math.round(listenSecondsAt(tempo, beat) * 1000) / 1000,
      role: marker.role ?? null,
      label: marker.label,
      gate: marker.gate ?? null,
      source: marker.source,
      count: Number.isSafeInteger(marker.count) && marker.count > 0 ? marker.count : 1,
    };
  });

  let start = null;
  if (args.start_bar !== undefined) {
    barStart(args.start_bar);
    start = { bar: args.start_bar };
  }

  const mmlSha = sha256Hex(new TextEncoder().encode(mml));
  const compareSha = compare ? sha256Hex(new TextEncoder().encode(args.compare_mml)) : null;

  let listenLink = null;
  let linkStatus = listen.studioWebOriginStatus;
  if (listen.studioWebOrigin) {
    const payload = {
      schema: LISTEN_LINK_SCHEMA,
      mml,
      title,
      ...(meterText ? { meter_text: meterText } : {}),
      ...(start ? { start } : {}),
      ...(markers.length ? {
        markers: markers.map(marker => ({
          beat: marker.beat, ...(marker.end_beat ? { end_beat: marker.end_beat } : {}),
          ...(marker.role ? { role: marker.role } : {}), kind: marker.kind, label: marker.label,
        })),
      } : {}),
      ...(compare ? { compare_mml: args.compare_mml } : {}),
      ...(source.kind === 'final_artifact' ? { source: { project_id: source.project_id, artifact_id: source.artifact_id } } : {}),
    };
    try {
      const url = await listenLinkUrl(listen.studioWebOrigin, payload);
      listenLink = { url, origin: listen.studioWebOrigin, characters: url.length };
      linkStatus = 'OK';
    } catch (error) {
      // The contract refused the document: the view is still complete, only
      // without a link, and the reason is stated rather than repaired.
      if (!(error instanceof ListenLinkError)) throw error;
      linkStatus = error.code === 'LISTEN_LINK_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'PAYLOAD_INVALID';
    }
  }

  const view = {
    schema: LISTEN_VIEW_SCHEMA,
    title,
    source,
    roles: [...LISTEN_ROLES],
    mml,
    mml_sha256: mmlSha,
    ...(compare ? { compare_mml: args.compare_mml, compare_mml_sha256: compareSha } : {}),
    meter_text: meterText,
    pickup,
    tempo: parsed.tempo,
    total_beats: parsed.total,
    duration_seconds: Math.round(duration * 1000) / 1000,
    bar_count: meterUsable ? bars.length : null,
    start,
    markers,
    truncated_markers: truncatedMarkers,
    song_notes: songNotes,
    delivery_flags: fromFinal.delivery_flags,
    provisional_releases: fromFinal.provisional_releases,
    unverified_lead: fromFinal.unverified_lead,
    parse: {
      finding_count: parsed.findings.length,
      findings: parsed.findings.slice(0, 10),
      notice: PARSE_NOTICE,
    },
    listen_link: listenLink,
    listen_link_status: linkStatus,
    preview_notice: PREVIEW_NOTICE,
    feedback_notice: FEEDBACK_NOTICE,
    ...(canonical ? { canonical } : {}),
  };
  return { structuredContent: view, text: summaryText(view) };
}

const LINK_STATUS_TEXT = Object.freeze({
  ORIGIN_NOT_CONFIGURED: '（這個部署沒有設定 STUDIO_WEB_ORIGIN，所以沒有 Studio Web 試聽連結。）',
  ORIGIN_INVALID: '（STUDIO_WEB_ORIGIN 不是有效的 https origin，所以沒有 Studio Web 試聽連結。）',
  PAYLOAD_TOO_LARGE: '（內容超過試聽連結的 256 KB 上限，所以沒有 Studio Web 試聽連結。）',
  PAYLOAD_INVALID: '（這份內容無法編成試聽連結。）',
});

function summaryText(view) {
  const lines = [];
  const where = view.source.kind === 'final_artifact' ? `Final ${view.source.artifact_id}（${view.source.project_id}）` : '內嵌 MML';
  lines.push(`試聽：${view.title}｜${where}｜MML sha256 ${view.mml_sha256.slice(0, 12)}`);
  const bpm = view.tempo.length ? view.tempo.map(entry => `T${entry.bpm}@${entry.beat}`).slice(0, 4).join(' ') : '未設定 T（以 T120 預覽）';
  lines.push(`長度 ${formatTime(view.duration_seconds)}｜${view.bar_count ? `${view.bar_count} 小節` : '沒有拍號圖（以拍與時間定位）'}｜${bpm}`);
  if (view.parse.finding_count) lines.push(`試聽讀取有 ${view.parse.finding_count} 則提醒（不是技術檢查結論）。`);
  if (view.markers.length) {
    lines.push(`請特別聽 ${view.markers.length} 處：`);
    for (const marker of view.markers.slice(0, 20)) {
      const place = marker.bar ? `第${marker.bar}小節` : `beat ${marker.beat}`;
      lines.push(`- ${place}（${formatTime(marker.seconds)}）${marker.role ? ` ${marker.role}` : ''} [${marker.kind}] ${marker.label}`);
    }
    if (view.markers.length > 20) lines.push(`- …另外 ${view.markers.length - 20} 處在播放器裡。`);
  }
  if (view.delivery_flags.length) lines.push(`交付旗標：${view.delivery_flags.map(flag => `${flag}（${flagLabel(flag)}）`).join('、')}。旗標是仍未解決的標籤，不是結論。`);
  if (view.song_notes.length) lines.push(`整曲待確認：${view.song_notes.map(note => note.label).slice(0, 8).join('；')}`);
  lines.push(view.listen_link ? `Studio Web 試聽連結：${view.listen_link.url}` : (LINK_STATUS_TEXT[view.listen_link_status] ?? '（沒有 Studio Web 試聽連結。）'));
  lines.push(PREVIEW_NOTICE);
  lines.push(FEEDBACK_NOTICE);
  return lines.join('\n');
}
