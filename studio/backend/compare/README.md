# Source and version comparison

Purpose: compare normalized events without deciding which source is musically correct.

V1 comparison should report:

- exact pitch/onset/duration matches;
- additions and removals;
- role moves;
- octave/register changes;
- duration and sustain changes;
- current-vs-history divergence from a trusted baseline;
- Core3 and Full6 coverage as diagnostics, not optimization targets.

Every difference must retain source/event IDs so the caller can trace it back to the original symbolic source.

Comparison must not silently auto-fix a conflict. It produces evidence for the arbitration layer.
