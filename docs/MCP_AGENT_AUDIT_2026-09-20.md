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

**這一修補尚未提供完整大型報告分頁。** 遠端純 MCP agent 仍需該能力；
目前 recovery 的 authenticated HTTP GET 可取回已有 run／proposal／job／artifact，
並不會替未保存的 operation report 新建 artifact。MCP-only 全程完成仍有此缺口。

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

- 完整 Node suite：1728 PASS／0 FAIL，退出 0，87.272 秒。
- Bootstrap isolation：197 次，單一 published identity／snapshot，shared refs 未改。
- MCP／proposal／audio adapter focused regressions：40 PASS／0 FAIL。
- Studio Web build：PASS；iPhone WebKit／iPad WebKit／desktop Chromium：全 PASS。
- Audio worker Python：6 PASS。這是 fixture regression，不是真實歌曲聽驗。
- `git diff --check`：PASS。
- 真實素材測試走的是實際 MCP／HTTP handler 的本機 Request；沒有連正式站驗收 OAuth。
- 原歌曲 record SHA-256 仍為
  `abb3d886dead6d5577254adeda91dcda82e2d3bd7385b704c57efcd4c7a821df`。

## 仍需接通／判斷的部分

1. 大型 suggestion／reduction／review／artifact 的 bounded MCP 讀取。
2. PWA 現在直接走 Web Worker，未與 Application Service 共用 project／run；
   網站按鈕、來源上傳與 agent continuation 還沒有同一條工作流。
3. MCP 本身不收 binary；host 需把附件交給既有 authenticated HTTP upload。
   舊 Sites worker 只暴露三個 technical tools，完整 Studio 在獨立服務入口。
4. 沒給 Mobile profile 時 run 會跳過 adaptation，而 Gate 8 request 只接受
   evidence_needed；不能藉此自行放寬 proposal policy 來補 profile。
5. 真實歌曲的 orphan NoteOff、角色來源證據、可靠錄音對齊與聽驗仍待處理。
   音訊演算法的根因未確認，不能把來源版本不合直接判為程式 bug。
6. 人工確認與 target-client acceptance 是既有必要邊界，不能用模型自行填 PASS。

尚無真實歌曲 MML，不宣稱整首歌、音樂品質或實機驗收完成。
