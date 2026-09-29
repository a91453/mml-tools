# MML App 架構：一個共用核心，多個執行面

Status: 架構與實作紀錄（2026-09-29，Stage 1）。**不是 Mabinogi Mobile MML Canonical 規則來源。**
規則只從 [docs/CANONICAL_MANIFEST.md](../CANONICAL_MANIFEST.md) 依其 `rules_snapshot_sha` 載入。
決策紀錄：[ADR-001 核心可攜策略](ADR-001-core-portability.md)、[ADR-002 離線／伺服器邊界](ADR-002-offline-server-boundary.md)。
Stage 1 範圍與驗證：[MML_APP_STAGE_1.md](MML_APP_STAGE_1.md)。

本文件描述：目前實際的架構（依程式碼的 import 路徑，而非名稱推測）、各模組可攜性、
目標架構，以及 Railway、MCP 與 Published Canonical 在其中的角色。

## 1. 一句話結論

MML 的語意只有一份，就是 `studio/backend/**`（加上它沿用的 `dist/core.js` 原語），並由 Manifest 指定的
Published Canonical 快照驅動。Studio Web、Workshop 的 Studio 橋接、HTTP/MCP、以及新的原生 App，
都是這份核心的**執行面（host）**，不是各自的實作。原生 App 在裝置上用 JavaScriptCore 執行同一份核心，
所以離線、不需要 Railway、也不經過 MCP。

## 2. 目前架構（Stage 1 之前）

### 2.1 Repository 與部署

同一個 repository `a91453/mml-tools` 含全部 MML ecosystem；沒有獨立的 App repository，
也沒有 submodule 或外部 package 依賴 MML 核心。Railway 上有兩個互相獨立的平面
（見 [STUDIO_AGENT_INTERFACE.md](../STUDIO_AGENT_INTERFACE.md) §0）：

| 平面 | Railway 專案／服務 | 內容 | 資料 |
| --- | --- | --- | --- |
| Permanent Studio Web | `mml-tools-studio-permanent` / `studio-web-permanent` | 釘選、SHA-256 驗證後發布的 Studio PWA 靜態檔 | `/studio-cache`（release 位元組） |
| Agent Control Plane | `mml-tools-allen` / `mml-tools` | OAuth、`/mcp`、`/api/v1/*`（Application Service） | `/data`（專案、素材、產出、工作紀錄） |

### 2.2 依賴圖（依實際 import）

```text
UI
  studio/web/app.mjs ............ Studio PWA 介面（DOM）
  studio/web/workshop/*.mjs ..... Workshop 編輯器（DOM、AudioWorklet、WebCodecs）
  server/listen/player-app.js ... 對話內試聽播放器
  dist/app.js, dist/player.js ... legacy Workbench 介面
      │
Application
  studio/web/model.mjs + worker.mjs ... 瀏覽器端應用層：在 Web Worker 內直接呼叫 backend 引擎
  studio/backend/application/* ........ 伺服器端 Application Service（run、proposal、job、asset、store）
  server/mcp.mjs, server/api.mjs ...... MCP／HTTP transport adapter，只轉接 Application Service
      │
Domain / MML Core
  studio/backend/rules ....... Canonical 的可執行契約（IMPLEMENTER，不定義規則）
  studio/backend/mml ......... parser（ingest／Final 驗證）、canonicalize、community formats
  studio/backend/canonical ... Canonical Music IR、timing、merge
  studio/backend/source ...... MIDI intake、sha256
  studio/backend/score ....... MusicXML／MXL intake
  studio/backend/{compare,arrangement,arbitration,reduction,adaptation,final,audio}
  dist/core.js ............... legacy 原語：精確有理數、拍號與小節、15 對重疊、MIDI/ABC codec
      │
Infrastructure
  studio/backend/bootstrap ... 從 Git 載入 Manifest 與快照（node:child_process、node:fs）
  application/store.mjs ...... 檔案型專案庫（node:fs、node:crypto）
  studio/web/storage.mjs ..... IndexedDB
  studio/audio-worker ........ Python／FFmpeg 原曲對齊
  audio/prescreen ............ Node worker_threads + SpessaSynth 渲染
  railway/server.mjs ......... Node HTTP、OAuth（SQLite）
```

