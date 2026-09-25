# Canonical-aware Final MML Emitter — implementation notes

Status: IMPLEMENTATION NOTES (not a Canonical rule source)
Implements: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`

This document describes an implementer. It defines no rule, publishes no
Canonical snapshot, and closes no `PENDING` item. Where it states a behaviour
that the published rule sources do not state, that behaviour is labelled an
**implementer policy** and is chosen to be strictly narrower than the rule, never
wider.

## 1. Where the emitter sits

```
 source intake ──► Canonical IR ──► arrangement/role candidates
                       │                        │
                       │                        ▼
                       │            candidate Canonical project
                       │                        │
                       ├────────────────────────┤
                       ▼                        ▼
        final/micro-gap-enforcement.mjs   final/mml-emitter.mjs   ◄── this PR
                       │                        │
                       ▼                        ▼
              final/readiness.mjs        six role bodies + `MML@…;`
```

Before this PR the repository could *read* MML (`mml/parser.mjs`) and convert it
into Canonical IR (`mml/canonicalize.mjs`), but nothing could *write* it. The web
delivery path (`studio/web/model.mjs`) only ever accepted an MML string the user
pasted and checked it back against the candidate. This PR supplies the missing
direction.

### A. Emitter input type

The **Canonical project** — the frozen object built by
`canonical/index.mjs#createCanonicalProject`. That is the same value
`enforceMicroGaps()` and `evaluateProjectReadiness()` already consume, so the
emitter can consult the G10 enforcement contract on the identical object rather
than on a re-derived view of it. No new candidate schema is introduced.

Canonical IR beats are **quarter notes**: `l4` is one beat, a whole note is `4`.
That is the convention `mml/parser.mjs` and `canonical/micro-timing.mjs` already
use (`SAFE_GRID = 4/64`), and the emitter inherits it rather than restating it.

### B. Field classification

| Field | Class |
| --- | --- |
| `event.pitch`, `event.start`, `event.end`, `event.kind` | source truth (via the baseline) |
| `event.sourceIds`, `event.sourceEventIds`, `event.metadata.timing` | source truth / provenance |
| `event.role`, `event.voice`, `event.volume` | derived musical decision |
| `tempoEvents[].beat`, `.bpm` | derived musical decision over source truth |
| `decisions[]` | derived musical decision |
| default-length (`lN`) plan, octave state, `<`/`>`/`oN` choice, enharmonic spelling, tie segmentation, rest segmentation | **Final-only serialization state** |

Everything in the third row is invented by the emitter and carries no musical
meaning: it must be freely re-choosable without changing a single parsed event.
That is exactly what the round-trip gate checks.

### C. Production modules that already exist (not rewritten here)

| Concern | Existing authority |
| --- | --- |
| exact rational arithmetic | `dist/core.js#F` / `f` (re-exported by `mml/index.mjs`) |
| MML parsing, Final syntax validation | `mml/parser.mjs#parseTrack` / `#validateMML` |
| six-slot `MML@…;` split contract | `mml/parser.mjs#splitMML` |
| pitch ↔ octave/note mapping | `mml/parser.mjs` (`12 * (octave + 1) + noteBase + accidental`) |
| character limit, tempo range, length ranges, dotted policy, octave/volume ranges | `rules/index.mjs#EFFECTIVE_RULESET.mobileSyntax` |
| sub-1/64 policy and the 1/64 grid | `canonical/micro-timing.mjs#SAFE_GRID`, `final/micro-gap-enforcement.mjs` |
| song readiness | `final/readiness.mjs` |

The emitter **reads** all of these. It re-implements none of them: there is no
second character counter, no second 1/64 threshold, no second pitch table, and no
second Final syntax rule set. The pitch mapping in particular is *derived from
the parser at load time* (`parserFacts()`) rather than transcribed, so the
inverse can never drift from the forward direction.

There was no pre-existing MML serializer, duration serializer, tempo serializer
or token emitter to reuse.

### D. PENDING items that constrain the emitter

