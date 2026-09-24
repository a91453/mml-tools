import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ENTRY_BYTES, crc32, unzipFiles, zipFiles } from '../web/backup-zip.mjs';

const text = value => new TextEncoder().encode(value);

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926);
});

test('zip round-trips projects exactly, compressed or stored', async () => {
  const files = [
    { name: 'projects/Song-A-1234.json', data: text(JSON.stringify({ id: 'a', title: '歌曲 A', notes: 'x'.repeat(5000) })) },
    { name: 'projects/tiny.json', data: text('{}') },
  ];
  for (const compress of [true, false]) {
    const back = await unzipFiles(await zipFiles(files, { compress }));
    assert.deepEqual(back.map(f => f.name), files.map(f => f.name));
    back.forEach((f, i) => assert.deepEqual(Buffer.from(f.data), Buffer.from(files[i].data)));
  }
});

test('names that differ only in case are kept apart', async () => {
  const back = await unzipFiles(await zipFiles([{ name: 'a.json', data: text('1') }, { name: 'A.json', data: text('2') }]));
  assert.deepEqual(back.map(f => f.name), ['a.json', 'A-2.json']);
});

test('the archive opens with the system unzip tool', async t => {
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { return t.skip('unzip not installed'); }
  const dir = await mkdtemp(join(tmpdir(), 'studio-zip-'));
  await writeFile(join(dir, 'b.zip'), await zipFiles([{ name: 'p/one.json', data: text('{"id":1}') }]));
  execFileSync('unzip', ['-q', 'b.zip'], { cwd: dir });
  assert.equal(await readFile(join(dir, 'p/one.json'), 'utf8'), '{"id":1}');
});

test('corrupted or oversized archives are refused', async () => {
  const zip = await zipFiles([{ name: 'x.json', data: text('{"a":1}') }], { compress: false });
  const flipped = zip.slice(); flipped[31 + 'x.json'.length] ^= 0xff; // one body byte
  await assert.rejects(unzipFiles(flipped), /校驗失敗/);
  await assert.rejects(unzipFiles(text('not a zip')), /不是有效的 ZIP/);
  const big = zip.slice();
  const view = new DataView(big.buffer);
  const central = big.length - 22 - (46 + 'x.json'.length);
  view.setUint32(central + 24, MAX_ENTRY_BYTES + 1, true); // declared uncompressed size
  await assert.rejects(unzipFiles(big), /超過/);
});

test('a Raw MIDI project backup carries its bytes, not its event list, and restores to the same project', async () => {
  // A 5,000-note MIDI in two slots used to write a 16.2 MiB backup, over the
  // 16 MiB a restore accepts. Restore re-ingests MIDI from the bytes and never
  // read the stored events.
  const { portableBackup } = await import('../web/backup-zip.mjs');
  const model = await import('../web/model.mjs');
  const { buildMidi, buildTrack, notesToEntries, setTempo } = await import('./fixtures/midi-fixtures.mjs');
  const notes = Array.from({ length: 5000 }, (_, i) => [i % 3, 48 + (i % 24), i * 90, i * 90 + 80]);
  const midi = buildMidi({ tracks: [buildTrack([[0, ...setTempo(500000)], ...notesToEntries(notes)])] });
  const workspace = model.newWorkspace();
  workspace.assets.candidate = model.intakeMidi({ name: 'song.mid', bytes: midi });
  workspace.assets.baseline = model.intakeMidi({ name: 'song.mid', bytes: midi });
  const backup = text(portableBackup(workspace, { canonical_version: 'test' }));
  assert.ok(backup.length < 2 * 1024 * 1024, `${backup.length} bytes`);
  const [entry] = await unzipFiles(await zipFiles([{ name: 'projects/song.json', data: backup }]));
  const restored = model.importWorkspace(new TextDecoder().decode(entry.data));
  for (const slot of ['candidate', 'baseline']) {
    assert.deepEqual(restored.assets[slot].project.events.map(event => event.id), workspace.assets[slot].project.events.map(event => event.id), slot);
    assert.equal(restored.assets[slot].source.sha256, workspace.assets[slot].source.sha256);
  }
  // A text asset is carried unchanged.
  const mml = model.newWorkspace();
  mml.assets.candidate = model.intake({ name: 'c.mml', content: 'MML@t120o4c1,,,,,;', id: 'c' });
  assert.deepEqual(JSON.parse(portableBackup(mml, null)).assets.candidate, JSON.parse(JSON.stringify(mml.assets.candidate)));
});

test('an entry that inflates past its declared size is refused without inflating it all', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const packed = deflateRawSync(Buffer.alloc(64 * 1024 * 1024, 0x20), { level: 9 });
  const name = Buffer.from('projects/x.json');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(10, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(10, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + packed.length, 16);
  const zip = new Uint8Array(Buffer.concat([local, name, packed, central, name, end]));
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(unzipFiles(zip), /projects\/x\.json 的內容校驗失敗/);
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024, 'the 64 MiB body was never held');
});
