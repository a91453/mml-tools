# Studio Audio Worker

This worker is the first original-audio evidence layer for Mabinogi Mobile MML Studio. It is intentionally **not** a whole-song Audio-to-MIDI system and it does not use source separation in v1.

## Input

- user-provided M4A / FLAC / WAV / other FFmpeg-readable audio;
- a Canonical Project JSON containing the symbolic baseline to align against;
- an explicit, finite, positive tempo at beat zero (later tempo changes are supported);
- optional source IDs to restrict symbolic alignment to the trusted baseline source.

## Pipeline

```text
Original audio
  -> FFmpeg mono decode
  -> silence-boundary trim
  -> chroma STFT

Canonical note events
  -> exact beat positions
  -> symbolic chroma timeline

symbolic chroma + source tempo map + audio chroma
  -> common physical time grid
  -> strictly advancing subsequence DTW
  -> beat <-> audio-seconds control points
  -> local BPM / Tempo-drift diagnostics
  -> alignment confidence diagnostics
```

## Evidence boundary

The alignment report may support:
- recording-time <-> canonical-beat mapping;
- Tempo drift review;
- section/structure mismatch review;
- locating audio windows for later role/prominence listening analysis.

The alignment report does **not** by itself prove:
- exact isolated note identity in a dense recording;
- Vocal identity;
- octave/register correctness;
- whether a note should be deleted or repitched;
- that a candidate MML is musically better.

The alignment report never mutates symbolic source events.

## Alignment method v2

`tempo-normalized-subsequence-dtw@2` integrates the source tempo map and samples
both feature streams on the same physical time grid. It permits steps (1,1),
(1,2), (2,1), with costs weighted by score frames consumed. Every step advances
both axes; skipped feature frames are interpolated with positive elapsed time.
The complete score must fit a path, while the recording may have an unmatched
intro/outro. There is no song-specific offset or use of the diagnostic's 8.5s
hypothesis in this implementation.

The local search speed range is 0.5–2 times the source timing. It is an algorithm
constraint, not a Canonical tempo threshold or acceptance verdict. A recording
outside it, missing tempo, or conflicting simultaneous tempos fails explicitly;
the worker does not fall back to a degenerate map. For long inputs, both grids
are coarsened together to stay within 25 million cost cells. The actual interval
is disclosed in `alignment.method.analysis_step_seconds` (normally at most 50ms
unless the audio hop size or memory budget requires coarser sampling).

`score_frame_coverage` and `audio_frame_coverage` still count direct DTW path
visits and can be below 1 because strict steps skip frames. They remain conservative
inputs to confidence and backend warnings. New `mapped_*_span_coverage` metrics
describe the time span, including interpolation; they do not replace existing
gate metrics. Chroma confidence, local tempo drift, ambiguous repeats and listening
review remain separate. The backend retains `alignment.method` with attached
evidence so the algorithm and search bounds remain traceable.

## CLI

From `studio/audio-worker`:

```sh
python -m mml_audio_worker.cli align \
  --audio original.m4a \
  --project canonical-project.json \
  --source-id official-score \
  --output alignment.json
```

## Runtime

- Python 3.12
- FFmpeg
- NumPy 2.5.3
- librosa 1.0.0
- SoundFile 0.14.0

Dependencies are pinned in `requirements.txt`; CI contains a synthetic M4A end-to-end alignment test.

## Reviewing a failed DTW map locally

Global DTW can align repeated material to the wrong section and compress beat
intervals. Full frame coverage and a high chroma score do not establish a usable
time map. The backend still flags collapsed intervals in existing reports.
The independent diagnostic below is separate from the corrected default worker.

For a constant-tempo source, create an independent tempo-preserving hypothesis:

```sh
python -m mml_audio_worker.diagnostic \
  --audio original.m4a \
  --project canonical-project.json \
  --out new-private-review-directory
```

The output directory must be new with an existing parent. It contains a private
copy of the audio, `diagnostic.json`, and `review.html`. Open the HTML locally to
play projected sections and download human listening notes. Notes stay in the
page until downloaded and are lost on refresh. Optional `--review-context`
records the user's instrument/performance intent. It does not render an
arrangement or simulate the game instrument.

The search keeps pitch classes unchanged, uses the source tempo, and tests
offsets −5…20 seconds and time scales 0.94…1.06. These are disclosed search
bounds, not acceptance thresholds. It rejects missing/variable tempo rather
than silently flattening it, compares all active frames, and includes the last
partial 32-beat section. Local offset disagreement highlights ambiguous repeats
or short sections. A best result at a search boundary needs further investigation.

This is a separate diagnostic schema, deliberately not an audio-alignment report
that can be attached to a gate. It never writes decisions, accepted roles,
confirmations, or a Final. Chroma similarity cannot establish Vocal identity,
exact notes, or in-game audibility. An aborted run can leave a partial private
directory; use a new directory for the next attempt.

Validation:

```sh
python -m unittest discover -s tests -v
# From repository root, after creating a review directory:
node studio/browser-tests/audio-diagnostic.mjs path/to/review-directory
```

## Privacy / deployment intent

The worker is intended to run cloud-side because the user workflow is iPhone/iPad-first. Audio is per-project input; this module returns derived evidence and never promotes the recording into symbolic source truth. Storage/retention policy belongs to deployment and is not implemented here.
