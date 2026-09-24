// Studio Workshop ⇄ Studio Web MML conversion (pure; no DOM).
//
// The two parsers agree on named notes (o4c = MIDI 60) but not on `n`:
// the Workshop reads nN as MIDI N+12 (n48 = o4c), Studio reads NN as MIDI NN
// (N60 = o4c). Which one the game uses is still open (LG-1 in
// docs/FRONTEND_FUSION_ANALYSIS_2026-09-23.md). Crossing between the two pages
// therefore rewrites every `n` so the *pitch* each page plays and analyses is
// the same.
//
// Opening (Studio → Workshop) re-spells nothing else, with one exception:
// Studio's N0–N11 lie below every Workshop `n` (n0 is already MIDI 12), so
// each is written as the octave −1 named note of the same MIDI pitch (`o0<`,
// and the octave is put back before the next named note). The Workshop plays
// those folded into its range, as it plays every note outside o1c–o7b; sent
// back, they return to Studio as the same N0–N11.
//
// Sending (Workshop → Studio) narrows the Workshop dialect to what Studio's
// parser (studio/backend/mml/parser.mjs, parseTrack in mode 'ingest') reads,
// keeping the notes and timing the Workshop plays:
//   - `..` is first rewritten by the Workshop's own game-safe pass;
//   - an absolute `o` is written before the first named note (the Workshop
//     starts at o4 and a relative > < may come first; Studio requires an O),
//     and wherever Studio's octave would otherwise differ from the Workshop's;
//   - a dotted default length `lN.` is sent as `lN`, and each note or rest
//     that relied on its dot carries the full length (`c` → `cN.`);
//   - a dotted `nX.` (Studio's N takes its length from L and has no dot) is
//     sent as the named note of the same pitch and length;
//   - `h` → `b`, `p` → `r`, `#` → `+`, several accidentals → one spelling;
//   - `@n`, unreadable characters, commands without a number, ties the
//     Workshop does not hold and a second tempo at one point are dropped, and
//     tempo and volume are clamped as the Workshop clamps them.
// Each sent track is then read back with a mirror of Studio's reading
// (readAsStudio) and compared with what the Workshop plays; a track that
// still differs is sent with a warning, never silently. That is a check of
// this conversion only: Studio runs its own technical validation, and
// nothing here is one.
import { compact, scanTokens, splitMML, stripPrograms, bareTrack, lenTicks, parseTrack as playTrack } from "./mml.mjs";
import { gameSafeTrack } from "./mml-compress.mjs";
import { GAME_TRACKS, OCT_BASE, N_BASE, PPQ, foldIntoRange } from "./config.mjs";
import { clamp } from "./util.mjs";

// Studio's N value minus the Workshop's n value, for the same MIDI pitch.
export const N_OFFSET = 12;

// The limits Studio's parser applies (the effective ruleset's mobileSyntax).
// Mirrored rather than imported: the Workshop does not load Studio's Canonical
// modules. studio/tests/workshop-bridge.test.mjs holds these to the ruleset
// and readAsStudio to the parser itself.
export const STUDIO_SYNTAX = Object.freeze({
  octaveMin: 0, octaveMax: 8,
  lengthMin: 1, lengthMax: 64,
  tempoMin: 32, tempoMax: 255,
  volumeMin: 0, volumeMax: 15,
  numericNoteMin: 0, numericNoteMax: 107,
});

// Every code workshopToStudio reports; the send box shows each through
// studio.warn.<code>. (Opening reports N_REWRITTEN and N_BELOW_WORKSHOP_RANGE,
// shown as studio.nWarning and studio.nLowWarning.)
export const SEND_WARNING_CODES = Object.freeze([
  "GAME_SAFE_FAILED", "NONSTANDARD_LENGTH_KEPT", "N_REWRITTEN", "UNREADABLE_DROPPED", "IGNORED_DROPPED",
  "PITCH_FOLDED", "PITCH_OUTSIDE_WORKSHOP_RANGE", "STUDIO_SYNTAX_ERROR", "STUDIO_READS_DIFFERENTLY",
]);

