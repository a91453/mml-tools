# AI／MCP 歌曲流程：2026-09-20 缺陷查核

Status: IMPLEMENTATION NOTES。檢查起點 `71b5f08`，Canonical version
`2026-09-13-v1`，rules snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea`。
沒有修改 Canonical、放寬 agent policy 或部署正式服務。

## 本次確認並修正

### MCP 無法提交來源衝突清單

Application Service 接受 `unresolved_conflicts` 陣列；原 MCP schema 卻宣告
object。透過真正 `handleMcp` 的 regression 重現：合法陣列回 `-32602`；
HTTP 可提交，同一內容在 MCP 到不了 service。

schema 已改為 bounded object array，沿用 `LIMITS.maxProposalConflicts`。
內容仍由原 service 驗證；有衝突的 proposal 保持 `REQUIRES_MORE_EVIDENCE`，
接受仍回 `PROPOSAL_REFUSED`。沒有因修 transport 而把衝突當成已解決。

### 遠端回應超限會丟失已執行操作的結果

使用真實 MIDI 在獨立持久化測試專案執行 HTTP upload → MCP run_start →
MCP suggestion。upload 為 201、run 正常停在 awaiting_review；完整 suggestion
為 794,287 bytes，超過 MCP 的 524,288-byte 序列化結果上限。

另複製歌曲 store，僅在副本呼叫 MCP finalize：job 已由 3 筆增為 4 筆，
業務結果是 `FINALIZATION_BLOCKED`，但原回應只留下 `PAYLOAD_TOO_LARGE`，
job ID、candidate 與 blocked 原因都遺失。不能因此認定操作未執行或盲目重送。

超限回應現在保留 bounded recovery envelope：`operation_returned`、
`operation`／`result_code`（若有）、`result_references`、唯讀 `recovery_reads`，
並區分操作回傳與 gate 通過。只投影固定識別碼與欄位，不複製報告或任意內部資料。
canonical envelope 與原 512 KiB 上限保留。

第一個檢查點 `08f8826` 先保留可恢復的操作結果；後續補上既有唯讀工具的
`report_page`，每頁最多 16,000 UTF-16 code units。它輸出完整 JSON 的可拼接片段，
以整份報告的 SHA-256 綁定後續頁；report 或 Canonical provenance 改變即拒絕。
可用 JSON path 只讀需要的區段，但仍綁定完整報告。預設完整回應與網路上限都不變。

分頁先驗證操作類型與參數，再呼叫既有 service；禁止搭配 confirmations／refresh，
且不開放在 start／resume／resolve／finalize 等寫入操作上。每頁仍重新驗證 owner。
既有 artifact 的 MML 可經同一方式讀回；不需要新增工具、資料庫或模型 SDK。

這不是持久化快照：昂貴 plan 每頁會重算，宜使用 path 或本機完整報告輸出。
recovery 的 authenticated HTTP GET 也仍可取回已有 run／proposal／job／artifact。
兩種讀取方式都不會替未保存的 operation report 新建歷史 artifact。

### 退化音訊映射可能誤判 originalAudio PASS

對使用者音訊產生的原始 alignment report 做記憶體診斷，未寫入歌曲 store：
75 段控制點的 beat 增加但 seconds 相同，舊 validator 卻給空 warnings，
既有 audio gate 因此回 PASS。confidence 約 0.714、coverage 為 1 並不能排除這種退化。

validator 現在加上 `COLLAPSED_ALIGNMENT_INTERVAL` 警告，既有 gate 依 warnings
保持 `PENDING`／`AUDIO_ALIGNMENT_REVIEW_REQUIRED`。原控制點及 symbolic events
不變；沒有猜測 tempo 閾值、重寫音符或把對齊失敗改成成功。
真實報告複驗得到同樣 75 段，現在為 PENDING。這不代表已修好 DTW 對齊品質。

### 舊 MCP 初始化指引

initialize 原本只教直接 intake／apply／review／finalize，沒有 run／proposal
流程。已改為先 discover，再 run_start／status／proposal_targets／submit／resolve／
resume，明示不會背景持續執行、不得發明 reviewer evidence。
亦更正 HTTP technical route 的過時註解：MCP 的 `mml_validate` 已能呼叫 Canonical
technical service，並非只有 HTTP 可以技術驗證。

## 驗證與限制

- 完整 Node suite（含後續分頁修補）：1735 PASS／0 FAIL，退出 0，99.436 秒。
- Bootstrap isolation：198 次，單一 published identity／snapshot，shared refs 未改。
- MCP／proposal／audio adapter focused regressions：40 PASS／0 FAIL。
- 新分頁與 run 欄位契約 focused regressions：18 PASS／0 FAIL。
- Studio Web build：PASS；iPhone WebKit／iPad WebKit／desktop Chromium：全 PASS。
- Audio worker Python：6 PASS。這是 fixture regression，不是真實歌曲聽驗。
- `git diff --check`：PASS。
- Legacy `node scripts/build.mjs`：仍被本機缺少 `zip` 阻擋（`spawnSync zip ENOENT`）；
  不宣稱此 Worker bundle 已通過建置或部署驗收。
- 真實素材測試走的是實際 MCP／HTTP handler 的本機 Request；沒有連正式站驗收 OAuth。
- 原歌曲 record SHA-256 仍為
  `abb3d886dead6d5577254adeda91dcda82e2d3bd7385b704c57efcd4c7a821df`。

### 真實 MIDI 的完整分頁回讀

使用原《怪獣の花唄》MIDI 所建立的獨立 store，以及既有歌曲 store 的副本。
每個工具先取得完整 Application Service JSON，再經實際 `handleMcp` 逐頁讀取，
串接並比對完整文字、SHA-256 與 JSON 深度相等。這是報告資料傳輸的驗收，
沒有把「完整讀到報告」當成「報告中的音樂審查已通過」。

| 工具 | 完整 JSON bytes | 頁數 | 最大單次 MCP 回應 bytes | 結果 |
| --- | ---: | ---: | ---: | --- |
| arrangement suggestion | 794,287 | 50 | 47,455 | 完整一致 |
| Final Six-Role Reduction plan | 4,400,080 | 276 | 42,230 | 完整一致 |
| candidate review | 1,588,180 | 100 | 40,481 | 完整一致 |
| run status | 15,415 | 1 | 37,452 | 完整一致 |

最大單次回應包含 MCP 的 text／structuredContent 雙份 envelope。
原歌曲 record 的 hash 與測試前相同；副本 record 亦逐位元組未變。
量測及各完整報告 hash 保存在
[report-pages.json](evidence/mcp-agent-2026-09-20/report-pages.json)。
真實歌曲仍沒有 Final artifact，所以 Final MML 的分頁取得僅由既有
direct／HTTP／MCP fixture parity test 驗證；不可宣稱真實 MML 已生成。

## 仍需接通／判斷的部分

1. PWA 現在直接走 Web Worker，未與 Application Service 共用 project／run；
   網站按鈕、來源上傳與 agent continuation 還沒有同一條工作流。
2. MCP 本身不收 binary；host 需把附件交給既有 authenticated HTTP upload。
   舊 Sites worker 只暴露三個 technical tools，完整 Studio 在獨立服務入口。
3. 沒給 Mobile profile 時 run 會跳過 adaptation，而 Gate 8 request 只接受
   evidence_needed；不能藉此自行放寬 proposal policy 來補 profile。
4. 真實歌曲的 orphan NoteOff、角色來源證據、可靠錄音對齊與聽驗仍待處理。
   音訊演算法的根因未確認，不能把來源版本不合直接判為程式 bug。
5. 人工確認與 target-client acceptance 是既有必要邊界，不能用模型自行填 PASS。

尚無真實歌曲 MML，不宣稱整首歌、音樂品質或實機驗收完成。

原可恢復 run 仍為 `run_d24f9dfe1f1a2bdafe0474727b4f496b`，revision 12，
`awaiting_review`／`AWAITING_ACCEPTED_REDUCTION_DECISIONS`；保存在
`.studio-agent/real-song/store/`。本輪真實報告探測使用獨立 store 或其副本，
沒有替原專案填寫 confirmations、套用新決定或偽造 final artifact。
本輪再集中詢問目標究竟為 Piano MIDI 編曲還是 M4A 原版全樂隊編曲；
答案尚未提供，不能替使用者選擇版本。這個答案也不會自動解決 orphan NoteOff、
Lead 證據、聽驗或實機驗收。
