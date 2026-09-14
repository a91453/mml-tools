# G11-B — Clean-room Smart Voice Split

Status: checkpoint 1 implementation note (non-Canonical)

Canonical authority for this work remains the Published Manifest at
`docs/CANONICAL_MANIFEST.md` and its pinned rules snapshot. This file is an
implementer note only; it creates no new MML rule.

## Purpose

G11-A preserves raw MIDI as a Source-Faithful Canonical baseline. G11-B begins
after that baseline exists and derives candidate monophonic voice lanes from a
polyphonic source voice. The output is arrangement evidence, not Final MML and
not a role assignment.

Checkpoint 1 is intentionally lossless. Every input Canonical note event must
remain traceable in the output with the same pitch, start, end, source IDs and
source-event IDs. No note is deleted, quantized, lengthened, shortened or merged.

## External behavioral reference

The user supplied an out-of-repository `voices.js` as a behavioral reference.
It demonstrates useful concepts such as time segmentation, pitch-ordered voice
strands, continuity matching and lane packing. Its source text is not copied
into this repository and no license is assumed.

The clean-room implementation uses only those high-level behavioral ideas and
is independently written against synthetic fixtures. Where the reference's
behavior would conflict with Published Canonical source preservation, Canonical
wins. In particular, checkpoint 1 does **not**:

- collapse simultaneous unisons;
- discard strands to satisfy a fixed lane cap;
- infer Melody/Vocal identity from the highest voice;
- assign Core3/Full6 roles;
- quantize timing;
- rewrite source durations;
- map velocity to Mobile volume.

## Algorithm in checkpoint 1

`studio/backend/arrangement/voice-split.mjs` performs four steps:

1. Build atomic sounding slices at every exact Canonical note start/end boundary.
2. At each adjacent boundary, hard-link a still-sounding source event to itself.
3. Match remaining released/new notes by minimum semitone distance using a
   deterministic minimum-cost assignment.
4. Build continuous chains and pack non-overlapping chains into reusable lanes,
   ordered by weighted average pitch for presentation.

The hard source-event identity link is stronger than pitch proximity. This is
important for long sustained notes: a surrounding moving voice cannot steal the
lane of a note that is still sounding.

## Provenance and diagnostics

Each emitted lane note records the original Canonical `eventId`, `sourceIds`,
`sourceEventIds`, source voice and source role. Simultaneous same-pitch attacks
are retained separately and reported as `SIMULTANEOUS_UNISONS_PRESERVED` rather
than silently collapsed.

A decomposition reports `complete=true` only when every input event ID is found
in the output and no unknown output event ID appears.

## Synthetic regression coverage

`studio/tests/voice-split.test.mjs` currently covers:

- sustained triad -> three monophonic lanes;
- minimum-pitch-distance replacement matching;
- hard continuity of a still-sounding event;
- silence without invented filler;
- simultaneous unison preservation;
- exact rational timing such as `1/3` beats;
- preservation of source-event provenance and input immutability;
- rejection of mixed source voices unless grouped first;
- project-level grouping by G11-A source voice identity.

## Explicitly deferred

Later G11-B checkpoints may add candidate ranking, optional capped reductions,
melody-likelihood evidence and track-merging hypotheses. Those operations must
remain reversible/auditable and may not silently erase the Source-Faithful
Baseline. G11-C remains responsible for six-role/Core3/Full6 candidate reduction
and Final-delivery concerns.
