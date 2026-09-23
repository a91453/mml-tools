# 第三方前端「MML 工房」融合分析：新介面與新邏輯

Status: 實作筆記（non-Canonical）
Date: 2026-09-23

本文件**不是**規則來源，也不是 `SOURCE_POLICY.md` 所定義的任何證據類別。規則載入唯一入口仍是
[`docs/CANONICAL_MANIFEST.md`](CANONICAL_MANIFEST.md)。本文只盤點：使用者提供的前端擷取包裡，
哪些行為、設計概念與程式碼值得吸收進本 repo，形成新介面與新邏輯；哪些必須拒絕。
擁有者授權後可以直接移植的部分，見 §11。
本文沒有新增、修改或解釋任何 Canonical 規則；文中提出的 PENDING 候選項都只是提案，尚未寫入
`docs/PENDING.md`。

---

## 0. 來源、授權與邊界

| 欄位 | 值 |
| --- | --- |
| 檔案 | 前端擷取包（任務附件；檔名與雜湊不記錄於公開 repository） |
| 內容 | 公開前端擷取 v1.1.0，112 個檔案：72 個站方 JS 模組、CSS、4 語系 shell／manifest、公開說明頁、vendor 函式庫、音色庫與 `.def` |
| 自述 | 「Third-party. Not Canonical. Do not copy into studio/.」 |
| 不含 | ASP.NET／C#／資料庫、`/api/*` 回應、登入頁、使用者分享樂譜 |
| 參照驗證狀態 | `MML_MABI_REFERENCE_NOT_VERIFIED`：擷取檔不能證明與正式站行為一致 |

**授權處理。**

- 初版分析（§1–§10）沿用 `docs/G11B_CLEANROOM.md`、`docs/FINAL_MML_EMITTER.md` §2、
  `docs/TIMBRE_PROFILE_RESEARCH.md` 的 clean-room 慣例：只記錄行為，並獨立重寫。
- 同日，repo 擁有者澄清兩點：
  - 擷取包 README 的「Do not copy into studio/」是擁有者本人為了防止他人複製而寫的；
  - 擁有者完整授權本 repo 使用這份前端。
- 因此前端**站方自有程式碼**的著作權限制已經解除，可以直接移植，分級見 §11。

仍然存在的限制：

1. **技術限制，與授權無關。** 對方的資料模型是 PPQ 480 整數 tick 加上浮點秒，而且有多處有損處理（見 §5）。這與 Canonical 的精確有理數時間、來源完整保存直接衝突，所以資料層仍然必須改寫。
2. **擁有者授權涵蓋不到的第三方元件。** 例如 SpessaSynth、lamejs、Font Awesome、音色庫，詳見下表。
3. **MIT 公開。** `scripts/export-oss.mjs` 會把整個 `studio/`、`dist/core.js` 與 `dist/player.js` 以 MIT（`oss/public/LICENSE`）匯出公開。移植進這些路徑的程式碼也會以 MIT 公開，這需要擁有者決定（§11.5）。
4. **註解中的 canary 字元。** 站方註解中散落與上下文無關的單個 CJK 字元（例如「竹」「卜」「月」「日」「水」「女」），看起來是擁有者放的指紋或 canary。移植時應該去除，或把註解改寫成摘要。

**Vendor 授權調查結果**（以 npm 上游 tarball 比對；只作為未來決策依據，本次沒有加入任何相依）：

| 檔案 | 比對結果 | 授權 | 結論 |
| --- | --- | --- | --- |
| `vendor/spessasynth_core.js`、`spessasynth_processor.js` | 與 `spessasynth_core@4.3.16` 在忽略空白後 diff 為 0 | Apache-2.0（上游 LICENSE），內含 stb_vorbis | 若採用，須從 npm 取得並附 NOTICE；擷取包本身沒有附 LICENSE |
| `vendor/spessasynth_lib.js` | 與 `spessasynth_lib@4.3.12` 在忽略空白後 diff 為 0 | Apache-2.0 | 同上 |
| `vendor/lamejs.js` | 與 `@breezystack/lamejs` 1.2.5–1.2.7 相同 | LGPL-3.0 | 拒絕：WAV 已足夠 |
| `vendor/fontawesome/*` | 檔頭寫明 Free 7.3.1 | 圖示 CC BY 4.0、字型 SIL OFL 1.1、程式 MIT | 不需要 |
| 音色庫（`.dls`／`.def`） | 已於 `TIMBRE_PROFILE_RESEARCH.md` 研究 | 第三方素材，不在本 repo 授權範圍 | 不提交；不能當證據；只用本機上傳（§13） |

**方法。** 七份唯讀平行分析：MML 核心、匯入轉換、音訊與混音、鋼琴捲軸、瀑布與影片、App
殼層／儲存／分享、repo 現況。每一項都以 A／B／C／D 分類：

- **A**：採用概念，獨立重寫；
- **B**：依 Canonical 改寫後採用；
- **C**：repo 已有更好的做法；
- **D**：拒絕。

會影響結論的幾個關鍵說法，已直接對照 repo 原始碼核實：

- Nxx 偏移：`studio/backend/mml/parser.mjs` 的 `n` 分支與具名音高公式；
- emitter 的 `&` 與 `l` 順序：`studio/backend/final/mml-emitter.mjs` 的 render 迴圈；
- `studio/web/sw.js` 的 precache 方式；
- `studio/web/storage.mjs` 的 `listProjects()` 實作；
- `studio/web/app.mjs` 中「刻意不是 arrangement editor」的註解；
- Studio 的 CSP。

---

## 1. 一頁結論

1. **介面缺口最大：Studio Web 目前沒有任何視覺化、播放或編輯。**
   - 除了 Final 與 per-role 貼上框外，全部是表格與可展開的 JSON 區塊。
   - 唯一的捲軸是舊 Workbench 的 `drawRoll`：唯讀、以浮點投影、高度固定。
   - 第三方前端最成熟的部分正好補這一塊：虛擬化 canvas 捲軸、觸控手勢、純函式繪圖、決定性渲染。
   - 融合後的新介面是**「六角色審核捲軸」**：
     - 唯讀；
     - 時間以精確有理數投影；
     - 標出 Lead／Core3、15 對重疊、Harmony 衝突與 drift；
     - 所有「編輯」都變成 G11-D decision draft，必須另外明確接受。
2. **邏輯上最重要的發現：Nxx 與具名音高可能差 12 個半音。**
   - 對方定義 `n0 = o0c = MIDI 12`，所以 `n48 = o4c`。
   - repo 目前的解析：
     - `Nxx` 直接當 pitch，也就是 `N60 = o4c`；
     - 具名音高依 `12*(octave+1)+…` 計算，`o4c = 60`，`o8` 高於 107。
   - 值得注意：官方「pitch 0–107」共 108 個值，**恰好**等於在對方假設下 `o0c`–`o8b` 的範圍。
   - 這只是社群證據（class F），不能直接改規則。但它是一個有明確判別方法的假設，值得列為
     PENDING 候選，用實機 A/B 驗證 `o4c`、`n48`、`n60` 三者。
3. **G11-A 當時因連線被擋而無法回答的問題，現在都有答案**（§6）。
   - 答案大多確認 repo 的無損設計較嚴謹；
   - 同時補出幾個值得做的診斷，例如同時起音分散、texture 比率、MusicXML repeat／volta。
4. **大量設計屬於 D。** 包括：
   - 60-tick 量化、八度折疊、全曲 tempo 合併、unison 合併、slur 當 tie；
   - 最高聲部等於 Melody、雲端分享與存檔、把擷取包內的音色庫放進 repo；
   - 環境音、殘響與空間化；
   - 開啟就自動提交的 nudge。
   這些都與 `MASTER_RULES` 或 `SOURCE_POLICY` 衝突。
