# Studio Web v1 final pre-PR audit

Implementation evidence, **not a Canonical rule authority**. Audited on 2026-09-13.
The final immutable branch HEAD and its CI runs are pinned in
[Draft PR #7](https://github.com/a91453/mml-tools/pull/7), which remains open and unmerged.

## Baseline and Canonical bootstrap

The read-only audit started from accepted remote implementation commit
`f60d9311a350ccc2ef928e9e831c1e2e94208f77` on `studio-web-v1`.
The old Work checkout was clean at `1574cf97ca746b04246c5f484ee9d7315d19ffcf`:
no staged, unstaged or untracked source changes. Authenticated GitHub refs,
commits, trees and blobs were fetched and SHA-verified, then the same local branch
was fast-forwarded to the accepted commit. No stale edits were replayed, no new
branch was created and no source work was discarded. Generated legacy build ZIP
changes were restored after testing; they were not pre-existing user work.

After a further Work interruption, local and remote were both rechecked at
`9e079ded4c68b205c512a41c754c94fbbdf44eb3`. The uncommitted F9 fix, regression and
this audit record were retained, the Published Canonical was loaded again, and
the complete Node suite again passed 221/221 before checkpointing them.

| Identity | Verified value |
| --- | --- |
| Canonical version / status | `2026-09-13-v1` / `PUBLISHED` |
| Rules snapshot | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest version | `2026-09-13-v1-manifest1` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| Published main HEAD | `cbbe14986e483f4158570cc873b7e1ce2b214408` |
| Accepted branch / initial PR HEAD | `f60d9311a350ccc2ef928e9e831c1e2e94208f77` |
| Local HEAD at start / after sync | `1574cf97…` / `f60d9311…` |
| Final working / PR HEAD | Actual Git and PR metadata; see PR #7 |

The Published main Manifest and all six pinned documents were fetched anew.
The four `CANONICAL_RULE_SOURCE` files supply rules; PENDING is an inventory,
OFFICIAL_EVIDENCE is supporting evidence. Snapshot commit, document blob hashes,
headers and all indexed resource paths were verified. No local Skill, memory,
historical patch, audit or unpublished rule text was used as an authority.
No Published Canonical document or executable rule contract was changed.

## Findings and disposition

No confirmed **P0** finding. The following are concrete failures of the audited
implementation. The new tests were run against the unfixed code before applying
the fixes: nine new tests failed; the existing FIFO/revision control stayed green.
The range-restoration test added during final verification also failed before its fix.

| ID | Priority / classification | Evidence at the audited implementation | Disposition |
| --- | --- | --- | --- |
| F1 | P1 / real bug, test gap | `backend/mml/parser.mjs` only warned for mapped pitch 108. With candidate/baseline `MML@t120o8c1,t120o3e1,t120o2c1,,,;` and completed reviews, `analyzeWorkspace` returned `VALIDATED` and copyable MML. | Fixed: ingest still preserves the event/warning; Final blocks the unverified mapping. This does not assert an engine-level `O8` ban. Tests: `mml-parser.test.mjs` Final-range test and `web-model.test.mjs` high-pitch review test; browser copy stays disabled. |
| F2 | P1 / real bug, test gap | `web/app.mjs` `run/drain` compared revision numbers only. Queue a project switch and then a review for A; B with the same revision received A's review. | Fixed: actions bind to project ID; evidence also binds to revision. Only explicit navigation is project-unbound. Controller and browser tests cover same-revision A/B plus rejected A-only intake. |
| F3 | P1 / real bug, test gap | Core3 callbacks looked up `report.core3.unapproved[index]` when executed. Queue approvals for rows one and two; after row one disappeared, row two's reason was attached to event three. | Fixed: capture the chosen event with its submitted evidence before waiting. Controller and browser tests assert exact event IDs and reasons after the list shrinks. |
| F4 | P1 / real bug, test gap | `putSource` read the current authority selector after asynchronous `file.text()`. A supporting file acquired `primary-symbolic` if the selector changed while reading. | Fixed: file/paste authority is captured with the user's choice. A controller regression holds file reading and verifies that later selector changes cannot promote authority. Audio endpoint/token/file are likewise captured at explicit request time. |
| F5 | P2 / real bug, UX issue | Boot called `commit` outside the draining loop. A file action queued while boot analysis was pending remained queued at `busy=0` until another action occurred. | Fixed: boot uses the same FIFO drain. Controller and three browser profiles prove two boot file choices run without another action, and reject an obsolete review. |
| F6 | P2 / real bug, UX issue | Queued project selection read the selector's current value at execution. The preceding save's `refreshProjects` reset it to A, so a user's B selection reopened A. | Fixed: capture the selected ID before waiting. Controller and browser tests exercise the intervening save/rerender. |
| F7 | P2 / real bug, UX issue | `commit` kept the previous `savedAt` on edited input. Injecting an analysis failure produced a new unsaved revision labelled with the old saved timestamp, with zero storage writes. | Fixed: clear the timestamp before analysis. Failure remains visibly PENDING with copy disabled and export available; a replacement Worker can process the next action. Failed analysis does not silently persist or certify the edit. |
| F8 | P2 / real bug, test gap | The XML reader strips prefixes, but navigation guards matched only bare tags. A score containing `<m:repeat/>` returned `complete=true`, `unsupported=[]`. | Fixed: detect prefixed local navigation names as unsupported too. Repeat/ending/segno/coda tests preserve written events and block completeness; browser/offline flow uses a prefixed repeat. No navigation expansion or new parser scope was added. |
| F9 | P1 / real bug, test gap | Restored settings could contain `end: "Infinity"`, or null/blank/boolean offsets. `model.mjs` coerced these into a passing range, and completed reviews could produce `VALIDATED`. | Fixed during final verification: both endpoints must be explicit finite numeric values, with a nonnegative start and end after start. A regression rejects all of these cases despite completed reviews. |
| F10 | P3 / documentation drift | PR #7 still cited `d430a2ff…` and CI #149 when its actual head was `f60d9311…`. A browser-test comment still described intake as dropped by design. The implementation record retained older-session counts. | Correct the stale comment, link this audit from the historical implementation record, and update the existing PR body only after final CI. |
| L1 | P3 / real-device-only limitation | Browser profiles configure WebKit viewport/touch flags; `setInputFiles` supplies files programmatically, and the clipboard assertion substitutes `navigator.clipboard.writeText`. No real iOS device or OS permission dialog is involved. | No production code change. Real Safari Files providers, clipboard permission/fallback gestures, Home Screen/background/reload and storage eviction need device acceptance. |
| L2 | P3 / test gap | Native audio alignment and HTTP boundary tests run separately; HTTP tests inject an aligner. There is no deployed HTTPS worker or production credential in this branch. | No deployment/code change. Optional configured HTTPS worker + real audio integration remains unverified. Synthetic/native CI evidence is not recording-specific acceptance. |

Speculation is not a confirmed bug or merge blocker. In particular, OS storage
reclamation and Home Screen suspension are unverified device conditions, not
asserted failures. No unrelated polish, caution-length/Nxx UI, arranging feature,
parser expansion or architecture redesign was added.

## Audit coverage and evidence boundaries

- **Bootstrap/package:** `backend/bootstrap`, `web/canonical-package.mjs`,
  `web/worker.mjs`, build script and bootstrap/build tests. Missing history/package
  corruption fails with `CANONICAL_NOT_LOADED`; runtime rules match the verified
  package. Six immutable documents and distinct dynamic identities are packaged.
  PR builds record actual source `pr_head` separately from CI's checkout/merge HEAD.
- **Readiness/source/delivery:** `web/model.mjs` reconstructs IR, discards imported
  PASS/audio/acceptance authority, downgrades imported accepted decisions, computes
  baseline/previous diffs and combines tool gates with explicit musical reviews.
  Unknown/unsupported remains blocking. Final delivery is checked against exact
  note/rest/volume/Tempo/meter identity; six slots, empty roles and one-copy MML@
  are retained. F1/F9 close evidenced false-PASS paths; no new music rule is inferred.
- **State/persistence:** source/settings revisions clear reviews, decisions, audio
  and acceptance; Canonical identity changes invalidate saved reviews. Backup import
  reconstructs assets and preserves old reviews only as history. Worker errors
  cannot leave old green results against edited data. IndexedDB save tokens prevent
  stale overwrites; browser tests exercise reload and actual transaction rejection.
- **Worker/FIFO:** the accepted true FIFO, finite restart budget and revision-bound
  semantics remain. Existing Worker-client tests cover timeout, crash, exhausted
  retries and healthy reuse; new controller/browser tests cover boot and project
  identity plus real replacement Workers following an injected failure. This is
  controlled automated fault injection, not a claim about all iOS suspension paths.
- **PWA/offline:** `sw.js` precaches the built local module graph and does not use
  `skipWaiting`. Build hashes cover packaged assets, including the installed XML
  parser browser distribution. Browser tests stop the origin server and reload
  through the Service Worker, retaining unsupported status and local data. This
  proves the tested offline reload, not OS eviction or every upgrade lifecycle.
- **Audio/privacy/auth:** symbolic processing is local. Audio selection does not
  upload. Only explicit alignment sends audio plus a minimal event/tempo projection
  to a user-configured HTTPS endpoint. Raw MML/MusicXML, review text and other source
  files stay local. Audio/project SHA bindings reject mismatches; evidence never
  edits symbolic events. Cookies, redirects and caches are excluded for uploads.
  Tokens are memory-only; HTTP requires exact origin/bearer and bounded framing.
  No telemetry/default endpoint or implicit upload was found in the static audit
  or tested user flows. Separate hosting still requires operator resource/time limits.
- **Safari/UI:** responsive/touch-sized controls, native file inputs, exact clipboard
  payload and reload are covered by automated profiles. Backup/export remains the
  recovery path when storage is unavailable or analysis fails. OS-level gestures,
  real file providers and background lifecycle remain L1, not automated PASS claims.

## Verification record

| Checkpoint | Verification |
| --- | --- |
| Accepted `f60d9311…` | Node 210/210 locally; independently verified successful push CI #151 and PR CI #152 |
| `ea0457c7a058c58585a1b06e5e8bc94c039b989e` | Node 213/213; push CI #153 and PR CI #154 successful |
| `9e079ded4c68b205c512a41c754c94fbbdf44eb3` | Node 220/220; push CI #155 and PR CI #156 successful; audio-worker 6/6; all three browser profiles PASS |
| Final range/audit checkpoint | Node suite adds the finite-range regression (221 tests); exact final SHA and CI evidence are recorded in PR #7 after the checkpoint is pushed |

The Work machine lacked browser binaries and native audio dependencies, so local
launch/import failures were not counted as passes. The full GitHub jobs provide
those results. No tests were removed, skipped or loosened. The Studio PWA and
legacy production bundle are built separately; generated artifacts do not change
production routes. Railway/MCP configuration and production deployment are untouched.

Proceed to real iPhone/iPad Safari acceptance after the final same-HEAD CI is green.
No merge is performed or implied. No confirmed P0/P1 code blocker remains after
these fixes; real-device and optional live-cloud validation remain explicitly open.
