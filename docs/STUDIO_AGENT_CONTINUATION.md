# 網頁啟動與接續 agent

Status: IMPLEMENTATION NOTES。預設關閉；本分支完成本機驗證，未部署正式服務。
沿用既有 HTTP/MCP、Application Service 與 Phase 2 policy，不修改 Canonical。

## 啟用方式

服務主機需已安裝並登入可用的 Codex CLI。設定 `MML_AGENT_CODEX` 為該主機的
**絕對執行檔路徑**，再啟動既有 Railway/Node 服務；可選 `MML_AGENT_MODEL`。
Windows 範例：

```powershell
$env:MML_AGENT_CODEX = 'C:\path\to\codex.exe'
node railway/server.mjs
```

沿用既有 OAuth owner、origin、持久化目錄與服務設定；這兩個變數不代替登入或
既有服務環境設定。設定必須指向實際執行檔，不是 shell command 或 `.cmd` wrapper。
現有 Docker image 沒有內建 Codex CLI 或帳號憑證；僅合併程式不會啟用模型。
請勿把 Codex auth、歌曲原音或服務 token 放進 Git / image。

已啟用的服務在 capabilities 明確揭露模型額度及資料傳送：agent 會收到 run、
符號音符、引用、必要報告與規則；不傳原始音訊/MIDI bytes。不設定上述變數時
維持既有手動交接，沒有模型執行。模型使用營運者所設定帳號的額度。

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
**不自動重跑**。每次 dispatch 最多12步，每次推論最多120秒，單一服務程序最多
同時2個 run；這不是跨 replica 排程器，啟用時應使用單一服務實例。

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

- 9項 driver 測試包含重複啟動、owner/run 隔離、停止、程序恢復、HTTP/revision、
  步數上限、真實 Application Service 提案/接受、推論期间狀態變動、未知結果核對。
- 桌面 Chromium、iPhone/iPad WebKit 驗證網頁自動 dispatch、狀態回讀及故意遺失
  首次啟動回應後沿用原任務。模型替身只回報等待審查，CI 不呼叫付費模型。
- 真正 Codex CLI 在《怪獸之歌》修正版 run 執行2次推論，讀取 suggestion 後停在
  waiting_review，revision仍6、沒有 proposal/Final。這是推論與協定驗證，不能當
  作歌曲角色、聽驗或遊戲內接受證据。真實模型與網頁的整合路徑分別驗證。
- 完整 Node suite：1,831 PASS、0 FAIL；94.917秒、204次 bootstrap、shared refs不變。
  Studio Web build通過。正式站尚未啟用；歌曲完整 Final 路徑仍待所需角色證據。

詳細歌曲身分、私有試聽頁及可公開證據見 [本次接續紀錄](KAIJU_CONTINUATION_2026-09-21.md)。
