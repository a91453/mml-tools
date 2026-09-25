import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

  // `writeCount` is how the policy's plan-derivation memo proves no write of
  // this process landed while a derivation ran (`plan-derivation-memo.mjs`):
  // an outcome is held only if the count did not move. A write method that
  // forgot to count would let an outcome derived across that write be held
  // and served for the state after it. The record and blob writes proposals
  // and runs actually make go through `writeProjectRecord`, `putJson` and
  // `putBytes`, so every method is pinned here on its own -- and every method
  // the store exposes must be classified, so one added later without a
  // decision about the counter fails this test rather than slipping past it.
  test(`${backend}: every write method moves the write count, once per call, and no read moves it`, t => {
    const store = storeFor(t, 64);
    const record = id => ({ project_id: `prj_${id.repeat(32)}`, owner: 'owner:store-write-count', title: id });
    const writes = {
      createProjectRecord: () => store.createProjectRecord(record('a')),
      writeProjectRecord: () => store.writeProjectRecord({ ...record('a'), title: 'rewritten' }),
      deleteProjectRecord: () => store.deleteProjectRecord(record('a').project_id),
      putBytes: () => store.putBytes('blob:bytes', Uint8Array.of(1, 2, 3)),
      putJson: () => store.putJson('blob:json', { value: 1 }),
      deleteBytes: () => store.deleteBytes('blob:bytes'),
    };
    const reads = {
      describe: () => store.describe(),
      readProjectRecord: () => store.readProjectRecord(record('b').project_id),
      listProjectRecords: () => store.listProjectRecords('owner:store-write-count'),
      getBytes: () => store.getBytes('blob:json'),
      getJson: () => store.getJson('blob:json'),
      usedBytes: () => store.usedBytes(),
      writeCount: () => store.writeCount(),
    };
    const values = ['maxBytes'];
    assert.deepEqual(Object.keys(store).sort(), [...Object.keys(writes), ...Object.keys(reads), ...values].sort(),
      'every store member is classified as a write, a read or a value');

    store.createProjectRecord(record('b'));
    for (const [name, write] of Object.entries(writes)) {
      const before = store.writeCount();
      write();
      assert.equal(store.writeCount(), before + 1, `${name} moves the write count by one`);
      for (const [readName, read] of Object.entries(reads)) {
        const unmoved = store.writeCount();
        read();
        assert.equal(store.writeCount(), unmoved, `${readName} is a read and moves nothing`);
      }
    }
    // The count is of attempts, not successes: a write the store refuses
    // still says something MAY have changed.
    for (const name of ['putBytes', 'putJson']) {
      const before = store.writeCount();
      assert.throws(() => store[name]('blob:too-big', name === 'putBytes' ? new Uint8Array(65) : { value: 'x'.repeat(65) }), { code: 'STORAGE_FULL' });
      assert.equal(store.writeCount(), before + 1, `a refused ${name} is counted`);
    }
  });
}

test('a temp file a failed or interrupted write left behind is neither charged nor kept', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mml-store-tmp-'));
  try {
    const store = createStore({ directory, durability: 'persistent', maxBytes: 1000 });
    store.putBytes('asset:a', new Uint8Array(400));
    assert.equal(store.usedBytes(), 400);
    // What a crash between writeFileSync and renameSync leaves.
    const stray = join(directory, 'blobs', 'deadbeef.bin.0011223344556677.tmp');
    writeFileSync(stray, new Uint8Array(500));
    writeFileSync(join(directory, 'records', 'x.json.0011223344556677.tmp'), '{');
    assert.equal(store.usedBytes(), 400, 'a temp file is not stored content');
    store.putBytes('asset:b', new Uint8Array(500));
    assert.equal(store.usedBytes(), 900);
    // The next start clears what the interrupted write left.
    const reopened = createStore({ directory, durability: 'persistent', maxBytes: 1000 });
    assert.deepEqual(readdirSync(join(directory, 'blobs')).filter(name => name.endsWith('.tmp')), []);
    assert.deepEqual(readdirSync(join(directory, 'records')).filter(name => name.endsWith('.tmp')), []);
    assert.equal(reopened.usedBytes(), 900);
    assert.deepEqual(Array.from(reopened.getBytes('asset:a')).length, 400);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
