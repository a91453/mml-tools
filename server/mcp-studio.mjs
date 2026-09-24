// The `studio_*` MCP control surface.
//
// Status: IMPLEMENTATION NOTES. High-level tools over the Studio
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
const candidateId = { type: 'string', minLength: 10, maxLength: 128, description: '候選 revision id（g11d:rev: 開頭），由 studio_decisions_apply、studio_final_reduction_apply 或 studio_mobile_adaptation_apply 產生。' };

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
import { LIMITS, PROPOSAL_KIND_NAMES, PROPOSAL_STATE_NAMES, RESOLUTION_NAMES } from '../studio/backend/application/index.mjs';
import { GAME_INSTRUMENTS, GAME_INSTRUMENT_IDS } from '../studio/backend/audio/instruments.mjs';
import { LABELS as PRESCREEN_LABELS } from '../studio/backend/audio/prescreen/prescreen.mjs';
import { PAGED_REPORT_TOOLS, REPORT_PAGE_SCHEMA, validateReportPage, readReportPage } from './report-page.mjs';
import { compactStudioResponse } from './mcp-compaction.mjs';
import { prescreenListenLinks } from './prescreen-listen.mjs';

const CONFIRMATIONS_DESCRIPTION = 'source_complete／version_drift_reviewed／player_readback／mobile_adaptation_reviewed／regression_reviewed／core3_completeness_reviewed／original_audio_required／original_audio_reviewed，每項需 reason。'
  + 'mobile_adaptation_reviewed（Gate 8）、regression_reviewed（Gate 9）、core3_completeness_reviewed（Gate 4 Core3 musical completeness）與 original_audio_reviewed（Gate 7：角色／突出度／延音／奏法／錄音結構已對照原曲審查）這四項，value=true 時另需至少一筆 evidence：只有理由字串的審查會被拒絕。original_audio_reviewed 需要候選已有 active 音訊對位證據，並綁定該證據 revision；對位證據沒有警告也不會自動通過 Gate 7。'
  + 'core3_completeness_reviewed 回答的是 Gate 4 的第二個問題（evaluator 無法證明完整的 Core3 是否仍站得住），它可以解決可審查的殘留（例如來源本來就沒有的 Chord1／Chord2 功能），但永遠無法消除缺席的 Lead，也無法消除身分依賴 Chord3–Chord5 的 Core3——那兩者 gate 直接 FAIL。'
  + 'Gate 4 的第一個問題（Core3 來源連續性）不在這裡：它由 studio_core3_change_approve 逐筆核准，兩者是不同 review axis，互不代替。'
  + 'player_readback 為 PASS、NOT_RUN 或 N/A（未使用預覽／驗證素材時，附理由）；PASS 可附 mml_sha256 綁定實際回讀的 MML。'
  + 'source_complete 與 original_audio_required 綁定於 baseline，同一個 baseline 上的每個候選都持續有效；其餘六項綁定於本候選，換候選即失效並回報為 stale。'
  + 'in_game 無法由此設定。';

const runId = { type: 'string', minLength: 36, maxLength: 36, description: '本服務發出的 run_id（run_ 開頭）。run 身分是 workflow instance，不是 baseline、候選或 artifact 的身分。' };
const runIdempotencyKey = { type: 'string', minLength: 1, maxLength: LIMITS.maxIdempotencyKeyLength, description: 'owner／專案／操作範圍內的 idempotency key，綁定於正規化後的請求指紋。同 key 同 payload 不重做；同 key 不同 payload 直接拒絕。' };
const runAssetIds = { type: 'array', minItems: 1, maxItems: LIMITS.maxAssetsPerProject, items: { type: 'string', minLength: 36, maxLength: 36 }, description: '明確選定參與本次 run 的符號來源素材。省略時使用專案中所有符號來源。原曲音訊是證據，不是符號來源：本服務不做 audio-to-MIDI、不做分軌、不做人聲分離、不做音高轉譜。' };
const runMeterText = { type: 'string', minLength: 1, maxLength: LIMITS.maxMeterTextLength, description: '來源確認的拍號圖，MML 來源才需要。未知時先詢問，不可假定。' };
const runDecisions = { type: 'array', minItems: 1, maxItems: LIMITS.maxDecisionsPerRequest, items: structuredPayload(), description: '明確接受的編排決定，內容與 studio_decisions_apply 相同。建議不是接受：沒有這一欄時 run 會停在 awaiting_review，不會自行解決任何 PENDING。' };
const runAcceptedBy = { type: 'string', minLength: 1, maxLength: 120, description: '審查者識別字串。這是呼叫端填寫的文字，會與實際通過驗證的 owner 身分分開記錄，本身不構成任何人已審查的證據。' };

const RUN_REDUCTION_DESCRIPTION = '明確接受的 G12 收斂：decisions（至少一筆）、expected_plan_id（來自唯讀 plan）、accepted_by，以及選填且僅供診斷的 instrument_profile。'
  + '省略時 run 只會產生唯讀 plan：若 ledger 顯示每個來源事件都已保留且沒有 blocker，就跳過且不產生 no-op 版本；否則停在 REDUCTION_DECISIONS_REQUIRED，附上 plan.id、未保留事件與原始 warning。OVERFLOW／PENDING 一律保留，字數不足不是刪音理由。'
  + '六角色已滿的 OVERFLOW 會另外附上 suggestion-only 的 7→6 merge 診斷：逐 lane／角色列出可無損塞入、完整同音覆蓋與會需要截短／丟音的事件數；這些數字不會自行產生 REDISTRIBUTE／OMIT，也不構成任何 Gate PASS。';
const RUN_ADAPTATION_DESCRIPTION = '明確接受的 Mobile 適配：profile（schema=mml-studio/mobile-adaptation-profile@1，需真實提供且附 reason／evidence）、release_representation（見 studio_mobile_adaptation_plan）、expected_plan_id、accepted_by；profile 與 release_representation 至少一項。'
  + '省略時完全不做適配、不產生版本——但「沒做變更」不等於 Gate 8 通過，Gate 8 審查仍然必須另外提供。本服務不自造樂器音域或音量。';
