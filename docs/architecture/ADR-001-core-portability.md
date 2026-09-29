# ADR-001：原生 App 如何使用共用 MML 核心

Status: Accepted（Stage 1，2026-09-29）。架構決策紀錄，**不是 Canonical 規則來源**。
相關：[MML_APP_ARCHITECTURE.md](MML_APP_ARCHITECTURE.md)、[ADR-002](ADR-002-offline-server-boundary.md)。

## 背景

MML 的語意（parsing、Final 驗證、Canonical IR、MIDI／MusicXML intake、Final emitter）目前只有一份實作：
`studio/backend/**` 加上它沿用的 `dist/core.js` 原語，約 4.5 萬行 JavaScript，由 Manifest 指定的
Published Canonical 驅動，並有約 2,700 項 regression。iPhone／iPad App 必須離線使用這些能力，
而且不能產生第二套 MML semantics、validation、parser、emitter 或 Canonical 規則。

限制：

- iOS App 只能執行隨 App 簽署出貨的程式碼（App Review Guidelines 2.5.2）；不能在執行期下載核心。
- 第三方 App 的 JavaScriptCore 沒有 JIT（缺少 dynamic-codesigning entitlement），以直譯器執行。
- 核心在求值時需要 `TextEncoder`；Application Service 的錯誤需要 `structuredClone`；
  兩者都不是 ECMAScript built-in。
- Canonical 載入器依賴 Git 子程序。

## 考慮過的方案

| 方案 | 正確性／單一真值 | 離線 | App Store | 可測試性 | 維護成本 | 結論 |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Swift 重寫核心** | 產生第二份實作；每次規則或實作修正都要雙寫，只能靠 conformance 追趕 | ✓ | ✓ | 需另建完整 conformance | 極高（4.5 萬行 + 2,700 項 regression） | 否決 |
| **B. JavaScriptCore + 建置時 bundle**（本 ADR） | 執行同一份 `studio/backend`，與 MCP 共用 technical service | ✓ | ✓（程式碼隨 App 出貨） | Linux（WebKitGTK）、macOS、iOS Simulator 都能跑同一套 Swift 測試 | 低：核心照常在 repo 演進，App 重新建置即可 | **採用** |
| C. WKWebView 執行 Studio PWA 或其 Worker | 同一份核心 | ✓ | 純網頁包裝有 4.2 風險 | 需要 App host、跨行程、只能非同步 | 中：WebContent 行程可能被系統終止；無法在 package 測試中執行 | 否決（作為核心執行環境） |
| D. WASM | 核心是 JavaScript；需把 JS 引擎（例如 QuickJS）編成 WASM，再找 WASM runtime | ✓ | iOS 沒有 WebKit 以外的 WASM runtime | 差 | 高 | 不適用 |
| E. 內嵌第三方 JS 引擎（QuickJS、Hermes） | 同一份核心 | ✓ | ✓ | 可 | 多一個原生依賴與授權；JavaScriptCore 已是系統框架 | 否決 |
| F. 遠端服務（Railway `/api/v1` 或 MCP） | 同一份核心 | ✗ | ✓ | 可 | 讓 App 永遠依賴網路與伺服器 | 否決作為主要路徑（見 ADR-002） |
| G. 只出貨預先計算的資料（generated assets） | parser／validator 無法預先計算 | — | — | — | — | 只用於 Canonical runtime package |
| H. IPC／子行程服務 | iOS 無法啟動子行程 | — | ✗ | — | — | 不適用 |

## 決策

採用 **B：在 JavaScriptCore 中執行建置時產生的共用核心 bundle**，Swift 負責 UI、專案與儲存。

1. **Bundle**：`scripts/build-native-core.mjs`（`npm run build:native-core`）以 esbuild 0.28.2
   （pinned devDependency）把 `studio/native/entry.mjs` 打包成一個 classic script（IIFE，target
   `safari17`＝iOS 17 的 JavaScriptCore）。內容是 `studio/backend` 與 `dist/core.js` 的原始模組；
   只有 Git 版 `bootstrap/index.mjs` 被換成 Canonical runtime package。任何 `node:` import、
   bare specifier 或未預期的 bundler 警告都讓建置失敗。輸出可重現：位元組只取決於原始碼、
   Canonical release 與 bundler 版本，不含 Git history 或時間。
2. **Canonical runtime package**：`scripts/canonical-runtime-package.mjs` 是 Studio Web 與原生核心
   共用的唯一定義；同一個 release 在兩個 host 的 digest 相同（目前 `8f01a836…`）。Studio Web 的建置輸出
   在抽出此 helper 前後逐位元組相同。