5. **低成本、低風險、可以馬上做的：**
   - Studio service worker 強化：precache 繞過 HTTP 快取，並補齊 update 偵測；
   - Nxx 對應常數顯式化，加上 fixture；
   - Final MML 語法高亮與 per-role 字數條；
   - emitter tie 段數上限改由最長音符推導。

---

## 2. 能力對照

| 能力 | 第三方前端 | repo 現況 | 融合方向 |
| --- | --- | --- | --- |
| 鋼琴捲軸 | 虛擬化 canvas、15 軌疊圖、觸控、完整編輯 | 舊 Workbench 唯讀 `drawRoll`；Studio 沒有 | 新 UI-1／UI-2／UI-3（唯讀＋提案式） |
| 瀑布視覺化 | 純函式 `draw(t)`、決定性、12 種樣式 | 無 | 吸收架構，不吸收裝飾（UI-1、UI-6） |
| 影片匯出 | WebCodecs H.264＋AAC、自寫 MP4 writer | 無 | 選配 UI-10（無聲、有標示） |
| 播放 | SpessaSynth＋DLS 取樣 | 舊 Workbench 有程序合成與回讀；Studio 沒有 | UI-5：移植 repo 自己的 player |
| 離線渲染 | Worker＋OfflineAudioContext，WAV／MP3 | 無 | LG-7：WAV＋provenance sidecar |
| 響度 | BS.1770 積分響度 | 無 | LG-7：只用於 A/B 等響度比較 |
| MML 高亮 | 單一 lexer，逐字元角色陣列 | 無（textarea 唯讀） | UI-4、LG-2 |
| 字數計數 | 去空白後計算，超過變紅，從不截斷 | emitter 有權威計數；貼上前沒有即時顯示 | UI-4（保留 P1 未驗證標示） |
| MIDI 匯入 | 有損（量化、截長、合併） | G11-A 無損 | C；補診斷（LG-4） |
| MusicXML 匯入 | OMR 導向：repeat 展開、tie／slur、容錯 | 未壓縮 score-partwise；遇錯即 throw；不處理 repeat | LG-3 |
| 3MLE `.mml`／`.mmi` | 可匯入匯出，含 bzip2 擴充區塊 | 會變成 JSON 解析錯誤 | LG-6 |
| 分享／存檔 | 伺服器 GUID、Google 登入 | 無（刻意不設預設雲端） | D；改為本機 fragment snapshot（UI-9） |
| 歌曲庫 | IndexedDB，metadata 與 data 分開存 | IndexedDB，但列表會載入整個 workspace | UI-8 |
| PWA | `cache:'reload'`、三路 update 偵測、明確套用更新 | 只用 `addAll`、只偵測 `updatefound` | UI-8（S） |
| i18n | 繁中／英／日／韓各 723 鍵，有對等測試 | 只有繁中，字串寫死 | UI-9 |
| 主題 | 深／淺 token、首繪前套用、canvas token bridge | 只有淺色 | UI-7 |

---

## 3. 新介面提案

編號順序即建議優先序。工作量：S = 小、M = 中、L = 大。

### UI-1 六角色審核捲軸（Review Roll） — M

- **吸收自：** `pianoroll.js` 的 sticky canvas＋spacer 虛擬化與可見範圍裁切；`waterfall.js` 的「一個純
  `draw()` 同時供預覽、匯出與縮圖使用」、版面隨 (W,H) 線性縮放、決定性測試（把
  `Math.random`／`Date.now` 換成會 throw 的函式）。
- **融合後：**
  - 新增 `studio/web/roll-geometry.mjs`：純函式，可以在 `node --test` 執行。
    - 精確有理數 beat 在繪圖當下才投影成 px，px 永遠不回流到資料；
    - 點擊命中回傳 **event ID**，不回傳時間。
  - 新增 `studio/web/roll-view.mjs`：
    - Melody／Chord1／Chord2（Core3）實心，Chord3–5 空心；
    - pending、unassigned、unsupported 用斜線填滿；
    - 缺角色時就地標示，不補假資料。
  - 疊加層：
    - 15 對 overlap；
    - Harmony（同音、m2、M7、m9）；
    - Lead 交接缺口；
    - voice-split 重疊。
  - 疊加層一律畫成琥珀色的**審核訊號**，不畫成紅色的「錯」，因為 `MASTER_RULES` §6 規定重疊是審核訊號，不是刪除目標。點擊後開啟 `app.mjs` 既有的仲裁表單。
  - 格線從 meter map 與可見範圍內分母的最小公倍數推導，**只顯示、從不 snap**。
- **落點：** `studio/web/app.mjs` 第 04 節；新模組加入 `scripts/build-studio-web.mjs` 的 precache 清單。
- **不做：** 對方的 88 鍵折疊、短音丟棄（`MIN_DUR`）、最小音高下限、只畫前 6 軌。極短音與超出範圍的音改用標記呈現。

### UI-2 Drift／Lineage 疊圖＋全曲縮圖 — S（在 UI-1 之後）

- 資料來自既有的 `compareCanonicalVersions`／`compareCandidateLineage`：
  - baseline 畫虛線、candidate 畫實線；
  - 角色移動畫連接線；
  - added／removed／octave／duration 各用一種顏色。
- 縮圖沿用 waterfall「縮圖用同一個 `draw` 加裁切 transform」的做法，呈現整首歌的衝突與 drift 密度。

### UI-3 Decision Composer（選取 → G11-D 草稿） — L

- **吸收自：** 選取模型：
  - marquee 取代選取、Ctrl 以按下當下的快照追加；
  - 移除「永遠追加」，避免畫面外有看不到的選取。
- **吸收自：** 右鍵選單「停用時一定說明原因」。
- **吸收自：** `overwriteEffect` 的「放開之前先預覽損害」。
- **融合後：**
  - 選取 event ID 後，選單提供 ASSIGN_ROLE／MOVE_ROLE／OMIT_FROM_SIX／DUPLICATE_WITH_JUSTIFICATION，產生 **draft**；
  - 預覽以 dry-run 執行 `applyAcceptedArrangement`，顯示會觸發的 PENDING 與衝突；
  - 接受仍是另一個明確步驟，經由 `recordAcceptedDecision`／`buildAcceptedDecisionRecord`。
  - Undo 只作用在本機 draft；已套用的 revision 只能被新的 `g11d:rev:` 取代，不能 undo。
  - 在尺規上拖曳，可以填入 decision 的精確有理數 `section {start,end}`。
- **拒絕：**
  - 音高、起點、時值的直接編輯（G11-D key allowlist 本來就拒絕）；
  - rolljoy 的 nudge pad；
  - 「面板關閉即提交」——在這裡等於把 suggestion 變成 acceptance。

### UI-4 MML 高亮疊層＋per-role 字數條＋事件與文字雙向連結 — S／M

- **吸收自：** `mml-highlight.js` 的「每個原始字元一個角色位元組」：陣列長度永遠等於文字長度，所以疊層不可能錯位。
- **吸收自：** 分色規則：
  - `t`／`l`／`o`／`v` 與其數值同色，音符長度不上色；
  - `<`、`>` 與 `o` 同色，`&` 與 `l` 同色；
  - 本 repo 另把 `n` 標為 caution 色。
- **吸收自：** 超過 2400 的字元疊紅底；無法辨識的字元加紅色波浪底線；超過 8000 字元時關閉高亮。
- **融合後：**
  - 新增 `studio/web/mml-highlight.mjs`，用在 `#final-mml`、`#final-role-*`；
  - 計數仍以 emitter 為權威，UI 只做顯示，並保留 P1「計數單位未驗證」標示；
  - 做完 LG-2 之後，可以點音符反選文字，也可以點文字定位到捲軸事件。

### UI-5 Studio 預覽播放器（移植 repo 自己的 player） — M／L

