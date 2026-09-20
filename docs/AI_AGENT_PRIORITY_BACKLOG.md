# 外部 agent 未完成事項與處理順序

Status: IMPLEMENTATION NOTES。不改 Canonical 或 Phase 2 接受政策。

| 優先級 | 工作 | 狀態／驗收條件 |
| --- | --- | --- |
| P0 | 附件上傳與同一個遠端 project/run 的外部 agent 操作 | `65b90d6` 已加入既有 CLI 的遠端 HTTP/MCP 模式；同一 OAuth owner、agent policy、分頁雜湊檢查與恢復規則。需營運者提供既有服務 origin/token 才能操作該部署。 |
| P0，與程式並行 | 《怪獸之歌》真實歌曲 Final | 9/21 已從最新 main 重跑完整 store 副本的來源診斷、G12、review、finalize，仍 `FINALIZATION_BLOCKED`。使用者確認M4A為準，鋼琴單人完整可演奏／多人增加音色。新增18段原音審查頁與固定速度對齊診斷；Lead／角色、可靠對齊與實際Mobile證據仍待補。已準備orphan NoteOff修正候選並證明1,545音符及其他解碼事件不變，尚未替換來源。原run revision12。見 [本輪驗收](KAIJU_FINAL_MOBILE_REVIEW_2026-09-21.md)及 [bug紀錄](KAIJU_FINAL_BUG_LOG_2026-09-21.md)。 |
| P1 | PWA 接 Application Service | 已加入 `/studio/` 服務工作區及 PWA 入口連結：OAuth、來源上傳、run/status、proposal 回讀、review、Final 下載。真實 MIDI 在 desktop Chromium、iPhone／iPad WebKit 全部完成 UI 啟動並由同 owner MCP 讀到同一 run；既有本機專案保留。程式與本機驗證完成，未部署正式站。 |
| P1 | Mobile profile 的必要輸入路徑 | 9/21 已接入 `/studio/` 既有 reviewer 路徑：逐角色實際 profile → 預覽 → 接受並 resume 同一 run → 新候選 Gate 8 review。無預填音域／音量；檢查 candidate、revision、staleness 與 evidence。三種 browser profile 驗證通過。Phase 2 policy 不變；真實歌曲尚缺實際輸入，正式站尚未部署此改動。 |
| P2 | 外部 agent dispatch／continuation | 已提供 UI 複製真實 service origin、project_id、run_id、revision 的接續資訊，與提案回到畫面的路徑。自動喚起／續跑外部 agent 尚未實作；現況需手動交接。仍以 request_key、idempotency 與既有 proposal policy 前進。 |
| P2 | 完整歌曲輸出與驗收 | 真實 source→decisions→G12→Mobile→review→finalize→MML，再驗證技術與事件回讀；音樂品質、聽驗、實機接受分開記錄。尚未完成。 |
| P3 | 大型唯讀報告效能 | 分頁已可完整回讀，但每頁重算。先使用 path 讀必要區段；若量測證明需要，再評估既有 store 上可失效的報告快照，不先建背景佇列／新資料庫。 |
| P3 | Legacy Worker build | 本機缺 zip；與現有 Studio Railway HTTP/MCP 入口分開處理，尚無該 bundle 建置／部署驗收。 |

遠端模式測試使用獨立 OAuth consent／PKCE／bearer 與實際 loopback HTTP server，
不是對正式部署登入。CLI regression 驗證合成 MIDI 上傳、run 重開、完整報告、
Unicode 檔名、禁止 confirmations、token 不落入 receipt、未知結果不重試。
真實 MIDI 的 [遠端驗證紀錄](evidence/mcp-agent-2026-09-20/remote-transport.json)：
11,506 bytes 的原 MIDI 經 authenticated HTTP upload，MCP intake／suggest completed；
794,287 bytes 完整建議回讀與 service 一致，同 start key 回同一 run。
新測試 run 停在 AWAITING_ACCEPTED_DECISIONS，沒有 final artifact。
這證明遠端傳輸入口可用，不代表歌曲、音樂品質或實機驗收完成。

最新完整 Node suite：1742 PASS／0 FAIL，87.089 秒；199 次 bootstrap，單一
published identity／snapshot，shared refs 未改。Studio Web build 通過；既有本機
browser regression、新服務合成 regression、真實 MIDI 服務測試各三種 profile 全部通過。
新增的 Docker allowlist regression 實際匯入 staged server 並讀取四個工作區資產；
發現並補齊原先遺漏的 `server/report-page.mjs`。本次沒有執行 Docker daemon build。
音訊引擎未變，未重跑 Python suite。操作、歌曲限制與證據見
[服務工作區](STUDIO_SERVICE_WORKSPACE.md)。
