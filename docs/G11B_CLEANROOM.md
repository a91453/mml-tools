# G11-B — Clean-room Smart Voice Split

Status: checkpoint 2 implementation note (non-Canonical)

Canonical authority for this work remains the Published Manifest at
`docs/CANONICAL_MANIFEST.md` and its pinned rules snapshot. This file is an
implementer note only; it creates no new MML rule and no new evidence class.

## Purpose

G11-A preserves raw MIDI as a Source-Faithful Canonical baseline. G11-B begins
after that baseline exists and derives candidate monophonic voice lanes from a
single polyphonic source voice. The output is arrangement evidence, not Final
MML, not a role assignment, and not a six-track reduction.

Both checkpoints so far are intentionally lossless. Every input Canonical note
event must remain traceable in the output with the same pitch, start, end,
source IDs and source-event IDs. No note is deleted, quantized, lengthened,
shortened, tied or merged.

## Scope boundary

G11-B does: polyphony decomposition, voice continuity, same-source note
continuity, source-aware matching, deterministic lane ordering,
provenance-preserving split, diagnostics.

G11-B does **not**: Melody/Chord1–Chord5 role assignment, Core3/Full6 reduction,
octave adaptation, Mobile audibility adaptation, velocity→V0–15 mapping, Final
MML emission, Final canonicalization. In particular `highest voice = Melody` is
**not** treated as a rule here; lanes are ordered by exact duration-weighted
pitch for presentation only, and that order carries no role meaning.

## External behavioral reference

The user supplied an out-of-repository `voices.js` (a contig-mapping voice
separator in the Chew & Wu lineage) as a **behavioral reference / supporting
evidence**. Under `SOURCE_POLICY.md` §C and §8 it is a third-party tool
candidate, not an authority.

Its source text is **not** copied into this repository, no file of it is stored
here, and no license is assumed. Only high-level, independently re-derived
behavior was used, each item going through: reference behavior → synthetic
fixture → expected semantics → independent implementation → differential check.

Reference verification status stays `MML_MABI_REFERENCE_NOT_VERIFIED`. Nothing
in this checkpoint claims that mml.mabi.tw voice splitting has been reproduced
or that production behavior has been matched.

### Behavior ledger

| Reference behavior studied | Adopted? | Canonical decision and why |
| --- | --- | --- |
| Onset grouping with a tolerance window | **No** | The reference merges note-ons within a fine-tick window to sample one monophonic line. That rewrites onsets and discards the events not picked. Canonical §2/§3 require source-complete preservation before reduction, so G11-B groups nothing and samples nothing. |
| Contig segmentation at changes in simultaneous-sounding count | **Adapted** | We segment at *every* exact note start/end boundary instead of only where the count changes. Finer segmentation costs more boundaries but never hides a substitution where one note is released as another begins. |
| Pitch-ranked strands inside a segment | **Adopted** | Each slice is ordered by descending pitch, ties broken by event id. This is presentation/matching order only, never a role. |
| Strand reduction to a fixed cap | **No** | The reference deletes strands to fit a fixed lane count. That is silent source deletion in the decomposition layer. G11-B keeps every lane and only *reports* `LANE_COUNT_EXCEEDS_TARGET` with `reductionApplied: false` when the caller passes `laneTarget`. Any real reduction belongs to an explicit later leftover/candidate layer. |
| Minimum pitch-distance matching between adjacent segments | **Adopted** | Used only for events that genuinely ended and were replaced. |
| Hungarian minimum-cost assignment | **Adopted (independently implemented)** | Written from the algorithm, not copied. The cost matrix is integer-only: `distance * (rows*cols + 1) + column`. Semitone distance stays strictly dominant, and equal-distance assignments deterministically prefer the lowest column indices. |
| Same-note-across-a-boundary as a hard constraint rather than a cost | **Adopted** | This is the single most important reference observation. A still-sounding source event is linked to itself before any cost matrix is built, so a sustained note cannot be stolen by a closer neighbour. |
| Chain construction by union across boundaries | **Adopted** | Implemented with union-find over slice nodes. |
| Lane packing of non-overlapping chains | **Adopted** | Greedy packing by chain start into `maxPolyphony` lanes, choosing the free lane whose exact weighted pitch is nearest. Since at most `maxPolyphony` chains are ever alive at once, a free lane always exists. |
| Unison merge (same tick, same pitch → keep the longest) | **No** | Destroys provenance for two distinct Canonical source events. Canonical §6 calls same-pitch overlap a *review signal*, not a deletion target. G11-B keeps both events and reports `SIMULTANEOUS_UNISONS_PRESERVED` with `merged: false`. |
| Leftover / dropped accounting | **Adapted** | The reference needs leftovers because it deletes. G11-B has no leftovers by construction; instead it runs an exact event-level coverage audit and only reports `SOURCE_COVERAGE_MISMATCH` if the invariant were ever broken. |
| Melody-vs-chord heuristics (`melodyRatio`, `hasMelody`, `MELODY_MIN_RATIO`) | **No** | Role classification. Out of G11-B scope entirely, and `highest voice = Melody` is explicitly forbidden as a Canonical rule. |
| Anchor-segment lane pitch seeding | **Adapted** | We seed a lane's pitch from the first chain parked in it rather than from a global anchor segment, so no single segment is promoted to a song-wide authority. |
| Float ticks for ordering and overlap | **No** | All ordering, overlap and continuity decisions use exact rational beats. `1/3` stays `1/3`. |

