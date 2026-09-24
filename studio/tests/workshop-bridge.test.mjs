// Studio Workshop ⇄ Studio Web hand-off: the MML conversion keeps the pitch
// each page's own parser reads (the two disagree on Nxx; LG-1), what the
// Workshop sends parses in Studio's own parser with the notes and timing the
// Workshop plays (or says why not), and the return record can never carry a
// verification claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAll } from '../web/workshop/mml.mjs';
import * as bridge from '../web/workshop/studio-mml.mjs';
import { parseTrack as studioTrack, splitMML as studioSplit } from '../backend/mml/parser.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import {
  projectSources, putReturn, takeReturn, workshopUrl, parseWorkshopHash, parseReturnHash,
  returnFileName, RETURN_KEY, RETURN_TTL_MS, UNVERIFIED_LABEL,
} from '../web/workshop-link.mjs';

const { workshopToStudio, studioToWorkshop, N_OFFSET } = bridge;
const workshopPitches = texts => parseAll(texts).tracks.map(t => t.notes.map(n => n.midi));
const studioPitches = mml => studioSplit(mml).map(part => studioTrack(part, 'Melody', { mode: 'ingest' }).events.filter(e => e.pitch !== undefined && e.pitch !== null).map(e => e.pitch));

// Both pages' readings in one shape: [pitch, onset, end], times in beats as
// Studio writes them ("7/4").
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const beat = tick => { const g = gcd(tick, 480); return 480 / g === 1 ? String(tick / g) : `${tick / g}/${480 / g}`; };
const plays = text => parseAll([text]).tracks[0].notes.map(n => [n.midi, beat(n.tick), beat(n.tick + n.durTick)]);
const reads = part => {
  const r = studioTrack(part, 'Melody', { mode: 'ingest' });
  return { errors: r.errors.map(e => e.message), notes: r.events.map(e => [e.pitch, e.start, e.end]) };
};
const send = text => {
  const { mml, warnings } = workshopToStudio([text]);
  return { part: studioSplit(mml)[0], codes: warnings.map(w => w.code) };
};
// Sent as the Workshop plays it: Studio reads it without an error and hears
// the same notes at the same times.
const assertFaithful = (text, want) => {
  const { part, codes } = send(text);
  if (want !== undefined) assert.equal(part, want, `sent form of ${text}`);
  assert.deepEqual(reads(part), { errors: [], notes: plays(text) }, `${text} → ${part}`);
  for (const code of ['STUDIO_SYNTAX_ERROR', 'STUDIO_READS_DIFFERENTLY', 'PITCH_OUTSIDE_WORKSHOP_RANGE']) assert.ok(!codes.includes(code), `${text}: ${code}`);
  return part;
};

// A deterministic stream of Workshop tracks: the whole dialect (h, p, #,
// several accidentals, dotted L, dotted n, `..`, relative octaves before the
// first note, ties that the Workshop does or does not hold, repeated tempi,
// @n, stray characters, commands without a number), kept to what the
// Workshop plays at its written pitch and exact timing unless `wild`.
function workshopTracks(count, seed, wild = false) {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = list => list[Math.floor(rnd() * list.length)];
  const tracks = [];
  for (let k = 0; k < count; k++) {
    let oct = 4;
    const shift = dir => { if (!wild && (oct + dir < 2 || oct + dir > 6)) return ''; oct += dir; return dir > 0 ? '>' : '<'; };
    let text = pick(['', 'o4', 't120', 'l8.', 'v10', 'n48', () => shift(1), () => shift(-1)]);
    if (typeof text === 'function') text = text();
    for (let n = 3 + Math.floor(rnd() * 24); n > 0; n--) {
      const r = rnd();
      if (r < 0.38) text += pick('cdefgabh') + pick(['', '', '+', '-', '#', '++', '-#', ...(wild ? ['---', '+++'] : [])])
        + pick(['', '', '1', '2', '4', '8', '16', '32', ...(wild ? ['0', '3', '7', '64', '128'] : [])]) + pick(['', '', '.', '..', ...(wild ? ['...'] : [])]);
      else if (r < 0.47) text += pick('rp') + pick(['', '2', '4', '8', '16']) + pick(['', '.', '..']);
      else if (r < 0.53) { oct = wild ? Math.floor(rnd() * 11) : 2 + Math.floor(rnd() * 5); text += `o${oct}`; }
      else if (r < 0.60) text += shift(rnd() < 0.5 ? 1 : -1);
      else if (r < 0.66) text += `l${pick(['1', '2', '4', '8', '16', ...(wild ? ['0', '3', '100'] : [])])}${pick(['', '', '.', '..'])}`;
      else if (r < 0.72) text += pick(['&', '&&']);
      else if (r < 0.76) text += `v${Math.floor(rnd() * (wild ? 20 : 16))}`;
      else if (r < 0.80) text += `t${wild ? Math.floor(rnd() * 400) : 60 + Math.floor(rnd() * 150)}`;
      else if (r < 0.88) text += `n${wild ? Math.floor(rnd() * 110) : 24 + Math.floor(rnd() * 60)}${pick(['', '', '.', '..'])}`;
      else text += pick(['c4&c4', 'c8&d8', 'c2.&c8', 'c4&v3c8', 'c4&l8c', 'c4&r4', '@3', 'c4&t100c4', 't100t120', 'x', 'o', 'l', 'n', 'c&n48', '&c', ...(wild ? ['o0<c', 'o8>c', 'o1<<c', 'o7>>c'] : [])]);
    }
    tracks.push(text);
  }
  return tracks;
}

