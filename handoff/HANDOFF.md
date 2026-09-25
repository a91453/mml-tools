# Handoff — 2026-09-25 (for Claude Code or Codex)

This branch holds notes only. It is never merged into main.

Reply to the owner in Traditional Chinese (繁體中文), briefly. Read AGENTS.md / CLAUDE.md first:
Railway Agent (railway agent, Dashboard Agent, railway_agent MCP tool) and GitHub Copilot delegation
are prohibited. Use deterministic Railway API/CLI, repository scripts and GitHub Actions. When something
needs a Dashboard click, give the owner exact steps.

## Owner preferences
- Authorized: open PRs and merge them yourself once CI is green (merge commit). No extra AI review rounds unless risky.
- Report minimally: merged, a Deploy click is needed, or a real decision.
- Split work into small PRs rather than waiting.

## State at handoff (~09:00 UTC)
- main = 42f38f6. PRs #90–#96 merged. #94 (sound-bank reconcile) closed unmerged; branch `claude/sound-bank-reconcile` kept.
  Delivery safeguard parked on `claude/delivery-emission-check-parked`.
- MCP control plane (Railway project 62c1cafe-…, service b43b70a2-…) auto-deploys main after CI; runs 8613d0c.
  SKIPPED deployments for studio/web-only merges are normal (watchPatterns).
- Permanent Studio Web (project 8382ec4b-8da6-4f27-947b-b325ea5aadfa, env 00c16c1a-f210-44a0-944f-9722c4b1a0f4,
  service 311e2f06-bad4-415c-b020-d52e1a6bf064, Bun function) runs v5 (25b8acd). v6 (8613d0c) is STAGED, not deployed.
  Plan: stage v7 over it; the owner clicks Deploy once.

## Owner decisions already taken
- (a) A pasted, valid MML delivery stays VALIDATED. Only readiness / machine delivery of a Studio-generated Final must agree with the emitter.
- (b) Decisions an imported project marks "accepted" are demoted to pending (as Studio Web already does).

## Status update (~11:00 UTC) — read this first
Merged: #97 (p1 listening recovery), #98 (p2 imported decisions pending).
Open PRs — what each still needs:
| PR | Branch | Needs |
|---|---|---|
| #99 | claude/p3-ops-and-test-hygiene | Reviewed OK. Merge when CI is green. |
| #100 | claude/p3-bank-races | Merge when CI is green (low risk). Review may add fixes. |
| #101 | claude/p2-ready-means-writable | Changes readiness semantics: do an adversarial review (does each of the three song kinds now block readiness, pasted MML stays VALIDATED, Web and service use the same emit options, no G10 verdict changed), fix problems, then merge when green. |
| #102 | claude/p1-run-finalize-guidance | Known MEDIUM bug to fix before merge: after an emitter refusal the run says no operation answers it (run-service.mjs ~:2433, capabilities.mjs ~:231, docs AI_ONE_CLICK_ORCHESTRATOR_PHASE1.md ~:187, STUDIO_AGENT_INTERFACE.md ~:746), but a new final_reduction does answer EVENT_ROLE_UNASSIGNED (a PASS reduction with ACCEPT_OVERFLOW keeps overflow events with role null; fixture g12 baselineWithOverflowLane). Name final_reduction when the refusal is EVENT_ROLE_UNASSIGNED (or any code a reduction answers); keep "no operation" only for refusals nothing answers. Add a test. |
Low follow-ups (optional, small PR after the above): listen — offline with no service worker the Worker replacement budget can run out on a listen-model failure (add a delay or keep the old Worker for non-listen calls); openFromProject still reports success when the session did not open (listen-ui.mjs ~:125); importPayload reads shared state.error after open() (make open() return its error). Gate 5 docs: say baselines stored before #98 keep a file's own accepted decision.
If a claude/wip-<key> branch is ahead of the merged/open PR branch, it holds later fix-round commits: diff it and carry them over.

## Fix branches (priority order)
Final branches appear on origin only when fixed + adversarially verified. If the session ran out before that,
the latest work-in-progress is on `claude/wip-<key>` (pushed every 10 minutes; may be partial — read its
commits and `handoff/open-items.json`, finish the items, run the tests).

