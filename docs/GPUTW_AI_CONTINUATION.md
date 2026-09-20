# 沒有模型額度時，用 GPUtw.ai 繼續開發本專案

Status: IMPLEMENTATION NOTES。不是 Canonical，不變更規則載入順序、Phase 1／2 policy
或任何驗收標準。唯一規則入口仍是 [CANONICAL_MANIFEST.md](CANONICAL_MANIFEST.md)。

本文只回答一件事：當 Claude／Codex 的模型額度用完時，如何改用 GPUtw.ai 租來的 GPU
自架模型，繼續驅動本程式庫既有的 CLI 與 MCP 介面。**換模型不改變驗收**：`npm test`、
source／audio／player／in-game 的界線完全不變。

## 先確認 GPUtw.ai 是什麼、不是什麼

| | |
|---|---|
| **是** | 台灣的 GPU 整機租用雲（按小時計費、資料留在台灣、可開統編與學研報帳） |
| **不是** | LLM API 供應商。它不賣 token，也沒有現成的 Claude／GPT 相容模型端點 |

所以「沒額度時用 GPUtw 繼續寫 code」實際上是三層：

```
GPUtw GPU 執行個體  →  自架推論服務（vLLM，OpenAI 相容）  →  coding agent（Codex CLI／Claude Code…）
   （你租的機器）          （你自己起的 /v1 端點）              （你原本在用的工具）
```

