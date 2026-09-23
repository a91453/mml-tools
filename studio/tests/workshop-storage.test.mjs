// Studio Workshop: autosave (localStorage) and the local song library's
// snapshot format (IndexedDB records). Keys and database names belong to
// Studio (studio-workshop/...). The IndexedDB round trip itself runs in the
// browser suite (studio/browser-tests/workshop.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  keys() { return [...this.#m.keys()]; }
}
globalThis.localStorage = new MemoryStorage();
globalThis.addEventListener ??= () => {};
globalThis.document ??= { visibilityState: 'visible' };

const storage = await import('../web/workshop/storage.mjs');
const library = await import('../web/workshop/library.mjs');

test('autosave writes one Studio-owned key and reads back a clean state', async () => {
  let savedAt = null;
  storage.setSavedHandler(at => { savedAt = at; });
  const state = { count: 3, active: 1, texts: ['t120l4cde', 'l2eg', ''], presets: ['[0,0,24,"lute"]', null, null], ghosts: [true, false, true], zip: [null, null, null], meters: [{ tick: 0, num: 3, den: 4 }], marks: [{ tick: 0, text: 'A' }] };
  storage.save(state);
  storage.flush();
  assert.ok(Number.isFinite(savedAt));
  assert.deepEqual(localStorage.keys(), [storage.KEY]);
  assert.equal(storage.KEY, 'studio-workshop/score');
  const back = storage.load();
  assert.deepEqual(back.texts, state.texts);
  assert.deepEqual(back.presets, state.presets);
  assert.equal(back.count, 3);
  assert.equal(back.active, 1);
  assert.deepEqual(back.meters, [{ tick: 0, num: 3, den: 4 }]);
  assert.deepEqual(back.marks, [{ tick: 0, text: 'A' }]);

  storage.saveUI({ theme: 'light', lang: 'ja' });
  assert.deepEqual(storage.loadUI(), { theme: 'light', lang: 'ja' });
  assert.equal(storage.UI_KEY, 'studio-workshop/ui');

  storage.setAutosave(false);
  storage.save({ ...state, texts: ['changed'] });
  storage.flush();
  assert.deepEqual(storage.load().texts, state.texts, 'autosave off writes nothing');
  storage.setAutosave(true);

  localStorage.setItem(storage.KEY, '{broken');
  assert.equal(storage.load(), null, 'an unreadable autosave falls back to the default score');
});

test('library snapshots round-trip through the stored format and are size-checked', () => {
  assert.equal(library.DB_NAME, 'studio-workshop-library');
  const snap = { texts: ['t120l4cde', 'l2eg', 'l1c', ...Array(12).fill('')], presets: ['[0,0,24,"lute"]', '[0,0,40,"violin"]', null, ...Array(12).fill(null)], count: 3, active: 2, zip: Array(15).fill(null) };
  const stored = library.fromSnapshot(snap, [true, false, true, ...Array(12).fill(true)], [{ tick: 0, num: 4, den: 4 }], [{ tick: 960, text: 'B' }]);
  assert.equal(library.cleanSnapshot(JSON.parse(JSON.stringify(stored)))?.v, library.SNAPSHOT_VERSION);
  const back = library.toSnapshot(library.cleanSnapshot(JSON.parse(JSON.stringify(stored))));
  assert.deepEqual(back.texts.slice(0, 3), snap.texts.slice(0, 3));
  assert.deepEqual(back.presets.slice(0, 2), snap.presets.slice(0, 2));
  assert.equal(back.count, 3);
  assert.deepEqual(library.metersOf(stored), [{ tick: 0, num: 4, den: 4 }]);
  assert.deepEqual(library.marksOf(stored), [{ tick: 960, text: 'B' }]);
  assert.equal(library.cleanSnapshot({ v: 99, tabs: [] }), null);

  const bytes = library.snapshotBytes(stored);
  assert.ok(library.fits(0, bytes).ok);
  assert.equal(library.fits(library.MAX_BYTES, bytes).ok, false);
  assert.ok(library.fits(library.MAX_BYTES, bytes, bytes).ok, 'replacing a file frees its own bytes');
  assert.deepEqual(library.zipEntryNames(['Song', 'song', 'a/b']), ['Song.mml', 'song-2.mml', 'ab.mml']);
  assert.equal(library.cleanName('  x  '), 'x');
});