- Studio 目前完全沒有 AudioContext。建議移植 **`dist/player.js`**，不移植對方的 player，原因是它已經有 `capture()` 回讀契約，且宣告 `gameTimbreEquivalent:false`。
- **吸收自：**
  - 無縫 loop：下一輪在 look-ahead 視窗內排程，並用 loop 計數折算位置；
  - 以 `ctx.suspend()` 暫停；
  - Media Session 鍵，前後鍵各移動一小節。
- 回讀擷取必須綁定 project／candidate hash，才可能餵給 `playerReadback`。
  光是播放**永遠**不會通過 Gate 6。

### UI-6 原曲 score-follow — M

- 在 `studio/audio-worker/mml_audio_worker/diagnostic.py` 的 `render_review` 產生的 `review.html` 裡，
  以 `<audio>` 播放位置驅動 candidate 音符跟隨。
- beat 轉秒只透過 alignment 的控制點或擬合出的 tempo／offset：
  - 各段不一致的地方畫成帶狀；
  - 低信心或 `COLLAPSED_ALIGNMENT_INTERVAL` 的區間畫斜線並標「未對齊」，不做平滑內插。
- 若之後要在 Studio 內用 blob URL 播放本機音檔，CSP 需要加上 `media-src 'self' blob:`。

### UI-7 深色模式與行動裝置人因 — S

- **吸收自：**
  - `:root` token 預設深色，`[data-theme=light]` 覆寫；
  - 外部 `theme-boot.js` 在首繪前套用主題，因為 CSP `script-src 'self'` 不允許 inline；
  - canvas 在主題切換時讀一次 CSS token，並用測試讓 fallback 表與 CSS 保持同步；
  - 角色色不隨主題改變，並另外加形狀或紋樣作為第二線索，照顧色盲使用者。
- **吸收自：**
  - 以「最後輸入類型」決定觸控目標大小，平板也拿到 44×44；
  - 軟鍵盤開啟時收合次要列；
  - modal 高度用 `dvh` 上限；
  - 回饋留在對話框內或出現在被按的按鈕上，不用容易被 modal 蓋住的 toast。

### UI-8 本機專案庫韌性＋Service Worker 強化 — S＋M

- **SW（S，建議最先做）：**
  - install 改用 `cache:'reload'` 的 Request。現在 `cache.addAll(ASSETS)` 可能從 HTTP 快取取到舊模組，違反 `sw.js` 自己「不混用新舊 Canonical 模組」的原則。
  - update 偵測補齊 `reg.waiting`、`reg.installing`、`updatefound` 三個入口；
  - 在 focus 與 visibility 事件時節流呼叫 `reg.update()`；
  - 「套用更新」按鈕只在任務佇列清空、專案已存檔時啟用；
  - `controllerchange` 觸發的重載由「使用者按過」旗標把關。
- **儲存（M）：**
  - `listProjects()` 目前用 `getAll()` 載入每個專案的完整 workspace（含原始 MIDI 與所有來源內容，單檔上限 4 MiB）只為了填下拉選單；
  - 改為 IndexedDB v2，`projects_meta` 與 `projects_data` 分開，但在同一個 transaction 寫入；
  - 加上存檔狀態標籤：儲存壞掉 > 未存 > hh:mm 已存；
  - 用 `navigator.storage.estimate()` 顯示配額；
  - 只在明確的「保留離線」動作時才呼叫 `persist()`；
  - 全部專案一次匯出成 ZIP，還原時仍逐一走 `importWorkspace`，review 移入歷史。

### UI-9 i18n、離線導覽與本機 snapshot 連結 — M（四語系 L）

- **i18n：**
  - 平面 key 表、繁中作為 fallback、複數只看 `n`、四語系 key 對等測試；
  - Gate／狀態 token（PENDING、VALIDATED…）**不翻譯**；
  - 第一步只做繁中字串抽離。
- **導覽頁：**
  - 依「手上有什麼」分流：什麼都沒有、有 MML、有 MIDI；
  - 只連結 Canonical Manifest，不重述規則，因為對方的 `guide-editor.html` 已經過時。
- **Snapshot 連結：**
  - 只編碼 candidate MML 與設定，使用 deflate-raw＋base64url，放在 URL fragment（不會送到伺服器）；
  - 匯入一律成為 Candidate，review／acceptance 進入歷史；
  - 不採用對方的 `/api/share` 伺服器分享（D）。

### UI-10（選配）無聲審核影片 — L，最低優先

- **吸收自：**
  - WebCodecs 流程：先探測再開始、佇列上限、以 `MessageChannel` 讓出執行緒、錯誤暫存不 throw、在 `finally` 關閉 frame、wake lock、匯出期間鎖定 UI、檢查 frame 數；
  - MP4 writer 的整數 timescale、`moov` 前置、拒絕倒退時間戳。
- **融合後：**
  - 只有影像，沒有合成音訊，也不做響度正規化；
  - 每一格都燒入「VISUALIZATION ONLY – not listening/acceptance evidence」、project／revision／candidate SHA-256 前綴、對齊狀態；
  - 附帶 `status: VISUALIZATION_ONLY`、`gate_confirmation: null` 的 sidecar manifest；
  - 受 iOS WebCodecs 支援度與記憶體限制影響。

---

## 4. 新邏輯提案

### LG-1 Nxx／具名音高偏移：記錄並顯式化 — S（最高價值）

- **現況：**
  - `parser.mjs` 對 `n` 直接取數值當 pitch；
  - 具名音高依 `12*(octave+1)+base` 計算，所以 `o4c = 60`；
  - `o8` 的具名音會發出 `NAMED_NOTE_ABOVE_OFFICIAL_PITCH_RANGE`。
- **社群證據（class F）：**
  - 對方把 `n0 = o0c` 對到 MIDI 12，說明頁寫「`n48` 等於 `o4c`」；
  - 在這個假設下，官方 pitch 0–107 恰好對應 `o0c`–`o8b`。
- **提案：**
  - 在 `rules/index.mjs` 或 `parser.mjs` 把 N↔具名對應寫成顯式常數，**預設維持現行行為**；
  - 加上 round-trip fixture；
  - 另外提出 PENDING 候選（§7），以實機 A/B 比較 `o4c`、`n48`、`n60` 後才切換；
  - 若另一個假設成立，所有攝入的 Nxx 都會差一個八度，所以影響範圍很大。

### LG-2 共用 lexer＋事件文字範圍 — M

- 對方一個 `scanTokens` 同時供 parser 與 highlighter 使用；註解說兩個 scanner 一定會悄悄分歧。
- **提案：**
  - 新增 `studio/backend/mml/lexer.mjs`，產生 token 的 `[start,end)`；
  - `parser.mjs` 的事件帶 source range（tie chain 涵蓋所有段落）；
  - emitter 輸出 per-event 字元範圍。
- **解鎖的功能：**
  - 有範圍的診斷（目前只有起點）；
  - `MOBILE_SYNTAX` §11.8 要求的可逆對應；
  - 精確找出哪些事件落在 2400 字之後；
  - `canonicalize.mjs` 的 token 層級 provenance。

### LG-3 MusicXML：repeat／volta 證據＋推導播放順序；容錯攝入 — M

- `score/musicxml.mjs` 目前：
  - 忽略 repeat barline；
  - 不處理 `<tied>`；
  - 遇到第一個壞的 backup 或 duration 就 throw。
- **提案：**
  - 記錄 `repeatBarlines[]`、`endings[]`；
  - 新增 `score/playback-order.mjs`：
    - `expandPlaybackOrder()` 回傳 `{eventId, pass}`，是**推導出的 view**，不改寫事件；
    - 遵守 `<ending number>`，不像對方那樣遇到 ending 就整個放棄展開；
    - 有歧義就 PENDING。
  - `<tied>` 只建立 `tieChainId` 連結，不合併事件；未閉合時記錄 `TIE_UNCLOSED`。
  - 壞小節記錄為 `MEASURE_LENGTH_MISMATCH`、`BACKUP_BEFORE_MEASURE_START` 診斷，並保留 `implicit` 旗標；一個壞事件不會讓整份檔案的其他證據消失。
