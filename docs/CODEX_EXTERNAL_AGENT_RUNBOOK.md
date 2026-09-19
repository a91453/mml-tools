# Codex 外部 agent：本機可恢復的歌曲流程

Status: IMPLEMENTATION NOTES。不是 Canonical，也不變更 Phase 1／2 policy。
真實歌曲驗收狀態見 [本輪紀錄](CODEX_EXTERNAL_AGENT_ACCEPTANCE_2026-09-19.md)。

## 已確認的入口與限制

`scripts/studio-agent.mjs` 是本機薄層入口。`call` 在程序內呼叫既有
MCP schema checker 與 `runStudioTool` dispatcher，再由 Application Service
呼叫原有音樂引擎。`upload` 使用既有 `uploadAsset`；`export` 讀取既有
Final artifact。沒有 HTTP listener、模型 SDK、queue、新資料庫或部署。

現有的遠端 HTTP／MCP 仍可使用；此 CLI **不連接遠端服務**，也不讀取
Studio PWA 的 IndexedDB。PWA 目前直接呼叫 Web Worker 引擎，沒有使用
Application Service。不要把本機 run 誤認成網站既有歌曲。

必須指定獨立 `--data-dir`。`store/` 使用既有 JSON record／blob store；
`receipts/` 保留每次呼叫的時間、actor、參數與結果（不內嵌上傳 bytes）。
真實歌曲的 suggestion／review／finalize 報告可能超過 MCP 的 512 KiB wire cap。
CLI 的本機檔案路徑不套用網路回應限制；使用 `--output` 保存完整 JSON，再分段讀取，
不要將整份大型報告貼進模型 context。網路 MCP 的限制完全保留。也可直接輸出報告：

```powershell
node scripts/studio-agent.mjs --data-dir .studio-agent/my-song --actor agent:codex report --project-id PROJECT_ID --kind suggestion --out suggestion.json
node scripts/studio-agent.mjs --data-dir .studio-agent/my-song --actor agent:codex report --project-id PROJECT_ID --candidate-id CANDIDATE_ID --kind reduction --out reduction.json
node scripts/studio-agent.mjs --data-dir .studio-agent/my-song --actor agent:codex report --project-id PROJECT_ID --candidate-id CANDIDATE_ID --kind review --out review.json
```

`review` 沿用 service 的普通 report artifact 寫入，沒有 confirmations；三種報告均
不推進 run、不覆寫既有輸出檔。`call --output` 可保存既有命令的完整結果。

actor 是 caller-supplied audit text，**不構成身分驗證或使用者已審查的證明**。
CLI 固定 local owner 為 `local:external-agent`；不同 actor 不是不同帳戶。

同一 data directory 的 CLI 呼叫有 exclusive lock；不要同時使用其他
Application Service 程序寫入 `store/`。原服務沒有跨程序協調能力。
若程序被強制終止，先檢查 `.agent.lock` 的 PID 與 run／proposal／step
紀錄，確認沒有程序仍在寫入後才移除 lock。不要以重送接受來猜測結果。

## Canonical 與來源準備

```powershell
git fetch origin main
node scripts/bootstrap-canonical.mjs
```

先讀完整輸出指定的六份文件；`--summary` 只能確認身分。規則快照不可改用
working tree。`CANONICAL_NOT_LOADED` 必須先修復，不能用舊規則 fallback。

來源必須是真實 MIDI；合成 fixture 只用於 regression。先記錄歌曲／版本、
檔案來源、是否包含原曲音訊、已知起點／有效範圍，以及有無已接受前版。
未知資訊保持未知；第三方 MIDI 不得因檔名、品質或模型判断升級為 official。
上傳的 kind 必須明示，例如 `third_party_midi`；只有可核對的官方來源才用
`official_midi`。Canonical IR 不可作為把 MIDI 的 unknown 改成 confirmed 的捷徑。

## 建立與啟動

以下 PowerShell 指令從 repository 根目錄執行。每個命令的 JSON 會印到 stdout，
也可用 `--output PATH` 保存 UTF-8 結果；非零退出碼表示 schema／操作拒絕或本機錯誤。
退出碼 0 只表示呼叫成功，必須另外讀取 `run.state`、`halt`、`blockers` 與 gates。

