# v1.1 Roadmap and Maintenance Register

Status: PLANNING RECORD — not a Canonical authority.

This document tracks post-v1 gap-audit findings and maintenance work. It records
status, evidence and decision classification only. It defines no music rule, no
syntax rule and no acceptance gate, and it MUST NOT be loaded as a replacement
for the Published Canonical rule sources. Rule discovery starts only at
[docs/CANONICAL_MANIFEST.md](CANONICAL_MANIFEST.md) and its pinned snapshot.

## Loaded Canonical identity

| Identity | Value |
| --- | --- |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| Published main at reconstruction | `4487aac598bb5d0eb0907f71856fe99a6e28fa21` |

All six indexed documents were loaded from the exact snapshot and their
version/publication headers verified. No local Skill, Master, memory, audit
document or implementation behaviour was used as a rule substitute.

## Classification vocabulary

**Status** — `RESOLVED` (closed by merged work), `OPEN`, `NO_ACTION_REQUIRED`,
and `PARTIALLY RESOLVED` for an umbrella item whose parts are split (see M3).
An umbrella row carries no blocker class of its own; its sub-items do.

**Blocker class** — what the item is actually waiting on:

| Class | Meaning |
| --- | --- |
| `ROADMAP_ONLY` | Needs to be tracked; no repository change is pending. |
| `NEEDS_PROJECT_DECISION` | Blocked on an explicit human decision. |
| `DESIGN_REQUIRED` | Approach must be reviewed before implementation. |
| `IMPLEMENTATION_WORK` | Approach is settled; code or workflow change remains. |
| `DOCUMENTATION_ONLY` | Prose change only. |
| `OWNER_ACTION_REQUIRED` | Repository settings; outside agent scope by construction. |

**Canonical impact** — `NONE` unless a change would add an acceptance gate,
change Core3 semantics, or introduce a new normative finalization requirement.
A new rules release requires an explicit, reviewed update to the release
metadata and snapshot reference. Nothing in this register may be read as
authorising one.

## Gap register G1–G15

Gap identifiers originate in the post-v1 mutation audit merged as PR #10
(`test(studio): cover the Canonical guards that no regression asserted`,
merge commit `4487aac`, head `19ffd3b`, test-only, +311 lines across 3 files).
Before this register existed, the taxonomy survived only in that pull request's
prose.

| ID | Subject | Status | Blocker class | Canonical impact |
| --- | --- | --- | --- | --- |
| G1 | Tie / attack identity | `RESOLVED` | — | `NONE` |
| G2 | Initial Tempo on non-empty roles | `RESOLVED` | — | `NONE` |
| G3 | Per-role 2,400-character limit | `RESOLVED` | — | `NONE` |
| G4 | Octave bounds as implementation mapping | `RESOLVED` | — | `NONE` |
| G5 | `core3Threat` discrimination | `RESOLVED` | — | `NONE` |
| G6 | Register-risk classification | `RESOLVED` | — | `NONE` |
| G7 | All 15 role-pair overlap coverage | `RESOLVED` | — | `NONE` |
| G8 | Named-song historical fixtures (P12) | `OPEN` | `NEEDS_PROJECT_DECISION` → `IMPLEMENTATION_WORK` | `NONE` |
| G9 | Reduced 1-/2-role quality (P17) | `OPEN` | `ROADMAP_ONLY` / `NEEDS_PROJECT_DECISION` | `NONE` (see correction 1) |
| G10 | Source-aware sub-1/64 micro-gap | `RESOLVED` | — | `NONE` |
| G11 | Drum policy fails closed | `RESOLVED` | — | `NONE` |
| G12 | Stale `workbench-source.zip` | `OPEN` | `NEEDS_PROJECT_DECISION` → `IMPLEMENTATION_WORK` | `NONE` |
| G13 | Lockfile decision | `OPEN` | `NEEDS_PROJECT_DECISION` → `IMPLEMENTATION_WORK` | `NONE` |
| G14 | Per-token caution granularity | `NO_ACTION_REQUIRED` | — | `NONE` |
| G11-D-R | G11-D residual integrity hardening (Lead identity at the gate, Web revision chain, record envelope, carry-forward) | `RESOLVED` (pending review) | — | `NONE` |

### Coverage closed by PR #10 (G1–G7, G11)

Each guard below was correct in production code before PR #10; only the
regression coverage was missing. Every added test was verified to fail against a
mutated guard and pass against current code. Suite moved 235 → 248.

