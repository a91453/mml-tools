# Timbre / Audibility Profile — format research

Status: RESEARCH NOTES — NOT CANONICAL, NOT EVIDENCE
Canonical release in force: `2026-09-13-v1`
Rules snapshot: `0a172900a01fdf39c2e9e84cf176961320b779ea`

These are format-study notes for a possible future Timbre-Aware Reduction. They
are not a Canonical rule source, not `SUPPORTING_EVIDENCE` under
`SOURCE_POLICY.md`, and nothing recorded here may be used to keep, move, omit or
redistribute a source event, or to clear any `ACCEPTANCE_CRITERIA.md` gate.

## What was studied

A DLS sound pack supplied as a task attachment, together with its `.def`
preset list: a RIFF/DLS Level 2 bank of about 15 MB and a UTF-8
preset/localization list. The pack is deliberately not named here.

**Neither file is committed to this repository**, and neither is required for
anything. G12 runs identically without them. The Final pipeline reads neither a
DLS nor a `.def`. Studio Web's optional timbre preview plays only a bank that
each user selects locally, and that file stays in their browser.

## Why it cannot be evidence

The pack's own `INFO` metadata describes it as a simulation that differs from
the original, not as the client's own sound source.

So by its own description it is a **simulation**, not the target Mabinogi Mobile
client's synthesis. Its `INFO` metadata also records that the samples were
edited in a third-party audio editor. Under `SOURCE_POLICY.md` this sits in
class **C / F** — third-party and community material, supporting evidence at
most, and only once independently confirmed. It is not class E in-game evidence,
and a third-party `.def` is not an official Nexon specification.

Treating it as the client's timbre truth would be the `OFFICIAL_GAME_LIMIT` /
`FINAL_CANONICAL_POLICY` confusion `MASTER_RULES.md` §1 forbids, with a
third-party asset standing in for an official one.

## Structural findings

Read with a throwaway RIFF walker; no parser was added to the repository.

| Fact | Value |
| --- | --- |
| Top-level chunks | `colh`, `LIST/lins`, `ptbl`, `LIST/wvpl`, `LIST/INFO` |
| `colh` instrument count | 128 |
| Instruments actually named | 11 |
| Remaining slots | 117, all named `(Not Used)N`, one full-range region each |
| Wave pool | 42 samples |
| Region chunk shape | `rgnh` + `wsmp` + `wlnk` (no per-region `lart`) |
| Articulation | one instrument-level `lar2`/`art2` per instrument |

### Program mapping

The `.def` `Program No.` column is 1-based; the DLS instrument header is
0-based. Every named instrument agrees under that offset:

| `.def` name | `.def` Program No. | DLS program | Regions | Key range |
| --- | --- | --- | --- | --- |
| Lute | 1 | 0 | 7 | 24–119 |
| Mandolin | 3 | 2 | 7 | 24–119 |
| Flute | 6 | 5 | 7 | 24–119 |
| Chalumeau | 7 | 6 | 8 | 24–119 |
| Piano | 22 | 21 | 7 | 24–119 |
| Violin | 23 | 22 | 7 | 24–119 |
| Harp | 25 | 24 | 7 | 24–119 |
| Music Box | 31 | 30 | 8 | 24–119 |
| BassDrum | 67 | 66 | 108 | 12–119 |
| Cymbals | 69 | 68 | 108 | 12–119 |

All instruments declare bank 0 / MSB 0 / LSB 0. The `.def` carries localized
names for Japanese (1041), Korean (1042) and Traditional Chinese (1028).

### Pitched instruments

Seven or eight multisample zones spanning key 24–119, one velocity layer each
(`0–127`), with root keys spread across the range — e.g. Flute
`[24–27, 28–39, 40–74, 75–86, 87–100, 101–112, 113–119]` with roots
`50, 62, 74, 75, 87, 99, 111`. The outermost zones (24–27 and 113–119) are
single narrow catch-alls, which is the shape of a pack padding the edges of a
range it was not sampled for rather than a statement about a usable register.

### Percussion instruments

`BassDrum` and `Cymbals` carry 108 one-key regions across 12–119, each with its
own root key — a per-key face layout, **not** a General MIDI drum map. This is
consistent with `MASTER_RULES.md` §8: GM drum note numbers are not what a Mobile
drum instrument expects, and mapping one to the other needs evidence this pack
does not supply.

### Articulation

Every named instrument carries exactly one `art2` connection block, and every
one of them is the same: `CONN_DST_EG1_RELEASETIME` ≈ −967.1 timecents ≈
**0.572 s release**. There is no attack, decay, sustain, filter, LFO or
velocity-to-attenuation articulation anywhere in the file.

So the pack encodes **no per-instrument envelope differentiation at all**. Any
attack/decay/sustain character is inside the sample data, not in metadata a
profile could read. A `timbre.attack` / `.sustain` / `.decay` field populated
from this file would be populated from nothing.

### Register note

The pitched zones span MIDI 24–119, while the Published Canonical Mobile syntax
range is narrower. That difference is recorded here as an observation about a
third-party file. It is **not** a finding about the client, not a proposed rule
change, and nothing in the implementation reads it.

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