test('Workshop → Studio keeps every pitch as Studio reads it, with six slots', () => {
  const texts = ['t120l4o4cdn48e', 'l4o3h8p8c#4d', 'o5l8n60n36', '', '', '', 'l4o4c'];
  const { mml, warnings, dropped } = workshopToStudio(texts);
  assert.match(mml, /^MML@[^;]*;$/);
  assert.equal(mml.slice(4, -1).split(',').length, 6);
  assert.deepEqual(dropped, [6], 'the auxiliary track is reported, not sent');
  assert.ok(warnings.some(w => w.code === 'N_REWRITTEN' && w.track === 0));
  assert.equal(mml, 'MML@t120l4o4cdn60e,l4o3b8r8c+4d,o5l8n72n48,,,;', 'h/p/# rewritten, Nxx shifted to Studio\'s reading');
  const want = workshopPitches(texts.slice(0, 6));
  const got = studioPitches(mml);
  assert.deepEqual(got.slice(0, 3), want.slice(0, 3));
  assert.equal(N_OFFSET, 12);
});

test('Workshop → Studio writes the o4 the Workshop starts from before the first named note', () => {
  assertFaithful('cde', 'o4cde');
  assertFaithful('t120l8cr8e', 't120l8o4cr8e');
  assertFaithful('n48c', 'n60o4c');
  assertFaithful('o4cde', 'o4cde');
});

test('Workshop → Studio turns a relative octave before the first note into the octave it reaches', () => {
  assertFaithful('>cd', 'o5cd');
  assertFaithful('<<l8c>d', 'o2l8c>d');
  assertFaithful('t90>>r4<c', 't90o6r4<c');
  assertFaithful('>o3c', '>o3c');
});

test('Workshop → Studio writes out the length a dotted default L gives', () => {
  assertFaithful('o4l8.cdr', 'o4l8c8.d8.r8.');
  assertFaithful('o4l4.c.d8e', 'o4l4c.d8e4.');
  assertFaithful('o4l16.c&c', 'o4l16c16.&c16.');
});

test('Workshop → Studio sends a dotted Nxx as the named note of the same pitch and length', () => {
  assertFaithful('o4n48.n50', 'o4c.n62');
  assertFaithful('o4l8.n48', 'o4l8c8.');
  assertFaithful('o5n48.c', 'o5o4c.o5c');
  assertFaithful('o4l8.n48&n48', 'o4l8c8.&c8.');
});

test('Workshop → Studio sends the game-safe rewrite of `..`, readable and timed as played', () => {
  for (const text of ['o4c4..d4', 't120o4c4..d4', 'o5c4..d4', 'o5l8c8..d8.e8.', 't120o4c2..&c8r4..n48..', 't100o4c4..&c16d', 'l8.o3cdef..g']) {
    const part = assertFaithful(text);
    assert.doesNotMatch(part, /\.\./, `${text} → ${part}`);
  }
});

test('Workshop → Studio re-spells what Studio does not read and drops what the Workshop does not play', () => {
  assertFaithful('o4c+-d##h', 'o4ceb');
  assert.deepEqual(send('o4cxd'), { part: 'o4cd', codes: ['UNREADABLE_DROPPED'] });
  assert.deepEqual(send('o4c&d'), { part: 'o4cd', codes: ['IGNORED_DROPPED'] });
  assert.deepEqual(send('o4c&r&'), { part: 'o4cr', codes: ['IGNORED_DROPPED'] });
  assert.deepEqual(send('o4t100t120c'), { part: 'o4t100c', codes: ['IGNORED_DROPPED'] });
  assert.deepEqual(send('o4c&&c'), { part: 'o4c&c', codes: [] }, 'a tie the Workshop holds is kept once');
  assert.deepEqual(send('o4t300v20c'), { part: 'o4t255v15c', codes: [] }, 'clamped as the Workshop clamps');
  assert.deepEqual(send('o9c'), { part: 'o7c', codes: ['PITCH_FOLDED'] }, 'beyond O0–O8: the pitch the Workshop plays');
});