| ID | Canonical authority | Coverage added | Test file |
| --- | --- | --- | --- |
| G1 | `MASTER_RULES` §7 · `MOBILE_SYNTAX` §8 | A tie continues the same pitch only, never spans a rest or ends a track unresolved; a repeated attack stays two attacks instead of collapsing into one sustain | `studio/tests/mml-parser.test.mjs` |
| G2 | `MOBILE_SYNTAX` §7 clause 1 | Initial Tempo required on every non-empty role; empty roles still receive no filler Tempo | `studio/tests/mml-parser.test.mjs` |
| G3 | `MOBILE_SYNTAX` §2 / §11.6 | Per-role 2,400-character limit fails Final and warns at ingest | `studio/tests/mml-parser.test.mjs` |
| G4 | `MOBILE_SYNTAX` §6 | Octave bounds stay an implementation mapping that disclaims official wording, kept separate from the pitch 0–107 check | `studio/tests/mml-parser.test.mjs` |
| G5 | Gate 5 · `MASTER_RULES` §5 | `core3Threat` discriminates Core3-versus-enrichment from same-tier conflicts; a same-tier conflict stays reviewable rather than ignored | `studio/tests/harmony-arbitration.test.mjs` |
| G6 | `MASTER_RULES` §6 | Register risk classifies on both the same-pitch and dissonance paths and follows the configured ceiling | `studio/tests/harmony-arbitration.test.mjs` |
| G7 | `PENDING` P15 | All 15 unordered role pairs exercised for sustained same-pitch overlap; evidence-backed decisions separate justified doubling from collision risk without adding, deleting or rewriting any source event | `studio/tests/harmony-arbitration.test.mjs` |
| G11 | `MASTER_RULES` §8 | Unmapped GM drum data fails closed; drum roles excluded from pitched overlap review without losing any of the 15 pairs; delivery emits the mapped drum face, never the raw source pitch | `studio/tests/drum-policy.test.mjs` |

**The underlying PENDING items are not closed by this coverage.** G7 supplies the
regression evidence P15 asks for; P15 itself remains open. G11's fixture mapping
is explicitly a test fixture and is not evidence-backed; P10 still owns the real
Mobile drum-face mapping. G3 asserts project delivery policy only; P1 keeps exact
client counter semantics unverified. G4 claims no official wording for the O-token
range; P6 remains open. G2 asserts delivery policy; P2 leaves the engine-necessity
question open. A closed gap means the guard is now asserted by a regression, not
that the pending in-game question is answered.

### G8 — Named-song historical regression fixtures (P12) · `OPEN`

**Evidence.** `studio/web/model.mjs:170` hardcodes
`historicalRegression: 'FIXTURE_PENDING'`. `docs/ACCEPTANCE_CRITERIA.md:121` and
`docs/PENDING.md` P12 both require that value until executable fixtures exist.
The disclaimer is surfaced to users in `studio/web/README.md:142` and
`studio/web/app.mjs:111`. PR #10 created no fixture and left P12 untouched.

**Why open.** P12's required action is "legally usable/minimal synthetic or
source-permitted regression fixtures". Which category applies to a named
regression such as Rashisa/らしさ has not been decided. This is a
legal/sourcing question, not a coding question.

**Guardrail for v1.1 (binding on this roadmap).**

- Synthetic fixtures MAY exercise generic regression mechanics.
- Synthetic evidence MUST NOT flip a named-song regression such as
  Rashisa/らしさ from `FIXTURE_PENDING` to `PASS`.
- A named-song `PASS` requires an executable, legally/source-permitted fixture
  that actually represents that named regression.
- Generic synthetic evidence is therefore NOT the exit criterion for a named
  regression. Passing generic mechanics tests never certifies a named song.

**Canonical impact.** `NONE`. P12 already states the rule; no rules release is
implied by satisfying it.

### G9 — Reduced one-/two-role performance quality (P17) · `OPEN`

**Classification: `ROADMAP_ONLY` / `NEEDS_PROJECT_DECISION`.**

**Evidence.** `docs/PENDING.md` P17 records that the degradation policy and
validation gate "are not yet fully formalized" and calls for "song-level A/B and
a project decision", while instructing that the Core3 gate must not be weakened
meanwhile. `docs/ACCEPTANCE_CRITERIA.md:70` states that reduced one-/two-role
checks "may be reported separately, but they do not redefine the Core3 gate".
No `reducedRole` / `roleCount` handling exists in `studio/backend`; the contract
carries only `core3` (`['Melody','Chord1','Chord2']`) and `core3ContinuityGate`.

**Canonical impact: `NONE`.** Published Canonical already permits reduced
one-/two-role checks to be reported separately and already states that they do
not redefine the Core3 gate. A future project decision about reduced-role
quality does **not** automatically require a Canonical change, and this roadmap
does not encode one.

