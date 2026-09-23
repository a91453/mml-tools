// Studio Workshop ⇄ Studio Web MML conversion (pure; no DOM).
//
// The two parsers agree on named notes (o4c = MIDI 60) but not on `n`:
// the Workshop reads nN as MIDI N+12 (n48 = o4c), Studio reads NN as MIDI NN
// (N60 = o4c). Which one the game uses is still open (LG-1 in
// docs/FRONTEND_FUSION_ANALYSIS_2026-09-23.md). Crossing between the two pages
// therefore rewrites every `n` so the *pitch* each page plays and analyses is
// the same; nothing else in the text is re-spelled.
//
// Towards Studio the Workshop dialect is also narrowed to what Studio's
// parser reads: `h` → `b`, `p` → `r`, `#` → `+`, `@n` and unreadable
// characters dropped, `..` rewritten by the Workshop's own game-safe pass.
// Studio then runs its own technical validation; nothing here is a check.
import { compact, scanTokens, splitMML, stripPrograms, bareTrack } from "./mml.mjs";
import { gameSafeTrack } from "./mml-compress.mjs";
import { GAME_TRACKS } from "./config.mjs";

// Studio's N value minus the Workshop's n value, for the same MIDI pitch.
export const N_OFFSET = 12;

export function rewriteTrack(text, { nDelta = 0, toStudio = false } = {}) {
  const { t } = compact(String(text ?? ""));
  let out = "";
  const warnings = [];
  for (const tok of scanTokens(t)) {
    const slice = t.slice(tok.a, tok.b);
    if (tok.kind === "n" && tok.pitch !== null && nDelta) {
      const v = tok.pitch + nDelta;
      if (v < 0) { warnings.push("N_OUT_OF_RANGE"); out += slice; continue; }
      out += `n${v}${t.slice(tok.pitchEnd, tok.b)}`;
      warnings.push("N_REWRITTEN");
    } else if (toStudio && tok.kind === "note") {
      const letter = t[tok.a] === "h" ? "b" : t[tok.a];
      out += letter + t.slice(tok.a + 1, tok.accEnd).replaceAll("#", "+") + t.slice(tok.accEnd, tok.b);
    } else if (toStudio && tok.kind === "rest") {
      out += `r${t.slice(tok.a + 1, tok.b)}`;
    } else if (toStudio && tok.kind === "prog") {
      continue;
    } else if (toStudio && tok.kind === "bad") {
      warnings.push("UNREADABLE_DROPPED");
    } else out += slice;
  }
  return { text: out, warnings: [...new Set(warnings)] };
}

// The six game tracks as one Studio-readable MML string (always six slots).
export function workshopToStudio(texts) {
  const warnings = [];
  const parts = [];
  for (let i = 0; i < GAME_TRACKS; i++) {
    let bare = stripPrograms(bareTrack(texts?.[i] ?? ""));
    if (!bare) { parts.push(""); continue; }
    const safe = gameSafeTrack(bare);
    if (safe.error) warnings.push({ track: i, code: "GAME_SAFE_FAILED", detail: safe.error });
    else {
      bare = safe.text;
      if (safe.warning) warnings.push({ track: i, code: "NONSTANDARD_LENGTH_KEPT" });
    }
    const r = rewriteTrack(bare, { nDelta: N_OFFSET, toStudio: true });
    for (const code of r.warnings) warnings.push({ track: i, code });
    parts.push(r.text);
  }
  const dropped = [];
  (texts ?? []).slice(GAME_TRACKS).forEach((t, k) => { if (bareTrack(t ?? "")) dropped.push(GAME_TRACKS + k); });
  return { mml: `MML@${parts.join(",")};`, warnings, dropped };
}

// A Studio MML string as Workshop text (one part per track).
export function studioToWorkshop(mml) {
  const warnings = [];
  const parts = splitMML(String(mml ?? "")).map((part, i) => {
    const r = rewriteTrack(part, { nDelta: -N_OFFSET });
    for (const code of r.warnings) warnings.push({ track: i, code });
    return r.text;
  });
  return { mml: `MML@${parts.join(",")};`, parts, warnings };
}
