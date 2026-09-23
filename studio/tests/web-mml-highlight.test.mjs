import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { parseTrack, validateMML } from '../backend/mml/parser.mjs';
import { ROLES } from '../../dist/core.js';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { FLAG, MAX_HL_CHARS, OFFICIAL_LENGTH_MAX, OFFICIAL_LENGTH_MIN, ROLE, ROLE_CHARACTER_LIMIT, buildRoles, diagnosticsFromValidation, renderHTML, roleCharacterCounts, scanTokens, segmentRoles } from '../web/mml-highlight.mjs';

// Grammar-generated, parser-clean six-role strings: tempo, octave moves, ties
// to the same pitch, dotted lengths, rests, volume and Nxx. Always available,
// including in the public export, which ships no song files.
function generatedSongs(count = 12, seed = 3) {
  let state = seed;
  const next = n => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) % n;
  const lengths = ['', '1', '2', '4', '8', '16', '32', '64', '2.', '4.', '8.', '16.'];
  const songs = [];
  for (let s = 0; s < count; s++) {
    const roles = [];
    for (let r = 0; r < 6; r++) {
      if (r > 0 && next(4) === 0) { roles.push(''); continue; }
      let text = `t${60 + next(150)}o${2 + next(4)}l${[4, 8, 16][next(3)]}`;
      let octave = Number(text.match(/o(\d)/)[1]);
      for (let k = 0; k < 20 + next(40); k++) {
        const pick = next(10);
        if (pick === 0 && octave < 6) { text += '>'; octave++; }
        else if (pick === 1 && octave > 1) { text += '<'; octave--; }
        else if (pick === 2) text += `r${lengths[next(lengths.length)]}`;
        else if (pick === 3) text += `v${next(16)}`;
        else if (pick === 4) text += `n${24 + next(60)}`;
        else {
          const letter = 'cdefgab'[next(7)] + ['', '+', '-', '#'][next(8) < 5 ? 0 : 1 + next(3)];
          text += `${letter}${lengths[next(lengths.length)]}`;
          if (next(5) === 0) text += `&${letter}${lengths[1 + next(lengths.length - 1)]}`;
        }
      }
      roles.push(text);
    }
    songs.push(`MML@${roles.join(',')};`);
  }
  return songs;
}

// The repository's reference songs when present, plus the generated corpus.
async function corpus() {
  const out = generatedSongs();
  const root = new URL('../../imports/song-reference', import.meta.url).pathname;
  if (!existsSync(root)) return out;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.mml')) out.push(await readFile(path, 'utf8'));
    }
  }
  await walk(root);
  return out;
}

// Deterministic pseudo-random strings over the parser's alphabet plus noise.
function* fuzz(count, seed = 7) {
  const alphabet = 'cdefgabrntolv<>&+-#.0123456789 h@[],/x';
  let state = seed;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
  for (let n = 0; n < count; n++) {
    let s = 'o4';
    const length = 1 + (next() % 40);
    for (let k = 0; k < length; k++) s += alphabet[next() % alphabet.length];
    yield s;
  }
}

test('tokens partition every role exactly, with no gap or overlap', async () => {
  const inputs = [...fuzz(400), ...(await corpus()).flatMap(mml => segmentRoles(mml).roles.map(([a, b]) => mml.slice(a, b)))];
  for (const text of inputs) {
    const tokens = scanTokens(text);
    let at = 0;
    for (const tok of tokens) { assert.equal(tok.a, at, text); assert.ok(tok.b > tok.a, text); at = tok.b; }
    assert.equal(at, text.length, text);
  }
});

test('every parser diagnostic lands on a token start: the scanner and parser split text identically', async () => {
  const inputs = [...fuzz(3000, 11), ...fuzz(3000, 29), ...(await corpus()).flatMap(mml => segmentRoles(mml).roles.map(([a, b]) => mml.slice(a, b)))];
  for (const text of inputs) {
    const starts = new Set(scanTokens(text).map(t => t.a));
    for (const mode of ['ingest', 'final']) {
      const parsed = parseTrack(text, 'Melody', { mode });
      for (const finding of [...parsed.errors, ...parsed.warnings]) {
        if (finding.code === 'TRACK_CHARACTER_LIMIT' || finding.code === 'TRACK_CHARACTER_LIMIT_SOURCE_ONLY' || finding.code === 'INITIAL_TEMPO_REQUIRED') continue;
        if (/軌尾有未完成延音/.test(finding.message)) continue; // reported at the last character
        assert.ok(starts.has(finding.position - 1), `${mode} ${JSON.stringify(text)} ${finding.message} @${finding.position}`);
      }
    }
  }
});