- **拒絕：** slur 當 tie、依小節格線 snap、60-tick 取整、丟棄 grace note。

### LG-4 來源聲部診斷：texture 比率與同時起音分散 — S

- **Texture：**
  - 在 `arrangement/role-candidates.mjs` 新增 `SOURCE_VOICE_TEXTURE {loneTopOnsetRatio（精確有理數）, sampleSufficient}`；
  - 起音少於 20 個時標為樣本不足；
  - **只作為證據，不判定角色**，因為「最高聲部 = Melody」不是規則。
- **同時起音分散：**
  - 在 `arrangement/voice-split.mjs` 新增 `ONSET_SPREAD_CLUSTER {eventIds, spread}`，偵測人性化和弦（幾個 tick 內的近同時起音）；
  - 不改動任何起音，因為 G11-B 已拒絕分組。

### LG-5 Emitter 三個小改良 — S

1. **Tie 段數上限由最長音符推導**：`3 + ceil(最長音符 / 最長 token)`，並設天花板。這能消除長音（例如 100 拍）造成的 `SEARCH_POLICY_LIMIT` 誤報，而且仍然精確、仍然 fail closed。
2. **`l` 切換寫在 `&` 之前**：
   - 現行 render 迴圈輸出 `…&l8c`；
   - 社群回報唯一實際貼進遊戲的形狀是 `…l8&c`（3MLE 形狀），且兩者字數相同；
   - 應視為實作政策並列為 PENDING 候選，在實機確認前兩者都算未驗證。
3. **可讀版面選項**：每個 role 一個 `l`、長休止在小節線分段、顯示時每 N 小節換行（貼上的文字不含空白）。仍需 round-trip 與 2400 字檢查。

另外可以只允許來源實際用過的 caution 長度，比全面的 `cautionLengthOptIn` 更窄（`buildTokenLattice`）。

### LG-6 社群格式攝入：3MLE `.mml`／`.mmi` — S＋M

- **內容偵測（S）：**
  - 依內容辨識 INI `[ChannelN]`、`mml-track=` 行；
  - 給出明確的 UNSUPPORTED 診斷，取代現在的 JSON 解析錯誤。
- **Adapter（M）：**
  - 新增 `studio/backend/mml/community-formats.mjs`：
    - 以 offset map 剝除註解與空白；
    - 讀 `[ChannelN]`；
    - 擴充區塊暫不讀；
  - 結果交給 `normalizeMMLSource`，屬 class C／D2 來源；
  - 保留原文，channel 到 role 的指派是一項 decision，不自動決定。
- **PC 96-PPQ 替代讀法：**
  - 對方的 `restoreStandard` 顯示 MabiIcco／PC 時鐘下 `c32.` 與 `c21` 等長；
  - 建議在 `canonicalize.mjs` 以「替代讀法診斷」呈現，依 `SOURCE_POLICY` §2 記錄分歧，**不靜默套用**。
- **攝入寬容**（僅 ingest，不影響 Final；列為 PENDING 候選）：`lN.`、`h`、`p`、`@n`、註解。

### LG-7 離線渲染與等響度 A/B — M

- **吸收自：**
  - 播放與離線渲染共用一個純函式 `flattenEvents`：note-off 排在同 frame 的 note-on 之前、1 ms 下限、以樣本取整；
  - 固定 44.1 kHz；
  - 增益只會往下調；
  - 尾端以 −80 dBFS 裁切；
  - 決定性測試。
- **落點：**
  - 新增 `dist/render-events.js`、`dist/render.js`，匯出 WAV；
  - sidecar JSON 帶 `midiSha256`、`renderProfile`（engine＠version、`gameTimbreEquivalent:false`）、`wavSha256`；
  - 檔名加 `-preview`。
- **BS.1770：** 新增 `dist/loudness.js`，只用於 A/B 等響度比較，並顯示套用了多少 ΔLU。它是「聆聽輔助」，不是證據。

### LG-8 形式標記、顯示標籤、lane 試聽 MIDI、`.def` catalog — S／M

- **形式標記：** MIDI Marker（0x06）與 MusicXML `<rehearsal>` 轉為 `formMarkers[{beat, text, sourceEventIds}]`，對應 `SOURCE_POLICY` §7 的 form 對齊。
- **顯示標籤：**
  - GM 名稱表；
  - meta 文字先試 UTF-8，失敗再以 Latin-1 解碼（只作顯示用，原始 bytes 保留）。
- **Lane 試聽 MIDI：** 跳過 channel 9、帶 marker，可以聽超過 9 條 lane。時間部分沿用 repo 精確 PPQ 的 `writeMidi`。
- **`.def` catalog：** 新增 `instruments/def-catalog.mjs` → `normalizeInstrumentProfile`。只作診斷用的未驗證 profile；**永不自動對應 program**。

### LG-9 Gate 8 提案型診斷 — S／M

- **`proposeVolumePlan()`：**
  - 放在 `adaptation/index.mjs`，參考對方的 velocity dead band；
  - 只產生帶 per-event 音量 ledger 的提案。
- **每個來源聲部一個八度位移的候選：**
  - 列出各位移下超出範圍的音符數（`candidateShifts[]`、`SOURCE_VOICE_SHIFT_DIVERGENCE`）；
  - 對方的 clamp 屬於 D。
- **Reduction 排序：** 在 `reduction/index.mjs`，以「外聲部優先、先捨棄最靠近旋律的內聲部」作為 overflow 的 `SUGGESTION_ONLY` 排序。
- **Tempo 不一致：** 多個來源 tempo 不同時發出 `TEMPO_MAP_MISMATCH`（`source/index.mjs`）。

### LG-10（選配）使用者自備音色庫的取樣預覽 — L

- 從 npm 取得 SpessaSynth（Apache-2.0，附 NOTICE），預設關閉；
- 音色庫只能由使用者自行載入，不存、不上傳；
- 模式名稱必須是「Sample preview — user bank ‹name, sha256›」，**不能**叫「遊戲音色」；
- 觸及 G13（沒有 lockfile）、README「沒有外部 JavaScript」的說法，以及 OSS NOTICE，必須先有專案決策。

---

## 5. 拒絕清單（D）

| 第三方設計 | 拒絕理由 |
| --- | --- |
| PPQ 480 整數 tick、60-tick（1/32）取整、浮點中間值、依小節格線 snap | Gate 1 精確時間；`FINAL_MML_EMITTER.md` §2 D |
| 八度折疊到 `o1c`–`o7b` 或 MIDI 24–107，clamp `t`／`v` | 靜默改音高與時間；`MASTER_RULES` §2 |
| 全曲 tempo 合併、tempo 只寫在第 1 軌、`dropSubTrackTempo` | 與 `MOBILE_SYNTAX` §7 已發布的交付政策（P2）矛盾 |
| `dropTrailingRests`、`dropDefaultState` | P14；依賴未證實的預設 tempo |
| 靜默修復錯誤的 `&` | 錯誤必須明示（`MOBILE_SYNTAX` §8） |
| Unison 合併、onset 分組取樣、兩階段 15 lane 重擊、最高聲部 = tab 1 = Melody | `G11B_CLEANROOM` 帳本；`SOURCE_POLICY` §4 |
| slur 當 tie、丟棄 grace／unpitched、截斷長音、為未閉合音符補結尾 | 來源完整保存（`SOURCE_POLICY` §3） |
| 合併後把來源音符改成休止 | 破壞性；repo 以 `merge-diagnostics.mjs` 只做診斷 |
| 疊加即取代、刪除變休止的直接編輯，`insertNote`／`moveNotes`／`dotNotes` | G11-D 只允許經明確接受的 decision |
| 面板關閉時自動提交 nudge | suggestion ≠ acceptance |
| 複製時才壓縮並剝除 `@n` | 會破壞 delivery identity 綁定；repo 複製已驗證的 bytes |
| `/api/share`、`/api/save`、Google 帳號 | 不設預設雲端；原始 bytes 保留在本機 |
| 把擷取包內的音色庫當內建預設音色、由音色庫推得的「照原樣發聲」範圍 | 只用本機上傳（§13）；`TIMBRE_PROFILE_RESEARCH.md` |
| 環境音（看似取自遊戲的 SFX 名稱）、Freeverb／I3DL2、HRTF 舞台、−14 LUFS 正規化 | 虛構遊戲聲學；改變證據音訊 |
| lamejs MP3 | LGPL-3.0；WAV 已足夠 |
| 12 種音符樣式、10 種擊中特效、粒子效果 | 純裝飾，會遮住重疊 |

