# 正式站端到端驗收

Status: IN_PROGRESS — implementation notes, not Canonical authority.

本工作分支起點 Published main：`bbb8534245c78041573fd93af88c8fc7fd3e89bd`。
Published Canonical：`2026-09-13-v1` / `PUBLISHED`。
Manifest：`2026-09-13-v1-manifest1`；manifest commit：`5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14`。
Rules snapshot：`0a172900a01fdf39c2e9e84cf176961320b779ea`。
四份規則與 inventory / supporting evidence 已從指定 snapshot 載入。

目標服務：`https://mml-tools-production.up.railway.app/studio/`。

驗收分層：

1. 正式 HTTPS、Canonical provenance、靜態資產與 Published main bytes、OAuth discovery、未登入 API/MCP 拒絕。
2. 真實瀏覽器 OAuth 登入、建立獨立驗收專案、MIDI 上傳與 run、同 owner MCP 回讀、evidence_needed 提案返回 UI、未完成 Final 禁止下載。
3. ChatGPT connector discovery / 同一任務呼叫需另有實際證據；測試 client 不冒充 ChatGPT。
4. 真實歌曲 Final、聽验與 IN_GAME_ACCEPTED 分開；合成來源傳輸驗收不能代替。

先前本機 browser / Docker CI 不作為正式站 PASS。新工具需保存逐階段證據及未完成原因，憑證不進報告或 Git。
本輪未授權 merge；不變更正式部署設定、既有歌曲或 Canonical。