const RELEASE_REPRESENTATION_DESCRIPTION = '選填：Final 無法表示的 release（例如 MIDI 比 1/64 格點早一個 tick 的 note-off）的表示決定。{decisions:[{id, eventIds, representation: EXTEND_TO_NEXT_GRID|TRUNCATE_TO_PREVIOUS_GRID, reason, attestation:{reviewer, reviewer_kind: human|agent|tool|mcp-client|imported}, evidence:[{class: primary-symbolic|primary-audio, ref: asset_id 或 source id, basis: direct-source-review|machine-metric|alignment-locator|encoding-pattern|imported-assertion, locator, finding}]}]}。'
  + 'attestation 只是提交者的 provenance（稽核紀錄），不影響證據等級：人類、對話式 AI、工具提交同一份證據，結果完全相同。證據生效的條件是：引用本專案真的持有、且與第三方檔案不同位元組的獨立 primary 來源（官方譜／官方 MIDI，或原曲音訊），basis 為 direct-source-review（直接審閱該來源本身，例如譜面寫的時值、錄音在 locator 處的延音／斷奏），並附 locator 與 finding。'
  + 'machine-metric／alignment-locator（SOURCE_POLICY §6 只是定位）、encoding-pattern、imported-assertion、第三方、工具輸出只會記錄、不計入，並保持 PENDING；不要把自己沒有實際審閱的來源標成 direct-source-review。來源 release 永遠保留在 baseline 與事件紀錄，onset／音高／角色不動，不加 tie、不合併重複音。傳 {decisions:[]} 可只取得逐 release 的分析與 releaseEvidenceRequirement（依本專案現有來源列出能解決的證據）。';
const RUN_FINALIZE_DESCRIPTION = 'finalize 選項：technical_timing_repair（明確 opt-in，預設 false，沒有自動模式）、pickup、final_partial（來源確認的弱起拍與末小節拍長，不會自行推測）。';

