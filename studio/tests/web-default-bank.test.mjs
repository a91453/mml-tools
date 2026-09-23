import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from 'spessasynth_core';
import {
  DEFAULT_BANK_DRUM_NOTES, DEFAULT_BANK_LABEL, DEFAULT_BANK_PROGRAMS, DEFAULT_INSTRUMENT, GAME_INSTRUMENTS, instrumentOptions,
  resolveRoleVoices, uniformProgram, voiceFor,
} from '../web/preview/instruments.mjs';
import { DEFAULT_BANK_DOWNLOAD_NOTICE, DEFAULT_BANK_SUBSET, DEFAULT_BANK_UPSTREAM, loadDefaultBank } from '../web/preview/default-bank.mjs';
import { DEFAULT_BANK_CREATION_DATE, trimDefaultBank } from '../web/preview/default-bank-trim.mjs';
import { createTransport } from '../web/preview/player.mjs';
import { parseListening } from '../web/listen-model.mjs';
import { syntheticUpstreamBank } from './support/synthetic-soundbank.mjs';

const dir = new URL('../web/default-bank/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', dir), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('provenance pins the upstream file and the subset; no bank is stored beside it', async () => {
  assert.equal(provenance.license, 'MIT');
  assert.deepEqual(provenance.upstream, { ...provenance.upstream, url: DEFAULT_BANK_UPSTREAM.url, sha256: DEFAULT_BANK_UPSTREAM.sha256, bytes: DEFAULT_BANK_UPSTREAM.bytes });
  assert.equal(DEFAULT_BANK_UPSTREAM.url, 'https://raw.githubusercontent.com/musescore/MuseScore/v2.3.2/share/sound/FluidR3Mono_GM.sf3');
  assert.equal(DEFAULT_BANK_UPSTREAM.sha256, 'cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2');
  assert.equal(DEFAULT_BANK_UPSTREAM.bytes, 14563174);
  assert.equal(DEFAULT_BANK_SUBSET.sha256, 'f41a3077bd83b81b1c64e2bc3eb1d9a30ff1907e674ab805da3fcb805354a633');
  assert.equal(provenance.output.sha256, DEFAULT_BANK_SUBSET.sha256);
  assert.equal(provenance.output.bytes, DEFAULT_BANK_SUBSET.bytes);
  assert.deepEqual(provenance.output.programs, [...DEFAULT_BANK_PROGRAMS]);
  assert.deepEqual(provenance.output.drum_notes, [...DEFAULT_BANK_DRUM_NOTES]);
  assert.equal(provenance.tool.creation_date, DEFAULT_BANK_CREATION_DATE);
  assert.match(provenance.distribution, /^Not redistributed/);
  assert.equal(DEFAULT_BANK_DOWNLOAD_NOTICE, '第一次使用免費音色：將從 MuseScore 官方來源下載約 14.6 MB，只存在這台裝置');
  // The licence and the record stay; the bank itself is never in the tree.
  assert.deepEqual((await readdir(dir)).sort(), ['LICENSE.md', 'provenance.json']);
  const license = (await readFile(new URL('LICENSE.md', dir), 'utf8')).replace(/\s+/g, ' ');
  for (const phrase of ['This Mono version of FluidR3 GM is released under the MIT license', 'Permission is hereby granted, free of charge', 'Frank Wen', 'Michael Cowgill', provenance.upstream.license_sha256, 'Neither that file nor the subset is stored in this repository or shipped in the Studio Web build']) {
    assert.ok(license.includes(phrase), `LICENSE.md carries: ${phrase}`);
  }
});

