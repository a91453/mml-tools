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
| Node 端 regression（含全引擎可攜性） | `tests/native-core.test.mjs` |
| Swift package（核心契約、JavaScriptCore 橋接、專案、observable models） | `apps/ios/MMLKit/` |
| SwiftUI App（`App/`、`Views/`、`Resources/`，含 App icon 與 Debug 限定的 `-demo-project`） | `apps/ios/MMLApp/` |
| XcodeGen spec 與由它產生、提交的 Xcode 專案 | `apps/ios/project.yml`、`apps/ios/MMLApp.xcodeproj/` |
| App 開發規則（Linux 驗證、XcodeGen、VERIFIED／UNVERIFIED） | `apps/ios/CLAUDE.md` |
| CI：App CI、Visual Smoke、未簽署 Release Archive、pinned XcodeGen | `.github/workflows/ios-*.yml`、`.github/scripts/ios-simulator-screenshot.sh`、`.github/actions/setup-xcodegen/` |
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
11. 每個專案同時只有一個 live session：切走再回來取得同一個 session，晚到的檢查不會把舊內容寫回；
    核心還在載入時開啟的專案，核心載入後即可檢查；刪除的專案不會被 session 寫回。
12. 以上流程不使用網路、Railway 或 MCP。
13. 匯出專案檔（JSON，檔名經過清理）與分享 MML 文字。

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

以下只列實際執行過的結果；VERIFIED 表示在所列環境跑過，UNVERIFIED 表示沒有。

### 4.1 本機（Linux x86_64，Node 22.22.2，JavaScriptCoreGTK 2.52.6）

| 指令 | 結果 |
| --- | --- |
| `npm test` | 2686 tests：2679 pass、0 fail、7 skipped（baseline＋10 項 native core；skip 同 baseline） |
| `node --test tests/native-core.test.mjs` | 10／10 pass |
| `npm run build:studio-web` | buildId、cacheId、asset 數、runtimeBundleDigest 與 baseline **完全相同** |
| `npm run build:native-core` | bundle 165,874 bytes（SHA-256 `f3e31029…`，與 CI 兩個 runner 的建置相同）、15 modules、15 conformance cases、runtime package digest 同 Studio Web |
| `swift build --build-tests -Xswiftc -warnings-as-errors`＋`swift test`（MMLKit） | Swift 6.0.3、6.3.3、6.4 各 34／34 pass，0 個診斷 |
| XcodeGen 2.46.0（依 pinned commit 從原始碼建置）產生專案 | 與提交的專案相同；重新產生結果不變 |
| actionlint 1.7.12、shellcheck（`ios-*.yml`、截圖腳本） | 無任何訊息 |
| CI guard policy tests | 18／18 pass |

### 4.2 GitHub Actions（commit `dd8a928`，全部 12 個 check run 通過）

| Workflow／job | 環境 | 結果（皆由 log 核對） |
| --- | --- | --- |
| iOS App CI／MMLKit on Linux | `swift:6.0-noble`、`swift:6.4-noble` | warnings as errors 建置成功；兩版皆 34 個 test 通過、0 失敗 |
| iOS App CI／Xcode | `macos-26`，Xcode 26.6，Swift 6.3.3，iOS Simulator SDK 26.5 | 提交的專案與重新產生的相同；可封存產品 `io.github.a91453.MMLApp`；native core 10／10；MMLKit macOS 34／34；MMLKit iOS Simulator `TEST SUCCEEDED`；App Simulator（Debug）與裝置（Release，未簽署）`BUILD SUCCEEDED` |
| iOS Release Archive | `macos-26` | `ARCHIVE SUCCEEDED`；bundle id `io.github.a91453.MMLApp`、顯示名稱 MML、0.1.0 (1)、iOS 17.0、iphoneos26.5、裝置 1,2、icon `AppIcon`、arm64；封存內的核心 SHA-256 `f3e31029…` 與本次建置及 manifest 相同，Canonical `2026-09-23-v3 · ff1a9df…`；未簽署（預期）；沒有需要 privacy manifest 理由的 API |
| iOS Visual Smoke | `macos-26`，iPhone 17 Pro 與 iPad Pro 11-inch (M5)，iOS 26.5 | 見 §4.3 |
| Studio CI（symbolic、studio-web、audio-worker）、Studio service CI | ubuntu | 全部通過；`studio-web` job 執行了 Chromium 與 WebKit 的 Studio Web 瀏覽器 regression |

其後的 `ecb208e`（Debug 限定的啟動就緒訊號，以及 Visual Smoke 改為等待該訊號）同樣 12 個 check run 全部通過：
Xcode job 每個步驟成功（drift、scheme、native core、MMLKit macOS 與 iOS Simulator、兩個 App 建置）；
Release Archive 的檢查表與上表相同（核心 SHA-256 仍為 `f3e31029…`），並確認 Release binary 不含
`-demo-project`、`MML_APP_READY`、`MML_APP_LAUNCH_FAILED`。

### 4.3 iOS Visual Smoke（Simulator 截圖）

