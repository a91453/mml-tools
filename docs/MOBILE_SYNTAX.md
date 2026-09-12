# Mobile Syntax Policy

Version: 2026-09-13-draft1
Status: CANONICAL CANDIDATE

This file separates documented game limits from project output policy.

## 1. Evidence classes

- `OFFICIAL_CONFIRMED`: explicitly documented by Nexon.
- `COMMUNITY_VERIFIED`: observed in published community works/guides; not official spec.
- `FINAL_PREFERRED`: preferred canonical output form for stability/readability.
- `FINAL_ALLOWED_WITH_CAUTION`: may be usable, but requires stronger validation.
- `FINAL_FORBIDDEN`: project policy forbids it in final delivery even if the engine may parse it.
- `PENDING_IN_GAME`: unresolved engine/client behavior.

## 2. Official game limits currently confirmed

From Nexon official guide/update material:
- maximum composition roles: 6 (base 3, expandable to 6);
- per-role MML text: 2,400 characters;
- Tempo input range: 32–255;
- note/rest length numeric range: 1–64;
- Volume range: 0–15;
- pitch range: 0–107;
- instruments include 1-chord and up-to-3-chord instruments.

These are game/documented limits, not arrangement-role definitions.

## 3. Length denominators

The official update says note/rest length is limited to the numeric range `1–64`. It does **not** say the engine only accepts powers of two.

Therefore:
- plain lengths within 1–64 MUST NOT be labeled engine-illegal solely because they are non-power-of-two;
- plain `64` is explicitly within the official range and MUST NOT be globally rejected;
- `48` MUST NOT be described as an official engine prohibition without further evidence.

Community evidence shows both practices:
- some guides recommend 2/4/8/16/32/64 for drift/tool stability;
- published works can contain other values and numeric-note commands.

Canonical policy:
- `FINAL_PREFERRED`: simple stable lengths, especially 2/4/8/16/32/64 when musically exact enough;
- `FINAL_ALLOWED_WITH_CAUTION`: other plain integer lengths 1–64 when source timing requires them and validation confirms no drift/regression;
- never rewrite a source-supported rhythm merely to satisfy a preferred-denominator statistic.

## 4. Dots and microtiming

Single-dot notation on ordinary supported values is allowed when it represents the intended rhythm and stays inside the supported timing model.

`FINAL_FORBIDDEN`:
- multiple-dot shorthand such as `1..`, `2..`, `4..`, `8..`;
- dotted-triplet-like shorthand previously known to cause fragile/non-canonical output, including `3.`, `6.`, `12.`, `24.`, `48.` unless future in-game evidence explicitly promotes a specific form;
- zero-duration events;
- technical micro-gaps below the project's safe timing resolution when they have no musical meaning.

Preferred rewrite: exact equivalent canonical note/tie/rest decomposition that preserves timing and attacks.

## 5. Numeric note command (`Nxx` / `nNN`)

Community works demonstrate real use of numeric-note commands, so the project MUST NOT claim that the Mobile parser categorically lacks Nxx support.

However, engine capability and final-output policy are separate questions.

Current policy:
- parser capability: `COMMUNITY_VERIFIED`, exact range/client guarantees still not official;
- Final Canonical output: avoid Nxx by default when ordinary pitch notation can represent the same music cleanly;
- use Nxx only after explicit project decision and in-game/round-trip validation for the target piece.

Do not convert every Nxx source event automatically; preserve event identity in IR first.

## 6. Pitch / octave

Official evidence currently states pitch range `0–107`, not a canonical `O0–O8` wording.

Therefore any octave-token range in code is an implementation mapping and MUST be verified against the 0–107 pitch model. Do not cite `O0–O8` as Nexon's official wording unless separately documented.

## 7. Tempo

`T32–T255` is `OFFICIAL_CONFIRMED` for score editor input.

Multiple/mid-track Tempo commands are not automatically illegal, but have practical drift/history risk and require:
- exact Tempo Map agreement across source, preview and candidate;
- source-confirmed locations;
- actual player/readback when a player is used;
- song-specific timing validation.

Whether every non-empty track must duplicate the entire Tempo Map is `PENDING_IN_GAME`; until resolved, use the project's synchronization-safe policy for delivery and document it as policy, not official engine law.

## 8. Tie / attack semantics

`&` may join only the intended continuation of the same pitch. Do not use it to hide a repeated attack or to tie through a rest.

A syntax optimizer MUST preserve note-on identity.

## 9. Character counting

Official limit: 2,400 characters per role.

Exact client counter semantics versus Python/JavaScript string length remain `PENDING_IN_GAME`. Validators may report both raw and normalized counts but must not claim perfect client equivalence until verified.

## 10. Empty roles

Empty-role behavior and whether Tempo must be present on an empty role remain implementation/client details. Do not invent filler rests solely to satisfy validators.

## 11. Final canonicalization

Before user delivery:
1. preserve source attacks/rests;
2. remove shell/Markdown/track-label contamination;
3. enforce official numeric limits;
4. apply this project's forbidden-fragile syntax rules;
5. ensure no zero duration or non-musical technical micro-gap remains;
6. verify each role independently against the 2,400-character limit;
7. verify Tempo/meter/time alignment;
8. keep a reversible mapping from canonical output to source events/decisions.

Technical syntax PASS does not certify musical correctness or in-game acceptance.