| Item | Effect on this emitter |
| --- | --- |
| **P1** client character-count semantics | The emitter reports `characters` as a JavaScript string length and labels it `javascript-string-length`. It never claims client equivalence. The 2,400 budget comes from the one existing contract value. |
| **P2** tempo-map duplication across roles | The emitter *applies* the published `FINAL_CANONICAL_POLICY` (same complete map at the same positions on every non-empty role) and labels it a project policy, not engine law. It does not create a third tempo policy. |
| **P3** `Nxx` exact guarantees | The default emitter never emits `Nxx`. A pitch that ordinary notation cannot spell inside the octave mapping fails closed instead of silently switching to numeric notation. Opt-in numeric output is **not implemented**; P3 stays open. |
| **P4** arbitrary 1–64 length behaviour | Plain non-power-of-two lengths are *not* treated as illegal. They are `FINAL_ALLOWED_WITH_CAUTION`, so they enter the token lattice only under the explicit `cautionLengthOptIn` flag that `parseTrack` already defines. |
| **P5** dotted edge forms | Single dots only, only on bases `1, 2, 4, 8, 16, 32`; never `64.`, never `3. 6. 12. 24. 48.`, never multiple dots. Read from the contract, not hard-coded. |
| **P6** octave token mapping | Treated as an implementation mapping throughout. Named pitches above the official `0–107` range fail closed for Final rather than being re-spelled. P6 stays open. |
| **P10** drum mapping | Out of scope. The emitter serializes pitched events only and does not consult a drum profile. |
| **P16** `r64` / 64th behaviour | Plain `64` is inside the official range and is **not** banned. It is an ordinary member of the preferred lattice. |

`P7` (empty-role behaviour) also binds: empty roles are emitted as empty strings
and never receive filler tempo or rests.

## 2. Clean-room legacy inventory

A single legacy file, `mml-compress.js`, was read as `LEGACY_REFERENCE` for
algorithmic ideas only. Nothing was copied; no function, control flow or constant
was ported. The file is not committed.

### A — concept adopted, re-implemented from scratch

| Legacy idea | What it actually solves | How this PR does it |
| --- | --- | --- |
| memoized search over tie segments instead of greedy "largest first" | greedy is genuinely suboptimal: a two-token split can beat a single long token plus a long tail | `duration-plan.mjs` runs a memoized exact search over *rational* remainders, with a deterministic candidate order and explicit bounds |
| a token may be written with an empty length suffix when it equals the current default `lN` | the cheapest token is the one you do not write | the suffix cost function takes the current default length as an argument |
| plan the `lN` switch points rather than fixing one default | one default for a whole role is rarely optimal | DP over (event index × default length), candidates restricted to lengths that actually occur |
| octave state is a carried DP state, not a per-note greedy choice | the value of an enharmonic spelling is in what it saves *later* | DP over (attack index × octave), cost weighted by how many tie segments repeat the note name |
| enharmonic spelling at the octave boundary (`b+` for C, `c-` for B) | avoids an octave shift *and* avoids shifting back | verified against this repo's parser: `o3b+` and `o4c` both yield pitch 60 |
| bound the search with an explicit budget and fail rather than hang | an unbounded decomposition search is a denial-of-service on the caller | `budget` option; exhaustion is a structured fail-closed diagnostic, never a truncated answer |
| splitting a sustained note where a tempo change falls, as tied segments | a tempo token cannot appear inside a token | `planRoleTimeline()` cuts at tempo beats and marks the later pieces as continuations of the same attack |

### B — valuable but needed Canonical adaptation

| Legacy idea | Why it could not be taken as-is |
| --- | --- |
| round-trip comparison of emitted vs re-parsed events | legacy compares with `eps = 1e-6` float tolerance. Replaced with exact rational comparison; a float compare cannot distinguish `4/64` from `4/64 − 10⁻²⁰`. |
| "rewrite the track by parse → re-emit rather than by string surgery" | sound idea, but legacy's re-emit target set is its own `STD_NUMS`, which is not this project's Final policy. Re-derived from `EFFECTIVE_RULESET`. |
| merging adjacent rests into fewer tokens | legal here *because a rest carries no attack*, so it is a pure representation choice. Adopted only for representation, never to delete or move a rest. |

### C — this repository already has a better implementation

- exact rational arithmetic (`F`) — legacy converted everything to integer PPQ=480 ticks precisely *because* its own fraction model drifted. This repo's `F` is exact BigInt rational and needs no tick domain.
- syntax legality — `parseTrack` in `mode: 'final'` already encodes the published policy, including the caution and dotted rules.
- the 1/64 question — `micro-gap-enforcement.mjs` already answers it source-awarely.

### D — legacy-only, rejected