// The audio prescreen's inputs, shared by the read-only prescreen and the
// shadow-record write so the two cannot describe the same request differently.
const PRESCREEN_NOTICE_TEXT = '預篩結果只是機器證據：不設定 Gate 7（原曲音訊證據）、不設定玩家回讀（Gate 6 player_readback）、不設定 in_game，也不選定、接受或套用任何版本。免費 GM 音色（FluidR3Mono，首次需要時由服務下載並以 SHA-256 驗證）不是遊戲音色。';
const prescreenMml = { type: 'string', minLength: 1, maxLength: 16384, description: '完整六軌 MML@...,...,...,...,...,...; 原文；本工具不改寫。' };
const prescreenInstruments = {
  type: 'array', minItems: 6, maxItems: 6, items: { type: 'string', enum: [...GAME_INSTRUMENT_IDS] },
  description: `六角色（Melody、Chord1–Chord5）各自的遊戲樂器，以 GM 音色近似：${GAME_INSTRUMENTS.map(item => `${item.id} ${item.label}=${item.drumNotes ? `GM 鼓 ${item.drumNotes[0]}` : `GM ${item.program}`}`).join('、')}。省略時六角色皆為 lute。`,
};
const prescreenProperties = {
  alternatives: {
    type: 'array', minItems: 2, maxItems: 4,
    description: '2–4 個替代版本，每個恰好指定 mml、candidate_id 或 artifact_id 其中之一（後兩者需 project_id）；label 選填（預設 A、B、C、D）；instruments 選填，覆寫共用的 instruments。',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 16 },
        mml: prescreenMml,
        candidate_id: candidateId,
        artifact_id: { type: 'string', minLength: 68, maxLength: 68, description: 'Final artifact（art_ 開頭），使用其已交付的 MML 與拍號圖。' },
        instruments: prescreenInstruments,
      },
    },
  },
  meter_text: { type: 'string', minLength: 1, maxLength: 2048, description: '來源確認的拍號圖，每行「起拍 拍號」。有 MML 替代版本時必填；候選／artifact 未提供時沿用其自身拍號圖。不可假定 4/4。' },
  pickup: { type: 'string', minLength: 1, maxLength: 32, description: '來源確認的弱起拍長；沒有時省略。' },
  instruments: prescreenInstruments,
  bar_range: { type: 'object', additionalProperties: false, required: ['from'], properties: { from: { type: 'integer', minimum: 1, maximum: 10000 }, to: { type: 'integer', minimum: 1, maximum: 10000 } }, description: '選填：只預篩第 from–to 小節（依拍號圖編號）。' },
  reference: {
    type: 'object', additionalProperties: false,
    properties: { mml: prescreenMml, candidate_id: candidateId },
    description: '來源忠實度的參照：mml（無專案時的來源 MML）或 candidate_id（本專案已接受的候選）。專案中省略時使用 Source-Faithful Baseline。沒有參照時，替代版本符號內容不同的小節一律 NEEDS_HUMAN（SOURCE_FIDELITY_UNAVAILABLE）。',
  },
  thresholds: structuredPayload('選填：覆寫預設門檻，例如 {"roughness":{"margin_abs":0.004}}；鍵為 roughness／masking／smear／clipping／original_similarity，欄位為 margin_abs／margin_rel／tolerance_abs／tolerance_rel。門檻變更會改變 thresholds.id 與 report_id。'),
  render: { type: 'object', additionalProperties: false, properties: { sample_rate: { type: 'integer', minimum: 22050, maximum: 44100 }, channels: { type: 'integer', minimum: 1, maximum: 2 } }, description: '選填：22050 或 44100 Hz，單聲道 1 或立體聲 2（預設 22050／1）。' },
};

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
    description: '在 Source-Faithful Baseline 上執行既有聲部拆解與角色候選建議。這是建議，不是接受：PENDING 仍是 PENDING，本工具不會替你決定保留、移除或搬移。當 role-less lanes 競爭同一角色或超過六角色容量時，回報 suggestion-only 的 7→6 merge diagnostics（無損空檔、完整同音覆蓋、碰撞／會需要截短丟音）；診斷不會自行合併、刪音、接受角色或通過任何 Gate。',
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
    description: '將明確接受的決定集合交給既有 G11-D 套用流程，全有或全無。acceptance 綁定由服務依現在載入的 baseline 與聲部拆解計算，呼叫端不得提供。已有角色的 MOVE_ROLE 進出 Melody、複製進 Melody、以及 Lead demotion 都維持完整 leadEvidence 門檻。唯一候選流程例外是 role-less 來源第一次 ASSIGN_ROLE -> Melody：可不帶 leadEvidence 先產生明確 review-pending 的可逆候選；這不是 Lead evidence、不是 Gate 3 PASS，Final 前仍需 candidate-bound reviewer evidence。leadEvidence 的 scoreEvidence／audioEvidence 有分類時請附 ref（本專案的 asset_id 或 source id）：review 與 finalize 會依本專案來源解析後才交給 Lead grader，沒有 ref、對不到專案來源或第三方來源的引用不算正面角色證據（SOURCE_POLICY §1C）；決定不陳述音訊判定方法，其 audio 分類一律視為 machine metric，只是定位（§6）。因此此路徑只有本專案持有的官方譜能證明角色；以直接審閱原曲錄音為依據，或替已套用的 move 補證據，請用 studio_lead_evidence_review。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        decisions: { type: 'array', minItems: 1, maxItems: 500, items: structuredPayload(), description: 'KEEP／ASSIGN_ROLE／MOVE_ROLE／OMIT_FROM_SIX／DUPLICATE_WITH_JUSTIFICATION，含 target、reason、evidence、acceptedBy。已有角色的 Lead move 另帶完整 leadEvidence；role-less 初次 ASSIGN_ROLE -> Melody 可省略它以產生 review-pending 候選，但不能因此宣稱 Lead PASS。sourceIdentity 請先用 studio_baseline_events 取得，不可猜測。' },
        parent_candidate_id: candidateId,
        accepted_by: { type: 'string', minLength: 1, maxLength: 120 },
      },
      required: ['project_id', 'decisions'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_final_reduction_plan',
    title: '預覽 Final Six-Role Reduction',
    description: 'G12：把已接受角色的候選收斂成可進入 Mobile Adaptation 的六角色候選，並產生事件級 accounting ledger。唯讀，不寫入、不產生候選。'
      + '每個來源支持的 baseline 事件都會落在 KEEP／REDISTRIBUTE／OVERFLOW／PENDING／OMIT 其中之一；overflow 與 pending 一律保留在 ledger 與候選中，不會消失。'
      + 'decisions 為 schema=mml-studio/final-six-role-reduction-decision@1 的陣列，含 id、action（KEEP／REDISTRIBUTE／DUPLICATE／ACCEPT_OVERFLOW／OMIT）、eventIds（候選事件 id，不接受 lane）、reason；REDISTRIBUTE 需 toRole，DUPLICATE 需 toRoles，兩者與 OMIT 另需至少一筆 evidence。'
      + '任何進出 Melody 的移動、複製進 Melody，或移除 Lead 事件，都要帶完整 leadEvidence，並由既有 Lead grader 判定；證據不足即 PENDING，沒有 G12 專用捷徑。'
      + '本階段只處理角色與六軌容量：不改音高、八度、起訖、時值與音量（那些屬於 Gate 8 Mobile Adaptation），不因角色字數超過上限而刪音，不把未對應鼓面的 GM 鼓音塞進音高角色。'
      + 'instrument_profile 為選填且僅供診斷：它不決定任何 outcome、不解決 PENDING、不通過任何 Gate，帶或不帶都不會改變 plan.id。'
      + '回傳 plan.id、逐事件 ledger、Core3／和聲／字數壓力前後比較；status=PASS 僅表示這份 plan 可安全套用，不是 Gate 3／4／5／8／9 通過。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        decisions: { type: 'array', maxItems: 500, items: structuredPayload(), description: '明確接受的 reduction decisions；留空即取得純分析預覽。' },
        accepted_by: { type: 'string', minLength: 1, maxLength: 120, description: '審查者識別；plan 身分綁定於此，預覽與套用需一致。' },
        instrument_profile: structuredPayload('選填 mml-studio/instrument-profile@1；僅診斷，不影響任何判定。'),
      },
      required: ['project_id', 'candidate_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_final_reduction_apply',
    title: '套用 Final Six-Role Reduction 並重新審核',
    description: '重新計算 reduction plan，只有 expected_plan_id 與目前 baseline／candidate／decisions／accepted_by／Canonical 一致時才原子套用。'
      + '產生新的 reduction 候選（stage=FINAL_SIX_ROLE_REDUCTION_V1），保留 parent candidate、Source-Faithful Baseline、plan 身分與 accounting ledger，並立即重新跑 review。'
      + '套用不代表任何 Gate 通過：Core3、Lead、Full6、Gate 8、Gate 9 與實機接受全部重新開啟。有任何 blocker 時完全不套用。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        candidate_id: candidateId,
        decisions: { type: 'array', minItems: 1, maxItems: 500, items: structuredPayload() },
        expected_plan_id: { type: 'string', minLength: 10, maxLength: 200 },
        accepted_by: { type: 'string', minLength: 1, maxLength: 120 },
        instrument_profile: structuredPayload('選填；僅診斷。'),
      },
      required: ['project_id', 'candidate_id', 'decisions', 'expected_plan_id', 'accepted_by'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_mobile_adaptation_plan',
    title: '預覽 Mobile 適配',
    description: '依附有 reason/evidence 的 profile 自動規劃整個角色的最小八度調整與音量映射。profile schema=mml-studio/mobile-adaptation-profile@1，含 id、reason、evidence、roles；roles 以 Melody/Chord1–Chord5 為鍵，各值可含 pitchRange:[min,max]、volumeDelta、defaultVolume。音域上限 107，音量 0–15。沒有內建樂器校準，不猜測鼓面，不修剪音符。回傳 plan.id 與逐事件差異；PASS 僅表示可套用，不是 Gate 8 通過。已綁定 Lead 證據的事件（含僅由 revision lineage 記錄者）不可調整音高／音量；來源基準未指定角色時，被指派為 Melody 的事件即屬此類，v1 無法調整該 Melody。另可只帶 release_representation（不需 profile）：回傳逐 release 的來源值、分析、兩種 1/64 表示選項與證據需求（plan.releaseTiming），並把有可採證據的決定轉成精確的 release 變更。',
    inputSchema: { type: 'object', properties: { project_id: projectId, candidate_id: candidateId, profile: structuredPayload('選填：Mobile target profile。'), release_representation: structuredPayload(RELEASE_REPRESENTATION_DESCRIPTION) }, required: ['project_id', 'candidate_id'], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: 'studio_mobile_adaptation_apply',
    title: '套用 Mobile 適配並重新審核',
    description: '重新計算適配計畫，只有 expected_plan_id 與目前 baseline/candidate/profile 一致時才原子套用。產生衍生 candidate、保留原始與前版，立即重新跑 review；舊 Gate 8/9、音訊與實機接受不會轉移。',
    inputSchema: { type: 'object', properties: { project_id: projectId, candidate_id: candidateId, profile: structuredPayload('選填：Mobile target profile。'), release_representation: structuredPayload(RELEASE_REPRESENTATION_DESCRIPTION), expected_plan_id: { type: 'string' }, accepted_by: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['project_id', 'candidate_id', 'expected_plan_id', 'accepted_by'], additionalProperties: false },
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
        review: structuredPayload('event_id（readiness 使用的事件 id；衍生複製請用候選中的衍生 id）、axis（promotion 或 demotion，兩者互不代替）、reason、至少一筆 evidence，以及 lead_evidence：精確 sourceIdentity、sectionRole、scoreEvidence／audioEvidence、continuity.checked、core3.checked/status 與正面的目的角色理由。sourceIdentity 請用 studio_baseline_events 取得，不可猜測；綁不到該 move 的 baseline 來源事件會被拒絕。必填 attestation：{ reviewer（誰提交）, reviewer_kind: human|agent|tool|mcp-client|imported, audio_basis: listening|direct-source-review|machine-metric|not-used }。attestation 只是 provenance（稽核紀錄），不影響評分：人類、對話式 AI、工具提交同一份證據，結果完全相同。scoreEvidence／audioEvidence 有分類時請附 ref（本專案的 asset_id 或 source id）：只有本專案持有位元組、且與第三方檔案不同的官方譜／官方 MIDI（score）或原曲錄音（audio）能當正面角色證據；第三方檔案只是輔助（SOURCE_POLICY §1C），沒有 ref 或 ref 對不到專案來源的引用不算。audio_basis 為 machine-metric（F0、CQT、chroma 等）時，該音訊分類只是定位，不算正面角色證據（SOURCE_POLICY §6）。只有實際直接審閱過來源時才可標 listening／direct-source-review。'),
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
    name: 'studio_run_plan',
    title: '一鍵流程規劃（唯讀）',
    description: '唯讀規劃：回報這個專案接下來會走哪些既有步驟、哪些結果已經存在、哪些步驟需要你補資料或審查，以及有哪些能力／環境阻擋。'
      + '本工具不建立 run、不建立 baseline、不寫 suggestion 快取、不產生候選、不套用任何決定，也不寫入任何紀錄；需要分析才知道的事會標成「需要 intake／suggestion」，不會為了產生計畫而先執行寫入。'
      + 'run 狀態是實作進度，不是 Canonical 判定：completed 不等於 TECHNICAL_PASS、SOURCE_PASS、VALIDATED 或 IN_GAME_ACCEPTED。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        asset_ids: runAssetIds,
        meter_text: runMeterText,
        target_candidate_id: candidateId,
        decisions: runDecisions,
        accepted_by: runAcceptedBy,
        final_reduction: structuredPayload(RUN_REDUCTION_DESCRIPTION),
        mobile_adaptation: structuredPayload(RUN_ADAPTATION_DESCRIPTION),
        confirmations: structuredPayload(CONFIRMATIONS_DESCRIPTION),
        finalize: structuredPayload(RUN_FINALIZE_DESCRIPTION),
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_run_start',
    title: '啟動一鍵流程',
    description: '建立一個 run，並執行目前輸入已經允許的有限步驟：既有來源匯入 → 角色建議 → 已明確接受的決定套用 → G12 六角色收斂 → Mobile 適配 → 候選審查 → finalize → run report。'
      + '缺少已接受的決定、已接受的 plan、Mobile profile 或審查證據時，會停在對應位置並回傳可操作的 review request；建議不會被當成接受，PENDING 不會被改成 KEEP／OMIT／PASS，沒有資料也不會被寫成 N/A 或 not-required。'
      + '執行模式是 bounded synchronous advancement：呼叫回傳後就沒有任何東西在背景執行，要繼續必須明確呼叫 studio_run_resume。'
      + 'idempotency_key 由服務強制：同 key 同 payload 回傳同一個 run，不重複套用、不升版本、不重複產生 artifact；同 key 不同 payload 直接拒絕。'
      + '套用成功不代表任何 Gate 通過，最終 in_game 仍為 PENDING。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        idempotency_key: runIdempotencyKey,
        asset_ids: runAssetIds,
        meter_text: runMeterText,
        target_candidate_id: candidateId,
        decisions: runDecisions,
        accepted_by: runAcceptedBy,
        final_reduction: structuredPayload(RUN_REDUCTION_DESCRIPTION),
        mobile_adaptation: structuredPayload(RUN_ADAPTATION_DESCRIPTION),
        confirmations: structuredPayload(CONFIRMATIONS_DESCRIPTION),
        finalize: structuredPayload(RUN_FINALIZE_DESCRIPTION),
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_run_status',
    title: '一鍵流程狀態（唯讀）',
    description: '唯讀查詢 run 的狀態、進度、每一步的 receipt、原始 blocker code、review requests、候選與 artifact 身分，以及 Canonical 與實作兩份分開的 provenance。'
      + '省略 run_id 時回傳本專案的 run 摘要清單。本工具不寫入任何東西、不重跑 review、不推進 run。'
      + '另外回報便宜可查的 staleness：來源 bytes、選定素材、baseline、候選或 rules snapshot 變了就會標出來，續跑時舊的核准不會被沿用。',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId, run_id: runId },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_run_next',
    title: 'Read-only provider-neutral continuation',
    description: 'Read an explicit existing run: revision, baseline/candidate, Canonical identities, stopped step, conditional operations, missing evidence and blockers. '
      + 'Creates and changes nothing; never accepts a proposal, reconciles an interruption, computes a gate or calls a model. '
      + 'Use current request keys with the existing proposal tools; only explicit authorized acceptance reaches the existing resume path. '
      + 'Gate snapshots are historical, not a new PASS. Server exposure does not prove this conversation connector exposes or can execute all continuation tools.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId, run_id: runId,
        expected_run_revision: { type: 'integer', minimum: 1, maximum: LIMITS.maxRunRevision, description: 'Optional observed revision; a mismatch is refused without writing.' },
      },
      required: ['project_id', 'run_id'], additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_run_resume',
    title: '續跑一鍵流程',
    description: '在明確補上新的輸入、決定或證據之後，重新檢查每一個綁定並續跑同一個 run。'
      + '每一步都會重新讀取實際狀態：來源 bytes、選定素材、baseline、候選、已接受決定、profile、plan 或 rules snapshot 有相關變動時就停住並回報，不會沿用已經不成立的核准或 PASS。'
      + '正常補證據（Gate 4／8／9 審查、Core3 核准、Lead 證據、音訊報告）後可以對目前候選重新 review 並繼續，不會因為多了一筆證據就永久卡住。'
      + 'expected_run_revision 提供樂觀併發：與目前 revision 不符時回傳 RUN_CONFLICT。'
      + 'adopt_candidate_id 用來明確採用 run 之外的操作所產生的候選，會驗證 baseline 與 lineage；絕不自行挑時間最新的候選。'
      + '若上次執行在 effect 與 receipt 之間中斷，而該 effect 無法用既有內容定址身分或已儲存的參照證明，run 會回報 interrupted／needs reconciliation 並指出未確認的步驟，不會盲目重放；確認狀態後以 reconcile=true 續跑。'
      + '若有多個相符結果而無法辨識是哪一個，candidate 用 adopt_candidate_id、artifact 用 adopt_artifact_id 明確指定，兩者都會嚴格驗證身分。'
      + 'meter_text 是 intake input 而非顯示資訊：MML 來源是依它解析的。若既有 baseline 是用某個 meter 建立而本 run 未提供 meter，run 會明確阻擋而不是沿用；提供不同 meter 則重新 intake，綁在舊 baseline 的候選與確認不會被沿用。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        run_id: runId,
        idempotency_key: runIdempotencyKey,
        expected_run_revision: { type: 'integer', minimum: 1, maximum: LIMITS.maxRunRevision, description: '上次讀到的 run revision；不符即拒絕，不覆蓋。' },
        asset_ids: runAssetIds,
        meter_text: runMeterText,
        adopt_candidate_id: candidateId,
        adopt_artifact_id: { type: 'string', minLength: 68, maxLength: 68, description: '明確指定要採用的 artifact（art_ 開頭），用來收束「中斷後有多個相符 artifact」的情況。會驗證型別、所屬候選，run report 另驗證其內容確實指向本 run；絕不以時間最新者代替。' },
        decisions: runDecisions,
        accepted_by: runAcceptedBy,
        final_reduction: structuredPayload(RUN_REDUCTION_DESCRIPTION),
        mobile_adaptation: structuredPayload(RUN_ADAPTATION_DESCRIPTION),
        confirmations: structuredPayload(CONFIRMATIONS_DESCRIPTION),
        finalize: structuredPayload(RUN_FINALIZE_DESCRIPTION),
        reconcile: { type: 'boolean', description: '明確宣告已確認中斷步驟的實際狀態，允許 run 繼續。預設 false。' },
      },
      required: ['project_id', 'run_id'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_proposal_targets',
    title: '可提案標的（唯讀）',
    description: '唯讀列出這個 run 目前真的正在等待的 review request，以及每一項可以用哪些 proposal class 回答、各自會走到哪一個既有操作、是否需要可解析的引用，以及上游模組自己說的缺什麼。'
      + '標的只來自 run 自己的 review_requests：run 沒有在問的事不會出現，本工具也不會發明任何標的。'
      + 'request_key 是 review request 的身分，由 code／step／gate／report reference／baseline／candidate 推導而來，不是陣列位置、不是時間、也不是請求內容的雜湊；素材一變，key 就跟著變，舊 proposal 因此無法再指到新的 request。'
      + 'readiness gate、被擋住的 finalize、輸入已變更與中斷待確認這四類，只接受 evidence_needed：回答它們的是審查者的 confirmation／核准／證據紀錄或人工檢視，proposal 再詳細都不是那些。'
      + '本工具不建立 proposal、不推進 run、不寫入任何東西。',
    inputSchema: {
      type: 'object',
      properties: { project_id: projectId, run_id: runId },
      required: ['project_id', 'run_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_proposal_submit',
    title: '提交 AI 提案',
    description: '把一份結構化、可稽核、可拒絕的提案存進來，內容是「這個 run 目前這一筆 review request 應該怎麼回答，以及為什麼」。'
      + '提交本身不套用任何東西：不產生候選、不升 revision、不記錄 confirmation、不移動任何 gate，run 的 revision 連動都不會動。要真的套用，必須另外做一次明確的 studio_proposal_resolve 接受。'
      + '本協定與模型無關：沒有 provider SDK、沒有模型金鑰、沒有模型識別欄位，本服務也不呼叫任何模型。proposed_by 只是呼叫端自己填的文字，會與通過驗證的 owner 身分分開記錄，本身不構成任何人已審查或已接受的證據。'
      + 'cites 裡的每一筆都必須是本專案真的持有、而且本服務可以解析的身分（baseline event id、source id，或 asset／artifact／job／candidate／run／該 run 自己給過的 report_reference）；網址、檔名、對話片段與模型的印象都不是，會被拒絕——那些請寫在 rationale。'
      + '每一筆 evidence_ref 都必須標明 truth_class（symbolic／audio／in_game／community／project_history），而且不接受任何單一信心分數（confidence／score／certainty／probability／likelihood）：SOURCE_POLICY.md 要求符號證據與音訊證據分欄保存，就是為了不讓一個數字蓋掉兩者的分歧。把原曲音訊來源標成 symbolic（或反之）同樣會被拒絕。'
      + 'missing_evidence 或 unresolved_conflicts 只要非空，判定就是 REQUIRES_MORE_EVIDENCE：agent 自己說證據不足時，本服務不會反過來判它證據充足。PENDING 是合法且重要的結果，evidence_needed 這個 class 就是為它存在的。'
      + 'decisions 不可自帶 acceptedBy、note 或 acceptance：接受者由接受那一步指定，acceptance binding 由服務在套用當下從實際載入的素材計算。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        run_id: runId,
        idempotency_key: runIdempotencyKey,
        expected_run_revision: { type: 'integer', minimum: 1, maximum: LIMITS.maxRunRevision, description: '撰寫這份提案時讀到的 run revision；不符即拒絕，不會套用到 agent 沒看過的素材上。' },
        request_key: { type: 'string', minLength: 68, maxLength: 68, description: 'studio_proposal_targets 給的 review request 身分（req: 開頭）。由服務推導，呼叫端不自行構造；指不到任何目前開著的 request 就直接拒絕，不會找最接近的一筆。' },
        kind: { type: 'string', enum: [...PROPOSAL_KIND_NAMES], description: 'proposal class。必須是該 request 允許的其中之一，否則回報 NOT_AGENT_SETTLABLE。' },
        proposed_by: { type: 'string', minLength: 1, maxLength: 120, description: '提案者識別字串。呼叫端自填的文字，不是通過驗證的身分，也不是接受者。' },
        rationale: { type: 'string', minLength: 1, maxLength: LIMITS.maxProposalRationaleLength, description: '給人類審查者看的理由。這裡是散文該待的地方，不會被當成引用。' },
        action: structuredPayload('依 kind 而定的封閉欄位：arrangement_decision→decisions；final_reduction→decisions／instrument_profile／expected_plan_id／plan_accepted_by；mobile_adaptation→profile／expected_plan_id；source_selection→asset_ids／meter_text；candidate_selection→candidate_id；evidence_needed→完全不帶 action。未列欄位一律拒絕。'),
        cites: structuredPayload('event_ids／source_ids／evidence_refs（每筆 kind、id、truth_class，選填 note）。全部對本專案解析，解析不到就是偽造。'),
        unresolved_conflicts: { type: 'array', maxItems: LIMITS.maxProposalConflicts, items: structuredPayload(), description: '尚未解決的來源分歧陣列；每筆含 summary、event_ids、source_ids、truth_classes。記錄而不裁決——MASTER_RULES.md §0 說兩個權威衝突時不要猜。' },
        missing_evidence: { type: 'array', maxItems: LIMITS.maxProposalConflicts, items: { type: 'string', maxLength: LIMITS.maxProposalNoteLength }, description: '還缺什麼證據才能決定。非空即代表本提案不足以進入操作。' },
        canonical_warnings: { type: 'array', maxItems: LIMITS.maxProposalConflicts, items: { type: 'string', maxLength: LIMITS.maxProposalNoteLength }, description: '提案者認為與 Canonical 規則相關、需要審查者注意的地方。這是提醒，不是裁決。' },
        expected_operation: { type: 'string', maxLength: 200, description: '提案者認為這份提案會走到哪一個既有操作。會與服務自己推導的比對，不符就拒絕——讓 agent 以為在提案 A 卻被套用成 B 是不可接受的。' },
      },
      required: ['project_id', 'run_id', 'request_key', 'kind', 'proposed_by', 'rationale'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_proposal_status',
    title: '提案狀態（唯讀）',
    description: '唯讀查詢提案。給 proposal_id 時回傳該筆提案的完整內容、繫結身分、引用、以及「用現在儲存的狀態重新計算」的 Agent Review 判定；省略時回傳本專案的提案清單，可用 run_id／request_key／state／kind 篩選。'
      + '判定永遠是當場重算的，不是提交當時的快取：快取一份安全檢查，就是一份可能已經錯了的安全檢查。提交當時的判定會另外保留在 agent_review_at_submission，供稽核比對。'
      + '本工具不寫入任何東西、不接受任何提案、不推進 run。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        proposal_id: { type: 'string', minLength: 36, maxLength: 36, description: '本服務發出的 proposal_id（pro_ 開頭）。' },
        run_id: runId,
        request_key: { type: 'string', minLength: 68, maxLength: 68 },
        state: { type: 'string', enum: [...PROPOSAL_STATE_NAMES] },
        kind: { type: 'string', enum: [...PROPOSAL_KIND_NAMES] },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'studio_proposal_resolve',
    title: '明確接受／拒絕提案',
    description: '對一份提案記錄明確的接受、拒絕或撤回。拒絕與撤回只是紀錄；接受是唯一會走到既有操作的路徑。'
      + '接受會先用現在儲存的狀態重新跑一次 Agent Review，只有 REQUIRES_EXPLICIT_ACCEPTANCE 這一個判定可以接受——那是單一值，不是清單。rules snapshot、baseline、候選、素材選擇、已接受決定集、run revision 或該 review request 任何一項變了，判定就是 STALE，直接拒絕。'
      + '接受之後，走的是既有的 resumeRun：同一把鎖、同一套 idempotency、同一套樂觀併發、同一套每步 staleness 重驗、同一套中斷規則。同樣的輸入，手動路徑與接受提案路徑產生同一個候選身分。'
      + 'accepted_by 由這一步提供，而且只由這一步提供：agent 的 proposed_by 不會被拿來當成接受者。'
      + '接受成功不代表操作成功、不代表任何 Gate 通過、也不代表 song state 改變：那些請讀回傳的 run 自己的 steps、blockers、gates 與 review requests。in_game 不受影響，仍為 PENDING。'
      + '本操作不接受 idempotency_key：接受時服務自己鑄造一把由 proposal id 與 revision 決定的固定 key 交給 resumeRun，重試本來就安全，呼叫端再給一把也綁不到任何東西。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        proposal_id: { type: 'string', minLength: 36, maxLength: 36 },
        resolution: { type: 'string', enum: [...RESOLUTION_NAMES], description: 'accept／reject／withdraw。' },
        accepted_by: { type: 'string', minLength: 1, maxLength: 120, description: '接受者識別字串，resolution=accept 時必填。這是接受這件事本身的紀錄，與提案者分開。' },
        reason: { type: 'string', maxLength: LIMITS.maxProposalNoteLength, description: '接受或拒絕的理由，記錄在提案上。' },
        expected_proposal_revision: { type: 'integer', minimum: 1, maximum: LIMITS.maxRunRevision, description: '上次讀到的提案 revision；不符即拒絕，不覆蓋。' },
      },
      required: ['project_id', 'proposal_id', 'resolution'],
      additionalProperties: false,
    },
    annotations: writes,
  },
  {
    name: 'studio_audio_prescreen',
    title: '音色 A/B 預篩（唯讀）',
    description: '把 2–4 個替代版本（MML 原文，或本專案的候選／Final artifact）以同一套免費 GM 音色渲染，逐小節比較：低中音粗糙度（感官不協和，指出是哪一對音，例如某個低音小二度；來源本來就有的不協和只回報、不計入勝差）、角色遮蔽／可聽度、衰減拖尾、削波／峰值，以及專案有原曲音訊且有 active 對位證據時與原曲的相似度（目前只讀 WAV／PCM，其他格式回報 ORIGINAL_AUDIO_METRIC_UNAVAILABLE）。'
      + '只有每一項適用指標都指向同一個勝者、各自勝差超過門檻、勝者在其他指標上不比最好的差超過容許值、而且勝者離來源不比其他版本遠時，該小節才是 OBVIOUS；否則是 NEEDS_HUMAN 並附理由（METRICS_CONFLICT／MARGIN_TOO_SMALL／METRIC_UNAVAILABLE／SOURCE_FIDELITY_TRADEOFF／SOURCE_FIDELITY_UNAVAILABLE），human_review 列出要 A/B 試聽的小節與版本；回應另附 listen（不在報告內、不改 report_id）：部署設定了 Studio Web 時，每個區段一條只開那幾小節的 A/B 試聽連結（候選版本沒有 MML，無連結）。試聽連結只是聽的輔助，不記錄任何東西。'
      + '報告含每個版本的 MML SHA-256、音色庫與渲染器身分、門檻 id 與 report_id；相同輸入得到相同報告。不寫入任何專案紀錄。'
      + '只帶 project_id、不帶其他欄位時，改為回傳本專案的 shadow 校準紀錄與逐指標／逐類別一致率。'
      + PRESCREEN_NOTICE_TEXT,
    inputSchema: { type: 'object', properties: { project_id: projectId, ...prescreenProperties }, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: 'studio_prescreen_shadow_record',
    title: '預篩 shadow 校準紀錄',
    description: 'Shadow 模式：只寫入本專案的預篩校準紀錄（服務資料目錄，不是專案或 repo）。entry=prediction 時以與 studio_audio_prescreen 相同的欄位由服務重新計算並記錄預測（同一份報告重複記錄不會重複）；entry=owner_choice 時記錄擁有者對某個預測區段實際選了哪個版本（prediction_id、region_id、chosen 為版本 label 或 NO_PREFERENCE、accepted_by 必填、reason 選填），之後的紀錄取代同一區段的舊選擇但保留歷史。'
      + '回傳逐指標與逐類別的一致率。這些紀錄不是任何 gate 的證據，也不會自動套用任何版本；自動套用只在擁有者發布對應的 Canonical 規則後才可能存在，目前沒有。'
      + PRESCREEN_NOTICE_TEXT,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: projectId,
        entry: { type: 'string', enum: ['prediction', 'owner_choice'] },
        ...prescreenProperties,
        prediction_id: { type: 'string', minLength: 36, maxLength: 36, description: 'entry=owner_choice：先前記錄的 prediction_id（psp_ 開頭）。' },
        region_id: { type: 'string', minLength: 1, maxLength: 40, description: 'entry=owner_choice：該預測中的 region_id，例如 bars-12-15。' },
        chosen: { type: 'string', minLength: 1, maxLength: 16, description: 'entry=owner_choice：擁有者實際選的版本 label，或 NO_PREFERENCE。' },
        accepted_by: { type: 'string', minLength: 1, maxLength: 120, description: 'entry=owner_choice 必填：做出選擇的人。' },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['project_id', 'entry'],
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

// Paging is a transport view on these existing reads, never an additional
// operation or stored artifact. The bounded view of long lists
// (mcp-compaction.mjs) is the other transport view, and every tool that can
// return one, or that writes, says how to read past it and what a too-large
// response after a write means.
export const RESPONSE_SIZE_NOTE = ' 回應中的長清單會摘要成 {compacted, truncated, total, first, sha256, report_page 或 retrieve}；儲存的紀錄完整不變，完整清單請依 report_page（工具、參數與 JSON path）分頁讀取，或用 retrieve 指名的讀取。'
  + 'Long lists are summarized; read them in full with report_page. If a call returns PAYLOAD_TOO_LARGE with details.operation_returned=true (for example operation="succeeded"), the operation already took effect: never retry it; read the state back through details.recovery_reads.';
for (const tool of STUDIO_MCP_TOOLS) {
  if (PAGED_REPORT_TOOLS.has(tool.name)) tool.inputSchema.properties.report_page = REPORT_PAGE_SCHEMA;
  if (tool.name !== 'studio_capabilities') tool.description += RESPONSE_SIZE_NOTE;
}

// The run input, as the Application Service already spells it.
//
// A projection, not a translation: every field below is passed through under
// the same name the service validates, and `project_id`/`run_id` are dropped
// because they are the addressing, not the request. The service refuses an
// unknown field, so a misspelling is reported rather than silently ignored --
// which is the whole point, since a dropped `final_reduction` would otherwise
// look like a caller that accepted no reduction.
const RUN_INPUT_FIELDS = [
  'idempotency_key', 'expected_run_revision', 'asset_ids', 'meter_text',
  'target_candidate_id', 'adopt_candidate_id', 'adopt_artifact_id', 'decisions',
  'accepted_by', 'final_reduction', 'mobile_adaptation', 'confirmations', 'finalize', 'reconcile',
];

const runInput = args => Object.fromEntries(RUN_INPUT_FIELDS.filter(name => args[name] !== undefined).map(name => [name, args[name]]));

// The same discipline for the proposal operations: only the fields the caller
// actually stated, and only fields the operation accepts. A field that is not
// listed here never reaches the service, and a field that is listed reaches it
// exactly as sent -- the Application Service's own closed key set is what
// refuses an unknown one, so the two surfaces cannot drift into accepting
// different things.
const PROPOSAL_SUBMIT_FIELDS = [
  'idempotency_key', 'run_id', 'expected_run_revision', 'request_key', 'kind',
  'proposed_by', 'rationale', 'action', 'cites', 'unresolved_conflicts',
  'missing_evidence', 'canonical_warnings', 'expected_operation',
];
const PROPOSAL_RESOLVE_FIELDS = ['resolution', 'accepted_by', 'reason', 'expected_proposal_revision'];
const PROPOSAL_FILTER_FIELDS = ['run_id', 'request_key', 'state', 'kind'];

const pick = (args, fields) => Object.fromEntries(fields.filter(name => args[name] !== undefined).map(name => [name, args[name]]));
const proposalInput = args => pick(args, PROPOSAL_SUBMIT_FIELDS);
const proposalResolveInput = args => pick(args, PROPOSAL_RESOLVE_FIELDS);
const proposalFilter = args => pick(args, PROPOSAL_FILTER_FIELDS);

/**
 * Dispatch one `studio_*` tool to the Application Service.
 *
 * Every branch is a single call. There is no composition here, no fallback to
 * a second path, and no place a verdict could be recomputed: whatever the
 * Application Service returns is what the model sees.
 *
 * `compact` is a transport option, never a tool argument. The MCP transport
 * never sets it, so every MCP response is the bounded view. An in-process
 * caller with no result cap that keeps whole results in files -- the local
 * agent CLI (scripts/studio-agent.mjs), whose `--output`, receipts and export
 * promise the full Application Service result -- passes `compact: false` and
 * receives that result itself. Only an explicit `false` turns the view off.
 */
export async function runStudioTool(name, args, { application, owner, listen = null, compact = true }) {
  const page = args.report_page === undefined ? null : validateReportPage(name, args);
  const result = await dispatchStudioTool(name, args, { application, owner });
  // A page is read from the full result; any other MCP response is the bounded
  // view (mcp-compaction.mjs), whose summaries point back at those pages.
  const view = page ? readReportPage(result, page) : compact === false ? result : compactStudioResponse(name, args, result);
  // The one addition to a response: listen links for the prescreen's
  // human_review regions, beside the report and never inside it
  // (server/prescreen-listen.mjs). A page read is of the report itself, so
  // the links are added after the view is taken: inside the compacted result
  // a song-length report's links were summarized into a report_page pointer
  // at a path the report does not have, and every link was lost. They are
  // bounded on their own (PRESCREEN_LISTEN_LIMITS) and stay whole.
  if (name === 'studio_audio_prescreen' && !page && result?.prescreen?.human_review) {
    return { ...view, listen: await prescreenListenLinks(result.prescreen, { listen, mmlOf: prescreenMmlOf(args, { application, owner }) }) };
  }
  return view;
}

// The MML an alternative label names: the text it was given, or the Final
// artifact's delivered MML. A candidate alternative has none. The report
// names an alternative by the label the Application Service gave it, which is
// the caller's label or the positional default (A, B, C, D) when the caller
// gave none, so the lookup resolves labels the same way.
function prescreenMmlOf(args, { application, owner }) {
  return async label => {
    const entry = (args.alternatives ?? []).find((item, index) => (item.label ?? PRESCREEN_LABELS[index]) === label);
    if (typeof entry?.mml === 'string') return entry.mml;
    if (typeof entry?.artifact_id === 'string') {
      const { artifact } = await application.getArtifact(owner, entry.artifact_id);
      return typeof artifact?.mml === 'string' ? artifact.mml : null;
    }
    return null;
  };
}

async function dispatchStudioTool(name, args, { application, owner }) {
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
    case 'studio_final_reduction_plan':
      return application.planFinalReduction(owner, args.project_id, { candidateId: args.candidate_id, decisions: args.decisions ?? [], acceptedBy: args.accepted_by ?? null, instrumentProfile: args.instrument_profile ?? null });
    case 'studio_final_reduction_apply':
      return application.applyFinalReduction(owner, args.project_id, { candidateId: args.candidate_id, decisions: args.decisions ?? [], expectedPlanId: args.expected_plan_id, acceptedBy: args.accepted_by, instrumentProfile: args.instrument_profile ?? null });
    case 'studio_mobile_adaptation_plan':
      return application.planMobileAdaptation(owner, args.project_id, { candidateId: args.candidate_id, profile: args.profile ?? null, releaseRepresentation: args.release_representation ?? null });
    case 'studio_mobile_adaptation_apply':
      return application.applyMobileAdaptation(owner, args.project_id, { candidateId: args.candidate_id, profile: args.profile ?? null, releaseRepresentation: args.release_representation ?? null, expectedPlanId: args.expected_plan_id, acceptedBy: args.accepted_by });
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
    case 'studio_run_plan':
      return application.planRun(owner, args.project_id, runInput(args));
    case 'studio_run_start':
      return application.startRun(owner, args.project_id, runInput(args));
    case 'studio_run_status':
      return application.getRun(owner, args.project_id, args.run_id ?? null);
    case 'studio_run_next': {
      // Forward all non-address fields, so even an in-process caller cannot
      // hide a forbidden field by having the adapter silently discard it.
      const { project_id, run_id, report_page, ...input } = args;
      return application.nextRun(owner, project_id, run_id, input);
    }
    case 'studio_run_resume':
      return application.resumeRun(owner, args.project_id, args.run_id, runInput(args));
    case 'studio_proposal_targets':
      return application.proposalTargets(owner, args.project_id, args.run_id);
    case 'studio_proposal_submit':
      return application.proposeDecision(owner, args.project_id, proposalInput(args));
    case 'studio_proposal_status':
      // The same read the HTTP adapter serves as GET /proposals and
      // GET /proposals/:id. Without an id there is nothing to look up, so the
      // project's own filtered list is the answer.
      return args.proposal_id === undefined
        ? application.listProposals(owner, args.project_id, proposalFilter(args))
        : application.getProposal(owner, args.project_id, args.proposal_id);
    case 'studio_proposal_resolve':
      return application.resolveProposal(owner, args.project_id, args.proposal_id, proposalResolveInput(args));
    case 'studio_audio_prescreen': {
      const { project_id, report_page, ...input } = args;
      // With only a project id there is nothing to compare, so the project's
      // shadow calibration record is the answer, as a list read is for the
      // other status tools.
      if (project_id !== undefined && !Object.keys(input).length) return application.prescreenShadowStatus(owner, project_id);
      return application.audioPrescreen(owner, project_id ?? null, input);
    }
    case 'studio_prescreen_shadow_record': {
      const { project_id, ...input } = args;
      return application.recordPrescreenShadow(owner, project_id, input);
    }
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
