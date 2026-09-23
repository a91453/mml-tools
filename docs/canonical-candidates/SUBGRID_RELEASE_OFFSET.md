# UNPUBLISHED CANONICAL CANDIDATE — Sub-grid systematic release offset

Candidate id: `CANDIDATE-2026-09-22-SUBGRID-RELEASE-OFFSET`
Status: **UNPUBLISHED CANONICAL CANDIDATE** — not a Canonical rule source, not
indexed by `docs/CANONICAL_MANIFEST.md`, not active in any release.
Based on: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`.
Change-control route: `MASTER_RULES.md §12` (explicit rationale, evidence class,
regression impact; executable-contract changes only after the prose is accepted).

This file proposes a rule. It publishes nothing. Until a reviewed release adds
it to the Manifest's rule sources, **Published v1 behaviour is unchanged and
fail-closed**: the micro-timing gate stays `PENDING`, and any project produced by
the candidate implementation is refused by Published-v1 micro-gap enforcement,
readiness and the Final emitter (`MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE`).

## 1. The question Published v1 does not decide

A third-party MIDI source encodes every note-off exactly one source tick before
its nominal position. In the Canonical IR this becomes, for each note, a release
`δ` (`0 < δ < 1/64` whole note) before a safe-grid point. Two shapes follow:

- the next same-role onset is on that grid point → a sub-grid **note-preceded
  inter-event gap** of length `δ` (the micro-timing analyzer reports it `UNKNOWN`);
- a real rest follows → the rest is `δ` longer than a grid length, and the note
  duration is `δ` shorter; neither has an exact Final decomposition, but the
  analyzer does not report it, because no interval is shorter than 1/64.

What Published v1 says:

| Source | Text | What it settles |
| --- | --- | --- |
| `MOBILE_SYNTAX §4` | sub-1/64 technical micro-gaps / decomposition components *without source-supported musical meaning* are `FINAL_FORBIDDEN`; preferred rewrite preserves event timing and attack identity | The gap must not reach Final **if** it is technical. No exact on-grid rewrite exists, so the preferred rewrite is unavailable. |
| `MOBILE_SYNTAX §11` steps 1, 5, 8 | preserve source attacks/rests; no non-musical technical micro-gap remains; reversible mapping | Obligations, not a transformation. |
| `MASTER_RULES §7` | meaningful rests/articulation preserved; technical micro-gaps *may be normalized* | A permission. It does not choose among rewrites. |
| `ACCEPTANCE_CRITERIA` Gate 1 | *exact timing* and note-on identity preserved | Cuts against every rewrite of a release. |
| `SOURCE_POLICY §1` A/C | official symbolic sources are the primary authority for onset **and duration**; third-party MIDI is supporting only | A third-party MIDI can neither prove the gap meaningful nor prove it meaningless. |

Two decisions are therefore open, and Published v1 gives no single unambiguous
answer to either:

1. **Classification authority.** What evidence establishes that a note-preceded
   `δ` gap has *no* musical meaning when the only symbolic source is class C?
2. **Transformation.** Given permission to normalize, which rewrite? Moving the
   next onset is forbidden (attack identity). Extending the release by `δ`
   (legato; silence shrinks by `δ`) and truncating the release back to the
   previous grid point (inserts a ≥1/64 rest — a new audible articulation) are
   both "normalizations"; the prose does not choose, and Gate 1's "exact timing"
   is violated by both.

`docs/TECHNICAL_TIMING_REPAIR.md §4, §13` reached the same conclusion for the
note-preceded case and refused it (`preceding-note-release-extension-is-not-proven-semantically-neutral`).
This candidate is the "published Canonical change" route named there.

## 2. Proposed rule text (candidate)

> **R-SRO-1 (scope).** Applies only to note events of one symbolic source whose
> encoding is *uniform*: every note of that source has an onset on the 1/64 safe
> grid, and every note release that is off the grid lies exactly the same
> distance `δ` before a grid point, with `0 < δ < 1/64`. When the source records
> its tick resolution, `δ` must equal exactly one source tick. Any other
> off-grid onset or release offset in the source excludes the whole source.
>
> **R-SRO-2 (classification).** Within that scope, the `δ` offset is classified as
> *source-encoding residue* (evidence class `SOURCE_ENCODING_PATTERN`,
> machine-derived symbolic structure). This classification is a statement about
> the encoding, not about musical meaning; it is overridden by any keep decision
> (accepted, pending or rejected) that names the event, and by any primary source
> that states a different duration.
>
> **R-SRO-3 (treatment).** Each in-scope release is moved later by exactly `δ` to
> the grid point. No onset moves; no event is created, deleted or merged; no tie
> is introduced; pitch, volume, role and voice are unchanged.
>
> **R-SRO-4 (exceptions — the release is left unchanged and stays `PENDING`).**
> (a) a same-role onset lies strictly inside `(release, release + δ)`;
> (b) a same-role explicit rest event overlaps that window;
> (c) a same-role, same-pitch note would newly overlap the extended note;
> (d) the rest that follows would become shorter than 1/64 (it must either close
> exactly — the `δ` micro-gap case — or remain ≥ 1/64);
> (e) the event's provenance is not exactly one source;
> (f) the event carries no assigned role;
> (g) the project already carries a candidate transform.
>
> **R-SRO-5 (attack / tie semantics).** An extended note that now abuts a
> same-pitch successor remains two attacks. `&` is never introduced
> (`MOBILE_SYNTAX §8`, `MASTER_RULES §7`).
>
> **R-SRO-6 (meaningful-rest protection).** A rest ≥ 1/64 survives; it shrinks by
> exactly `δ` (e.g. a quarter rest encoded as quarter + 1 tick becomes exactly a
> quarter). A rest is never removed, and no sub-grid rest is created.
>
> **R-SRO-7 (reversibility).** Every changed event records its pre-change release
> and `δ`; reversal restores the original exactly (`MOBILE_SYNTAX §11` step 8).

## 3. Rationale

- The shape is a property of the encoder, not of individual notes: in the Kaiju
  source 1,544 of 1,545 releases are exactly one tick before the grid, every
  onset is on the grid, and every ≥1/64 rest is exactly one tick longer than a
  grid length (`docs/evidence/kaiju-final-remediation-2026-09-22/microtiming-audit.json`).
  A musically meaningful articulation would not be one tick (≈0.8 ms at 150 BPM)
  on every note of a piano arrangement, uniformly, including under sustained
  chords.
- Of the two normalizations, extending by `δ` changes each release by one tick;
  truncating to the previous grid point changes it by 29 ticks and inserts an
  audible rest that no source shows. `MASTER_RULES §2` orders "minimal necessary
  adaptation" before cleanup; the candidate follows it.
- It still requires a *uniform* pattern. A source with mixed offsets, off-grid
  onsets or non-tick offsets is excluded wholesale, so the rule cannot be used as
  a quantizer.

## 4. Evidence class

`SOURCE_ENCODING_PATTERN` — machine-derived symbolic structure over the entire
source. It is **not** source-supported musical meaning, **not** audio evidence,
**not** human listening, **not** player readback and **not** in-game evidence.
It never overrides a keep decision or a primary source.

## 5. Regression impact

- Onsets, pitches, roles, voices, volumes, event identities and event counts:
  unchanged by construction and verified per event.
- Silence per role: shrinks by exactly `δ` at each changed release; sub-grid holes
  disappear; ≥1/64 rests shrink by `δ` and remain ≥1/64.
- Lead / Core3 / Full6 membership: unchanged (no event moves role).
- Existing fixtures without the pattern: untouched (`RRC-16`), and the Published-v1
  micro-gap enforcement blocker list is byte-identical for unmarked projects.
- Songs whose source has a *meaningful* uniform one-tick detache would be
  normalized; R-SRO-2's keep-decision override is the protection, and reviewers
  should reject publication if such repertoire is expected.

## 6. Implementation impact (already present, inactive)

- `studio/backend/canonical/release-regrid-candidate.mjs` — pattern analysis,
  plan/refusal, invariant verification, exact reversal. `activeInCanonicalVersions`
  is empty.
- `studio/backend/final/micro-gap-enforcement.mjs` — appends
  `MICRO_GAP_UNPUBLISHED_CANONICAL_CANDIDATE` for any project carrying an inactive
  candidate marker (project- or event-level), so readiness and the Final emitter
  refuse it.
- `studio/tests/release-regrid-candidate.test.mjs` — `RRC-1`…`RRC-16`; seven
  deliberate mutations (guard removed, keep ignored, rest floor ignored,
  same-pitch check ignored, uniformity ignored, double `δ`, onset check removed)
  were each caught.
- Not wired into the application service, run engine, readiness derivation or
  finalize. Activation after publication needs: the Manifest/release update, the
  candidate's version added to `activeInCanonicalVersions`, an explicit
  caller opt-in at the Final stage, and fresh review of every affected candidate.

## 7. Rollback / fail-closed behaviour

- Unpublished (now): the transform is diagnostic only; marked projects are
  refused; no gate moves.
- After publication, rollback = remove the version from
  `activeInCanonicalVersions` (marked projects are refused again) and reverse any
  derived candidate with `reverseReleaseRegridCandidate`.

## 8. What this does not do

- It does not publish, and it does not make Kaiju `VALIDATED`.
- It does not classify any interval `TECHNICAL_RESIDUE` in the Published-v1
  analyzer and does not write any decision.
- It does not address other Final blockers (for Kaiju, e.g. the long-rest
  duration-search limit reported in the remediation notes).

The alternative, no-rule-change route remains open: a primary symbolic source
(official score/MIDI) for the song that states the nominal durations would make
the durations source-supported under the existing rules.

## 9. Status note — the Published-v1 evidence route now exists (2026-09-22)

This candidate is **unchanged, still unpublished and still inactive**
(`activeInCanonicalVersions: []`). It is no longer the only way forward for the
note-preceded case: the "alternative, no-rule-change route" above is now
implemented under Published v1 as an evidence-gated **release representation**
in Mobile Adaptation v1 (`canonical/release-timing.mjs`,
`docs/MONSTER_SONG_MICROTIMING_FINAL_FLOW_2026-09-22.md`). There, a release no
admitted Final token can express moves to an adjacent 1/64 grid point only under a
decision whose evidence cites an independent primary source (an official score,
or the original recording) by a direct review of it, whoever submits it
(corrected 2026-09-23: the first version also required a human submitter, which
no Published rule asks for); the
uniform-encoding observation this candidate rests on is reported but is not
admissible evidence there. The difference that remains is exactly the one this
candidate proposes to change: whether the machine-derived pattern alone may
classify and normalize the releases without that per-window evidence. Publishing
it is not required for the evidence route and is not proposed by that work.
