# MML App Stage 1：範圍、實作與驗證紀錄

Status: 實作與驗證紀錄（branch `feature/mml-app-stage-1`，2026-09-29）。**不是 Canonical 規則來源。**
架構：[MML_APP_ARCHITECTURE.md](MML_APP_ARCHITECTURE.md)。決策：[ADR-001](ADR-001-core-portability.md)、
[ADR-002](ADR-002-offline-server-boundary.md)。App 使用說明：[apps/ios/README.md](../../apps/ios/README.md)。

## 1. 身份

| 項目 | 值 |
| --- | --- |
| Base（main） | `d02635d49d0c0efb58fc8bfc4cf4eb21581d6d4c`（Merge #144） |
| Published Canonical | `canonical_version` `2026-09-23-v3`，`canonical_status` `PUBLISHED` |
| Manifest | `manifest_version` `2026-09-23-v3-manifest1`；`manifest_commit` `44f3f0082cf5c30328edf1c251398b844488ad0a` |
| Rules snapshot | `rules_snapshot_sha` `ff1a9df054f5ca1ae42571067fc95feb274755ef` |
| Machine delivery schema | `mabinogi-mobile-mml-studio/machine-delivery@2` |
| Validation profile | `mabinogi-mobile-mml-canonical-v1-2026-09-13` |
| Canonical runtime package digest | `8f01a836fefd2af1d1ca997e5124283ccb282d2b6ec8c60e4bfb34cde987703b`（與 Studio Web 相同） |

App 的 repository 就是 `a91453/mml-tools`：沒有另一個 App repo，main HEAD 與上方 Base 相同。
Branch HEAD 以 PR 為準。本 Stage 沒有修改任何規則文件、Manifest、Canonical 快照或 MCP 工具。

## 2. 交付內容

| 項目 | 位置 |
| --- | --- |
| Canonical runtime package 的共用定義（Studio Web 輸出逐位元組不變） | `scripts/canonical-runtime-package.mjs`、`scripts/build-studio-web.mjs` |
| 原生核心 host：facade、host shims、conformance case | `studio/native/` |
| 原生核心建置（`npm run build:native-core`） | `scripts/build-native-core.mjs` → `studio/native-build/`（不進版控） |
| Node 端 regression | `tests/native-core.test.mjs` |
| Swift package（核心契約、JavaScriptCore 橋接、專案、observable models） | `apps/ios/MMLKit/` |
| SwiftUI App 與 Xcode 專案 | `apps/ios/MMLApp/`、`apps/ios/MMLApp.xcodeproj/` |
| macOS CI | `.github/workflows/ios-app-ci.yml` |
| 架構文件與 ADR | `docs/architecture/` |

### 已實作的 App 功能

1. 可在 iPhone 與 iPad 啟動的 SwiftUI App（`NavigationSplitView`：iPad 分割、iPhone 堆疊）。
2. 原生核心邊界：`MMLCoreEngine` 協定；正式實作 `JavaScriptCoreEngine` 執行共用核心。
3. 專案模型：`MMLProject`（`io.github.a91453.mml-tools.project` schema 1），目錄套件
   `Application Support/Projects/<id>.mmlproj/project.json`，原子寫入，毫秒精度時間戳。
4. 建立、改名、刪除專案；無法讀取或 schema 較新的專案會列出原因，不覆寫、不刪除。
5. 輸入 MML、匯入 UTF-8 文字檔（`.txt`、`.mml`）；拍號圖、弱起、末小節由使用者依來源填寫，
   **不預設 4/4**。
6. 以共用核心執行 Published Canonical 技術檢查（MCP `mml_validate` 的同一份實作）。
7. 顯示核心自己的診斷：PASS／FAIL、錯誤與提醒（角色、位置、代碼、訊息）、六軌摘要、Tempo／拍號、
   各驗收面向（技術 PASS 不代表來源、聽驗、播放器回讀或實機驗收）。
8. 顯示 Canonical identity、validation profile、runtime package、bundle SHA-256 與建置稽核紀錄；
   六份已發布文件可離線閱讀。
9. 專案關閉（切換、離開前景）時儲存，重新開啟得到相同資料與結果；另有 1 秒自動儲存。
10. 結果綁定「請求＋engine stamp」；內容、Canonical release 或核心建置改變時標示為過時。
11. 以上流程不使用網路、Railway 或 MCP。
12. 匯出專案檔（JSON）與分享 MML 文字。

## 3. Baseline（修改前，`d02635d`）

| 指令 | 結果 |
| --- | --- |
| `npm ci --ignore-scripts` | 成功 |
| `npm run canonical:bootstrap -- --summary` | `CANONICAL_LOADED`，身份同 §1 |
| `npm test` | 2676 tests：2669 pass、0 fail、7 skipped；約 139 秒 |
| `npm run build:studio-web` | buildId `1248f6168819fd570fc145ba22259490086cea9bd5969c07eff33e647a746000`、cacheId `a39f0d8d16c6…`、170 assets、runtimeBundleDigest `8f01a836…` |

7 項 skip 都是環境條件，不是 regression：1 項需要 `STUDIO_DEFAULT_BANK_SOURCE`（上游 sound bank），
6 項需要第三方 Workshop bundle（`MML_WORKSHOP_FE`）。原始 clone 是 shallow，先 `git fetch --unshallow`
才能讀到 rules snapshot。Repository 沒有 lint 或 typecheck 指令；環境原本沒有 Swift 與 Xcode。

## 4. 驗證結果（本 branch）

### 4.1 本機（Linux x86_64，Node 22.22.2，Swift 6.3.3，JavaScriptCoreGTK 2.52.6）

