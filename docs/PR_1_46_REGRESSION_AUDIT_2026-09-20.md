# PR #1-#46 regression audit - 2026-09-20

> Railway resource IDs are kept out of this public repository and appear as `<redacted-id-N>` (the same N is the same resource). Read them from the Railway dashboard.

Status: IMPLEMENTATION AUDIT, not Canonical policy or song acceptance.

## Scope and identity

The owner requested review of PRs #1-#46 and fixes in existing PR #46.
The inventory covers all 46 PR records, changed-file inventories, available
reviews and conversation comments, followed by risk-directed inspection and
reproductions against the current source. It is not a claim that every line of
all 46 historical branches was audited or that each historical checkout was
executed. Passing regressions cannot prove absence of every other bug.

| Identity | Value |
| --- | --- |
| Published main inspected | `f3c1d8143673cc840a9bc513c42a9a1c937c2b6c` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| Canonical version / status | `2026-09-13-v1` / `PUBLISHED` |
| Immutable rules snapshot | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Last implementation checkpoint | `f9ec48d8133168233d9abc25cda8e139b42f6fa0` |
| Implementation tree tested | `35c6b761dad9ca27d295dd423ce870ca45e409b2` |

The Published main Manifest and its six pinned documents were loaded separately
from implementation code. No rule source, Manifest or snapshot is changed.
The local checkout contains authentic Git objects obtained from an authenticated
private Actions checkout. Its HEAD remains the dependency-collection checkpoint
`2d2e34820a3091fd58d118417eb29cb3d7799a55`; the tested working tree was matched to
the implementation tree above. Exact-PR-head CI is separate evidence.

The Actions read token could not fetch three fields for closed/unmerged #16.
The GitHub connector separately returned its PR metadata, all 105 changed paths,
and empty review list. All paths are under the unmerged third-party snapshot;
none is a current runtime or a rule authority. This is an exclusion, not a claim
that every vendored file was reviewed. The temporary PR46-only audit/dependency
workflows were removed from the final diff after inputs were obtained. Private
input artifacts use one-day retention and contain no checkout credentials.

## Confirmed pre-existing defects repaired

Severity is an audit assessment, not a Canonical gate result.

| ID | Severity | Origin / affected code | Reproduction and correction |
| --- | --- | --- | --- |
| R01 | P2 | #35, Application Service store | At a 10-byte quota, replacing a 6-byte key while another 4-byte key exists incorrectly throws `STORAGE_FULL`. Charge `used - previous size + new size` in both backends; oversized replacements still leave original bytes intact. |
| R02 | P2 | #35, memory store | Mutating a `getBytes()` result changes the stored asset without a write. Return an independent byte array, matching filesystem behavior. |
| R03 | P1 | #2, MusicXML reader | A `words` direction-type before a metronome hides real initial or later Tempo while `complete` remains true. Read all direction-type children, retaining source beat/offset and sound-tempo precedence. |
| R04 | P1 | #2, MusicXML meter reader | `2/4 + 3/8` is silently reduced to its first pair. Record `COMPLEX_METER`, retain both source pairs and notes, and mark the source incomplete instead of inventing one supported signature. |
| R05 | P2 | #2, MusicXML meter reader | A later `senza-misura` passage is silently omitted while source completeness remains true. Record `UNMETERED_TIME` and preserve source notes without claiming support. |
| R06 | P2 | #2, MusicXML metronome reader | Multiple visual metronomes without explicit playback tempo are silently reduced to the first. Record `MULTIPLE_METRONOME_MARKS`; do not choose one by guesswork. |
| R07 | P2 | #2; retained as P2-B in #20/#21 | The project object is frozen but its five validated collections accept push/pop/replacement/truncation. Freeze fresh copies of sources/events/tempoEvents/meterEvents/decisions; preserve caller-array and Worker-copy independence. This is collection protection, not a claim of deep immutability for all nested metadata. |
| R08 | P1 | #35 MCP dependency expansion, legacy Sites build | The old build strips only the first import and reports success; loading its single-file artifact fails on a dangling `technical-service.mjs` import. Package the explicit pure dependency graph in isolated scopes and reject new unmapped imports during build. Actual artifact evaluation, routes and refusals now have tests. |

MusicXML structural references are W3C MusicXML 4.0:
[time](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/time/)
and [direction](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/direction/).
These describe the source format, not Mobile output policy. R04-R06 close false
completeness; they do not implement composite-meter rendering, unmetered output
or arbitration between multiple visual tempo marks.

### Sites boundary after R08

The single-file Sites artifact can boot and serve its existing assets, health,
gateway-protected MCP discovery and service information. It has no Published
Git history and no Application Service store. Its existing technical-service
code therefore returns `CANONICAL_NOT_LOADED` for Canonical validation/overlap
requests, with `legacy_fallback_allowed: false`. The three tool names remain
stable; two are explicit refusals in this environment, not functioning Canonical
validators. Its service-info notice states this limitation.

