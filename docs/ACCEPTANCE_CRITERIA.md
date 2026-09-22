# Acceptance Criteria

Version: 2026-09-22-v1
Status: PUBLISHED CANONICAL

A Mabinogi Mobile MML candidate becomes machine-deliverable when Studio can emit a paste-ready artifact that clears every machine-delivery blocker below. Gate statuses remain independent: a non-blocking musical/evidence question may stay `PENDING` and MUST be reported rather than rewritten as PASS.

Human listening and target-client acceptance are post-delivery quality records. They can create a later revision, but they are not prerequisites for a machine-deliverable artifact.

## Gate disposition model

Every gate result carries one of these delivery effects in addition to its ordinary `PASS` / `FAIL` / `PENDING` / `UNSUPPORTED` / `N/A` status:

- `BLOCKING`: no paste-ready Final artifact may be emitted.
- `NON_BLOCKING_PENDING`: the question remains unresolved, but a conservative Source-Faithful and technically valid artifact may be emitted with the pending item recorded.
- `POST_DELIVERY`: the check is evidence/quality history for an already machine-deliverable artifact.

The same gate may be blocking or non-blocking depending on whether the unresolved fact is necessary to make a destructive choice. Studio must explain the disposition; it may not turn missing evidence into PASS.

## Gate 0 — Intake / version identity

Required:
- target song/version identified;
- source recording version confirmed when recordings are used;
- start offset and effective music range known when required by the source;
- source files inventoried;
- current candidate and accepted previous version identified when available.

Silent version mixing is `BLOCKING`.

## Gate 1 — Technical syntax

Required:
- six-role structure valid for the intended delivery;
- each non-empty role within the current official character limit;
- `OFFICIAL_GAME_LIMIT` numeric ranges enforced separately: Tempo, note/rest length, Volume, pitch, role count/character limit;
- `FINAL_CANONICAL_POLICY` enforced separately: forbidden fragile syntax, safe timing-grid rules, Nxx opt-in policy, synchronization-safe Tempo delivery policy;
- no zero duration;
- no shell/Markdown/label contamination in paste-ready output;
- exact timing and note-on identity preserved;
- Final readback/round-trip agrees with the emitted artifact.

Violations are `BLOCKING`. Result `TECHNICAL_PASS` says only that this gate passed.

## Gate 2 — Source completeness / traceability

Required for machine delivery:
- a Source-Faithful Baseline exists before role cleanup, reduction, or Mobile adaptation;
- the baseline/equivalent source map is event-level and can enumerate Lead/T1 added, removed and moved events, other meaningful role moves, and pitch/onset/duration/prominence changes;
- candidate diff against the baseline is available;
- diff against the accepted previous version is available when one exists;
- every destructive or identity-changing transformation is traceable.

A missing/non-diffable baseline, broken source identity, or unexplained source-supported deletion/replacement is `BLOCKING`.

A role classification that remains uncertain may be `NON_BLOCKING_PENDING` only when the artifact preserves the safer Source-Faithful material and no destructive decision depends on the unresolved classification.

## Gate 3 — Melody / Lead

Studio evaluates what can be established from stored source identity, role evidence, continuity, diffs and accepted decisions. A model may propose a role; it does not author the gate verdict.

Required:
- no source-supported Lead is silently erased;
- instrumental Lead windows and hand-offs are preserved when source-supported;
- natural rests/breaths are preserved;
- any actual Lead demotion/promotion is backed by the evidence chain required by `SOURCE_POLICY.md`, or reverted/preserved conservatively.

If positive evidence for a destructive Lead move is missing, Studio must prefer the Source-Faithful Lead when that fallback is legal. The gate then remains `PENDING` / `NON_BLOCKING_PENDING`; it is not PASS.

If the candidate has already destroyed or reassigned Lead material and cannot be safely reverted/preserved, the gate is `BLOCKING`.

## Gate 4 — Core3

Core3 remains the one-player three-chord target, but its review status is not allowed to hide a separate valid Full6 artifact.

Studio evaluates:
- Lead + Core Harmony + essential Bass/inner support presence;
- continuity and unsupported register/role changes;
- whether Melody + Chord1 + Chord2 stand up independently.

For a delivery explicitly targeting a three-role instrument, incomplete Core3 is `BLOCKING`.

