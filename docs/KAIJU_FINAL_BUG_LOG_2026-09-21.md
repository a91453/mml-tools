# 《怪獸之歌》執行 bug 與接續紀錄

使用者要求逐步記錄 bug；問題、診斷工具缺陷與環境阻礙分開列出。
分支 `codex/kaiju-final-mobile-review`。P0 尚未通過 Final；以下沒有替代音樂審查。

| ID | 步驟／類型 | 重現與影響 | 處理／狀態 |
| --- | --- | --- | --- |
| KAIJU-001 | MIDI intake／來源資料異常 | track 0/event 1719，channel 1/note 62/tick 258240 的 orphan note-off；該 channel 無 positive note-on，來源完整性仍 pending。 | **修正候選已驗證，尚未採用**。移除 delta=0 的四 bytes 並修正 chunk 長度；1,545 個音符與其餘事件保持相同。需新 asset/baseline 及 fresh review。 |
| KAIJU-002 | Audio alignment／演算法限制 | 用目前 DTW 重跑真實 M4A＋MIDI，可重現 75 個 collapsed intervals。coverage=1、confidence≈0.714，但末 beat 546 映到172.571s、局部 tempo drift p95≈761.33%。全路徑 DTW 能以壓縮／重複匹配取得高色度分數。 | **OPEN；已有 gate 防護**。既有 backend 的 `COLLAPSED_ALIGNMENT_INTERVAL` 保持 pending。新工具提供獨立固定速度診斷與聽驗入口；未修改原 DTW，也未將新假設當成接受的對齊。 |
| KAIJU-003 | 探索性分段診斷／本輪工具缺陷 | 初稿 `range(0, 544, 32)` 遺漏 beat 544–545.9979 的曲尾，造成段落檢查不完整。 | **FIXED**。改從真實 end beat 建立18段，包含最後不足32拍的區段；新增尾段與整倍數邊界測試。 |
| KAIJU-004 | 段落審查頁／手機排版 | 390px iPhone 上寬表格使「播放這段」直向折行，人工紀錄需橫向尋找。 | **FIXED**。小螢幕改逐段卡片；播放、紀錄框可直接操作。iPhone WebKit 重測、截圖檢查通過。 |
| ENV-001 | 完整 Node suite／環境依賴 | 首輪1813 PASS／5 FAIL；既有 Sites build 在本機找不到 `zip`。GnuWin32 zip 另有 Node stdout pipe 相容性問題。 | **本機解決**。驗證官方 SHA 後使用本機 MSYS2 zip＋既有 Git runtime，僅改 subprocess PATH；完整1818 PASS／0 FAIL。不是歌曲或新 profile 程式缺陷。 |

來源修正證據：[orphan-repair.json](evidence/kaiju-final-mobile-2026-09-21/orphan-repair.json)。
DTW 實際重跑摘要：[dtw-reproduction.json](evidence/kaiju-final-mobile-2026-09-21/dtw-reproduction.json)。
完整真實素材與 private review HTML 在忽略的 `.studio-agent/`，不加入 Git。

## 本輪取得的可核對進展

以實際提供的 M4A 為準，記錄鋼琴單人可完整演奏、多人補充音色的目標。
新增 `python -m mml_audio_worker.diagnostic`，所有 note 保持原調；
以來源150 BPM，在明示範圍搜尋 offset/time scale，結果為約8.5秒／1.0。
全曲 mean chroma similarity 約0.613，僅代表這個搜尋範圍內的最佳假設。
不應與 unrestricted DTW 的0.714直接比較為品質分數；兩者路徑自由度不同。

- beat 32–64：全曲假設21.3–34.1s；局部最佳offset −4.3s，比全曲少12.8s，
  恰為32拍，提示重複段落歧義。局部similarity0.584，全曲位置0.569；需人工定位。
- beat 544–545.9979：全曲假設226.1–226.8992s；約0.8秒尾段局部最佳offset6.5s，
  與全曲8.5s不同，短段色度不足以確認終止位置。
- 其餘16個32拍區段的局部最佳offset為8.4–8.6s。這仍不是聽驗或Lead身份證明。

[可重現完整診斷](evidence/kaiju-final-mobile-2026-09-21/tempo-alignment-diagnostic.json)
保存audio/project SHA、搜尋範圍與所有18段結果。報告採獨立schema，不能提交為
既有audio-alignment gate證據。頁面播放原始M4A並下載人工筆記，不提交任何confirmation。

## 重跑

使用已安裝的 audio-worker requirements 與 FFmpeg，從 repository root：

```powershell
$env:PYTHONPATH = (Join-Path (Get-Location) '.studio-agent/python-deps') + ';' + (Join-Path (Get-Location) 'studio/audio-worker')
$env:PATH = (Join-Path (Get-Location) '.studio-agent/bin') + ';' + $env:PATH
python -m mml_audio_worker.diagnostic --audio .studio-agent/kaiju-piano-review/reference.m4a --project .studio-agent/source-project.json --out .studio-agent/kaiju-piano-review-next --review-context '鋼琴單人可演奏；多人演奏增加音色。'
python -m unittest discover -s studio/audio-worker/tests -v
node studio/browser-tests/audio-diagnostic.mjs .studio-agent/kaiju-piano-review-next
```

本機 Python 可執行檔在 Codex bundled runtime，若系統沒有 `python`，以其完整路徑替代。
輸出目錄不可存在；失敗的輸出可能留下部分private檔案，重跑請用新目錄。
重現原DTW使用 `python -m mml_audio_worker.cli align`，傳入同一audio/project及來源
`midi:sha256:58619209f743416fa2150471b079cc14796e92911000793fce98384603c18487`。

## 驗證與後續停止點

- Python **12 PASS／0 FAIL**，含原M4A end-to-end、HTTP boundary及6個新診斷測試。
- 既有audio gate測試 **7 PASS／0 FAIL**；另實際確認新的diagnostic schema不能被當作
  audio-alignment report接收。機器可讀結果見
  [diagnostic-validation.json](evidence/kaiju-final-mobile-2026-09-21/diagnostic-validation.json)。
- 真實M4A review HTML：desktop Chromium／iPhone WebKit播放曲尾、定點停止、
  記錄下載與SHA回讀均PASS；18段均顯示。這是播放器功能驗證，不是人耳聽驗。
- 此輪只改診斷工具、其tests、browser harness與紀錄；先前Node1818項完整驗證仍屬
  P1/audit那次程式狀態，沒有把它說成新Python程式的驗證。
- 原run仍為revision12，等待accepted reduction；Final blocker清單見
  [歌曲驗收](KAIJU_FINAL_MOBILE_REVIEW_2026-09-21.md)。下一步是依原音確認段落定位、
  Lead／角色證據，才可接受G12並做Core3/候選試奏與Gate8。
- 診斷後再次執行store副本的Final audit，仍`FINAL_NOT_VERIFIED`，原store完整inventory
  SHA與第一次audit相同；[第二次audit](evidence/kaiju-final-mobile-2026-09-21/final-audit-after-diagnostic.json)
  保存此輪程式HEAD與結果，沒有Final artifact或MML。
- reviewer需提供實際判斷；遵循既有runbook的「不要改用直接 Application Service
  呼叫，將 agent 自己的推論包裝為 reviewer 證據」。目前沒有足夠證據自行填true。

額度策略：執行期間讀取實際用量；任一五小時／每週窗口剩餘≤10%時，先提交已驗證
工作與接續紀錄，再push目前分支。非active turn沒有背景監看。禁止把M4A/MIDI、
完整來源事件、暫存store、金鑰或依賴環境加入checkpoint。