| 指令 | 結果 |
| --- | --- |
| `npm test` | 2685 tests：2678 pass、0 fail、7 skipped（baseline＋9 項 native core；skip 同 baseline） |
| `node --test tests/native-core.test.mjs` | 9／9 pass |
| `npm run build:studio-web` | buildId、cacheId、asset 數、runtimeBundleDigest 與 baseline **完全相同** |
| `npm run build:native-core` | bundle 165,553 bytes、15 modules、15 conformance cases、runtime package digest 同 Studio Web |
| `swift build --package-path apps/ios/MMLKit` | 成功，0 warning |
| `swift test --package-path apps/ios/MMLKit` | 30／30 pass（MMLCore 5、MMLCoreJSC 9、MMLProjects 8、MMLWorkspace 8） |
| CI guard policy tests（railway-agent、artifact-upload、classify、dependency-lock、secret-scan） | 18／18 pass |

### 4.2 GitHub Actions `iOS App CI`（macos-15，Xcode 16.4，Swift 6.1.2）

| 步驟 | 結果 |
| --- | --- |
| `npm run build:native-core` | 成功，runtime package digest `8f01a836…`，15 cases |
| `node --test tests/native-core.test.mjs` | 9／9 pass |
| `swift test`（macOS，Apple JavaScriptCore） | 30／30 pass |
| `xcodebuild test -scheme MMLKit-Package`（iOS Simulator） | 30／30 pass，`TEST SUCCEEDED` |
| `xcodebuild build` App，iOS Simulator，Debug | `BUILD SUCCEEDED` |
| `xcodebuild build` App，generic iOS device，Release，未簽署 | `BUILD SUCCEEDED` |
| 我方原始碼的編譯警告 | 0（只有 Xcode 的 AppIntents metadata 提示） |

### 4.3 最大 Final 字串的檢查時間（六軌各 2400 字，約 11,500 音）

| 環境 | 時間 |
| --- | --- |
| Linux JavaScriptCoreGTK，JIT | 0.38 秒 |
| Linux JavaScriptCoreGTK，`JSC_useJIT=false`（接近 iOS App 的無 JIT 條件） | 2.2–2.4 秒 |
| macOS runner，`swift test` | 1.97 秒 |
| iOS Simulator（macOS runner） | 3.12 秒 |
| iPhone／iPad 實機 | **NOT VERIFIED** |

### 4.4 NOT VERIFIED

- 在 iPhone 或 iPad 實機上執行（需要簽署與裝置）；實機效能；實機飛航模式操作。
- 以 Xcode 開啟專案的互動操作、SwiftUI 畫面的實際外觀與操作流程（CI 只建置，沒有 UI 測試）。
- 簽署後的 archive、TestFlight 上傳與 App Store 審核。
- 以 WKWebView 或其他方案的效能比較（ADR-001 的比較是依架構特性，不是實測）。
- Studio Web 瀏覽器 regression（`npm run test:studio-web`）未在本機執行：本 Stage 沒有修改 Studio Web
  原始碼，建置輸出以 buildId 證明逐位元組相同；Studio CI 的 `studio-web` job 會執行它。

## 5. 仍存在的風險

1. **無 JIT 的效能**：最大字串約 2–3 秒；只以按鈕觸發。需要實機量測（§4.3）。
2. **核心與 App 的建置順序**：Xcode 建置前必須先 `npm run build:native-core`（缺檔會明確失敗）。
3. **Host shims** 是本 Stage 新增的程式碼，只涵蓋資料值與 UTF-8；已與 Node 比對，但 Stage 2
   使用更多引擎時需要擴充測試（例如 community formats 的 Big5）。
4. **既有的 Workshop 方言 parser** 與 Studio parser 以鏡像方式同步（架構文件 §2.3），
   本 Stage 未處理。
5. **Bundle identifier 與專案格式名稱是暫定值**（owner 的 GitHub namespace），正式上架前需確認。
6. **專案只在本機**：沒有 iCloud 同步；刪除 App 會刪除專案（匯出檔除外）。

## 6. 延後項目（刻意不在 Stage 1）

來源管理（MIDI、MusicXML、原曲）、MIDI／MusicXML 匯入、3MLE 格式、六軌編輯器、Melody／Chord 分軌編輯、
version drift、Studio 審核流程（Lead、Core3、harmony、G11–G12、Mobile adaptation）、Final MML 產出、
播放與試聽、Files／iCloud 文件整合、與 Agent Control Plane 的連接、UI 美化、App icon 與 privacy manifest。

## 7. 建議的 Stage 2

1. **匯入來源**：facade 加入 bytes 傳遞與 `ingestMIDI`／`ingestMusicXML`（已驗證可在裸 context 執行，
   結果與 Node 相同）；專案套件保存來源檔與其 SHA-256；conformance case 擴充到 intake。
2. **Canonical IR 與 version drift**：顯示來源與候選的差異；定義與 Studio Web 備份的匯入匯出
   （匯入的審核一律需重新審核）。
3. **實機驗證與效能**：在實機量測無 JIT 的檢查時間；必要時在共用核心內最佳化（所有 host 受益），
   而不是在 Swift 重寫。
4. **上架準備**：Apple Developer team、正式 bundle identifier、App icon、privacy manifest、
   TestFlight 的簽署與上傳流程（CI 的 archive job）。
5. **共用核心收斂**：規劃 Workshop 方言 parser 與 Studio parser 的收斂，消除鏡像同步。

## 8. 需要 owner 決定的事

1. 正式的 App 名稱、bundle identifier 與 Apple Developer team。
2. 是否需要 iCloud／Files 文件整合與跨裝置同步。
3. Workshop 編輯器在 iOS 上的方向：原生重做、以 Web 形式嵌入，或維持在 Studio Web。
4. App 是否要登入 Agent Control Plane（在裝置上保存 OAuth 憑證），以及其範圍。