| Legacy element | Why rejected |
| --- | --- |
| `PPQ = 480`, integer tick domain, `lenTicks` | a tick grid is not Canonical and silently quantizes. All timing here stays exact rational. |
| `STD_NUMS` as the legal denominator set | MOBILE_SYNTAX §3 forbids calling a plain 1–64 length engine-illegal for being non-power-of-two. |
| `gameLegal` / `hasNonStdDenom` | same reason: it hard-rejects denominators the published rules explicitly protect. |
| `N_BASE`, `OCT_BASE`, `PITCH_MIN/MAX`, `foldIntoRange` | legacy pitch model. This repo derives the mapping from its own parser. |
| free use of `n<num>` for character savings | `Nxx` is `FINAL_ALLOWED_WITH_CAUTION` with opt-in plus evidence (P3). Never a compression device. |
| `OPT_RULES` = `fill` / `partial` / `release` | **lossy**: they absorb rests into notes or shorten notes to create breaths. That is arrangement, and MASTER_RULES §7 protects meaningful rests. |
| `repairItems` / `snap` / drift accounting | quantization and rounding toward a legal value. Forbidden; a duration the search cannot express means fail closed. |
| `trimToToken` | truncates a track to fit a character budget. That is silent musical deletion. |
| `maxDots` > 1, `l16.`-style dotted defaults | multiple dots are `FINAL_FORBIDDEN`; and this repo's parser does not accept a dot after `lN` at all (verified). |

## 3. Emitter contract

```js
import { emitFinalMml } from './studio/backend/final/index.mjs';

const result = emitFinalMml(canonicalProject, options);
```

`options` (all optional):