Commit `ecb208e`，run `36507937843`：`macos-26`，Xcode 26.6，Simulator iOS 26.5，Debug 建置。截圖與 log 是
`ios-visual-smoke` artifact（保留 7 天）。每次啟動後，腳本等 App 在 stderr 寫出就緒訊號才截圖；
「就緒」是 `simctl launch` 之後等待的秒數（每秒檢查一次）。四次啟動的 App stderr 都只有一行
`MML_APP_READY canonical=2026-09-23-v3`，沒有錯誤。

| 截圖 | 裝置 | 啟動參數 | 就緒 | 畫面（逐張檢視） |
| --- | --- | --- | --- | --- |
| `iphone.png` | iPhone 17 Pro | 無 | 0 秒 | 空的專案庫「還沒有專案」；上方「Published Canonical 2026-09-23-v3 · 本機核心 · 離線可用」 |
| `iphone-demo.png` | iPhone 17 Pro | `-demo-project` | 2 秒 | 開啟「示範：兩軌練習」：「與目前內容及本機核心一致」、Strict Mobile 技術檢查 PASS、提醒 1 項（Melody `CROSS_ROLE_END_TIME_REVIEW`）、六軌摘要（Melody 11 拍、Chord1 12 拍、其餘空軌）、總拍長 12 拍、Tempo T120、拍號 4/4、各驗收面向（只有 `strict_mobile_technical` 為 PASS，其餘 PENDING／NOT_RUN） |
| `ipad.png` | iPad Pro 11-inch (M5) | 無 | 10 秒 | 分割畫面：左側空專案庫與 Canonical 狀態，右側「選擇或建立專案」 |
| `ipad-demo.png` | iPad Pro 11-inch (M5) | `-demo-project` | 21 秒 | 左側列出兩個示範專案與上次檢查摘要（「兩軌練習」技術 PASS、「Tempo 256」技術 FAIL），右側為與 iPhone 相同的結果畫面 |

畫面上的 PASS、FAIL、提醒與摘要都是本機核心的回答：`-demo-project` 只透過 `Workspace` 建立專案、
填入 MML 與拍號、執行檢查並關閉（儲存），不陳述任何判定。iPad 在剛開機的 Simulator 上要 10–21 秒才就緒，
與第一次 Visual Smoke（`dd8a928`，固定等 8 秒）的 iPad 截圖拍到仍在啟動的 App 一致。
這些截圖證明 App 在 iOS Simulator 上啟動、載入 Published Canonical 並以本機核心完成檢查；
不證明互動操作或實機行為（§4.5）。

### 4.4 最大 Final 字串的檢查時間（六軌各 2400 字，約 11,500 音）

| 環境 | 時間 |
| --- | --- |
| Linux JavaScriptCoreGTK，JIT | 0.38 秒 |
| Linux JavaScriptCoreGTK，`JSC_useJIT=false`（接近 iOS App 的無 JIT 條件） | 2.2–2.4 秒 |
| macOS runner（Xcode 26.6），`swift test` | 2.25 秒 |
| iOS Simulator（macOS runner，Xcode 26.6） | 1.50 秒 |
| iPhone／iPad 實機 | **UNVERIFIED** |

### 4.5 UNVERIFIED

- 在 iPhone 或 iPad 實機上執行（需要簽署與裝置）；實機效能；實機飛航模式操作。
- 互動操作：CI 只有啟動截圖，沒有 UI 自動化測試。
- 簽署、上傳 App Store Connect、TestFlight 與 App Store 審核（見 §5）。
- 以 WKWebView 或其他方案的效能比較（ADR-001 的比較是依架構特性，不是實測）。

## 5. 開發與交付流程（沿用 a91453/railway-game-ios）

| 層 | 在哪裡跑 | 驗證什麼 |
| --- | --- | --- |
| 1. Claude Code Cloud | Linux 容器 | 共用核心的 Node 測試；MMLKit 在 WebKitGTK 的 JavaScriptCore 上建置與測試。沒有 Xcode、Simulator、SwiftUI |
| 2. `ios-app-ci.yml`（Linux） | App、核心、Manifest 或建置變更 | MMLKit 在 Swift 6.0 與 6.4，warnings as errors |
| 3. `ios-app-ci.yml`（macOS） | 同上 | 提交的專案與 `project.yml` 一致、shared scheme、可封存產品；MMLKit 在 macOS 與 iOS Simulator；App 以 Apple SDK 建置（Simulator、裝置） |
| 4. `ios-visual-smoke.yml` | 手動，及修改它的 PR | iPhone、iPad Simulator 啟動、等 App 回報就緒、截圖（含 `-demo-project`）→ artifact，可在手機上看 |
| 5. `ios-release-archive.yml` | 手動，及修改專案設定或 App 資源的 PR | 未簽署 Release archive 與檢查 |
| 6. TestFlight | **尚未建立** | 見下 |