GPUtw 的官方 AI 知識套件（[GPUtw-ai/GPUtw-Skill](https://github.com/GPUtw-ai/GPUtw-Skill)）
是教 agent **操作 GPUtw REST API**，不是提供模型。裝了它之後，agent 能用自然語言幫你
開機、看狀態、搬檔、關機；但要有模型可用，仍得自己在機器上跑起來。

## 成本現實（先算再做）

- 只有 `RUNNING` 在計費，`stop` 或 `delete` 立即停止。**忘記關機 = 整晚扣點數**，
  自動化流程結尾一定要接關機步驟。
- 目錄價以 USD/hr 表示、餘額以 NT$ 計；最低儲值 NT$100，入門卡每小時個位數台幣起跳，
  但跑得動 coding 模型的卡（大 VRAM 或多卡）不是最低價那一檔。實際價格以
  <https://gputw.ai/zh-TW/pricing> 為準。
- **你的 `@nkust.edu.tw` 信箱符合 EDU 帳號資格**（註冊贈點＋學研價），這是這條路線
  對你划算的主要原因。
- 判斷準則：等額度回復幾小時就能繼續的零星修改 → 直接等。**一次要做完一大批**
  （整輪 suggestion／review／finalize、大量測試修復、跨檔重構）→ 租機比較值得，
  因為成本是「時數 × 費率」而不是「請求數」。

## Step 1：拿到 API key，並讓 agent 看得懂 GPUtw

控制台建立 API key（前綴 `gputw_live_`），依需要給 scope：本用途至少要
`catalog:read`、`instances:create`、`instances:read`、`instances:manage`、`ports:manage`。

安裝官方知識套件（擇一）：

```bash
# Claude Code plugin（官方建議）
/plugin marketplace add GPUtw-ai/GPUtw-Skill
/plugin install gputw@gputw

# 或官方 MCP server（18 個工具）
claude mcp add gputw -s user -e GPUTW_API_KEY=gputw_live_xxx -- npx -y @gputw/mcp-server@latest

# Codex CLI / Gemini CLI / Cursor 見該 repo 的 SETUP.md
```

呼叫 API 的兩個硬性要求：

- `Authorization: Bearer gputw_live_…`，**金鑰不可放 query string**。
- **必須帶 `User-Agent`**，否則 Cloudflare 直接 `403`（error code 1010），請求根本到不了。

Base URL：`https://api.gputw.ai/api`（`https://gputw.ai/api` 同一套）。

## Step 2：開一台跑 vLLM 的機器

```bash
API=https://api.gputw.ai/api
UA=mml-tools/0.2
KEY=$GPUTW_API_KEY

# 1) 看目錄，挑 VRAM 夠的型號
curl -fsS "$API/gpus/active" -A "$UA" | jq '.data[] | {id, name, vramGb, hourlyPrice, availableGpus}'

# 2) 取該型號目前可租的機器
curl -fsS "$API/nodes/available?catalogId=<catalog-uuid>" -A "$UA" -H "Authorization: Bearer $KEY"

# 3) 部署（自帶 vLLM 官方映像，直接指定模型與 API 金鑰）
curl -fsS -X POST "$API/instances/create" -A "$UA" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "nodeId": "<node-id>",
    "bandwidthMbps": 100,
    "customImage": {
      "dockerImage": "vllm/vllm-openai:v0.11.0",
      "webUiEnabled": true, "webUiLabel": "vLLM", "webUiPort": 8080,
      "env": [{ "name": "HF_TOKEN", "value": "hf_xxx" }],
      "args": ["--model", "<org/model>", "--served-model-name", "local-coder",
               "--port", "8080", "--max-model-len", "65536",
               "--api-key", "<自己設一組長亂數>"]
    },
    "ports": [8080]
  }'
```

要點：

- `args` **取代映像的 `CMD`、保留 `ENTRYPOINT`**，所以上面等同直接傳參數給 vLLM 的
  OpenAI server。`dockerImage` 要用明確 tag 或 digest，不要 `latest`。
- 也可以改用平台範本（`GET /templates` 裡的 **vLLM Inference Server**
  `gputw/vllm:latest`、**Ollama + Open WebUI** `gputw/ollama:latest`、
  **llama.cpp Server**）。範本的模型與啟動參數由範本決定，**先呼叫 `GET /templates`
  看實際欄位再決定**，不要寫死 UUID。
- 自訂映像必須至少宣告 Web UI 或 `sshEnabled`；宣告的埠沒在時限內回應會 `FAILED`
  （失敗不收費）。
- `402` = 餘額不足以支付所有執行中機器的一小時；`409` = 該機器已有執行個體，換一台。

輪詢到 ready，失敗就讀日誌：

```bash
curl -fsS "$API/instances/$ID/status" -A "$UA" -H "Authorization: Bearer $KEY"
curl -fsS "$API/instances/$ID/logs?tail=200&previous=1" -A "$UA" -H "Authorization: Bearer $KEY"
```

（別在迴圈裡打 `GET /instances`，輪詢用 `/{id}/status`。）

## Step 3：把埠開出來（安全設定很重要）

```bash
curl -fsS -X PATCH "$API/instances/$ID/ports" -A "$UA" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"ports":[8080],"portAccess":{"8080":{"mode":"public"}}}'
```

端點會是 `https://8080-<instance-id>.gputw.ai`，OpenAI 相容路徑就是它的 `/v1`。

- `public` 模式是「有網址就連得到」，**所以 vLLM 那一側一定要有 `--api-key`**，
  否則你在公開網路上放了一台免費推論機。
- `unlisted` 的密碼頁是給瀏覽器的，程式化 client（agent、curl）會被擋在密碼頁外，
  不適合當 API 端點。
- 不要用 raw TCP 曝露來開沒有驗證的 Web UI。
- 每台含 3 個免費額外埠，超過另計費。

## Step 4：模型選擇

以機器的 VRAM 與**可用 context 長度**為準，兩者對本專案都重要：

| 機器規模 | 可行做法 |
|---|---|
| 單卡 24–32 GB | 量化過的中型 coder 模型（例如 30B 級 MoE 的 AWQ／FP8、或 14B 級全精度）；context 要壓小 |
| 單卡 48–96 GB | 30B 級 MoE coder 模型 FP8＋長 context，是自架寫 code 的甜蜜點 |
| 多卡整機 | 100B＋ 開源 coder／通用模型，`--tensor-parallel-size` 對應卡數 |

模型權重可用 `POST /vault/downloads`（`{"source":"hf:<repo>:<path>","targetPath":"models/…"}`）
由**伺服器端**抓進 `/vault`，不經過你的網路；大權重這樣省很多時間。

本專案的真實限制：suggestion／reduction／review 報告可能很大（見
[CODEX 外部 agent runbook](CODEX_EXTERNAL_AGENT_RUNBOOK.md)）。**context window 太小的模型
會在讀報告時失敗**，所以寧可犧牲一點模型大小換 `--max-model-len`，並照 runbook 用
`--out` 落地＋分段讀，不要把整份報告塞進 context。

## Step 5：把 coding agent 接上去

### Codex CLI（本專案摩擦最低）

本程式庫已有 [Codex 外部 agent runbook](CODEX_EXTERNAL_AGENT_RUNBOOK.md)，
而 Codex CLI 原生吃 OpenAI 相容端點。在 `~/.codex/config.toml`：

```toml
# 頂層選擇鍵必須放在任何表頭之前。TOML 的表一旦開始，要到下一個表頭才結束，
# 空行不會結束它 —— 寫在 [model_providers.gputw] 之後會被解析成該表的欄位，
# 頂層就沒有任何選擇鍵，provider 根本不會被選用。
model_provider = "gputw"
model = "local-coder"

[model_providers.gputw]
name = "GPUtw self-hosted vLLM"
base_url = "https://8080-<instance-id>.gputw.ai/v1"
env_key = "GPUTW_VLLM_API_KEY"
```

### Claude Code

Claude Code 走 **Anthropic Messages API**，不是 OpenAI 格式，所以需要一層相容端點：

- 在同一台機器上（或本機）跑 LiteLLM proxy，它以 `/v1/messages` 提供 Anthropic 格式
  並轉發到 vLLM，然後設 `ANTHROPIC_BASE_URL` 指向 proxy、`ANTHROPIC_AUTH_TOKEN`
  設成你自訂的金鑰。
- 較新版本的 vLLM 已直接提供 Anthropic Messages 相容端點（官方文件有 Claude Code 整合頁）。
  **以你實際部署的 vLLM 版本為準**：先用 curl 打一次 `/v1/messages` 確認，有就省掉 proxy，
  沒有就補 LiteLLM。

### 其他

Aider、Cline／Roo Code、OpenCode 等都接受 OpenAI 相容 base URL＋key，可直接填上面的端點。

## Step 6：讓自架模型真的能改這個專案

本程式庫的設計本來就**不綁模型供應商**（`studio/backend/application/` 是唯一業務邏輯，
HTTP 與 MCP 只是 adapter，不夾帶任何模型 SDK），所以換模型不需要改任何程式：

- **本機路線**：`node scripts/studio-agent.mjs --data-dir … --actor agent:local …`，
  自架模型只是換一個驅動它的 agent；CLI 的本機檔案路徑不套用 512 KiB 網路回應限制。
- **遠端路線**：既有 `/mcp` 的 `studio_*` 工具照舊，需 OAuth；大型報告用 `report_page`
  分頁，規則見 runbook。
- **驗收不變**：`npm test` 仍是把關（撰寫時 1343 項）。技術 PASS 依然不等於
  source／audio／player／Mobile adaptation／實機驗收，`in_game` 一樣不能由服務設定。
- 自架模型品質通常低於前沿模型，**更要靠測試與 review 報告擋**，不要放寬既有 gate。

## 安全與界線

- `GPUTW_API_KEY`、vLLM 的 `--api-key`、`HF_TOKEN` 一律走環境變數，不進 repo、不進
  query string、不寫進 receipts。
- 公開埠一定要有推論端金鑰；`POST /instances/{id}/exec` 是 root 權限且留稽核紀錄。
- 換成自架模型是把資料送到**你自己租的機器**，比送第三方單純；但來源素材與授權界線
  （[SOURCE_POLICY.md](SOURCE_POLICY.md)）不因為換模型而改變。
- 端點清單快照為 2026-09；產生程式碼前以 <https://gputw.ai/zh-TW/docs> 與
  `GET /templates`、`GET /gpus/active` 的即時回應為準，不要憑記憶補端點。

## 收工檢查表（每次都要做）

1. 需要保留的輸出已在 `/vault`（`/workspace` 會隨刪除消失），專案產出已 commit。
2. `POST /instances/stop`（保留可重啟）或 `POST /instances/delete`（完全移除）。
3. `GET /instances` 確認沒有殘留的 `RUNNING` 機器。
4. 用完的臨時 API key 在控制台撤銷。

## 參考

- GPUtw 官方站與文件：<https://gputw.ai/zh-TW>、<https://gputw.ai/zh-TW/docs>
- 官方 AI 知識套件／MCP：<https://github.com/GPUtw-ai/GPUtw-Skill>
- 本專案：[CODEX 外部 agent runbook](CODEX_EXTERNAL_AGENT_RUNBOOK.md)、
  [Studio Agent 介面](STUDIO_AGENT_INTERFACE.md)、[服務工作區](STUDIO_SERVICE_WORKSPACE.md)