A new Canonical rules release would become required **only if** the project
later chooses to:

1. introduce a new acceptance gate; or
2. change Core3 semantics; or
3. introduce new normative finalization requirements.

Absent one of those three, reduced-role work is reporting and tooling that sits
inside the existing published rules.

### G10 — Source-aware sub-1/64 micro-gap enforcement · `RESOLVED`

**Original finding.** `docs/MOBILE_SYNTAX.md` §4 makes `FINAL_FORBIDDEN`
"technical micro-gaps or decomposition components finer than 1/64 **when they
have no source-supported musical meaning**", and §11 step 5 requires Final
canonicalization to "ensure no zero duration or non-musical technical micro-gap
remains". `docs/MASTER_RULES.md` §7 permits normalizing meaning-free micro-gaps
while preserving meaningful source rests. The executable contract declared
`rejectTechnicalMicroGapsBelow64: true` with no consumer anywhere in the
repository, and `preserveMeaningfulRests: true` sat beside it in the same state.

**Why it could not be a threshold.** Enforcement is conditioned by Canonical on
*source-supported musical meaning*. A naive "reject everything finer than 1/64"
would itself violate Canonical by discarding source-supported material, so the
source-meaning signal had to be threaded into the check.

**How it was closed.** In three merged stages:

| Stage | Contents |
| --- | --- |
| C2A | `studio/backend/canonical/micro-timing.mjs` — the source-aware classifier. Exact-rational 1/64 grid, interval identity for both event durations and inter-event gaps, and the four outcomes: source-supported, technical residue, unknown, unresolved stream identity. |
| C2B | `microTimingGate` in `studio/backend/final/readiness.mjs` — per-song readiness consumes those outcomes without collapsing them into a boolean. |
| C2C | `studio/backend/final/micro-gap-enforcement.mjs` — the Final policy layer. It is the single place a classification becomes a Final outcome, and the place the contract values are actually read. |

The enforcement layer maps each class to one outcome — source-supported to
`preserve`, technical residue to `reject-final`, unknown and unresolved stream
identity to `block-pending` — and derives the safe grid from
`shortestSafeDenominator` as an exact rational rather than restating 1/64, so
the contract and the analyzer can no longer drift apart in silence. A contract
that stops echoing the published rule is reported non-conformant and fails
closed; it cannot relax the rule and cannot turn a `FAIL` into a pass. The
report also publishes `enforcement[]`, `preservedIntervalKeys`,
`rejectedIntervalKeys` and `blockedIntervalKeys` as the hook a later
Canonical-aware Final emitter consumes.

Regression coverage is `studio/tests/micro-timing-analyzer.test.mjs`,
`studio/tests/micro-timing-readiness.test.mjs`,
`studio/tests/micro-timing-performance.test.mjs` and
`studio/tests/micro-gap-enforcement.test.mjs`. Seven deliberate mutations of the
G10 guards — including treating every sub-grid interval as technical, treating
unknown provenance as technical, ignoring the source-supported classification,
moving either boundary comparison to include exactly 1/64, ignoring the contract
flags, and letting a mismatched denominator silently become the grid — were each
caught by at least one regression.

**Canonical impact.** `NONE` — the rule was already published, and this work
added none. Only enforcement was missing.

**What this does not claim.** This closes the *implementation* gap: the published
rule now has an executable consumer and mutation-verified coverage. It resolves
no `PENDING` in-game question. P4 (arbitrary 1–64 length behavior) and P5 (dotted
edge forms) remain open, and a `microTiming` `PASS` certifies source-supported
musical meaning only — it makes no Final representability claim, which needs its
own mechanism, and it never substitutes for the separate technical MML gate.

**Out of scope, deliberately.** The complete Final MML emitter is the next
project. G10 stops at classification, enforcement and diagnostics; it performs no
normalization rewrite, because an exact rewrite to a canonical note/tie/rest
decomposition belongs to that emitter. Rejecting is the fail-closed half of the
range MASTER_RULES §7 permits, and `rejectedIntervalKeys` is the worklist the
emitter can adopt without this contract changing meaning.

**Follow-up, as built.** The Canonical-aware Final MML emitter now exists as
`studio/backend/final/mml-emitter.mjs` and is G10's second declared consumer: it
reads `enforceMicroGaps` rather than re-deriving a threshold, refuses to emit on
a rejected or blocked interval, and refuses rather than damaging a preserved
source-supported one — no Final token is shorter than the 1/64 grid, so such an
interval cannot be written at all. It performs **no** technical timing repair,
so `rejectedIntervalKeys` remains an unconsumed worklist and that part of the
paragraph above still stands. See [FINAL_MML_EMITTER.md](FINAL_MML_EMITTER.md).
It resolves no `PENDING`: P1, P2, P3, P4, P5, P6, P10 and P16 are all still
open, and the emitter is deliberately narrower than each of them.

