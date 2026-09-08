# MML Workbench

可自行修改的瑪奇 Mobile 六軌 MML 檢查與預覽工作台。網站核心 v0.1.0，工具服務 v0.2.0。

## 獨立主機部署

`railway/` 提供獨立的 Node HTTP 服務、單一擁有者 OAuth、Dockerfile 與部署說明；它沿用原有 MML 核心。此版本採用 OAuth DCR、公用客戶端與 PKCE S256，授權資料保存於獨立 SQLite volume，MML 不入庫。請依 `railway/README.md` 完成環境變數、持久磁碟及來源連接。

私人 GitHub 程式庫為 `a91453/mml-tools`；Railway 精確目標與進度記錄於 `railway/deployment-target.json`。部署使用 Railway 服務設定及 `railway/Dockerfile`，不使用新服務已停用的 `railway.toml` 設定方式；`railway/service-settings.json` 保存不含密碼的設定參考。本機 75 項測試通過，包括經由實際本機 HTTP 的 OAuth＋MCP 呼叫；本機測試、正式 HTTPS 檢查及使用者在 ChatGPT 的連接驗收分開記錄。

Railway 已於 2026-09-08 22:48 UTC 完成部署，GitHub 來源為 `a91453/mml-tools` 的 `main`。已觀察到 `/healthz` 200、OAuth metadata 200、未登入 `/mcp` 401；完整使用者 OAuth 與授權後工具呼叫仍需另外驗收。正式工具網址為 `https://mml-tools-production.up.railway.app/mcp`，採 OAuth DCR。較早的「Application not found」是歷史部署狀態，不是目前的登入錯誤原因。

登入頁修正：只將 HTML 的 `Referrer-Policy` 設為 `same-origin`，避免一般表單送出被 `no-referrer` 轉成 `Origin: null`；保留嚴格來源、CSRF、密碼及 PKCE 檢查。此修正已部署，2026-09-08 23:18 UTC 的正式 HTTPS 檢查確認登入頁政策正確、同來源請求通過來源及 CSRF 檢查、`null` 來源仍拒絕；合成檢查明確拒絕授權，沒有提交擁有者密碼，也不代表本人登入完成。請從 ChatGPT 開始新的連接流程，不要重送舊登入頁。目前尚未觀察到 `/data` 持久磁碟，重新部署會遺失 OAuth 註冊及授權資料；需補上持久磁碟後才能依賴跨部署授權保存。

## MCP 工具服務

新增 `POST /mcp`，使用無狀態 Streamable HTTP：

- `mml_service_info`：版本、能力與限制。
- `mml_validate`：完整六軌技術檢查、字數、Tempo Map、拍長、小節及全部 15 對重疊摘要。
- `mml_overlap_details`：同音重疊與低中音小二度／大七度區間，完整計數並可分頁取得明細。

所有工具均唯讀，不改寫歌曲、不自動下載、不呼叫模型 API。呼叫檢查時，需明確提供 `mml` 與來源確認的 `meter_text`；例如 `0 4/4`，不能在來源未知時假設拍號。工具只處理本次傳入的資料，不會自動讀取其他對話、網站編輯器或使用者音檔。程式不保存或記錄工具傳入的歌曲；平台自身的資料政策仍適用。

`technical_ok` 和技術 PASS 不代表來源比對、聽驗、播放器回讀或遊戲驗收完成。MCP 首版沒有音訊播放與 MIDI／ABC 匯出工具；現有瀏覽器工作台仍提供這些功能。

Sites 版本依賴 Sites 的私人存取閘道。Worker 僅在閘道提供可信身分標頭後接受 MCP 呼叫；不可將 Worker 直接放到會接受任意身分標頭的公開主機。Railway 版本則使用 `railway/server.mjs` 與自己的 OAuth，不信任 Sites 身分標頭。兩者的正式 MCP URL 與 OAuth resource 不可混用；本機路由測試不能證明使用者 OAuth 連接已完成。

傳輸支援 2025-03-26、2025-06-18、2025-11-25 協定版本的此服務所需子集：initialize、ping、tools/list、tools/call、初始化與取消通知。不宣告資源、提示詞、工作排程、通知串流或工作階段能力。GET /mcp 回應 405 是預期行為；需 POST 才能進行協定測試。

