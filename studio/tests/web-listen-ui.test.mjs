import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createListening } from '../web/listen-ui.mjs';
import { encodeListenLink } from '../web/listen-link.mjs';

// The listening panel with its boundaries doubled: the page (one plain object
// per selector, so a test can press what the panel bound), the session store's
// IndexedDB (in memory, every step in a task of its own, as in a browser) and
// the Worker call. What is checked is what the status line says about a
// session that could not open.
function memoryIndexedDB(hooks) {
  const records = new Map();
  const later = fn => setTimeout(fn, 0);
  const indexedDB = {
    open() {
      hooks.onOpen?.();
      const request = {};
      later(() => {
        request.result = {
          createObjectStore() {},
          transaction() {
            const tx = {};
            const op = run => { const r = {}; later(() => { r.result = run(); later(() => tx.oncomplete?.()); }); return r; };
            tx.objectStore = () => ({
              getAll: () => op(() => [...records.values()].map(value => structuredClone(value))),
              get: id => op(() => structuredClone(records.get(id))),
              put: value => op(() => { records.set(value.id, structuredClone(value)); return value.id; }),
              delete: id => op(() => { records.delete(id); }),
            });
            return tx;
          },
          close() {},
        };
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { indexedDB, records };
}
async function panel(t, { call, hooks = {} }) {
  const memory = memoryIndexedDB(hooks);
  const had = Object.hasOwn(globalThis, 'indexedDB'), previous = globalThis.indexedDB;
  globalThis.indexedDB = memory.indexedDB;
  t.after(() => { if (had) globalThis.indexedDB = previous; else delete globalThis.indexedDB; });
  const elements = new Map();
  const element = selector => { if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', dataset: {} }); return elements.get(selector); };
  const root = { hidden: true, innerHTML: '', querySelector: element, querySelectorAll: () => [], scrollIntoView() {} };
  const messages = [];
  const listening = createListening({ root, call, message: (text, error = false) => messages.push([text, error]), copyText() {}, audio: { stop() {} } });
  return { listening, root, element, messages, records: memory.records };
}
const codec = { deflateRaw: bytes => new Uint8Array(zlib.deflateRawSync(bytes)) };
const refused = Error('本機分析 Worker 無法啟動');

test('送到試聽 whose session could not open says why, and never that it opened', async t => {
  const { listening, root, messages, records } = await panel(t, { call: async () => { throw refused; } });
  await assert.rejects(listening.openFromProject({ projectId: 'p1', projectTitle: '專案', label: '候選 MML', mml: 'MML@t120o4l4cdef,,,,,;' }), { message: refused.message });
  assert.deepEqual(messages, [], 'the caller shows the failure; nothing reports a session that opened');
  assert.ok(root.innerHTML.includes(refused.message), 'the panel shows the same reason');
  assert.equal(records.size, 1, 'the session is kept, so it can be opened again from the list');
});

// open() used to leave its reason in the panel's shared state, and the link
// read it back after open() returned. Opening another session from the list
// in that window cleared it, and the status line said the link could not open
// because of "null".
test('a listen link that could not open reports its own reason while another session is opened from the list', async t => {
  const payload = await encodeListenLink({ schema: 'mml-studio/listen-link@1', mml: 'MML@t120o4l4cdef,,,,,;', title: '連結' }, codec);
  let armed = false;
  const hooks = {};
  const { listening, element, messages, records } = await panel(t, {
    hooks,
    call: async (action, mml) => {
      assert.equal(action, 'parseListening');
      if (mml === 'MML@t120o4l4cdef,,,,,;') { armed = true; throw refused; }
      return new Promise(() => {}); // the other session is still being read
    },
  });
  records.set('other', { id: 'other', title: '另一個', mml: 'MML@t120o4l4g,,,,,;', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', notes: [], markers: [] });
  // The link's session failed to open and the panel is refreshing its list:
  // the user presses 開啟 on the other session.
  hooks.onOpen = () => {
    if (!armed) return;
    armed = false;
    element('#listen-session-select').value = 'other';
    element('#listen-session-open').onclick();
  };
  assert.equal(await listening.importPayload(payload), null);
  assert.deepEqual(messages, [[`試聽連結無法開啟：${refused.message}`, true]]);
});