const SPELL = ["c", "c+", "d", "d+", "e", "f", "f+", "g", "g+", "a", "a+", "b"];
const octaveOf = midi => Math.floor((midi - OCT_BASE) / 12);
const studioOctave = o => o >= STUDIO_SYNTAX.octaveMin && o <= STUDIO_SYNTAX.octaveMax;
const studioNumeric = p => p >= STUDIO_SYNTAX.numericNoteMin && p <= STUDIO_SYNTAX.numericNoteMax;
// A pitch Studio can be given at all: as a named note in O0–O8, or as an N.
const studioPitch = p => studioOctave(octaveOf(p)) || studioNumeric(p);

// One Workshop track as Studio-readable text. Pure; see the header.
export function trackToStudio(text) {
  const { t } = compact(String(text ?? ""));
  const out = [];
  const warnings = new Set();
  // The Workshop's reading of its own text.
  let wOct = 4, defLen = 4, defDots = 0, tick = 0, tempoTick = -1;
  // Studio's reading of the text written so far.
  let sOct = 4, sExplicit = false, sLen = 4;
  let run = null;   // octave commands not yet written
  let tieAt = -1;   // out[] slot of a `&` not yet known to be held
  let last = null;  // the note just written, until a rest: { plays, reads }

  const setOctave = o => {
    if (sExplicit && sOct === o) return;
    out.push(`o${o}`);
    sOct = o;
    sExplicit = true;
  };
  // A run of o / > / < is written as it stands when Studio reads it to the
  // Workshop's octave without leaving O0–O8 (and with an O, before the first
  // named note); otherwise as one absolute `o`, or not at all when the octave
  // is outside Studio's range (the notes there are then re-spelled).
  const flush = atEnd => {
    if (!run) return;
    const r = run;
    run = null;
    if (r.ok && r.sim === wOct && (sExplicit || r.abs)) {
      out.push(r.text);
      sOct = wOct;
      sExplicit = true;
    } else if (!atEnd && studioOctave(wOct)) {
      out.push(`o${wOct}`);
      sOct = wOct;
      sExplicit = true;
    }
  };
  const octave = (tok, slice) => {
    run ??= { text: "", sim: sOct, ok: true, abs: false };
    if (tok.kind === "o") {
      wOct = run.sim = tok.num;
      run.abs = true;
    } else {
      wOct += tok.dir;
      run.sim += tok.dir;
    }
    run.ok &&= studioOctave(run.sim);
    run.text += slice;
  };

  // The length as the Workshop reads it, spelled so Studio's L (always the
  // undotted Workshop L) gives the same: a dotted default L is written out.
  const lengthText = tok =>
    tok.num !== null ? `${Math.max(1, tok.num)}${".".repeat(tok.dots)}`
      : tok.dots ? ".".repeat(tok.dots)
        : defDots ? `${defLen}${".".repeat(defDots)}` : "";
  const ticksOf = tok =>
    tok.num !== null ? lenTicks(tok.num, tok.dots) : lenTicks(defLen, tok.dots || defDots);

  // The Workshop holds a tie only into the same pitch straight after a note.
  const settleTie = (plays, reads) => {
    if (tieAt < 0) return;
    if (last && last.plays === plays) {
      if (last.reads === reads) out[tieAt] = "&";
    } else warnings.add("IGNORED_DROPPED");
    tieAt = -1;
  };

  // Studio's N has no length or dot of its own: one tied N per dotted part,
  // each under its own L, and L put back afterwards.
  const numeric = (pitch, tok) => {
    const base = tok.num !== null ? Math.max(1, tok.num) : defLen;
    const dots = tok.num !== null ? tok.dots : tok.dots || defDots;
    let s = "";
    for (let k = 0; k <= dots; k++) {
      if (k) s += "&";
      const part = base * 2 ** k;
      if (part !== sLen) { s += `l${part}`; sLen = part; }
      s += `n${pitch}`;
    }
    if (sLen !== defLen) { s += `l${defLen}`; sLen = defLen; }
    out.push(s);
  };

  // A note the Workshop plays: kept as written when Studio reads that
  // spelling at the same pitch, otherwise re-spelled from the pitch itself.
  const note = (tok, written, asWritten) => {
    const plays = foldIntoRange(written);
    let reads = written;
    if (!asWritten && !studioPitch(written)) { reads = plays; warnings.add("PITCH_FOLDED"); }
    settleTie(plays, reads);
    if (asWritten) {
      setOctave(wOct);
      out.push(asWritten + lengthText(tok));
    } else if (studioOctave(octaveOf(reads))) {
      setOctave(octaveOf(reads));
      out.push(SPELL[reads % 12] + lengthText(tok));
    } else numeric(reads, tok);
    last = { plays, reads };
    tick += ticksOf(tok);
  };

  for (const tok of scanTokens(t)) {
    const slice = t.slice(tok.a, tok.b);
    if (tok.kind === "o" || tok.kind === "oct") {
      if (tok.kind === "o" && tok.num === null) warnings.add("UNREADABLE_DROPPED");
      else octave(tok, slice);
      continue;
    }
    flush(false);
    if (tok.kind === "note") {
      const acc = t.slice(tok.a + 1, tok.accEnd);
      const letter = t[tok.a] === "h" ? "b" : t[tok.a];
      const asWritten = acc.length <= 1 && studioOctave(wOct) ? letter + acc.replace("#", "+") : null;
      note(tok, wOct * 12 + OCT_BASE + tok.semi, asWritten);
    } else if (tok.kind === "n") {
      if (tok.pitch === null) { warnings.add("UNREADABLE_DROPPED"); continue; }
      const written = N_BASE + tok.pitch;
      warnings.add("N_REWRITTEN");
      if (!(tok.dots || defDots) && studioNumeric(written)) {
        const plays = foldIntoRange(written);
        settleTie(plays, written);
        out.push(`n${written}`);
        last = { plays, reads: written };
        tick += ticksOf(tok);
      } else note(tok, written, null);
    } else if (tok.kind === "rest") {
      if (tieAt >= 0) { warnings.add("IGNORED_DROPPED"); tieAt = -1; }
      out.push(`r${lengthText(tok)}`);
      last = null;
      tick += ticksOf(tok);
    } else if (tok.kind === "tie") {
      if (tieAt < 0) { tieAt = out.length; out.push(""); }
    } else if (tok.kind === "l") {
      if (tok.num === null) { warnings.add("UNREADABLE_DROPPED"); continue; }
      defLen = Math.max(1, tok.num);
      defDots = tok.dots;
      out.push(`l${defLen}`);
      sLen = defLen;
    } else if (tok.kind === "t") {
      if (tok.num === null) warnings.add("UNREADABLE_DROPPED");
      else if (tick === tempoTick) warnings.add("IGNORED_DROPPED");
      else { tempoTick = tick; out.push(`t${clamp(tok.num, 32, 255)}`); }
    } else if (tok.kind === "v") {
      if (tok.num === null) warnings.add("UNREADABLE_DROPPED");
      else out.push(`v${clamp(tok.num, 0, 15)}`);
    } else if (tok.kind === "bad") warnings.add("UNREADABLE_DROPPED");
    // `prog` (@n): the instrument is not part of Studio's MML.
  }
  flush(true);
  if (tieAt >= 0) warnings.add("IGNORED_DROPPED");
  return { text: out.join(""), warnings: [...warnings] };
}

