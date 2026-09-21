# 《怪獸之歌》7→6 candidate 路徑 — 2026-09-21

Status: **IMPLEMENTATION READY / REAL SONG RERUN REQUIRES PERSISTENT SONG ASSETS**

這是《怪獸之歌》下一輪 7→6 candidate 工作紀錄，不是 Canonical 規則來源，
也不是歌曲 Final／VALIDATED／IN_GAME_ACCEPTED 聲明。

## Canonical 與 Git 身分

- Published Canonical: `2026-09-13-v1`
- rules snapshot: `0a172900a01fdf39c2e9e84cf176961320b779ea`
- 工作分支: `codex/kaiju-7to6-candidate-20260921`
- 起點: `0ff5633944c4642b0784f97d1370bc381b39a1c7`（PR #49 merge）
- PR #49 已把 role-less `ASSIGN_ROLE -> Melody` 的候選製作與 Gate 3 驗收分開：
  可產生明確標記 review-pending 的可逆 candidate；Lead promotion 仍維持
  `PENDING`，Final 前仍需 candidate-bound reviewer evidence。

## 使用者提供的歷史 frontend 參考

使用者提供 `frontend-complete-2026-09-14-debranded.zip`。其中舊 frontend 有：

- voice split / strand reduction / Hungarian continuity matching；
- track merge 多模式比較；
- dropped／trimmed／character-count diagnostics；
- source note reference 保留。

這些檔案是歷史編曲／工具 context，不是 Canonical authority。
舊 merge 實作會實際清除來源軌、截短或丟棄衝突音，因此不能直接搬入 G12。

本分支只保留其「比較不同合併目標的成本」概念，改為 read-only
`SUGGESTION_ONLY` 診斷。任何來源事件都不因診斷被刪除、縮短或改音。

## 新的 7→6 診斷

`studio/backend/reduction/legacy-merge-diagnostics.mjs` 對第七 lane／OVERFLOW
逐目標角色回報：

- `losslessGapCount`: 原事件時值可原封不動塞入該角色；
- `unisonCoveredCount`: 同音且完整覆蓋；只代表可審查的 dedup 候選，不能自動 OMIT；
- `wouldRequireTrimOrDropCount`: 舊 frontend 必須截短／丟音才放得下；現在保持 unresolved；
- exact-rational timing；
- 鄰近 pitch continuity，僅作排序診斷；
- `leadReviewRequired`：目標是 Melody 時明示仍需 Lead reviewer evidence。

plan-level 依 G11-C lane identity 聚合，並把 bounded 摘要帶進
`REDUCTION_DECISIONS_REQUIRED` review request。所有結果均為
`authority: SUGGESTION_ONLY`，不改 outcome、不 certifies gate。

## 真實歌曲已知輸入

上一輪已逐事件驗證的修正版 Piano MIDI：

- SHA-256 `5819c9c5e7b5f357c0523b16d69eda16dd84d5a2ad60a167802e904b02c23782`
- 1,545 sounding events 保留；
- 七條 lanes；
- 原 orphan NoteOff 修正只移除 delta=0、沒有對應 NoteOn 的四 bytes。

目標錄音仍是使用者指定的 M4A：

- SHA-256 `35a05318c127248d9a391201847ee586e82df87b4755cdeb1ec33e4ceb98d061`
- M4A 是錄音／可聽角色參考；Piano MIDI 是 supporting symbolic material。

使用者 Mobile intent：

- piano；
- 單人必須可完整演奏；
- 多人演奏增加音色豐富度，不可讓單人 Core3 依賴 Chord3–Chord5。

## 本環境目前不能誤稱已重跑真實歌曲

目前連線中的 Studio instance 沒有先前《怪獸之歌》的 persistent project/store；
舊 project ids 回報 `PROJECT_NOT_FOUND`，而 GitHub 只保存摘要／hash，不提交
MIDI、M4A bytes 或完整 1,545-event payload。

因此本分支目前完成的是「讓真實 7→6 可以安全執行與審查」的實作路徑，
不是偽造一份沒有來源 bytes 的歌曲 candidate。

取得同一 persistent store／重新上傳同一修正版 MIDI + M4A 後，正確續跑順序：

```
來源決策
→ role-less provisional assignment
→ G12 7→6 merge diagnostics
→ reviewer 接受 event-level REDISTRIBUTE / KEEP / OVERFLOW
→ six-role review-pending candidate
→ technical readback
→ candidate review (Lead / Core3 / Full6 / regression)
→ Mobile adaptation review
→ finalize only after required non-game gates pass
```

不得把 merge diagnostic、候選 materialization、parser PASS 或 player PASS 當成
Lead／Core3／Mobile／IN_GAME acceptance。
