# 《怪獸之歌》Final 複驗與 Mobile reviewer 入口

Status: **P1 IMPLEMENTED / P0 FINAL BLOCKED**。這是實作與歌曲驗收紀錄，
不發布新 Canonical，也不代表已部署正式網站。

## 同步與規則

- 工作樹起初乾淨；`git fetch --all --prune` 後將 main fast-forward 到
  `ba9b8b31f82b4537866470c52c8539db1de963e9`（PR #46）。
- 工作分支：`codex/kaiju-final-mobile-review`。
- 完整 Manifest Bootstrap：`CANONICAL_LOADED`，Published `2026-09-13-v1`，
  snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea`。
- 未變更音樂 gate、Lead contract 或 Phase 2 agent 接受政策。

## P1：服務工作區已可輸入實際 profile 與候選 review

`/studio/` 新增 profile 與 Gate 8 表單。使用者自行填目標樂器／測試情境、
理由、證據、每個角色的音域／音量及接受者，先由同一後端預覽，再以既有
reviewer resume 路徑套用到同一 run。UI 不推薦或預填任何樂器數值。

套用後 Gate 8 仍 PENDING。使用者重新讀取候選 review、查看來源／上一版本
差異後，明確提交審查者、true／false 結論、理由與證據。記錄只適用於所選候選。
已有來源與 profile 的其他 gates 不會由表單自動寫成 PASS。完整操作見
[服務工作區](STUDIO_SERVICE_WORKSPACE.md#mobile-profile-與-gate-8-reviewer-操作)。

防錯涵蓋 profile 編輯後預覽失效、候選／revision 變更、來源過期、完成或
未確定 run、空白證據、套用回應中斷、review 後再次適配。候選變更會重新要求
Gate 8；沒有把 agent proposal policy 放寬成可以自填 confirmation。

## P0：原歌曲已重新執行，但尚未產生 Final

新增 `scripts/studio-final-audit.mjs`：鎖住本機 CLI data directory，完整複製 store
到全新輸出目錄，在副本上讀取素材並驗證 SHA-256、重算來源診斷、逐頁讀回 baseline、
執行 G12 plan、candidate review 及 finalize。它不提供任何 confirmations 或 profile。
若有 Final artifact，另讀 artifact 並重做 technical validation、核對 round-trip；
有 blocker 時 exit 2，不寫 MML。原 store 全部檔案前後雜湊一致才出具報告。

本機重現（輸出目錄必須尚不存在；父目錄需存在）：

```powershell
node scripts/studio-final-audit.mjs --data-dir .studio-agent/real-song --project-id prj_d4048044eb6d84453c81191102d72830 --run-id run_d24f9dfe1f1a2bdafe0474727b4f496b --out .studio-agent/kaiju-final-next-audit
```

| 檢查 | 本次真實結果 |
| --- | --- |
| 原 run | revision 12，`awaiting_review`，`AWAITING_ACCEPTED_REDUCTION_DECISIONS` |
| MIDI | 11,506 bytes，SHA-256 `58619209f743416fa2150471b079cc14796e92911000793fce98384603c18487` |
| baseline | 1,545 個 note events，全部尚無 accepted role |
| 原 store | 6 個檔案，內容全部不變；inventory SHA-256 `0cfdf56412454e5665e5635fd22deeb80008562f0912d75b14fd5563867331ab` |
| Finalize | `blocked` / `FINALIZATION_BLOCKED` |
| Final artifact / MML | null / 未產生 |
| Final blockers | source、microTiming、core3Completeness、originalAudio、playerReadback、mobileAdaptation、regression |
| source / audio / Mobile / regression / in-game | PENDING |
| technical / player readback | NOT_RUN |

原 run 本身仍停在 G12；副本上的額外 review／finalize 是診斷，未把原 run 後續
steps 記為完成。機器可讀證據見
[final-audit.json](evidence/kaiju-final-mobile-2026-09-21/final-audit.json)。
本機完整報告在 `.studio-agent/kaiju-final-20260921/`，包括 source diagnostics、
baseline events、G12、review、finalize 及完整 store 副本。

## 已準備的 orphan NoteOff 修正候選

原檔 track 0/event 1719，tick 258240、channel 1、note 62，是 velocity=0 的
note-on 編碼（即 note-off）。全檔 channel 1 的 positive note-on 數為 0。
該事件 delta=0，原始檔 byte offset 5972，4 bytes 為 `00 91 3e 00`。

已另外產生 `Kaiju_no_Hanauta__Vaundy_Piano.orphan-review.mid`：只移除這 4 bytes，
並更新相應 track chunk 長度。重新解碼與逐事件核對結果：

- parsed notes 仍為 1,545；pitch/start/end/role/voice/volume 等 sounding fields 相同；
- 除被移除事件外，全部解碼事件相同（比較時排除位置與事件序號）；
- `unsupported` 由單一 `ORPHAN_NOTE_OFF` 變成空陣列；
- 原 MIDI bytes、原 baseline 與原 run 未被替換；
- 修正候選 11,502 bytes，SHA-256
  `5819c9c5e7b5f357c0523b16d69eda16dd84d5a2ad60a167802e904b02c23782`。

這是可審查的來源修正候選，尚未當成 accepted source。接續採用時，需將它作為
新 asset 建立新 baseline；來源 digest 與部分 source event ordinals 會改變，不能
把原角色／Lead 審查直接移植。沒有藉此直接覆寫 `source_complete=true`。
[修正證據](evidence/kaiju-final-mobile-2026-09-21/orphan-repair.json)不包含歌曲 bytes。
MIDI 與完整事件 payload 只保存在忽略的本機輸出目錄。

## 還需要的歌曲事實與審查

1. 確定 Final 目標為已提供的鋼琴 MIDI 完整編曲，或 M4A 原版全樂隊。
2. 可核對的 Lead／角色來源證據與段落說明；1,545 個 unassigned events 不能
   由「最高音就是旋律」自動當成 accepted Lead。之後才可完成 G12 與 Core3。
3. 實際 Mobile 目標樂器、音域／音量測試或確認無需調整的依據。P1 現在有可用入口，
   但這首歌尚未收到這些輸入，也未實際執行有依據的 adaptation。
4. 若保留 MV 為驗收音訊，需可靠 beat↔recording 對齊與角色／聽驗。
   舊 DTW 的異常結果沒有被附加成 PASS。Final 所需 player/readback 與 regression
   也須在正確候選產生後完成；實機接受另行記錄。

本輪已集中詢問前述目標版本與實際證據。沒有新的回答時，P0 保持未完成，
不能以 UI／synthetic 測試成功聲稱真實歌曲驗收完成。

## 程式與瀏覽器驗證

- 相關 Node regressions：40 PASS / 0 FAIL，包含 audit 的 blocker、真實 emitter/readback、
  store 保留、目錄重疊、lock 與同一 output 重用拒絕。
- desktop Chromium、iPhone WebKit、iPad WebKit：profile 真實表單輸入 → preview →
  同 run apply → candidate review → explicit Gate 8 → 再次適配使 Gate 8 失效，全部 PASS。
  另含 concurrent revision、空證據與套用回應遺失的測試。這些音樂數值屬獨立 synthetic
  fixture，沒有供給《怪獸之歌》。fixture 其他 gates 從明確 test seam 提供後，Final
  emitter/round-trip PASS、in-game PENDING。
- 原始真實 MIDI 的 OAuth／upload／run／MCP 共用狀態／proposal 回讀，三種 browser
  profile 全 PASS。真實素材專案維持 awaiting_review、沒有 Final。
- Studio Web build PASS，62 assets。瀏覽器圖片已目視檢查，窄螢幕沒有表單截斷。
- 第一輪完整 suite：1,813 PASS / 5 FAIL；5 項均由既有 Sites build 缺少 `zip` 引起。
  GnuWin32 executable 的 stdout pipe 在此 Node/Windows 環境也失敗，未採用。
  改用 [MSYS2 zip 3.0-5](https://packages.msys2.org/packages/zip)，核對官方 SHA-256
  `874e20bf625fbe577949444faf30ab9a725dbd4886ec9bff26459152da7f831c` 後僅安裝於
  `.studio-agent/msys-zip/`，借用現有 Git runtime。Sites build 5 項全部通過。
  沒有更改系統 PATH；只為驗證 subprocess 設定 PATH。

完整 suite 最終 **1,818 PASS / 0 FAIL**，90.322 秒；202 次 bootstrap、單一 published
identity／rules snapshot，shared refs 未變。結果與可重現命令另記於同目錄的
[validation.json](evidence/kaiju-final-mobile-2026-09-21/validation.json)。
Browser evidence：[synthetic](evidence/kaiju-final-mobile-2026-09-21/browser-synthetic.json)、
[real MIDI](evidence/kaiju-final-mobile-2026-09-21/browser-real-midi.json)。