// One Studio track as Workshop text: only `n` changes (see the header).
export function trackToWorkshop(text) {
  const { t } = compact(String(text ?? ""));
  let out = "";
  const warnings = new Set();
  let oct = 4;    // the octave the Studio text sets (both pages agree on o > <)
  let shown = 4;  // the octave the Workshop text is left at
  const restore = () => {
    if (shown === oct) return;
    out += oct >= 0 ? `o${oct}` : "<".repeat(shown - oct);
    shown = oct;
  };
  for (const tok of scanTokens(t)) {
    const slice = t.slice(tok.a, tok.b);
    if (tok.kind === "o") {
      if (tok.num !== null) oct = shown = tok.num;
      out += slice;
    } else if (tok.kind === "oct") {
      restore();
      oct += tok.dir;
      shown = oct;
      out += slice;
    } else if (tok.kind === "note") {
      restore();
      out += slice;
    } else if (tok.kind === "n" && tok.pitch !== null) {
      const v = tok.pitch - N_OFFSET;
      const tail = t.slice(tok.pitchEnd, tok.b);
      if (v >= 0) {
        out += `n${v}${tail}`;
        warnings.add("N_REWRITTEN");
      } else {
        if (shown !== -1) { out += shown === 0 ? "<" : "o0<"; shown = -1; }
        out += SPELL[tok.pitch] + tail;
        warnings.add("N_BELOW_WORKSHOP_RANGE");
      }
    } else out += slice;
  }
  return { text: out, warnings: [...warnings] };
}

