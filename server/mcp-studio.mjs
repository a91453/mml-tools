// The `studio_*` MCP control surface.
//
// Status: IMPLEMENTATION NOTES. Twelve high-level tools over the Studio
// Application Service. Deliberately not one tool per backend function: a model
// should reason about a project, its sources, a suggestion, a decision set, a
// review and a Final artifact — not about `midi-file.mjs`, `role-candidates.mjs`,
// `readiness.mjs`, `technical-timing-repair.mjs` or `mml-emitter.mjs`. Those
// names never cross this boundary, and neither does any workflow of this
// module's own: every tool below is one Application Service call.
//
// The same tools serve ChatGPT, Claude, Codex, a future model and a local
// agent. There is no provider branch here, no provider-specific state model and
// no provider-specific description, because the answer to "what does this song
// need next" must not depend on who asked.
//
// No tool carries bytes. Every input is an identity, a small structured option
// or short text, and an agent that needs a recording, a MIDI file or a score in
// a project is told to upload it over the HTTP asset endpoint and pass the
// `asset_id` back. That is what keeps a 30 MB file out of a model's context and
// out of this process's memory.

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const projectId = { type: 'string', minLength: 36, maxLength: 36, description: '本服務發出的 project_id（prj_ 開頭）。不可傳檔案路徑、暫存檔名或瀏覽器網址。' };
const candidateId = { type: 'string', minLength: 10, maxLength: 128, description: '既有 G11-D revision id（g11d:rev: 開頭），由 studio_decisions_apply 產生。' };

// A structured payload whose vocabulary belongs to the Application Service.
//
// As JSON Schema this is an ordinary object with unconstrained properties, so
// `tools/list` advertises something every MCP host can read. It is deliberately
// NOT a detailed schema: restating the decision, confirmation or alignment
// vocabulary here would create a second contract to keep in step with the
// module that owns it, and the two would drift.
//
// The transport still checks the value internally — plain JSON only, bounded
// depth and width, no prototype-polluting keys — and the whole request body is
// capped at MAX_BODY_BYTES, so this is not a way to smuggle bulk data in.
const structuredPayload = description => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) });

