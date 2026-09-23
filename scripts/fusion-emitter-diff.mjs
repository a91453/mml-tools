#!/usr/bin/env node
// Differential harness: "MML 工房" lossless compressor vs the repo Final emitter.
//
// Status: diagnostic tool. It is not a Canonical rule source, not a gate, and
// its findings change nothing by themselves. Context:
// docs/FRONTEND_FUSION_ANALYSIS_2026-09-23.md §11.3 and docs/FINAL_MML_EMITTER.md §2.
//
// The third-party bundle (repository-owner authorized, 2026-09-23) is never
// committed. It is imported at runtime from the directory named by
// MML_WORKSHOP_FE (the folder that contains `js/mml-compress.js`). When that is
// unset or missing, the harness reports SKIPPED — which is not a pass.
//
// What it answers:
//   1. Where does the third-party *lossless* compressor write a shorter string
//      than `studio/backend/final/mml-emitter.mjs` for exactly the same music?
//   2. Which technique buys those characters, and is it legal under the repo's
//      Final rules (parser.mjs `mode: 'final'`)?
//   3. The Nxx / o8 pitch-mapping differences between the two parsers (LG-1).
//
// The judge is ONLY the repo parser (`studio/backend/mml/parser.mjs`): both
// outputs are re-parsed and compared as exact rationals (pitch, start, end,
// volume, tempo map; role end reported separately). The third-party
// `sameEvents` (float, eps = 1e-6, folds pitches into o1c–o7b) is never used as
// the judge.
//
// Third-party compressor configuration — every lossy path is off:
//   * OPT_RULES fill/partial/release (optimizeDurations/optimizeTrack): never called;
//   * repairItems / snap, trimToToken, gameSafeTrack: never called;
//   * dropTrailingRests: false (a trailing rest is part of the role end);
//   * dropSubTrackTempo: false; barsPerLine: 0;
//   * dropDefaultState: true — drops only a leading `v8`, which the repo parser
//     reads as its own default, so the parsed events cannot change;
//   * `n<num>` spelling for savings: the compressor has no option for it, so an
//     in-memory copy of the module is imported with `nSpelling` disabled (the
//     `raw` variant keeps it, only to measure and expose it). Nothing is written
//     to disk.
// Further in-memory ablations (plain default lengths only, no mid-item `l`
// switch) attribute savings to techniques. Each patch must match its anchor
// exactly once or the harness refuses to run, so a changed upstream file cannot
// silently turn a patch into a no-op.
//
// Usage:
//   MML_WORKSHOP_FE=/path/to/frontend-complete-2026-09-14 \
//     node scripts/fusion-emitter-diff.mjs [--json out.json] [--markdown out.md]
//                                          [--only songs|synthetic|nxx] [--strict]
//
// Output goes to stdout unless --json/--markdown name a file. Exit code 0; with
// --strict a SKIPPED run exits 2.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { F, f, ROLES } from '../studio/backend/mml/index.mjs';
import { splitMML, parseTrack } from '../studio/backend/mml/parser.mjs';
import { normalizeMMLSource, mmlFragmentToProject } from '../studio/backend/mml/canonicalize.mjs';
import { emitFinalMml } from '../studio/backend/final/index.mjs';
import { EFFECTIVE_RULESET } from '../studio/backend/rules/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const syntax = EFFECTIVE_RULESET.mobileSyntax;
const PREFERRED = new Set(syntax.preferredLengthDenominators);
const DOTTED_OK = new Set(syntax.preferredDottedBaseDenominators);
const PREFERRED_LIST = [...syntax.preferredLengthDenominators];
// The third-party "standard" set: preferred plus the triplet family. Used only
// for the caution-opt-in comparison, where the repo emitter also admits them.
const TRIPLET_FAMILY = [3, 6, 12, 24, 48];
const FE_BUDGET = 2_000_000;

export const WORKSHOP_ENV = 'MML_WORKSHOP_FE';
export const SONG_REFERENCE_DIR = join(ROOT, 'imports', 'song-reference');

// ── locating and loading the third-party bundle ──────────────────────────────

export function resolveWorkshop(dir = process.env[WORKSHOP_ENV]) {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, reason: `${WORKSHOP_ENV} is not set` };
  const root = resolve(dir.trim());
  for (const rel of ['js/mml-compress.js', 'js/mml.js', 'js/config.js']) {
    const path = join(root, rel);
    if (!existsSync(path)) return { ok: false, reason: `${path} not found` };
  }
  return { ok: true, dir: root };
}

// In-memory patches. `find` must occur exactly once in the upstream file.
export const PATCHES = Object.freeze({
  // Nxx for savings: `nSpelling` always answers "not available".
  noNumericSpelling: {
    find: 'const nSpelling = nt =>',
    replace: 'const nSpelling = nt => null && ',
  },
  // `lN.` default lengths: the repo parser does not accept a dot after `lN`.
  plainDefaultLengthsOnly: {
    find: 'const cands = [...freq.entries()]',
    replace: 'const cands = [...freq.entries()].filter(([k]) => k.endsWith(".0"))',
  },
  // Ablation only: forbid the `b.l32&b` shape (an `l` switch after the first
  // tie segment of an item).
  noMidItemLengthSwitch: {
    find: 'if (!e || e.segs.length < 2) continue;',
    replace: 'continue;',
  },
});