// ─── Studio's reading, mirrored for the conversion check ───────────────────
// parseTrack in studio/backend/mml/parser.mjs, mode 'ingest': the same
// errors (by kind, not wording) and the same note events, times in beats as
// exact fractions ("7/4"). Warnings, controls and the Final-only rules are
// left out: they never decide what is read.
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; };
const frac = (n, d) => { const g = gcd(n, d) || 1n; return { n: n / g, d: d / g }; };
const plus = (x, y) => frac(x.n * y.d + y.n * x.d, x.d * y.d);
const same = (x, y) => x.n === y.n && x.d === y.d;
const beats = x => (x.d === 1n ? String(x.n) : `${x.n}/${x.d}`);
const NOTE_BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function readAsStudio(raw) {
  const S = STUDIO_SYNTAX;
  const text = String(raw ?? "").toLowerCase();
  const errors = [];
  const notes = [];
  let i = 0, time = frac(0n, 1n), octave = 4, explicit = false, length = 4, trusted = true;
  let pending = false, lastWasNote = false, lastTempo = null;
  const fail = code => errors.push(code);
  const inLength = v => Number.isSafeInteger(v) && v >= S.lengthMin && v <= S.lengthMax;
  const invalidate = () => { pending = false; lastWasNote = false; };
  const digits = () => {
    const m = /^\d+/.exec(text.slice(i));
    if (m) i += m[0].length;
    return m ? m[0] : null;
  };
  const duration = (den, dots) => {
    const k = BigInt(Math.min(dots, 8));
    return frac(4n * (2n ** (k + 1n) - 1n), BigInt(den) * 2n ** k);
  };
  const append = (pitch, dur) => {
    const end = plus(time, dur);
    const prev = notes.at(-1);
    if (pending && prev && prev.pitch === pitch && same(prev.end, time)) prev.end = end;
    else {
      if (pending) fail("TIE_PITCH_OR_GAP");
      notes.push({ pitch, start: time, end });
    }
    pending = false;
    lastWasNote = true;
    time = end;
  };

  if (/\s/.test(text)) fail("WHITESPACE");
  while (i < text.length) {
    const ch = text[i++];
    if (/\s/.test(ch)) continue;
    if ("tolv".includes(ch)) {
      const d = digits();
      if (d === null) { fail("VALUE_MISSING"); continue; }
      const v = Number(d);
      if (ch === "t") {
        if (v < S.tempoMin || v > S.tempoMax) fail("TEMPO_OUT_OF_RANGE");
        if (lastTempo && same(lastTempo, time)) fail("TEMPO_ORDER");
        lastTempo = time;
      } else if (ch === "o") {
        octave = v;
        explicit = true;
        if (!studioOctave(v)) fail("OCTAVE_OUT_OF_RANGE");
      } else if (ch === "l") {
        if (inLength(v)) { length = v; trusted = true; } else { trusted = false; fail("LENGTH_OUT_OF_RANGE"); }
      } else if (v < S.volumeMin || v > S.volumeMax) fail("VOLUME_OUT_OF_RANGE");
      continue;
    }
    if (ch === "<" || ch === ">") {
      octave += ch === ">" ? 1 : -1;
      if (!studioOctave(octave)) fail("OCTAVE_OUT_OF_RANGE");
      continue;
    }
    if (ch === "&") {
      if (pending || !lastWasNote || !notes.length || !same(notes.at(-1).end, time)) fail("TIE_WITHOUT_NOTE");
      pending = true;
      continue;
    }
    if (ch === "n") {
      const d = digits();
      const pitch = Number(d);
      if (d === null || !Number.isSafeInteger(pitch) || !studioNumeric(pitch) || !trusted || !inLength(length)) {
        fail("NUMERIC_NOTE");
        invalidate();
        continue;
      }
      append(pitch, duration(length, 0));
      continue;
    }
    if (ch in NOTE_BASE || ch === "r") {
      let accidental = 0;
      if (ch !== "r" && ["+", "#", "-"].includes(text[i])) { accidental = text[i] === "-" ? -1 : 1; i++; }
      const d = digits();
      if (d === null && !trusted) { fail("DEFAULT_LENGTH_INVALID"); invalidate(); continue; }
      const den = d !== null ? Number(d) : length;
      let dots = 0;
      while (text[i] === ".") { dots++; i++; }
      if (!inLength(den)) { fail("LENGTH_OUT_OF_RANGE"); invalidate(); continue; }
      const dur = duration(den, dots);
      if (ch === "r") {
        if (pending) fail("TIE_INTO_REST");
        pending = false;
        lastWasNote = false;
        time = plus(time, dur);
      } else {
        if (!explicit) fail("OCTAVE_NOT_SET");
        const pitch = 12 * (octave + 1) + NOTE_BASE[ch] + accidental;
        if (pitch < 0 || pitch > 127) fail("PITCH_OUT_OF_RANGE");
        append(pitch, dur);
      }
      continue;
    }
    fail("UNREADABLE");
    invalidate();
  }
  if (pending) fail("TIE_AT_END");
  return { errors, notes: notes.map(n => ({ pitch: n.pitch, start: beats(n.start), end: beats(n.end) })), total: beats(time) };
}

