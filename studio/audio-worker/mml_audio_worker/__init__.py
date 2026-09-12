"""Lightweight original-audio alignment worker for MML Studio."""

from .alignment import align_audio_to_project, build_symbolic_chroma, align_feature_sequences

__all__ = ["align_audio_to_project", "build_symbolic_chroma", "align_feature_sequences"]