### G11-D-R — G11-D residual integrity hardening · `RESOLVED` (pending review)

**Origin.** PR #28 (G11-D) recorded four residuals rather than fixing them: the
pre-G11-D Web Lead evidence path was not covered by the identity binding; the
Web model did not chain revisions; decision records were self-consistent but
their acceptance block was outside the digest; baseline/parent arbitration
decisions were carried forward unchanged.

**Closed how.** Four checkpoint commits on `fix/g11d-residual-hardening`, each
with its own threat model, regressions and executed mutations, documented in
`docs/G11D_DECISION_APPLICATION.md` under "Residual hardening". Canonical impact
`NONE`; no Published Canonical document changed.

**Still open, by design.** Authenticated authorship of decision records is
`NOT_ESTABLISHED` (no trust root exists; a digest is not a signature). Multi-
source Lead evidence stays fail-closed until the IR preserves source/source-event
pairs. Both are stated in the code as data.

### G12 — Stale legacy `workbench-source.zip` · `OPEN`

**Evidence.** `dist/workbench-source.zip` is tracked (`.gitignore` excludes only
`dist/server/` and `dist/.openai/`). It was last committed in `8c755f5`
(2026-09-09). `scripts/build.mjs:13` regenerates it from 23 explicitly listed
inputs; since that commit, `README.md` has changed in 5 commits, `package.json`
in 3 and `.gitignore` in 2, so the tracked artifact no longer matches its
declared inputs. It is user-visible: `dist/index.html:32` offers it for download
and `scripts/build.mjs:15` base64-embeds it into the legacy Worker bundle.

**Mitigating fact.** Studio CI runs `npm run build` on main, which rebuilds the
zip, so deployments do not serve the stale committed bytes. The drift is in the
tracked artifact, not in what users receive.

**Why open.** Requires a strategy choice, not a repair. Candidate options:
(a) untrack it and always build; (b) keep it committed and add a CI drift check;
(c) retire the download with the legacy Workbench.

**Canonical impact.** `NONE`.

### G13 — Lockfile decision · `OPEN`

**Evidence.** No `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` or
`yarn.lock` exists. All three `studio-ci.yml` jobs install with
`npm install --ignore-scripts --package-lock=false`. Direct dependencies are
exactly pinned (`fast-xml-parser 5.10.1`, `playwright 1.62.1`), so only
transitive resolution floats. `docs/RELEASE_READINESS_2026-09-13.md` already
records this as accepted debt: exact direct versions without a committed
lockfile, "so transitive install reproducibility can be hardened later."

**Why open.** Deliberately deferred rather than overlooked. It interacts with the
durable release path, which pins byte-reproducible artifacts
(`ops/permanent/release-lock.json`, `buildId`), so the lockfile posture and the
release-workflow intent (M3b) should be decided together.

**Canonical impact.** `NONE`.

### G14 — Per-token caution granularity · `NO_ACTION_REQUIRED`

**Evidence.** `docs/MOBILE_SYNTAX.md` §3 does not require per-token caution
granularity; candidate-level caution opt-in satisfies the published rule. The
dated audit records list candidate-level opt-in as visible debt
(`docs/RULES_AUDIT_2026-09-13.md`), not as a Canonical violation.

**Disposition.** Closed as not-a-gap. Retained here so the identifier is not
silently reused and so a future reader does not re-derive it as open.

### G15 — Emitter and Web validator disagree on final-bar completeness · `OPEN`

**Evidence.** Two implementers answer different questions about the same
candidate. `studio/backend/final/mml-emitter.mjs` enforces the Final policy it
implements — safe-grid decomposition, forbidden dotted forms, the
synchronization-safe Tempo policy, the per-role character limit, and its own
readback — but performs no final-bar-completeness check. `validateMML`
(`studio/backend/mml/parser.mjs`), which the Web layer uses to grade a delivery,
does require the last bar to be filled against the confirmed meter. A candidate
whose music ends mid-bar therefore serializes cleanly and is then refused by the
delivery check. Reproduced during the Web Final delivery integration and pinned
as a regression in `studio/tests/web-final-delivery.test.mjs`.

