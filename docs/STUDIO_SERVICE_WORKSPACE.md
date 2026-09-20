# 服務專案：瀏覽器與外部 agent 共用同一個 run

Status: IMPLEMENTATION NOTES。沿用既有 Application Service、OAuth、音樂引擎與
Phase 1／2 policy。本次沒有部署正式服務、搬移本機歌曲或更動 Canonical。

## 已完成的入口

服務現在提供 `https://SERVICE_ORIGIN/studio/`。既有 PWA 原始碼的「服務專案 ·
AI / MCP」連結也可開啟連接頁，再前往服務來源。原本的本機工作區仍使用
IndexedDB／Web Worker；服務工作區使用 `/api/v1`，與同一 OAuth owner 的
`/mcp` 共用來源、project、run 與 proposals。

登入使用既有動態 client registration、owner consent 及 PKCE S256。
只增加精確的同來源 `/studio/` OAuth callback，不開放其他任意 callback。
access／refresh token 只留在頁面記憶體；OAuth pending state／verifier 暫存在
sessionStorage，交換時清除。重新整理整個網頁後需再登入。畫面的「重新讀取」
只重讀服務資料，不會丟失登入。

畫面可建立／選擇專案、上傳 MIDI 並啟動 run、加入原曲音訊、查看各階段與
review requests、讀取 proposal 詳情、複製外部 agent 接續資訊、重算並下載
候選 review，以及下載有效 completed run 綁定的 Final MML。接受 proposal
仍由已授權的 agent／既有 reviewer 入口依 policy 執行；本頁沒有代填 confirmations。
9/21 新增明確的 Mobile profile／Gate 8 reviewer 表單；只有使用者填入並提交的
候選審查會送往既有 reviewer API，操作與證據見下節。

## Mobile profile 與 Gate 8 reviewer 操作

1. 選擇已完成角色與六軌分配、尚未結案的 run。畫面顯示審查候選與 revision。
2. 填寫 profile 名稱、目標樂器／測試情境、理由、證據及接受者名稱；在需要的
   角色填入音域或音量。初值全部空白，省略的欄位維持候選原值。
3. 按「預覽 Mobile 適配」，展開事件變化、衝突與 blockers。PASS 只表示可執行。
   修改任何 profile 欄位或接受者，必須重新預覽。
4. 按「接受預覽並接續此任務」。呼叫既有 `resumeRun.mobile_adaptation`，攜帶
   profile、plan id、接受者、observed run revision 與 idempotency key，仍是同一 run。
5. 按「重新計算候選審查」，查看 gates、來源／上一版本差異與已記錄的審查。
   可下載完整 report。再填 Gate 8 審查者、結論、理由及證據，按「記錄 Gate 8
   審查並接續」。結論沒有預選；無需額外調整的判斷也必須提供依據。
6. 查看更新的 run gates。此操作只提供 `mobile_adaptation_reviewed`；其他 gate
   不會被 UI 一起確認。新候選會使舊 Gate 8 review 失效，必須重算並重新審查。

預覽／review 都綁定 project、run、candidate 與 revision。提交前讀回最新 run，
後端再以 `expected_run_revision` 防止競爭寫入。來源過期、未完成 G12、有未確定
step 或已產生結案報告的 run 不開放這些提交。網路結果不明時先清除可提交的本機
預覽，要求重新讀取；不會自動重送相對音量調整。profile 草稿不跨登入持久化。

這是既有 reviewer 流程的 UI，不增加 agent proposal 的 gate 權限；不能把任意
Gate 8 request 改成 `MOBILE_ADAPTATION_BLOCKED` 來接受 profile proposal。
完整驗證與真實歌曲現況見 [9/21 紀錄](KAIJU_FINAL_MOBILE_REVIEW_2026-09-21.md)。

## 重複操作

1. 在已有此版本程式的服務開啟 `/studio/`，登入後建立獨立測試專案。
2. 選擇真實來源身分與 `.mid`／`.midi`，按「上傳 MIDI 並啟動任務」。
   沒有官方證據時維持第三方來源，不能用下拉選項代替證據。
3. 若啟動回應中斷，按「沿用原請求重試啟動」。本分頁保存的 asset_id 與
   idempotency_key 會重用，避免新增第二個 run。若連上傳結果都未知，先按
   「重新讀取」核對專案來源，再從「專案已有來源」選取，避免盲目重複上傳。
4. 按「複製外部 agent 接續資訊」，交給已連接**同一服務**的 Codex／其他外部
   agent。文字包含服務來源、project_id、run_id、observed_revision；不含 token，
   也不構成對任何新 proposal 的接受。agent 先讀現況及 proposal targets，再依
   本次任務已給的授權處理。CLI 操作見 [外部 agent runbook](CODEX_EXTERNAL_AGENT_RUNBOOK.md)。
5. 使用「重新讀取」查看外部 agent 的提案及 run。必要來源判斷、Lead／Core3
   evidence、聽驗、人工確認與實機接受仍保持既有政策，不能因 UI 顯示提案就宣稱通過。
6. 有 candidate 時可「重新計算候選審查」及下載完整 JSON。這只重算報告，
   不寫入 review artifact、不記錄人工確認。需保存 JSON 才能留下此次 review。