export const STUDIO_MCP_TOOLS = [
  {
    name: 'studio_capabilities',
    title: 'Studio 能力與 Canonical 狀態',
    description: '回報本服務實際支援的能力、Published Canonical 載入狀態與五個獨立 provenance 身分、資產耐久性與工作執行模型。audio_to_midi、source_separation、in_game_test 為 false 代表本服務不做這些事。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: 'studio_project_create',
    title: '建立 Studio 專案',
    description: '建立一個空專案並回傳 project_id。素材需另經 HTTP 上傳端點加入，本工具不接收任何檔案內容。',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 120 } },
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_project_get',
    title: '讀取專案狀態',
    description: '給 project_id 時回傳該專案的資產、Source-Faithful Baseline、候選、音訊證據、工作與產出清單；省略 project_id 時回傳本人所有專案的摘要清單（project_id、標題、素材與候選數、baseline_id），遺失 project_id 時由此找回。只有識別碼與統計，不含任何位元組。',
    inputSchema: { type: 'object', properties: { project_id: projectId }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: 'studio_sources_analyze',
    title: '來源匯入與 Source-Faithful Baseline',
    description: '以既有 MIDI／MusicXML／MML／Canonical IR 轉換器讀取專案的符號來源，建立可比對差異的 Source-Faithful Baseline。不刪音、不量化來源時值、不做 Mobile 調整、不指派角色、不產生 Final MML。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        asset_ids: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 36, maxLength: 36 } },
        meter_text: { type: 'string', minLength: 1, maxLength: 2048, description: '來源確認的拍號圖，MML 來源才需要。未知時先詢問，不可假定。' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_baseline_events',
    title: 'Source-Faithful Baseline 事件與來源身分',
    description: '唯讀列出 baseline 事件：event_id、role、pitch、起訖拍、source_ids 與 source_event_ids。Lead 相關決定的 leadEvidence.sourceIdentity 必須引用這裡的來源身分。可用 lane_id（來自 studio_arrangement_suggest）或 event_ids 縮小範圍，並分頁。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        lane_id: { type: 'string', minLength: 1, maxLength: 200 },
        event_ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1, maxLength: 300 } },
        offset: { type: 'integer', minimum: 0, maximum: 1000000 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_arrangement_suggest',
    title: '六角色候選建議',
    description: '在 Source-Faithful Baseline 上執行既有聲部拆解與角色候選建議。這是建議，不是接受：PENDING 仍是 PENDING，本工具不會替你決定保留、移除或搬移。',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId, refresh: { type: 'boolean' } },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_decisions_apply',
    title: '套用已接受的編排決定',
    description: '將明確接受的決定集合交給既有 G11-D 套用流程，全有或全無。acceptance 綁定由服務依現在載入的 baseline 與聲部拆解計算，呼叫端不得提供。Lead 相關決定仍需要既有 Gate 要求的證據。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        decisions: { type: 'array', minItems: 1, maxItems: 500, items: structuredPayload(), description: 'KEEP／ASSIGN_ROLE／MOVE_ROLE／OMIT_FROM_SIX／DUPLICATE_WITH_JUSTIFICATION，含 target、reason、evidence、acceptedBy。' },
        parent_candidate_id: candidateId,
        accepted_by: { type: 'string', minLength: 1, maxLength: 120 },
      },
      required: ['project_id', 'decisions'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_audio_alignment',
    title: '附加原曲音訊對位證據',
    description: '驗證並附加既有 Audio Worker 產生的對位報告。這是時間軸證據層：不代表音高真相、人聲辨識、八度正確性、Lead 刪除決定或編排優劣。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        report: structuredPayload('既有 audio worker 輸出的 alignment 報告 JSON。'),
      },
      required: ['project_id', 'candidate_id', 'report'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_candidate_review',
    title: '候選審查',
    description: '以既有 compare／Core3／harmony／Lead demotion／readiness 模組重新檢查候選，回報各自的判定、阻擋項與六個獨立 gate。指標僅供診斷，不得為了讓數字歸零而刪掉來源支持的音樂。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        confirmations: structuredPayload('source_complete／version_drift_reviewed／player_readback／original_audio_required，每項需 reason。player_readback 為 PASS、NOT_RUN 或 N/A（未使用預覽／驗證素材時，附理由）；PASS 可附 mml_sha256 綁定實際回讀的 MML。確認綁定於目前 baseline 與本候選；in_game 無法由此設定。'),
      },
      required: ['project_id', 'candidate_id'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_finalize',
    title: 'Final MML 產出',
    description: '在 readiness 通過後執行既有 Final 流程：micro-gap 判定與強制、可選的 Technical Timing Repair、Final MML 產生、回讀驗證，並產生 artifact。gate 未通過時不會產生任何 MML。產出成功不等於 IN_GAME_ACCEPTED。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        technical_timing_repair: { type: 'boolean', description: '明確 opt-in。預設 false，呼叫 finalize 不會自動開啟。' },
        confirmations: structuredPayload(),
        pickup: { type: 'string', minLength: 1, maxLength: 32, description: '來源確認的弱起拍長（整數、小數或分數拍）；沒有時省略。Final parser 不會自行推測。' },
        final_partial: { type: 'string', minLength: 1, maxLength: 32, description: '來源確認的末小節拍長；曲子未在小節線結束時必填，否則 technical gate 無法通過。不會自行推測。' },
      },
      required: ['project_id', 'candidate_id'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_job_status',
    title: '工作狀態',
    description: '以 job_id 查詢工作狀態與狀態轉換紀錄。本版本工作為同步執行，取得 job_id 時已是終態；能力查詢中的 background_execution 為 false。',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', minLength: 36, maxLength: 36 } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_artifact_get',
    title: '讀取 Final 產出',
    description: '以 artifact_id 取得 Final MML 與其 readiness 摘要、修復報告、回讀報告、警告、Canonical provenance 與尚未通過的 gate。',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string', minLength: 68, maxLength: 68 } },
      required: ['artifact_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
];

/**
 * Dispatch one `studio_*` tool to the Application Service.
 *
 * Every branch is a single call. There is no composition here, no fallback to
 * a second path, and no place a verdict could be recomputed: whatever the
 * Application Service returns is what the model sees.
 */
export async function runStudioTool(name, args, { application, owner }) {
  switch (name) {
    case 'studio_capabilities':
      return application.capabilities();
    case 'studio_project_create':
      return application.createProject(owner, { title: args.title });
    case 'studio_project_get':
      // The same read the HTTP adapter serves as GET /projects and
      // GET /projects/:id. Without an id there is nothing to look up, so the
      // owner's own list is the answer; a client that lost its project id
      // recovers it here rather than being locked out of its own project.
      return args.project_id === undefined
        ? application.listProjects(owner)
        : application.getProject(owner, args.project_id);
    case 'studio_baseline_events':
      return application.listBaselineEvents(owner, args.project_id, { laneId: args.lane_id ?? null, eventIds: args.event_ids ?? null, offset: args.offset ?? 0, limit: args.limit ?? 500 });
    case 'studio_sources_analyze':
      return application.analyzeSources(owner, args.project_id, { assetIds: args.asset_ids ?? null, meterText: args.meter_text ?? '' });
    case 'studio_arrangement_suggest':
      return application.suggestArrangement(owner, args.project_id, { refresh: args.refresh === true });
    case 'studio_decisions_apply':
      return application.applyDecisions(owner, args.project_id, {
        decisions: args.decisions,
        parentCandidateId: args.parent_candidate_id ?? null,
        acceptedBy: args.accepted_by ?? null,
      });
    case 'studio_audio_alignment':
      return application.attachAudioAlignment(owner, args.project_id, { candidateId: args.candidate_id, report: args.report });
    case 'studio_candidate_review':
      return application.reviewCandidate(owner, args.project_id, { candidateId: args.candidate_id, confirmations: args.confirmations ?? null });
    case 'studio_finalize':
      return application.finalize(owner, args.project_id, {
        candidateId: args.candidate_id,
        // Passed through exactly as supplied. Calling finalize never turns the
        // repair on by itself, and there is no automatic mode.
        technicalTimingRepair: args.technical_timing_repair ?? false,
        confirmations: args.confirmations ?? null,
        pickup: args.pickup ?? null,
        finalPartial: args.final_partial ?? null,
      });
    case 'studio_job_status':
      return application.getJob(owner, args.job_id);
    case 'studio_artifact_get':
      return application.getArtifact(owner, args.artifact_id);
    default:
      throw Error('Unknown studio tool');
  }
}

// How an agent gets bytes into a project. Returned in `studio_capabilities` and
// in the server instructions so a model never has to guess, and never tries to
// inline a file into a tool call.
export const UPLOAD_INSTRUCTION = 'Assets are uploaded over HTTP, never through MCP: POST the file to /api/v1/projects/<project_id>/assets as multipart/form-data with a `kind` field, or as a raw body with the x-mml-asset-kind header. The response carries the asset_id to use here.';