---

## 6. G11-A 當時被阻擋的問題：現在的答案

資料來源是擷取包的程式碼（仍是 `MML_MABI_REFERENCE_NOT_VERIFIED`）。

| 問題 | 第三方行為 | repo 對應 |
| --- | --- | --- |
| Voice split | 以 (MTrk, channel) 為一列；先取整到 grid、合併 unison（留最長）；模式：melody／root／both／voices（4 或 3 lane）／all（15 lane） | G11-B 無損，C |
| 軌道合併 | 匯入時不合併；捲軸中由使用者合併 A→B，五種模式；A 的音符之後一律變休止 | `merge-diagnostics.mjs` 只診斷，C |
| 和弦／15 軌 | 「all」模式第二階段把 unison 合併後剩下的音拆到最多 15−head 條 lane；只有前 6 軌進遊戲 | G12 OVERFLOW／PENDING 帳本，C |
| 2,400 字 | 從不為了塞進上限而刪音符；去空白計數、超過只警告；`v` dead band、>32 個 tempo 只留第一個、丟尾端休止；壓縮由使用者另外按 Optimize | emitter 權威計數；LG-5 |
| Program | 只用於標籤；匯入後重設為預設樂器 | program 在音符起點擷取，C |
| Tempo／拍號 | 收集所有軌、取整、clamp 32–255、同 tick 取最後一個、只寫在第 1 條 lane；分母 >32 的拍號丟棄；缺少時補 4/4 | repo 拒絕並記錄，C；LG-9 `TEMPO_MAP_MISMATCH` |
| Note on／off | 每個 MTrk 內依 (channel, pitch) FIFO；velocity 0 = off；孤立的 off 忽略；未閉合的音在軌尾結束 | repo 記錄而不修補，C |
| Sustain／重疊 | 忽略 CC64；同音重疊以 FIFO 配對後合併 unison；取樣時每個音切到下一個起音 | repo 記錄踏板事件，C |
| 打擊 | channel 10 列會被標示，但使用者仍可當成有音高的音匯入，GM 鼓號因此漏進 MML | repo 拒絕把鼓號當音高，C |

結論：repo 的無損設計在每一題都較嚴謹；可以吸收的是 LG-3、LG-4、LG-8、LG-9 的**診斷**，不是行為。

---

## 7. 社群方言事實與 `MOBILE_SYNTAX`／`PENDING` 對照

以下全屬 class F 社群證據，**不是權威**。說明頁與 JS 之間也彼此矛盾：`guide-reference.html`
描述的是像 PC 版的 16 個 score，Melody 1600／Chord1 1200……，但 `config.js` 是 6×2400。

| # | 第三方主張 | repo | 狀態 |
| --- | --- | --- | --- |
| D1 | `n0 = o0c = MIDI 12`，`n48 = o4c` | `N60 = o4c` | **差 12 半音**（P3／P6）→ LG-1 |
| D2 | Mobile 拒絕 `l15`、`l17`、`l21`；標準長度含 3、6、12、24、48 | 1–64 全部接受；3／6／12／24／48 屬 caution | 與 §3 衝突（P4／P13）；對方也承認 `l5`、`l7`、`l9` 未經實機測試 |
| D3 | Mobile 480 PPQ，長度 floor(1920/n)；PC 96 PPQ，附點加 floor(t/2) | 精確分數 | 給出 P4／P8 的測試計畫：480 模型預測 7、9、19、21、27、38 會有捨入誤差，`l5` 可以區分兩種模型 |
| D4 | `..` 實測貼上會被拒；但說明頁仍教 `c4..` | 多點附點 FINAL_FORBIDDEN | 支持 §4（P5） |
| D5 | 單附點可用於所有標準長度，含 `64.`、`3.`、`48.` | Final 禁止 | P5 不變；repo 較嚴 |
| D6 | 預設長度可以加附點：`l4.` 之後 `c` 與 `c.` 都是 1.5 拍 | parser 對 `lN.` 報錯 | 攝入缺口 → PENDING 候選 |
| D7 | Tempo 全曲共用，只放在第 1 軌 | 每個非空 role 重複完整 tempo map | 對應 P2 的較弱假設；說明頁對多 score 合奏的描述相反 → P9 |
| D8 | `t` 範圍 32–255；沒有 `t` 時為 120 | 超出範圍報錯；beat 0 必須有 tempo | 範圍一致；「否則用播放器預設」支持 beat 0 必須有 tempo 的要求 |
| D9 | tie 中途換 tempo 仍是同一個音；說明頁說長音必須在 tempo 變化處切開，否則遊戲中會跑掉 | emitter 已在 tempo 處切段 | 支持 repo（P2／P13） |
| D10 | `l` 切換寫在 `&` 之前（`b.l32&b`） | emitter 輸出 `&l8c` | 此 token 順序未經實機驗證 → PENDING 候選，LG-5 |
| D11 | 預設 v8、l4、o4；`v` 被 clamp | 超出範圍報錯；第一個音之前必須明示 `o` | 範圍一致 |
| D12 | `&` 接不同音高或接休止會被靜默處理 | 報錯 | repo 較好（§8） |
| D13 | 接受 `h`＝b、`p`＝休止、`#`、`c++`、`@n`、`[ceg]`、註解、大寫 | 全部報錯 | Final 一致；攝入寬容 → PENDING 候選 |
| D14 | 空白與註解不計入 2400 字 | 以字串長度計數；Final 不允許空白 | 只反映對方複製前會先剝除；P1 不變 |
| D15 | 6 個遊戲軌（主旋律＋和弦 1–5） | 相同 | 一致 |
| D16 | 遊戲不擋超出範圍的音；`o1e`–`o7e` 照原樣發聲 | Final 拒絕 >107 | 後者來自音色包而非遊戲；只影響預覽保真度 |

**PENDING 候選**（提案，尚未寫入 `docs/PENDING.md`；需要走 Canonical 發布流程）：

1. N↔具名音高偏移（D1）；
2. 帶附點的預設長度 `lN.`（D6）；
3. tie 後接狀態指令，`&l8c` 與 `l8&c`（D10）；
4. 攝入時寬容 `h`、`p`、`@n`、註解（D13）。

---

## 8. 新介面的證據標示規則

1. **視覺化**（捲軸、疊圖、影片）是符號事件的推導 view：
   - 永遠不是 SOURCE、AUDIO_ALIGNMENT 或 IN_GAME 證據（`MASTER_RULES` §9、§11；Gate 6、7、10）；
   - 證據欄位應引用 event ID 或音訊時間窗，不引用畫面或影片檔。