3. **Facade**：`studio/native/core-facade.mjs` 是 transport adapter，和 `server/mcp.mjs` 同層。
   它組合 MCP 所用的同一個 `createTechnicalService` 與 `createCanonicalGate`；gate 的 loader 在使用前以
   Studio Web 的 `verifyCanonicalPackage` 驗證 runtime package，失敗時 `CANONICAL_NOT_LOADED`，
   沒有 legacy fallback。介面是 JSON 文字進出：`submit(operation, json)` 取得 ticket，
   `collect(ticket)` 取回 `{ok, result}` 或 `{ok:false, error:{code,message,details}}`。
   JavaScriptCore 在外層 API 呼叫返回時清空 microtask queue，所以下一次呼叫就能取回結果；
   未完成時回傳 `NOT_SETTLED`，不等待。
4. **Host shims**：`studio/native/host-globals.mjs` 只在主機缺少時安裝 WHATWG UTF-8
   `TextEncoder`／`TextDecoder` 與資料值用的 `structuredClone`。它們與 Node 的實作做 fuzz 比對；
   非 UTF-8 編碼與 streaming decode 明確拒絕，不做近似。
5. **Swift 端**：`MMLCoreJSC` 透過 JavaScriptCore **C API** 執行 bundle。Apple 平台用系統框架；
   Linux 用 WebKitGTK 的 `javascriptcoregtk-4.1`，C API 相同。所以同一套 Swift 程式碼與測試在三個環境都能跑。
   Bundle 載入前先比對 manifest 的 byte 數與 SHA-256；執行後核心回報的 runtime package digest
   必須等於 manifest 所記錄的。
6. **Conformance**：建置時用 Node 伺服器路徑（Git 載入的 Canonical gate + technical service）回答
   `studio/native/conformance-cases.mjs` 的每個 case，寫成 `conformance.json`；Node 裸 context 測試與
   Swift（JavaScriptCore）測試都要求 bundle 給出完全相同的 JSON。Case 只描述「問什麼」，
   答案永遠在建置時由 Canonical 實作產生，所以它們不會變成第二個規則來源。

## 取捨

- **效能**：沒有 JIT。實測（Linux x86_64，JavaScriptCoreGTK 2.52，`JSC_useJIT=false`）：
  六軌各 2400 字、約 11,500 個音的最大 Final 字串，一次技術檢查約 2.3 秒（有 JIT 約 0.38 秒）。
  以按鈕觸發可接受；不適合每次按鍵即時驗證。iPhone 實機數字 **NOT VERIFIED**。
- **Bundle 大小**：Stage 1 為 165 KB（含 64 KB Canonical 文件）；全引擎約 1.1 MB。
- **兩種語言**：錯誤跨越邊界時以 code 表示；JavaScript 例外在 Swift 端是 host fault，不是 MML 判定。
- **建置步驟**：Xcode 建置需要先有 `studio/native-build/`（Node 22 + published history）。
  Xcode 本身不執行 Node；缺檔時建置失敗並指示指令。
- **新增 devDependency**：esbuild（exact pin，lockfile 依 CONTRIBUTING 流程重新產生）。

## 風險與緩解

| 風險 | 緩解 |
| --- | --- |
| WebKitGTK 與 Apple JavaScriptCore 行為差異 | iOS App CI 在 macOS 與 iOS Simulator 上用 Apple 的 JavaScriptCore 跑同一套測試 |
| Microtask 清空時機不同 | 兩個 JavaScriptCore 都實測；未完成時 fail closed（`NOT_SETTLED`） |
| Host shim 與平台行為不一致 | 與 Node 的 `TextEncoder`／`TextDecoder`／`structuredClone` 比對；不支援的輸入明確拒絕 |
| 核心與 App 的 Canonical 身份不一致 | manifest SHA-256 → runtime package digest → `verifyCanonicalPackage`；每筆結果綁定 engine stamp |
| 有人以 Swift「快速修正」MML 行為 | App 原始碼不解析 MML；架構文件與測試（conformance、網路 API 掃描）明示邊界 |
| 核心演進讓 bundle 過期 | 核心不進版控；每次建置都重新產生；iOS App CI 監看核心路徑 |

## 後果

- MML 規則或實作的修正只需在 `studio/backend` 做一次；Studio Web、MCP 與 App 都會得到它。
- App 的技術檢查與 MCP `mml_validate` 的報告相同（`tests/native-core.test.mjs` 直接比對 `handleMcp`）。
- Stage 2 起新增的能力（MIDI、MusicXML、drift、審核）以擴充 facade 操作加入，並沿用 conformance 機制。
  全引擎求值實驗已證明這些模組在裸 context 可執行（見架構文件 §3）。