**What this is not.** Neither behaviour is an engine claim. The published rule
sources do not state a final-bar-completeness requirement:
`MOBILE_SYNTAX.md` §11 step 7 requires that meter and time alignment be
verified without specifying this test, and `PENDING.md` P14 explicitly records
that cross-role end-time and total-duration expectations are not yet formalised.
The validator's check is one implementation's reading, and this register may not
be read as promoting it to a rule.

**Mitigating fact.** The integration fails closed: the emitted string is
verified before it can become a delivery, a refusal keeps no output, and nothing
pads a short final bar to make the check pass. The Web UI shows the validator's
refusal in the validator's own words and labels it as current implementation
behaviour.

**Why open.** Needs a decision rather than a repair: whether the emitter should
adopt the same test, whether the validator's test should be narrowed, or whether
the two questions are legitimately different and only the reporting needs work.
Any answer that would make final-bar completeness a normative finalization
requirement is a Canonical change and must go through change control instead.

**Canonical impact.** `NONE`.

## Maintenance and governance register

Items surfaced by the same reconstruction that do not carry a G identifier.

| ID | Subject | Status | Blocker class | Canonical impact |
| --- | --- | --- | --- | --- |
| M1 | Durable roadmap register | `RESOLVED` by this document | `DOCUMENTATION_ONLY` | `NONE` |
| M2 | Current-facing documentation drift | `NO_ACTION_REQUIRED` (verified) | — | `NONE` |
| M3 | Durable release / bootstrap CI topology (umbrella) | `PARTIALLY RESOLVED` | see M3a / M3b | `NONE` |
| M3a | Durable bootstrap push coverage on `main` | `RESOLVED` in PR #11 | — | `NONE` |
| M3b | Historical release workflow re-runnability | `OPEN` | `NEEDS_PROJECT_DECISION` | `NONE` |
| M4 | Governance / branch protection | `OPEN` | `OWNER_ACTION_REQUIRED` | `NONE` |
| M5 | Song History / Regression Evidence structure | `OPEN` | `NEEDS_PROJECT_DECISION` | Undecided — see M5 |
| M6 | Canonical bootstrap Git-subprocess fragility under parallel tests | `RESOLVED` in PR #29 | — | `NONE` |

### M1 — Durable roadmap register · `RESOLVED`

Before this file existed, a repository-wide search for `V1_1_ROADMAP` and `v1.1`
returned zero hits in tracked files, and the G1–G14 identifiers appeared nowhere
in the repository. The taxonomy existed only in merged PR #10's description, so
the gap identifiers were unresolvable to anyone reading the repository. This
document is that register.

### M2 — Current-facing documentation drift · `NO_ACTION_REQUIRED`

The read-only reconstruction initially flagged `README.md:13`
("本機 78 項測試通過") as stale. **Direct verification contradicted that flag.**

| Command | Result |
| --- | --- |
| `npm run test:legacy` | 78 tests, 78 pass, 0 fail |
| `npm run test:studio` | 170 tests, 170 pass, 0 fail |
| `npm test` | 248 tests, 248 pass, 0 fail |

The README sentence sits in the `獨立主機部署` (standalone host deployment)
section and describes the legacy Workbench suite, which is still exactly 78
tests. Its accompanying claim — coverage "包括經由實際本機 HTTP 的 OAuth＋MCP
呼叫" — is satisfied by a real-loopback OAuth/MCP test in the legacy suite. The
figure is correct and correctly scoped; changing it to 248 would have introduced
an error.

Other verifiable README claims also hold: `dist/core.js` declares
`VERSION = '0.1.0'` and `server/mcp.mjs` declares `SERVICE_VERSION = '0.2.0'`,
matching "網站核心 v0.1.0，工具服務 v0.2.0"; every referenced path and npm script
exists. **No unambiguous current-facing README drift was found, so no README
change was made.**

Dated audit and checkpoint records (`RELEASE_READINESS_2026-09-13.md`,
`RULES_AUDIT_2026-09-13.md`, `STUDIO_WEB_V1_FINAL_AUDIT.md`,
`STUDIO_WEB_V1_IMPLEMENTATION.md`) are historical by construction. Their
then-accurate figures are not drift and MUST NOT be rewritten.

### M3 — Durable release / bootstrap CI topology · umbrella

Tracked as an umbrella with two independent parts. **M3a is resolved in PR #11.
M3b remains open and is a project decision, not implementation work.**

#### M3a — Durable bootstrap push coverage on `main` · `RESOLVED` in PR #11