關鍵觀察（每項都有對應的程式路徑）：

- **核心已經是 portable 的。** `studio/backend` 除了 `bootstrap/`、`application/` 的部分服務與
  `audio/prescreen/` 之外沒有 `node:` import。Studio Web 已經在瀏覽器 Worker 裡直接執行它：
  `scripts/build-studio-web.mjs` 把 Git 版 `bootstrap/index.mjs` 換成建置時驗證過的靜態
  Canonical 套件，並在使用前以 `studio/web/canonical-package.mjs` 驗證 digest。
- **唯一與環境綁死的是 Canonical 載入。** `rules/index.mjs` 在模組求值時呼叫
  `loadPublishedCanonical()`，Git 版需要 `git` 子程序與完整 published history。
- **MCP 與商業邏輯已分離。** `server/mcp.mjs` 的 `mml_validate`／`mml_overlap_details` 呼叫
  `application/technical-service.mjs`；該檔只 import `contracts.mjs` 與 `dist/core.js`，
  Canonical 驗證器由 `createCanonicalGate()` 注入。
- **瀏覽器端的主機 API。** `dist/core.js` 在求值時建立 `TextEncoder`；`application/contracts.mjs`
  的每個 `StudioApplicationError` 都呼叫 `structuredClone`；多個引擎（canonical、arrangement、
  reduction、adaptation、final）也使用 `structuredClone`；`mml/community-formats.mjs`
  需要 Big5／windows-1252 的 `TextDecoder` 與 `atob`；`score/*` import npm 的 `fast-xml-parser`。

### 2.3 已存在的重複（Stage 1 未更動，列為風險）

- Workshop 有自己的 MML 方言 parser（`studio/web/workshop/mml.mjs`），`studio-mml.mjs` 以
  「Mirrored rather than imported」的方式複製 Studio parser 的語法上限，只靠
  `studio/tests/workshop-bridge.test.mjs` 保持一致。
- `workshop/bzip2.mjs`、`workshop/mml-ext.mjs` 與 `backend/mml/bzip2-decode.mjs`、
  `backend/mml/community-formats.mjs` 功能重疊；`mml-highlight.mjs` 有兩份。
- `dist/core.js` 的 legacy `validateMML` 與 Canonical parser 判定不同；已以
  `LEGACY_DIAGNOSTIC`／`legacy_*` 欄位明確隔離，不會被當成 Canonical 判定。

## 3. 可攜性稽核

分類：**A** 可直接離線重用；**B** 小幅抽象後可離線重用；**C** 需要 portable adapter；
**D** Node／伺服器專屬；**E** 必須在伺服器端；**F** 可從 App 執行路徑移除 Railway 依賴；
**G** Stage 1 不應搬進 App。「驗證」欄只寫實際跑過的結果。