2. **播放模式名稱**只能是「Procedural preview」或「Sample preview — user bank ‹name, sha256›」，**不能**用「遊戲音色」或「in-game」。
3. **渲染輸出與回讀擷取**一律帶 `renderProfile`（engine＠version、bank hash、`gameTimbreEquivalent:false`），檔名加 `-preview`：
   - 只能餵給 `playerReadback`，而且必須是實際載入狀態的擷取；
   - 不能餵給 `originalAudio` 或 `in_game`。
4. **音高與 tempo 只有兩種處理**：照寫的播放，或拒絕（fail closed）。不折疊、不合併。
5. **不加任何聲學效果**：不加殘響、環境音或空間化；等響度 A/B 要顯示套用的 ΔLU，並標為「聆聽輔助」。
6. **時間保持精確**：有理數 beat 一直保留到最後的 px 步驟；秒只能透過 alignment map 取得；未對齊的區間畫斜線。
7. **疊加層不隱藏任何東西**：極短音、超出範圍、超過 6 的 lane 都以標記呈現，不丟棄。

---

## 9. 建議實作順序

| 階段 | 項目 | 工作量 | 風險 |
| --- | --- | --- | --- |
| **P1 馬上可做** | UI-8 SW 強化；LG-1 Nxx 顯式常數＋fixture（不改行為）；UI-4 高亮（先用只有起點的位置）；LG-4 兩個診斷；LG-5 tie 上限 | 各 S | 低 |
| **P2 新介面主體** | UI-1 六角色審核捲軸；UI-2 drift 疊圖；UI-7 深色模式；LG-2 共用 lexer；LG-3 MusicXML repeat／容錯；UI-8 儲存 v2 | M | 中 |
| **P3 新互動** | UI-3 Decision Composer；UI-5 Studio 播放器＋回讀；LG-7 WAV 渲染＋等響度；LG-6 社群格式；UI-9 i18n 與導覽 | L | 中 |
| **P4 選配** | UI-6 score-follow；LG-8、LG-9；LG-10 自備音色庫；UI-10 審核影片 | M–L | 需專案決策 |

每一項都是獨立 PR，並遵守 `studio-ci.yml` 現行檢查：

- `npm test`；
- `build:studio-web` 的 precache 與可重現性；
- `web-boundary` 零預設請求；
- Chromium／WebKit Playwright。

---

## 10. 實作程序

> 授權澄清之後，本節只約束「規則層」的改寫。站方自有程式碼改依 §11.4 的移植程序處理。

資料層與規則相關的邏輯，一律照 `G11B_CLEANROOM.md` 的流程：

1. **參照行為**：引用本文件的條目編號，不引用擷取檔的原文；
2. **合成 fixture**：從規則與規格推導，不從擷取檔的輸出取得；
3. **預期語意**：以 Canonical 條文為準；
4. **獨立實作**：不開著擷取檔寫程式，也不移植常數表；
5. **差異比對**：只記錄行為差異，並在該 PR 的 ledger 中寫明 A／B／C／D。

擷取包本身、音色包與任何 vendor 檔案仍然**不整包提交**進 repo。若日後決定採用 SpessaSynth，
必須從 npm 上游取得，並附 Apache-2.0 LICENSE 與 NOTICE。

---

## 11. 授權澄清後：哪些可以直接移植、哪些用來優化、哪些仍然不行

§0 的授權澄清只解除站方自有程式碼的著作權限制，**沒有**解除 Canonical 規則。所以分級的依據改成
「程式碼與資料模型的耦合程度」：

- 資料層無關的 UI 與基礎設施，可以直接移植；
- 會碰到時間、音高或事件的部分，必須改寫資料層；
- 與規則衝突的設計，不論授權如何都不採用。

模組相依關係以擷取包的 `import` 圖為準；「無相依」表示該檔不 import 任何站方模組。

### 11.1 直接移植（小幅調整）

| 來源模組 | 行數 | 相依 | 移植到 | 需要的調整 |
| --- | --- | --- | --- | --- |
| `pwa.js`＋`sw.js` 的 precache／update 模式 | 155 | 無 | `studio/web/sw.js`、`app.mjs` 啟動段 | `cache:'reload'`、三路 update 偵測；套用更新只在任務佇列清空且已存檔時啟用；沿用 build-hash precache |
| `zip.js` | 187 | 無 | 新 `studio/web/backup-zip.mjs` | 全專案備份；還原仍逐一走 `importWorkspace` |
| `history.js` | 163 | 無 | 新 `studio/web/draft-history.mjs` | 只用於 UI-3 的本機 draft 堆疊，不用於已套用的 revision |
| `mixmath.js`（BS.1770、peak、trim） | 292 | 無 | 新 `dist/loudness.js`，Studio 共用 | 移除 stage／HRTF 相關部分；響度只作聆聽輔助 |
| `mp4.js` | 457 | 無 | 新 `studio/web/mp4-mux.mjs`（僅 UI-10 需要） | 只保留影像軌 |
| `mediakeys.js` | 127 | 無 | `dist/app.js`、Studio player | 無 |
| `theme.js`＋`editor.css` 的 token | 56 | storage | `studio/web/theme.mjs`、`style.css` | CSP 不允許 inline，所以 boot 改成外部檔案 |
| `i18n.js` 基礎設施 | 179 | 語系表 | 新 `studio/web/i18n.mjs` | Gate／狀態 token 不翻譯；先抽出繁中字串 |
| `bzip2.js`＋`mml-ext.js`＋`mml-in.js` 的格式讀取部分 | 591＋494＋420 | 見註 | 新 `studio/backend/mml/community-formats.mjs` | 只取「檔案 → 原始 MML 文字＋metadata」這一段，接到 `normalizeMMLSource`；不經過對方的 tick 模型與 `mml-compress` |
| `mml-highlight.js` 的疊層機制 | 217 | mml、config | 新 `studio/web/mml-highlight.mjs` | token 規則改成對應 repo `parser.mjs` 的 ingest／Final 模式；`n` 用 caution 色 |

註：`bzip2.js` 無相依；`mml-ext.js` 依賴 `bzip2.js` 與 i18n；`mml-in.js` 依賴 config、mml、mml-compress、mml-ext、i18n，移植時只取格式讀取段落，所以會切斷後面幾個相依。

### 11.2 移植後改寫資料層

| 來源模組 | 行數 | 保留 | 改寫 |
| --- | --- | --- | --- |
| `pianoroll.js`（依賴 config、mml、rolledit、select、util、player、rolljoy、i18n、theme） | 4,295 | viewport 虛擬化、繪圖順序、縮放錨點、觸控仲裁、ghost 分層、theme bridge、右鍵選單框架 | 輸入從 tick 改為精確有理數 beat，只在繪圖時投影；命中回傳 event ID；移除所有 `rolledit` 破壞性編輯；callback 改為產生 G11-D draft（UI-1、UI-3） |
| `select.js` | 247 | marquee 與快照追加的邏輯 | 選取對象從文字範圍改為 event ID |
| `waterfall.js`＋少量 `wfstyles.js` | 699＋1,924 | 純 `draw(t)`、線性版面、決定性測試、縮圖裁切 | 時間來源改為 alignment map；移除 `MIN_DUR`、88 鍵折疊、6 軌截斷；只保留一到兩種樣式；每格燒入 VISUALIZATION ONLY 標示 |
| `video.js` | 1,490 | WebCodecs 流程與錯誤處理 | 去掉音訊、響度正規化與環境音 |
| `voices.js` 的 `melodyKind` | — | 比率的定義與 20 個起音的門檻 | 改用有理數，只輸出為 `SOURCE_VOICE_TEXTURE` 診斷，不決定角色（LG-4） |
| `musicxml-in.js` 的 repeat／barline 合併 | — | barline 跨聲部合併、`times` 上限、未配對 `:|` 的偵測 | 保留 `<ending>`，不像對方整個放棄展開；輸出推導播放順序，不改事件；時間改用有理數（LG-3） |
| `midi-in.js` 的 meta 文字解碼、GM 名稱表 | — | 先 UTF-8 再 Latin-1 解碼、去除控制字元 | 只作顯示用，原始 bytes 保留（LG-8） |
| `mixnotes.js`／`mix-worker.js` 的事件攤平 | 138＋ | 同一 frame 先 off 後 on、以樣本取整、分塊渲染 | 輸入改為 repo player 實際載入的 MIDI，以符合回讀契約（LG-7） |

