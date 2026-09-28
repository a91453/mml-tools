# mml-tools 外掛（Claude 與 ChatGPT 共用）

同一個資料夾同時是 Claude 外掛與 ChatGPT／Codex 外掛。兩邊裝到的東西一樣：

- **MCP 伺服器 `mml-studio`**：`https://mml-tools-production.up.railway.app/mcp`（Streamable HTTP，OAuth）。提供技術檢查、Studio 編排流程與試聽播放器等工具，工具內容見根目錄 [README](../../README.md) 的「MCP 工具服務」。
- **Skill `mabinogi-mobile-mml`**：先從 `docs/CANONICAL_MANIFEST.md` 載入 Published Canonical，再做任何 MML 工作的流程說明。它不是規則來源。

> 這個服務只允許擁有者本人登入。其他人可以安裝外掛，但連線時無法通過登入。

## 安裝

| 在哪裡用 | 怎麼裝 |
| --- | --- |
| Claude Code | `/plugin marketplace add a91453/mml-tools`，再 `/plugin install mml-tools@mml-tools` |
| claude.ai、Claude Desktop、Cowork | 自訂（Customize）→ Plugins → Add marketplace，填 `a91453/mml-tools`，安裝 `mml-tools`。裝好後到外掛的 Connectors 分頁連線並登入 |
| ChatGPT 桌面版、Codex CLI | `codex plugin marketplace add a91453/mml-tools`，再從 `/plugins` 安裝 `mml-tools` |
| ChatGPT 網頁版 | 設定 → Security and login → 開啟 Developer mode，到 chatgpt.com/plugins 按 **+**，填上面的 MCP 網址 |

- 安裝外掛不會自動登入。第一次使用 `mml-studio` 的工具時，照畫面指示用擁有者帳號登入。
- 如果之前已經用網址手動加過同一個自訂連接器，裝了外掛後可能會出現兩份相同的工具。留一份就好，把另一份停用或移除。
- OpenAI 文件目前只寫桌面版與 Codex CLI 可以從 GitHub repo 加入 marketplace；網頁版請用開發者模式直接填網址。

## 檔案

| 檔案 | 給誰讀 |
| --- | --- |
| `.claude-plugin/plugin.json` | Claude（外掛資訊） |
| `.mcp.json` | Claude（MCP 伺服器，`type: "http"`） |
| `plugin.json` | ChatGPT／Codex（[Agent Plugins](https://agent-plugins.org/) 格式） |
| `mcp.json` | ChatGPT／Codex（MCP 伺服器，`type: "streamable-http"`） |
| `skills/mabinogi-mobile-mml/SKILL.md` | 兩邊共用（[Agent Skills](https://agentskills.io/specification) 格式） |

Marketplace 目錄在 repo 根目錄：Claude 讀 `.claude-plugin/marketplace.json`，ChatGPT／Codex 讀 `.agents/plugins/marketplace.json`。

Skill 的原檔在 [`skills/mabinogi-mobile-mml/`](../../skills/mabinogi-mobile-mml/)，這裡是逐位元組相同的副本。外掛只能帶走自己資料夾裡的檔案，所以副本放在這裡；原檔路徑則是 `docs/CANONICAL_MANIFEST.md` 點名的位置，不能搬。改 skill 時兩份一起改，`tests/plugin-package.test.mjs` 會檢查兩份相同，也會檢查兩邊的 manifest 與 MCP 網址一致。
