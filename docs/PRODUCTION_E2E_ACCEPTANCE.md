# 正式站端到端驗收

Status: IMPLEMENTATION NOTES — **完整正式站驗收仍為 PENDING**。
這是服務傳輸驗收，不新增 Canonical 或接受政策。

## 起點與規則身分

| 身分 | 本輪值 |
| --- | --- |
| Published main / 預期部署 source | `bbb8534245c78041573fd93af88c8fc7fd3e89bd` |
| Canonical version / status | `2026-09-13-v1` / `PUBLISHED` |
| Manifest version | `2026-09-13-v1-manifest1` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| Rules snapshot | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| 工作分支 | `codex/production-e2e-acceptance` |

先從 GitHub Published main 取得 Manifest，再從 snapshot 載入四份規則、
inventory 與 supporting evidence。它們的權限分開，測試不能反向定義規則。
工作分支／PR SHA 是驗收工具版本，不是規則或部署版本。

## 驗收邊界

| 層次 | 執行與成功條件 |
| --- | --- |
| 公開正式站 | HTTPS health、Published 身分、四份資產 bytes、MIME/CSP/no-store、路由、OAuth issuer/endpoints、未登入 API/MCP 401 |
| 網頁與外部 MCP client | 使用者實際 OAuth 登入；新建獨立專案；MIDI 上傳；同 project/run/revision；evidence_needed 提案回到 UI；handoff 保留；Final 維持禁止下載；reload 後 server run 仍存在 |
| ChatGPT connector | 需在已連接的 ChatGPT app 實際 discovery、呼叫同一 project/run；測試 client 不能代替此證據 |
| 真實歌曲 | 來源、人工判斷、各 Canonical gate、有效 Final 與事件回讀另行驗證 |
| 遊戲接受 | 只有使用者／受控目標 client 可提供；合成 MIDI、CI 或網頁成功均不證明 IN_GAME_ACCEPTED |

公開 probe 的 PASS 僅代表第一列。即使 live browser/MCP 通過，完整報告仍為
PENDING，直到其餘必要驗收有獨立證據。工具的 exit code `2` 表示驗收未完整，
`1` 表示執行失敗；不能因命令執行完就宣稱所有層次 PASS。

## 取得預期版本

需要完整 Git history、Node 22+。先完成正常 GitHub 驗證與 checkout，再執行：

```sh
git fetch origin main
git rev-parse refs/remotes/origin/main
git log -1 --format=%H refs/remotes/origin/main -- docs/CANONICAL_MANIFEST.md
```

下面命令的 SHA 是本轮已載入的值。若 main 已更新，先讀新 Published Manifest
及其 snapshot，並確認實際欲驗收的部署，再更新參數。
loader 確認選定 SHA 屬於 `origin/main` 歷史，從該 SHA 讀取 Manifest 與四個
web assets，再依 snapshot 讀取六份文件並驗證 headers；不使用工作樹／PR
規則，不 checkout 或修改使用者檔案。歷史不足時回報 CANONICAL_NOT_LOADED。

```sh
node scripts/studio-production-probe.mjs \
  --origin https://mml-tools-production.up.railway.app \
  --expected-main bbb8534245c78041573fd93af88c8fc7fd3e89bd \
  --manifest-commit 5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14 \
  --out .studio-agent/production-public-001.json
```

每次用新 evidence 檔名；工具不覆寫舊報告。公開 probe 不註冊 OAuth client、
不寫入歌曲；POST 只用於確認靜態路由 405 與未登入 MCP 401。
每個正式請求 timeout 30 秒。部署 SHA 是 HTTPS 服務自述，不冒充 Railway
control-plane 獨立查核；資產 SHA-256 則與選定 Published source bytes 實際比對。

## 登入後的正式網頁／MCP 驗收

需要可顯示視窗的本機桌面與 Playwright。不要把正式密碼或 token 貼到終端、
命令列或報告。工具開啟瀏覽器後，由使用者在正常 OAuth 畫面登入，最長等待
五分鐘；無自動輸入密碼或登入狀態匯出。

