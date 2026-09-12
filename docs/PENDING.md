# Pending / In-Game Verification Register

Version: 2026-09-13-draft1
Status: CANONICAL CANDIDATE

Items here MUST NOT be promoted to confirmed engine behavior without new evidence.

## P1 — Client character-count semantics

Official limit is 2,400 MML characters per role. Exact client counting behavior versus Python/JavaScript `len()` and normalization remains unverified.

Needed evidence: controlled strings near the boundary on the target client.

## P2 — Tempo map duplication across roles

Official documentation confirms Tempo input range and notes improved consistency of tempo commands, but does not state that every non-empty role must duplicate the entire Tempo Map.

Current delivery may use a synchronization-safe duplication policy, but it must be labeled project policy.

Needed evidence: controlled multi-role tests with mid-song Tempo changes.

## P3 — Numeric-note (`Nxx`) exact guarantees

Community works demonstrate use, so parser capability is not reasonably described as absent. Official range/semantics and target-client edge behavior remain undocumented.

Needed evidence: controlled Nxx range tests and round-trip/readback on target client.

## P4 — Arbitrary 1–64 length behavior

Official editor range is 1–64. Community practice contains both arbitrary denominators and warnings that non-power-of-two values can drift or be rewritten by tools.

Needed evidence: controlled timing tests for representative denominators (3, 5, 6, 7, 9, 12, 19, 21, 24, 27, 38, 48, 64), with long-duration drift measurement.

Until then, distinguish `engine/editor range` from `Final preferred timing forms`.

## P5 — Dotted edge forms

Single-dot common forms are widely used, but exact acceptance/stability of fragile forms such as `3.`, `6.`, `12.`, `24.`, `48.`, `64.` and multiple dots is not established by official specification.

Project Final forbids fragile forms pending evidence.

## P6 — Octave token mapping

Official documentation states pitch range 0–107. The exact canonical relation between `O` tokens, note names, numeric pitch and edge pitches must be documented/tested before `O0–O8` is called an official rule.

## P7 — Empty-role behavior

Whether empty roles need any Tempo/rest filler and how the client treats fully empty harmony slots should be confirmed rather than assumed.

## P8 — Regional/client differences

Korean official sources are the strongest documented evidence currently used. Taiwan/HK/Macau client differences in parser/limits must be verified if observed.

## P9 — A/B two-score synchronization

Community practice demonstrates two independent six-role scores synchronized by performers, but exact join/leave/rejoin behavior and robust synchronization procedure require target-client testing.

## P10 — Mobile drum-face mapping

GM drum pitches are not ordinary pitched-output truth. Maintain an evidence-backed mapping for the target Mobile drum instrument(s); unsupported mappings remain `PENDING`.

## P11 — Same-pitch collision behavior

Community guides report swallowed notes when the same pitch is played simultaneously on the same instrument. Exact conditions across roles/instruments/sustain windows need controlled testing.

This remains a review signal, not an automatic delete rule.

## P12 — Studio documentation drift

`docs/RULES_AUDIT_2026-09-13.md` states original-audio alignment as the remaining global implementation blocker, while `studio/backend/rules/index.mjs` currently has `STUDIO_IMPLEMENTATION.originalAudioAlignment = true`.

Required action after Canonical review: update audit/status language and keep song-specific audio evidence requirements separate from module-existence readiness.

## P13 — Studio parser policy drift

Current `studio-v1` executable contract hard-rejects `48` and Final `Nxx`. New evidence requires review:
- `48` must not be claimed officially illegal merely from the old contract;
- Nxx community parser capability must be acknowledged;
- final-policy decisions must follow accepted Canonical docs.

Do not patch code until this Canonical branch is reviewed.

## P14 — Historical regressions as fixtures

Rashisa/らしさ lead over-cleaning and other named song regressions are documented conceptually but not all source assets are committed as reproducible fixtures.

Required action: add legally usable/minimal synthetic or source-permitted regression fixtures before making Studio merge readiness claims based on them.
