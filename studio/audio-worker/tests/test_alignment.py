from __future__ import annotations

import json
import math
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from mml_audio_worker.alignment import (
    AUDIO_ALIGNMENT_SCHEMA,
    align_audio_to_project,
    align_feature_sequences,
    build_symbolic_chroma,
)


def _project() -> dict:
    pitches = [60, 62, 64, 65]
    events = []
    for index, pitch in enumerate(pitches):
        events.append({
            "kind": "note",
            "id": f"official:n{index + 1}",
            "pitch": pitch,
            "start": str(index),
            "end": str(index + 1),
            "sourceIds": ["official"],
            "sourceEventIds": [f"fixture:{index + 1}"],
            "role": None,
            "volume": None,
        })
    return {
        "schema": "mabinogi-mobile-mml-studio/canonical-project@2",
        "id": "audio-fixture",
        "title": "Audio Fixture",
        "sources": [{"id": "official", "kind": "official-musicxml", "authority": "primary-symbolic"}],
        "events": events,
        "tempoEvents": [{"kind": "tempo", "id": "tempo:1", "beat": "0", "bpm": 60, "sourceIds": ["official"]}],
        "meterEvents": [],
        "decisions": [],
    }


def _synthesize_score_audio(sample_rate: int = 22050) -> np.ndarray:
    pieces = []
    for midi in [60, 62, 64, 65]:
        frequency = 440.0 * (2.0 ** ((midi - 69) / 12.0))
        t = np.arange(sample_rate, dtype=np.float64) / sample_rate
        tone = 0.35 * np.sin(2.0 * math.pi * frequency * t)
        fade = max(1, int(sample_rate * 0.02))
        envelope = np.ones(sample_rate, dtype=np.float64)
        envelope[:fade] = np.linspace(0.0, 1.0, fade, endpoint=False)
        envelope[-fade:] = np.linspace(1.0, 0.0, fade, endpoint=False)
        pieces.append((tone * envelope).astype(np.float32))
    return np.concatenate(pieces)


class AlignmentTests(unittest.TestCase):
    def test_symbolic_chroma_keeps_exact_pitch_classes(self) -> None:
        chroma, beats = build_symbolic_chroma(_project(), frames_per_beat=4, source_ids=["official"])
        self.assertEqual(chroma.shape[0], 12)
        self.assertAlmostEqual(float(beats[-1]), 4.0)
        expected = [0, 2, 4, 5]
        for beat_index, pitch_class in enumerate(expected):
            frame = beat_index * 4
            self.assertEqual(int(np.argmax(chroma[:, frame])), pitch_class)

    def test_feature_dtw_recovers_monotonic_mapping(self) -> None:
        score = np.zeros((12, 8), dtype=np.float64)
        for index in range(8):
            score[index % 4, index] = 1.0
        audio = np.repeat(score, 2, axis=1)
        result = align_feature_sequences(score, audio)
        mapped = result["mapped_audio_frame"]
        self.assertEqual(len(mapped), 8)
        self.assertTrue(np.all(np.diff(mapped) >= 0))
        self.assertGreater(result["metrics"]["mean_chroma_similarity"], 0.99)
        self.assertGreater(result["metrics"]["confidence"], 0.99)

    def test_end_to_end_m4a_alignment_emits_traceable_evidence(self) -> None:
        sample_rate = 22050
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wav = root / "fixture.wav"
            m4a = root / "fixture.m4a"
            sf.write(wav, _synthesize_score_audio(sample_rate), sample_rate, subtype="PCM_16")
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-i", str(wav), "-c:a", "aac", "-b:a", "128k", str(m4a),
            ], check=True, capture_output=True, text=True, timeout=60)

            report = align_audio_to_project(
                m4a,
                _project(),
                source_ids=["official"],
                sample_rate=sample_rate,
                hop_length=256,
                score_frames_per_beat=4,
                control_step_beats=1.0,
            )

            self.assertEqual(report["schema"], AUDIO_ALIGNMENT_SCHEMA)
            self.assertEqual(report["symbolic"]["project_id"], "audio-fixture")
            self.assertEqual(report["symbolic"]["source_ids"], ["official"])
            self.assertEqual(len(report["audio"]["sha256"]), 64)
            self.assertFalse(report["evidence_policy"]["changes_symbolic_truth"])
            self.assertIn("exact-note-identity", report["evidence_policy"]["not_valid_by_itself_for"])

            points = report["alignment"]["control_points"]
            self.assertGreaterEqual(len(points), 5)
            seconds = [point["seconds"] for point in points]
            self.assertTrue(all(b >= a for a, b in zip(seconds, seconds[1:])))
            self.assertGreater(seconds[-1], 2.5)
            self.assertGreater(report["alignment"]["metrics"]["mean_chroma_similarity"], 0.30)
            self.assertGreater(report["alignment"]["metrics"]["score_frame_coverage"], 0.90)
            self.assertGreater(report["alignment"]["tempo_drift"]["sample_count"], 0)

    def test_report_is_json_serializable(self) -> None:
        score, _ = build_symbolic_chroma(_project(), frames_per_beat=2)
        aligned = align_feature_sequences(score, score)
        payload = {"metrics": aligned["metrics"], "mapped": aligned["mapped_audio_frame"].tolist()}
        json.dumps(payload)


if __name__ == "__main__":
    unittest.main()
