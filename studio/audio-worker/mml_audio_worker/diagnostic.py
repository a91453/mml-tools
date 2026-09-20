"""Tempo-preserving hypotheses for reviewing failed DTW; never gate evidence."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import shutil
import tempfile
from fractions import Fraction
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.ndimage import gaussian_filter1d

from .alignment import _audio_chroma, _decode_with_ffmpeg, _note_events


def constant_tempo(project: dict) -> float:
    events = sorted(project.get("tempoEvents", []), key=lambda e: Fraction(str(e["beat"])))
    if not events or Fraction(str(events[0]["beat"])) != 0:
        raise ValueError("diagnostic requires an explicit tempo at beat zero")
    bpms = [float(e["bpm"]) for e in events]
    if any(not math.isfinite(bpm) or bpm <= 0 for bpm in bpms):
        raise ValueError("tempo must be positive and finite")
    if any(bpm != bpms[0] for bpm in bpms):
        raise ValueError("constant-tempo diagnostic does not support tempo changes")
    return bpms[0]


def section_ranges(end_beat: float, step: float = 32) -> list[tuple[float, float]]:
    if not math.isfinite(end_beat) or end_beat <= 0 or not math.isfinite(step) or step <= 0:
        raise ValueError("section bounds must be positive and finite")
    return [(float(start), min(float(start + step), end_beat)) for start in np.arange(0, end_beat, step)]


def search_affine(score, score_times, audio, audio_times, offsets, scales):
    """Compare every active score frame; never reward dropping the tail/prefix."""
    active = np.linalg.norm(score, axis=0) > 1e-12
    if not np.any(active):
        raise ValueError("search window contains no sounding notes")
    candidates = []
    for scale in scales:
        for offset in offsets:
            times = offset + score_times[active] * scale
            if times[0] < audio_times[0] or times[-1] > audio_times[-1]:
                continue
            sampled = np.array([np.interp(times, audio_times, row) for row in audio])
            similarity = np.sum(score[:, active] * sampled, axis=0).mean()
            candidates.append({"similarity": float(similarity), "offset_seconds": round(float(offset), 6),
                               "time_scale": round(float(scale), 6)})
    if not candidates:
        raise ValueError("search bounds cannot fit all active symbolic frames inside audio")
    return sorted(candidates, key=lambda item: -item["similarity"])


def diagnose(project, chroma, audio_times):
    bpm = constant_tempo(project)
    notes = _note_events(project)
    if not notes:
        raise ValueError("project contains no notes")
    end_beat = max(float(Fraction(e["end"])) for e in notes)
    score_times = np.arange(0, end_beat * 60 / bpm, .1)
    score = np.zeros((12, len(score_times)))
    for event in notes:
        start, end = (float(Fraction(event[key])) * 60 / bpm for key in ("start", "end"))
        pitch = event["pitch"]
        if not isinstance(pitch, int) or not 0 <= pitch <= 127 or start < 0 or end <= start:
            raise ValueError("invalid symbolic note")
        score[pitch % 12, (score_times >= start) & (score_times < end)] += 1
    score = gaussian_filter1d(score, .7, axis=1)
    score /= np.maximum(np.linalg.norm(score, axis=0, keepdims=True), 1e-12)
    audio = gaussian_filter1d(chroma, 2, axis=1)
    audio /= np.maximum(np.linalg.norm(audio, axis=0, keepdims=True), 1e-12)
    candidates = search_affine(score, score_times, audio, audio_times,
                               np.arange(-5, 20.01, .25), np.arange(.94, 1.061, .01))
    best = candidates[0]
    sections = []
    for start, end in section_ranges(end_beat):
        selected = (score_times >= start * 60 / bpm) & (score_times < end * 60 / bpm)
        entry = {"start_beat": start, "end_beat": end,
                 "projected_start_seconds": round(best["offset_seconds"] + start * 60 / bpm * best["time_scale"], 6),
                 "projected_end_seconds": round(best["offset_seconds"] + end * 60 / bpm * best["time_scale"], 6)}
        if not np.any(np.linalg.norm(score[:, selected], axis=0) > 1e-12):
            entry["status"] = "NO_SOUNDING_FRAMES"
        else:
            local = search_affine(score[:, selected], score_times[selected], audio, audio_times,
                                  np.arange(-5, 20.01, .1), [best["time_scale"]])
            global_fit = search_affine(score[:, selected], score_times[selected], audio, audio_times,
                                       [best["offset_seconds"]], [best["time_scale"]])[0]
            entry.update({"status": "UNREVIEWED", "best_local": local[0], "global_fit": global_fit,
                          "offset_disagreement_seconds": round(local[0]["offset_seconds"] - best["offset_seconds"], 6)})
        sections.append(entry)
    return {"schema": "mml-studio/tempo-alignment-diagnostic@1", "status": "EXPLORATORY_NOT_ACCEPTED",
            "project_id": project.get("id"), "bpm": bpm, "end_beat": end_beat,
            "search": {"offset_seconds": [-5, 20], "offset_step": .25, "scale": [.94, 1.06], "scale_step": .01,
                       "pitch_shift": 0, "score_step_seconds": .1, "section_step_beats": 32,
                       "note_weight": "uniform", "gaussian_sigma_frames": {"score": .7, "audio": 2}},
            "best_affine_hypothesis": best, "sections": sections,
            "notice": "Search bounds are diagnostic choices, not acceptance thresholds. Repeated music can be ambiguous. "
                      "No listening, Lead identity, pitch accuracy, Mobile audibility or acceptance gate is verified."}


def render_review(report: dict, audio_name: str) -> str:
    rows = []
    for index, section in enumerate(report["sections"]):
        start, end = section["projected_start_seconds"], section["projected_end_seconds"]
        local = section.get("best_local", {})
        rows.append(f'<tr><td data-label="Beat">{section["start_beat"]:g}–{section["end_beat"]:g}</td>'
                    f'<td data-label="推估錄音範圍">{start:.2f}–{end:.2f}s</td><td data-label="局部最佳偏移(s)">{local.get("offset_seconds", "—")}</td>'
                    f'<td data-label="與全曲偏移差(s)">{section.get("offset_disagreement_seconds", "—")}</td>'
                    f'<td><button data-start="{max(0, start)}" data-end="{end}">播放這段</button></td>'
                    f'<td data-label="人工紀錄"><textarea data-section="{index}" aria-label="第 {index + 1} 段聽驗紀錄" '
                    'placeholder="起點是否吻合？有無重複段歧義？主旋律／伴奏依據？"></textarea></td></tr>')
    # Escape script delimiters even when project IDs are user-controlled.
    payload = json.dumps(report, ensure_ascii=False).replace("<", "\\u003c")
    return '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M4A 段落審查</title><style>body{font:16px system-ui;margin:24px auto;padding:0 16px;max-width:1100px;background:#f4f6f8;color:#172330}
table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border:1px solid #ccd5df;text-align:left}textarea{box-sizing:border-box;min-width:180px;min-height:65px;width:100%}button{padding:10px;cursor:pointer;white-space:nowrap}audio{width:100%}.scroll{overflow:auto}.notice{background:#fff3cd;padding:16px;line-height:1.7}code{overflow-wrap:anywhere}
@media(max-width:600px){thead{display:none}table,tbody{display:block;background:transparent}tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));background:white;border:1px solid #ccd5df;margin-bottom:16px}td{display:block;border:0;padding:10px}td[data-label]:before{content:attr(data-label);display:block;font-size:12px;color:#586576;margin-bottom:6px}td:nth-last-child(-n+2){grid-column:1/-1}textarea{min-width:0;min-height:95px}.scroll{overflow:visible}}</style>
<h1>M4A 段落審查</h1><p class="notice">待審查假設：以下時間由固定速度／起始偏移搜尋推估；不能當作已驗證對齊。
請特別核對局部偏移不同的段落與曲尾。色度比對不能判定 Vocal 或精確音高。
本頁播放原始 M4A，不是鋼琴編曲或遊戲內試奏。填寫後請下載紀錄；重新整理會清空未下載內容。本頁不提交任何 gate。</p>
<p>審查情境：''' + html.escape(report.get("review_context") or "尚未指定；請依實際目標樂器與演奏方式核對。") + '''</p>
<p>Audio SHA-256: <code>''' + html.escape(report["audio_sha256"]) + '''</code></p>
<audio controls preload="metadata" src="''' + html.escape(audio_name, quote=True) + '''"></audio>
<p><button id="export">下載本次段落聽驗紀錄</button></p><div class="scroll"><table><thead><tr><th>Beat</th><th>推估錄音範圍</th><th>局部最佳偏移(s)</th><th>與全曲偏移差(s)</th><th>原音</th><th>人工紀錄</th></tr></thead><tbody>''' + "".join(rows) + '''</tbody></table></div>
<script>const report=''' + payload + ''';
const audio=document.querySelector('audio');let stopAt=null;
document.querySelectorAll('[data-start]').forEach(button=>button.onclick=()=>{stopAt=Number(button.dataset.end);audio.currentTime=Number(button.dataset.start);audio.play().catch(error=>alert(error.message));});
audio.addEventListener('timeupdate',()=>{if(stopAt!==null&&audio.currentTime>=stopAt){audio.pause();stopAt=null;}});
document.getElementById('export').onclick=()=>{const notes=[...document.querySelectorAll('textarea')].map(input=>({section:report.sections[Number(input.dataset.section)],note:input.value.trim()}));
const result={schema:'mml-studio/section-listening-notes@1',status:'REVIEW_NOTES_ONLY',audio_sha256:report.audio_sha256,project_sha256:report.project_sha256,created_at:new Date().toISOString(),notes,gate_confirmation:null};
const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)+'\\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='section-listening-notes.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};</script></html>'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--out", required=True, help="New local output directory; includes a private copy of audio")
    parser.add_argument("--review-context", help="User-provided instrument/performance intent; not a review conclusion")
    args = parser.parse_args(argv)
    source, project_path, out = Path(args.audio), Path(args.project), Path(args.out)
    # Never overwrite a previous review or original source.
    out.mkdir(parents=False, exist_ok=False)
    project_bytes = project_path.read_bytes()
    project = json.loads(project_bytes)
    constant_tempo(project)
    audio_name = "reference" + source.suffix.lower()
    copied = out / audio_name
    shutil.copyfile(source, copied)
    audio_hash = hashlib.sha256(copied.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="mml-diagnostic-") as directory:
        decoded = Path(directory) / "decoded.wav"
        _decode_with_ffmpeg(copied, decoded, 22050)
        y, sr = sf.read(decoded, dtype="float32")
        chroma = _audio_chroma(y, sr, 512)
        audio_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=512)
        report = diagnose(project, chroma, audio_times)
        report.update({"audio_sha256": audio_hash, "project_sha256": hashlib.sha256(project_bytes).hexdigest(),
                       "audio_duration_seconds": len(y) / sr, "review_context": args.review_context})
    (out / "diagnostic.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    (out / "review.html").write_text(render_review(report, audio_name), encoding="utf8")
    print(json.dumps({"status": report["status"], "best": report["best_affine_hypothesis"], "sections": len(report["sections"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
