# ADR-002：離線與伺服器的邊界（App、Studio、Workshop、MCP、Railway）

Status: Accepted（Stage 1，2026-09-29）。架構決策紀錄，**不是 Canonical 規則來源**。
相關：[MML_APP_ARCHITECTURE.md](MML_APP_ARCHITECTURE.md)、[ADR-001](ADR-001-core-portability.md)。
Railway 操作一律遵守 [RAILWAY_AGENT_POLICY.md](../RAILWAY_AGENT_POLICY.md)。

## 背景

在 Stage 1 之前，想在手機上得到 Published Canonical 技術檢查有兩條路：在 Safari 開 Railway 託管的 Studio PWA，
或透過 AI client 呼叫 Railway 上的 MCP。前者依賴網頁託管，後者依賴網路、OAuth 與伺服器。
原生 App 要以離線為主，但不能因此廢掉伺服器上真正有價值的能力。

## 決策

### 1. App 本機即可完成（Stage 1 的工作流程全部在此）

- 建立、開啟、編輯、刪除專案；匯入 MML 文字；匯出專案檔與分享 MML 文字。
- Published Canonical 技術檢查（MCP `mml_validate` 的同一份實作）及其診斷。
- Canonical identity 與六份已發布文件的離線閱讀。
- 結果是否過時的判斷（請求與 engine stamp 的比較）。

這些步驟**不使用網路**：App 原始碼沒有 URLSession、Network、WebKit 或 socket（有測試掃描），
JavaScriptCore context 也沒有任何網路 API。不收集 telemetry。

### 2. Studio／Workshop 可在本機共用

- Studio Web 在瀏覽器 Worker 執行同一份核心；Workshop 在瀏覽器執行。它們需要的是
  靜態網頁託管，而不是伺服器端的 MML 執行。
- App 與 Studio Web 共用同一份 Canonical runtime package（同一 digest），因此對同一 release 的判定一致。
- 專案格式各自版本化：Studio Web 為 IndexedDB 的 `mml-studio-web/workspace@1`，App 為
  `io.github.a91453.mml-tools.project` schema 1。跨 host 匯入匯出屬 Stage 2+，必須沿用
  「匯入的審核紀錄需重新審核、不能帶入現成的 acceptance」規則。

### 3. 透過 MCP 對外提供

- MCP 是 Claude、ChatGPT 與其他 agent 的 integration surface：三個技術工具、`studio_*` 工具與
  `studio_listen`。它維持在 Agent Control Plane，App 不經過它。
- App 與 MCP 共用 `application/technical-service.mjs`；報告格式不變。本 Stage 未修改任何 MCP 工具。

### 4. Railway／伺服器仍值得保留

| 能力 | 原因 |
| --- | --- |
| MCP、OAuth、`/api/v1` | AI client 需要可連線的端點與授權 |
| One-Click Orchestrator、AI Proposal Protocol、持久工作紀錄 | 跨請求的工作狀態、多 agent、稽核紀錄需要伺服器端儲存 |
| 原曲對齊（Python／FFmpeg audio-worker） | FFmpeg 與 DSP；以明確上傳的選用服務提供 |
| Audio prescreen 渲染 | Node worker_threads + sound bank |
| Studio PWA 託管（Permanent Studio Web） | 網頁使用者仍需要；與 App 無關 |

### 5. 從 App 執行路徑完全移除的 Railway 依賴

技術驗證、Canonical identity、規則文件、專案儲存。App 的 Stage 1 工作流程在構造上不含任何網路路徑
（原始碼掃描測試、無網路 API 的 JavaScriptCore context、完整流程測試皆在無網路依賴下通過）；
實機飛航模式操作 **NOT VERIFIED**。沒有任何「先試本機、失敗再打伺服器」的 fallback。

### 6. 未來的遠端能力（Stage 2+）必須遵守

1. **明確、逐次、由使用者觸發**：與 Studio Web 的原曲對齊相同，選擇檔案不會自動上傳；
   沒有預設的雲端端點。
2. **不取代本機 Canonical 判定**：遠端答案不能寫入本機的技術檢查欄位，也不能在本機核心不可用時頂替。
3. **憑證只在 session 中**，不寫入專案檔。
4. **由另一個 `MMLCoreEngine` 或專屬 client 實作**，UI 與專案模型不直接依賴伺服器。

### 7. Canonical 更新走 App 更新

App 不在執行期下載規則、runtime package 或核心程式碼（單一真值、可稽核、App Review 2.5.2）。
新 release 發布 → 重新建置核心 → 發布新版 App。舊結果依 engine stamp 自動標示過時。

## 取捨

- 離線優先的代價是規則更新需要一次 App 發布（TestFlight／App Store 審核時間）。
  以可稽核性與單一真值為優先；App 會清楚顯示它執行的是哪個 release。
- 伺服器上的能力（對齊、prescreen、agent run）在 App 中暫時不可用；需要時改用 Studio Web 或 MCP。

## 後果

- 「Railway 是部署選項，不是架構前提」有了可驗證的界線：App 的 Stage 1 路徑沒有網路程式碼，
  測試會在有人加入時失敗。
- MCP 保持為 AI 的入口，並與 App 共用實作，而不是成為 App 的後端。
