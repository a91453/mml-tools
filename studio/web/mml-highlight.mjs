// MML syntax highlighting for Studio Web.
//
// Ported from the owner's earlier frontend `mml-highlight.js` (frontend capture
// f1b7024f…baad9a, owner authorization 2026-09-23) and merged with Studio's
// parser. Pure functions; no DOM, no backend import (the main thread never
// imports the Canonical engines, see app.mjs).
//
// Kept from the earlier frontend:
//   * one role byte per source character. The array length IS the text length,
//     so the overlay cannot drift out of alignment with the textarea the way a
//     hand-built span list silently can;
//   * `t l o v` coloured together with their number (tempo, default length,
//     octave and volume are declarations, not durations); note and rest
//     lengths stay neutral; `<` `>` share `o`, `&` shares `l`; accidentals are
//     never dimmed; `r` colours only its letter; `n` has its own colour;
//   * a separate band for characters past the per-role limit, never truncating;
//   * a size cap beyond which highlighting switches off;
//   * adjacent equal roles collapse into one span, and a trailing newline gets
//     a spacer so the overlay and the textarea keep the same line count.
//
// Changed for Studio, where the two disagree:
//   * the token set is Studio's parser (studio/backend/mml/parser.mjs), not
//     the earlier frontend's wider dialect: `h`, `p`, `@n`, `[ ]` and comments are errors
//     here, so they are drawn as errors. `scanTokens` mirrors the parser's
//     character loop and studio/tests/web-mml-highlight.test.mjs holds the two
//     together;
//   * whitespace inside a role is an error in Studio (roles are pasted
//     verbatim), so it is marked instead of left plain;
//   * parser diagnostics computed in the Worker can be layered on top: an
//     error marks its token, a caution (Nxx, caution lengths, non-Final dotted
//     forms) marks its token in the caution style. The highlighter never
//     decides legality itself beyond the lexical level.

export const MAX_HL_CHARS = 8000;
export const ROLE_CHARACTER_LIMIT = 2400;
// EFFECTIVE_RULESET.mobileSyntax values; pinned by the test suite.
export const OFFICIAL_LENGTH_MIN = 1;
export const OFFICIAL_LENGTH_MAX = 64;

const R = { plain: 0, t: 1, l: 2, o: 3, v: 4, n: 5, quiet: 6, punct: 7, dead: 8, bad: 9 };
const CLS = ['', 'tk-t', 'tk-l', 'tk-o', 'tk-v', 'tk-n', 'tk-quiet', 'tk-punct', 'tk-dead', 'tk-bad'];
export const ROLE = Object.freeze({ ...R });
export const FLAG = Object.freeze({ OVER: 1 << 4, ERROR: 1 << 5, CAUTION: 1 << 6 });

const NOTE_LETTERS = 'cdefgab';
const isSpace = c => /\s/.test(c); // the parser's own class
const isDigit = c => c >= '0' && c <= '9';

// Tokens of one role body, in source order. Kinds: t l o v oct tie n note rest
// space bad. `a`/`b` are half-open offsets into `text`. Mirrors parseTrack():
// the same character classes, the same greedy digit runs, accidentals only on
// note letters, dots after an explicit or implied length, one bad character at
// a time.
export function scanTokens(text) {
  const tokens = [];
  const lower = text.toLowerCase();
  let i = 0;
  // The parser stops a note or rest that has no explicit length right after
  // its accidental while the last `l` was out of range, so the dots that
  // follow are read as separate (unrecognised) characters. Track the same flag.
  let lengthTrusted = true;
  const digits = from => { let j = from; while (j < lower.length && isDigit(lower[j])) j++; return j; };
  while (i < lower.length) {
    const a = i;
    const ch = lower[i++];
    if (isSpace(ch)) { tokens.push({ kind: 'space', a, b: i }); continue; }
    if ('tolv'.includes(ch)) {
      i = digits(i);
      const missingValue = i === a + 1;
      if (ch === 'l' && !missingValue) {
        const value = Number(lower.slice(a + 1, i));
        lengthTrusted = Number.isSafeInteger(value) && value >= OFFICIAL_LENGTH_MIN && value <= OFFICIAL_LENGTH_MAX;
      }
      tokens.push({ kind: ch, a, b: i, missingValue });
      continue;
    }
    if (ch === '<' || ch === '>') { tokens.push({ kind: 'oct', a, b: i }); continue; }
    if (ch === '&') { tokens.push({ kind: 'tie', a, b: i }); continue; }
    if (ch === 'n') { i = digits(i); tokens.push({ kind: 'n', a, b: i, missingValue: i === a + 1 }); continue; }
    if (NOTE_LETTERS.includes(ch) || ch === 'r') {
      if (ch !== 'r' && (lower[i] === '+' || lower[i] === '#' || lower[i] === '-')) i++;
      const lengthEnd = digits(i);
      if (lengthEnd === i && !lengthTrusted) { tokens.push({ kind: ch === 'r' ? 'rest' : 'note', a, b: i }); continue; }
      i = lengthEnd;
      while (lower[i] === '.') i++;
      tokens.push({ kind: ch === 'r' ? 'rest' : 'note', a, b: i });
      continue;
    }
    tokens.push({ kind: 'bad', a, b: i });
  }
  return tokens;
}