| 能力 | 模組 | 分類 | 依賴／阻礙 | 建議邊界 | 驗證 |
| --- | --- | --- | --- | --- | --- |
| MML parsing（ingest／Final） | `mml/parser.mjs` | A + F | `dist/core.js`（需 `TextEncoder`） | 原生核心 bundle | Stage 1 已在 JavaScriptCore 執行；15 個 conformance case 與 Node 伺服器路徑逐位元組相同 |
| 技術驗證（`mml_validate`） | `application/technical-service.mjs` | A + F | `contracts.mjs`（需 `structuredClone`） | 同一個 technical service，原生 facade 轉接 | 同上；與 `handleMcp` 的 `mml_validate`／`mml_overlap_details` 報告相同（僅 `service_version` 不同） |
| Canonical rules | `rules/index.mjs` | B | 求值時載入 Canonical | 以建置時的 runtime package 取代 Git loader | 已實作；runtime package digest 與 Studio Web 相同 |
| Canonical identity | `bootstrap/` + `canonical-package.mjs` | C | Git（`node:child_process`） | 建置時載入、裝置上驗證 digest；Git provenance 只進 manifest 的 `audit` | 已實作；竄改的套件以 `CANONICAL_NOT_LOADED` 拒絕 |
| MML transformation／canonicalize | `mml/canonicalize.mjs` | B | 無 Node API | 擴充 facade 操作 | 在裸 context 可求值（見下方實驗） |
| Final emitter | `final/mml-emitter.mjs` 等 | B | `structuredClone`（已有 host shim） | 擴充 facade 操作 | 可求值；未跑 Final 產出比對 |
| Source handling／IR | `canonical/*`、`compare/*` | B | `structuredClone` | 擴充 facade 操作 | 可求值 |
| MIDI import | `source/midi*.mjs` | B | 需要把 bytes 從 Swift 傳入 JS | facade 加入 bytes 傳遞（base64 或 typed array） | 實驗：裸 context 的 `ingestMIDI` 結果與 Node 逐位元組相同 |
| MusicXML／MXL import | `score/*` | B/C | npm `fast-xml-parser`（純 JS，可 bundle）；inflate 為純 JS | bundle 內含 parser | 實驗：裸 context 的 `ingestMusicXML` 結果與 Node 相同 |
| 3MLE `.mml`／`.mmi` | `mml/community-formats.mjs` | C | `TextDecoder('big5'／'windows-1252')`、`atob` | Swift 端解碼後傳入，或 host 提供 legacy 編碼 | 未驗證；目前 shim 對非 UTF-8 明確拒絕 |
| Project persistence | `studio/web/storage.mjs`（IndexedDB）、`application/store.mjs`（fs） | D（對 App） | 瀏覽器／Node 專屬 | App 以 Swift 實作本機儲存（`MMLProjects`），格式各自版本化 | Stage 1 已實作並測試 |
| Audio preview／playback | `studio/web/preview/*`、`workshop/engine.mjs`（AudioWorklet）、SpessaSynth | G | Web Audio、AudioWorklet | 未來以 AVAudioEngine 原生實作，事件來源仍是核心 | 未做 |
| 原曲對齊 | `studio/audio-worker`（Python／FFmpeg） | E | FFmpeg、DSP、檔案大小 | 維持選用的遠端服務，明確上傳 | 未做 |
| Audio prescreen | `audio/prescreen/*`、`application/prescreen-service.mjs` | D/E | `worker_threads`、npm SpessaSynth、磁碟 sound bank | 伺服器 | 未做 |
| Studio 審核流程（G11–G12、Mobile adaptation） | `arrangement/*`、`arbitration/*`、`reduction/*`、`adaptation/*` | B（引擎）／G（Stage 1） | `structuredClone` | Stage 2+ 擴充 facade | 可求值 |
| Workshop 編輯器 | `studio/web/workshop/*` | G | DOM、AudioWorklet、WebCodecs；自有方言 parser | 不搬進 App；未來若需要，先收斂到共用核心 | — |
| One-Click Orchestrator、AI Proposal Protocol | `application/run-service.mjs`、`proposal-service.mjs` | D/E | 檔案型 store、跨請求工作狀態、多 agent | 伺服器（Agent Control Plane） | — |
| MCP operations | `server/mcp*.mjs` | E | AI client 的連線介面 | 保留在伺服器；與 App 共用 technical service | parity 測試 |

