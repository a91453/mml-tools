# 怪獸之歌：Claude Code 接手驗證與 Gate 4 推導修正（2026-09-23）

Status: IMPLEMENTATION NOTES（非 Canonical 規則來源；不發布新 Canonical）

分支：`claude/kaiju-handoff-verification-vqjba9`；起點 published main `adf73cf`。
Canonical `2026-09-13-v1`、rules snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea`、
Manifest commit `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14`，均自 published main 重新載入。
摘要證據：[verification-receipt.json](evidence/kaiju-handoff-verification-2026-09-23/verification-receipt.json)
（只含雜湊、身分、計數與衍生診斷；不含音源 bytes、完整服務匯出或任何審查結論）。

## 1. 接續的是原專案，不是替代品

- 交接包 36 檔 `VERIFY_PACKAGE.py` 全數通過；MIDI `5819c9c5…`、錄音 `35a05318…` 與服務素材清單一致。
- Claude Code 自己的 MCP connector 讀到同一 owner 的 `prj_a808b53c7cafadaf4c6bf5f0fe4c370a`、
  run `run_faf465f75ad72e943adba4832f88f931`（revision 16、`awaiting_review`）。30 個 Studio 工具可見，
  與 `adf73cf` 的 server 程式一致。本次**沒有任何 Studio 寫入**、沒有上傳、沒有 resume。
- 專案報告 `60d695f8…` 與 candidate review `5258bcc7…` 和交接包記錄相同：交接後狀態未變。

## 2. 證據匯出與逐位元重現

- 以 `report_page`（UTF-16 offset、`report_sha256` 綁定、串接後驗 `value_sha256`）匯出 run、run_next、
  proposal targets、11 份 proposal、7 個 job、Lead promotion／Lead evidence review、音訊歷史（兩份完整報告，
  `audioReportHash` 重算相符）及所有小型 review 區段；私有匯出留在本機，不進 Git。
- 以同一份程式（`adf73cf`）、交接 MIDI 與匯出的 298 筆決定，在**隔離的暫存 store**重建：
  baseline `bas:315eb13d…`（含 source/event digest）與 candidate `g11d:rev:fc3c9354…` 完全相同；
  再放入匯出的 reviewer 紀錄後，12,918,091 UTF-16 單位的完整 candidate review SHA-256 與正式服務
  `5258bcc7…` **完全一致**。這是驗證，不是 native store 備份或遷移。
- 重現工具：`scripts/studio-reproduce-review.mjs`（離線、不寫任何服務、工作目錄必須是新的）。

## 3. 交接資訊與先前主張的更正

| 交接／先前主張 | 實測 |
| --- | --- |
| Lead review 24 筆、pending 545 | 服務實存 **174** 筆（14:57–16:13 UTC）；Melody 569 → PASS 174／PENDING 395 |
| Lead review 以音訊 foreground 支持 | 16 筆明確 F0 數值中 11 筆在 MIDI 40–45（低音域）、voiced prob ≤0.13，對應 Melody 高 2–3 八度；只有開頭 3 筆在合理人聲音域。150 筆 CQT salience 無可重現的方法。依 SOURCE_POLICY §4、§6，這些不是正面 Lead 證據 |
| 每筆 Lead review 的 `core3: PASS` | 是紀錄內自填欄位，不是 Gate 4 結果 |
| Core3 缺 principal harmony | 實為評估器推導缺陷（下節）；Chord2 最低音佔比 99.61% 重現；「173/209」分母未定義，無法照原文重現 |
| micro-timing 1,282 UNKNOWN | 重現：全部是 note 之後恰好 1/480 拍（1 tick）的間隙；Melody 556／Chord2 640／Chord1 77／Chord3 9 |

另記：`source_complete` confirmation（15:36，evidence 0 筆）與 174 筆 Lead review 均由前一個 agent 工作階段寫入；
依 `studio_capabilities.never_agent_settable` 與 [2026-09-21 紀錄](KAIJU_CONTINUATION_2026-09-21.md) 的流程，
這類 reviewer 紀錄不應由 agent 自填。本次未修改或撤銷任何紀錄，交由擁有者決定。

## 4. 實作缺陷與修正：Gate 4 評的是沒人接受過的編曲

`evaluateCore3Completeness` 以來源聲部拆 lane。已接受的 G11-D 區段決定會讓同一個來源聲部在不同段落
擔任不同角色（本曲右手在各段分屬 Melody／Chord1／Chord3），這種 lane 帶有多個宣告角色，被讀成互相競爭，
評估器因此回報 `core3EventCount: 0`、Chord1 `ABSENT`——與候選實際的 1,419 個 Core3 事件不符。

修正：新增 `splitProjectRoleConsistentVoices`，只有當某聲部的事件帶有多個已指派角色時才再依角色拆分；
單一角色或無角色（所有 Source-Faithful Baseline）的聲部與原本完全相同（lane id 亦同）。不重新指派、
不合併、不量化、不刪音。Gate 4 評估器預設採用；呼叫端明確提供的 decompositions 仍照舊。

效果（同一候選，本機重現）：`evaluation: COMPLETE`、1,542 個 Core3 事件，但狀態仍為
`PENDING / CORE3_ENRICHMENT_DEPENDENCE_UNRESOLVED`——閘門沒有放寬。細查：Core3 在範圍內從未全靜音；
Lead 無伴奏的窗口只有 168 個 1/480 拍與 3 個 239/480 拍，後者沒有任何加花素材；只有 5 個 Chord3/Chord4
事件、且只在 1 tick 的窗口裡發聲，才使整條 lane（123 事件）被判為 essential。因此**候選不需要為 Gate 4
搬動角色**；剩下的是 reviewer 對這個 1-tick 現象的判斷，或 micro-timing 問題的解決。

## 5. Canonical Blocker Matrix（候選 `g11d:rev:fc3c9354…`，fresh）

| Gate | 狀態 | 類別 | 需要什麼 |
| --- | --- | --- | --- |
| source / baseline / core3 continuity / crossSourceHarmony / versionDrift / pendingDecisions | PASS | — | source 的 confirmation 為 agent 寫入，擁有者可覆核 |
| core3Completeness | PENDING | 推導缺陷（已修於本分支，待合併部署）→ 之後為 reviewer 判斷 | 部署修正後，由人以證據記錄 `core3_completeness_reviewed`，或先解決 1/480 間隙 |
| microTiming | PENDING（1,282 UNKNOWN） | Canonical 未決 | 對「note 後 1 tick 間隙」的分類權威（trusted producer attestation 或更強的來源／實機時間證據），**以及**是否允許延長 note release 1/480 拍的 Canonical 決定；兩者皆非 agent 可自行認定 |
| leadPromotion | PENDING（395） | 缺主要證據／人耳 | 逐段可核對的 Lead 判斷（人耳或主要來源）；174 筆既有 PASS 依據不足，建議擁有者覆核 |
| originalAudio | PENDING（低信心警告） | 需審查／更佳對位 | reviewer 審查或保留原警告的正當修訂；現行守門在有 reviewer 紀錄時拒絕修訂 |
| technical / playerReadback | NOT_RUN | 依序阻塞 | 前述 gate 解決後才可 finalize 與實際回讀 |
| mobileAdaptation（Gate 8）/ regression（Gate 9） | PENDING | 需人審 | 候選綁定、附證據的審查；具名回歸仍為 FIXTURE_PENDING |
| in_game | PENDING | 僅使用者 | 實機驗收 |

旁註（未修改）：`audioGate` 只要有音訊證據且無警告即 PASS，沒有要求 Gate 7 所列的角色／突出度等審查；
這比 ACCEPTANCE_CRITERIA Gate 7 寬，建議另案評估，不在本 PR 變更。

## 6. 驗證

- `node --test tests/*.test.mjs studio/tests/*.test.mjs`：1,940 通過、0 失敗（含 3 個新 Gate 4 回歸測試；
  移除修正後其中 2 個會失敗，證明測試確實覆蓋缺陷）。
- 重現工具在 `adf73cf` 程式上得到與正式服務相同的完整 review 雜湊；在本分支上只有
  `core3_completeness` 與 `readiness` 兩個區段改變。