```sh
npm install --ignore-scripts --package-lock=false
npx playwright install chromium webkit
node studio/browser-tests/production-acceptance.mjs \
  --origin https://mml-tools-production.up.railway.app \
  --expected-main bbb8534245c78041573fd93af88c8fc7fd3e89bd \
  --manifest-commit 5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14 \
  --create-test-project --profile desktop \
  --out .studio-agent/production-browser-001
```

預設是 repository 自產的 synthetic MIDI，**不是歌曲**。可加 `--midi /path/song.mid`
測試已獲准的真實素材；這仍不證明來源完整、音樂品質或歌曲 Final。
每次都建立一個 `E2E acceptance <UUID>` 專案，不碰既有歌曲；正式服務會保留
測試專案、來源、run 與 evidence_needed 提案。不會自動刪除。
`--profile iphone`／`ipad` 使用 WebKit 行動尺寸模擬，不是實體 iOS 或遊戲實測。
每種 profile 各使用新的輸出目錄與專案。

每個 mutation 前先記錄 pending_step，成功後保存 project_id/run_id/proposal_id，
不保存 bearer、password、cookies、HAR、trace、browser state 或來源 bytes。
bearer 只從同來源 API 的實際登入請求留在程序記憶體；MCP 呼叫沿用該 OAuth
owner。讀大型報告使用既有雜湊驗證分頁。程式只提交 evidence_needed，不 resolve
提案、不 resume、不填 confirmations、不強行產出 Final。

中斷／失敗後，依 verification.json 的 project_title、ID、pending_step 與
瀏覽器服務資料核對結果；尤其上傳／提案可能已執行。**不自動重試 mutation**。
不要刪 lock 後盲目重跑；先核對現況，再用新目錄開始新的驗收專案。
reload 檢查只證明 remote run 不依附 browser memory，未測 server restart durability。

## CI 與剩餘項目

`service-workspace.mjs` 在既有 local HTTPS/OAuth regression 中共用
`production-workflow.mjs`，三種 profile 執行相同的網頁／MCP assertions。
CI 使用獨立 local store 與既有 synthetic OAuth fixture；不用正式 credentials，
也不連正式站。原有失落 start 回應／idempotency 及合成 Final fixture 仍保留。

目前環境缺可用 browser controller 與供 driver 使用的正式瀏覽器 OAuth session，
所以正式網頁登入後流程仍 NOT_RUN。既有 CI、Docker 或先前真實 MIDI 本機測試不能替代。

2026-09-20 已取得的正式證據：

- [公開 probe](evidence/production-e2e-2026-09-20/public-probe.json)：實際 HTTPS 檢查 PASS，
  四份資產 bytes 與 Published main 完全一致。Git clone 在此環境沒有認證，這次以
  GitHub connector 讀取固定 SHA 並核對 Git blob SHA 後執行 probe；新版 CLI 的
  Git-history loader 另有 regression，不宣稱此環境完成了 authenticated git clone。
- [連接器與部署](evidence/production-e2e-2026-09-20/connector-and-deployment.json)：
  現有已認證 MML Studio app 的 capabilities / project list 實際成功，專案清單為空。
  Server 宣告支援 run / proposal，但本對話可呼叫的 connector 清單缺少八個
  `studio_run_*` / `studio_proposal_*` 工具。需重新掃描／更新 app 的工具清單後，
  才能驗證 ChatGPT 對同一 browser run 的呼叫；僅此兩個成功 read 不算 connector E2E。
- Railway 控制台獨立確認 deployment `8f375cb5-4640-4b4c-a15f-662d66cae6e6` 為 SUCCESS、
  source commit 為 `bbb8534`、branch main、wait-for-CI 開啟、`/data` 掛載。
- live watch patterns 確認仍缺 `/server/report-page.mjs`、`/server/studio-web.mjs`、
  `/studio/web/service/**`；repository 參考設定已有，線上設定尚未補上。本分支未變更它。

真實歌曲 Final、聽驗、IN_GAME_ACCEPTED 仍待實際證據。公開實測前的 timeout 與
本機檔案取回多出換行造成的 hash mismatch 已分別重測／核對原始 Git bytes；
它們不作為正式站缺陷結論。

本分支不修改 runtime UI、Canonical、接受政策或部署設定；未 merge／deploy。