**Pre-PR state — reconstruction evidence, no longer current.** Before PR #11,
`.github/workflows/studio-durable-bootstrap-ci.yml` declared
`push: branches: [studio-permanent-durable-migration]`. That branch had been
deleted after PR #9 merged (remote heads were `main`,
`chore/v1.1-gap-audit-regression`, `chatgpt/lead-role-20260910` and
`legacy-v0.2.0`), so the push trigger was dead, and `main` was never in the list.
Run history showed 5 total runs, all on the deleted branch, and none on `main`.
The consequence at that time: `ops/permanent/**` changes merged to `main`
received no durable bootstrap push-CI coverage.

**Resolution in PR #11.** The obsolete branch target is replaced with `main`, so
the deleted-branch push target no longer appears in the workflow. Path filters,
`pull_request` behavior, `permissions`, job name, `runs-on` and all four steps are
unchanged; a parsed before/after comparison differs in exactly one key,
`on.push.branches`.

**Status.** No implementation work remains for M3a. Because the trigger is scoped
to `main`, the restored coverage exercises itself on the merge commit rather than
on the PR branch.

#### M3b — Historical release workflow re-runnability · `OPEN` · `NEEDS_PROJECT_DECISION`

`.github/workflows/studio-durable-release.yml` is **unchanged by PR #11** and is
currently treated as a **pinned historical release publisher**, not a generic
current-main release workflow. Evidence for that reading: a pinned source SHA,
pinned `buildId` / `release-lock.json` verification, explicit
publish-without-replacing-historical-assets behavior, and
`ops/permanent/build_function.py` rendering with `trustSourceSha 5769e76849e5…`,
pinned by construction and independent of current `main`.

Under that interpretation, its pinned first step — asserting that `origin/main`
equals `5769e76849e5ef8dad03b4080050cafcf1c2eabe`, which no longer holds now that
published main is `4487aac` — is deliberate pinning rather than a defect, and its
`concurrency` group hardcoded to `studio-durable-release-5769e76849e5` is
consistent with that reading.

**Open question.** Should a pinned historical release publisher remain manually
re-runnable at all? If yes, the pinned guard needs an explicit re-run story; if
no, the workflow should record that it is archival. This is a project decision,
not implementation work. While it stands: nothing is parameterized, no pinned
SHA, `buildId` or `release-lock.json` is touched, and no release is published.

**Canonical impact.** `NONE` for both parts.

### M4 — Governance / branch protection · `OPEN`

