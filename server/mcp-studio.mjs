// The `studio_*` MCP control surface.
//
// Status: IMPLEMENTATION NOTES. Fourteen high-level tools over the Studio
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

// The recordable confirmations, named here once so `studio_candidate_review`
// and `studio_finalize` cannot describe the same vocabulary differently.
//
// It says which confirmations exist, which of them require evidence when
// recorded true, and which question each one answers — because an agent that
// cannot see `core3_completeness_reviewed` here has no way to learn it exists,
// and one that believes only Gate 8 and Gate 9 need evidence will send a
// reason-only Core3 completeness review and have it refused with no idea why.
// Gate 4's two questions are named apart on purpose: the source-continuity
// audit is answered by `studio_core3_change_approve`, one change at a time, and
// the musical-completeness review is answered here, and neither is the other.
const CONFIRMATIONS_DESCRIPTION = 'source_complete／version_drift_reviewed／player_readback／mobile_adaptation_reviewed／regression_reviewed／core3_completeness_reviewed／original_audio_required，每項需 reason。'
  + 'mobile_adaptation_reviewed（Gate 8）、regression_reviewed（Gate 9）與 core3_completeness_reviewed（Gate 4 Core3 musical completeness）這三項，value=true 時另需至少一筆 evidence：只有理由字串的審查會被拒絕。'
  + 'core3_completeness_reviewed 回答的是 Gate 4 的第二個問題（evaluator 無法證明完整的 Core3 是否仍站得住），它可以解決可審查的殘留（例如來源本來就沒有的 Chord1／Chord2 功能），但永遠無法消除缺席的 Lead，也無法消除身分依賴 Chord3–Chord5 的 Core3——那兩者 gate 直接 FAIL。'
  + 'Gate 4 的第一個問題（Core3 來源連續性）不在這裡：它由 studio_core3_change_approve 逐筆核准，兩者是不同 review axis，互不代替。'
  + 'player_readback 為 PASS、NOT_RUN 或 N/A（未使用預覽／驗證素材時，附理由）；PASS 可附 mml_sha256 綁定實際回讀的 MML。'
  + 'source_complete 與 original_audio_required 綁定於 baseline，同一個 baseline 上的每個候選都持續有效；其餘五項綁定於本候選，換候選即失效並回報為 stale。'
  + 'in_game 無法由此設定。';

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
    description: '將明確接受的決定集合交給既有 G11-D 套用流程，全有或全無。acceptance 綁定由服務依現在載入的 baseline 與聲部拆解計算，呼叫端不得提供。任何 Lead move（Melody→其他角色、其他角色→Melody、複製進 Melody）都必須提供 leadEvidence：精確 sourceIdentity、sectionRole、可用的 scoreEvidence/audioEvidence、continuity.checked、core3.checked/status，以及正面的目的角色理由；來源衝突保持 PENDING。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        decisions: { type: 'array', minItems: 1, maxItems: 500, items: structuredPayload(), description: 'KEEP／ASSIGN_ROLE／MOVE_ROLE／OMIT_FROM_SIX／DUPLICATE_WITH_JUSTIFICATION，含 target、reason、evidence、acceptedBy；Lead move 另帶完整 leadEvidence。sourceIdentity 請先用 studio_baseline_events 取得，不可猜測。' },
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
    description: '以既有 compare／Core3／harmony／共享 Lead role grader（demotion + promotion）／readiness 模組重新檢查候選。Lead promotion 不信任 decision application 的 PASS，而是從已套用決定重新產生 grader report；任何未證實的 Lead move 都保持 PENDING。指標僅供診斷，不得為了讓數字歸零而刪掉來源支持的音樂。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        confirmations: structuredPayload(CONFIRMATIONS_DESCRIPTION),
      },
      required: ['project_id', 'candidate_id'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_core3_change_approve',
    title: 'Core3 來源變更核准',
    description: 'Gate 4 的第一個問題：Core3 來源連續性。針對連續性稽核目前回報為「未核准」的單一 Core3 變更（remove／modify／role-move）記錄一筆有證據的核准，綁定目前 baseline 與本候選。變更必須是本候選現在真的存在且未核准的那一筆，因此無法預先核准，也不會被其他候選繼承。這與 Gate 4 的第二個問題（Core3 musical completeness，見 studio_candidate_review 的 core3_completeness_reviewed）是不同的 review axis：任何一邊都不能代替另一邊，Lead 的決定與 Lead evidence 也都不是 Core3 核准。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        approval: structuredPayload('event_id、type（remove／modify／role-move）、reason，以及至少一筆 evidence。evidence 為必填：沒有證據的核准是主張，不是審查。'),
      },
      required: ['project_id', 'candidate_id', 'approval'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_lead_evidence_review',
    title: 'Lead 證據重新審查',
    description: '為「先前 revision 已經套用過」的單一 Lead move 重新提交證據。之所以需要這條路徑：下游 Lead gate 會從執行該 move 的 revision 取回證據並對目前候選重新評分，一旦後續 revision 改動了 Lead 樣貌，舊引用就不再描述正在評分的編曲，會正確地回到 PENDING（LEAD_EVIDENCE_CONTEXT_CHANGED）；但 G11-D 拒絕重複套用已發生的 move（PREVIOUS_ROLE_MISMATCH），KEEP 也不是 role move，因此原本無路可補。這裡提交的是審查紀錄，不是決定：不移動任何東西、不產生 revision，也不是 boolean 確認。每次 review 與 finalize 都會用同一個共享 grader 重新評分，絕不沿用舊的 PASS。綁定 exact candidate、axis、以及 Source-Faithful baseline 來源事件（衍生複製會綁回其 origin，不接受衍生 id）；下一個改動 Lead 的 revision 是不同候選，這筆審查不會被載入，報告會自動回到 PENDING。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        review: structuredPayload('event_id（readiness 使用的事件 id；衍生複製請用候選中的衍生 id）、axis（promotion 或 demotion，兩者互不代替）、reason、至少一筆 evidence，以及 lead_evidence：精確 sourceIdentity、sectionRole、scoreEvidence／audioEvidence、continuity.checked、core3.checked/status 與正面的目的角色理由。sourceIdentity 請用 studio_baseline_events 取得，不可猜測；綁不到該 move 的 baseline 來源事件會被拒絕。'),
      },
      required: ['project_id', 'candidate_id', 'review'],
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
        confirmations: structuredPayload(CONFIRMATIONS_DESCRIPTION),
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
    case 'studio_core3_change_approve':
      return application.approveCore3SourceChange(owner, args.project_id, { candidateId: args.candidate_id, approval: args.approval });
    case 'studio_lead_evidence_review':
      return application.reviewLeadEvidence(owner, args.project_id, { candidateId: args.candidate_id, review: args.review });
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