TestFlight 是下一步：沿用 railway-game-ios 的 `testflight.yml`、`testflight-checks.yml` 與
`.github/scripts/testflight-*.sh`（以 App Store Connect API key 自動簽署 → IPA 檢查 → 上傳 → 內部
TestFlight；只能由 owner 從 `main` 手動觸發；secrets 只放在 GitHub environment）。移植需要把腳本裡的
專案、scheme、App 名稱與 bundle id 參數化，並先有 owner 決定的 Apple Developer team、正式 bundle id 與
App Store Connect app。App Store Connect 只接受 Xcode 26 以上建置，本 branch 的 CI 已在 Xcode 26.6。
Stage 1 刻意不移植：在帳號就緒前，它只能以假值自我測試，無法證明簽署或上傳。

## 6. Review 紀錄

獨立 review（對 `d02635d..bb54a94`）與自我 review 找到並已修正：

| 發現 | 修正與驗證 |
| --- | --- |
| 關閉的 session 晚到的檢查會把舊內容寫回，覆蓋重新開啟後的新編輯 | 每個專案一個 live session；以延遲的核心重現，拿掉修正時 regression test 失敗 |
| 核心載入前開啟的專案永遠無法檢查；多個 iPad 視窗會重啟核心 | session 使用時才讀取核心；`startCore` 只執行一次（失敗可重試）；regression test |
| 刪除正在開啟的專案可能被 session 寫回 | 刪除前 discard session；regression test |
| 切換專案時儲存失敗會默默遺失編輯 | 儲存失敗時停留在該專案，錯誤保持顯示 |
| JavaScriptCore 呼叫參數未受 GC 保護 | 每個參數在呼叫期間 `JSValueProtect` |
| `collect` 在結果無法序列化時回傳 `null` | 先序列化再標記完成；失敗時為 `INTERNAL_ERROR` |
| 文件把 JSON 等值寫成逐位元組；把未提交的實驗寫成已驗證 | 文件改正；實驗改為提交的全引擎可攜性 regression |
| 匯出檔名直接用標題（空白或 `/` 會出錯） | 清理檔名，永不隱藏 |
| 第一次 Visual Smoke 的 iPad 截圖拍到仍在啟動的 App（固定 8 秒不夠） | App（Debug）回報就緒或失敗，截圖腳本等待；失敗或逾時則該步驟失敗。`ecb208e` 上 iPad 10、21 秒就緒，四張截圖皆正確（§4.3） |

## 7. 仍存在的風險

1. **無 JIT 的效能**：最大字串約 2–3 秒；只以按鈕觸發。需要實機量測（§4.4）。
2. **核心與 App 的建置順序**：Xcode 建置前必須先 `npm run build:native-core`（缺檔會明確失敗）。
3. **Host shims** 是本 Stage 新增的程式碼，只涵蓋資料值與 UTF-8；已與 Node 比對，但 Stage 2
   使用更多引擎時需要擴充測試（例如 community formats 的 Big5）。
4. **既有的 Workshop 方言 parser** 與 Studio parser 以鏡像方式同步（架構文件 §2.3），
   本 Stage 未處理。
5. **Bundle identifier 與專案格式名稱是暫定值**（owner 的 GitHub namespace），正式上架前需確認。
6. **專案只在本機**：沒有 iCloud 同步；刪除 App 會刪除專案（匯出檔除外）。

## 8. 延後項目（刻意不在 Stage 1）

來源管理（MIDI、MusicXML、原曲）、MIDI／MusicXML 匯入、3MLE 格式、六軌編輯器、Melody／Chord 分軌編輯、
version drift、Studio 審核流程（Lead、Core3、harmony、G11–G12、Mobile adaptation）、Final MML 產出、
播放與試聽、Files／iCloud 文件整合、與 Agent Control Plane 的連接、UI 美化、privacy manifest、TestFlight 流程（§5）。

## 9. 建議的 Stage 2

1. **TestFlight**：owner 決定 Apple Developer team 與正式 bundle id 後，移植 railway-game-ios 的
   TestFlight workflow 與腳本（§5），加上 privacy manifest；第一次真實上傳由 owner 觸發。
2. **匯入來源**：facade 加入 bytes 傳遞與 `ingestMIDI`／`ingestMusicXML`（全引擎可攜性 regression 已證明
   它們在裸 host 的結果與 Node 相同）；專案套件保存來源檔與其 SHA-256；conformance case 擴充到 intake。
3. **Canonical IR 與 version drift**：顯示來源與候選的差異；定義與 Studio Web 備份的匯入匯出
   （匯入的審核一律需重新審核）。
4. **實機驗證與效能**：在實機量測無 JIT 的檢查時間；必要時在共用核心內最佳化（所有 host 受益），
   而不是在 Swift 重寫。
5. **共用核心收斂**：規劃 Workshop 方言 parser 與 Studio parser 的收斂，消除鏡像同步。

## 10. 需要 owner 決定的事

1. 正式的 App 名稱、bundle identifier（目前暫定 `io.github.a91453.MMLApp`）、Apple Developer team 與 App Store Connect app，以及何時開始 TestFlight。
2. 是否需要 iCloud／Files 文件整合與跨裝置同步。
3. Workshop 編輯器在 iOS 上的方向：原生重做、以 Web 形式嵌入，或維持在 Studio Web。
4. App 是否要登入 Agent Control Plane（在裝置上保存 OAuth 憑證），以及其範圍。
