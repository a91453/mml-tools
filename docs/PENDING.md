# Pending / In-Game Verification Register

Version: 2026-09-23-v2
Status: PUBLISHED CANONICAL

Items here MUST NOT be promoted to confirmed engine behavior without new evidence.

## P1 — Client character-count semantics

Official limit is 2,400 MML characters per role. Exact client counting behavior versus Python/JavaScript `len()` and normalization remains unverified.

Needed evidence: controlled strings near the boundary on the target client.

## P2 — Tempo map duplication across roles

Official documentation confirms Tempo input range and notes improved consistency of Tempo commands, but does not state that every non-empty role must duplicate the entire Tempo Map.

Current Final delivery policy is defined in `MOBILE_SYNTAX.md`: every non-empty role carries the same initial Tempo and, for variable-Tempo songs, the same complete Tempo Map at the same musical positions. This is a synchronization-safe project policy, not an official engine-law claim.

Needed evidence: controlled multi-role tests with mid-song Tempo changes to determine whether a weaker rule is safe.

## P3 — Numeric-note (`Nxx`) exact guarantees

Community works demonstrate use, so parser capability is not reasonably described as absent. Official range/semantics and target-client edge behavior remain undocumented.

Current Final label is `FINAL_ALLOWED_WITH_CAUTION`: ordinary notation is the default output; paste-ready Nxx requires explicit project opt-in plus target-piece round-trip or in-game support.

Needed evidence: controlled Nxx range tests and round-trip/readback on the target client.

## P4 — Arbitrary 1–64 length behavior

Official editor range is 1–64. Community practice contains both arbitrary denominators and warnings that non-power-of-two values can drift or be rewritten by tools.

Needed evidence: controlled timing tests for representative denominators (3, 5, 6, 7, 9, 12, 19, 21, 24, 27, 38, 48, 64), with long-duration drift measurement.

Until then, distinguish `engine/editor range` from `Final preferred timing forms`.

## P5 — Dotted edge forms

Common binary-base single dots are supported as project Final syntax, but exact engine acceptance/stability of fragile forms such as `3.`, `6.`, `12.`, `24.`, `48.`, `64.` and multiple dots is not established by official specification.

Project Final policy is already single-valued: dotted fragile/non-preferred forms listed in `MOBILE_SYNTAX.md`, including `64.`, are not emitted in Final Canonical output pending stronger evidence. Engine capability remains a separate question.

## P6 — Octave token mapping

Official documentation states pitch range 0–107. The exact canonical relation between `O` tokens, note names, numeric pitch and edge pitches must be documented/tested before `O0–O8` is called an official rule.

## P7 — Empty-role behavior

Project Final policy leaves fully empty roles empty. Whether the client technically requires/ignores Tempo or rest filler in an empty harmony slot should be confirmed rather than assumed.

## P8 — Regional/client differences

Korean official sources are the strongest documented evidence currently used. Taiwan/HK/Macau client differences in parser/limits must be verified if observed.

## P9 — A/B two-score synchronization

Community practice demonstrates two independent six-role scores synchronized by performers, but exact join/leave/rejoin behavior and robust synchronization procedure require target-client testing.

## P10 — Mobile drum-face mapping

GM drum pitches are not ordinary pitched-output truth. Maintain an evidence-backed mapping for the target Mobile drum instrument(s); unsupported mappings remain `PENDING`.

## P11 — Same-pitch collision behavior

Community guides report swallowed notes when the same pitch is played simultaneously on the same instrument. Exact conditions across roles/instruments/sustain windows need controlled testing.

This remains a review signal, not an automatic delete rule.

## P12 — Historical regressions as fixtures

Rashisa/らしさ lead over-cleaning and other named song regressions are documented conceptually but not all source assets are committed as reproducible fixtures.

Required action: add legally usable/minimal synthetic or source-permitted regression fixtures before making claims that those named regressions themselves have passed.

Until then, reports must use `FIXTURE_PENDING` rather than claiming the named regression passed.

## P13 — Editor limits vs paste/playback parser limits

Official documentation confirms score-editor input limits such as Tempo 32–255 and note/rest length 1–64. It does not prove that every historical client/parser/playback path has exactly the same hidden acceptance boundary.

Project Final continues to obey the official editor limits regardless.

Needed evidence: controlled paste/playback tests only if behavior outside the editor path matters.

## P14 — Cross-role end-time / total-duration equality

The project must distinguish meaningful source rests/endings from accidental track truncation. Exact requirements for all non-empty roles ending at identical time versus musically intentional shorter roles are not yet formalized as a single rule.

Needed evidence: source-aware end-time comparison plus target-client synchronization tests. Do not pad meaningful silence merely to force numeric equality.

## P15 — All 15 cross-track sustained same-pitch pairs

For six roles there are 15 unordered role pairs. Current review tooling must demonstrate that sustained same-pitch overlap analysis actually covers all relevant pairs/windows; legacy text-only validation is insufficient proof.

Needed evidence: regression tests that exercise all 15 pair combinations and distinguish musically justified doubling from collision-risk cases.

## P16 — `r64` / 64th behavior across instruments

Plain 64 is inside the official editor length range and appears in community works. Instrument-specific audibility/stability of very short notes/rests can still differ in practice.

Needed evidence: representative target-client tests on relevant pitched/percussion instruments. This does not justify a blanket ban on plain 64.

## P17 — Reduced one-/two-role performance quality

Core3 is the canonical single-player three-chord target. When only one or two roles are actually performed, the expected degradation policy and validation gate are not yet fully formalized.

Needed evidence: song-level A/B and a project decision on what minimum musical completeness is expected for one-role and two-role situations. Do not weaken the Core3 gate while this remains pending.

## Resolved implementation drift — not pending rules

The following earlier audit items are now resolved in Studio code and are retained here only as history:

- **Former Studio documentation/audio-status drift:** original-audio alignment is implemented; module readiness is separate from song-specific audio evidence.
- **Former parser-policy drift:** ingest now preserves plain 1–64 caution values and Nxx; Final applies caution/opt-in policy instead of blanket input rejection.
- **Former Lead-readiness bypass:** a baseline Lead removal/role move now requires a matching PASS demotion report instead of being treated as `N/A`.

These resolved items MUST NOT be cited as current blockers or current parser behavior.
