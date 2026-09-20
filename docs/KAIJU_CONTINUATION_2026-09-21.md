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

輸出目錄必須不存在。實際產物：`.studio-agent/kaiju-continuation/review/index.html`。
原音、完整事件、store 均留本機；Git 僅保存程式與[摘要](evidence/kaiju-continuation-2026-09-21/source-review.json)。
本次 UI 驗證：Chromium 1280px／390px、18段／7聲部、尾段播放停止、下載筆記 binding、
無 JS 錯誤／橫向溢出；原音 metadata 時長232.849705秒。
另2項Node測試驗證尾段不遺漏及嵌入JSON不可注入script。

## 目前阻塞

首次把未分配音符指定為 Melody 就是 Lead promotion。現有 Phase 2 不允許 agent
自填 Lead reviewer evidence；Source Policy 也不允許以音高最高推斷其角色。
仍需可核對的分段 Lead／伴奏／Bass 判斷，才可接受角色並進入G12。
G12、Mobile、候選review、Final及技術回讀尚未完成。網頁agent自動化仍在本分支續作。