test('the instrument mapping resolves every role to a preset the recorded subset carries', () => {
  assert.deepEqual(GAME_INSTRUMENTS.map(item => [item.name, item.label, item.program, item.drumNotes ?? null]), [
    ['Lute', '魯特琴', 24, null], ['Mandolin', '曼陀林', 25, null], ['Chalumeau', '夏盧莫管', 71, null], ['Xylophone', '木琴', 13, null],
    ['Flute', '長笛', 73, null], ['Violin', '小提琴', 40, null], ['Piano', '鋼琴', 0, null], ['Harp', '豎琴', 46, null],
    ['Music Box', '音樂盒', 10, null], ['BassDrum', '大鼓', 0, [35, 36]], ['Cymbals', '鈸', 0, [49, 57]],
  ]);
  assert.equal(DEFAULT_BANK_LABEL, '免費通用音色（近似），不是遊戲音色');
  for (const item of GAME_INSTRUMENTS) {
    for (const voice of resolveRoleVoices(Array(6).fill(item.id))) {
      assert.ok(provenance.output.presets.some(p => p.program === voice.program && p.drums === (voice.drumNote !== null)), `${item.name} resolves to a preset in the subset`);
      if (voice.drumNote !== null) assert.ok(provenance.output.drum_notes.includes(voice.drumNote));
    }
  }
  const mixed = resolveRoleVoices(['lute', 'harp', 'piano', 'bass-drum', 'cymbals', 'nonsense']);
  assert.deepEqual(mixed.map(v => [v.program, v.drumNote]), [[24, null], [46, null], [0, null], [0, 35], [0, 49], [24, null]]);
  assert.equal(voiceFor(undefined).id, DEFAULT_INSTRUMENT);
  // A user bank's own presets are chosen as p:<program>.
  assert.deepEqual(voiceFor('p:5'), { program: 5, drumNote: null, label: '006' });
  assert.equal(voiceFor('p:300').id, DEFAULT_INSTRUMENT);
  assert.equal(uniformProgram(resolveRoleVoices(Array(6).fill('violin'))), 40);
  assert.equal(uniformProgram(mixed), null);
  assert.equal(instrumentOptions({ defaultBank: true }).length, 11);
  assert.deepEqual(instrumentOptions({ defaultBank: false, presets: [{ program: 0, name: 'Saw' }] }), [{ value: 'p:0', label: '001 Saw' }]);
});

// ─── the browser's download, verification and cache, without a network ───
const synthetic = syntheticUpstreamBank();
const syntheticSubset = trimDefaultBank(synthetic, core).bytes;
const pins = { upstream: { url: DEFAULT_BANK_UPSTREAM.url, sha256: sha256(synthetic), bytes: synthetic.length }, subset: { sha256: sha256(syntheticSubset), bytes: syntheticSubset.length } };
const nodeTrim = async upstream => trimDefaultBank(new Uint8Array(upstream), core).bytes.buffer;
function memoryCache() {
  const records = new Map();
  return { records, load: async sha => records.get(sha) ?? null, store: async record => { records.set(record.sha256, record); } };
}
function recordingFetch(body = synthetic, init = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return new Response(body.slice(), { headers: { 'content-length': String(body.length) }, ...init }); };
  return { calls, fetchImpl };
}

test('the synthetic stand-in trims like the upstream: mapped presets kept, the rest dropped, in any time zone', () => {
  const bank = core.SoundBankLoader.fromArrayBuffer(syntheticSubset.slice().buffer);
  assert.deepEqual(bank.presets.filter(p => !p.isGMGSDrum).map(p => p.program).sort((a, b) => a - b), [...DEFAULT_BANK_PROGRAMS]);
  const kit = bank.presets.find(p => p.isGMGSDrum);
  for (const note of DEFAULT_BANK_DRUM_NOTES) assert.ok(kit.getVoiceParameters(note, 100).length > 0, `drum note ${note} kept`);
  assert.equal(kit.getVoiceParameters(60, 100).length, 0, 'drum notes outside the mapping are trimmed');
  assert.ok(bank.samples.every(sample => sample.isCompressed));
  assert.equal(bank.soundBankInfo.creationDate.toISOString(), '2016-12-05T00:00:00.000Z');
  // The upstream INFO date is text read in the local time zone; the subset
  // must not depend on where it is made.
  const script = `import * as core from 'spessasynth_core';
    import { createHash } from 'node:crypto';
    import { syntheticUpstreamBank } from ${JSON.stringify(new URL('./support/synthetic-soundbank.mjs', import.meta.url).href)};
    import { trimDefaultBank } from ${JSON.stringify(new URL('../web/preview/default-bank-trim.mjs', import.meta.url).href)};
    process.stdout.write(createHash('sha256').update(trimDefaultBank(syntheticUpstreamBank(), core).bytes).digest('hex'));`;
  for (const TZ of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, TZ }, encoding: 'utf8' }), pins.subset.sha256, TZ);
  }
});