test('note, Nxx and tie tokens account for every parsed event of a clean role', async () => {
  let checked = 0;
  for (const mml of await corpus()) {
    const seg = segmentRoles(mml.trim());
    assert.equal(seg.wrapped, true);
    for (const [a, b] of seg.roles) {
      const text = mml.trim().slice(a, b);
      const parsed = parseTrack(text, 'Melody', { mode: 'ingest' });
      if (parsed.errors.length || !text) continue;
      const tokens = scanTokens(text);
      const attacks = tokens.filter(t => t.kind === 'note' || t.kind === 'n').length;
      const ties = tokens.filter(t => t.kind === 'tie').length;
      assert.equal(attacks - ties, parsed.events.length);
      checked += 1;
    }
  }
  assert.ok(checked >= 30, `only ${checked} clean roles were checked`);
});

test('the role array is exactly as long as the text, including wrapper, commas and trailing newline', () => {
  const src = 'MML@t120o4l8cdef,v10r4n60,,,,;\n';
  const keys = buildRoles(src);
  assert.equal(keys.length, src.length);
  assert.equal(keys[src.indexOf('M')], ROLE.dead);
  assert.equal(keys[src.indexOf(',')], ROLE.punct);
  assert.equal(keys[src.indexOf(';')], ROLE.punct);
  assert.equal(keys[src.indexOf('t')], ROLE.t);
  assert.equal(keys[src.indexOf('1')], ROLE.t, 'the tempo number shares the t colour');
  assert.equal(keys[src.indexOf('c')], ROLE.plain, 'note letters stay plain');
  assert.equal(keys[src.indexOf('r')], ROLE.quiet);
  assert.equal(keys[src.indexOf('4', src.indexOf('r'))], ROLE.plain, 'a rest length is a length, not a colour');
  assert.equal(keys[src.indexOf('n')], ROLE.n);
  const html = renderHTML(src, keys);
  assert.equal(html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), `${src}\n `);
});

test('Studio treats the earlier frontend dialect extras and inner whitespace as errors', () => {
  const src = 'o4h8 p4@1[ceg]';
  const keys = buildRoles(src);
  for (const ch of ['h', ' ', 'p', '@', '[', ']']) assert.equal(keys[src.indexOf(ch)] & 15, ROLE.bad, ch);
  const parsed = parseTrack(src, 'Melody', { mode: 'ingest' });
  assert.ok(parsed.errors.length > 0, 'the parser agrees these are errors');
});

test('characters past the per-role limit are banded, never removed', () => {
  const role = `t120o4${'c'.repeat(2400)}`;
  const keys = buildRoles(`MML@${role},,,,,;`);
  const start = 4;
  assert.equal(keys[start + 2399] & FLAG.OVER, 0);
  assert.equal(keys[start + 2400] & FLAG.OVER, FLAG.OVER);
  assert.deepEqual(roleCharacterCounts(`MML@${role},,,,,;`), [role.length, 0, 0, 0, 0, 0]);
});

test('parser findings are layered onto their tokens; highlighting switches off above the size cap', () => {
  const mml = 'MML@t120o4l8cn60e,,,,,;';
  const validation = validateMML(mml, { meterText: '0 4/4' });
  const diagnostics = diagnosticsFromValidation(validation, ROLES);
  assert.ok(diagnostics.some(d => d.severity === 'error'), 'Nxx without opt-in fails Final');
  const keys = buildRoles(mml, { diagnostics });
  const n = mml.indexOf('n60');
  for (let k = n; k < n + 3; k++) assert.ok(keys[k] & FLAG.ERROR, 'the whole Nxx token is marked');
  assert.equal(keys[mml.indexOf('c')] & FLAG.ERROR, 0);

  const ingest = validateMML(mml, { meterText: '0 4/4', validationMode: 'ingest' });
  const cautions = diagnosticsFromValidation(ingest, ROLES);
  assert.ok(buildRoles(mml, { diagnostics: cautions })[n] & FLAG.CAUTION, 'ingest keeps Nxx as a caution');

  const huge = 'c'.repeat(MAX_HL_CHARS + 1);
  assert.ok(buildRoles(huge).every(k => k === 0));
});

test('the highlighter constants are the published ruleset values', () => {
  const syntax = EFFECTIVE_RULESET.mobileSyntax;
  assert.equal(OFFICIAL_LENGTH_MIN, syntax.officialLengthMin);
  assert.equal(OFFICIAL_LENGTH_MAX, syntax.officialLengthMax);
  assert.equal(ROLE_CHARACTER_LIMIT, syntax.perTrackCharacterLimit);
});
