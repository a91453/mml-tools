# 網頁啟動與接續 agent

Status: IMPLEMENTATION NOTES。預設關閉；本分支完成本機驗證，未部署正式服務。
沿用既有 HTTP/MCP、Application Service 與 Phase 2 policy，不修改 Canonical。

## 啟用方式

### Production：OpenAI Responses，預設關閉

正式服務**不使用 Railway Agent，也不執行 Codex CLI 子程序**。只有同時設定下列三項才會啟用：

```text
MML_AGENT_PROVIDER=openai-responses
MML_AGENT_MODEL=<明確模型 ID>
OPENAI_API_KEY=<Railway runtime secret>
```

只設定 `MML_AGENT_MODEL` 不會啟用；production 若設定 `MML_AGENT_CODEX` 會直接拒絕啟動。模型只收到 run metadata、衍生符號事件、引用、必要報告與 Published Canonical 文件；不送原始 MIDI／音訊 bytes。Responses request 固定 `store:false`，不開 provider-native tools，也不做 provider retry。模型只回一個 JSON Schema 綁定的 Studio action；真正執行前仍會再經既有 project/run/candidate 身分、MCP schema、allowlist、Proposal Protocol 與 Agent Review Policy。

production 預設成本界線：

- 每次 dispatch 最多 6 次模型決策；
- 同一歌曲 run 累積最多 10 次模型呼叫；
- 整個服務每 UTC 日最多 16 次模型呼叫；
- 同時最多 1 個 agent run；
- 每次輸入最多 262144 bytes；
- 每次輸出最多 900 tokens；
- 每次 provider request 最多 60000 ms。

程式硬上限分別是 8 / 12 / 24 / 1 / 393216 / 1200 / 60000。可用
`MML_AGENT_MAX_STEPS`、`MML_AGENT_MAX_CALLS_PER_RUN`、
`MML_AGENT_MAX_CALLS_PER_DAY`、`MML_AGENT_MAX_INPUT_BYTES`、
`MML_AGENT_MAX_OUTPUT_TOKENS`、`MML_AGENT_TIMEOUT_MS` 調低或在硬上限內選值，不能藉環境變數突破上限。每日與每-run call counter 寫在持久化 agent-dispatch store，所以 restart 不會把額度洗掉。

`OPENAI_API_KEY` 是另一個外部服務成本面；Railway Agent 的 hard usage limit 仍應維持 `$0`。Capabilities 會揭露 provider、call/input/output/timeout 上限與 `store:false`，但不揭露 API key。

### Development：保留本機 Codex CLI 測試路徑

開發／測試環境仍可設定 `MML_AGENT_CODEX` 為已安裝 Codex CLI 的絕對路徑，並可選 `MML_AGENT_MODEL`。這條路徑只供本機／測試；production 會拒絕它。不要把 Codex auth、OpenAI key、歌曲原音或服務 token 放進 Git / image。

## 網頁操作

1. 開啟同一服務的 `/studio/` 並登入。畫面確認該主機是否已啟用 agent。
2. 勾選「啟動歌曲及提交審查後，自動接續有依據的可逆提案」，再上傳並啟動歌曲。
   勾選預設關閉；啟動授權該 run 的可逆提案及分開接受步驟。
3. 也可對既有 run 按「啟動／接續 agent」。模型每次只輸出一項結構化操作，
   由服務檢查專案、run、候選、revision、工具 schema 與既有 policy 後執行。
4. 狀態輪詢不覆寫使用者正在填寫的 review 草稿。完成後按「重新讀取」查看
   最新 run/proposals。提交 Mobile profile 或 Gate 8 review 後，若仍勾選自動
   接續且 run 未完成，會對同一 run 再次啟動 agent。
5. 「停止 agent」中止模型推論並防止後續操作；已開始的 Studio 操作可能已完成，
   仍需讀回狀態。需要來源角色、Lead/Core3 或人工/實機證據時，agent 停止並說明缺項。
6. role-less MIDI 的第一次 `ASSIGN_ROLE -> Melody` 可在不自填 `leadEvidence` 的情況下
   產生明確標示 review-pending 的可逆候選，讓後續六軌／試聽／review 能繼續；這不是
   Lead PASS。已有角色的 `MOVE_ROLE`、Lead demotion、Gate 3 與 Final 仍維持原門檻。

啟動回應遺失時，同一分頁保存的 request key 會重用；重試回讀原任務，不開第二個
agent 或歌曲 run。關閉分頁不會中止服務程序中的執行。服務重啟則顯示 interrupted，
**不自動重跑**。production 的實際 step/call/input/output/timeout 上限以 capabilities 回報為準，且程式硬上限如上；正式服務固定單一 concurrent agent run。這不是跨 replica 排程器，啟用時必須維持單一服務實例。

## 中斷及未知操作結果

每次呼叫 Studio 前先持久化 pending action。若呼叫結果未知，後續啟動會被拒絕。
操作者先重新讀取 run、proposal 與操作紀錄；歌曲本身若有 pending step，先沿用
既有 reconciliation 流程。確認結果後，在「核對中斷的 agent 操作」填入核對依據，
提交目前 revision 與 pending action fingerprint，再明確重新啟動。
此入口只清除 agent 的停止標記，不重送操作、不改歌曲、不代填 gate confirmation。
模型無法呼叫該入口。

agent 只能接受本任務先前提出、actor 相符且既有 validator 判為 acceptable 的
submitted proposal。拒絕 confirmations、reconcile、直接套用決策、假冒 reviewer、
跨 run/candidate 及不在允許清單的工具。原生 shell/apps/multi-agent 關閉，推論輸出
若出現原生工具事件會遭拒。CLI 使用獨立暫存目錄與 `--ignore-user-config`、
`--ephemeral`、read-only sandbox，不將模型輸出的命令交給 shell 執行。

## 驗證與限制

- driver 測試涵蓋重複啟動、owner/run 隔離、停止、程序恢復、HTTP/revision、
  step 上限、持久化 per-run / per-day provider-call budget、真實 Application Service 提案/接受、role-less Melody 候選端到端、
  推論期間狀態變動與未知結果核對。Responses provider 另有 store:false、JSON Schema、input/output hard bound、失敗不重試測試。
- 桌面 Chromium、iPhone/iPad WebKit 驗證網頁自動 dispatch、狀態回讀及故意遺失
  首次啟動回應後沿用原任務。模型替身只回報等待審查，CI 不呼叫付費模型。
- 真正 Codex CLI 在《怪獸之歌》修正版 run 執行2次推論，讀取 suggestion 後停在
  waiting_review，revision仍6、沒有 proposal/Final。這是推論與協定驗證，不能當
  作歌曲角色、聽驗或遊戲內接受證据。真實模型與網頁的整合路徑分別驗證。
- 完整 Node suite：1,831 PASS、0 FAIL；94.917秒、204次 bootstrap、shared refs不變。
  Studio Web build通過。正式站尚未啟用；歌曲完整 Final 路徑仍待所需角色證據。

詳細歌曲身分、私有試聽頁及可公開證據見 [本次接續紀錄](KAIJU_CONTINUATION_2026-09-21.md)。