## 使用

1. 貼上 `MML@...,...,...,...,...,...;`，或開啟 TXT/MML。
2. 依來源確認拍號圖、弱起及末小節，按「檢查並載入」。
3. 選 Melody、單人前三軌或完整六軌試聽。
4. 可加入本機原曲音檔，設定第0拍對應的音檔秒數，切換原曲與MML。
5. 匯出 MML、Preview MIDI、完整ABC、驗證回讀JSON或專案JSON。

沒有外部JavaScript、音色CDN或執行期套件依賴。以原生Web Audio提供程序合成音色；這不是Mabinogi Mobile音色模擬。網頁及音檔由瀏覽器處理，不上傳原曲。專案JSON保存MML與設定，音檔另行保留；本版不做背景自動保存。

## 可溯源驗證

- `core.js`：BigInt有理數MML解析、Strict Mobile profile、拍號與小節、完整15對重疊區間、MIDI/ABC編碼與各自解碼、逐事件及控制資料比對。
- `player.js`：從實際MIDI bytes解碼後持有自己的引擎資料；回讀匯出真正載入的資料及播放排程，保留session/hash/範圍。不会把來源預期值寫回去修成一致。
- `app.js`：完整字串、原曲A/B、依版本失效的檢查結果、匯出與載入。
- `tests/`：歷史事故反例；含錯誤音量、Program、拍號、事件、rest-tie、Nxx及混合拍號等。

新工作台並未修改既有安裝版 `mabinogi-mobile-mml` 技能或Python驗證器。它是一個獨立且可匯出的實作。

## 驗收範圍

`PASS` 僅屬於具名檢查。播放器回讀檢查的是載入引擎與排程，音訊context尚未啟動會明載 `not_started`。回讀不是硬體輸出錄音，不是Midify的widget回讀，不證明全曲已聽過，更不是Mobile實機驗收。

原曲身份、有效區間、分層聽驗及遊戲驗收不會自動變成PASS。有效時長比較由使用者輸入的已確認範圍計算；不自動使用容器長度、不裁尾湊2%。

來源可保留精確事件；Strict Mobile交付限制單獨施加。本版可直接解析的分母為1、2、3、4、6、8、12、16、24、32；拒絕Nxx、雙附點、附點三連音式寫法、48/64及更細時值。拒絕不等於自動重寫：輸出需依來源完成最小必要適配。

ABC輸出使用L:1/4、K:C、完整展開、小節線、同音tie及明確拍號變化。與第三方播放器的方言相容性仍需在該播放器實際載入後驗證；不宣稱Midify已支援本版的混合拍號。

GM Program及CC7會被保留並逐事件核對。聽感採有限的程序合成近似，沒有完整GM SoundFont。鼓音需自備有來源證據的Mobile音位→GM鼓面表；JSON中填写evidence不能自動證實其真實性。

## 修改及測試

使用Node.js 22以上：

```sh
node --test tests/*.test.mjs
```

網站原始頁面放於 `dist/`。以任一支援 ES Modules 的本機 HTTP 服務開啟；不要直接以 file:// 開啟。Web Audio 需使用者點擊播放及可用音訊 context。

部署建置執行 `node scripts/build.mjs`，需要 Node.js 22 以上和 `zip`。建置將共用核心、MCP 服務及原有網站資產組成單一 Worker ESM，輸出到 `dist/server/index.js`，並複製部署設定到 `dist/.openai/hosting.json`。不需要安裝 npm 套件；也不會存取網路。

測試包含合成曲譜、MCP 握手與工具結果、參數和容量限制，以及缺少閘道身分時的拒絕處理。以合成身分標頭測試 Worker 僅驗證本機路由邏輯，不能當成正式 OAuth 或端到端連線驗證。

既有測試使用合成音符及假的AudioContext驗證排程契約，未執行瀏覽器UI或真實音訊硬體驗收。手機／iPad首次播放、音訊中斷恢復、长曲與實際音色需使用者試聽後繼續校正。

原始碼下載包不包含任何使用者歌曲、音檔、登入資料或部署憑證。原始碼、事件格式與測試都可帶走；Sites上的原始碼亦已版本化。
