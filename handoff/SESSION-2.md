# Second session (session_01WXkNv6MWESXKS2CVK4rhuW) — status, newest first

Read HANDOFF.md first (owner preferences, policies, v7 steps). This file only
adds what the second session owns.

## ~12:10 UTC — v7 in progress (read this first)
- All fix PRs merged; main = 5dbf42a (source of v7). v6 WAS deployed by the owner at 10:33 UTC.
- Branch `claude/studio-v7-release`: pins committed (buildId f654796859ea…, cacheId b3fe1d4d…, 157 assets,
  runtime ZIP 8666b6b8…, trust ZIP 28bdb56b… unchanged, rendered function 9afd162e…), plus RELEASE_2026-09-25-v6.md.
- Release run 36132530795 and mirror run 36132589479 succeeded (dispatched on the branch while main == 5dbf42a).
- The v7 function is STAGED on Railway (patch 85babe52…); read back byte-identical (sha 9afd162e…); only Source Code, not destructive.
- WAITING: the owner clicks Deploy in the Railway Dashboard. Then: get-logs on the new deployment, write
  RELEASE_2026-09-25-v7.md (template: v6/v5 records; RENDERED_SOURCE_VERIFIED should show 5b746a472c3c…),
  point the README "Current release" at v7 (add v6 to the list), open the PR, merge when CI is green.
  Do NOT merge the branch before the deploy is verified. Then task D.

## ~11:15 UTC
- PR #103 MERGED (d4cff30). Task B is done. Remaining: #100 and #102 (first session), then task C (v7), then D.

## ~11:10 UTC
- main = 7afe9e0 (#97, #98, #99, #101 merged). #100 and #102 are still driven by
  the first session (see HANDOFF.md "Status update ~11:05").
- Task B (paste raw MML into the listening panel) is DONE on branch
  `claude/listen-paste-mml`, PR #103 (draft). Files: studio/web/listen-paste.mjs (new,
  pure, unit tests in studio/tests/web-listen-paste.test.mjs), studio/web/listen-ui.mjs
  (pasteCard/bindPaste/importPasted), style.css, studio/browser-tests/listening.mjs
  (runPasteChecks). Chromium suite passed twice locally; WebKit only in CI.
- Next for #103: merge main into the branch (#100 also edits listen-ui.mjs play();
  keep both), run `node --test studio/tests/web-listen-*.test.mjs` and the Chromium
  suite, push, wait for CI (incl. WebKit), mark ready, merge (merge commit).
- After #100, #102 and #103 are merged: task C (Studio Web v7 durable release),
  exactly as in HANDOFF.md "Studio Web v7 release". Nothing of v7 is started yet.
- Then task D (tell the owner about RELEASE_S3_* secrets, ask for a real-browser check).