```powershell
$work = '.studio-agent/my-song'
New-Item -ItemType Directory -Force $work | Out-Null
function AgentCall($tool, $body) {
  $request = Join-Path $work 'request.json'
  $body | ConvertTo-Json -Depth 50 | Set-Content -Encoding utf8 $request
  $result = node scripts/studio-agent.mjs --data-dir $work --actor agent:codex call $tool --input $request
  if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
  $result | ConvertFrom-Json
}

$cap = AgentCall studio_capabilities @{}
$created = AgentCall studio_project_create @{title='歌曲與版本（獨立驗收）'}
$projectId = $created.project.project_id
$upload = node scripts/studio-agent.mjs --data-dir $work --actor agent:codex upload --project-id $projectId --file 'C:\path\real-song.mid' --kind third_party_midi
if ($LASTEXITCODE -ne 0) { throw ($upload -join "`n") }
$assetId = ($upload | ConvertFrom-Json).asset.asset_id
$started = AgentCall studio_run_start @{project_id=$projectId; asset_ids=@($assetId); idempotency_key='initial-source-v1'}
$runId = $started.run.run_id
$identity = @{project_id=$projectId; run_id=$runId}
$identity | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $work 'identity.json')
$started.run
```

重開終端後重新定義 `$work` 與 `AgentCall`，從 `identity.json` 取得兩個 ID，
呼叫 `studio_run_status`。若在 identity 檔寫入前中斷，可以
`studio_project_get {}` 列出 local owner 的專案，再以 project ID 呼叫
`studio_run_status` 列出 runs；不要自行挑最新候選。

## Codex 的反覆操作迴圈

1. 讀 `studio_run_status` 及 `studio_proposal_targets`，保留當前 revision。
2. 讀 `studio_arrangement_suggest`、`studio_baseline_events`（依 `offset`／`limit`
   分頁）及 request 所指的 report。事件 ID／sourceIdentity 必須來自實際回應。
3. 由 Codex 檢查來源與具體事件，提出最小可逆決策；不自動把所有建議變成 KEEP，
   不因超過 2,400 字刪除音符，不推定最高音就是 Vocal，不自行發明樂器校準。
4. 對當前 request 提交 proposal；記錄 `proposed_by: agent:codex`。
5. 重新讀 proposal。只有 `REQUIRES_EXPLICIT_ACCEPTANCE` 可以在使用者已授權、
   且證據可核對時接受。接受是另一個命令，`accepted_by: agent:codex`；禁止填 user。
6. 接受會走既有 `resumeRun`。讀取新的 run／candidate／review requests 後重複。
   不要用舊 request key 或舊 plan ID 回答新候選。
7. 缺少證據時提交 `evidence_needed`、集中提出具體問題，保留 run；不盲目輪詢或重試。

編曲 proposal 範例結構如下。角括號內容必須替換成實際查得的值與理由；
`decision.json` 的 vocabulary 由既有引擎定義，不由 CLI 定義。

```json
{
  "project_id": "<project ID>",
  "run_id": "<run ID>",
  "request_key": "<current proposal target request_key>",
  "expected_run_revision": 3,
  "kind": "arrangement_decision",
  "proposed_by": "agent:codex",
  "rationale": "<實際比對的來源、事件範圍與保留／改動理由>",
  "action": { "decisions": [] },
  "cites": { "event_ids": ["<actual baseline event ID>"] }
}
```

`action.decisions` 不得包含 `acceptedBy`、`note`、`acceptance` 或 `leadEvidence`；
Phase 2 會拒絕這些欄位。Lead promotion／demotion 缺少正面來源角色證據時保留 PENDING。

```powershell
$proposal = AgentCall studio_proposal_submit (Get-Content 'proposal.json' -Raw | ConvertFrom-Json)
$fresh = AgentCall studio_proposal_status @{project_id=$projectId; proposal_id=$proposal.proposal.proposal_id}
# 先實際讀取 agent_review 與證據；以下命令是明確接受，不能無條件迴圈執行。
$accepted = AgentCall studio_proposal_resolve @{
  project_id=$projectId
  proposal_id=$fresh.proposal.proposal_id
  expected_proposal_revision=$fresh.proposal.revision
  resolution='accept'
  accepted_by='agent:codex'
  reason='使用者已授權；此處填寫本次已核對的具體決策理由'
}
```

## 各 proposal 類別與實際停止點

| 類別 | Agent 可做的事 | 不能替代的事 |
| --- | --- | --- |
| `source_selection` | 指定已上傳的實際 asset IDs／已確認 meter | 來源完整、錄音版本確認 |
| `candidate_selection` | 明確指定當前 project/baseline 可接受的候選 | 猜測「最新就是正確」或中斷 reconciliation |
| `arrangement_decision` | 提出並分開接受可核對的 event decisions | Lead reviewer evidence、Core3 source-change approval |
| `final_reduction` | 對 G12 plan 的 ledger 提出逐事件決策；接受時服務重算 plan | overflow 不能當刪音授權；plan/apply 成功不是 review PASS |
| `mobile_adaptation` | 對可接受此類的 request 提出帶真實 reason/evidence 的 profile | 虛構 register、volume、聽驗或 Gate 8 PASS |
| `evidence_needed` | 如實記錄缺少何種資料／審查 | 不可接受來推進，沒有 downstream operation |

`studio_proposal_targets` 的當前表才決定某個 request 可用哪些類別。
目前 `READINESS_GATE_BLOCKED`／`FINALIZE_BLOCKED` 只容許 `evidence_needed`。
G12 若每個事件都已保留且無 blocker，run 可以明示跳過 no-op。
沒有 Mobile profile 時 run 會 `skipped`，**不代表已實施 Mobile Adaptation**。
目前 Mobile proposal target 是 `MOBILE_ADAPTATION_BLOCKED`，不是所有 Gate 8
readiness request；若 run 已跳過 Mobile 並只剩 Gate 8，不可硬塞 profile proposal。
需要先依實際歌曲取得 profile／確認適當的既有操作路徑，再繼續，不能宣稱適配成功。

CLI 採較窄的操作面：直接 decision／reduction／adaptation apply、reviewer-only
工具與 run 的決策／reconciliation 捷徑不開放；已有服務的政策沒有因此放寬。
`tools` 印出可呼叫的既有 schema，但 CLI 仍拒絕其中的 reviewer-only 欄位。

## Review 與使用者介入

Phase 2 `NEVER_AGENT_SETTLABLE` 明列：所有 confirmations、Lead evidence review、
Core3 source-change approval、readiness／Canonical verdict、中斷 reconciliation
與 in-game acceptance 不能由 proposal 自行完成。不要改用直接 Application Service
呼叫，將 agent 自己的推論包裝為 reviewer 證據。

需要 review 時一次整理：目前 candidate ID、每個 gate 的 blocker、來源／事件／
report reference、需要使用者確認的命題，以及是否需要實際聽驗／target client。
只有實際收到的使用者判斷或測試證據才能交給現有 reviewer 入口紀錄。
Gate 4／8／9 的 true 必須附 evidence 並綁候選；換候選後必須重新檢查。
`player_readback=N/A`／`original_audio_required=false` 也不能由「沒有檔案」推得。

現有 reviewer 入口是 HTTP confirmations／candidate review，或 MCP
`studio_candidate_review`／`studio_lead_evidence_review`／`studio_core3_change_approve`。
本機資料由具體 reviewer 透過同一 Application Service、同一 `store/` 與 local owner
紀錄；遠端 reviewer 介面不會同步到本機。這不是網站上的 review UI。
例如 reviewer 自己的 Node 程序可使用以下既有 API（不可將測試 fixture confirmations
複製進來，亦不可由 agent 自行填 true）：

```js
import { readFileSync } from 'node:fs';
import { createStudioApplication } from './studio/backend/application/index.mjs';
const reviewed = JSON.parse(readFileSync('actual-human-review.json', 'utf8'));
const app = createStudioApplication({ dataDirectory: '.studio-agent/my-song/store', durability: 'persistent' });
await app.reviewCandidate('local:external-agent', reviewed.project_id, {
  candidateId: reviewed.candidate_id, confirmations: reviewed.confirmations,
});
```

紀錄完成後重新讀 run，使用新的 idempotency key 與剛讀到的 revision resume：

```powershell
$current = AgentCall studio_run_status $identity
$resumed = AgentCall studio_run_resume @{
  project_id=$projectId; run_id=$runId
  expected_run_revision=$current.run.revision
  idempotency_key='after-actual-review-v1'
}
```

同一 key 同 payload 只重播 receipt；要新一輪推進，必須用新 key。
`RUN_CONFLICT`／`STALE` 先重讀；`accepted` 但未 `applied` 的 proposal 先檢查
application marker 再依 Phase 2 recovery 重試，不提交新的重複 proposal。

## Final 與輸出

`resumeRun` 只有在 review 不再阻擋時才會 finalize。Technical Timing Repair
預設 false；若真實來源證據支持啟用，在 run `finalize` options 明確 opt-in。
弱起與末小節長度同樣需要來源依據，不猜拍號／長度以通過 validator。

```powershell
node scripts/studio-agent.mjs --data-dir $work --actor agent:codex export --project-id $projectId --run-id $runId --out 'song.mml'
```

只匯出 `completed` run 所指、candidate ID 相符且實際有 MML 的 `final_mml`；
不覆寫既有檔案。回應與 receipt 同時保留完整 artifact，包括 technical check、
`round_trip`、character counts、remaining gates。事件回讀不是音訊聽驗，也不是
外部 player loaded-state readback，更不是 `IN_GAME_ACCEPTED`。

交付時逐項寫清楚：各階段 completed／skipped／blocked、每次停止原因與介入次數、
MML 路徑、technical／round-trip 結果、音樂品質／聽驗／實機狀態；失敗也保留 store。

## 自動化還缺什麼

網站按一次便持續執行，尚需把 PWA 的 upload／start／status／proposal review
接到同一持久化 Application Service，並由外部 agent host 在 request 返回後繼續
讀取、推理、提交／接受 proposal、resume。現有網站沒有這個橋接，服務也沒有
agent dispatch／continuation。還需要把真正需人的 review／聽驗交給使用者並接回
同一候選。這些不等於一定要新增 provider SDK、付費 queue 或資料庫；本轮沒有
新增或部署它們，也沒有聲稱網站已能無人值守完成。
