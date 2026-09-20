# 外部 agent CLI：Code Review 修正紀錄

Status: IMPLEMENTATION NOTES；不變更 Canonical 或 agent 接受政策。

使用者提供 Claude 對 `ecbbb46bb481ad4395729c9df6f01c140e1f1bee` 的審查報告後，
Codex 在 Windows 本機重新核對並重現以下問題。此文件記錄本機驗證，
不把 Claude 報告中的 Linux 測試數字當成本機執行結果。

## F1：失效 completed run 仍可匯出

確認為本輪 CLI 引入的缺陷。`getRun` 已提供 staleness，但原本 `export`
只保留 `run`，成功回應及 receipt 均遺失失效訊號與當前 Canonical provenance。

重現使用獨立合成 fixture 與既有 Application Service：先透過正常引擎完成 run，
再上傳另一份 fixture 並重新 intake。服務回報 `RUN_BASELINE_CHANGED` 與
`RUN_CANDIDATE_CHANGED`；修正前 `export` 仍退出 0 並寫出舊 MML。
沒有直接改寫 run 狀態、gate 或 artifact 來建構這個案例。

修正後，任何非空 staleness 都會使匯出退出 1，回報 `AGENT_INPUT_REFUSED`，
不建立 MML、不修改 run。`error.details` 保留 run ID、完整 staleness、
staleness_notice 與當前 canonical；receipt 保存相同結果。
成功匯出也保留這三個服務欄位，artifact 本身的產出 provenance 仍完整保留。
這是 CLI 交付檢查，不是新增音樂規則，也不聲稱重新驗證所有 bytes 或 gates。

## F2：review 的 artifact 說明錯誤

確認為 CLI 與 runbook 的錯誤描述。未提供 confirmations 的 review 只計算報告，
不建立 store artifact。原本同一個錯誤 notice 還套用到 suggestion／reduction。

修正為各 kind 的獨立說明；runbook 明確區分本機 `--out` 報告、receipt 和
service store artifact。報告本文位於 `--out`，receipt 保留路徑與操作結果，
因此搬移／稽核時必須保留兩者。沒有為配合原本的錯誤說明而新增 artifact 寫入。

新增 regression 對 review／reduction 執行前後的全部 store records 與 blobs
逐位元組比對，確認未改寫 run、confirmations 或建立 artifact。
真實歌曲也重新執行 review，確認專案 record 的 SHA-256 前後一致。

## F3：工具表不一致時錯誤分類不正確

保留為防禦性修補：現有 allowlist 與工具表對應，正常操作無法觸發。
測試暫時移除一個 allowlist 內的工具後，原本會將 TypeError 訊息以 `-32602`
回報成 caller input 錯誤。修正後在 schema validation 前檢查工具存在，回報
固定 `INTERNAL_ERROR`，不 dispatch，也不外露 TypeError；測試後恢復工具表。

## 驗證

可重跑的 CLI regression：

```powershell
node --test tests/studio-agent-cli.test.mjs
```

完整 suite 與 Canonical bootstrap isolation（主機須能找到 Git、Node 與 sh）：

```powershell
node scripts/bootstrap-stress.mjs --runs=1 --keep-logs -- node --test --test-reporter=tap --test-concurrency=4 'tests/*.test.mjs' 'studio/tests/*.test.mjs'
node scripts/build-studio-web.mjs
git diff --check
```

本次結果另記在 [verification.json](evidence/codex-external-agent-2026-09-19/verification.json)
的 `review_followup`，與第一次歌曲驗收的歷史結果分開。

- CLI：9 PASS／0 FAIL。
- 完整 suite：1722 PASS／0 FAIL，退出 0，83.98 秒；wrapper 未保存 skip 計數。
- Bootstrap isolation：197 次、單一 published identity、單一 rules snapshot，shared refs 未改。
- Studio Web build 與 `git diff --check`：PASS。
- 本次沒有重跑音訊／瀏覽器測試；原報告的結果是前次執行紀錄。

## 真實歌曲狀態

《怪獣の花唄》重新計算 review、讀取 run 並嘗試 export：仍是 revision 12、
`awaiting_review`／`AWAITING_ACCEPTED_REDUCTION_DECISIONS`，匯出如實拒絕。
專案 record SHA-256 仍為
`abb3d886dead6d5577254adeda91dcda82e2d3bd7385b704c57efcd4c7a821df`。
新 review 報告保存在忽略的 `.studio-agent/kaiju-review-after-code-review.json`；
逐次 receipts 在 `.studio-agent/real-song/receipts/`。

本次沒有新增使用者介入請求，也沒有把 test fixture confirmations 用於歌曲。
尚無真實歌曲 MML；來源／Lead/Core3 證據、聽驗與實機阻塞見
[原驗收報告](CODEX_EXTERNAL_AGENT_ACCEPTANCE_2026-09-19.md)。
這些 CLI 修正不代表已完成歌曲或網站自動持續執行。
