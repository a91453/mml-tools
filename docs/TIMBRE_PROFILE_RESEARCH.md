# Timbre / Audibility Profile — format research

Status: RESEARCH NOTES — NOT CANONICAL, NOT EVIDENCE
Written under Canonical release `2026-09-13-v1`
(rules snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea`)

These are format-study notes for a possible future Timbre-Aware Reduction. They
are not a Canonical rule source, not `SUPPORTING_EVIDENCE` under
`SOURCE_POLICY.md`, and nothing recorded here may be used to keep, move, omit or
redistribute a source event, or to clear any `ACCEPTANCE_CRITERIA.md` gate.

## What was studied

A third-party DLS sound bank and its preset list, supplied as task attachments
and examined locally. The pack, its files and its metadata are deliberately not
described here.

**Neither file is committed to this repository**, and neither is required for
anything. G12 runs identically without them. The Final pipeline reads neither a
DLS nor a preset list. Studio Web's optional timbre preview plays only a bank
that each user selects locally, and that file stays in their browser.

## Why it cannot be evidence

The bank's own metadata describes it as a simulation, not the target Mabinogi
Mobile client's synthesis. Under `SOURCE_POLICY.md` this sits in class
**C / F** — third-party and community material, supporting evidence at most,
and only once independently confirmed. It is not class E in-game evidence, and a
third-party preset list is not an official Nexon specification.

Treating it as the client's timbre truth would be the `OFFICIAL_GAME_LIMIT` /
`FINAL_CANONICAL_POLICY` confusion `MASTER_RULES.md` §1 forbids, with a
third-party asset standing in for an official one.

## Structural findings

Read locally with a throwaway RIFF walker; no parser was added to the
repository. Only the findings that bear on a future profile are kept here.

- **Program numbering.** The preset list numbers programs from 1 and the DLS
  instrument header from 0; every named instrument agrees under that offset. A
  profile keyed on program identity has to say which convention it uses.
- **Pitched instruments** are multisampled with one velocity layer. The
  outermost zones are narrow catch-alls, the shape of a bank padding a range it
  was not sampled for, which says nothing about a usable register.
- **Percussion** uses one-key regions laid out per key, **not** a General MIDI
  drum map. This is consistent with `MASTER_RULES.md` §8: GM drum note numbers
  are not what a Mobile drum instrument expects, and mapping one to the other
  needs evidence this bank does not supply.
- **Articulation.** Every instrument carries the same single release-time
  connection and nothing else: no attack, decay, sustain, filter, LFO or
  velocity articulation. So the bank encodes **no per-instrument envelope
  differentiation at all**; any such character is inside the sample data. A
  `timbre.attack` / `.sustain` / `.decay` field populated from it would be
  populated from nothing.
- **Register.** The pitched zones span a wider range than the Published
  Canonical Mobile syntax range. That is an observation about a third-party
  file. It is **not** a finding about the client, not a proposed rule change,
  and nothing in the implementation reads it.

## What this does and does not support

Supported, today:

* the shape of a future profile — per-instrument program identity, per-zone key
  ranges, velocity layers, root keys, release time;
* the conclusion that **this file cannot populate** attack, decay, sustain,
  perceived loudness, spectral overlap or masking, because it does not contain
  them;
* the conclusion that a drum-face mapping cannot be derived from it either: a
  108-key face layout says where faces are, not which GM drum each is.

Not supported, and not claimed:

* that this pack's synthesis matches the target Mabinogi Mobile client;
* any usable/weak register claim for any instrument;
* any audibility, masking or separation claim;
* any reason to keep, move, omit or redistribute a single source event.

## The reserved interface

`studio/backend/reduction/index.mjs` exports `mml-studio/instrument-profile@1`
and `normalizeInstrumentProfile()`. The profile is optional and **provably
inert**: the reduction plan's identity, items, outcomes and blockers are all
computed before it is read, and a regression asserts two plans are equal with
and without one — including a profile asserting `verificationStatus: "VERIFIED"`.

`verificationStatus` is a claim by whoever supplied the profile, never a
verification this repository performed, and even `VERIFIED` buys nothing at this
stage. What it *would* buy is a Canonical question, not an implementation one.

```jsonc
{
  "schema": "mml-studio/instrument-profile@1",
  "instrumentId": "…",
  "targetClient": "…",
  "evidence": [],
  "verificationStatus": "UNVERIFIED",   // | PARTIAL | VERIFIED
  "pitch":    { "testedRange": [null, null], "usableRange": [null, null], "weakRegions": [] },
  "dynamics": { "volumeResponse": null },
  "timbre":   { "attack": null, "sustain": null, "decay": null }
}
```

## What a future Timbre-Aware Reduction would need first

1. Controlled target-client evidence (class E under `SOURCE_POLICY.md`): client,
   region, version, instrument, the exact MML pasted, and the audible result.
2. A stated equivalence claim between whatever profile source is used and that
   client, with the tests that establish it and the conditions under which it
   holds.
3. A Canonical decision about what such a profile is *allowed to prove* — it
   would still sit below source traceability, Lead and Core3 in
   `MASTER_RULES.md` §2, so at most it could rank suggestions and raise
   diagnostics. It could not, on its own, delete source material.

Until all three exist, the interface stays diagnostic-only. That is a rule gap
in the sense that Canonical has not spoken on timbre evidence — and it is
correctly handled by doing nothing, so no rule-change proposal is raised.