test('first use downloads the pinned upstream, verifies both digests and caches only the subset', async () => {
  const cache = memoryCache();
  const { calls, fetchImpl } = recordingFetch();
  const progress = [];
  const bank = await loadDefaultBank({ fetchImpl, trim: nodeTrim, cache, onProgress: event => progress.push(event), ...pins });
  assert.deepEqual(calls.map(call => call.url), [DEFAULT_BANK_UPSTREAM.url]);
  assert.deepEqual(calls[0].options, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  assert.equal(bank.isDefault, true);
  assert.equal(bank.downloaded, true);
  assert.equal(bank.label, DEFAULT_BANK_LABEL);
  assert.equal(bank.sha256, pins.subset.sha256);
  assert.deepEqual(new Uint8Array(bank.bytes), syntheticSubset);
  assert.deepEqual([...cache.records.keys()], [pins.subset.sha256], 'only the subset is kept, under its own digest');
  assert.equal(cache.records.get(pins.subset.sha256).upstream.sha256, pins.upstream.sha256);
  assert.deepEqual([...new Set(progress.map(event => event.phase))], ['download', 'trim', 'done']);
  assert.deepEqual(progress.filter(event => event.phase === 'download').at(-1), { phase: 'download', received: synthetic.length, total: synthetic.length });

  // A later session reads the cache and makes no request at all.
  const again = recordingFetch();
  const cached = await loadDefaultBank({ fetchImpl: again.fetchImpl, trim: () => assert.fail('no trim on a cache hit'), cache, ...pins });
  assert.equal(again.calls.length, 0);
  assert.equal(cached.downloaded, false);
  assert.deepEqual(new Uint8Array(cached.bytes), syntheticSubset);

  // A cached subset that no longer matches its digest is not used.
  const damaged = new Uint8Array(syntheticSubset); damaged[damaged.length - 1] ^= 1;
  cache.records.set(pins.subset.sha256, { ...cache.records.get(pins.subset.sha256), bytes: damaged.buffer });
  const third = recordingFetch();
  const redone = await loadDefaultBank({ fetchImpl: third.fetchImpl, trim: nodeTrim, cache, ...pins });
  assert.equal(third.calls.length, 1);
  assert.deepEqual(new Uint8Array(redone.bytes), syntheticSubset);
  assert.deepEqual(new Uint8Array(cache.records.get(pins.subset.sha256).bytes), syntheticSubset);
});

test('tampered downloads and non-reproducing subsets are refused and nothing is cached', async () => {
  const tampered = new Uint8Array(synthetic); tampered[tampered.length - 1] ^= 1;
  let cache = memoryCache();
  await assert.rejects(loadDefaultBank({ fetchImpl: recordingFetch(tampered).fetchImpl, trim: () => assert.fail('an unverified download is never trimmed'), cache, ...pins }), error => error.code === 'DEFAULT_BANK_UPSTREAM_MISMATCH' && /SHA-256 不符/.test(error.message));
  assert.equal(cache.records.size, 0);
  // The shipped pins are enforced when none are injected.
  await assert.rejects(loadDefaultBank({ fetchImpl: recordingFetch().fetchImpl, trim: nodeTrim, cache }), error => error.code === 'DEFAULT_BANK_UPSTREAM_MISMATCH');
  // A subset that does not reproduce the pinned digest is never used.
  await assert.rejects(loadDefaultBank({ fetchImpl: recordingFetch().fetchImpl, trim: nodeTrim, cache, ...pins, subset: { sha256: '0'.repeat(64), bytes: 1 } }), error => error.code === 'DEFAULT_BANK_SUBSET_MISMATCH');
  await assert.rejects(loadDefaultBank({ fetchImpl: recordingFetch().fetchImpl, trim: async upstream => { const out = new Uint8Array(await nodeTrim(upstream)); out[20] ^= 1; return out.buffer; }, cache, ...pins }), error => error.code === 'DEFAULT_BANK_SUBSET_MISMATCH');
  assert.equal(cache.records.size, 0);
  // A response longer than the pinned file is abandoned as soon as it says so.
  const longer = new Uint8Array(synthetic.length + 1);
  cache = memoryCache();
  await assert.rejects(loadDefaultBank({ fetchImpl: recordingFetch(longer).fetchImpl, trim: nodeTrim, cache, ...pins }), error => error.code === 'DEFAULT_BANK_UPSTREAM_MISMATCH');
  assert.equal(cache.records.size, 0);
});

test('an offline, blocked or failing download says so and points to the user\'s own bank', async () => {
  const cache = memoryCache();
  const failures = [
    [async () => { throw new TypeError('Failed to fetch'); }, nodeTrim, 'DEFAULT_BANK_DOWNLOAD_FAILED', /無法下載免費音色（可能離線或被阻擋：Failed to fetch）/],
    [recordingFetch(new Uint8Array(0), { status: 404 }).fetchImpl, nodeTrim, 'DEFAULT_BANK_DOWNLOAD_FAILED', /HTTP 404/],
    [async () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('network error')); } })), nodeTrim, 'DEFAULT_BANK_DOWNLOAD_FAILED', /下載中斷/],
    [recordingFetch().fetchImpl, async () => { throw Error('Worker 無法啟動'); }, 'DEFAULT_BANK_TRIM_FAILED', /無法在這個瀏覽器產生免費音色子集/],
  ];
  for (const [fetchImpl, trim, code, pattern] of failures) {
    await assert.rejects(loadDefaultBank({ fetchImpl, trim, cache, ...pins }), error => {
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      assert.match(error.message, /可改為選擇自己的音色庫（\.sf2／\.sf3／\.dls）後再播放。$/);
      return true;
    });
  }
  assert.equal(cache.records.size, 0);
  // A browser that cannot keep the verified subset still plays it this time.
  const bank = await loadDefaultBank({ fetchImpl: recordingFetch().fetchImpl, trim: nodeTrim, cache: { load: async () => { throw Error('blocked'); }, store: async () => { throw Error('quota'); } }, ...pins });
  assert.equal(bank.sha256, pins.subset.sha256);
  assert.equal(bank.stored, false);
});