test('what the conversion cannot express is sent with a warning, never silently', () => {
  for (const [text, code, studioErrors] of [
    ['o4c128', 'STUDIO_SYNTAX_ERROR', true],
    ['o4l100c', 'STUDIO_SYNTAX_ERROR', true],
    ['o4c64..', 'STUDIO_READS_DIFFERENTLY', false],
    ['o4c7d', 'STUDIO_READS_DIFFERENTLY', false],
    ['o0c', 'PITCH_OUTSIDE_WORKSHOP_RANGE', false],
  ]) {
    const { part, codes } = send(text);
    assert.ok(codes.includes(code), `${text} → ${part}: ${codes}`);
    const read = reads(part);
    assert.equal(read.errors.length > 0, studioErrors, `${text} → ${part}`);
    if (!studioErrors) assert.notDeepEqual(read.notes, plays(text));
  }
});

test('property: sampled Workshop tracks parse in Studio without conversion errors, with the pitches and onsets the Workshop plays', () => {
  const tracks = workshopTracks(600, 20260924);
  let dotted = 0, relative = 0, numeric = 0;
  for (const text of tracks) {
    assertFaithful(text);
    dotted += /l\d+\./.test(text) || /\.\./.test(text);
    relative += /^[<>]/.test(text);
    numeric += /n\d+\./.test(text);
  }
  assert.ok(dotted > 100 && relative > 50 && numeric > 50, `the sample covers the cases: ${dotted} ${relative} ${numeric}`);
});

test('property: anything Studio would refuse or read differently is flagged, and the mirror reads as Studio does', () => {
  const same = (part, label) => {
    const mine = bridge.readAsStudio(part);
    const theirs = studioTrack(part, 'Melody', { mode: 'ingest' });
    assert.equal(mine.errors.length === 0, theirs.errors.length === 0, `${label}: ${part} ${mine.errors} ${theirs.errors.map(e => e.message)}`);
    assert.deepEqual(mine.notes.map(n => [n.pitch, n.start, n.end]), theirs.events.map(e => [e.pitch, e.start, e.end]), `${label}: ${part}`);
  };
  for (const text of workshopTracks(600, 7, true)) {
    const { part, codes } = send(text);
    same(part, 'sent');
    same(text, 'raw Workshop text');
    const read = reads(part);
    if (read.errors.length) assert.ok(codes.includes('STUDIO_SYNTAX_ERROR'), `${text} → ${part}`);
    else if (JSON.stringify(read.notes) !== JSON.stringify(plays(text))) {
      assert.ok(codes.includes('STUDIO_READS_DIFFERENTLY') || codes.includes('PITCH_OUTSIDE_WORKSHOP_RANGE'), `${text} → ${part}: ${codes}`);
    }
  }
});

test('the mirrored Studio limits are the effective ruleset\'s, and every send warning has its text', async () => {
  const s = EFFECTIVE_RULESET.mobileSyntax;
  assert.deepEqual({ ...bridge.STUDIO_SYNTAX }, {
    octaveMin: s.octaveMin, octaveMax: s.octaveMax,
    lengthMin: s.officialLengthMin, lengthMax: s.officialLengthMax,
    tempoMin: s.tempoMin, tempoMax: s.tempoMax,
    volumeMin: s.volumeMin, volumeMax: s.volumeMax,
    numericNoteMin: s.numericNoteMin, numericNoteMax: s.numericNoteMax,
  });
  for (const tag of ['zh-Hant', 'en', 'ja', 'ko']) {
    const table = (await import(`../web/workshop/i18n/${tag}.mjs`)).default;
    for (const code of bridge.SEND_WARNING_CODES) assert.equal(typeof table[`studio.warn.${code}`], 'string', `${tag} studio.warn.${code}`);
    for (const key of ['studio.nWarning', 'studio.nLowWarning']) assert.equal(typeof table[key], 'string', `${tag} ${key}`);
  }
  const reported = new Set();
  for (const text of workshopTracks(400, 11, true)) for (const w of workshopToStudio([text]).warnings) reported.add(w.code);
  for (const code of reported) assert.ok(bridge.SEND_WARNING_CODES.includes(code), `${code} is listed`);
});

test('Studio → Workshop keeps every pitch as the Workshop reads it', () => {
  const studio = 'MML@t120o4c4n60e4,l8o3n48c,,,,;';
  const { mml, parts } = studioToWorkshop(studio);
  assert.equal(mml, 'MML@t120o4c4n48e4,l8o3n36c,,,,;');
  assert.deepEqual(workshopPitches(parts).slice(0, 2), studioPitches(studio).slice(0, 2));
  assert.deepEqual(bridge.trackToWorkshop('o4n5c'), { text: 'o4o0<fo4c', warnings: ['N_BELOW_WORKSHOP_RANGE'] }, 'N0–N11 become octave −1 notes, never folded');
});

