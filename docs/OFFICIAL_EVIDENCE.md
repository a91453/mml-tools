# Official & Community Evidence Index

Version: 2026-09-13-draft1
Status: CANONICAL SUPPORTING EVIDENCE

This file records evidence used by the Canonical candidate. It is not itself a rule override.

## A. Official Nexon evidence

### A1 — Composition Guide
URL: https://mabinogimobile.nexon.com/Info/Guide/2751071
Current guide states:
- composition starts with 3 harmonies/roles and can expand to a maximum of 6;
- each harmony/role accepts up to 2,400 MML text characters;
- guide notes its game-state basis as 2025-12-18.

Evidence class: `OFFICIAL_CONFIRMED`.

### A2 — 2025-10-30 Update Notes
URL: https://mabinogimobile.nexon.com/News/Update/3201526
Composition section states the score editor was changed so that:
- Tempo is limited to 32–255;
- note/rest length is limited to 1–64;
- Volume is limited to 0–15;
- pitch is limited to 0–107;
- score-defined Tempo command behavior was improved for consistency.

Evidence class: `OFFICIAL_CONFIRMED`.

Important interpretation: `length 1–64` is a numeric range statement. It does not, by itself, prove that only powers of two are accepted.

### A3 — Instrument Performance Guide
URL: https://mabinogimobile.nexon.com/Info/Guide/2751072
States that there are instruments that play one note at a time and 3-harmony instruments that can play up to 3 notes at once.

Evidence class: `OFFICIAL_CONFIRMED`.

This supports a three-role single-player capability, but does not define project-specific roles such as Lead/Harmony/Bass.

## B. Nexon-hosted community evidence

### B1 — Score-making Guide (2025-09-13)
URL: https://mabinogimobile.nexon.com/Community/Tip/3137150
The author explicitly labels the guide as a subjective beginner workflow. It demonstrates:
- practical use of 1/64 editing and `r64/l64` in generated MML;
- a common three-part solo selection pattern: main melody, supporting part, bass;
- reports that multiple Tempo commands and non-power-of-two lengths can create timing/drift problems in the author's workflow/toolchain;
- reports same-pitch simultaneous-note swallowing in some conditions;
- historical 1,200-character information that predates the later official 2,400 limit and MUST NOT be treated as current.

Evidence class: `COMMUNITY_VERIFIED / HISTORICAL`, not official spec.

### B2 — Published Art-board works
Nexon Community Art posts have been observed using:
- plain 64th lengths;
- numeric-note (`nNN`) commands;
- non-power-of-two length denominators within the official 1–64 numeric range;
- three-role solo arrangements and larger ensemble arrangements.

Evidence class: `COMMUNITY_VERIFIED`.

Project implication: these examples are sufficient to reject blanket statements such as `Nxx is certainly unsupported` or `all non-power-of-two lengths are engine-illegal`, but they do not by themselves define universal guarantees or preferred canonical output.

## C. Evidence interpretation rules

1. Official documentation outranks community claims for documented limits.
2. New official updates supersede older community numeric limits.
3. Community successful use can disprove an unsupported blanket prohibition, but does not automatically prove all edge cases.
4. Tool behavior must not be confused with engine behavior.
5. In-game evidence on the target client remains necessary for unresolved edge semantics.
6. Project Final policy may intentionally be stricter than the engine for stability/auditability, but must be labeled as policy.

## D. Known corrections caused by this evidence

- Old `1200 characters per role` guidance is obsolete; current official value is 2400.
- Plain 64th lengths must not be rejected globally.
- Tempo 32–255 is official editor range, not merely a guessed safe profile.
- `48` cannot be called officially illegal solely because an older Studio contract rejected it.
- Nxx cannot be called categorically unsupported based only on the old Final profile.
- `O0–O8` is not currently supported as Nexon's official wording; official wording is pitch 0–107.