**全引擎求值實驗**（未提交，只作為 Stage 2 的依據）：把 `provenance.mjs` 伺服器 gate 會載入的全部 19 個
Canonical 引擎模組，加上 `fast-xml-parser`，用同一個 native host plugin 打包（約 1.1 MB），在沒有任何
Node／Web API 的 context 中裝上 host shims 後求值成功。實際的 MIDI intake 與 MusicXML intake
結果與 Node 逐位元組相同。這證明 Stage 2 的匯入功能是「擴充 bundle 與 facade」，不是重寫。

## 4. 目標架構

```text
                    Published Canonical（Manifest → rules_snapshot_sha，唯一規則真值）
                                         │  建置時載入、封裝成 runtime package（同一 digest）
                                         ▼
                     Shared MML Core：studio/backend/** + dist/core.js
                    （唯一的 MML 語意實作；IMPLEMENTER，不定義規則）
          ┌────────────────────┬──────────────┴───────────┬──────────────────────┐
          │                    │                          │                      │
   Native core bundle     Studio Web build          Node Application      （未來其他 host）
   studio/native +        scripts/build-            Service：
   build-native-core      studio-web.mjs            studio/backend/application
          │                    │                          │
   iOS App（JavaScriptCore）  Studio PWA／Workshop       HTTP /api/v1 ── MCP /mcp
   離線、裝置上執行          瀏覽器 Worker、離線          (Agent Control Plane)
                                                          │
                                              Claude／ChatGPT／agents
```

與概念圖的差異與原因：

- **MCP 不在 App 與核心之間。** MCP 是 AI client 的 transport，和 App 同為核心的執行面，
  兩者共用 `technical-service.mjs`。App 不需要經過 MCP 才能 parse／validate。
- **Studio 與 Workshop 目前不是同一層。** Studio Web 直接使用核心；Workshop 有自己的方言 parser，
  只透過橋接與 Studio 交換。這是既有的技術債，不是目標狀態（§2.3）。
- **Canonical 以「建置時封裝的 runtime package」進入離線 host。** 規則文件、metadata 與 digest
  在建置時從 Git 讀出；裝置上只驗證、不重新發布、不下載。

### 4.1 原生 App 的分層

```text
MMLApp（SwiftUI，apps/ios/MMLApp）                    UI：只顯示核心的答案
  └─ MMLWorkspace（@Observable Workspace／ProjectSession） Application：建立、編輯、匯入、檢查、自動儲存
      ├─ MMLProjects（MMLProject、FileProjectStore）     Infrastructure：本機檔案、版本化 schema、原子寫入
      └─ MMLCore（MMLCoreEngine 協定、報告的 typed view）  Domain 邊界：App 對核心的唯一介面
          └─ MMLCoreJSC（JavaScriptCoreEngine）            Infrastructure：JavaScriptCore C API
              └─ NativeCore/mml-core.js                     Shared MML Core（studio/native facade）
```

- `MMLCoreEngine` 是可替換的邊界：未來若某項能力需要遠端執行，實作另一個 engine，App 不變。
- Swift 端不解析 MML、不判斷 PASS／FAIL、不改寫訊息；只保存核心回傳的完整 JSON（`TechnicalReport.raw`）。
- 每次檢查的結果綁定「請求＋engine stamp（Canonical 版本、快照、runtime package、profile、bundle）」；
  內容或核心改變時標示為過時，而不是沿用。

### 4.2 為何不採用 FileDocument／DocumentGroup（Stage 1）

評估過 SwiftUI 的 document-based 架構，Stage 1 不採用：

1. Studio 的使用方式是「專案庫」（Studio Web 以 IndexedDB 保存多個專案），DocumentGroup 以
   Files 瀏覽器為中心，使用流程不同。
2. 未來的專案會包含多個來源檔（MIDI、MusicXML、音檔）、派生資料與 Canonical 綁定的審核紀錄，
   需要 App 控制的 schema migration 與失效規則。
3. 本機儲存必須能在沒有 UI host 的情況下測試（`FileProjectStore` 在 Linux 與 macOS 都有測試）。