7. run completed 且有有效 Final artifact 才可下載 MML。下載前重新核對 run
   staleness、revision、artifact_id、artifact type 與 candidate 綁定；過期結果拒絕匯出。

原曲音訊可保存到專案，但上傳不等於完成 audio alignment 或聽驗。
預設使用手動外部 agent 交接；本分支另提供需主機設定、使用者明確啟動的
[自動 agent 接續](STUDIO_AGENT_CONTINUATION.md)，可在分頁關閉後由服务程序完成
本次有限步數執行。服務重啟不會自動重跑。

## 修復的部署打包缺陷

新增分頁後，`server/mcp-studio.mjs` 已匯入 `server/report-page.mjs`，但 Docker
allowlist 沒有納入該檔案；repository checkout 可以跑測試，依 allowlist 打包的
服務卻會在載入入口時缺模組。本次補上該模組、服務靜態 router 與四個工作區
資產，並同步 source-controlled watch pattern 參考。未更動線上 Railway 設定。

新增 regression 從 `.dockerignore` 允許的檔案實際組出 image filesystem，匯入
`railway/server.mjs`，並讀取四個工作區資產。這是 staging regression，**本次
沒有執行 Docker daemon image build，也沒有部署正式站**。

## 瀏覽器與真實歌曲驗證

測試入口使用真正的本機 HTTPS server、既有 OAuth 密碼 consent／PKCE、HTTP API
與 authenticated MCP。每個 profile 使用獨立持久化歌曲 store，OAuth DB 為記憶體。
測試憑證只用於該 browser context／MCP probe；沒有修改正式 TLS 或登入要求。

需要 Node、已安裝的 Playwright Chromium／WebKit 及 OpenSSL：

```powershell
# 若 openssl 已在 PATH，可省略這行；Windows Git 的實際安裝位置可能不同。
$env:STUDIO_TEST_OPENSSL='C:\Users\11407\AppData\Local\Programs\Git\usr\bin\openssl.exe'

# 合成 regression；含另一個獨立 fixture 的 review / Final MML 下載。
node studio/browser-tests/service-workspace.mjs --out .studio-agent/service-browser-regression

# 真實素材；不會替它填 confirmations 或產生假的 completed run。
node studio/browser-tests/service-workspace.mjs --midi .studio-agent/real-song/source/Kaiju_no_Hanauta__Vaundy_Piano.mid --out .studio-agent/service-browser-real-midi
```

兩個命令均測 desktop Chromium、iPhone WebKit、iPad WebKit。可加 `--desktop`
只測桌面。輸出目錄包含 screenshots、verification.json、獨立 store 與測試用
一天效期憑證；`.studio-agent/` 被 Git 忽略。不要提交來源音樂、store、token 或私鑰。

2026-09-20 的實測結果：

| 驗證 | 結果 | 限制 |
| --- | --- | --- |
| 真實 MIDI：登入→建立專案→上傳→run→同 owner MCP 讀取→提案回到 UI | 三種 profile 全部通過 | run 均 awaiting_review，無 Final artifact |
| 真實 MIDI：server 已保存 run 後刻意丟棄 start 回應，再用相同 key 恢復 | 三種 profile 均回同一 run，未重複建立 | 不是任意操作的自動重試機制 |
| 獨立合成候選 review 與 Final MML 下載 | 三種 profile 內容均與 service 相同 | fixture confirmations 限定測試專案，不能當成真實歌曲驗收 |
| 舊本機 PWA regression | 三種 profile 全部通過 | 保留本機流程；不代表正式站已更新 |

來源 MIDI 為 11,506 bytes，SHA-256
`58619209f743416fa2150471b079cc14796e92911000793fce98384603c18487`。
機器可讀證據：[真實 MIDI](evidence/mcp-agent-2026-09-20/service-browser-real-midi.json)、
[合成 regression](evidence/mcp-agent-2026-09-20/service-browser-regression.json)。

完整 Node suite 1742 PASS／0 FAIL（87.089 秒），199 次 Canonical bootstrap
保持單一 published identity／snapshot，shared refs 未改。Studio Web build PASS，
62 個 assets；`git diff --check` 通過。完整 suite 指令：

```powershell
node scripts/bootstrap-stress.mjs --runs=1 --keep-logs -- node --test --test-reporter=tap --test-concurrency=4 'tests/*.test.mjs' 'studio/tests/*.test.mjs'
```

原歌曲 store record SHA-256 仍為
`abb3d886dead6d5577254adeda91dcda82e2d3bd7385b704c57efcd4c7a821df`；原 run revision 12
保持 awaiting_review。本輪新瀏覽器驗證沒有修改它。

## 尚未完成

歌曲目標是 Piano MIDI 版本或 M4A 原版全樂隊仍待回答；orphan NoteOff、Lead／
角色來源證據、有效音訊對齊、Mobile profile、聽驗與實機接受仍未解決。這輪沒有
額外要求使用者介入，先完成不依賴該答案的 UI／傳輸工作。

Gate 8 的 Phase 2 proposal policy 只允許 evidence_needed；agent 不能自行新增
缺 profile 的接受通道。profile 仍需由既有 reviewer 路徑提供實際資料。
網站一鍵持續運作還需要外部 agent 的喚起／續跑接線與需要人工時的交接；目前
提供的是手動複製接續資訊。完整真實歌曲 MML、音樂品質與遊戲實機驗收均未完成。