## Checkpoint 2 — what changed

1. **Source-aware continuity (hardened).** A Canonical source event that spans
   several sounding slices is hard-linked to itself before matching. Fixtures
   now include moving voices that pass within a semitone of a held inner tone,
   a pedal tone under changing chords, and moving-bass/moving-top pairs.
2. **Deterministic adjacent-segment matching.** The tie-break is now a bounded
   integer term inside the cost matrix instead of a magic float scale, so a
   tie-break can never outweigh a real semitone difference at any matrix size.
3. **Silence boundary in the continuity graph.** Each lane now exposes
   `segments` (the chains parked in it) and `junctions` between them, with
   `silence: true` when the lane was reused across real silence. Lane adjacency
   is a packing fact and is never presented as one continuous voice.
4. **Float-free ordering.** Chain pitch, lane pitch, lane affinity and lane
   ordering are computed as exact rationals. `averagePitch` remains as a float
   presentation field beside the exact `averagePitchExact`.
5. **Fragment-level provenance.** Every emitted span carries `eventId`,
   `chainId`, `eventStart`, `eventEnd`, `fragment`, `sourceIds`,
   `sourceEventIds`, `sourceVoice` and `sourceRole`, so a fragment can always be
   told apart from a whole event and diffed back to the baseline.
6. **Exact coverage audit.** `complete` now requires, per event, full rational
   duration coverage, matching first start and last end, unchanged pitch, and a
   single owning lane — not merely the presence of the id.
7. **New non-destructive diagnostics.** `OVERLAPPING_SAME_PITCH_EVENTS`,
   `ADJACENT_REPEATED_ATTACKS` (`tieForbidden: true`, per Canonical §7),
   `LANE_REUSED_ACROSS_SILENCE`, `EVENT_REPRESENTED_AS_FRAGMENTS` and
   `LANE_COUNT_EXCEEDS_TARGET`.
8. **Linear-time sweeps.** Slice construction and the same-pitch scans no longer
   rescan the whole score per boundary or per pair.

## Algorithm

`studio/backend/arrangement/voice-split.mjs`:

1. Re-sort input by `(start, -pitch, id)`; the caller's array order can never
   change the result.
2. Sweep every exact note start/end boundary into atomic sounding slices,
   skipping regions where nothing sounds.
3. At each pair of physically touching slices, hard-link still-sounding source
   events to themselves, then match the remaining released/new notes with an
   integer minimum-cost assignment on semitone distance.
4. Union the links into chains; a chain never crosses a silence.
5. Pack non-overlapping chains into `maxPolyphony` lanes, recording every
   junction and whether it crosses silence.
6. Audit exact event-level coverage and emit diagnostics.

## Source / provenance invariants

The decomposition layer never changes pitch, onset, duration, `sourceIds` or
`sourceEventIds`; never merges two source events; never converts a repeated
attack into a sustain; never deletes an event for a cap; never drops an event
because matching failed. Simultaneous same-pitch events from different source
events remain two events. Source voices are never merged: a shared MIDI channel
on two different tracks stays two independent decompositions.

## Synthetic regression coverage

`studio/tests/voice-split.test.mjs` runs a shared `assertLossless` and
`assertOrderIndependent` check on every fixture, plus:

- static triad; minimum-pitch-distance replacement;
- moving top over held bass; moving bass under held top;
- inner sustained tone against neighbours passing within a semitone;
- long tone sustained across chord changes;
- contrary motion; crossing voices;
- polyphony changing 3 → 4 → 2;
- gap-separated phrases, and a non-silent junction that must *not* be flagged;
- silence → restart;
- exact triplet timing, including a `1/3` boundary a float would smear;
- duplicate simultaneous unisons; repeated unison attacks;
- same pitch, different onset, overlapping;
- same channel on different MIDI tracks;
- polyphony above a lane target, reported and not reduced;
- a seeded randomized dense-polyphony property check over four seeds asserting
  losslessness, exact rational spellings, lane monophony and order-independence.

## Explicitly deferred

Later G11-B checkpoints may add candidate ranking, an explicit reversible
leftover/candidate-reduction layer, melody-likelihood *evidence* (never a role
verdict) and track-merging hypotheses. G11-C remains responsible for six-role /
Core3 / Full6 candidate reduction and Final-delivery concerns.