保留的路：專案已經是目錄套件（`<id>.mmlproj/project.json`），之後可以加一個
`ReferenceFileDocument` 包裝同一個格式，提供 Files／iCloud Drive 的開啟與匯出，不必改模型。

## 5. Published Canonical 的所有權

- 規則的唯一真值：`a91453/mml-tools` published `main` 上的 `docs/CANONICAL_MANIFEST.md`，
  及其 `rules_snapshot_sha` 指向的四份規則文件。App、Studio、Workshop、MCP 都不是規則來源。
- 核心 bundle 的建置流程是 `loadPublishedCanonical()` → `canonicalRuntimePackage()`，
  與 Studio Web 相同；`SUPPORTED_CANONICAL_VERSIONS` 未列入的 release 會讓建置失敗，
  不會把舊實作重新標示成新 release。
- App 顯示並保存的身份是分開的欄位：`canonical_version`、`manifest_version`、
  `rules_snapshot_sha`、runtime package digest、validation profile、bundle SHA-256；
  `manifest_commit`、`published_main_head`、`repository_head` 只是建置時的稽核紀錄。
- 新 Canonical release 發布後，App 需要重新建置核心並發布新版 App；裝置上的舊結果會因
  engine stamp 不同而標示過時。App 不下載規則或程式碼（ADR-002）。

## 6. Railway 的角色

Railway 是部署選項，不是架構前提。

| 能力 | 在哪裡執行 | Railway 是否必要 |
| --- | --- | --- |
| 技術驗證、Canonical identity、規則文件閱讀、專案儲存 | App 本機 | 否（Stage 1 已移除 App 路徑上的所有 Railway 依賴） |
| Studio 審核流程、MIDI／MusicXML intake | Studio Web 瀏覽器本機；App 於 Stage 2+ 本機 | 否 |
| Studio PWA 的網頁託管 | Permanent Studio Web（Railway） | 對網頁使用者是；對 App 否 |
| MCP、OAuth、`/api/v1`、One-Click run、proposal、持久工作紀錄 | Agent Control Plane（Railway） | 對 AI client 是 |
| 原曲對齊、audio prescreen 渲染 | 伺服器／選用服務 | 是（需要 FFmpeg、DSP、sound bank） |

## 7. MCP 的角色

- MCP 是 AI integration surface：Claude、ChatGPT 與其他 agent 透過 `/mcp` 使用同一份核心能力。
- MCP 不是 App 的 backend。App 在本機得到與 `mml_validate` 相同的報告；`tests/native-core.test.mjs`
  直接比較 `handleMcp` 的 `structuredContent` 與原生 bundle 的結果。
- Stage 1 沒有修改任何 MCP 工具、schema 或回應格式；既有 MCP 測試全數通過。
- 未來 App 與 AI 工作流的連接應是明確的使用者動作（例如匯出專案、把專案交給 Agent Control Plane），
  而不是讓 App 的本機功能依賴 MCP。

## 8. 遷移路徑

1. **Stage 1（本次）**：原生核心 bundle、App foundation、專案庫、本機技術檢查、Canonical identity。
2. **Stage 2**：擴充 facade（bytes 傳遞、MIDI／MusicXML intake、version drift、Canonical IR 匯出），
   專案加入來源檔；以同樣的 conformance 機制驗證。
3. **Stage 3**：Studio 審核流程（Lead／Core3／harmony、G11–G12）、Final MML 產出與回讀、
   原生播放（AVAudioEngine，事件來源仍是核心）。
4. **之後**：Files／iCloud 文件整合、選用的遠端能力（原曲對齊）以明確上傳方式接入、
   視需要把 Workshop 方言收斂到共用核心。

只有在 profiling 證明某段 JavaScript 是瓶頸時，才考慮以 Swift 重寫該段，而且必須通過同一套
conformance 測試；不以「偏好 Swift」為理由產生第二份實作。
