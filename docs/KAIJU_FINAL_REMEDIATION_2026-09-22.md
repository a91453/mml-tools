# 怪獸之歌 / Kaiju — final remediation (2026-09-22)

Status: IMPLEMENTATION NOTES (not a Canonical rule source; publishes nothing)

Branch `claude/kaiju-final-remediation-sbth4h`, started from Published main
`ae15e5fc11eea5486d5f6c7fe3b243f9549168c2` (PR #64 merge). PR #64's Railway
audit/gate architecture is not touched.

## 0. Identities (kept separate; none substitutes for another)

| Identity | Value | How obtained |
| --- | --- | --- |
| `canonical_version` / status | `2026-09-13-v1` / `PUBLISHED` | Published main `docs/CANONICAL_MANIFEST.md` |
| `manifest_version` | `2026-09-13-v1-manifest1` | same |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` | same; verified as a full commit, ancestor of main; all six documents loaded from it with correct headers |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` | `git log -1 origin/main -- docs/CANONICAL_MANIFEST.md` on **full** history (a shallow clone returned the wrong `85c049c…`) |
| Repository main HEAD | `ae15e5fc11eea5486d5f6c7fe3b243f9549168c2` | `git rev-parse origin/main` |
| Production build / deployed source | `37ddf414ee90abfb78109dfc1e6a8a43cb85e35c` | `studio_capabilities` self-report (PR #63 merge; not independent Railway control-plane evidence) |
| Working-branch checkpoints / PR head | see §6 | Git |

`scripts/bootstrap-canonical.mjs --summary` → `CANONICAL_LOADED`.

Kaiju identities (full values re-read from production, never guessed):
project `prj_a808b53c7cafadaf4c6bf5f0fe4c370a`, run
`run_faf465f75ad72e943adba4832f88f931` (revision 16, `awaiting_review`),
candidate `g11d:rev:fc3c93547c09a668031005bbb67f96a88f109cc6e7f59a5cb0b2dbe5ddb75b63`,
baseline `bas:315eb13d5b82f81a3a20d72986514bb2ee4bc3e70304199f693037b8fb4d7c0d`,
selected source asset `ast_2ba293828d08c0c7e4b67240fb7dad28`
(`third_party_midi`, sha256 `5819c9c5…c23782`). All Studio access in this work was
read-only; zero writes.

## 1. Checkpoint A — microTiming

### A1. Reproduction (production evidence, machine-verified)

The source MIDI is not available in this environment. The candidate was rebuilt
instead from production read exports — all 1,545 baseline events (exact ids,
pitch, timing, voice) and the 298 accepted decisions — through the unchanged
Canonical IR intake → suggestion → decision application → review
(`scripts/studio-microtiming-audit.mjs`). The rebuilt micro-timing gate value is
**byte-identical** to production's:
`review.readiness.gates.microTiming` value SHA-256 `de4dc41b…d7df7`
(2,994,319 UTF-16 units) and `unknownIntervals` `23f23907…3cd3` both match the
service's `report_page` `value_sha256`. Receipt:
[microtiming-audit.json](evidence/kaiju-final-remediation-2026-09-22/microtiming-audit.json).

| Finding | Value |
| --- | --- |
| UNKNOWN intervals | 1,282 — all `inter-event-gap`, all exactly 1/480 beat (one source tick), all note→note |
| Role pairs | Melody 556 · Chord2 640 · Chord1 77 · Chord3 9 (Lead, Core3 and enrichment all affected) |
| Next onset | on the 1/64 safe grid in 1,282 / 1,282 |
| Previous note | duration + 1 tick is a grid multiple in 1,282 / 1,282 (239, 479, 719 … ticks) |
| Same-pitch repeated attacks across the gap | 296 (must remain two attacks) |
| Position | every song-position decile holds 112–155 intervals of the identical shape |
| **Whole source** | 1,545 / 1,545 onsets on grid; **1,544 / 1,545 releases exactly one tick before the grid**; the single exception (`0:1715`) ends on the grid |
| Release boundaries per role stream | 1,282 sub-grid gaps (reported) + **257 note→rest** boundaries where the rest is grid + 1 tick + **5** role ends (both **not** reported by the analyzer) |

Classification of the gaps against the prompt's hypotheses: not a parser/IR
round-trip artifact (event times reproduce the exported source ticks exactly);
not quantization residue of this pipeline (nothing here quantizes); not
evidence of intentional articulation in any source we hold (the only symbolic
source is class-C third-party MIDI; no primary score). It is a uniform
note-release encoding of the source MIDI — a *pattern observation*, not a
Canonical classification.

Consequence that was not visible before: resolving the 1,282 UNKNOWNs alone
would **not** make Kaiju emittable. The 257 off-grid rest boundaries and 5 role
ends have no exact Final decomposition either (the exact duration planner finds
no plan for 239/480, 241/480, 1441/480 … beats; with a 480-tick grid denominator
of 2⁵·3·5 none exists, since no admitted token carries a 2⁵ factor). The
emitter fails closed on them; readiness does not count them.

### A2. Does Published v1 decide it? — **No**

Published v1 forbids a meaning-free sub-1/64 micro-gap in Final
(`MOBILE_SYNTAX §4, §11.5`) and *permits* normalizing it (`MASTER_RULES §7`),
but leaves two decisions open (full analysis in the candidate document):

1. **Classification authority** — nothing says what evidence shows a
   note-preceded gap has *no* musical meaning when the only symbolic source is
   third-party (`SOURCE_POLICY §1`: official symbolic sources are the authority
   for duration; class C can prove neither meaning nor its absence).
2. **Transformation** — extending the release by 1/480 and truncating it to the
   previous grid point are both normalizations; moving the onset is forbidden;
   Gate 1 "exact timing preserved" is contradicted by both remaining options.

So no single unambiguous algorithm is authorised. The existing implementation
already refuses the note-preceded case (`TECHNICAL_TIMING_REPAIR.md §13`), and
that refusal is the Published-v1-compliant behaviour.

**Decision:** an **UNPUBLISHED CANONICAL CANDIDATE** —
[docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md](canonical-candidates/SUBGRID_RELEASE_OFFSET.md)
(`CANDIDATE-2026-09-22-SUBGRID-RELEASE-OFFSET`) — with rationale, evidence class
(`SOURCE_ENCODING_PATTERN`, machine-derived), precise scope (uniform whole-source
one-tick release offset), treatment (release + δ to the grid), exceptions, tie
semantics, meaningful-rest protection, regression and implementation impact, and
rollback. The Manifest is not changed.

Candidate implementation (inactive): `studio/backend/canonical/release-regrid-candidate.mjs`.
Published-v1 fail-closed guard: `enforceMicroGaps` now appends
`MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE` for any project carrying a candidate
marker (project or event level), so readiness and the Final emitter refuse it.
Unmarked projects' blocker lists are byte-identical to before.

Candidate-only evaluation on the reproduced Kaiju candidate: 1,544 releases
planned (1,282 gaps closed, 257 rests shortened by exactly one tick and still
≥ 1/64, 5 role ends), 0 refusals, 0 invariant violations, 0 remaining
micro-timing intervals; Published-v1 enforcement on the result: `PENDING`
(`MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE`).

A hypothetical emission (markers stripped, an assumed T150 added because the
export has no tempo map — **not a result**) serialises Melody/Chord1/Chord2/Chord3
at 1,096/816/1,472/671 characters but still `FAIL`s on Chord4: two very long rests
(179/2 and 96 beats) exceed the bounded exact duration search
(`DURATION_SEARCH_POLICY_LIMIT`). That is an independent Gate 1 blocker.

**Publication is required before Kaiju can pass Gate 1 / Final under this
candidate.** The no-rule-change alternative is a primary symbolic source for the
song that states the nominal durations.

### A3. Tests

`studio/tests/release-regrid-candidate.test.mjs` (`RRC-1`…`RRC-16`): true rest
survives; sub-grid rest refused; repeated same-pitch attacks survive untied
through emission; sustain vs re-attack; no onset crossing; no new same-pitch
overlap; non-uniform source and off-grid onset refuse the whole source; any keep
decision (accepted/pending/rejected) refuses; per-role Lead/Core3 ids, pitches
and onsets identical; emission round-trip and exact reversal; no double
application; invariant net; no drift on pattern-free projects. Seven deliberate
mutations were each caught. Existing micro-timing, repair, emitter and readiness
suites: 450/450 pass unchanged.

| Axis | Before | After checkpoint A |
| --- | --- | --- |
| microTiming (Published v1) | PENDING, 1,282 UNKNOWN, cause undocumented | **PENDING** (unchanged, correct); cause proven; scope corrected to 1,544 off-grid releases; Canonical decision required and drafted as an unpublished candidate |