### 11.3 用來優化 repo 現有邏輯（差異比對）

授權之後，擷取包可以在測試環境中當作**比較對象**直接執行。它仍然不是權威，結果只用來找出 repo 的改進空間：

1. **字數最佳化：`mml-compress.js` vs `final/mml-emitter.mjs`。**
   - 對真實歌曲參考資料與合成曲，把兩邊的輸出都用 repo 的 `parser.mjs` 回讀，比對事件是否完全相等；
   - 找出「對方較短，且事件仍完全相等」的案例，再把對應的技巧改寫進 `duration-plan.mjs` 或 emitter 的 DP；
   - 對方有損的選項（`OPT_RULES`、Nxx 省字、`@n` 剝除）一律關閉，否則不列入比較。
2. **攝入診斷：`midi-in.js`／`musicxml-in.js` vs repo intake。**
   - 用同一份檔案比較兩邊的事件數與分歧位置；
   - 對方丟棄、合併或量化的地方，就是 repo 應該用診斷顯示給使用者的地方，例如 `ONSET_SPREAD_CLUSTER`、`MEASURE_LENGTH_MISMATCH`。
3. **Nxx 偏移（LG-1）。**
   - 以相同 MML 在兩邊解析，列出所有 `n` 與 `o8` 的音高差異，作為實機 A/B 的測試清單；
   - 在實機結果出來之前，不改 repo 的行為。

差異比對的腳本放在 `scripts/` 或 `studio/tests/support/`。擷取包本身不提交，執行時從本機路徑讀取；找不到時 skip，並明確列為 SKIPPED，不能算通過。

### 11.4 移植程序

1. 每個移植進來的檔案，開頭加上 provenance 註解：
   - 來源擷取包（§0；檔名與雜湊只留在本機紀錄）；
   - 「repo 擁有者授權，2026-09-23」。
2. 去除 canary 字元；Chinese 設計註解保留重點，或改寫成摘要。
3. 移植的同一個 PR 內，必須補上 repo 自己的測試。對方的測試沒有包含在擷取包內，不能依賴它。
4. 會碰到時間、音高或事件的程式碼，仍然走 §10 的程序；不能因為「已授權」就跳過 Canonical 檢查。
5. vendor 函式庫不從擷取包移植，改由上游取得，例如 SpessaSynth 由 npm 取得並附 LICENSE。

### 11.5 需要擁有者決定的事

| 決定 | 選項 | 建議 |
| --- | --- | --- |
| 移植的程式碼是否隨 OSS 以 MIT 公開 | (a) 放在 `studio/`、`dist/`，隨 `export-oss.mjs` 以 MIT 公開；(b) 放在 OSS 匯出排除的路徑，但 Studio build 相依它時公開版會缺模組；(c) 只移植 UI／基礎設施，資料層仍自寫 | 若不在意這些 UI 程式以 MIT 公開，選 (a) 最簡單 |
| 擷取包內的音色庫 | 見 §13 | 已決定：只用本機上傳，不提交 |
| SpessaSynth 取樣預覽（LG-10） | 加入 npm 相依（Apache-2.0）與使用者自備音色庫 | 等 G13（lockfile）處理後再做 |

### 11.6 仍然不採用（與授權無關）

§5 的清單全部維持不變，原因都是規則衝突，不是著作權：

- 60-tick 量化、八度折疊、tempo 合併、unison 合併、slur 當 tie、最高聲部 = Melody；
- 直接破壞性編輯、面板關閉即提交；
- 雲端分享／存檔；
- 環境音、殘響與空間化；
- lamejs：第三方 LGPL；
- 擷取包內的音色庫：只用本機上傳（§13）。

### 11.7 修正後的建議順序

| 順序 | 內容 | 來源 | 工作量 |
| --- | --- | --- | --- |
| 1 | SW／PWA 更新流程 | `pwa.js`、`sw.js` 直接移植 | S |
| 2 | 字數差異比對：`mml-compress` vs emitter | 11.3-1 | S（腳本）＋M（依結果改 DP） |
| 3 | Nxx 差異清單＋顯式常數＋fixture | 11.3-3、LG-1 | S |
| 4 | MML 高亮與字數條 | `mml-highlight.js` 移植並改 token 規則 | S |
| 5 | 六角色審核捲軸 | `pianoroll.js` 移植 viewport／繪圖／手勢，改寫資料層 | M（有對方的捲軸可移植，比從零寫快很多） |
| 6 | Drift 疊圖＋碰撞層 | 同上的 renderer | S |
| 7 | 3MLE／`.mmi` 攝入 | `mml-in.js`、`mml-ext.js`、`bzip2.js` 格式讀取段 | M |
| 8 | 專案庫 v2＋ZIP 備份＋主題 | `zip.js`、`theme.js`、`library.js` 模式 | M |
| 9 | Decision Composer | `select.js`、`history.js`、`rollmenu.js` | L |
| 10 | Studio player＋WAV＋等響度 | repo `dist/player.js`＋`mixmath.js` | M–L |

---

## 12. 第一批實作紀錄（2026-09-23）

擁有者選擇 §11.5 的 **(a)**：移植的程式碼放進 `studio/`，隨 OSS 以 MIT 公開。
擁有者另外指示：與現行版本衝突時，取兩者優點合成最佳版本。
以下各項都照這個原則處理，表中寫明取了哪一邊。

### 12.1 Service Worker 更新流程（UI-8 的 SW 部分）

| 面向 | MML 工房 | Studio 原本 | 合成後 |
| --- | --- | --- | --- |
| install | `cache:'reload'` | `addAll`，可能取到 HTTP 快取中的舊檔 | 採 MML 工房：`cache:'reload'` |
| 程式碼快取策略 | network-first，線上即新版 | 單一版本 cache-first，不混用新舊模組 | 採 Studio：cache-first；因此必須主動公告新版 |
| 偵測 | `waiting`／`installing`／`updatefound` 三路；focus＋visibility 節流 | 只聽 `updatefound` | 採 MML 工房的三路偵測與節流 |
| 套用 | 使用者按鈕 → `SKIP_WAITING`；reload 由「本分頁要求」旗標把關 | 只能關閉所有分頁 | 採 MML 工房的按鈕與旗標；**新增**：排在任務佇列之後執行，專案未儲存時拒絕 |
| 其他分頁 | 無處理（network-first 不需要） | 無 | **新增**：未要求更新的分頁標為 stale，必須重新載入才能繼續操作，避免新舊模組混用 |
| 舊快取清理 | keep-list，會刪同源其他 app 的快取 | 以 prefix 清理 | 採 Studio：只清自己 prefix 的快取 |

檔案：`studio/web/pwa-update.mjs`、`studio/web/sw.js`、`studio/web/app.mjs`；測試 `studio/tests/web-pwa-update.test.mjs`。

### 12.2 MML 語法高亮與逐角色字數（UI-4）

- **採用 MML 工房的做法：**
  - 每個字元對應一個角色位元組；
  - `t`／`l`／`o`／`v` 連同數字一起上色，音長不上色；
  - 超過字數上限的部分用色帶標示，從不截斷；
  - 超過 8000 字元時關閉高亮。
- **採用 Studio 的規則：**
  - token 規則與 `parser.mjs` 一致；
  - `h`、`p`、`@n`、`[ ]`、註解與角色內空白都顯示為錯誤，因為 Studio 本來就拒絕這些寫法。