For a generic six-role machine-deliverable artifact, unresolved Core3 completeness may be `NON_BLOCKING_PENDING` when all source-supported material remains represented in Full6, the artifact is legal, and no source material was dropped merely to improve the Core3 metric.

## Gate 5 — Full6 / cross-source arbitration

Required:
- Chord3–Chord5 enrich rather than silently replace Core3/source material;
- same-pitch overlaps, low/mid m2/M7 and cross-source m9 risks are computed/reported;
- simultaneous 5/6-track attacks are surfaced;
- source conflicts are accounted for as keep/omit/move/octave/redistribute/PENDING.

Review signals are not automatic deletion targets.

An unresolved musical tension is `NON_BLOCKING_PENDING` when the safer action is to retain the traceable source-supported material and the output remains legal. Reduction that cannot fit the intended six roles without unexplained loss is `BLOCKING`.

## Gate 6 — Tempo / duration / preview

Machine-delivery requirements:
- playback order expanded where the source uses navigation;
- exact meter/form and Tempo Map used by the candidate are known;
- synchronization-safe delivery policy in `MOBILE_SYNTAX.md` is satisfied;
- timing is representable under Final Canonical policy;
- emitted MML round-trips without changing note-on identity or timing.

These are `BLOCKING`.

A separate player/listening readback is `POST_DELIVERY` unless that player is the only available evidence for a fact the candidate depends on. `applied=true` or website playback never creates a PASS by itself.

## Gate 7 — Original-audio evidence

When official audio is available, Studio may use stored alignment/analysis to locate role, prominence, sustain, articulation and structure questions. Audio metrics never overwrite symbolic event identity.

Missing or unreviewed original-audio evidence is `NON_BLOCKING_PENDING` when:
- symbolic/source traceability is complete;
- recording version identity is not in dispute; and
- no destructive decision depends on an audio-only claim.

It is `BLOCKING` when the recording version is unresolved or an otherwise unsupported destructive choice requires audio evidence and no conservative Source-Faithful fallback exists.

Human listening of the delivered artifact is `POST_DELIVERY`.

## Gate 8 — Mobile adaptation

Machine-delivery requirements:
- official limits and Final syntax are satisfied;
- global pitch/register representation is legal;
- role moves/octave/register changes, when applied, remain traceable;
- optimizations do not erase source-supported content.

If no target-instrument profile is supplied and no instrument-specific transformation is needed, instrument-specific audibility/range review is `NON_BLOCKING_PENDING`; Studio must not invent a profile.

If a target instrument/profile is explicitly part of the requested delivery and a known conflict exists, adaptation is `BLOCKING` until resolved.

## Gate 9 — Regression

Machine checks required:
- compare candidate to the Source-Faithful Baseline;
- compare candidate to the accepted previous version when available;
- detect unintended Lead/Core3/source drift;
- account for removals and transformations;
- run any available executable named regression fixtures.

Unexplained destructive drift is `BLOCKING`.

Subjective A/B listening is `POST_DELIVERY`. If a named regression fixture does not exist, report `FIXTURE_PENDING`; do not claim it passed. Absence of that fixture alone does not block an otherwise machine-deliverable artifact.

## Gate 10 — Human / in-game post-delivery acceptance

Neither human listening nor in-game acceptance is a machine-delivery gate.

Optional human review may record:
- exact artifact/candidate;
- listening setup;
- audible issue/section;
- accepted/rejected notes.

Only the user or controlled target-client test can set `IN_GAME_ACCEPTED`. Record when possible:
- client/region/version/date;
- instrument/role setup;
- exact pasted MML;
- screenshots/error text;
- audible issue and section;
- accepted/rejected outcome.

A negative post-delivery result should create a new candidate/revision rather than retroactively falsify the audit trail of the artifact that was tested.

## Final state vocabulary

Gate/report statuses:
- `PASS`
- `FAIL`
- `PENDING`
- `UNSUPPORTED`
- `N/A`

Song lifecycle:
- `CANDIDATE`
- `AUTOMATED_VALIDATED` — every machine-delivery blocker cleared and a paste-ready artifact emitted; may include explicitly listed non-blocking PENDING items.
- `HUMAN_REVIEWED` — optional human listening/review attached to the exact artifact/candidate.
- `IN_GAME_ACCEPTED` — optional controlled target-client acceptance attached to the exact MML.

Never infer `HUMAN_REVIEWED` or `IN_GAME_ACCEPTED` from parser, model, player, or backend success.
