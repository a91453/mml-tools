// Studio Workshop (studio/web/workshop/): the editor's MML core — parse and
// re-encode round trips, piano-roll edit operations and undo/redo history.
// The Workshop is outside the Canonical pipeline; these tests pin the ported
// editor's own behaviour, not any Canonical rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAll, splitMML, bareTrack, scanTokens, compact } from '../web/workshop/mml.mjs';
import { trackToItems, itemsToMML, reflow, compressMML, gameSafeTrack } from '../web/workshop/mml-compress.mjs';
import { insertNote, deleteNote, moveNote, transpose, findNote } from '../web/workshop/rolledit.mjs';
import * as history from '../web/workshop/history.mjs';

const notesOf = song => song.tracks.map(t => t.notes.map(n => [n.tick, n.durTick, n.midi, n.vel]));
const SAMPLE = [
  't120v12l8o5ceg>c<gec4dfa>c<afd4<b>dgbgd<b>dc2r2',
  't120v10l2o4egfadge1',
  't96v9l16o3c<b>c<b>c4.&c16 r8 d+8f+8a-4',
  'l4o4c.d8e8.f16 g2&g8 a8b8>c8',
];

test('parse → re-encode → parse keeps every note (tick, length, pitch, velocity)', () => {
  const before = parseAll(SAMPLE);
  const encoded = SAMPLE.map(text => {
    const t = trackToItems(bareTrack(text));
    assert.equal(t.error, undefined, t.error);
    const out = itemsToMML(t.items, {});
    assert.equal(typeof out, 'string');
    return out;
  });
  assert.deepEqual(notesOf(parseAll(encoded)), notesOf(before));
});

test('reflow only moves line breaks; the parsed song is unchanged', () => {
  for (const bars of [0, 1, 2, 4]) {
    const flowed = SAMPLE.map(text => reflow(text, bars));
    assert.deepEqual(notesOf(parseAll(flowed)), notesOf(parseAll(SAMPLE)), `bars per line ${bars}`);
    if (bars === 0) for (const t of flowed) assert.doesNotMatch(t.trim(), /\n/);
  }
});

test('lossless compression and the game-safe pass are event-preserving', () => {
  const src = `MML@${SAMPLE.join(',')};`;
  const r = compressMML(src, { verifyWith: s => parseAll(splitMML(s)) });
  assert.notEqual(r.ok, false);
  assert.deepEqual(notesOf(parseAll(splitMML(r.mml))), notesOf(parseAll(SAMPLE)));
  const fixed = gameSafeTrack('t120l8c..d4..e');
  assert.ok(fixed.fixed, 'double dots are rewritten');
  assert.doesNotMatch(fixed.text, /\.\./);
  assert.deepEqual(notesOf(parseAll([fixed.text])), notesOf(parseAll(['t120l8c..d4..e'])));
});

test('the scanner covers every character of a track exactly once', () => {
  for (const text of [...SAMPLE, 'h8p8n48@3[ceg]c#4X']) {
    const { t } = compact(text);
    let at = 0;
    for (const tok of scanTokens(t)) { assert.equal(tok.a, at); assert.ok(tok.b > tok.a); at = tok.b; }
    assert.equal(at, t.length);
  }
});

test('piano-roll edits: draw, move, transpose and delete a note', () => {
  const items = trackToItems('t120l4o4cdef').items;
  const at = 480 * 4;
  const drawn = insertNote(items, at, 480, 67);
  const song = parseAll([itemsToMML(drawn, {})]);
  assert.deepEqual(song.tracks[0].notes.map(n => n.midi), [60, 62, 64, 65, 67]);
  assert.ok(findNote(drawn, at, 67));

  const moved = moveNote(drawn, { tick: at, midi: 67 }, { tick: at + 480, midi: 69 });
  const movedSong = parseAll([itemsToMML(moved, {})]).tracks[0].notes;
  assert.deepEqual(movedSong.at(-1).tick, at + 480);
  assert.equal(movedSong.at(-1).midi, 69);

  const up = transpose(moved, 2);
  assert.deepEqual(parseAll([itemsToMML(up.items, {})]).tracks[0].notes.map(n => n.midi), [62, 64, 66, 67, 71]);
  assert.deepEqual(transpose(moved, 60), { low: 0, high: 5 }, 'a transpose past the range is refused, never folded');

  const gone = deleteNote(moved, at + 480, 69);
  assert.deepEqual(parseAll([itemsToMML(gone, {})]).tracks[0].notes.map(n => n.midi), [60, 62, 64, 65]);
});

test('undo/redo restores exact snapshots, and a new edit clears the redo stack', () => {
  let doc = { text: 'l4cde' };
  const applied = [];
  history.init({ snapshot: () => structuredClone(doc), restore: s => { doc = structuredClone(s); }, onApply: () => applied.push(doc.text) });
  history.edit(() => { doc.text += 'f'; });
  history.edit(() => { doc.text += 'g'; });
  history.edit(() => {});
  assert.deepEqual(history._debug(), { undo: 2, redo: 0, pending: false }, 'a no-op edit records nothing');
  assert.equal(history.undo(), true);
  assert.equal(doc.text, 'l4cdef');
  assert.equal(history.undo(), true);
  assert.equal(doc.text, 'l4cde');
  assert.equal(history.undo(), false);
  assert.equal(history.redo(), true);
  assert.equal(doc.text, 'l4cdef');
  history.edit(() => { doc.text = 'l4c'; });
  assert.equal(history.canRedo(), false);
  assert.deepEqual(applied, ['l4cdef', 'l4cde', 'l4cdef']);

  // A typing burst becomes one undo step when it is flushed.
  history.typed(); doc.text += 'r'; history.typed(); doc.text += 'r';
  history.flushTyping();
  assert.equal(history.undo(), true);
  assert.equal(doc.text, 'l4c');
  history.reset();
});
