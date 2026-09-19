# 外部 agent 未完成事項與處理順序

Status: IMPLEMENTATION NOTES。不改 Canonical 或 Phase 2 接受政策。

| 優先級 | 工作 | 狀態／驗收條件 |
| --- | --- | --- |
| P0 | 附件上傳與同一個遠端 project/run 的外部 agent 操作 | `65b90d6` 已加入既有 CLI 的遠端 HTTP/MCP 模式；同一 OAuth owner、agent policy、分頁雜湊檢查與恢復規則。需營運者提供既有服務 origin/token 才能操作該部署。 |
| P0，與程式並行 | 真實歌曲版本、orphan NoteOff、Lead／角色來源證據、有效音訊對齊 | 等來源與使用者判斷；不能以程式改 PASS。原歌曲 run 保持 revision 12、awaiting_review，完整本機 store 未改。 |
| P1 | PWA 接 Application Service | 尚未實作。先加入明確的 service 專案入口及既有 OAuth 登入，讓上傳、run/status、proposal/review 同指 service project；保留既有本機 IndexedDB 專案，不自動搬移已接受歌曲。驗收需真實 MIDI 在 UI 上啟動後可由同一 MCP owner 讀到相同 run_id。 |
| P1 | Mobile profile 的必要輸入路徑 | 現有 Phase 1 無 profile 時跳過 adaptation；Gate 8 request 的 Phase 2 policy 只允許 evidence_needed。先由既有 reviewer 路徑補實際 profile／證據；若要新增 agent 可處理的「缺 profile」request，需明確審查流程／政策變更，不能把 Gate 8 request 偽裝成 adaptation refusal。 |
| P2 | 外部 agent dispatch／continuation | 網站啟動後把真實 project_id/run_id 交給外部 agent；用 revision、request_key、idempotency、proposal policy 前進。停在必要聽驗／人工判斷時回到相同候選；不得假稱網站目前會自行呼叫模型。 |
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

本次完整 Node suite：1738 PASS／0 FAIL，87.465 秒；199 次 bootstrap，單一
published identity／snapshot，shared refs 未改。CLI focused suite：12 PASS／0 FAIL。
沒有再更動 UI／音訊引擎，因此未重跑前一輪已通過的 browser／Python 測試。