This is not a new fake Canonical loader and not a fallback to `dist/core.js`.
Full Canonical/Studio operations remain on the separately configured Railway
service. Railway MCP wiring and the pinned Permanent Studio release are not
changed by the Sites packager. No real Sites-host deployment was performed.
Historical README descriptions of the three tools must be read with this
runtime distinction, not as evidence that Sites can load Published Canonical.

## Red/green and current-source validation

| Added regression file | Old implementation | Fixed implementation |
| --- | --- | --- |
| `studio/tests/application-store-regressions.test.mjs` | 1 pass / 5 fail | 6 pass |
| `studio/tests/musicxml-timing-structure.test.mjs` | 2 pass / 5 fail | 7 pass |
| `studio/tests/canonical-collection-regressions.test.mjs` | 0 pass / 6 fail | 6 pass |
| `tests/sites-build.test.mjs` | 0 pass / 5 fail | 5 pass |
| Total | 3 pass / 21 fail | 24 pass / 0 fail |

The old-code runs were isolated from production; no shared source or user song
store was used. `raw-midi-preflight.test.mjs` was updated to assert the formerly
open P2-B collection guard while retaining its deep-frozen pipeline checks.

Actually executed on the implementation tree identified above:

- `npm test`: **1,816 pass, 0 fail, 0 skip**.
- `node scripts/bootstrap-stress.mjs --runs=1`: full suite passes again;
  177 bootstrap attempts, one Published main identity, one rules snapshot,
  no failed Git calls from the tested checkout and isolation `ok: true`.
- `RELEASE_TEST_ASSETS=ops/permanent/assets node --test ops/permanent/bootstrap.test.mjs`:
  **2 pass, 0 fail**. Fixture bootstrap tests, not a production migration.
- `npm run build:studio-web` and `npm run build`: exit 0.
- Sites tests import the actual generated artifact in an isolated realm and
  exercise its fetch handler; a successful writer exit is no longer sufficient.
- `git diff --check`: pass. Generated tracked ZIP changes were restored rather
  than silently committed; archive strategy remains G12 below.

The final PR requires all eight applicable jobs: Studio CI (symbolic,
studio-web, audio-worker), Studio service CI (container-smoke, service-browser),
and OSS Export CI (export-node, export-browser, export-audio-worker).
Their exact-head statuses are recorded in the PR conversation/Checks, not
borrowed from the original five-job evidence-only head. Local checks are not a
claim of production OAuth, real-device browser or song acceptance.

## Per-PR disposition inventory

Unless a new repair is named, a row records the reviewed area and retained
boundary, not a new defect or a proof of bug freedom. Historical findings already
repaired by later merged code were not reintroduced or counted as new fixes.

