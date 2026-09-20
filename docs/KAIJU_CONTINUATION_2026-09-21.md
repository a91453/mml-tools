# 怪獸之歌：修正來源接續與 agent 自動化

分支：`codex/kaiju-final-agent-continuation`；起點 `c3a16e0`。
Canonical `2026-09-13-v1` / snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea` 已重新載入。

## 實際歌曲進展

採用前輪已逐事件驗證的 orphan NoteOff 修正 MIDI，建立獨立、可恢復專案。
原 run revision 12 及其原始來源不被覆寫。修正依據是
[逐事件／byte 證據](evidence/kaiju-final-mobile-2026-09-21/orphan-repair.json)：
僅移除 delta=0、沒有對應 NoteOn 的四 bytes，1,545 個 sounding events 均保留。

- 新 store：`.studio-agent/kaiju-continuation/store/`，receipts 在同層 `receipts/`。
- Project：`prj_7ea81c9704d668ba58e05a7e269e47ce`。
- Run：`run_e0baf5f128de315b3a4556e546e16889`，revision 6。
- 修正來源仍標示 `third_party_midi`；M4A 仍是使用者指定的錄音參考。
- 新 baseline：`bas:315eb13d5b82f81a3a20d72986514bb2ee4bc3e70304199f693037b8fb4d7c0d`。
- Intake / suggestion 成功；目前 `AWAITING_ACCEPTED_DECISIONS`。
- 七條 lane 共 1,545 音；兩條競爭 Lead（192、209 音），三條競爭 Bass（206、268、235 音）。
- 音樂角色沒有被 heuristic 直接接受，尚無 Final MML。

新增唯讀工具 `scripts/studio-source-review.mjs`，從既有 Application Service 逐頁讀取
lane events，驗證無重複、無漏音，產生18段私有來源試聽頁，包含最後不足32拍的尾段。
可單獨播放各聲部、對照原始M4A、輸出綁定新baseline的人工筆記；頁面不送出
confirmations，沒有把試聽頁的功能測試當成人耳音樂判斷。

```powershell
node scripts/studio-source-review.mjs --data-dir .studio-agent/kaiju-continuation --project-id prj_7ea81c9704d668ba58e05a7e269e47ce --run-id run_e0baf5f128de315b3a4556e546e16889 --out .studio-agent/kaiju-continuation/review-next
```

輸出目錄必須不存在。實際產物：`.studio-agent/kaiju-continuation/review-next/index.html`。
原音、完整事件、store 均留本機；Git 僅保存程式與[摘要](evidence/kaiju-continuation-2026-09-21/source-review.json)。
本次 UI 驗證：Chromium 1280px／390px、18段／7聲部、尾段播放停止、下載筆記 binding、
無 JS 錯誤／橫向溢出；原音 metadata 時長232.849705秒。
另2項Node測試驗證尾段不遺漏及嵌入JSON不可注入script。

## 目前阻塞

首次把未分配音符指定為 Melody 就是 Lead promotion。現有 Phase 2 不允許 agent
自填 Lead reviewer evidence；Source Policy 也不允許以音高最高推斷其角色。
仍需可核對的分段 Lead／伴奏／Bass 判斷，才可接受角色並進入G12。
使用者已回答沒有額外角色樂譜或已確認的分段角色說明。G12、Mobile、候選review、Final及技術回讀尚未完成。

## 待修問題：使用者 MIDI 的候選輸出被正式驗收擋住

使用者追問「為什麼不能用我提供的 MIDI」。澄清：提供的 MIDI 已成功入庫，
修正版保留1,545音符，並可拆為7條聲部；檔案本身可以作為編曲依據。
先前把正式驗收阻塞描述成必須另找樂譜，混淆了候選製作與正式驗收。
不能要求使用者先購買或另找樂譜，才允許依其指定 MIDI 製作候選。

根因是目前 role-less MIDI 首次指派 Melody 也會觸發 Lead promotion；
`studio/backend/application/proposal-service.mjs` 明確拒絕 proposal 自填
`leadEvidence`。現有 agent 正確遵守這項限制，但來源編排到可試聽候選的路徑
尚未打通。這是產品流程缺口，不代表使用者 MIDI 無效。

下次優先修正及驗收：

1. 先檢查既有 candidate/render/export API，確認可重用的預覽路徑及實際阻塞位置，
   避免另造一套音樂引擎或直接繞過 Final gate。
2. 以使用者指定 MIDI 作編曲依據，提供明確標示未完成音樂審查的六軌候選 MML
   與試聽；不把第三方 MIDI 改標成官方來源。M4A 仍保留為已指定的錄音參考。
3. 保留原 baseline，記錄每個來源事件的保留、分配、移動、重複及容量不足情形。
   7聲部縮為6軌不得靜默刪音；音樂角色推斷必須明示為推斷。
4. 對候選執行語法、軌數、時間與事件對照回讀；技術PASS與角色／聽驗／Mobile／
   實機接受分開顯示。待審候選不得冒充 Final，也不得自填 reviewer evidence。
5. 用本曲實際走完候選製作及回讀，再接既有 review/finalize；若需更動正式規則，
   明確呈現規則差異，不把候選輸出需求當作已授權降低正式驗收標準。

本次僅保存問題與接續計畫，以上候選路徑尚未實作。PR保留Draft、不merge、不部署。
程式checkpoint `126f19b` 的 Studio CI、Studio service CI、OSS Export CI 均已通過；
本節為後續文件變更，不能把該次CI結果標成此文件commit的新執行結果。

## 網頁接續與驗證

本分支已完成可選的網頁自動 agent：明確勾選後啟動／審查提交會接續同一 run；
包含有限步數、停止、重複請求回讀、程序重啟停止、未知操作結果人工核對。
正式站未部署，模型預設關閉。設定及限制見 [操作說明](STUDIO_AGENT_CONTINUATION.md)。

[真實 Codex 紀錄](evidence/kaiju-continuation-2026-09-21/live-agent.json)：2次推論、
1次唯讀 suggestion 呼叫，因缺少正向角色證據而 waiting_review；run保持revision6、
沒有新提案或Final。此結果驗證 agent 能讀到實際阻塞，並未完成歌曲。

完整回歸1,831 PASS／0 FAIL（94.917秒、204次bootstrap、shared refs不變）。
首次回歸發現部署watch patterns漏列新增runner模組，補齊後全套通過。
另視覺檢查發現checkbox inline style受CSP阻擋，改放既有stylesheet後重跑瀏覽器。
桌面Chromium、iPhone/iPad WebKit全數驗證自動dispatch及啟動回應遺失後同run回讀。
瀏覽器使用合成來源和模型替身；其中Final回讀PASS不是本曲的Final回讀。
Studio Web build通過；[驗證摘要](evidence/kaiju-continuation-2026-09-21/validation.json)及
[瀏覽器紀錄](evidence/kaiju-continuation-2026-09-21/agent-browser.json)可公開，完整歌曲事件、原音、TLS key與auth仍留本機。
