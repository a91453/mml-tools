from __future__ import annotations

import argparse
import json
from pathlib import Path

from .alignment import align_audio_to_project, load_project_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mml-audio-worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    align = subparsers.add_parser("align", help="Align original audio to Canonical project beat time")
    align.add_argument("--audio", required=True, help="Path to user-provided M4A/FLAC/WAV/audio file")
    align.add_argument("--project", required=True, help="Path to Canonical project JSON")
    align.add_argument("--output", required=True, help="Output alignment JSON path")
    align.add_argument("--source-id", action="append", default=None, help="Limit symbolic alignment to one or more source IDs")
    align.add_argument("--sample-rate", type=int, default=22050)
    align.add_argument("--hop-length", type=int, default=512)
    align.add_argument("--score-frames-per-beat", type=int, default=8)
    align.add_argument("--control-step-beats", type=float, default=1.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "align":
        raise RuntimeError("unsupported command")

    project = load_project_json(args.project)
    report = align_audio_to_project(
        args.audio,
        project,
        source_ids=args.source_id,
        sample_rate=args.sample_rate,
        hop_length=args.hop_length,
        score_frames_per_beat=args.score_frames_per_beat,
        control_step_beats=args.control_step_beats,
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