| Option | Meaning |
| --- | --- |
| `cautionLengthOptIn` | admit `FINAL_ALLOWED_WITH_CAUTION` plain lengths (1–64 outside the preferred set) into the token lattice. Default `false`. |
| `readiness` | a report from `evaluateProjectReadiness()`. When supplied, any blocking gate other than `technical` (which needs this emitter's own output) blocks emission. |
| `budget` | node budget for the duration search. Exhaustion fails closed. |
| `maxTieSegments` | maximum tie segments per attack. Exhaustion fails closed. |

Result — always a frozen plain object, never a thrown error for a musical or
policy outcome:

```js
{
  status: 'PASS' | 'FAIL' | 'PENDING',
  combinedMml: string | null,      // 'MML@a,b,c,d,e,f;'  — null unless PASS
  roles: [{ role, empty, mml, characters, attacks, ... }],
  characterCounts: { limit, unit: 'javascript-string-length', perRole, overBudget },
  microGap: { status, preservedIntervalKeys, rejectedIntervalKeys, blockedIntervalKeys, ... },
  roundTrip: { status, comparedFields, mismatches } | null,
  diagnostics: [{ code, severity, role?, ... }],
  canonical: { canonical_version, rules_snapshot_sha, ... },
  notice: '...'
}
```

`throw` is reserved for programmer error (a missing or non-object project). Every
representability, Canonical, evidence and budget outcome is a structured result.

### What `status: 'PASS'` does and does not mean

It means: the candidate was serialized exactly, the emitted string re-parses
under `mode: 'final'` with no errors, and the re-parsed semantics are
**exactly** equal to the candidate's. It is a `TECHNICAL_PASS`-class statement
plus round-trip evidence.

It does **not** mean the song is Canonical-compliant, source-complete, ready, or
accepted in game. `evaluateProjectReadiness()` remains the readiness authority,
and `IN_GAME_ACCEPTED` remains the user's to set. An emitter that succeeds has
verified an implementation, not certified a rule.

## 4. Representability policy

Two different things have to be kept apart here, and conflating them was a real
defect in an earlier revision of this document and of the code.

**The semantic notion.** A duration is Final-representable when it is an exact
sum of admitted token durations. That is a statement about arithmetic.

**What the implementation can establish.** `duration-plan.mjs` runs a *bounded*
search. When it returns a plan, that plan is exactly correct — the sum is checked
as exact rationals. When it returns nothing, that is a statement about the search
and its bounds, **not** a proof that no exact decomposition exists. The planner
has no completeness proof and does not claim one.

Both outcomes fail closed, so the safety property is unaffected either way;
what changes is only what the diagnostics are entitled to say. See
§4b for the failure taxonomy.

Admitted tokens are built from the executable contract:

- plain length `n`, duration `4/n` IR beats, for `n` in
  `preferredLengthDenominators` (`1 2 4 8 16 32 64`);
- plain length `n` for any other integer `n` in `officialLengthMin..officialLengthMax`
  — **only** when `cautionLengthOptIn` is set;
- single-dotted length `n`, duration `6/n` IR beats, for `n` in
  `preferredDottedBaseDenominators` (`1 2 4 8 16 32`).

Nothing else is emitted. In particular `64.`, `3.`, `6.`, `12.`, `24.`, `48.`,
any multiple dot, any zero duration, and any `Nxx` are never produced.

With the preferred lattice alone, the shortest token is `64` = `4/64` IR beats =
`SAFE_GRID`, so every admitted token is an exact multiple of the safe grid and no
emitted component can ever fall below it. This direction *is* provable: since
every admitted token is at least `SAFE_GRID` and all are positive, no sum of them
can be shorter than `SAFE_GRID`, which is why a G10-preserved sub-grid interval
is genuinely unrepresentable rather than merely unfound. Caution lengths do not
change this: every plain length is at most `64`, so the shortest token of any
lattice the emitter builds is `4/64` IR beats too
(`SHORTEST_ADMITTED_TOKEN_BEATS` in `micro-gap-enforcement.mjs`, derived from
`buildTokenLattice({ cautionLengthOptIn: true })`). G10 therefore raises
`MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE` for every preserved
interval instead of clearing it, and, since a role is written from beat 0, the
same bound means no role reaches any position after beat 0 and before
`SHORTEST_ADMITTED_TOKEN_BEATS` (§4b).

Everything else fails closed without such a proof. Nothing is ever rounded,
snapped, or approximated to the nearest legal token.

### Why the search is organised around the grid

Every preferred token is a whole number of 1/64 notes, because a plain
denominator divides 64 only inside the preferred set. So a grid-aligned
remainder minus a preferred token is still grid-aligned, and the reachable state
set collapses onto the grid and stays small. Every caution length is off-grid,
and admitting all 64 of them at every step instead explodes the state space into
arbitrary rationals — a plainly representable 7/16 beats burned a 200,000-node
budget and then poisoned every later plan sharing that search state.

Several deterministic bounds prevent that. None of them can make an emitted
duration *wrong* — everything returned is still an exact sum — but each of them
can make the search *miss* a decomposition that does exist:

- `maxTieSegments` (12) caps the segments in one decomposition. The longest
  preferred token is a dotted whole note, so a sustain longer than twelve of
  those is missed even though repeated whole notes express it exactly;
- `MAX_OFF_GRID_SEGMENTS` (3) caps the off-grid (caution) tokens in one
  decomposition. A triplet costs one;
- a grid-aligned remainder is decomposed with grid-aligned tokens only, so an
  answer that left the grid and came back is not considered;
- the node budget stops the search outright.

All are implementer policy for search cost, not rules, and all report a bounded
search result rather than approximating.

## 4b. Duration search failure taxonomy

The planner distinguishes three failures, because they mean different things:

| `planDuration` reason | Meaning | Emitter diagnostic |
| --- | --- | --- |
| `non-positive-duration` | The input is not a duration. Provable, and MOBILE_SYNTAX §4 makes zero duration `FINAL_FORBIDDEN` anyway. | `DURATION_NON_POSITIVE` |
| `budget-exhausted` | The node budget ran out mid-search. | `DURATION_SEARCH_BUDGET_EXHAUSTED` |
| `search-policy-limit` | The search finished within its bounds without finding an exact plan. | `DURATION_SEARCH_POLICY_LIMIT` |

`search-policy-limit` is deliberately **not** called "not representable", and
there is no diagnostic code that makes that claim about a duration. A duration
that is plainly an exact sum of admitted tokens lands in this bucket whenever
expressing it needs more segments, or more off-grid tokens, than the bounds
allow. Reporting that as mathematical impossibility would be an overclaim, and a
reader who believed it might go looking for a musical fix to a problem that is
only a search limit.

Every diagnostic in this family carries `completenessProven: false`.

One outcome is a proof, and it replaces either search code. When the span the
search failed on starts or ends at a position that
`canonical/release-timing.mjs#classifyPosition` calls `NOT_FINAL_REPRESENTABLE`,
the emitter reports `BOUNDARY_NOT_FINAL_REPRESENTABLE` with
`completenessProven: true`, the search's own `planFailure`, and the
`unreachableBoundaries`. A role is written as consecutive tokens from beat 0, so
every position it reaches is a sum of admitted token lengths, whose whole-note
denominator divides the lcm of the admitted token denominators; that position's
does not, so no bound, budget or `cautionLengthOptIn` changes the answer. It is a
claim about a position, never about a duration, and an off-grid position
`classifyPosition` calls `CAUTION_REPRESENTABLE` keeps the search's own code.
G10 already refuses positions of that kind before any serialization. It also
refuses the one position below the shortest token that the denominator test
misses. A role's earliest note (ties broken by event id) that starts after beat
0 and before `SHORTEST_ADMITTED_TOKEN_BEATS` (1/16 beat, 1/64 of a whole note)
is an `unsupportedBoundaries` entry with reason
`LEADING_SILENCE_SHORTER_THAN_ANY_FINAL_TOKEN` and coverage always `none`, and
raises the boundary code. The arithmetic: every position a role reaches is 0 or
a sum of at least one admitted token, and every admitted token lasts at least
1/16 beat, so no position in (0, 1/16) is reached whatever its denominator;
1/24 beat (1/96 of a whole note) passes the denominator test and is still never
reached. Only the earliest note needs this: any other position in (0, 1/16) a
role has to reach ends a span of that role shorter than the grid, which the
interval analyzer reports, and an onset `classifyPosition` already refuses keeps
its own `ONSET_NOT_FINAL_REPRESENTABLE` entry and is not listed twice. Its
coverage is `none` even when an analysed interval (a sub-grid leading rest)
ends there: it is an attack, no outcome of that interval moves it, and no hold
or repair shortens the silence before it. An onset
or rest boundary a role has to reach raises
`MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE` unless an analysed sub-grid
interval of the role starts or ends there and decides it. A note release no
release representation can move (one under a keep claim, or one with no valid
representation) raises the same code unless an analysed interval decides the
release itself: the note's own sub-grid duration, or the sub-grid gap after the
release. A sub-grid rest that starts at the release decides only the rest's
start, so it does not stand in for the release. An unreachable release a
representation can move raises `MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE`
unless such an interval decides it. The emitter reports the boundary refusal as
the same proof under its own code, `MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE`
(§5), and serializes nothing past a G10 that has not cleared. So
`BOUNDARY_NOT_FINAL_REPRESENTABLE` is left for positions G10 does not own, such
as an off-grid Tempo position that splits a span. What follows an unreachable
release that no interval decides changes G10's answer only through whether a
representation is valid for it. Under a keep claim it raises the boundary code
whether an explicit rest follows it, implicit silence follows it or the role
ends there. With no keep claim, an explicit rest starting at the release makes
both representations invalid (extending enters the rest, and truncating leaves
the rest's start where it is), so it raises the boundary code. After implicit
silence, or at the role end, it raises the release code when a representation
is valid (and G10 adds `MICRO_TIMING_RELEASE_PROVISIONAL` when the provisional
hold covers every open micro-timing question, ACCEPTANCE_CRITERIA "Delivered
first, flagged for listening"), and the boundary code only when neither
representation is valid for another reason.

A worked example, pinned by regression in both the planner and the production
`emitFinalMml` path: a 100-beat sustain is exactly 16 dotted whole notes plus one
whole note, so an exact decomposition demonstrably exists, yet the default
12-segment cap cannot reach it. The emitter fails closed and names it a
search-policy limit; raising only the bound makes the same candidate emit.

## 4a. What the emitter refuses

| Situation | Outcome |
| --- | --- |
| the bounded search finds no exact plan | `FAIL` — never rounded to the nearest token, and reported as a search-policy limit rather than as unrepresentability |
| duration search budget exhausted | `FAIL`, reported as a search limit rather than a proof of impossibility |
| a span the search failed on starts or ends at a position no admitted token sequence reaches | `FAIL` with `BOUNDARY_NOT_FINAL_REPRESENTABLE` — a proof about the position (§4b); the boundary is not moved |
| two notes overlap inside one role | `FAIL` — a role is one sequential voice; neither note is dropped or truncated |
| a note event carries no six-slot role | `FAIL` — the emitter does not choose a slot |
| a rest event carries no six-slot role | not a slot's material: a rest is silence, and one no role holds (a notated MusicXML rest carried from the baseline) is left out of the role streams, as the gaps of a MIDI source are; a rest a role holds is written as that role's rest |
| some notes in a role have a decided volume and some do not | `FAIL` — no level is invented for the rest |
| pitch above the official `0–107` range | `FAIL` — not re-spelled, and `Nxx` is not substituted (P3) |
| pitch with no ordinary spelling in the octave mapping | `FAIL` (P6) |
| tempo not an integer, or outside `T32–T255` | `FAIL` — never rounded or clamped |
| no tempo at beat 0, or two tempi on one beat | `FAIL` — nothing is invented or deduplicated here; the diagnostic names both values and sources. A tempo several sources state identically at one beat is already one event after the Canonical merge (`canonical/control-map.mjs`) |
| a tempo position falls past a non-empty role's end | `FAIL` — the role is **not** padded with filler rests (P2 / P14 stay open) |
| any role exceeds the 2,400-character budget | `FAIL` with role, count, overage and attack count — no note, attack or rest is removed |
| G10 reports confirmed technical residue | `FAIL` — unless `technicalTimingRepair` is opted into *and* the repair layer normalizes it exactly (§5a) |
| G10 reports unproven sub-grid material | `PENDING` — never acted on, with or without the repair opt-in |
| G10 reports an onset (including an onset after a leading silence shorter than any Final token), a rest boundary, or a note release no release representation can move (under a keep claim, or with no valid representation), that the role must reach and no admitted token sequence can (`MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE`) | `FAIL` with `MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE` — a proof, not unproven material, naming each boundary by role, event and beat (§5); no attack, rest or such release is moved to make it writable |
| G10 preserves source-supported sub-grid material (G10 itself is `PENDING` with `MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE`) | `FAIL` with `SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE` — provably unrepresentable (every admitted token is at least one safe-grid unit), and refusing is the only answer that does not damage it; the G10 code is kept out of `MICRO_GAP_BLOCKED_PENDING` |
| a supplied readiness report blocks on any gate but `technical` | `PENDING` |
| a pending arbitration decision exists | `PENDING` |
| the round-trip readback does not match | `FAIL` |

## 5. G10 consumption

The emitter calls `enforceMicroGaps(project)` and honours the three key lists and
the boundary list it publishes, without re-deriving any threshold:

- `preservedIntervalKeys` — source-supported sub-grid material. The emitter may
  not delete, shorten, quantize, absorb or move an attack across these. Because
  no admitted token is shorter than the grid, a preserved sub-grid interval is
  **not representable** — provably, since every admitted token is at least one
  safe-grid unit — so the emitter fails closed with
  `SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE` rather than damaging it. G10
  says the same thing itself: whenever this list is non-empty it raises
  `MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE`, keyed on the
  classification alone and never on coverage. That code alone makes G10
  `PENDING` (never `FAIL`), it stays visible beside a `FAIL`, it is `BLOCKING`
  under every machine-delivery schema, and the classification, the key lists
  and `finalRepresentable` (still `null`) are unchanged. ACCEPTANCE_CRITERIA
  Gate 2 keeps an unsupported source construct `PENDING/UNSUPPORTED`, not
  guessed, and rule 1 of "Machine delivery" keeps an open source-supported
  claim and anything else the micro-timing gate reports `BLOCKING`.
- `rejectedIntervalKeys` — confirmed technical residue. `enforceMicroGaps`
  returns `FAIL` for these and the emitter refuses to emit, unless Technical
  Timing Repair is opted into and normalizes them exactly (§5a). A correct
  refusal is still better than a guessed normalization, and the repair layer
  refuses rather than guessing wherever Canonical does not determine the
  transformation.
- `blockedIntervalKeys` — unproven. The emitter returns `PENDING` and emits
  nothing. The repair layer cannot reach these at all.
- `unsupportedBoundaries` — every onset or rest boundary that
  `classifyPosition` proves no admitted token sequence reaches, and each role's
  earliest onset after a silence shorter than any Final token
  (`LEADING_SILENCE_SHORTER_THAN_ANY_FINAL_TOKEN`, §4b), each with the
  `coverage` G10 decided it by. A boundary an analysed interval of its role
  starts or ends at (`analysed-interval`) is answered by that interval's outcome
  above, and every outcome of an analysed interval blocks (unproven is
  `PENDING`, residue `FAIL`, preserved raises
  `MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE`), so an
  `analysed-interval` entry never sits beside a G10 `PASS`. The coverage rules
  are asymmetric on purpose: an onset `classifyPosition` refuses keeps its
  coverage by interval (the interval's own answer blocks), while a leading-onset
  entry is always `none`; one at a release of its role that raises
  `MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE` (`release-target`) by the
  release-side handling; one inside a silence (`inside-silence`) needs nothing,
  because the silence is written as one exact span. The list also carries every
  note release at such a position that no release representation can move and
  nothing else decides, with coverage `none`: one under a keep claim (reason
  `RELEASE_UNDER_A_KEEP_CLAIM_NOT_FINAL_REPRESENTABLE`, target status
  `SOURCE_SUPPORTED_NOT_REPRESENTABLE`) or one whose every representation is
  invalid (`RELEASE_WITH_NO_VALID_REPRESENTATION`, target status
  `NO_VALID_REPRESENTATION`). Such a release is left out when an analysed
  interval decides the release itself — the note's own sub-grid duration,
  which ends at it, or the sub-grid gap after it, which starts at it — because
  that interval's outcome decides it and it is not reported twice. It is also
  left out when another entry already reports that position of its role with
  coverage `none` (an explicit rest starting at the release that no interval
  decides). An interval of another span at the same beat does not decide the
  release: a sub-grid rest that starts at the release decides the rest's start
  (`analysed-interval`), and the release is listed beside it with coverage
  `none` whether that rest's interval is preserved, unproven or technical
  residue. Neither kind of release raises the release code, and neither covers
  a boundary as `release-target`. So a release under a keep claim gets the same
  G10 answer whether an explicit rest follows it, implicit silence follows it,
  or the role ends there. A release with no keep claim is such an entry only
  while no representation is valid for it, which is always so when an explicit
  rest starts at it; after implicit silence or at the role end it usually has a
  valid representation and raises the release code instead (§4b). A boundary
  with coverage `none` makes G10 raise
  `MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE`. That is a proof, not
  unproven material, so the emitter keeps it out of
  `MICRO_GAP_BLOCKED_PENDING` (which keeps the other G10 blockers, if any) and
  returns `FAIL` with `MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE`: severity
  `error`, `completenessProven: true`, and `unreachableBoundaries` naming each
  boundary by role, event id, kind, boundary, beat and reason — at most 20, with
  `unreachableBoundaryCount` the true count and `unreachableBoundariesTruncated`.
  Its message states the arithmetic that applies: a position whose whole-note
  denominator does not divide the admitted lcm (beat 49/32 is 49/128 of a whole
  note, and it is 128 that fails, not 32), and, for a leading-onset entry, that
  no admitted token is shorter than 1/16 beat. It names at most 20 positions of
  each kind and counts the rest. Nothing is emitted, and no attack, rest or
  release is moved.

  Both G10 proof codes (`FINAL_REPRESENTABILITY_PROOFS`:
  `MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE` and
  `MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE`) are kept out of
  `MICRO_GAP_BLOCKED_PENDING`, which is raised only while an open blocker
  remains or no proof is present, so it never carries a proof and is never
  empty. A run names no operation for either
  (`READINESS_BLOCKER_WITHOUT_OPERATION`), and a request that carries only
  them lists no operation.

  **Scope.** A G10 `PASS` now means the emitter meets no micro-timing refusal
  G10 owns: no preserved interval, no unproven or residue interval, and no
  position a role has to reach that G10 can prove unreachable. Still outside
  G10, and disclosed: an off-grid Tempo position that splits a span (the
  serialization proof `BOUNDARY_NOT_FINAL_REPRESENTABLE`, which also depends on
  the `collapseTempoRestatements` option); caution positions the bounded search
  cannot decompose (`DURATION_SEARCH_*`, `completenessProven: false`, which
  `classifyPosition` calls representable in principle); and a candidate note
  whose timing drifted from its Source-Faithful origin without a release record
  (the release analysis reads the baseline's release, Layer A).

  `FAIL` rather than `PENDING`, because `PENDING` (severity `pending`) is
  reserved for an unresolved Canonical or evidence question and `error` is "this
  candidate cannot be Final-emitted as it stands". Nothing in this build answers
  this one: an onset is an attack and is never moved, no Mobile adaptation,
  decision or repair moves an onset or removes a rest, release representation
  refuses a release under a keep claim and every invalid option, the
  provisional hold only ever takes a valid extension, and the arithmetic
  depends on no search bound, budget or caution opt-in. (Omitting a note, or
  moving it to another role, changes which positions a role has to reach only
  by changing the arrangement; that is an arrangement decision on its own
  evidence, not an answer to this proof.) It is the same answer
  the emitter gives for the same proof met at serialization
  (`BOUNDARY_NOT_FINAL_REPRESENTABLE`) and for a preserved sub-grid interval.

  `MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE` deliberately stays `PENDING`
  under `MICRO_GAP_BLOCKED_PENDING`, and that holds only because G10 raises it
  for no other release than one awaiting a representation decision
  (`REPRESENTATION_DECISION_REQUIRED`): no keep claim covers it and at least one
  representation is valid for it. That release is an open decision, answered by
  an evidence-backed release representation
  (`applyMobileAdaptation.release_representation`), and under machine delivery a
  qualifying one may instead be held provisionally (ACCEPTANCE_CRITERIA
  "Delivered first, flagged for listening"). A release with no valid
  representation has neither answer — the representation is refused and the
  hold takes only a valid extension — so it is a boundary entry above, not a
  release code. For identical events, where no analysed interval decides the
  release itself, the emitter therefore answers `FAIL` for such a release
  whether a keep claim on it is accepted, pending, rejected or absent. Where a
  representation is valid, an accepted or pending keep claim takes it away
  (release representation refuses a claimed release), so that release is
  `FAIL` while the claim stands and `PENDING` once no claim covers it. G10's
  own status is `PENDING` for both codes; the boundary code is `BLOCKING` for
  machine delivery under every schema, and the release code is too unless the
  provisional hold covers it. The emitter status only says
  whether the candidate is waiting on an answer (`PENDING`) or cannot be
  written as it stands (`FAIL`). No operation in this build answers the
  boundary code either, so a run's microTiming review request says so in
  `missing` and names no operation when that code and the preserved-material
  code are all the gate carries (`READINESS_BLOCKER_WITHOUT_OPERATION` in
  `application/run-contracts.mjs`).
  A gate that also carries the release code keeps its hint, and release
  representation can answer every release that code stands for.

## 5a. Technical Timing Repair consumption

`emitFinalMml(project, { technicalTimingRepair: true })` is opt-in and defaults
to off, so the default path is byte-for-byte what §5 describes. Opt-in because
the repair transforms the musical candidate, and that must be a caller's explicit
decision rather than a side effect of asking for MML.

When it is on and G10 rejected something, `final/technical-timing-repair.mjs`
runs between the enforcement pass and the gates. The repaired candidate is used
only when the repair returns `PASS` **and** the same `enforceMicroGaps` re-grades
the repaired candidate clean **and** nothing preserved remains. "Clean" is
`PASS`, or `PENDING` whose only blocker is
`MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE`, with nothing rejected:
exactly where the re-grade would be `PASS` without that code
([TECHNICAL_TIMING_REPAIR.md](TECHNICAL_TIMING_REPAIR.md) §8). Otherwise nothing
changes: the original verdict stands and the refusal is recorded as
`TECHNICAL_TIMING_REPAIR_UNAVAILABLE`.

Repair never answers a gate — it only changes which candidate the gates are asked
about. A preserved interval still fails closed, unproven material still blocks, a
blocking readiness report still returns `PENDING`, and the character budget still
refuses without a note being dropped. The repair layer touches no note at all: a
technical hole whose preceding span is a **note** is refused rather than closed,
because extending that note's release is not proven neutral by anything the
Canonical IR carries. The round-trip gate compares against the
**repaired** semantics, because that is what the emitted string means; the
pre-repair timing stays in `result.technicalTimingRepair` and
`result.microGap.gradedProjectId` names which project the key lists describe.

Full design, refusal taxonomy and mutation table:
[TECHNICAL_TIMING_REPAIR.md](TECHNICAL_TIMING_REPAIR.md).

## 6. Determinism and idempotence

Every search has a fixed candidate order and improves only on strict `<`, so ties
resolve to the first candidate. The same project emits byte-identical output on
every run.

`projectFromFinalReadback()` rebuilds a Canonical project from the emitted
string's own parse, so `emit → parse → emit` can be asserted byte-identical.

## 7. Local mutation exercise

Ten deliberate mutations were applied by hand, the targeted suites run, the
catching test recorded, and the mutation reverted. **There is no committed
mutation harness**, so this is a *local mutation exercise* and not independently
reproducible mutation testing.

| # | Mutation | Caught by |
| --- | --- | --- |
| A | exact rational duration equality replaced with a float compare | 3 tests, incl. the 10⁻²⁰ pair whose doubles are equal |
| B | adjacent same-pitch notes merged into one tied note | 6 tests, first `adjacent same-pitch notes stay two distinct attacks` |
| C | a duration the search could not express rounded to the nearest legal token | 7 tests, incl. both fail-closed paths |
| D | G10 blocked/unproven intervals ignored and emitted anyway | `an unclassified micro-gap blocks Final output entirely` |
| E | G10 preserve guard removed, destroying source-supported material | `a source-supported sub-1/64 interval is never destroyed to make output` |
| F | round-trip enforcement branch deleted | `the Final gate itself refuses output whose readback does not match` |
| G | trailing notes dropped until the role fit the character budget | `a role one character over the limit fails, and deletes no music` |
| H | every non-power-of-two denominator treated as engine-illegal | 5 tests, incl. the 4/7-beat duration no tick grid can express |
| I | the six forbidden dotted forms admitted to the lattice | `the forbidden dotted forms are never admitted` |
| J | tempo positions moved to the nearest whole beat | `tempo positions round-trip exactly on a non-integer beat` |

F initially caught **nothing**: the enforcement branch was unreachable from
outside, because by construction the serializer never produces output that fails
its own gate. A redundant check that is never exercised has silently stopped
being a check, so the gate was extracted into `finalizeWithRoundTrip` and given
direct coverage. That is the one coverage gap this exercise found.
