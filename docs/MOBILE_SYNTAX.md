# Mobile Syntax Policy

Version: 2026-09-22-v1
Status: PUBLISHED CANONICAL

This file separates documented game limits from project output policy.

## 1. Evidence classes

- `OFFICIAL_CONFIRMED`: explicitly documented by Nexon.
- `COMMUNITY_VERIFIED`: observed in published community works/guides; not official spec.
- `FINAL_PREFERRED`: preferred canonical output form for stability/readability.
- `FINAL_ALLOWED_WITH_CAUTION`: usable only under explicit project conditions and stronger validation.
- `FINAL_FORBIDDEN`: project policy forbids it in final delivery even if the engine may parse it.
- `PENDING_IN_GAME`: unresolved engine/client behavior.

## 2. Official game limits currently confirmed

From Nexon official guide/update material:
- maximum composition roles: 6 (base 3, expandable to 6);
- per-role MML text: 2,400 characters;
- Tempo editor input range: 32–255;
- note/rest length numeric range: 1–64;
- Volume range: 0–15;
- pitch range: 0–107;
- instruments include 1-chord and up-to-3-chord instruments.

These are documented editor/game limits, not arrangement-role definitions and not proof of every hidden playback/parser boundary outside the documented editing path.

## 3. Length denominators

The official update says note/rest length is limited to the numeric range `1–64`. It does **not** say the engine only accepts powers of two.

Therefore:
- plain lengths within 1–64 MUST NOT be labeled engine-illegal solely because they are non-power-of-two;
- plain `64` is within the official range and MUST NOT be globally rejected;
- plain `48` MUST NOT be described as an official engine prohibition.

Community evidence shows both practices:
- some guides recommend 2/4/8/16/32/64 for drift/tool stability;
- published works use other values and numeric-note commands.

Canonical Final labels:
- `FINAL_PREFERRED`: simple stable lengths, especially 1/2/4/8/16/32/64 when they reproduce the intended rhythm exactly;
- `FINAL_ALLOWED_WITH_CAUTION`: other plain integer lengths 1–64, including `48`, when source timing requires them and validation confirms no drift/regression;
- never rewrite a source-supported rhythm merely to satisfy a preferred-denominator statistic.

Code and validators MUST distinguish `engine/editor accepted range` from `project Final preference`.

## 4. Dots, safe timing grid and microtiming

Project safe timing resolution for Final Canonical decomposition is **1/64**. This is a `FINAL_CANONICAL_POLICY`, not a claim that the engine cannot internally parse finer timing.

Canonical single-dot policy:
- `FINAL_PREFERRED`: ordinary single-dot shorthand on bases `1, 2, 4, 8, 16, 32` when it preserves the intended rhythm;
- `FINAL_FORBIDDEN`: `64.`;
- `FINAL_FORBIDDEN`: dotted non-preferred/fragile bases, including `3.`, `6.`, `12.`, `24.`, `48.`;
- other dotted bases outside the preferred set MUST NOT be emitted in Final Canonical output; rewrite them to an exact canonical note/tie/rest decomposition.

Also `FINAL_FORBIDDEN`:
- multiple-dot shorthand such as `1..`, `2..`, `4..`, `8..`;
- zero-duration events;
- technical micro-gaps or decomposition components finer than 1/64 when they have no source-supported musical meaning.

Preferred rewrite: exact equivalent canonical note/tie/rest decomposition that preserves event timing and attack identity. The engine capability of forbidden dotted forms remains a separate `PENDING_IN_GAME` question.

## 5. Numeric note command (`Nxx` / `nNN`)

Community works demonstrate real use of numeric-note commands, so the project MUST NOT claim that the Mobile parser categorically lacks Nxx support.

Engine capability and final-output policy are separate questions.

Current labels:
- parser/input capability: `COMMUNITY_VERIFIED`; exact official range/client guarantees remain undocumented;
- Final Canonical output: `FINAL_ALLOWED_WITH_CAUTION` only.

