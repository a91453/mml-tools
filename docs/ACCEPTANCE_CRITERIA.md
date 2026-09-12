# Acceptance Criteria

Version: 2026-09-13-v1
Status: PUBLISHED CANONICAL

A Mabinogi Mobile MML candidate becomes final only by passing layered gates. Passing one layer does not imply the next.

## Gate 0 — Intake / version identity

Required:
- target song/version identified;
- source recording version confirmed;
- start offset and effective music range known;
- source files inventoried;
- current candidate and accepted previous version identified when available.

Fail closed on silent version mixing.

## Gate 1 — Technical syntax

Required:
- six-role structure valid for the intended delivery;
- each non-empty role within the current official character limit;
- `OFFICIAL_GAME_LIMIT` numeric ranges enforced separately: Tempo, note/rest length, Volume, pitch, role count/character limit;
- `FINAL_CANONICAL_POLICY` enforced separately: forbidden fragile syntax, safe timing-grid rules, Nxx opt-in policy, synchronization-safe Tempo delivery policy;
- no zero duration;
- no shell/Markdown/label contamination in paste-ready output;
- exact timing and note-on identity preserved.

A numeric value being inside an official editor range does not automatically make every shorthand form using that number a preferred/allowed Final Canonical form.

Result: `TECHNICAL_PASS` only.

## Gate 2 — Source completeness / traceability

Required:
- a Source-Faithful Baseline SHALL exist before role cleanup, reduction, or Mobile adaptation is accepted;
- an equivalent source map is acceptable only if it is event-level and can enumerate Lead/T1 added, removed and moved events, other meaningful role moves, and pitch/onset/duration/prominence changes;
- important Lead, harmony, bass, counter/texture and form events are attributable to sources;
- candidate diff against the baseline is available;
- diff against the accepted previous version is available when one exists;
- removals, additions, role moves and pitch/onset/duration/prominence edits are explainable.

Unsupported source constructs remain `PENDING/UNSUPPORTED`, not guessed.

A prose-only source inventory or non-diffable checklist does not satisfy this gate.

## Gate 3 — Melody / Lead

Required:
- Lead continuity is recognizable and source-supported;
- instrumental Lead windows are classified;
- no `not proven Vocal -> demote` logic;
- natural rests/breaths are preserved;
- important hand-offs do not create false gaps;
- any Lead demotion has the evidence chain required by `SOURCE_POLICY.md`.

Melody failure blocks Chord/Full6 promotion to final.

## Gate 4 — Core3

Required:
- Melody + Chord1 + Chord2 form a musically complete one-player arrangement for a three-chord-capable instrument;
- Lead + Core Harmony + essential Bass/inner support are present;
- no severe unsupported register discontinuity or role pollution introduced by cleanup;
- Core3 remains intelligible without Chord3–Chord5.

Coverage metrics are diagnostic, not optimization targets.

Reduced one-/two-role performance checks may be reported separately, but they do not redefine the Core3 gate.

## Gate 5 — Full6 / cross-source arbitration

Required:
- Chord3–Chord5 enrich rather than damage Core3;
- same-pitch overlaps reviewed;
- low/mid m2/M7 and cross-source m9 risks reviewed;
- simultaneous 5/6-track attacks justified by source/music when retained;
- every meaningful source conflict has an explicit keep/omit/move/octave/redistribute/PENDING decision.

## Gate 6 — Tempo / duration / preview

When preview/verification assets are used:
- playback order fully expanded;
- independent Conductor used where applicable;
- exact bars/ties from confirmed meter;
- candidate follows the synchronization-safe delivery policy in `MOBILE_SYNTAX.md`;
- Tempo Map agrees with the source/candidate decision;
- duration sanity difference within project tolerance, with 2% used only as a warning threshold;
- loaded player state/readback is actual, not assumed.

`applied=true` or website playback does not pass this gate.

## Gate 7 — Original-audio evidence

Required when official audio is part of the source set:
- beat↔recording alignment evidence exists for relevant sections;
- role/prominence/sustain/articulation/recording-structure questions are reviewed;
- audio metrics do not overwrite symbolic event identity.

A globally implemented audio module does not pass this gate for a song automatically.

## Gate 8 — Mobile adaptation

Required:
- adaptations are minimal and evidence-backed;
- octave/register changes preserve role and musical identity;
- role moves preserve/re-arbitrate prominence rather than blindly inheriting destination volume;
- optimizations do not erase source-supported content;
- Final syntax follows `MOBILE_SYNTAX.md`.

## Gate 9 — Regression

Required:
- compare candidate to the Source-Faithful Baseline;
- compare candidate to the accepted previous version when available;
- detect unintended Lead/Core3/source drift;
- permanent historical regressions are checked when an executable/reproducible fixture exists;
- no previous accepted strength is removed without stronger evidence.

If a named regression such as Rashisa lead over-cleaning does not yet have an executable fixture in the repository, the report MUST state `FIXTURE_PENDING` and MUST NOT claim that named regression has passed.

## Gate 10 — In-game acceptance

Only the user or controlled target-client test can set `IN_GAME_ACCEPTED`.

Record when possible:
- client/region/version/date;
- instrument/role setup;
- exact pasted MML;
- screenshots/error text;
- audible issue and section;
- accepted/rejected outcome.

## Final state vocabulary

Allowed final report states:
- `PASS`
- `FAIL`
- `PENDING`
- `UNSUPPORTED`
- `N/A`

For the song as a whole, distinguish at least:
- `CANDIDATE`
- `VALIDATED` (all required non-game gates passed)
- `IN_GAME_ACCEPTED` (user/controlled client accepted)

Never infer `IN_GAME_ACCEPTED` from parser or player success.