**Evidence.** The GitHub API reports `main` as `protected: false`. There is no
`CODEOWNERS`, pull-request template or `CONTRIBUTING.md`. Studio CI runs on every
pull request and on main pushes and is green (run #168 on `4487aac`), but no
check is *required*, so nothing mechanically prevents a direct push to main or a
merge over red CI. The merged branch `chore/v1.1-gap-audit-regression` was never
deleted.

**Why this matters here specifically.** The Canonical model directs readers to
load `docs/CANONICAL_MANIFEST.md` from the published `main` history. Main's
integrity is therefore the chain of custody for the published rules release.

**Scope note.** Branch protection is a repository setting. It is owner-side by
construction and explicitly outside agent scope in this workstream. This register
can carry a recommendation only.

**Canonical impact.** `NONE`.

### M5 — Song History / Regression Evidence structure · `OPEN`

No schema is designed here. This section classifies only the decisions that must
precede implementation.

**Existing precedent.** `docs/history/lead-role-2026-09-10/` already models a
usable pattern: original bytes preserved verbatim, a README declaring
`Status: HISTORICAL_REFERENCE`, an original-path → preserved-file mapping table,
and an explicit statement that the archived files' former normative declarations
carry no current Canonical authority.

| # | Decision | Class | Why it precedes implementation |
| --- | --- | --- | --- |
| D1 | Scope split: per-song decision provenance, the P12 regression-fixture store, or both | `NEEDS_PROJECT_DECISION` | They carry different legal constraints; combining them subordinates the safer to the riskier. |
| D2 | Authority and reference model for the history store | Provenance / authority design decision | See below. |
| D3 | Legal/licensing gate: synthetic, source-permitted, or reference-by-hash without committing bytes | `NEEDS_PROJECT_DECISION` | Directly gates G8/P12; the same decision serves both. |
| D4 | Location: same repository or a separate one | `NEEDS_PROJECT_DECISION` | If separate, it must be referenced without creating a second rule authority. |
| D5 | Identity/provenance recording for history entries | Provenance / authority design decision | See below. |
| D6 | Mutability: append-only with explicit supersession, or editable | `NEEDS_PROJECT_DECISION` | Determines whether the store functions as evidence or as notes. |
| D7 | `FIXTURE_PENDING` exit criteria and who certifies them | `NEEDS_PROJECT_DECISION` | Today it is a hardcoded constant; the transition must be defined before code implements one. Bound by the G8 guardrail above. |
| D8 | Granularity: per-song, per-section or per-event | `NEEDS_PROJECT_DECISION` | `MOBILE_SYNTAX` §11.8 requires a reversible mapping from canonical output to source events/decisions, which constrains the floor. |

**D2 — authority and reference model.** Classified as a provenance / authority
design decision. This roadmap does **not** assume that adding a Song History
structure requires a `manifest_version` bump. Whether the Published Manifest
should reference a future history store at all, and whether doing so would
require a Manifest revision, are separate questions to be decided explicitly
later. A history store can also exist as a non-indexed, clearly non-Canonical
record, exactly as `docs/history/lead-role-2026-09-10/` does today.

**D5 — identity and provenance recording.** Classified as a provenance /
authority design decision. This roadmap does **not** assume that the absence of
identity pinning retroactively invalidates historical records. Existing
historical records remain valid as history. What identity a future entry should
carry — and whether it should pin `canonical_version`, `rules_snapshot_sha` or a
tool `buildId` — is a design choice about future provenance quality, not a
judgment on past records.

**Canonical impact.** Undecided by construction; see D2. No Canonical or Manifest
change is asserted to be required.

### M6 — Canonical bootstrap Git-subprocess fragility under parallel tests · `RESOLVED` in PR #29

**Verified root cause.** The Manifest was not intermittently corrupted by Git
under load. `studio/tests/web-build-reproducibility.test.mjs` temporarily rewrote
the **shared checkout's** `refs/remotes/origin/main` to probe commits while
checking fail-closed build behaviour. Every `node --test` file runs in its own
process and many bootstrap from that same discovery ref during module import. A
sibling process resolving the ref inside one of those probe windows therefore
loaded the probe Manifest and correctly refused it. Instrumentation captured the
failing process resolving the published ref to the probe commit during the
window, reproducing the observed `Unpinned snapshot locator` and unsupported
Canonical-version failures. High Git subprocess volume widened the race window;
it did not corrupt a read.

**Resolution.** PR #29 moves all build-reproducibility probes that publish a
Manifest, move the discovery ref, or edit source inputs into private isolated Git
repositories. The shared checkout stays read-only and both the in-file guard and
the full-suite stress runner assert that its discovery ref is never rewritten.
The production loader is also hardened without changing its authority contract:
it binds every Git command to the requested repository root, removes ambient Git
redirection/config-injection variables, disables replacement refs, resolves the
published discovery ref to one commit before reading the Manifest, and reads the
Manifest and pinned snapshot resources with strict `cat-file --batch` parsing.
There is no cache, retry, fallback to working HEAD, hardcoded snapshot bypass, or
legacy-rule fallback. A failed load still fails that caller closed; a later
independent load starts cleanly.

**Measured / regression evidence.** One bootstrap fell from 29 Git subprocesses
to 8. In the pre-fix instrumented full run, the suite issued 2,443 Git
subprocesses, resolved four published identities and rewrote the shared discovery
ref six times. After isolation and loader hardening, the corresponding measured
run used 973 Git subprocesses, resolved one published identity and left the
shared ref untouched. Fourteen deliberate mutations of the new guards were
caught. Five default-concurrency full-suite stress runs and three runs at
concurrency 12 observed zero failures, one published identity per run and no
shared-ref writes. Exact-head Studio CI run `35136363244` on PR head
`9963386106a317d56376d83c04afd1b371897c8b` passed `symbolic`, the dedicated M6
full-suite isolation step, `audio-worker`, and `studio-web`.

**Failure semantics.** The safety direction is unchanged: malformed or
unpublished Manifest data, unavailable or wrong snapshots, identity mismatch,
short/missing/mistyped batch objects and unavailable required Git history remain
`CANONICAL_NOT_LOADED`. No lower-authority source is substituted.

**Canonical impact.** `NONE`. This is loading/test-isolation robustness only; it
changes no music rule, syntax rule, acceptance gate or Published Canonical
release identity.

**Follow-up after merge (post-merge adversarial review).** Two of the review's
lenses completed before its budget ran out; their raw findings were checked by
hand. Three were real and are fixed in the follow-up PR: the loader no longer
strips `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT`-`KEY`-`VALUE`, because that
is the only per-process channel for `safe.directory` in a foreign-owned checkout
and injected configuration cannot move discovery past the root binding
(regressions: injection loads the requested root or fails closed; a chowned
checkout loads only through the channel); a Manifest locator with an empty path
segment (`studio/tests//`) is rejected instead of aliasing another locator; and
the shared-ref observation in the in-file guard and the stress runner now
includes the identity (inode, size, change time) of the ref, its reflog and
`packed-refs`, so a delete-and-recreate is seen, not only a rewrite-and-restore.
One finding was refuted by experiment (`log.showSignature` does not pollute
`git log --format=%H` stdout). One is recorded as a non-blocking residual: a
symlink entry in the pinned snapshot reads as a `blob` for `IMPLEMENTER` /
`VERIFIER` locators, unchanged from the previous loader; rule documents are
content-checked and unaffected.


## Dependencies

- **G13 depends on M3b.** The lockfile posture and the durable release intent both
  govern reproducibility; deciding them separately risks contradictory pins.
- **G8 depends on M5/D3.** The legal/licensing gate for committable source
  material is the same decision in both items.
- **M5/D7 depends on the G8 guardrail.** The `FIXTURE_PENDING` exit criteria must
  honour the named-song rule: generic synthetic evidence is not an exit
  criterion.
- **G10 depended on nothing else.** It was self-contained: a published rule with
  a declared but inert flag, needing design then implementation. Now `RESOLVED`.
- **G9 depends on a project decision only.** It blocks no other item and is
  blocked by no other item.
- **M4 is independent and owner-side.** It gates nothing in this register
  technically, but it underwrites the trustworthiness of published main.

## Recommended separate pull requests

Sequenced so that no PR mixes a decision-bearing change with a mechanical one.

| PR | Contents | Prerequisite |
| --- | --- | --- |
| **A — documentation + CI topology** | This register; restore `ops/permanent/**` push coverage on `main` (M3a) | None. This is PR #11. |
| **B — release semantics** | Resolve `studio-durable-release.yml` re-runnability per M3b | M3b decision |
| **C — G10 enforcement** ✅ | Source-aware micro-gap enforcement with mutation-verified regressions | Delivered across C2A / C2B / C2C |
| **D — G12 / G13** | Artifact strategy and lockfile posture together | G12 + G13 decisions, after M3b |
| **E — M5 groundwork** | Song History structure documentation only, no schema | D1–D8 decisions |
| **F — Final MML emitter** ✅ | Canonical-aware Final MML emitter: exact-rational duration decomposition, attack/tie semantics, tempo placement, pitch/octave and character planning, G10 consumption, round-trip Final gate | C. Foundation delivered; no technical timing repair, no `Nxx` opt-in output |

G8 and G9 receive no PR row: neither is unblocked, and G9 is `ROADMAP_ONLY`.
M4 receives no PR row: it is applied in repository settings by the owner.

## Corrections applied to the reconstruction

Recorded so the superseded readings are not reintroduced later.

1. **G9/P17 is `ROADMAP_ONLY` / `NEEDS_PROJECT_DECISION` with Canonical impact
   `NONE`.** Published Canonical already allows reduced one-/two-role checks to
   be reported separately and already states they do not redefine the Core3 gate.
   A future project decision about reduced-role quality does not automatically
   require a Canonical change. A new rules release is required only if the
   project introduces a new acceptance gate, changes Core3 semantics, or
   introduces new normative finalization requirements. The earlier reading that
   "P17 resolution requires a Canonical change" is superseded and is not encoded
   in this register.

2. **G8/P12 keeps the stricter named-song guardrail.** Synthetic fixtures may
   exercise generic regression mechanics, but synthetic evidence must not flip a
   named-song regression such as Rashisa/らしさ from `FIXTURE_PENDING` to `PASS`.
   A named-song `PASS` requires an executable, legally/source-permitted fixture
   that actually represents that named regression. Generic synthetic evidence is
   not the exit criterion for a named regression.

3. **G10 wording.** When G10 was open it was described as "a confirmed unenforced
   or partially unenforced published rule found by this audit". The earlier phrase
   "the only unenforced published rule" is withdrawn: the audit ran no exhaustive
   enforcement sweep across all published rules, so uniqueness was never
   evidenced. Closing G10 does not retroactively supply that sweep.

4. **M5 D2/D5 are provenance / authority design decisions.** This register does
   not assume that adding a Song History structure requires a `manifest_version`
   bump, and does not assume that absent identity pinning retroactively
   invalidates historical records. Whether the Published Manifest should
   reference a future history store, and whether that requires a Manifest
   revision, must be decided explicitly later.

A fifth correction arose from verification during this work and is recorded at
M2: the `README.md` 78-test figure was flagged as drift during reconstruction and
proved to be **correct** on direct measurement. No README change was made.
