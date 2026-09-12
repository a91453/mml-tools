# Studio Audio Worker

This worker is the first original-audio evidence layer for Mabinogi Mobile MML Studio. It is intentionally **not** a whole-song Audio-to-MIDI system and it does not use source separation in v1.

## Input

- user-provided M4A / FLAC / WAV / other FFmpeg-readable audio;
- a Canonical Project JSON containing the symbolic baseline to align against;
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

symbolic chroma + audio chroma
  -> DTW
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

## Privacy / deployment intent

The worker is intended to run cloud-side because the user workflow is iPhone/iPad-first. Audio is per-project input; this module returns derived evidence and never promotes the recording into symbolic source truth. Storage/retention policy belongs to deployment and is not implemented here.
