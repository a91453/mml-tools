import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../backend/application/store.mjs';

for (const backend of ['memory', 'filesystem']) {
  function storeFor(t, maxBytes) {
    const directory = backend === 'filesystem' ? mkdtempSync(join(tmpdir(), 'mml-store-regression-')) : null;
    if (directory) t.after(() => rmSync(directory, { recursive: true, force: true }));
    return createStore({ directory, maxBytes });
  }

  test(`${backend}: replacement capacity counts the previous blob only once`, t => {
    const store = storeFor(t, 10);
    store.putBytes('baseline', Uint8Array.of(1, 2, 3, 4, 5, 6));
    store.putBytes('other', Uint8Array.of(7, 8, 9, 10));
    assert.equal(store.usedBytes(), 10);
    store.putBytes('baseline', Uint8Array.of(6, 5, 4, 3, 2, 1));
    assert.equal(store.usedBytes(), 10);
    assert.deepEqual([...store.getBytes('baseline')], [6, 5, 4, 3, 2, 1]);
    store.putBytes('baseline', Uint8Array.of(1, 2));
    assert.equal(store.usedBytes(), 6);
    store.putBytes('baseline', Uint8Array.of(1, 2, 3, 4, 5, 6));
    assert.equal(store.usedBytes(), 10);
    assert.throws(() => store.putBytes('baseline', new Uint8Array(7)), { code: 'STORAGE_FULL' });
    assert.throws(() => store.putBytes('new', Uint8Array.of(1)), { code: 'STORAGE_FULL' });
    assert.equal(store.usedBytes(), 10);
    assert.deepEqual([...store.getBytes('baseline')], [1, 2, 3, 4, 5, 6]);
  });

  test(`${backend}: JSON replacement and byte/JSON key reuse share the same quota accounting`, t => {
    const value = { title: '\u97f3\u6a02' };
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const store = storeFor(t, size);
    store.putJson('review', value);
    assert.equal(store.putJson('review', value), size);
    assert.deepEqual(store.getJson('review'), value);
    store.putBytes('review', Uint8Array.of(1));
    assert.equal(store.usedBytes(), 1);
    assert.equal(store.putJson('review', value), size);
    assert.equal(store.usedBytes(), size);
    assert.throws(() => store.putJson('review', { title: 'x'.repeat(size) }), { code: 'STORAGE_FULL' });
    assert.deepEqual(store.getJson('review'), value);
  });

  test(`${backend}: callers cannot mutate stored bytes through a read result`, t => {
    const store = storeFor(t, 10);
    const input = Uint8Array.of(1, 2, 3);
    store.putBytes('asset', input);
    input[0] = 99;
    const first = store.getBytes('asset');
    first[1] = 99;
    const second = store.getBytes('asset');
    assert.notStrictEqual(first, second);
    assert.deepEqual([...second], [1, 2, 3]);
    assert.equal(store.usedBytes(), 3);
    assert.equal(store.getBytes('missing'), null);
    store.putBytes('empty', new Uint8Array());
    assert.deepEqual(store.getBytes('empty'), new Uint8Array());
  });
}