// Does Studio read `sent` as the Workshop plays `played`? Pitch, onset and
// end of every note; a note outside the Workshop's range is sent at its
// written pitch (the Workshop plays it folded), which is reported apart.
export function checkTrack(played, sent) {
  const read = readAsStudio(sent);
  if (read.errors.length) return ["STUDIO_SYNTAX_ERROR"];
  const plays = playTrack(played, 0, []).notes;
  const at = tick => beats(frac(BigInt(tick), BigInt(PPQ)));
  if (plays.length !== read.notes.length) return ["STUDIO_READS_DIFFERENTLY"];
  let outside = false;
  for (let k = 0; k < plays.length; k++) {
    const a = plays[k], b = read.notes[k];
    if (b.start !== at(a.tick) || b.end !== at(a.tick + a.dur)) return ["STUDIO_READS_DIFFERENTLY"];
    if (b.pitch === a.midi) continue;
    if (foldIntoRange(b.pitch) !== a.midi) return ["STUDIO_READS_DIFFERENTLY"];
    outside = true;
  }
  return outside ? ["PITCH_OUTSIDE_WORKSHOP_RANGE"] : [];
}

// The six game tracks as one Studio-readable MML string (always six slots).
export function workshopToStudio(texts) {
  const warnings = [];
  const parts = [];
  for (let i = 0; i < GAME_TRACKS; i++) {
    const played = stripPrograms(bareTrack(texts?.[i] ?? ""));
    if (!played) { parts.push(""); continue; }
    // The warnings describe the user's own text; the game-safe pass, when it
    // re-spells a `..` track, only decides the text that is sent.
    const own = trackToStudio(played);
    let sent = own;
    const safe = gameSafeTrack(played);
    if (safe.error) warnings.push({ track: i, code: "GAME_SAFE_FAILED", detail: safe.error });
    else {
      if (safe.warning) warnings.push({ track: i, code: "NONSTANDARD_LENGTH_KEPT" });
      if (safe.fixed) sent = trackToStudio(safe.text);
    }
    for (const code of own.warnings) warnings.push({ track: i, code });
    // The game-safe pass writes each note at the pitch the Workshop plays.
    if (sent !== own && checkTrack(played, own.text).includes("PITCH_OUTSIDE_WORKSHOP_RANGE")
      && !own.warnings.includes("PITCH_FOLDED")) warnings.push({ track: i, code: "PITCH_FOLDED" });
    for (const code of checkTrack(played, sent.text)) warnings.push({ track: i, code });
    parts.push(sent.text);
  }
  const dropped = [];
  (texts ?? []).slice(GAME_TRACKS).forEach((t, k) => { if (bareTrack(t ?? "")) dropped.push(GAME_TRACKS + k); });
  return { mml: `MML@${parts.join(",")};`, warnings, dropped };
}

// A Studio MML string as Workshop text (one part per track).
export function studioToWorkshop(mml) {
  const warnings = [];
  const parts = splitMML(String(mml ?? "")).map((part, i) => {
    const r = trackToWorkshop(part);
    for (const code of r.warnings) warnings.push({ track: i, code });
    return r.text;
  });
  return { mml: `MML@${parts.join(",")};`, parts, warnings };
}