| # | Final branch | WIP branch | Items (index into handoff/open-items.json `.open`) |
|---|---|---|---|
| 1 | claude/p1-listen-recovery | claude/wip-p1-listen | 3 listen-model.mjs dropped request breaks listening until reload; 9 listen link claims success on failure; 10 link opened during failing first boot |
| 2 | claude/p1-run-finalize-guidance | claude/wip-p1-backend | 1 run offers impossible ops after emitter refusal; 14 CLASSIFICATION_UNKNOWN suggests release_representation; 21 #95 boundary message unbounded + wrong denominator; 13 prescreen fractional tempo; 18 stale conflict on APPLIED proposal; 20 INVALID vs STALE |
| 3 | claude/p2-import-decisions-pending | claude/wip-p2-gate5-import | 2 imported accepted decisions clear Gate 5 → decision (b) |
| 4 | claude/p2-ready-means-writable | claude/wip-p2-delivery-ready | 0 ready while the emitter refuses → decision (a); port the parked safeguard onto main (do not edit run-service finalize op list; branch 2 owns it) |
| 5 | claude/p3-bank-races | claude/wip-p3-bank | 5, 6, 7, 8, 11, 12 sound-bank races on main (minimal fixes; do not port #94's redesign) |
| 6 | claude/p3-ops-and-test-hygiene | claude/wip-p3-ops-tests | 27 process-death test timeouts; 31 stale workflow push triggers; 17 Dockerfile comment only; 26 Workshop 'bank picked during boot' check that never held the engine |

For each: open a PR, merge when CI is green; if main moved, merge main into the branch first.

## Next feature (after branch 1 is merged)
Paste / import raw MML directly in the Studio Web listening panel (today it only accepts a `#listen=` link;
raw MML needs project → paste slot → analysis → send to listening). Add a paste box for a full `MML@…;`
(highlight + per-role counts), optional title and meter text (else 4/4 assumed, as today), 2–4 versions at
once for A/B comparison using the existing A/B, changed-bars and ranged playback, and .mml/.txt file pick +
drag-drop. It creates a local listening session through the same path as link import: no upload, no
project, no gate. Files: studio/web/listen-ui.mjs (+ app.mjs if needed), browser checks in studio/browser-tests.

## Tests
- `npm test` (a shallow clone fails exactly 3 history-dependent bootstrap tests; CI uses full history).
- Studio Web: `node scripts/bootstrap-canonical.mjs --summary && node scripts/build.mjs && node scripts/build-studio-web.mjs`,
  then `node studio/browser-tests/run.mjs` (set STUDIO_BROWSER_CHROMIUM to a Chromium binary and
  STUDIO_BROWSER_ALLOW_MISSING=1 if WebKit is absent). Keep app.mjs's boot text `try {\n  identity=` intact.

## Studio Web v7 release (after everything above is merged)
Follow ops/permanent/README.md and the v4/v5 records; commits 8f5b708 and 793cb66 are templates.
1. Pin SOURCE_SHA / BUILD_ID / CACHE_ID / TAG in ops/permanent/package_release.py and .github/workflows/studio-durable-release.yml.
2. Build twice (local deps; fresh `npm install --ignore-scripts --package-lock=false`) → same buildId; package both → identical.
3. Commit ZIPs + release-lock.json; run ops/permanent bootstrap.test.mjs (RELEASE_TEST_ASSETS=ops/permanent/assets) and publish-release.test.mjs.
4. `python3 ops/permanent/build_function.py ops/permanent/assets fn.ts` twice (identical); Bun offline start from a seeded cache; tamper test.
5. Dispatch studio-durable-release.yml while origin/main == SOURCE_SHA, then studio-durable-mirror.yml.
6. Stage the complete rendered function on the Railway function (staged), read it back and compare SHA-256; check staged changes.
7. The API commit always times out → owner clicks Deploy (Railway Dashboard → mml-tools-studio-permanent → production → staged changes → Deploy).
8. Verify the startup log; write the release record + README "Current release" pointer; PR; merge.
9. Tell the owner: delete the RELEASE_S3_* GitHub repository secrets only after the v7 mirror; keep the same-named Railway function variables. Ask for a real-browser check of the site.

## Still open — needs an owner decision (do not start without asking)
TTR option cannot take effect through Finalize; Studio Web grades Lead evidence differently from the service;
multi-source baseline id depends on project id/title; transitive deps unpinned; two proposal retry edge cases;
Worker boot recovery tested only in Chromium; harmony timing test can flake under load; verify_deployed.py never
run against the permanent URL; parked #94 leftovers; a per-note MML-vs-MML diff list. Details in open-items.json.
