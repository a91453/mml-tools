from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable

import librosa
import numpy as np
import soundfile as sf

AUDIO_ALIGNMENT_SCHEMA = "mabinogi-mobile-mml-studio/audio-alignment@1"
MAX_AUDIO_BYTES = 512 * 1024 * 1024
DEFAULT_SAMPLE_RATE = 22050
DEFAULT_HOP_LENGTH = 512
DEFAULT_SCORE_FRAMES_PER_BEAT = 8
MAX_ALIGNMENT_CELLS = 25_000_000


def _fraction(value: Any) -> Fraction:
    if isinstance(value, Fraction):
        return value
    return Fraction(str(value))


def _normalize_columns(matrix: np.ndarray) -> np.ndarray:
    matrix = np.asarray(matrix, dtype=np.float64)
    if matrix.ndim != 2:
        raise ValueError("feature matrix must be two-dimensional")
    norms = np.linalg.norm(matrix, axis=0, keepdims=True)
    zero = norms[0] <= 1e-12
    if np.any(zero):
        matrix = matrix.copy()
        matrix[:, zero] = 1.0 / math.sqrt(matrix.shape[0])
        norms = np.linalg.norm(matrix, axis=0, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


def _note_events(project: dict[str, Any], source_ids: set[str] | None = None) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for event in project.get("events", []):
        if event.get("kind") != "note":
            continue
        if source_ids is not None and not source_ids.intersection(event.get("sourceIds", [])):
            continue
        events.append(event)
    return events


def build_symbolic_chroma(
    project: dict[str, Any],
    *,
    frames_per_beat: int = DEFAULT_SCORE_FRAMES_PER_BEAT,
    source_ids: Iterable[str] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Render Canonical note events into a 12-bin chroma timeline.

    This is an alignment representation only. It does not alter note identity,
    infer missing notes, or turn audio similarity into symbolic pitch truth.
    """
    if not isinstance(project, dict) or not isinstance(project.get("events"), list):
        raise ValueError("project must contain a Canonical events array")
    if not isinstance(frames_per_beat, int) or frames_per_beat < 1 or frames_per_beat > 64:
        raise ValueError("frames_per_beat must be an integer from 1 to 64")

    selected_sources = set(source_ids) if source_ids is not None else None
    notes = _note_events(project, selected_sources)
    if not notes:
        raise ValueError("project contains no note events for symbolic alignment")

    total_beat = max(_fraction(event["end"]) for event in notes)
    frame_count = max(2, int(math.ceil(float(total_beat) * frames_per_beat)) + 1)
    beat_positions = np.arange(frame_count, dtype=np.float64) / frames_per_beat
    chroma = np.zeros((12, frame_count), dtype=np.float64)

    for event in notes:
        pitch = int(event["pitch"])
        if pitch < 0 or pitch > 127:
            raise ValueError(f"event {event.get('id')} has invalid MIDI pitch")
        start = _fraction(event["start"])
        end = _fraction(event["end"])
        if end <= start:
            raise ValueError(f"event {event.get('id')} has non-positive duration")

        first = max(0, int(math.floor(float(start) * frames_per_beat)))
        last = min(frame_count, int(math.ceil(float(end) * frames_per_beat)))
        volume = event.get("volume")
        weight = 1.0 if volume is None else max(0.05, min(1.0, float(volume) / 15.0))
        chroma[pitch % 12, first:last] += weight

    return _normalize_columns(chroma), beat_positions


def align_feature_sequences(
    score_chroma: np.ndarray,
    audio_chroma: np.ndarray,
) -> dict[str, Any]:
    """Align equal-time-resolution features with strictly advancing subsequence DTW.

    Both axes advance at every step. A skipped frame is interpolated, never
    clamped onto its neighbour. The score is covered in full; audio can contain
    an introduction/outro. These search constraints are not musical verdicts.
    """
    score = _normalize_columns(score_chroma)
    audio = _normalize_columns(audio_chroma)
    if score.shape[0] != 12 or audio.shape[0] != 12:
        raise ValueError("score and audio chroma must each have 12 rows")
    if score.shape[1] < 2 or audio.shape[1] < 2:
        raise ValueError("score and audio chroma require at least two frames")

    if score.shape[1] * audio.shape[1] > MAX_ALIGNMENT_CELLS:
        raise ValueError("alignment feature matrix exceeds the cell budget")
    # Keep score/audio axes explicit. librosa 1.0.0's built-in subsequence
    # backtracking flips returned columns for tall C even when C was supplied
    # without transposition. Public dtw_backtracking preserves these axes.
    cost = np.maximum(0.0, 1.0 - score.T @ audio)
    allowed_steps = np.array([[1, 1], [1, 2], [2, 1]])
    accumulated, steps = librosa.sequence.dtw(
        C=cost, subseq=True, backtrack=False, return_steps=True,
        step_sizes_sigma=allowed_steps,
        # Charge each step per score frame consumed; otherwise skipping score
        # frames is artificially cheaper and biases the path toward compression.
        weights_mul=np.array([1.0, 1.0, 2.0]),
    )
    if not np.any(np.isfinite(accumulated[-1])):
        raise ValueError("No valid full-score path within the alignment speed bounds")
    path = librosa.sequence.dtw_backtracking(
        steps, step_sizes_sigma=allowed_steps, subseq=True,
        start=int(np.argmin(accumulated[-1])),
    )
    path = np.asarray(path[::-1], dtype=np.int64)
    if path.ndim != 2 or path.shape[1] != 2 or not len(path):
        raise RuntimeError("DTW returned an invalid path")

    score_indices = path[:, 0]
    audio_indices = path[:, 1]
    if score_indices.min() < 0 or score_indices.max() >= score.shape[1]:
        raise RuntimeError("DTW score index out of range")
    if audio_indices.min() < 0 or audio_indices.max() >= audio.shape[1]:
        raise RuntimeError("DTW audio index out of range")

    similarities = np.sum(score[:, score_indices] * audio[:, audio_indices], axis=0)
    similarities = np.clip(similarities, 0.0, 1.0)

    mapped_audio_frame = np.full(score.shape[1], np.nan, dtype=np.float64)
    for score_index in range(score.shape[1]):
        matches = audio_indices[score_indices == score_index]
        if len(matches):
            mapped_audio_frame[score_index] = float(np.median(matches))

    known = np.flatnonzero(~np.isnan(mapped_audio_frame))
    if not len(known):
        raise RuntimeError("DTW path did not map any symbolic frames")
    missing = np.flatnonzero(np.isnan(mapped_audio_frame))
    if len(missing):
        mapped_audio_frame[missing] = np.interp(missing, known, mapped_audio_frame[known])
    if score_indices[0] != 0 or score_indices[-1] != score.shape[1] - 1:
        raise RuntimeError("DTW did not cover the full symbolic timeline")
    if np.any(np.diff(mapped_audio_frame) <= 0):
        raise RuntimeError("DTW produced a non-advancing time map")

    score_coverage = len(np.unique(score_indices)) / score.shape[1]
    audio_coverage = len(np.unique(audio_indices)) / audio.shape[1]
    mean_similarity = float(np.mean(similarities))
    p10_similarity = float(np.quantile(similarities, 0.10))
    confidence = float(np.clip(mean_similarity * min(1.0, score_coverage), 0.0, 1.0))

    return {
        "path": path,
        "mapped_audio_frame": mapped_audio_frame,
        "metrics": {
            "mean_chroma_similarity": mean_similarity,
            "p10_chroma_similarity": p10_similarity,
            "score_frame_coverage": float(score_coverage),
            "audio_frame_coverage": float(audio_coverage),
            "mapped_score_span_coverage": 1.0,
            "mapped_audio_span_coverage": float((audio_indices[-1] - audio_indices[0] + 1) / audio.shape[1]),
            "confidence": confidence,
            "notice": "Confidence is an alignment diagnostic, not proof of exact note identity or musical correctness.",
        },
    }


def _score_seconds(project: dict[str, Any], beats: np.ndarray) -> np.ndarray:
    """Integrate the source tempo map, including changes between feature frames."""
    events = sorted(project.get("tempoEvents", []), key=lambda e: _fraction(e["beat"]))
    if not events or _fraction(events[0]["beat"]) != 0:
        raise ValueError("alignment requires an explicit source tempo at beat zero")
    tempo_beats, tempo_seconds, bpms = [], [], []
    seconds = 0.0
    for event in events:
        beat, bpm = float(_fraction(event["beat"])), float(event["bpm"])
        if not math.isfinite(beat) or beat < 0 or not math.isfinite(bpm) or bpm <= 0:
            raise ValueError("tempo beats must be non-negative and BPM positive/finite")
        if tempo_beats:
            if beat == tempo_beats[-1]:
                if bpm != bpms[-1]:
                    raise ValueError("conflicting tempos at the same beat")
                continue
            seconds += (beat - tempo_beats[-1]) * 60 / bpms[-1]
        tempo_beats.append(beat)
        tempo_seconds.append(seconds)
        bpms.append(bpm)
    index = np.searchsorted(tempo_beats, beats, side="right") - 1
    return np.asarray(tempo_seconds)[index] + (beats - np.asarray(tempo_beats)[index]) * 60 / np.asarray(bpms)[index]


def _align_timed_features(score, beats, audio, audio_times, project):
    score_seconds = _score_seconds(project, beats)
    # Use a common physical sampling interval so slope limits describe relative
    # playback speed rather than the unrelated beat/STFT feature frame rates.
    # For long recordings, coarsen both grids together within the memory budget.
    step = max(float(np.min(np.diff(audio_times))), min(.05, float(np.min(np.diff(score_seconds)))))
    while True:
        score_count = int(math.ceil(score_seconds[-1] / step)) + 1
        effective_step = score_seconds[-1] / (score_count - 1)
        audio_count = int(math.floor((audio_times[-1] - audio_times[0]) / effective_step)) + 1
        if score_count * audio_count <= MAX_ALIGNMENT_CELLS:
            break
        if score_count == 2:
            raise ValueError("audio/score duration ratio exceeds the alignment cell budget")
        step *= 1.1
    if min(score_count, audio_count) < 2:
        raise ValueError("audio/score timeline is too short for constrained alignment")
    # Include the exact score endpoint, without extrapolating the recording.
    score_grid = np.linspace(0, score_seconds[-1], score_count)
    step = effective_step
    audio_grid = audio_times[0] + np.arange(audio_count) * step
    resampled_score = np.array([np.interp(score_grid, score_seconds, row) for row in score])
    resampled_audio = np.array([np.interp(audio_grid, audio_times, row) for row in audio])
    aligned = align_feature_sequences(resampled_score, resampled_audio)
    mapped_seconds = np.interp(aligned["mapped_audio_frame"], np.arange(len(audio_grid)), audio_grid)
    aligned["mapped_audio_frame"] = np.interp(
        np.interp(score_seconds, score_grid, mapped_seconds), audio_times, np.arange(len(audio_times)),
    )
    aligned["method"] = {
        "name": "tempo-normalized-subsequence-dtw@2", "analysis_step_seconds": step,
        "steps": [[1, 1], [1, 2], [2, 1]], "step_cost_weights": [1, 1, 2],
        "tempo_source": "symbolic.tempoEvents", "audio_prefix_suffix_allowed": True,
        "search_speed_ratio_bounds": [.5, 2.0],
        "notice": "Slope limits constrain the search, not musical acceptance. Inspect ambiguous repeats and section boundaries.",
    }
    return aligned


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _decode_with_ffmpeg(input_path: Path, output_wav: Path, sample_rate: int) -> None:
    if input_path.stat().st_size > MAX_AUDIO_BYTES:
        raise ValueError(f"audio file exceeds {MAX_AUDIO_BYTES} bytes")
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_f32le",
        str(output_wav),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=300)
    except FileNotFoundError as error:
        raise RuntimeError("ffmpeg is required by the audio worker") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("ffmpeg decode exceeded 300 seconds") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "ffmpeg decode failed").strip()[-2000:]
        raise RuntimeError(f"ffmpeg decode failed: {detail}") from error


def _audio_chroma(y: np.ndarray, sample_rate: int, hop_length: int) -> np.ndarray:
    if y.ndim != 1 or len(y) < max(2048, sample_rate // 2):
        raise ValueError("decoded audio is too short for alignment")
    chroma = librosa.feature.chroma_stft(
        y=y,
        sr=sample_rate,
        n_fft=4096,
        hop_length=hop_length,
        center=True,
    )
    return _normalize_columns(chroma)


def _expected_tempo_at(project: dict[str, Any], beat: float) -> float | None:
    tempo_events = sorted(project.get("tempoEvents", []), key=lambda item: float(_fraction(item["beat"])))
    current: float | None = None
    for event in tempo_events:
        if float(_fraction(event["beat"])) > beat:
            break
        bpm = float(event["bpm"])
        if bpm > 0:
            current = bpm
    return current


def _control_points(
    beat_positions: np.ndarray,
    mapped_audio_frame: np.ndarray,
    audio_times: np.ndarray,
    project: dict[str, Any],
    *,
    step_beats: float = 1.0,
) -> list[dict[str, Any]]:
    if step_beats <= 0:
        raise ValueError("control point step must be positive")
    max_beat = float(beat_positions[-1])
    targets = list(np.arange(0.0, max_beat + 1e-9, step_beats))
    if not targets or abs(targets[-1] - max_beat) > 1e-8:
        targets.append(max_beat)

    points: list[dict[str, Any]] = []
    mapped_seconds = np.interp(mapped_audio_frame, np.arange(len(audio_times)), audio_times)
    for beat in targets:
        score_index = int(np.clip(np.searchsorted(beat_positions, beat, side="left"), 0, len(beat_positions) - 1))
        points.append({
            "beat": round(float(beat_positions[score_index]), 9),
            "seconds": round(float(mapped_seconds[score_index]), 9),
            "expected_bpm": _expected_tempo_at(project, float(beat_positions[score_index])),
        })

    for index in range(1, len(points)):
        previous, current = points[index - 1], points[index]
        delta_beats = current["beat"] - previous["beat"]
        delta_seconds = current["seconds"] - previous["seconds"]
        local_bpm = 60.0 * delta_beats / delta_seconds if delta_beats > 0 and delta_seconds > 1e-9 else None
        current["local_bpm_from_alignment"] = round(local_bpm, 6) if local_bpm else None
        expected = current.get("expected_bpm")
        current["tempo_drift_percent"] = (
            round((local_bpm - expected) / expected * 100.0, 6)
            if local_bpm and expected and expected > 0
            else None
        )
    if points:
        points[0]["local_bpm_from_alignment"] = None
        points[0]["tempo_drift_percent"] = None
    return points


def align_audio_to_project(
    audio_path: str | os.PathLike[str],
    project: dict[str, Any],
    *,
    source_ids: Iterable[str] | None = None,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    hop_length: int = DEFAULT_HOP_LENGTH,
    score_frames_per_beat: int = DEFAULT_SCORE_FRAMES_PER_BEAT,
    control_step_beats: float = 1.0,
) -> dict[str, Any]:
    """Decode user-provided audio, align it to symbolic Canonical beats, and emit evidence.

    The returned report never changes symbolic events. It only maps audio time to
    beat time and reports timing/chroma diagnostics for later arbitration.
    """
    path = Path(audio_path)
    if not path.is_file():
        raise FileNotFoundError(path)
    if sample_rate < 8000 or sample_rate > 96000:
        raise ValueError("sample_rate must be from 8000 to 96000")
    if hop_length < 64 or hop_length > 8192:
        raise ValueError("hop_length must be from 64 to 8192")

    source_ids = tuple(source_ids) if source_ids is not None else None
    score_chroma, beat_positions = build_symbolic_chroma(
        project,
        frames_per_beat=score_frames_per_beat,
        source_ids=source_ids,
    )

    with tempfile.TemporaryDirectory(prefix="mml-audio-") as directory:
        decoded = Path(directory) / "decoded.wav"
        _decode_with_ffmpeg(path, decoded, sample_rate)
        y, decoded_sr = sf.read(decoded, dtype="float32", always_2d=False)
        if decoded_sr != sample_rate:
            raise RuntimeError("decoded sample rate differs from requested sample rate")
        if y.ndim != 1:
            raise RuntimeError("ffmpeg output is not mono")

        trimmed, trim_index = librosa.effects.trim(y, top_db=50)
        if len(trimmed) < sample_rate // 2:
            raise ValueError("audio remaining after silence trim is too short")
        trim_start_seconds = float(trim_index[0]) / sample_rate
        trim_end_seconds = float(trim_index[1]) / sample_rate
        audio_chroma = _audio_chroma(trimmed, sample_rate, hop_length)
        audio_times = librosa.frames_to_time(
            np.arange(audio_chroma.shape[1]),
            sr=sample_rate,
            hop_length=hop_length,
        ) + trim_start_seconds

    aligned = _align_timed_features(score_chroma, beat_positions, audio_chroma, audio_times, project)
    points = _control_points(
        beat_positions,
        aligned["mapped_audio_frame"],
        audio_times,
        project,
        step_beats=control_step_beats,
    )

    drift_values = [point["tempo_drift_percent"] for point in points if point.get("tempo_drift_percent") is not None]
    tempo_summary = {
        "sample_count": len(drift_values),
        "median_drift_percent": round(float(np.median(drift_values)), 6) if drift_values else None,
        "p95_absolute_drift_percent": round(float(np.quantile(np.abs(drift_values), 0.95)), 6) if drift_values else None,
    }

    return {
        "schema": AUDIO_ALIGNMENT_SCHEMA,
        "audio": {
            "filename": path.name,
            "sha256": _sha256(path),
            "input_bytes": path.stat().st_size,
            "decoded_sample_rate": sample_rate,
            "trim_start_seconds": round(trim_start_seconds, 9),
            "trim_end_seconds": round(trim_end_seconds, 9),
        },
        "symbolic": {
            "project_id": project.get("id"),
            "source_ids": sorted(set(source_ids)) if source_ids is not None else None,
            "score_frames_per_beat": score_frames_per_beat,
            "end_beat": round(float(beat_positions[-1]), 9),
        },
        "alignment": {
            "method": aligned["method"],
            "control_points": points,
            "metrics": aligned["metrics"],
            "tempo_drift": tempo_summary,
        },
        "evidence_policy": {
            "changes_symbolic_truth": False,
            "valid_for": ["time-alignment", "tempo-drift", "structure-review", "audio-role-followup"],
            "not_valid_by_itself_for": ["exact-note-identity", "vocal-identity", "automatic-repitch", "automatic-deletion"],
        },
    }


def load_project_json(path: str | os.PathLike[str]) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        project = json.load(handle)
    if not isinstance(project, dict):
        raise ValueError("project JSON must be an object")
    return project