| PR | Area | Disposition against current source |
| --- | --- | --- |
| #1 | Legacy Lead-role skill/master | Historical context only; Published Manifest/snapshot supersedes it. |
| #2 | Studio IR, MusicXML, arbitration, audio/readiness | R03-R07 repaired; source/acceptance axes remain separate. |
| #3 | Canonical candidate | Historical publication step; no new rule release in #46. |
| #4 | Draft2 implementation alignment | Check current code against Published v1, not the draft wording. |
| #5 | Manifest and verifier | Pinned version/snapshot/header/provenance checks retained. |
| #6 | Common Bootstrap | Missing history still fails closed; no runtime legacy fallback. |
| #7 | Mobile-first PWA | Existing pitch-range, project-queue, Core3 row-binding and intake-authority regressions retained. |
| #8 | Artifact identity | Stable runtime identity and tamper rejection remain covered; no permanent release rewrite. |
| #9 | Durable permanent deployment | Separate plane; fixture bootstrap suite executed; no migration/redeploy. |
| #10 | Canonical guard tests | Guard suite retained; no plain-64 or simultaneous-attack blanket bans added. |
| #11 | Roadmap / durable CI | Outstanding decision items remain explicitly classified below. |
| #12 | Timing provenance | Component provenance preserved; no source timing normalization introduced. |
| #13 | Micro-timing analyzer | Existing F1/F2 guard behavior retained. |
| #14 | Micro-timing readiness | Source-aware refusal retained, not replaced by metric cleanup. |
| #15 | Raw MIDI intake | Exact MIDI evidence / note identity retained; no guessing repairs for real orphan NoteOffs. |
| #16 | Third-party frontend snapshot | Closed, not merged; 105 reference paths excluded from runtime/rule authority. |
| #17 | Lossless voice split | Deep-frozen and non-mutation pipeline checks pass with R07. |
| #18 | Six-role suggestions | Candidate is not acceptance; ambiguous roles remain pending. |
| #19 | Evidence-scope hotfix | Current scope/provenance containment regressions retained. |
| #20 | Pre-Web adversarial audit | Its remaining collection-level P2-B is closed by R07; P2-A was repaired later. |
| #21 | Raw MIDI Web integration | Update P2-B preflight assertion; preserve Worker-copy and deep-frozen integration tests. |
| #22 | Dated readiness snapshot | Historical claims are not current acceptance evidence. |
| #23 | Living Raw MIDI docs | No new runtime defect established from this documentation-only change. |
| #24 | Sub-1/64 gap handling | Source-aware distinction retained; no forced shortening/filling of musical events. |
| #25 | Final emitter | Existing syntax/readback/attack guards retained; G15 remains separately classified. |
| #26 | Third-party editor naming docs | No runtime or rule change required. |
| #27 | Web Final delivery | Delivery still validates emitted MML and fails closed on unresolved final-bar inputs. |
| #28 | Accepted-decision application | Baseline/candidate/evidence binding tests retained; no automatic acceptance. |
| #29 | M6 parallel Bootstrap | Full-suite isolation stress rerun; no shared-ref mutation. |
| #30 | safe.directory / M6 guards | Existing trusted Git invocation checks retained. |
| #31 | Revision/evidence integrity | Later code already closes foreign Lead identity and evidence carry-forward findings; do not count them as newly fixed. |
| #32 | Song reference package (removed from the public tree since) | Source package is not a real-song Final or in-game PASS. |
| #33 | OSS export | Applicable clean-export CI included for expanded source changes. |
| #34 | Technical timing repair | Explicit opt-in and source-aware guards retained; no unsupported note-release extensions. |
| #35 | Application API/MCP | R01/R02 storage bugs and R08 dependency packaging repaired. |
| #36 | Git-less Railway image Bootstrap | Existing real Docker-image smoke CI retained; no credential/sealing workaround. |
| #37 | Candidate-bound confirmations / transport audit | Current review, ownership and error-envelope regressions retained. |
| #38 | Lead promotion / Final compliance | Previously fixed Lead/Core3 lineage and gate issues remain covered; no role-evidence shortcut. |
| #39 | Mobile Adaptation | Existing profile/evidence/review boundaries retained; no invented ranges or velocities. |
| #40 | Final six-role reduction | Existing retention-ledger, duplicate-baseline and overflow guards retained. |
| #41 | Run orchestrator | Previously fixed prototype and durable idempotency-binding findings retained. |
| #42 | Proposal protocol | Previously fixed stale replay / under-lock binding checks retained; proposals are not acceptance. |
| #43 | Shared workspace / MCP handoff | Existing browser and container CI retained; no automatic external-agent continuation claim. |
| #44 | Production E2E tools/evidence | Earlier live watch-pattern omission repaired by original #46; full production acceptance still not implied. |
| #45 | GPUtw/Jev / probe diagnostics | Existing config/response/classification regressions retained; no paid live Jev or GPU operation performed. |
| #46 | Railway evidence + expanded audit | Original operational correction retained; R01-R08 and 24 new tests added in checkpoints. |

## Remaining decisions and evidence gaps - not silently marked fixed

- **G12, committed legacy source ZIP strategy:** the build regenerates the ZIP,
  but the tracked artifact can drift. Choosing to untrack, enforce committed
  determinism, or retire the legacy download remains an explicit project
  strategy item. R08 fixes executable Worker packaging, not this strategy.
- **G13, lockfile posture:** exact direct versions but floating transitive
  resolution is existing accepted debt. No dependency upgrade, new package or
  lockfile policy is introduced here.
- **G15, final partial bars:** emitter/validator scope disagreement remains a
  documented decision item. Explicit source-confirmed pickup/final_partial is
  still required where applicable; #46 does not pad notes or invent meter.
- **Production acceptance:** browser OAuth -> upload -> same run through MCP ->
  proposal/readback is not newly executed on production. A local/CI pass is not
  production acceptance; the callable connector surface is a separate check.
- **Real-song/audio/client acceptance:** real alignment quality, named song
  fixtures, target-client behavior and `IN_GAME_ACCEPTED` still require the
  corresponding evidence. Live Jev network behavior was not exercised here.
- **R07 scope:** collection containers are protected; arbitrary nested metadata
  is not asserted deeply immutable. No unsupported security guarantee is made.

See [V1_1_ROADMAP.md](V1_1_ROADMAP.md) and the original production evidence for
their actual status. G14 per-token caution granularity is already
`NO_ACTION_REQUIRED`, not an open Canonical violation.

## Deployment and merge boundary

The initial #46 changed live watchPatterns deliberately and refreshed the
observed successful deployment to `<redacted-id-1>` at
`bbb8534245c78041573fd93af88c8fc7fd3e89bd`. This expanded audit did not change
Railway settings, secrets, volumes, source data or deployment state.

**The expanded diff is no longer evidence-only:** changes under
`/studio/backend/**` match the production watch patterns. Merging can enter the
configured main/Wait-for-CI deployment path. The original assertion that an
#46 merge would not trigger production deployment must not be reused.
No merge, manual deploy, Permanent Studio release update, Canonical publication
or song acceptance is authorized or performed by this audit.
