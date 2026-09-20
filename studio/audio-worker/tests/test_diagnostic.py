import unittest

import numpy as np

from mml_audio_worker.diagnostic import constant_tempo, diagnose, render_review, search_affine, section_ranges


class DiagnosticTests(unittest.TestCase):
    def test_sections_include_short_tail_without_extending_song(self):
        sections = section_ranges(545.9979166667)
        self.assertEqual(len(sections), 18)
        self.assertEqual(sections[-1], (544.0, 545.9979166667))
        self.assertEqual(section_ranges(64), [(0.0, 32.0), (32.0, 64.0)])

    def test_tempo_changes_and_missing_initial_tempo_are_not_silently_flattened(self):
        self.assertEqual(constant_tempo({"tempoEvents": [{"beat": "0", "bpm": 150}, {"beat": "8", "bpm": 150}]}), 150)
        for events in ([], [{"beat": "1", "bpm": 150}],
                       [{"beat": "0", "bpm": 150}, {"beat": "8", "bpm": 120}],
                       [{"beat": "0", "bpm": float("nan")}], [{"beat": "0", "bpm": 0}]):
            with self.assertRaises(ValueError):
                constant_tempo({"tempoEvents": events})

    def test_recovers_offset_with_intro_and_repeated_pitch_classes(self):
        score = np.eye(12)[:, [0, 4, 7, 0, 2, 5, 9, 0]]
        audio = np.column_stack([np.eye(12)[:, 11], np.eye(12)[:, 10], score, np.eye(12)[:, 8]])
        result = search_affine(score, np.arange(8), audio, np.arange(11), np.arange(-2, 5), [1])[0]
        self.assertEqual(result["offset_seconds"], 2)
        self.assertAlmostEqual(result["similarity"], 1)

    def test_does_not_improve_score_by_excluding_unmatched_tail(self):
        score = np.eye(12)[:, [0, 4, 7, 9]]
        audio = np.eye(12)[:, [11, 0, 4, 7]]
        result = search_affine(score, np.arange(4), audio, np.arange(4), [0, 1], [1])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["offset_seconds"], 0)
        with self.assertRaisesRegex(ValueError, "all active"):
            search_affine(score, np.arange(4), audio, np.arange(4), [1], [1])

    def test_diagnostic_does_not_present_search_as_gate_evidence(self):
        project = {"id": "fixture", "tempoEvents": [{"beat": "0", "bpm": 60}],
                   "events": [{"kind": "note", "pitch": pitch, "start": str(i), "end": str(i + 1)}
                              for i, pitch in enumerate([60, 64, 67, 62])]}
        times = np.arange(0, 10, .02)
        audio = np.zeros((12, len(times)))
        for i, pitch in enumerate([60, 64, 67, 62]):
            audio[pitch % 12, (times >= i + 2) & (times < i + 3)] = 1
        report = diagnose(project, audio, times)
        self.assertEqual(report["status"], "EXPLORATORY_NOT_ACCEPTED")
        self.assertEqual(report["best_affine_hypothesis"]["offset_seconds"], 2)
        self.assertNotIn("alignment", report)
        self.assertNotIn("confirmations", report)
        self.assertEqual(report["sections"][-1]["end_beat"], 4)

    def test_html_cannot_execute_project_id_and_marks_audio_as_reference(self):
        report = {"project_id": "</script><script>alert(1)</script>", "audio_sha256": "a" * 64, "sections": []}
        rendered = render_review(report, 'reference.m4a" onerror="alert(2)')
        self.assertNotIn(report["project_id"], rendered)
        self.assertIn("\\u003c/script>", rendered)
        self.assertIn("reference.m4a&quot; onerror=&quot;alert(2)", rendered)
        self.assertIn("gate_confirmation:null", rendered)


if __name__ == "__main__":
    unittest.main()