Default Final behavior:
- preserve Nxx event identity when ingesting historical/community/source MML;
- normalize to ordinary pitch notation when it can represent the same event cleanly;
- retain Nxx in paste-ready Final only when the song/project manifest explicitly enables numeric-pitch output **and** target-piece round-trip or in-game validation supports it.

Therefore:
- an input parser MUST NOT hard-reject Nxx merely because the default Final emitter avoids it;
- a strict Final validator MAY reject Nxx when the explicit numeric-pitch opt-in/evidence is absent.

Do not convert every Nxx source event before event identity is preserved in IR.

## 6. Pitch / octave

Official evidence currently states pitch range `0–107`, not a canonical `O0–O8` wording.

Therefore any octave-token range in code is an implementation mapping and MUST be verified against the 0–107 pitch model. Do not cite `O0–O8` as Nexon's official wording unless separately documented.

## 7. Tempo and synchronization-safe delivery policy

`T32–T255` is `OFFICIAL_CONFIRMED` for score-editor input and is the project's Final numeric Tempo range.

Multiple/mid-track Tempo commands are not automatically illegal, but have practical drift/history risk and require:
- exact Tempo Map agreement across source, preview and candidate;
- source-confirmed change locations;
- actual player/readback when a player is used;
- song-specific timing validation.

Until controlled in-game tests prove a weaker requirement, `FINAL_CANONICAL_POLICY` for delivery is:
1. every non-empty role starts with the same initial Tempo value;
2. when Tempo changes during the song, every non-empty role carries the same complete Tempo Map at the same musical positions;
3. fully empty roles remain empty and are not given filler Tempo/rests solely for validators;
4. this duplication rule is a synchronization-safe project policy, **not** an official claim that the engine technically requires Tempo on every role.

Whether the client would remain synchronized with only one role carrying mid-song Tempo changes remains `PENDING_IN_GAME`.

## 8. Tie / attack semantics

`&` may join only the intended continuation of the same pitch. Do not use it to hide a repeated attack or to tie through a rest.

A syntax optimizer MUST preserve note-on identity.

## 9. Character counting

Official limit: 2,400 characters per role.

Exact client counter semantics versus Python/JavaScript string length remain `PENDING_IN_GAME`. Validators may report both raw and normalized counts but must not claim perfect client equivalence until verified.

## 10. Empty roles

Empty roles remain empty by default. Do not invent filler rests or Tempo solely to satisfy validators.

Exact client behavior around empty harmony slots remains `PENDING_IN_GAME`.

## 11. Final canonicalization

Before user delivery:
1. preserve source attacks/rests;
2. remove shell/Markdown/track-label contamination;
3. enforce `OFFICIAL_GAME_LIMIT` numeric ranges separately from project Final policy;
4. apply the explicit `FINAL_FORBIDDEN` / `FINAL_ALLOWED_WITH_CAUTION` rules above;
5. ensure no zero duration or non-musical technical micro-gap remains;
6. verify each role independently against the 2,400-character limit;
7. verify synchronization-safe Tempo policy, meter and time alignment;
8. keep a reversible mapping from canonical output to source events/decisions.

Technical syntax PASS does not certify musical correctness or in-game acceptance.


## 12. Generic machine-deliverable output and target-instrument adaptation

A paste-ready machine-deliverable MML does not require an invented instrument profile.

When no target-instrument profile is supplied:
- enforce the official global pitch/tempo/length/volume/role/character limits and all Final Canonical syntax rules;
- preserve the Source-Faithful register and prominence unless a source-backed transformation is required;
- do not infer instrument-specific audibility, range, octave displacement, or volume from model preference;
- report target-instrument Mobile adaptation/listening as `PENDING` when it has not been tested.

That `PENDING` is non-blocking when no instrument-specific transformation was necessary to make the MML legal and representable.

When a target instrument/profile is explicitly part of the requested delivery, a known range/representation conflict is blocking until a valid adaptation is produced. A model may propose the adaptation; Studio validates its legality, traceability and diff.
