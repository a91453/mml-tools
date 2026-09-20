# 《怪獸之歌》執行 bug 與接續紀錄

使用者要求逐步記錄 bug；問題、診斷工具缺陷與環境阻礙分開列出。
分支 `codex/kaiju-final-mobile-review`。P0 尚未通過 Final；以下沒有替代音樂審查。

| ID | 步驟／類型 | 重現與影響 | 處理／狀態 |
| --- | --- | --- | --- |
| KAIJU-001 | MIDI intake／來源資料異常 | track 0/event 1719，channel 1/note 62/tick 258240 的 orphan note-off；該 channel 無 positive note-on，來源完整性仍 pending。 | **修正候選已驗證，尚未採用**。移除 delta=0 的四 bytes 並修正 chunk 長度；1,545 個音符與其餘事件保持相同。需新 asset/baseline 及 fresh review。 |
| KAIJU-002 | Audio alignment／演算法缺陷 | 舊DTW真實M4A＋MIDI有75個collapsed intervals，末beat546映到172.571s。單邊路徑能壓縮時間，且強制對齊錄音兩端。 | **時間壓縮機制已修復／歌曲聽驗仍待審查**。改用tempo-normalized subsequence DTW，兩軸都必須前進；真實重跑0個collapsed intervals，曲尾226.941s。未改音樂gate或自動接受新報告。詳見下方本輪修正。 |
| KAIJU-003 | 探索性分段診斷／本輪工具缺陷 | 初稿 `range(0, 544, 32)` 遺漏 beat 544–545.9979 的曲尾，造成段落檢查不完整。 | **FIXED**。改從真實 end beat 建立18段，包含最後不足32拍的區段；新增尾段與整倍數邊界測試。 |
| KAIJU-004 | 段落審查頁／手機排版 | 390px iPhone 上寬表格使「播放這段」直向折行，人工紀錄需橫向尋找。 | **FIXED**。小螢幕改逐段卡片；播放、紀錄框可直接操作。iPhone WebKit 重測、截圖檢查通過。 |
| ENV-001 | 完整 Node suite／環境依賴 | 首輪1813 PASS／5 FAIL；既有 Sites build 在本機找不到 `zip`。GnuWin32 zip 另有 Node stdout pipe 相容性問題。 | **本機解決**。驗證官方 SHA 後使用本機 MSYS2 zip＋既有 Git runtime，僅改 subprocess PATH；完整1818 PASS／0 FAIL。不是歌曲或新 profile 程式缺陷。 |
| KAIJU-005 | DTW修正回歸／librosa相容性 | librosa1.0.0在手動提供高矩形cost matrix且subseq=True時，仍交換回傳path兩欄；較快演奏因此觸發audio index out of range。 | **FIXED**。使用公開dtw_backtracking指定終點與step，保留score/audio座標；較短錄音與速度邊界回歸通過。未修改依賴套件。 |
| KAIJU-006 | 音訊來源追溯／Iterable重用 | `source_ids`傳generator時，渲染先消耗它，產出report時source_ids變空。 | **FIXED**。入口將Iterable保存為tuple；M4A end-to-end改用generator並核對report仍保留來源ID。 |

來源修正證據：[orphan-repair.json](evidence/kaiju-final-mobile-2026-09-21/orphan-repair.json)。
DTW 實際重跑摘要：[dtw-reproduction.json](evidence/kaiju-final-mobile-2026-09-21/dtw-reproduction.json)。
完整真實素材與 private review HTML 在忽略的 `.studio-agent/`，不加入 Git。

## 本輪取得的可核對進展

此節保留8f84920診斷工具階段的結果；後續KAIJU-002修正見下一節。

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

## 優先修正 KAIJU-002：時間軸壓縮

使用者要求這輪先修最高優先的bug。選擇KAIJU-002，因為錯誤時間定位會影響
下游Lead／角色與段落審查；KAIJU-001已有獨立修正候選，其餘原列問題已處理。

根因包括：樂譜使用beat frames、錄音使用STFT frames而缺乏共同時間刻度；
DTW允許單邊前進，能將多個beat映到同一瞬間；全路徑對齊還強制兩端配對，
將MV的前後片段拉入樂譜。高chroma分數與全frame coverage掩蓋了這種退化。

已修改預設audio worker（CLI與HTTP共用），不是另加一份成功的假設報告：

1. 積分來源tempo map，支援拍點之間的速度變化，再將兩側重取樣成相同時間刻度。
2. subsequence DTW允許錄音有未匹配的前後段，但要求完整score都有路徑。
3. 路徑只允許(1,1)、(1,2)、(2,1)，兩側都需前進；跳過的frame以正時間內插。
   每一步依消耗的score frames加權，減少跳過score造成成本偏低的問題。
4. 無可行完整路徑就回報錯誤，沒有退回舊演算法；未使用8.5秒或歌名作特例。
5. 限制最多2,500萬cost cells，較長輸入同步降低兩側取樣密度，actual interval記入method。
6. 後端保存method資訊；原有confidence／frame coverage警告仍有效，沒有放寬gate。

| 真實M4A重跑 | 修正前 | 修正後 |
| --- | --- | --- |
| collapsed beat intervals | 75 | **0** |
| beat 0映射 | 9.2415s | 8.4410s |
| beat 546映射 | 172.5707s | 226.9409s |
| median tempo drift | +115.33% | +4.44% |
| p95 absolute local tempo drift | 761.33% | 100% |

新版直接path frame coverage約0.708、confidence約0.456；它們保守地計算直接訪問，
不將內插frame算成直接匹配。完整score的映射span仍為1。新增span metrics僅供診斷，
沒有用它們替換既有gate metrics。局部tempo仍可能碰到搜尋邊界，因此不能把
「無停滯且全曲長度合理」說成beat級聽驗已完成。

在記憶體中將真實新report交給既有backend檢查，保留`LOW_ALIGNMENT_CONFIDENCE`、
`LOW_SCORE_FRAME_COVERAGE`，originalAudio仍PENDING；未附加到原store，也未寫confirmation。
原store完整inventory SHA與先前audit相同。

驗證：Python **18 PASS／0 FAIL**，新增已知定位的重複段落＋intro/outro、變速積分、
較快演奏座標、不可行速度比失敗、記憶體上限等回歸。M4A end-to-end新增實際拍點時間
容差檢查，取代舊測試把direct frame coverage誤當完整映射的斷言。
Node audio＋application pipeline＋finalize **43 PASS／0 FAIL**。
新舊報告摘要、程式SHA、完整report SHA、store一致性與警告见
[dtw-fix-verification.json](evidence/kaiju-final-mobile-2026-09-21/dtw-fix-verification.json)。

搜尋速度比0.5–2只是本演算法的限制，不是Canonical驗收閾值；缺少初始tempo、
同拍衝突tempo或超出可行範圍會明確失敗。新版source／角色／聽驗仍須人工證據。
現有constant-tempo diagnostic和審查頁仍可作獨立對照，原報告不被覆寫。