async function importPatched(file, patchNames) {
  let src = readFileSync(file, 'utf8');
  const base = pathToFileURL(dirname(file) + '/').href;
  // A data: module cannot resolve relative specifiers, so they become absolute
  // file: URLs. The patched copy therefore shares mml.js/config.js instances
  // with the stock import.
  src = src.replace(/(\bfrom\s+)(["'])\.\/([^"']+)\2/g, (_, pre, q, path) => `${pre}${q}${new URL(path, base).href}${q}`);
  for (const name of patchNames) {
    const { find, replace } = PATCHES[name];
    const count = src.split(find).length - 1;
    if (count !== 1) throw Error(`patch ${name}: expected exactly one anchor, found ${count}; the third-party file changed`);
    src = src.replace(find, replace);
  }
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

// The variant chain. Each step adds one restriction, so the character delta
// between neighbours is attributable to exactly one technique.
export const FE_VARIANTS = Object.freeze({
  raw: { label: 'stock, Nxx allowed', patches: [], nums: 'std+seen', align: 'none', explicitOctave: false },
  stock: { label: 'lossless, no Nxx', patches: ['noNumericSpelling'], nums: 'std+seen', align: 'none', explicitOctave: false },
  stockOctave: { label: '+ explicit first O', patches: ['noNumericSpelling'], nums: 'std+seen', align: 'none', explicitOctave: true },
  plainL: { label: '+ plain lN only', patches: ['noNumericSpelling', 'plainDefaultLengthsOnly'], nums: 'std+seen', align: 'none', explicitOctave: true },
  final: { label: 'Final lattice', patches: ['noNumericSpelling', 'plainDefaultLengthsOnly'], nums: 'preferred', align: 'grid', explicitOctave: true },
  finalCaution: { label: 'Final lattice + triplets', patches: ['noNumericSpelling', 'plainDefaultLengthsOnly'], nums: 'preferred+triplets', align: 'none', explicitOctave: true },
  finalNoMid: { label: 'Final lattice, no mid-item l', patches: ['noNumericSpelling', 'plainDefaultLengthsOnly', 'noMidItemLengthSwitch'], nums: 'preferred', align: 'grid', explicitOctave: true },
});

export async function loadWorkshop(dir) {
  const compressFile = join(dir, 'js', 'mml-compress.js');
  const mml = await import(pathToFileURL(join(dir, 'js', 'mml.js')).href);
  const stock = await import(pathToFileURL(compressFile).href);
  const modules = new Map();
  const variants = {};
  for (const [name, variant] of Object.entries(FE_VARIANTS)) {
    const key = variant.patches.join('+') || 'stock';
    if (!modules.has(key)) modules.set(key, variant.patches.length ? await importPatched(compressFile, variant.patches) : stock);
    variants[name] = { ...variant, module: modules.get(key) };
  }
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  return {
    dir,
    mml,
    stock,
    variants,
    provenance: {
      'js/mml-compress.js': sha(compressFile),
      'js/mml.js': sha(join(dir, 'js', 'mml.js')),
      'js/config.js': sha(join(dir, 'js', 'config.js')),
    },
  };
}

// ── third-party emission (lossless configuration) ───────────────────────────

function tieSegmentCap(items, lenTicks) {
  // Same sizing as the compressor's own writeTieSegs(mergeRests(items)).
  let longest = 0;
  let run = 0;
  for (const item of items) {
    if (item.k === 'rest') run += item.dur;
    else run = 0;
    if (item.k === 'note' || item.k === 'rest') longest = Math.max(longest, item.k === 'rest' ? run : item.dur);
  }
  return Math.min(24, Math.max(8, 3 + Math.ceil(longest / lenTicks(1, 1))));
}

/** First note must carry an explicit `oN` in Final. Conservative post-fix: it
 * can only lengthen the third-party output, never shorten it. */
export function ensureExplicitOctave(text) {
  const match = /[a-g]/.exec(text);
  if (!match) return { text, added: 0 };
  const before = text.slice(0, match.index);
  if (/o\d/.test(before)) return { text, added: 0 };
  const net = (before.match(/>/g) ?? []).length - (before.match(/</g) ?? []).length;
  const out = `${before.replace(/[<>]/g, '')}o${4 + net}${text.slice(match.index)}`;
  return { text: out, added: out.length - text.length };
}

export function feEmitRole(workshop, variantName, roleText) {
  const variant = workshop.variants[variantName];
  const mod = variant.module;
  const { lenTicks } = workshop.mml;
  if (!roleText) return { ok: true, mml: '', ms: 0 };
  const started = performance.now();
  const tokenized = mod.trackToItems(roleText);
  if (tokenized.error) return { ok: false, error: String(tokenized.error) };
  const { items } = tokenized;
  const nums = variant.nums === 'preferred'
    ? PREFERRED_LIST
    : variant.nums === 'preferred+triplets'
      ? [...PREFERRED_LIST, ...TRIPLET_FAMILY]
      : mod.encoderNums(tokenized.seenNums);
  const cfg = mod.makeEncoderCfg({
    allowedNums: nums,
    maxDots: 1,
    maxTieSegsMax: tieSegmentCap(items, lenTicks),
    budget: FE_BUDGET,
    // On the 1/64 grid every preferred plain and dotted token survives except
    // `64.` (45 ticks), which is exactly the one Final forbids.
    alignTo: variant.align === 'grid' ? lenTicks(64, 0) : 1,
  });
  let out = mod.itemsToMML(items, {
    cfg,
    dropTrailingRests: false,
    dropDefaultState: true,
    dropSubTrackTempo: false,
    barsPerLine: 0,
    isFirstTrack: true,
  });
  const ms = Math.round(performance.now() - started);
  if (out === null) return { ok: false, error: cfg.exhausted ? 'budget-exhausted' : 'uncodable', ms };
  let octaveFix = 0;
  if (variant.explicitOctave) ({ text: out, added: octaveFix } = ensureExplicitOctave(out));
  return { ok: true, mml: out, ms, exhausted: !!cfg.exhausted, droppedChars: tokenized.dropped, octaveFix };
}

// ── repo side ────────────────────────────────────────────────────────────────

export function repoEmit(mml, { sourceId = 'fusion-diff' } = {}) {
  const fragment = normalizeMMLSource(mml, { sourceId, meterText: '' });
  const project = mmlFragmentToProject(fragment);
  const attempts = [];
  for (const options of [{}, { cautionLengthOptIn: true }]) {
    const started = performance.now();
    const result = emitFinalMml(project, options);
    attempts.push({
      options,
      status: result.status,
      ms: Math.round(performance.now() - started),
      codes: [...new Set(result.diagnostics.filter(d => d.severity === 'error').map(d => d.code))],
    });
    if (result.status === 'PASS') {
      return {
        ok: true,
        options,
        roles: result.roles.map(role => role.mml ?? ''),
        attempts,
      };
    }
  }
  return { ok: false, roles: null, attempts };
}

// Some parser findings carry no code. The harness labels them (prefix `~`) so
// the report can say which rule fired; the labels are not repo codes.
const UNCODED_LABELS = [
  [/首音前必須明確設定O八度/, '~FIRST_NOTE_OCTAVE_UNSET'],
  [/無法辨識字元/, '~UNRECOGNIZED_CHARACTER'],
  [/延音/, '~TIE_STRUCTURE'],
  [/Tempo/, '~TEMPO_ORDER'],
];
const errorLabel = error => error.code
  ?? UNCODED_LABELS.find(([pattern]) => pattern.test(error.message))?.[1]
  ?? '~UNCODED';

export function readRole(text, role, { caution = false } = {}) {
  const parsed = parseTrack(text, role, { mode: 'final', allowCautionLengths: caution });
  return {
    events: parsed.events,
    tempo: parsed.tempo,
    total: parsed.total,
    errorCodes: [...new Set(parsed.errors.map(errorLabel))],
    errors: parsed.errors,
  };
}

/** Exact rational comparison of two repo-parser readings. */
export function compareExact(a, b) {
  const diffs = [];
  if (a.events.length !== b.events.length) diffs.push({ field: 'eventCount', a: a.events.length, b: b.events.length });
  const count = Math.min(a.events.length, b.events.length);
  for (let index = 0; index < count && diffs.length < 6; index += 1) {
    const x = a.events[index];
    const y = b.events[index];
    if (x.pitch !== y.pitch) diffs.push({ index, field: 'pitch', a: x.pitch, b: y.pitch });
    if (f(x.start).cmp(y.start) !== 0) diffs.push({ index, field: 'start', a: x.start, b: y.start });
    if (f(x.end).cmp(y.end) !== 0) diffs.push({ index, field: 'end', a: x.end, b: y.end });
    if (x.volume !== y.volume) diffs.push({ index, field: 'volume', a: x.volume, b: y.volume });
  }
  const tempoEqual = a.tempo.length === b.tempo.length
    && a.tempo.every((t, i) => f(t.beat).cmp(b.tempo[i].beat) === 0 && t.bpm === b.tempo[i].bpm);
  if (!tempoEqual) diffs.push({ field: 'tempoMap', a: a.tempo, b: b.tempo });
  return { equal: diffs.length === 0, endEqual: f(a.total).cmp(b.total) === 0, diffs };
}

// ── token scan: char categories and Final form census ────────────────────────

const dotFactor = dots => new F((1n << BigInt(dots + 1)) - 1n, 1n << BigInt(dots));
const lengthOf = (denominator, dots) => new F(4, denominator).mul(dotFactor(dots));

export const GROUPS = Object.freeze({
  octave: 'octave route / enharmonic spelling',
  attackName: 'octave route / enharmonic spelling',
  lSwitch: 'default-length plan (lN placement + suffixes)',
  noteSuffix: 'default-length plan (lN placement + suffixes)',
  tie: 'tie segmentation',
  tieName: 'tie segmentation',
  restLetter: 'rest segmentation',
  restSuffix: 'rest segmentation',
  tempo: 'state tokens (t/v)',
  volume: 'state tokens (t/v)',
  nxx: 'Nxx numeric notes',
  other: 'other',
});

const ILLEGAL_FORMS = new Set(['numeric-note', 'dotted-default-length', 'forbidden-dotted', 'multiple-dots', 'implicit-initial-octave', 'length-out-of-range']);

/**
 * Scan an MML role with the *third-party* reading of `lN.` (a dotted default),
 * which is a superset of the repo reading for everything else. Used for
 * alignment and attribution only; legality comes from the repo parser.
 */
export function scanRole(text) {
  const tokens = [];
  const cat = new Array(text.length).fill('other');
  const forms = [];
  let i = 0;
  let time = new F(0);
  let defLen = 4;
  let defDots = 0;
  let tied = false;
  let octaveSet = false;
  let octave = null;
  let volume = 8; // the repo parser's starting V
  const state = () => ({ octave, defLen, defDots, volume });
  const readInt = () => {
    const m = /^\d+/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const readDots = () => {
    let d = 0;
    while (text[i] === '.') { d += 1; i += 1; }
    return d;
  };
  const mark = (a, b, category) => { for (let k = a; k < b; k += 1) cat[k] = category; };
  const lengthForms = (num, dots, explicit, at) => {
    if (num < syntax.officialLengthMin || num > syntax.officialLengthMax) forms.push({ form: 'length-out-of-range', at });
    else if (explicit && !PREFERRED.has(num)) forms.push({ form: 'caution-length', at, value: num });
    if (dots > 1) forms.push({ form: 'multiple-dots', at });
    else if (dots === 1 && !DOTTED_OK.has(num)) forms.push({ form: 'forbidden-dotted', at, value: `${num}.` });
  };

  while (i < text.length) {
    const a = i;
    const ch = text[i++];
    if ('abcdefg'.includes(ch) || ch === 'r' || ch === 'n') {
      let nameEnd = i;
      let pitchNumber = null;
      if (ch === 'n') {
        pitchNumber = readInt();
        nameEnd = i;
        forms.push({ form: 'numeric-note', at: a, value: pitchNumber });
      } else if (ch !== 'r') {
        while ('+#-'.includes(text[i]) && i < text.length) i += 1;
        nameEnd = i;
        if (!octaveSet) { forms.push({ form: 'implicit-initial-octave', at: a }); octaveSet = true; }
      }
      const num = ch === 'n' ? null : readInt();
      const numEnd = i;
      const dots = readDots();
      const duration = num !== null ? lengthOf(num, dots) : dots > 0 ? lengthOf(defLen, dots) : lengthOf(defLen, defDots);
      if (num !== null) lengthForms(num, dots, true, a);
      else if (dots > 0) lengthForms(defLen, dots, false, a);
      const kind = ch === 'r' ? 'rest' : ch === 'n' ? 'nxx' : 'note';
      const continuation = kind !== 'rest' && tied;
      if (kind === 'rest') { mark(a, nameEnd, 'restLetter'); mark(nameEnd, i, 'restSuffix'); }
      else if (kind === 'nxx') { mark(a, nameEnd, 'nxx'); mark(nameEnd, i, 'noteSuffix'); }
      else { mark(a, nameEnd, continuation ? 'tieName' : 'attackName'); mark(nameEnd, i, 'noteSuffix'); }
      time = time.add(duration);
      tied = false;
      tokens.push({ kind, a, b: i, t0: time.sub(duration), t1: time, continuation, num, dots, numEnd, pitchNumber, state: state() });
      continue;
    }
    if ('lotv@'.includes(ch)) {
      const num = readInt();
      let dots = 0;
      if (ch === 'l' && num !== null) {
        dots = readDots();
        if (num >= syntax.officialLengthMin && num <= syntax.officialLengthMax) { defLen = num; defDots = dots; }
        if (dots) forms.push({ form: 'dotted-default-length', at: a, value: `l${num}${'.'.repeat(dots)}` });
        if (!PREFERRED.has(num)) forms.push({ form: 'caution-length', at: a, value: num });
      }
      if (ch === 'o') { octaveSet = true; if (num !== null) octave = num; }
      if (ch === 'v' && num !== null) volume = num;
      mark(a, i, { l: 'lSwitch', o: 'octave', t: 'tempo', v: 'volume', '@': 'other' }[ch]);
      tokens.push({ kind: ch, a, b: i, num, dots });
      continue;
    }
    if (ch === '<' || ch === '>') {
      // Third-party reading: an unset octave pointer starts at o4.
      octave = (octave ?? 4) + (ch === '>' ? 1 : -1);
      mark(a, i, 'octave');
      tokens.push({ kind: 'oct', a, b: i });
      continue;
    }
    if (ch === '&') { mark(a, i, 'tie'); tied = true; tokens.push({ kind: 'tie', a, b: i }); continue; }
    tokens.push({ kind: 'bad', a, b: i });
  }
  return { tokens, cat, forms, total: time };
}

function formCensus(scan) {
  const census = {};
  for (const item of scan.forms) census[item.form] = (census[item.form] ?? 0) + 1;
  return census;
}

function groupCounts(scan, from = 0, to = scan.cat.length) {
  const counts = {};
  for (let k = from; k < to; k += 1) {
    const group = GROUPS[scan.cat[k]];
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return counts;
}

function subtractCounts(a, b) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (a[key] ?? 0) - (b[key] ?? 0);
    if (d) out[key] = d;
  }
  return out;
}

// ── the repo emitter's default-length candidate set ─────────────────────────

/**
 * Reconstruct which plain `lN` the repo emitter can consider for a role: its
 * DP only offers lengths whose plain duration equals some whole item (a note
 * piece or a merged rest span, both cut at tempo beats), plus the parser's
 * starting `l4` (mml-emitter.mjs, "default-length candidates"). An `lN` used by
 * the third-party output outside this set is a choice the repo never saw.
 */
export function repoLengthCandidates(reference) {
  const cuts = reference.tempo.map(t => f(t.beat));
  const spans = [];
  let cursor = f(0);
  for (const event of reference.events) {
    if (f(event.start).cmp(cursor) > 0) spans.push([cursor, f(event.start)]);
    spans.push([f(event.start), f(event.end)]);
    cursor = f(event.end);
  }
  if (f(reference.total).cmp(cursor) > 0) spans.push([cursor, f(reference.total)]);
  const out = new Set([4]);
  for (const [start, end] of spans) {
    let from = start;
    for (const beat of [...cuts.filter(b => b.cmp(start) > 0 && b.cmp(end) < 0), end]) {
      const duration = beat.sub(from);
      for (const n of PREFERRED_LIST) if (new F(4, n).cmp(duration) === 0) out.add(n);
      from = beat;
    }
  }
  return out;
}

// ── time-aligned diff regions ────────────────────────────────────────────────

const INITIAL_STATE = Object.freeze({ octave: null, defLen: 4, defDots: 0, volume: 8 });

function chunkOffsets(scan, beats) {
  const offsets = new Map([['0', { offset: 0, state: INITIAL_STATE }]]);
  for (const token of scan.tokens) {
    if (!token.t1) continue;
    const key = token.t1.toString();
    if (beats.has(key) && !offsets.has(key)) offsets.set(key, { offset: token.b, state: token.state });
  }
  return offsets;
}

const sameState = (x, y) => x.octave === y.octave && x.defLen === y.defLen && x.defDots === y.defDots && x.volume === y.volume;

/**
 * Cut both strings at the same musical positions (event starts/ends and tempo
 * beats from the repo parse) and merge consecutive differing chunks into
 * regions. State tokens written for the next note (o, <, >, l, v, t) fall into
 * the chunk of the note they serve.
 */
export function diffRegions(feText, repoText, reference) {
  const fe = scanRole(feText);
  const repo = scanRole(repoText);
  const beats = new Set(['0', reference.total]);
  for (const event of reference.events) { beats.add(event.start); beats.add(event.end); }
  for (const tempo of reference.tempo) beats.add(tempo.beat);
  const feOffsets = chunkOffsets(fe, beats);
  const repoOffsets = chunkOffsets(repo, beats);
  const common = [...beats].filter(beat => feOffsets.has(beat) && repoOffsets.has(beat)).sort((x, y) => f(x).cmp(y));

  // A region may only start and end where both writers are in the same state
  // (octave, default length, volume). Otherwise a `<` written one chunk
  // earlier by one side would look like a saving in the next chunk.
  const cuts = common.filter(beat => sameState(feOffsets.get(beat).state, repoOffsets.get(beat).state));
  const repoCandidates = repoLengthCandidates(reference);
  const regions = [];
  for (let index = 0; index < cuts.length; index += 1) {
    const beat = cuts[index];
    const next = cuts[index + 1];
    const fa = feOffsets.get(beat).offset;
    const fb = next === undefined ? feText.length : feOffsets.get(next).offset;
    const ra = repoOffsets.get(beat).offset;
    const rb = next === undefined ? repoText.length : repoOffsets.get(next).offset;
    const feSlice = feText.slice(fa, fb);
    const repoSlice = repoText.slice(ra, rb);
    if (feSlice === repoSlice) continue;
    const region = { from: beat, to: next ?? reference.total, fe: feSlice, repo: repoSlice, delta: feSlice.length - repoSlice.length };
    region.groups = subtractCounts(groupCounts(fe, fa, fb), groupCounts(repo, ra, rb));
    region.forms = [...new Set(fe.forms.filter(item => item.at >= fa && item.at < fb).map(item => item.form))];
    region.legal = !region.forms.some(form => ILLEGAL_FORMS.has(form));
    region.unseenLengths = [...new Set([...feSlice.matchAll(/l(\d+)(?!\d|\.)/g)].map(m => Number(m[1])))].filter(n => !repoCandidates.has(n));
    region.technique = classifyRegion(region);
    regions.push(region);
  }
  const size = region => region.fe.length + region.repo.length;
  const wins = regions.filter(region => region.delta < 0);
  const smallestWin = wins.reduce((best, region) => (!best || size(region) < size(best) || (size(region) === size(best) && region.delta < best.delta) ? region : best), null);
  const largestWin = wins.reduce((best, region) => (!best || region.delta < best.delta ? region : best), null);
  return {
    regions,
    smallestWin,
    largestWin,
    syncPoints: cuts.length,
    repoCandidates: [...repoCandidates].sort((a, b) => a - b),
    roleGroups: subtractCounts(groupCounts(fe), groupCounts(repo)),
    feForms: formCensus(fe),
  };
}

const countOf = (text, pattern) => (text.match(pattern) ?? []).length;

function classifyRegion(region) {
  const forms = region.forms.filter(form => ILLEGAL_FORMS.has(form));
  if (forms.length) return `ILLEGAL: ${forms.join('+')}`;
  if (region.forms.includes('caution-length')) return 'caution length (needs cautionLengthOptIn)';
  if (region.delta < 0 && region.unseenLengths.length) return `default length outside the repo candidate set (l${region.unseenLengths.join('/l')})`;
  const midItem = /l\d+&/;
  if (midItem.test(region.fe) !== midItem.test(region.repo)) return 'mid-item l switch (b.l32&b shape)';
  const midRest = /r[\d.]*l\d+r/;
  if (midRest.test(region.fe) !== midRest.test(region.repo)) return 'l switch between segments of one rest run';
  const entries = Object.entries(region.groups);
  if (!entries.length) return 'placement only';
  const [group] = entries.sort((x, y) => (region.delta <= 0 ? x[1] - y[1] : y[1] - x[1]))[0];
  const lDiff = countOf(region.fe, /l\d+/g) - countOf(region.repo, /l\d+/g);
  if (group === GROUPS.restLetter) return lDiff ? 'rest chunks written under a switched lN' : 'rest segmentation (token split)';
  if (group === GROUPS.octave) {
    const enh = countOf(region.fe, /b\+|c-/g) - countOf(region.repo, /b\+|c-/g);
    return enh ? 'enharmonic b+/c- spelling' : 'octave route (</>/oN placement)';
  }
  if (group === GROUPS.tie) return 'tie split choice';
  if (group === GROUPS.lSwitch) {
    const dotDiff = countOf(region.fe, /\./g) - countOf(region.repo, /\./g);
    return dotDiff ? 'dot usage (bare . vs N.)' : 'lN switch placement';
  }
  if (group === GROUPS.tempo) return 'v/t placement';
  return group;
}

// ── inputs ───────────────────────────────────────────────────────────────────

export function songReferenceInputs(dir = SONG_REFERENCE_DIR) {
  const out = [];
  const walk = path => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.mml')) out.push({ id: relative(dir, full), mml: readFileSync(full, 'utf8').trim() });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const one = (melody, rest = ['', '', '', '', '']) => `MML@${[melody, ...rest].join(',')};`;

export const SYNTHETIC_CASES = Object.freeze([
  { id: 'long-tie-7-bars', note: 'long sustains', mml: one('t120o4c1&c1&c1&c1&c1&c1&c2.&c8r8d1&d1&d1&d1&d1&d1&d1&d1&d1&d1') },
  { id: 'long-tie-dotted', note: 'dotted remainder in tie', mml: one('t100o4e2.&e1&e1&e8g4.&g1&g16r16a1.&a1.&a1.') },
  { id: 'tempo-mid-note', note: 'tempo change inside sustained notes', mml: 'MML@t120o4c2t90&c2d4t150&d4.e8t120r2f1,t120o3e2t90&e2g4t150&g4.a8t120r2a1,,,,;' },
  { id: 'tempo-in-rest', note: 'tempo change inside a rest', mml: one('t120o4c4r2t80r2d4r1t140r4e2') },
  { id: 'octave-boundary', note: 'b+/c- boundary spelling', mml: one('t120o4cc<b>c<b>c<b>cl8o5c<b>c<b>c<bo3b>c<b>c4<b4>c2') },
  { id: 'octave-boundary-ties', note: 'boundary notes with tie segments', mml: one('t120o4c2&c8<b8>c4<b4&b16>c16<b8>c1&c1<b1&b1') },
  { id: 'octave-leaps', note: 'wide leaps (o-token vs >/<)', mml: one('t120o2c>>c<<d>>>e<<<fo6go2ao6b<<<<c') },
  { id: 'dotted-lengths', note: 'dotted lengths', mml: one('t120o4c4.d8e4.f8g2.a4c8.d16e8.f16g16.a32b16.>c32c1.<b2.a4.g8.f16.e32.d32') },
  { id: 'triplets-12-24', note: 'triplet 12/24 (caution)', mml: one('t120o4l12cdefgab>c<l24cdefgab>cc<l12r4c6d6e6f3') },
  { id: 'triplets-in-ties', note: 'triplet remainders inside ties (caution)', mml: one('t120o4c4&c12d12e12f4.&f24g24a2&a6b6>c6') },
  { id: 'long-rests', note: '12-bar and dotted rests', mml: one('t120o4c4r1r1r1r1r1r1r1r1r1r1r1r1r2.d4r1.r1.r1.e4') },
  { id: 'long-rest-offgrid', note: 'long rest ending off the bar', mml: one('t120o4c8r8r1r1r1r1r1r1r1r1r1r1r4.d8r16r1r1r1r1r1r1r1r1r2r8.e16') },
  { id: 'dot-tail-32', note: '3MLE shape b8.&b32r32 (mid-item l switch)', mml: one('t120o4b8.&b32r32a8.&a32r32g8.&g32r32f8.&f32r32e8.&e32r32d8.&d32r32c8.&c32r32<b8.&b32r32') },
  { id: 'staccato-l32', note: 'short notes with fixed rests', mml: one('t120o4l32cr8.dr8.er8.fr8.gr8.ar8.br8.>cr8.<l16cr8dr8er8') },
  { id: 'rest-merge', note: 'adjacent rests of mixed length', mml: one('t120o4c4r8r8r4r2d4r16r16r8r4r2e4r32r32r16r8r4r2f4') },
  { id: 'volume-changes', note: 'volume transitions', mml: one('t120v10o4c4v12d4v12e4v8f4r4v15g4v15a4r4v10b4') },
  { id: 'same-pitch-attacks', note: 'repeated attacks vs ties', mml: one('t120o4c8c8c8c8c4&c4c2&c8c8c4') },
]);

export const NXX_CASES = Object.freeze([
  ...[0, 11, 12, 23, 24, 35, 36, 47, 48, 59, 60, 71, 72, 83, 84, 95, 96, 100, 107].map(n => ({ id: `n${n}`, mml: `t120o4n${n}` })),
  { id: 'n108 (above official range)', mml: 't120o4n108' },
  { id: 'n60 after named o4c', mml: 't120o4cn60c' },
  { id: 'o0c', mml: 't120o0c' },
  { id: 'o0b', mml: 't120o0b' },
  { id: 'o1c', mml: 't120o1c' },
  { id: 'o4c', mml: 't120o4c' },
  { id: 'o7b', mml: 't120o7b' },
  { id: 'o8c', mml: 't120o8c' },
  { id: 'o8e', mml: 't120o8e' },
  { id: 'o8b', mml: 't120o8b' },
  { id: 'o7b>c (step into o8)', mml: 't120o7b>c' },
  { id: 'o1c<b (step into o0)', mml: 't120o1c<b' },
  { id: 'o8c- (B7 spelled from o8)', mml: 't120o8c-' },
  { id: 'o0b+ (C1 spelled from o0)', mml: 't120o0b+' },
]);

// ── running ──────────────────────────────────────────────────────────────────

function compareRole({ workshop, role, inputText, repoText, reference, variants }) {
  const row = { role, inputChars: inputText.length, repo: repoText?.length ?? null, repoMml: repoText, variants: {} };
  const judgeBase = repoText !== null ? readRole(repoText, role, { caution: true }) : reference;
  for (const name of variants) {
    const emitted = feEmitRole(workshop, name, inputText);
    if (!emitted.ok) { row.variants[name] = { ok: false, error: emitted.error }; continue; }
    const strict = readRole(emitted.mml, role);
    const caution = readRole(emitted.mml, role, { caution: true });
    const vsRepo = compareExact(strict, judgeBase);
    const vsSource = compareExact(strict, reference);
    const entry = {
      ok: true,
      mml: emitted.mml,
      chars: emitted.mml.length,
      ms: emitted.ms,
      exhausted: emitted.exhausted,
      octaveFix: emitted.octaveFix,
      eventsEqual: vsRepo.equal,
      endEqual: vsRepo.endEqual,
      eventsEqualSource: vsSource.equal,
      diffs: vsRepo.diffs,
      finalOk: strict.errorCodes.length === 0,
      finalOkWithCaution: caution.errorCodes.length === 0,
      finalErrors: strict.errorCodes,
    };
    if (repoText !== null) {
      const diff = diffRegions(emitted.mml, repoText, judgeBase);
      entry.delta = entry.chars - repoText.length;
      entry.regions = diff.regions;
      entry.smallestWin = diff.smallestWin;
      entry.largestWin = diff.largestWin;
      entry.roleGroups = diff.roleGroups;
      entry.forms = diff.feForms;
    }
    row.variants[name] = entry;
  }
  return row;
}

function variantsFor(needsCaution) {
  return needsCaution
    ? ['raw', 'stock', 'stockOctave', 'plainL', 'finalCaution']
    : ['raw', 'stock', 'stockOctave', 'plainL', 'final', 'finalNoMid'];
}

export async function runSongCase(workshop, { id, mml, kind = 'song' }) {
  const sourceRoles = splitMML(mml);
  const repo = repoEmit(mml);
  // Caution lengths in the source (ingest warning), or a repo emission that
  // only passed with the opt-in, move the comparison to the caution lattice.
  const needsCaution = (repo.ok && repo.options.cautionLengthOptIn === true)
    || sourceRoles.some((text, index) => parseTrack(text, ROLES[index], { mode: 'ingest' }).warnings.some(w => w.code === 'CAUTION_LENGTH'));
  const rows = [];
  const inputs = [{ input: 'source', roles: sourceRoles }];
  if (repo.ok) inputs.push({ input: 'repo-output', roles: repo.roles });
  for (const { input, roles } of inputs) {
    for (let index = 0; index < ROLES.length; index += 1) {
      const role = ROLES[index];
      const text = roles[index];
      if (!text) continue;
      const reference = readRole(sourceRoles[index], role, { caution: true });
      const row = compareRole({
        workshop,
        role,
        inputText: text,
        repoText: repo.ok ? repo.roles[index] : null,
        reference,
        variants: variantsFor(needsCaution),
      });
      if (repo.ok) {
        const repoRead = readRole(repo.roles[index], role, { caution: needsCaution });
        row.repoFinalOk = repoRead.errorCodes.length === 0;
        row.repoEqualsSource = compareExact(repoRead, reference).equal;
      }
      rows.push({ case: id, kind, input, ...row });
    }
  }
  return {
    id,
    kind,
    repo: { ok: repo.ok, options: repo.options ?? null, attempts: repo.attempts, total: repo.ok ? repo.roles.reduce((s, r) => s + r.length, 0) : null },
    needsCaution,
    rows,
  };
}

export function runNxxDiff(workshop) {
  const rows = [];
  for (const item of NXX_CASES) {
    const theirs = workshop.mml.parseAll([item.mml]);
    const repo = parseTrack(item.mml, 'Melody', { mode: 'ingest' });
    const repoFinal = parseTrack(item.mml, 'Melody', { mode: 'final' });
    const theirNotes = theirs.tracks[0].notes.map(note => note.midi);
    const repoNotes = repo.events.map(event => event.pitch);
    const length = Math.max(theirNotes.length, repoNotes.length);
    for (let index = 0; index < length; index += 1) {
      const fe = theirNotes[index] ?? null;
      const rp = repoNotes[index] ?? null;
      rows.push({
        id: item.id,
        mml: item.mml,
        index,
        fe,
        repo: rp,
        delta: fe !== null && rp !== null ? fe - rp : null,
        feFolded: theirs.warnings.some(w => /fold|折|範圍|range/i.test(w)) || undefined,
        feWarnings: theirs.warnings.length,
        repoFinalCodes: [...new Set(repoFinal.errors.map(error => error.code ?? 'UNCODED'))],
      });
    }
  }
  return rows;
}

/** Nxx the unpatched compressor actually emits, re-read by the repo parser. */
function emittedNxx(caseResults) {
  const out = [];
  for (const result of caseResults) {
    for (const input of ['source', 'repo-output']) {
      const rows = result.rows.filter(row => row.input === input && row.variants.raw?.ok && row.variants.raw.forms?.['numeric-note']);
      if (!rows.length) continue;
      const tokens = rows.flatMap(row => scanRole(row.variants.raw.mml).tokens.filter(token => token.kind === 'nxx').map(token => ({
        role: row.role,
        token: row.variants.raw.mml.slice(token.a, token.b),
        feMidi: token.pitchNumber + 12,
        repoPitch: token.pitchNumber,
      })));
      out.push({
        case: result.id,
        input,
        roles: rows.map(row => `${row.role}×${row.variants.raw.forms['numeric-note']}`),
        count: tokens.length,
        distinctOffsets: [...new Set(tokens.map(t => t.feMidi - t.repoPitch))],
        examples: [...new Map(tokens.map(t => [t.token, t])).values()].slice(0, 4),
        eventsEqualUnderRepoParser: rows.every(row => row.variants.raw.eventsEqual),
        charsSavedByNxx: rows.reduce((acc, row) => acc + (row.variants.stock?.ok ? row.variants.stock.chars - row.variants.raw.chars : 0), 0),
      });
    }
  }
  return out;
}

export async function runHarness({ workshop, only = null } = {}) {
  const report = {
    tool: 'scripts/fusion-emitter-diff.mjs',
    canonical: EFFECTIVE_RULESET.canonical ?? null,
    workshop: { dir: workshop.dir, provenance: workshop.provenance },
    songs: [],
    synthetic: [],
    nxx: [],
  };
  if (!only || only === 'songs') {
    for (const input of songReferenceInputs()) report.songs.push(await runSongCase(workshop, { ...input, kind: 'song' }));
  }
  if (!only || only === 'synthetic') {
    for (const item of SYNTHETIC_CASES) report.synthetic.push(await runSongCase(workshop, { ...item, kind: 'synthetic' }));
  }
  if (!only || only === 'nxx') report.nxx = runNxxDiff(workshop);
  report.emittedNxx = emittedNxx([...report.songs, ...report.synthetic]);
  report.summary = summarize([...report.songs, ...report.synthetic]);
  return report;
}

// ── summary ──────────────────────────────────────────────────────────────────

const legalVariantOf = row => (row.variants.final ? 'final' : 'finalCaution');

export function summarize(caseResults) {
  const rows = caseResults.flatMap(result => result.rows).filter(row => row.repo !== null);
  const sum = (name, pick = row => row.variants[name]) => rows.reduce((acc, row) => {
    const entry = pick(row);
    return entry?.ok ? acc + entry.chars : acc;
  }, 0);
  // Variant-chain attribution: the delta between neighbours belongs to the one
  // restriction added in between.
  const chain = [
    ['Nxx numeric spelling (raw → stock)', 'raw', 'stock'],
    ['implicit first octave (stock → + explicit O)', 'stock', 'stockOctave'],
    ['dotted default lN. (→ plain lN only)', 'stockOctave', 'plainL'],
    ['non-preferred lengths / 64. (→ Final lattice)', 'plainL', null],
    ['mid-item l switch (Final lattice → without it)', 'final', 'finalNoMid'],
  ];
  const attribution = chain.map(([label, from, to]) => {
    let saved = 0; let rowsAffected = 0;
    for (const row of rows) {
      const a = row.variants[from];
      const b = row.variants[to ?? legalVariantOf(row)];
      if (!a?.ok || !b?.ok) continue;
      const d = b.chars - a.chars;
      if (d) { saved += d; rowsAffected += 1; }
    }
    return { technique: label, charsSavedByTechnique: saved, rows: rowsAffected };
  });

  // Legal wins: Final-legal third-party output whose events equal the repo
  // output, broken down by region technique.
  const wins = new Map();
  const losses = new Map();
  for (const row of rows) {
    const entry = row.variants[legalVariantOf(row)];
    if (!entry?.ok || !entry.eventsEqual || !entry.endEqual) continue;
    const legal = row.variants.final ? entry.finalOk : entry.finalOkWithCaution;
    for (const region of entry.regions ?? []) {
      if (!region.delta) continue;
      const target = region.delta < 0 ? wins : losses;
      const key = `${region.technique}${legal && region.legal ? '' : ' [not Final-legal]'}`;
      const bucket = target.get(key) ?? { technique: key, chars: 0, regions: 0, example: null };
      bucket.chars += Math.abs(region.delta);
      bucket.regions += 1;
      if (!bucket.example || region.fe.length + region.repo.length < bucket.example.fe.length + bucket.example.repo.length) {
        bucket.example = { case: row.case, role: row.role, input: row.input, from: region.from, to: region.to, fe: region.fe, repo: region.repo, delta: region.delta };
      }
      target.set(key, bucket);
    }
  }
  const rank = map => [...map.values()].sort((a, b) => b.chars - a.chars);
  return {
    rowsCompared: rows.length,
    totals: {
      repo: rows.reduce((acc, row) => acc + (row.repo ?? 0), 0),
      raw: sum('raw'),
      stock: sum('stock'),
      final: sum(null, row => row.variants[legalVariantOf(row)]),
    },
    attribution,
    legalWins: rank(wins),
    repoWins: rank(losses),
  };
}

// ── rendering ────────────────────────────────────────────────────────────────

const clip = (text, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const yn = value => (value === true ? 'yes' : value === false ? 'NO' : '—');
const cell = entry => (entry?.ok ? String(entry.chars) : `✗ ${entry?.error ?? ''}`.trim());
const code = text => `\`${String(text).replaceAll('`', 'ˋ').replaceAll('|', '¦')}\``;

export function renderMarkdown(report) {
  const out = [];
  out.push('# Fusion emitter diff — MML 工房 lossless compressor vs repo Final emitter', '');
  out.push(`Workshop bundle: \`${report.workshop.dir}\``);
  for (const [file, sha] of Object.entries(report.workshop.provenance)) out.push(`- ${file} sha256 \`${sha}\``);
  out.push('', 'Judge: repo `parser.mjs` (final mode), exact rationals. Δ = third-party − repo (negative = third-party shorter).', '');
  out.push('Variants: raw = stock with Nxx; stock = lossless, no Nxx; final = preferred lattice on the 1/64 grid, plain `lN` only, explicit first `oN` (finalCaution adds 3/6/12/24/48 where the repo needed `cautionLengthOptIn`).', '');

  const table = results => {
    out.push('| case | input | role | repo | raw | stock | final | Δ final | events = | end = | Final OK (stock/final) | smallest legal win (repo → theirs) |');
    out.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |');
    for (const result of results) {
      if (!result.repo.ok) out.push(`| ${result.id} | — | — | repo FAIL ${result.repo.attempts.map(a => a.codes.join('+')).join(' / ')} | | | | | | | | |`);
      for (const row of result.rows) {
        const legalName = legalVariantOf(row);
        const legal = row.variants[legalName];
        const stock = row.variants.stock;
        const win = legal?.smallestWin;
        out.push(`| ${result.id}${result.needsCaution ? ' (caution)' : ''} | ${row.input} | ${row.role} | ${row.repo ?? '—'} | ${cell(row.variants.raw)} | ${cell(stock)} | ${cell(legal)} | ${legal?.ok && row.repo !== null ? legal.delta : '—'} | ${yn(legal?.eventsEqual)} | ${yn(legal?.endEqual)} | ${yn(stock?.finalOk)} / ${yn(legalName === 'final' ? legal?.finalOk : legal?.finalOkWithCaution)} | ${win ? `${code(clip(win.repo, 30))} → ${code(clip(win.fe, 30))} (${win.delta})` : '—'} |`);
      }
    }
    out.push('');
  };
  if (report.songs.length) { out.push('## Song references (`imports/song-reference/**`)', ''); table(report.songs); }
  if (report.synthetic.length) { out.push('## Synthetic cases', ''); table(report.synthetic); }

  const s = report.summary;
  out.push('## Totals', '');
  out.push(`Rows compared: ${s.rowsCompared}. Characters — repo ${s.totals.repo}, raw ${s.totals.raw}, stock ${s.totals.stock}, Final-constrained ${s.totals.final}.`, '');
  out.push('### Variant-chain attribution (third-party techniques, all roles)', '');
  out.push('| technique | net chars it saves (+) or costs (−) | rows changed |', '| --- | ---: | ---: |');
  for (const item of s.attribution) out.push(`| ${item.technique} | ${item.charsSavedByTechnique} | ${item.rows} |`);
  out.push('', '### Legal optimization opportunities (Final-constrained third-party shorter, events exactly equal)', '');
  out.push('| technique | chars saved | regions | smallest example (repo → theirs) |', '| --- | ---: | ---: | --- |');
  for (const item of s.legalWins) out.push(`| ${item.technique} | ${item.chars} | ${item.regions} | ${item.example.case}/${item.example.role}@${item.example.from}: ${code(clip(item.example.repo, 40))} → ${code(clip(item.example.fe, 40))} |`);
  out.push('', '### Regions where the repo emitter is shorter', '');
  out.push('| technique | chars | regions | smallest example (repo vs theirs) |', '| --- | ---: | ---: | --- |');
  for (const item of s.repoWins) out.push(`| ${item.technique} | ${item.chars} | ${item.regions} | ${item.example.case}/${item.example.role}@${item.example.from}: ${code(clip(item.example.repo, 40))} vs ${code(clip(item.example.fe, 40))} |`);

  if (report.nxx.length) {
    out.push('', '## Nxx / o0 / o8 pitch readings (their `parseAll` vs repo `parseTrack`)', '');
    out.push('| case | note # | theirs (MIDI) | repo pitch | Δ | repo Final codes |', '| --- | ---: | ---: | ---: | ---: | --- |');
    for (const row of report.nxx) out.push(`| ${code(row.mml)} | ${row.index} | ${row.fe ?? '—'} | ${row.repo ?? '—'} | ${row.delta ?? '—'} | ${row.repoFinalCodes.join(', ') || '—'} |`);
  }
  if (report.emittedNxx?.length) {
    out.push('', '### Nxx emitted by the unpatched compressor, re-read by the repo parser', '');
    for (const item of report.emittedNxx) out.push(`- ${item.case} (${item.input}): ${item.count} Nxx in ${item.roles.join(', ')}, saving ${item.charsSavedByNxx} chars; theirs − repo pitch offset ${item.distinctOffsets.join('/')}; e.g. ${item.examples.map(e => `${code(e.token)} = MIDI ${e.feMidi} to them, ${e.repoPitch} to the repo`).join('; ')}; events equal under repo parser: ${yn(item.eventsEqualUnderRepoParser)}`);
  }
  out.push('');
  return out.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: {
      json: { type: 'string' },
      markdown: { type: 'string' },
      only: { type: 'string' },
      strict: { type: 'boolean', default: false },
    },
  });
  const located = resolveWorkshop();
  if (!located.ok) {
    process.stdout.write(`SKIPPED: ${located.reason}. Set ${WORKSHOP_ENV} to the MML 工房 bundle directory (the one containing js/mml-compress.js). A skipped run is not a pass.\n`);
    process.exitCode = values.strict ? 2 : 0;
    return;
  }
  if (values.only && !['songs', 'synthetic', 'nxx'].includes(values.only)) throw Error('--only must be songs, synthetic or nxx');
  const workshop = await loadWorkshop(located.dir);
  const report = await runHarness({ workshop, only: values.only ?? null });
  const markdown = renderMarkdown(report);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, (key, value) => (value instanceof F ? value.toString() : value), 2));
  if (values.markdown) writeFileSync(values.markdown, markdown);
  if (!values.markdown) process.stdout.write(`${markdown}\n`);
  else process.stdout.write(`wrote ${values.markdown}${values.json ? ` and ${values.json}` : ''}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
