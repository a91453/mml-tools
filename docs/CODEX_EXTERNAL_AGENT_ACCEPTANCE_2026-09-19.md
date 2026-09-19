# Codex external-agent 真實歌曲紀錄 — 2026-09-19～20

Status: **INCOMPLETE — REAL_SONG_REVIEW_REQUIRED**。

使用者於 9/20 提供《怪獣の花唄》的鋼琴 MIDI ZIP 與 MV M4A 後，本輪已實際執行
intake、suggestion、proposal 提交與 agent 接受、保留來源的 candidate、G12 分析、
音訊對齊、candidate review 及 finalize 嘗試。**Final 被既有 gates 阻擋，沒有
歌曲 MML；音樂品質、聽驗與實機均未通過。** 不是端到端完成聲明。

操作方式見 [runbook](CODEX_EXTERNAL_AGENT_RUNBOOK.md)。
針對 `ecbbb46` 的後續 Code Review 修正與複驗，見
[9/20 修正紀錄](CODEX_EXTERNAL_AGENT_REVIEW_FIXES_2026-09-20.md)；下列初次驗收數字保留為歷史。

## 規則與現況查核

- 起點 `main`／更新後的 `origin/main`：`3b107d537ca1c0a183cbb059d8ddc1b9c6c389f3`，工作樹乾淨。
- 未發現適用的 `AGENTS.md`；依 repository 的 Manifest bootstrap skill 載入規則。
- 實際 bootstrap：`CANONICAL_LOADED`；version `2026-09-13-v1`／`PUBLISHED`。
- Manifest `2026-09-13-v1-manifest1`；manifest commit `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14`。
- rules snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea`；已讀快照中的四份規則、inventory 與 supporting evidence。
- 已核對 run/proposal/review/final service、MCP dispatcher 與相關 tests 的實際行為。
- 起初 repository／本機 Git 可見歷史無 MIDI。《瞬き》參考包明示 MIDI binary 未匯出，未改動該已接受歌曲。
- 沒有連接中的 Studio MCP tool；使用現有本機 Application Service。PWA 是獨立 Web Worker plane，未改部署。

## 真實素材

| 素材 | 實際內容 |
| --- | --- |
| ZIP | 使用者提供 `1-Kaiju_no_Hanauta__Vaundy_Piano.zip` |
| MIDI | `Kaiju_no_Hanauta__Vaundy_Piano.mid`，11,506 bytes；ZIP 另有 AppleDouble metadata，未當成 MIDI |
| MIDI SHA-256 | `58619209f743416fa2150471b079cc14796e92911000793fce98384603c18487` |
| MIDI asset | `ast_7d249fe5676954dd204b236b50399333`，`third_party_midi` |
| 音訊 | 使用者提供 `2-怪獣の花唄-Vaundy-MUSIC-VIDEO.m4a`，3,766,598 bytes |
| 音訊 SHA-256 | `35a05318c127248d9a391201847ee586e82df87b4755cdeb1ec33e4ceb98d061` |
| 音訊 asset | `ast_6a227cb940566e71be6f0ce51b45e665`，`original_audio`；這是用途分類，非檔名自證官方版本 |

MIDI 有兩個名為 Piano 的 track、1,545 個可解析 note events、7 個拆分 lane。
Tempo 為 150 BPM，含數個相同 BPM 的重複標記；meter 先 2/4，beat 2 起 4/4，
track 結束於 beat 546。來源真實度／整曲完整性尚待使用者核對。

原檔保持未修改。Decoder 發現 `ORPHAN_NOTE_OFF`：track 0、零起算 channel 1、
note 62、tick 258240、`track:0/event:1719`。因此 intake 的 `source_complete=false`。
`review-service` 也明確拒絕對有 unsupported source material 的 baseline 寫入
`source_complete=true`。本輪沒有改這項規則，沒有刪除此事件來製造 PASS。

## 實際 run 與階段

| 欄位 | 值 |
| --- | --- |
| local directory | `.studio-agent/real-song/` |
| owner／actor | `local:external-agent`／`agent:codex`；caller-supplied audit text，非身分認證 |
| project | `prj_d4048044eb6d84453c81191102d72830` |
| run | `run_d24f9dfe1f1a2bdafe0474727b4f496b`，revision `12` |
| state／halt | `awaiting_review`／`AWAITING_ACCEPTED_REDUCTION_DECISIONS` |
| baseline | `bas:5ba5e52f2bdb0c3711ecdeaf520f2d19241bed774dc5da1039aef59744219c2e` |
| candidate | `g11d:rev:2286584725fdce51365c260ffad93ac0918195817932b6ce7aff688c47bcd03c` |
| Final artifact／MML | null／null |

| 階段 | 真實執行結果 |
| --- | --- |
| Intake | 成功建立可追溯 baseline；仍有 1 個 unsupported note-off |
| Suggestion | 執行成功：7 lanes，5 pending；兩個交错的 Lead 候選、三個 competing bass 候選 |
| Source proposal | `pro_ffe3df41f7650ef7c9c03eb834568c5b`，提交後由 `agent:codex` 明確接受，續跑原 run |
| Arrangement proposal | `pro_178ea2681ed8191d6a8be62df000230b`，提交後由 `agent:codex` 明確接受 |
| Apply decisions | 成功保留全部 1,545 notes；7 個 KEEP 僅表示原事件不變，**角色仍為 null**，沒有把 PENDING 角色改成 confirmed |
| Final Six-Role Reduction | 只完成既有 plan 分析；1545 PENDING events 全數保留，17 overlap risks，Core3 incomplete；未套用 reduction |
| Mobile Adaptation | 未執行；尚無確定角色／實際 instrument profile，不自造 profile |
| Review | 在同一候選上另行實際執行；沒有任何 confirmation，未建立 store artifact；報告與 receipt 另存本機 |
| Finalize | 在同一候選上另行實際嘗試；`operation=blocked`、`FINALIZATION_BLOCKED`，沒有 artifact／MML |
| 音訊對齊 | 既有 audio worker 已完成實際 M4A alignment，但結果異常，沒有附加成 gate 證據 |

run 本身仍停在 G12；另外執行 review／finalize 是為了查明真實 blocker，沒有把
run 後續 step 偽記為 completed。KEEP retention revision 沒有宣稱完成角色編排。

Finalization blockers：`source`、`microTiming`、`core3Completeness`、
`originalAudio`、`playerReadback`、`mobileAdaptation`、`regression`。
其中 micro-timing 是 `MICRO_TIMING_STREAM_IDENTITY_UNRESOLVED`，Core3 musical
completeness 為 FAIL。source/audio/mobile/regression/in-game 保持 PENDING；
technical/player readback 為 NOT_RUN。

## 音訊證據的限度

實際 audio worker report 保存在 `.studio-agent/kaiju-alignment.json`：
trim range 約 0.093～229.738 秒，mean chroma similarity 約 0.714。
但 median local tempo drift 為 +115.33%，p95 absolute drift 為 761.33%；
beat 545 被映射至約 115.22 秒，beat 546 卻跳至 172.57 秒。
這不是可靠的節拍／段落對齊，不可由 similarity 分數推成聽驗或音樂正確。
本輪沒有附加此 report 來使 `originalAudio` gate 通過，也沒有以它指定 Lead。

## 停止、修復與使用者介入

1. 初始 run 缺 MIDI，停在 `SYMBOLIC_SOURCE_REQUIRED`。向使用者索取素材；已於 9/20 解決。
2. 來源 proposal 接受後，停在 `ARRANGEMENT_DECISIONS_REQUIRED`。Codex 接受有實際事件依據的 unchanged-retention 決策，沒有猜測 Lead。
3. retention candidate 產生後，停在 `REDUCTION_DECISIONS_REQUIRED`。目前未解決。
4. 額外 finalize 嘗試由 gates 拒絕；不是新的 run，也不是生成成功。

介面阻塞：suggestion 及 finalize 的完整報告超過 MCP 512 KiB wire cap，原路徑
回傳 `PAYLOAD_TOO_LARGE` 且沒有可縮小的參數。修復為本機 adapter 共用既有 MCP
schema checker／dispatcher、將完整回應與 receipt 保存於本機；**網路上限未放寬**。
本機服務沒有增加第二個音樂引擎或 gate policy。

使用者介入請求目前共 **2 輪**：第一輪索取 MIDI（已解決）；第二輪集中詢問
鋼琴 MIDI 是否為完整目標編曲，以及來源譜／已確認的 Lead 說明（2 個問題，待回覆）。
剩餘來源問題包括 orphan note-off 的可追溯修正；剩餘音樂證據包括可靠錄音對齊、
Lead/Core3、Gate 8／9、實際聽驗與實機。未以例行操作反覆索取批准。

目前的 evidence-needed proposal：`pro_c531a9dc6cc29be28571a6c546dff275`，
`PROPOSABLE`／`acceptable=false`／`NO_DOWNSTREAM_OPERATION`，描述上述缺口。
原缺素材 proposal `pro_0ac1ce02691962988a27deaa2d78c6d8` 保留為歷史。

## Agent 政策限制

五類 proposal 在符合其 open request、binding 與 evidence 條件後可取得
`REQUIRES_EXPLICIT_ACCEPTANCE`：source/candidate selection、arrangement、
final reduction、mobile adaptation。API 接受 caller-supplied named reviewer，
沒有實作人類限定或 proposer/acceptor 不同人的要求；本次授權以 `agent:codex`
記錄，沒有冒充使用者。

但 `NEVER_AGENT_SETTLABLE` 禁止 agent proposal 提供 confirmations、Lead reviewer
evidence、Core3 source-change approval、gate verdict 與 reconciliation。
這首 raw MIDI 沒有 authored roles；**首次 ASSIGN_ROLE 到 Melody 也算 promotion**，
需要來源綁定的 Lead evidence，且每個 Lead-affecting decision 限定單一事件。
因此一般「授權 agent 編曲」無法跨過此具體 policy 邊界。本輪沒有放寬或另走 API 偽造。

## 程式驗證

- 新 CLI regressions：6 項；使用合成素材，與歌曲驗收分開。包含跨程序恢復、agent identity、拒絕 review 捷徑、真正 emitter／round-trip、鎖、超過 wire cap 的完整報告。
- 最新 CLI／MCP／proposal transport 相關測試：46/46 PASS。
- 完整 Node suite + bootstrap isolation：最終修復後 **1719 PASS／0 FAIL／1 SKIP**，193 bootstraps、單一 published identity、單一 snapshot、shared refs 未改。
- Windows 初次 suite 出現 `sh` 缺失及暫存目錄 rename／cleanup 錯誤。使用現有 Git shell，並對 13 份既有儲存測試的 cleanup 加有限 `rm` retry；沒有略過斷言或改正式 store。
- Canonical bootstrap：CANONICAL_LOADED。
- Studio Web build：PASS。Browser regressions：iPhone WebKit／iPad WebKit／desktop Chromium 全 PASS。
- Audio worker：6/6 PASS；既有 pinned Python requirements 與 FFmpeg 僅安裝在忽略的本機工作目錄。一次 HTTP connection abort 的失敗紀錄保留，重跑通過；不把重跑隱瞞成從未失敗。
- Legacy build：仍 BLOCKED，主機無 `zip` executable（`spawnSync zip ENOENT`）。
- `git diff --check`：PASS。

合成 fixture 的 Final 串接由獨立 test reviewer seam 提供
`FIXTURE_CONFIRMATIONS` 後完成，technical／round-trip PASS、in-game PENDING。
真實歌曲完全沒有使用該 confirmations。Rashisa 等缺 source fixture 的命名回歸
仍為 `FIXTURE_PENDING`。

## 恢復與產出位置

```powershell
node scripts/studio-agent.mjs --data-dir .studio-agent/real-song --actor agent:codex call studio_run_status --input docs/evidence/codex-external-agent-2026-09-19/status-input.json
```

完整可恢復 state 在 `.studio-agent/real-song/store/`，逐次呼叫在 `receipts/`。
本機分析另有 `kaiju-suggestion.json`、`lane-events.json`、`kaiju-reduction.json`、
`kaiju-review.json`、`kaiju-alignment.json`、`kaiju-finalize-result.json`。
尚無歌曲 `.mml`，export 會如實拒絕。

分支內的 [project record snapshot](evidence/codex-external-agent-2026-09-19/project-record.json)
保存 run/proposal/asset/candidate 的 audit metadata，SHA-256：
`abb3d886dead6d5577254adeda91dcda82e2d3bd7385b704c57efcd4c7a821df`。
**它不是獨立可恢復的完整備份**；跨機器恢復必須連同本機 `store/` 的 blobs。
MIDI、M4A、完整 note payload 與本機依賴未提交 Git。不要把 metadata-only snapshot
當成已含歌曲。原本的缺來源 snapshot 已更新為本次實際歌曲的 metadata。

網站按一次持續執行仍缺：PWA 與 Application Service 共用專案／run 狀態、外部
agent 的 dispatch/continuation、大型報告的遠端分頁或檔案處理，以及真正 reviewer
證據接回同一候選的流程。本輪沒有新增模型 SDK、queue／資料庫、費用服務或正式部署。