- **新增：**
  - 把 Worker 驗證結果中的 error／caution 疊加到對應 token 上；
  - 貼上框即時顯示各角色字數，並附 P1 未驗證聲明。
- **一致性測試：**
  - 用 6,000 組隨機輸入，加上生成語料和參考曲，驗證 scanner 與 parser 對每個診斷位置的切分完全一致；
  - 測試過程抓到一個真實差異：當前一個 `l` 值無效、音符又沒有寫長度時，parser 不會吃掉後面的附點；
  - scanner 已改成同樣行為。

### 12.3 六角色審核捲軸（UI-1，並納入 UI-2 的訊號層）

- **採用 MML 工房的做法：**
  - 視口大小的 sticky canvas，搭配撐出整首歌長度的 spacer；
  - 只繪製可見範圍；
  - 繪製時有重入保護；
  - 縮放用固定檔位，錨點以內容單位計算，重複縮放不漂移；
  - 滾輪位移正規化並累積；
  - 單指平移、tap 選取；雙指 pinch 只縮放一軸，軸向判定後鎖定；
  - 點擊半徑內取最近的音符；
  - 從 CSS token 讀取顏色。
- **採用 Studio 的規則：**
  - 精確有理數時間：只在最後一步換算成像素，點擊結果回傳 event ID；
  - 小節線來自來源拍號圖，以 BigInt 計算；沒有拍號圖時只畫拍線，不假設 4/4；
  - 不折疊音高，107 以上的音區塊加上標示；
  - 捲軸唯讀：不提供任何編輯，也沒有「隱式提交」。
- **新增：**
  - Core3 實心、Chord3–5 空心、未指派以斜線填滿，形狀本身就能區分角色，不只靠顏色；
  - 跨來源和聲衝突可以直接連到既有的仲裁表單；
  - 15 對審核改用技術驗證器本身的 `reviewSong()` 產生同音重疊與低音擁擠訊號，並對回 event ID，不另外維護一套規則；
  - 行動裝置上捲到捲軸邊緣時，剩下的拖曳交還給整頁捲動，因為 Studio 是長頁面，不是全螢幕編輯器。

檔案：`studio/web/review-roll.mjs`、`roll-geometry.mjs`、`roll-model.mjs`；`model.mjs` 的報告新增 `roll` 欄位。
測試：`studio/tests/web-review-roll.test.mjs`。
另外以真實參考曲在桌面與手機兩種 viewport 截圖確認，無水平溢出，也沒有 console 錯誤。

### 12.4 Emitter 字數最佳化（§11.3-1 的結果）

差異比對腳本 `scripts/fusion-emitter-diff.mjs`（測試 `tests/fusion-emitter-diff.test.mjs`）：

- 擷取包不提交進 repo；
- 沒有提供擷取包時，結果回報為 SKIPPED，不算通過；
- 判定只使用 repo parser 的精確有理數比對。

差異比對找到 repo emitter 的候選缺口：預設長度 `lN` 只有在「某個事件剛好是該長度」時才會被列為候選，所以長休止或長延音從來不會使用 `l1`。

- **改法：** 永遠提供 `l1`、`l2` 兩個候選。
- **效果：** 參考曲每首縮短 287 字元（總長 25,215 → 24,067，減少 4.6%），事件完全不變。
- **成本比較：**
  - 提供全部七個 preferred 長度：節省量相同，但計算時間約 2 倍；
  - 只提供 `l1`／`l2`：計算時間約增加 24%，因此採用這個做法。
- **回歸測試：** 30 拍休止＋長音的案例從 31 字元縮短為 24 字元。

差異比對也列出不能移植的節省來源，包括 `lN.`、Nxx、省略首個 `o`、`6.`。這些在 Final 中不合法，因此不採用。

它也確認了 LG-1：MML 工房把 `nN` 解讀為 MIDI N+12，並把超出 24–107 的音折回範圍內。其預設壓縮器用 Nxx 省字元時，經 repo parser 回讀後每個音都低 12 個半音。LG-1 仍待實機 A/B 驗證。

### 12.5 仍未做的項目

- **UI-3 Decision Composer：** 捲軸選取 → G11-D 草稿。
- **UI-5 Studio 播放器與 LG-7：** WAV 渲染與等響度比較。
- **UI-7 深色模式：** 目前的 token 已放在 `.roll-card` 與 `style.css`，之後可以直接擴充成深色主題。
- **UI-8：** 專案庫 v2 與 ZIP 備份。
- **UI-9：** i18n 與離線導覽頁。
- **LG-1：** Nxx 對應常數顯式化，並提出 PENDING 候選；需要實機證據。
- **LG-2：** 讓 parser 直接使用共用 lexer。目前以一致性測試約束 scanner 與 parser，還沒有重構 parser 本身。
- **LG-3、LG-6：** MusicXML repeat／volta，以及 3MLE 攝入。
- **差異比對新發現的問題：**
  - `triplets-in-ties` 案例，即使加上 `cautionLengthOptIn` 仍會 `DURATION_SEARCH_BUDGET_EXHAUSTED`；
  - rest run 內的 `l` 切換可省 8 字元，但只在選擇性使用時才有利。

---

## 13. 遊戲音色試聽（2026-09-23 第二批）

擁有者要求 Studio 在完成 MML 後能以遊戲音色試聽。

### 13.1 已完成：試聽功能，使用本機音色庫

- **引擎**：SpessaSynth，版本為 `spessasynth_lib@4.3.12` 與 `spessasynth_core@4.3.16`。
  - 從 npm 取得，授權為 Apache-2.0，並固定版本。
  - 與擷取包中的 vendor 檔內容相同，但取自上游。
  - Apache-2.0 全文放在 `vendor/spessasynth/lib.js` 開頭的註解中。不用獨立的 LICENSE 檔，因為主機只允許特定副檔名，一個無法提供的 precache 檔會讓整個 Service Worker 安裝失敗。
  - 建置時由 `scripts/build-studio-web.mjs` 放到 `vendor/spessasynth/`，只在按下播放時才載入。
- **沿用 MML 工房的架構**：
  - 單一 AudioContext，搭配 AudioWorklet 合成器與輸出 gain；
  - look-ahead 排程：25 ms tick、0.3 s 視窗、0.12 s 起始延遲；
  - 已排入的事件無法撤回，所以停止時把輸出靜音到視窗結束；
  - Safari 的 worklet console 墊片；
  - v→velocity 與角色→channel 的對應，沿用擁有者的模型。
- **採用 Studio 的規則**：
  - 時間先以精確有理數積分 tempo map，最後一步才換成秒數；
  - AudioContext 在點擊當下同步建立，符合 iOS 的使用者手勢要求；
  - 重新繪製時只更新試聽卡片，不會清掉其他表單裡正在輸入的內容。
- **音色庫存放**：
  - 使用者自行選取的 `.dls`／`.sf2`／`.sf3`，會驗證 RIFF 容器並計算 SHA-256；
  - 存放在獨立的 IndexedDB，不上傳、不進入專案備份，也不在建置產物中。
- **CSP**：新增 `'wasm-unsafe-eval'`，只允許 SpessaSynth 內建的 WebAssembly 解碼器編譯，不允許 JavaScript eval。
- **驗證**：
  - 以擁有者提供的音色庫在 headless Chromium 實測：列出音色、實際發聲、播放中切換音色、重新載入後音色庫仍在、沒有 console 錯誤。
  - 單元測試：`web-preview-schedule`、`web-build`（vendor 內容、授權標頭、precache、所有 precache 檔可由主機提供，並確認建置中沒有任何音色庫）。

### 13.2 擁有者決定：只用本機上傳

- 音色庫不進 repo、不進建置、不進 OSS 匯出，也不在 repo 或 PR 中記錄它的名稱或檔內資訊。
- 使用者在各自的裝置上選取檔案即可試聽。