// Split a pasted text into the part before `MML@`, the role bodies and the
// tail after `;`. Mirrors splitMML(): the wrapper is recognised only when the
// trimmed text starts with MML@ and ends with `;`. Otherwise the whole text is
// treated as a single role body (the Final per-role boxes).
export function segmentRoles(src) {
  const lead = src.length - src.trimStart().length;
  const trail = src.trimEnd().length;
  const body = src.slice(lead, trail);
  if (/^mml@/i.test(body) && body.endsWith(';')) {
    const roles = [];
    let start = lead + 4;
    for (let k = start; k < trail - 1; k++) {
      if (src[k] === ',') { roles.push([start, k]); start = k + 1; }
    }
    roles.push([start, trail - 1]);
    return { wrapped: true, prefix: [lead, lead + 4], suffix: [trail - 1, trail], roles };
  }
  return { wrapped: false, prefix: null, suffix: null, roles: [[0, src.length]] };
}

// Per-role character counts as the parser counts them: the raw role string.
export function roleCharacterCounts(src) {
  return segmentRoles(src).roles.map(([a, b]) => b - a);
}

/**
 * @param {string} src
 * @param {{ diagnostics?: Array<{ role:number, position:number, severity:'error'|'caution' }>, limit?: number }} options
 *   `position` is the parser's 1-based offset inside that role's string.
 * @returns {Uint8Array} length === src.length
 */
export function buildRoles(src, { diagnostics = [], limit = ROLE_CHARACTER_LIMIT } = {}) {
  const keys = new Uint8Array(src.length);
  if (src.length === 0 || src.length > MAX_HL_CHARS) return keys;
  const seg = segmentRoles(src);
  if (seg.wrapped) {
    for (let k = seg.prefix[0]; k < seg.prefix[1]; k++) keys[k] = R.dead;
    keys[seg.suffix[0]] = R.punct;
    for (let r = 0; r + 1 < seg.roles.length; r++) keys[seg.roles[r][1]] = R.punct;
  }
  const tokensByRole = seg.roles.map(([a, b]) => {
    const tokens = scanTokens(src.slice(a, b));
    const put = (tok, role) => { for (let k = a + tok.a; k < a + tok.b; k++) keys[k] = role; };
    for (const tok of tokens) {
      switch (tok.kind) {
        case 't': case 'l': case 'o': case 'v': put(tok, tok.missingValue ? R.bad : R[tok.kind]); break;
        case 'oct': put(tok, R.o); break;
        case 'tie': put(tok, R.l); break;
        case 'n': put(tok, tok.missingValue ? R.bad : R.n); break;
        case 'rest': keys[a + tok.a] = R.quiet; break;
        case 'space': case 'bad': put(tok, R.bad); break;
        default: break; // note letters, accidentals and lengths stay plain
      }
    }
    if (b - a > limit) for (let k = a + limit; k < b; k++) keys[k] |= FLAG.OVER;
    return tokens;
  });
  for (const diagnostic of diagnostics) {
    const range = seg.roles[diagnostic.role];
    if (!range || !Number.isInteger(diagnostic.position)) continue;
    const at = diagnostic.position - 1;
    const tok = tokensByRole[diagnostic.role].find(t => t.a <= at && at < t.b)
      ?? (at >= range[1] - range[0] && range[1] > range[0] ? { a: range[1] - range[0] - 1, b: range[1] - range[0] } : null);
    if (!tok) continue;
    const flag = diagnostic.severity === 'error' ? FLAG.ERROR : FLAG.CAUTION;
    for (let k = range[0] + tok.a; k < range[0] + tok.b; k++) keys[k] |= flag;
  }
  return keys;
}

const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function classOf(k) {
  let c = CLS[k & 15];
  if (k & FLAG.OVER) c += ' tk-over';
  if (k & FLAG.ERROR) c += ' tk-error';
  if (k & FLAG.CAUTION) c += ' tk-caution';
  return c.trim();
}

export function renderHTML(src, keys) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const k = keys[i];
    let j = i + 1;
    while (j < src.length && keys[j] === k) j++;
    const text = escHtml(src.slice(i, j));
    out += k === 0 ? text : `<span class="${classOf(k)}">${text}</span>`;
    i = j;
  }
  // A <pre>'s final newline takes no line box while a textarea's does.
  if (src === '' || src.endsWith('\n')) out += '\n ';
  return out;
}

// Map parser findings ({ role: 'Melody', position, code }) to role indexes.
const CAUTION_CODES = new Set(['NUMERIC_NOTE_CAUTION', 'CAUTION_LENGTH', 'NONCANONICAL_DOTTED_SOURCE_FORM', 'NAMED_NOTE_ABOVE_OFFICIAL_PITCH_RANGE', 'TRACK_CHARACTER_LIMIT_SOURCE_ONLY']);
export function diagnosticsFromValidation(validation, roleNames) {
  const out = [];
  const add = (list, severity) => {
    for (const finding of list ?? []) {
      const role = roleNames.indexOf(finding?.role);
      if (role < 0 || !Number.isInteger(finding.position)) continue;
      if (severity === 'caution' && finding.code && !CAUTION_CODES.has(finding.code)) continue;
      out.push({ role, position: finding.position, severity });
    }
  };
  add(validation?.errors, 'error');
  add(validation?.warnings, 'caution');
  return out;
}