test('Studio N0–N11 (and N12–N23) come back at the same pitch after an untouched round trip', () => {
  const studio = 'MML@t120o4l8cN5d4N11&N11N0>c,l4o3N12N23c,,,,;';
  const before = studioSplit(studio).map(reads);
  assert.deepEqual(before.map(r => r.errors), [[], [], [], [], [], []]);
  const opened = studioToWorkshop(studio);
  const back = workshopToStudio(opened.parts);
  assert.deepEqual(studioSplit(back.mml).map(reads), before, 'the same notes, pitches and times');
  assert.ok(back.warnings.some(w => w.code === 'PITCH_OUTSIDE_WORKSHOP_RANGE' && w.track === 0), 'and the sender is told the Workshop played them folded');

  // Opening says what it did: octave −1 notes, which the Workshop plays
  // folded into its range, as it plays every note outside o1c–o7b.
  assert.ok(opened.warnings.some(w => w.code === 'N_BELOW_WORKSHOP_RANGE' && w.track === 0));
  assert.ok(!opened.warnings.some(w => w.code === 'N_BELOW_WORKSHOP_RANGE' && w.track === 1), 'N12–N23 are ordinary n0–n11');
  assert.equal(opened.parts[0], 't120o4l8co0<fo4d4o0<b&bco4>c');
  assert.deepEqual(parseAll(opened.parts).tracks[0].notes.map(n => n.midi), [60, 29, 62, 35, 24, 72]);
});

test('project sources list the Final/delivery MML and only MML assets', () => {
  const workspace = {
    id: 'p1', deliveryMml: ' MML@t120o4c1,,,,,; ',
    assets: {
      candidate: { format: 'MML', name: 'cand.mml', content: 'MML@t120o4d1,,,,,;' },
      baseline: { format: 'MusicXML', name: 'b.musicxml', content: '<score-partwise/>' },
      previous: { format: 'MML', name: 'prev.mml', content: 'not mml' },
    },
  };
  assert.deepEqual(projectSources(workspace).map(s => [s.slot, s.mml]), [['delivery', 'MML@t120o4c1,,,,,;'], ['candidate', 'MML@t120o4d1,,,,,;']]);
  assert.deepEqual(projectSources(null), []);
  const url = workshopUrl('p 1', 'delivery');
  assert.equal(url, './studio/web/workshop/index.html#studio-project=p+1&asset=delivery');
  assert.deepEqual(parseWorkshopHash(url.slice(url.indexOf('#'))), { projectId: 'p 1', slot: 'delivery' });
  assert.equal(parseWorkshopHash('#asset=x'), null);
});

test('the return record is read once, expires, and is never a verification claim', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  const now = Date.UTC(2026, 8, 23);
  const id = putReturn({ mml: 'MML@t120o4c1,,,,,;', name: 'Song', origin: { projectId: 'p1' }, warnings: ['w'] }, storage, now);
  assert.ok(store.has(RETURN_KEY));
  assert.equal(takeReturn('other-id', storage, now), null, 'another id is not imported');
  assert.ok(store.has(RETURN_KEY), 'and does not consume the record');
  const record = takeReturn(id, storage, now + 1000);
  assert.deepEqual({ ...record, at: undefined }, { id, at: undefined, mml: 'MML@t120o4c1,,,,,;', name: 'Song', origin: { projectId: 'p1' }, warnings: ['w'], label: UNVERIFIED_LABEL, verified: false });
  assert.equal(takeReturn(id, storage, now + 2000), null, 'read once');

  const stale = putReturn({ mml: 'MML@c,,,,,;' }, storage, now);
  assert.equal(takeReturn(stale, storage, now + RETURN_TTL_MS + 1), null, 'expired');
  store.set(RETURN_KEY, JSON.stringify({ schema: 'mml-studio/workshop-return@1', id: 'x', at: now, mml: 'MML@c,,,,,;', verified: true, state: 'VALIDATED' }));
  assert.equal(takeReturn('x', storage, now).verified, false, 'a forged claim is dropped');
  assert.equal(takeReturn('x', storage, now), null);
  assert.throws(() => putReturn({ mml: 'not mml' }, storage, now), /WORKSHOP_RETURN_INVALID/);
  assert.equal(parseReturnHash('#workshop-return=abc'), 'abc');
  assert.equal(returnFileName({ name: 'My/Song' }, new Date(Date.UTC(2026, 8, 23, 4, 5))), 'My_Song-workshop-edit-202609230405.mml');
});