test('per-role voices: a drum role sounds its kit note, and only one uniform program is a readback', async t => {
  const sent = [], drums = new Map();
  const context = { currentTime: 10, state: 'running', resume: async () => {} };
  const synth = {
    noteOn: (channel, pitch) => sent.push({ channel, pitch }), noteOff() {}, controllerChange() {}, programChange: (channel, program) => sent.push({ channel, program }), stopAll() {}, destroy() {}, voiceCount: 0,
    midiChannels: Array.from({ length: 16 }, (_, channel) => ({ setSystemParameter() {}, setDrums: value => drums.set(channel, value) })),
  };
  const engine = { context, synth, out: { gain: { cancelScheduledValues() {}, setValueAtTime() {} } }, presets: [{ program: 24, bankMSB: 0, name: 'Guitar' }], bank: { name: 'default', sha256: '0'.repeat(64) } };
  let tick = null;
  const saved = { si: globalThis.setInterval, ci: globalThis.clearInterval, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  Object.assign(globalThis, { setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { tick = null; }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
  t.after(() => Object.assign(globalThis, { setInterval: saved.si, clearInterval: saved.ci, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }));
  const ends = [];
  const transport = createTransport(engine, { onEnd: capture => ends.push(capture) });
  transport.load(parseListening('MML@t120o4c4,t120o4e4,,t120o4g4,,;').song);
  transport.setVoices(resolveRoleVoices(['lute', 'harp', 'lute', 'bass-drum', 'lute', 'lute']));
  await transport.play(0);
  context.currentTime += 5; tick?.();
  assert.deepEqual(sent.filter(e => e.program !== undefined).map(e => [e.channel, e.program]), [[0, 24], [1, 46], [2, 24], [3, 0], [4, 24], [5, 24]]);
  assert.equal(drums.get(3), true);
  assert.equal(drums.get(0), false);
  assert.deepEqual(sent.filter(e => e.pitch !== undefined).map(e => [e.channel, e.pitch]), [[0, 60], [1, 64], [3, 35]], 'the drum role plays its kit note');
  context.currentTime += 10; tick?.();
  assert.ok(ends[0].incomplete.includes('PER_ROLE_INSTRUMENTS'), 'per-role instruments cannot be a readback');
  sent.length = 0;
  transport.setVoices(resolveRoleVoices(Array(6).fill('lute')));
  context.currentTime += 10;
  await transport.play(0);
  context.currentTime += 5; tick?.(); context.currentTime += 10; tick?.();
  assert.deepEqual(ends[1].incomplete, []);
  assert.equal(ends[1].program.program, 24);
});

// The upstream bank is not stored in this repository. With it at hand
// (STUDIO_DEFAULT_BANK_SOURCE=/path/to/FluidR3Mono_GM.sf3), the subset must
// reproduce byte for byte from the pinned input, through the Node script and
// through the browser's own download path with the shipped pins.
const source = process.env.STUDIO_DEFAULT_BANK_SOURCE;
test('the subset reproduces byte for byte from the pinned upstream bank', { skip: source ? false : 'set STUDIO_DEFAULT_BANK_SOURCE to the pinned upstream FluidR3Mono_GM.sf3' }, async () => {
  const input = await readFile(source);
  assert.equal(sha256(input), provenance.upstream.sha256);
  assert.equal(input.length, provenance.upstream.bytes);
  const { trimDefaultBank: scriptTrim } = await import('../../scripts/build-default-soundbank.mjs');
  const first = scriptTrim(input), second = scriptTrim(input);
  assert.equal(sha256(first.bytes), provenance.output.sha256);
  assert.equal(first.bytes.length, provenance.output.bytes);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.presets, provenance.output.presets);
  assert.equal(first.samples, provenance.output.samples);
  const bank = core.SoundBankLoader.fromArrayBuffer(first.bytes.slice().buffer);
  assert.ok(bank.samples.every(sample => sample.isCompressed), 'the SF3 sample data was kept, not decoded');
  const kit = bank.presets.find(p => p.isGMGSDrum);
  for (const note of DEFAULT_BANK_DRUM_NOTES) assert.ok(kit.getVoiceParameters(note, 100).length > 0, `drum note ${note} sounds`);
  assert.equal(kit.getVoiceParameters(60, 100).length, 0, 'drum notes outside the mapping were trimmed');
  for (const program of DEFAULT_BANK_PROGRAMS) {
    const preset = bank.presets.find(p => !p.isGMGSDrum && p.program === program);
    for (const key of [36, 60, 84]) assert.ok(preset.getVoiceParameters(key, 100).length > 0, `program ${program} key ${key}`);
  }
  const cache = memoryCache();
  const downloaded = await loadDefaultBank({ fetchImpl: recordingFetch(new Uint8Array(input)).fetchImpl, trim: nodeTrim, cache });
  assert.equal(downloaded.sha256, DEFAULT_BANK_SUBSET.sha256);
  assert.deepEqual(new Uint8Array(downloaded.bytes), first.bytes);
});
