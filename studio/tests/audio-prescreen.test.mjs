// The audio prescreen (音色 A/B 預篩): renderer, metrics, decision rule, bank.
//
// Every test renders with a tiny synthetic bank generated in memory
// (support/synthetic-render-bank.mjs). None touches the network: downloads are
// exercised with an injected fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { ROLES } from '../../dist/core.js';
import { splitMML, parseTrack } from '../backend/mml/parser.mjs';
import { GAME_INSTRUMENTS, gmVoiceFor, soundingPitch, velocityForVolume } from '../backend/audio/instruments.mjs';
import { velocityFor } from '../web/preview/schedule.mjs';
import { GAME_INSTRUMENTS as WEB_INSTRUMENTS, voiceFor as webVoiceFor } from '../web/preview/instruments.mjs';
import { AUDIO_BANK_ERROR, FREE_GM_BANK, SoundBankError, bankCacheDirectory, createSoundBankProvider } from '../backend/audio/prescreen/sound-bank.mjs';
import { createRenderPool } from '../backend/audio/prescreen/render-pool.mjs';
import { barsFor, meterFromText, performanceFromTracks, referenceFromPerformance } from '../backend/audio/prescreen/performance.mjs';
import { clippingByBar, modelNotes, similarityValue } from '../backend/audio/prescreen/metrics.mjs';
import { alternativeNotes, fidelityByBar } from '../backend/audio/prescreen/fidelity.mjs';
import { DEFAULT_THRESHOLDS, REASON, VERDICT, contenders, decideBar, normalizeThresholds } from '../backend/audio/prescreen/decision.mjs';
import { decodeWav, encodeWav16 } from '../backend/audio/prescreen/wav.mjs';
import { runPrescreen } from '../backend/audio/prescreen/prescreen.mjs';
import { voiceKey } from '../backend/audio/prescreen/renderer-core-constants.mjs';
import { syntheticSoundBank } from './support/synthetic-render-bank.mjs';
import { syntheticSongMml, SYNTHETIC_METER } from './support/prescreen-fixtures.mjs';

const OWNER = 'owner:prescreen';
const { bytes: BANK_BYTES, descriptor: BANK } = syntheticSoundBank();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const perf = (mml, instruments = null) => performanceFromTracks(splitMML(mml).map((track, index) => parseTrack(track, ROLES[index], { mode: 'ingest' })), { instruments });
const SIX = id => Array(6).fill(id);

// One pool and one calibration cache for the direct engine tests.
const pool = createRenderPool({ size: 2, idleMs: 2000 });
const profileCache = new Map();
const provider = createSoundBankProvider({ bank: BANK, bytes: BANK_BYTES });
test.after(() => pool.close());

async function screen(mmls, { instruments = SIX('piano'), reference = null, meter = '0 4/4', thresholds = null, returnPcm = false, render } = {}) {
  return runPrescreen({
    alternatives: mmls.map((mml, index) => ({ label: 'ABCD'[index], source: { kind: 'mml' }, mml_sha256: sha256(mml), performance: perf(mml, Array.isArray(instruments[0]) ? instruments[index] : instruments) })),
    reference: reference ? { kind: 'mml', id: null, sha256: sha256(reference), notes: referenceFromPerformance(perf(reference)).notes } : null,
    meter: meterFromText(meter),
    thresholds: normalizeThresholds(thresholds),
    bankProvider: provider,
    pool,
    profileCache,
    returnPcm,
    ...(render ? { render } : {}),
  });
}

// ─── the shared instrument table ────────────────────────────────────────────

test('AP-1 the game-instrument table maps the eleven instruments to their GM stand-ins', () => {
  const byId = Object.fromEntries(GAME_INSTRUMENTS.map(item => [item.id, item]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).filter(([, item]) => !item.drumNotes).map(([id, item]) => [id, item.program])), {
    lute: 24, mandolin: 25, chalumeau: 71, xylophone: 13, flute: 73, violin: 40, piano: 0, harp: 46, 'music-box': 10,
  });
  assert.deepEqual(byId['bass-drum'].drumNotes, [35, 36]);
  assert.deepEqual(byId.cymbals.drumNotes, [49, 57]);
  assert.equal(gmVoiceFor('cymbals').drumNote, 49);
  assert.throws(() => gmVoiceFor('kazoo'), /unknown game instrument/);
  // The volume curve is the Studio Web preview's, V0-V15 alike.
  for (let volume = 0; volume <= 15; volume++) assert.equal(velocityForVolume(volume), velocityFor(volume));
  // And the table is the preview picker's, field for field, voice for voice.
  const plain = list => list.map(({ id, name, label, program, drumNotes }) => ({ id, name, label, program, drumNotes: drumNotes ? [...drumNotes] : null }));
  assert.deepEqual(plain(GAME_INSTRUMENTS), plain(WEB_INSTRUMENTS));
  for (const { id } of GAME_INSTRUMENTS) {
    const web = webVoiceFor(id);
    const backend = gmVoiceFor(id);
    assert.deepEqual([backend.program, backend.drumNote, backend.drumNotes, backend.label], [web.program, web.drumNote, web.drumNotes, web.label], id);
  }
});

// ─── the sound bank ─────────────────────────────────────────────────────────

test('AP-2 the free bank is pinned by URL, SHA-256 and size and cached under the data directory, never the repository', () => {
  assert.equal(FREE_GM_BANK.url, 'https://raw.githubusercontent.com/musescore/MuseScore/v2.3.2/share/sound/FluidR3Mono_GM.sf3');
  assert.equal(FREE_GM_BANK.sha256, 'cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2');
  assert.equal(FREE_GM_BANK.bytes, 14563174);
  assert.equal(bankCacheDirectory({ dataDirectory: '/srv/studio' }), '/srv/studio/audio-banks');
  assert.equal(bankCacheDirectory({ env: { MML_STUDIO_DATA_DIR: '/x' } }), '/x/audio-banks');
  assert.equal(bankCacheDirectory({ env: {} }), '/data/audio-banks');
});

test('AP-3 a bank whose bytes are not the pinned bytes is refused and never cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  try {
    // Injected bytes that do not match the descriptor.
    await assert.rejects(createSoundBankProvider({ bank: { ...BANK, sha256: 'f'.repeat(64) }, bytes: BANK_BYTES }).load(),
      error => error instanceof SoundBankError && error.code === AUDIO_BANK_ERROR.HASH_MISMATCH && error.details.reason === 'SHA256_MISMATCH');
    // A download of the right size but different bytes.
    let calls = 0;
    const tampered = Uint8Array.from(BANK_BYTES);
    tampered[100] ^= 0xff;
    const bad = createSoundBankProvider({ bank: { ...BANK, url: 'https://bank.invalid/x.sf2' }, cacheDirectory: dir, fetchImpl: async () => { calls++; return new Response(tampered); } });
    await assert.rejects(bad.load(), error => error.code === AUDIO_BANK_ERROR.HASH_MISMATCH);
    assert.equal(existsSync(join(dir, `${BANK.sha256}.sf2`)), false, 'a refused download is never cached');
    // A failed load is retried on the next call, not remembered.
    await assert.rejects(bad.load(), error => error.code === AUDIO_BANK_ERROR.HASH_MISMATCH);
    assert.equal(calls, 2);
    // A truncated download is a size mismatch.
    const short = createSoundBankProvider({ bank: { ...BANK, url: 'https://bank.invalid/x.sf2' }, fetchImpl: async () => new Response(BANK_BYTES.subarray(0, 100)) });
    await assert.rejects(short.load(), error => error.details.reason === 'SIZE_MISMATCH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-4 a verified download is cached, re-verified on read, and a corrupt cache is fetched again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  try {
    let calls = 0;
    const fetchImpl = async url => { calls++; assert.equal(url, 'https://bank.invalid/x.sf2'); return new Response(BANK_BYTES); };
    const bank = { ...BANK, url: 'https://bank.invalid/x.sf2' };
    const first = await createSoundBankProvider({ bank, cacheDirectory: dir, fetchImpl }).load();
    assert.equal(first.identity.cache, 'disk');
    assert.equal(first.identity.sha256, BANK.sha256);
    const second = await createSoundBankProvider({ bank, cacheDirectory: dir, fetchImpl }).load();
    assert.equal(calls, 1, 'the cached bank is read, not downloaded again');
    assert.deepEqual(second.bytes, first.bytes);
    const path = join(dir, `${BANK.sha256}.sf2`);
    const corrupt = readFileSync(path);
    corrupt[200] ^= 0xff;
    writeFileSync(path, corrupt);
    await createSoundBankProvider({ bank, cacheDirectory: dir, fetchImpl }).load();
    assert.equal(calls, 2, 'a cache that does not verify is replaced from the pinned URL');
    // Downloading turned off with nothing cached is a clear refusal.
    await assert.rejects(createSoundBankProvider({ bank, cacheDirectory: join(dir, 'empty'), allowDownload: false }).load(),
      error => error.code === AUDIO_BANK_ERROR.UNAVAILABLE && error.details.reason === 'DOWNLOAD_DISABLED');
    await assert.rejects(createSoundBankProvider({ bank, fetchImpl: async () => { throw Error('offline'); } }).load(),
      error => error.code === AUDIO_BANK_ERROR.UNAVAILABLE && error.details.reason === 'DOWNLOAD_FAILED');
    await assert.rejects(createSoundBankProvider({ bank, fetchImpl: async () => new Response('no', { status: 404 }) }).load(),
      error => error.code === AUDIO_BANK_ERROR.UNAVAILABLE && error.details.status === 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-5 a cache directory inside the repository is never written', async () => {
  const inside = fileURLToPath(new URL('../../studio/.prescreen-bank-probe', import.meta.url));
  try {
    const loaded = await createSoundBankProvider({ bank: { ...BANK, url: 'https://bank.invalid/x.sf2' }, cacheDirectory: inside, fetchImpl: async () => new Response(BANK_BYTES) }).load();
    assert.equal(loaded.identity.cache, 'memory-only');
    assert.equal(existsSync(inside), false);
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});

// ─── the renderer ───────────────────────────────────────────────────────────

test('AP-6 rendering is deterministic: the same MML gives the same PCM, bit for bit', async () => {
  const mml = syntheticSongMml({ bars: 4 });
  const other = syntheticSongMml({ bars: 4, variant: 'crunch' });
  const first = await screen([mml, other], { returnPcm: true, reference: mml });
  const separatePool = createRenderPool({ size: 1, idleMs: 1000 });
  try {
    const again = await runPrescreen({
      alternatives: [mml, other].map((text, index) => ({ label: 'AB'[index], source: { kind: 'mml' }, mml_sha256: sha256(text), performance: perf(text, SIX('piano')) })),
      reference: { kind: 'mml', id: null, sha256: sha256(mml), notes: referenceFromPerformance(perf(mml)).notes },
      meter: meterFromText('0 4/4'), thresholds: normalizeThresholds(), bankProvider: provider, pool: separatePool, profileCache: new Map(), returnPcm: true,
    });
    assert.equal(again.report.report_id, first.report.report_id, 'a fresh worker, a fresh calibration, the same report');
    assert.deepEqual(again.pcm.A, first.pcm.A);
    assert.deepEqual(again.pcm.B, first.pcm.B);
  } finally {
    await separatePool.close();
  }
  const [a, b] = first.report.alternatives;
  assert.match(a.render.pcm_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(a.render.pcm_sha256, b.render.pcm_sha256, 'different notes, different PCM');
  assert.equal(a.mml_sha256, sha256(mml));
  assert.equal(first.pcm.A.length, a.render.frames, 'mono: one sample per frame');
  assert.equal(first.pcm.A.some(value => value !== 0), true, 'the synthetic bank sounds');
  const stereo = await screen([mml, other], { render: { sampleRate: 22050, channels: 2 }, returnPcm: true, reference: mml });
  assert.equal(stereo.pcm.A.length, stereo.report.alternatives[0].render.frames * 2);
  assert.notEqual(stereo.report.report_id, first.report.report_id, 'the render settings are part of the report identity');
  assert.equal(first.report.bank.sha256, BANK.sha256);
  assert.equal(first.report.renderer.effects, false);
});

// ─── the metrics ────────────────────────────────────────────────────────────

test('AP-7 a low minor-second cluster is rougher than a fifth, and the pair is named', async () => {
  const { report } = await screen(['MML@t120o3v12c1,t120o3v12c+1,,,,;', 'MML@t120o3v12c1,t120o3v12g1,,,,;']);
  const bar = report.bars[0];
  assert.ok(bar.metrics.roughness.A > 2 * bar.metrics.roughness.B, JSON.stringify(bar.metrics.roughness));
  const top = bar.evidence.A.roughness.attribution[0];
  assert.deepEqual(top.notes, ['Melody:C3@0', 'Chord1:C#3@0']);
  assert.equal(top.interval, 'm2');
  assert.equal(top.source_inherited, false);
  // The same cluster an octave higher is smoother (register matters).
  const { report: high } = await screen(['MML@t120o3v12c1,t120o3v12c+1,,,,;', 'MML@t120o5v12c1,t120o5v12c+1,,,,;']);
  assert.ok(high.bars[0].metrics.roughness.B < high.bars[0].metrics.roughness.A);
});

test('AP-8 dissonance the source already has is reported but not counted', async () => {
  const cluster = 'MML@t120o3v12c1,t120o3v12c+1,,,,;';
  const { report } = await screen([cluster, 'MML@t120o3v12c1,t120o3v12g1,,,,;'], { reference: cluster });
  const bar = report.bars[0];
  assert.ok(bar.evidence.A.roughness.low_mid > 0);
  assert.ok(bar.evidence.A.roughness.inherited_low_mid >= 0.99 * bar.evidence.A.roughness.low_mid);
  assert.ok(bar.metrics.roughness.A < 0.01 * bar.evidence.A.roughness.low_mid, 'the decision value excludes the inherited pair');
  assert.equal(bar.evidence.A.roughness.attribution[0].source_inherited, true);
  // B changed the source, so its fifth is its own roughness, and it is further from the source.
  assert.ok(bar.metrics.roughness.B > bar.metrics.roughness.A);
  assert.equal(bar.fidelity.B.pitch_changed, 1);
  assert.equal(bar.verdict, VERDICT.OBVIOUS);
  assert.equal(bar.winner, 'A');
});

test('AP-9 a role drowned in its band by louder roles is reported masked', async () => {
  // Chord1 plays softly in the same register as four loud roles; in the other
  // alternative it is loud and the others are an octave apart.
  const masked = 'MML@t120o4v15ceg>c<,t120o4v1dfa>d<,t120o4v15egb>e<,t120o4v15cegc,t120o4v15egbe,;';
  const clear = 'MML@t120o5v15ceg>c<,t120o3v15dfa>d<,t120o6v6egb>e<,t120o6v6cegc,t120o6v6egbe,;';
  const { report } = await screen([masked, clear], { meter: '0 4/4' });
  const bar = report.bars[0];
  assert.ok(bar.evidence.A.audibility.Chord1 < 0.2, JSON.stringify(bar.evidence.A.audibility));
  assert.ok(bar.evidence.B.audibility.Chord1 > 0.5, JSON.stringify(bar.evidence.B.audibility));
  assert.ok(bar.metrics.masking.A > bar.metrics.masking.B);
});

test('AP-10 long release tails that ring into the next attack smear it; short ones do not', async () => {
  const run = 'MML@t120o4v12l16cdefgab>cdc<bagfed,,,,,;';
  const { report } = await screen([run, run], { instruments: [SIX('harp'), SIX('violin')] });
  const bar = report.bars[0];
  assert.ok(bar.metrics.smear.A > 3 * bar.metrics.smear.B, JSON.stringify(bar.metrics.smear));
  assert.match(bar.evidence.A.smear.worst.attack, /^Melody:/);
  // Same notes, different instruments: source fidelity cannot differ, so the
  // sound metrics decide, and the long-ringing harp loses.
  assert.equal(bar.verdict, VERDICT.OBVIOUS);
  assert.equal(bar.winner, 'B');
  assert.ok(bar.decisive.smear);
});

test('AP-11 clipped duration and peak level come from the rendered mix', () => {
  const performance = { tempo: [{ beat: '0', bpm: 120 }], roles: [] };
  const bars = [{ bar: 1, startExact: '0', endExact: '4' }, { bar: 2, startExact: '4', endExact: '8' }];
  const analysis = { sampleRate: 1000, hop: 500, chunkPeak: new Float32Array([0.5, 0.25, 1, 1, 0, 0, 0, 0]), chunkClipped: new Uint32Array([0, 0, 40, 10, 0, 0, 0, 0]) };
  const [first, second] = clippingByBar(performance, analysis, bars);
  assert.equal(first.value, 50, '50 clipped samples at 1 kHz = 50 ms');
  assert.equal(first.peak_dbfs, 0);
  assert.equal(second.value, 0);
  assert.equal(second.peak_dbfs, null);
});

test('AP-12 source fidelity counts each kind of change against the reference', () => {
  const bars = barsFor('8', meterFromText('0 4/4'));
  const reference = referenceFromPerformance(perf('MML@t120o4c4d4e4f4g4a4b4>c4,t120o3c1c1,,,,;')).notes;
  const changed = alternativeNotes(perf('MML@t120o4c4d+4e4f4r8g8a4b4>c4,t120o3c1,t120o3r1c1,,,;'));
  const [one, two] = fidelityByBar(changed, reference, bars);
  assert.equal(one.counts.pitch_changed, 1, 'D → D#');
  assert.equal(one.distance, 1);
  assert.equal(two.counts.onset_changed, 1, 'G moved by an eighth');
  assert.equal(two.counts.duration_changed, 1, 'and shortened');
  assert.equal(two.counts.role_moved, 1, 'the second bass note moved to Chord2');
  assert.equal(two.distance, 3);
  const dropped = fidelityByBar(alternativeNotes(perf('MML@t120o4c4d4e4f4g4a4b4,t120o3c1c1,t120o3c1,,,;')), reference, bars);
  assert.deepEqual([dropped[0].counts.added, dropped[1].counts.omitted], [1, 1]);
  assert.equal(fidelityByBar(alternativeNotes(perf('MML@t120o4c4d4e4f4g4a4b4>c4,t120o3c1c1,,,,;')), reference, bars).every(bar => bar.distance === 0), true);
});

test('AP-13 WAVE PCM decodes to mono; anything else is reported unsupported', () => {
  const samples = Float32Array.from({ length: 2205 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 22050));
  const decoded = decodeWav(encodeWav16(samples, 22050));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.sampleRate, 22050);
  assert.ok(Math.abs(decoded.mono[100] - samples[100]) < 1e-4);
  assert.deepEqual(decodeWav(new TextEncoder().encode(`ID3${'x'.repeat(100)}`)), { ok: false, reason: 'UNSUPPORTED_AUDIO_ENCODING' });
  assert.equal(similarityValue(null, { frames: 4 }), null);
});

// ─── the decision rule ──────────────────────────────────────────────────────

const T = normalizeThresholds();
const metric = values => ({ available: true, values });
const LABELS = ['A', 'B'];
const faithful = { available: true, values: { A: 0, B: 0 } };

test('AP-14 agreeing, clear margins are OBVIOUS; conflicting metrics are NEEDS_HUMAN', () => {
  const obvious = decideBar({ labels: LABELS, thresholds: T, fidelity: faithful, metrics: {
    roughness: metric({ A: 0.002, B: 0.03 }), masking: metric({ A: 0, B: 0.9 }), smear: metric({ A: 0.2, B: 0.21 }), clipping: metric({ A: 0, B: 0 }),
  } });
  assert.equal(obvious.verdict, VERDICT.OBVIOUS);
  assert.equal(obvious.winner, 'A');
  assert.equal(obvious.category, 'masking+roughness');

  const conflict = decideBar({ labels: LABELS, thresholds: T, fidelity: faithful, metrics: {
    roughness: metric({ A: 0.002, B: 0.03 }), masking: metric({ A: 1.2, B: 0 }), smear: metric({ A: 0.2, B: 0.2 }), clipping: metric({ A: 0, B: 0 }),
  } });
  assert.equal(conflict.verdict, VERDICT.NEEDS_HUMAN);
  assert.deepEqual(conflict.reasons, [REASON.METRICS_CONFLICT]);
  assert.equal(conflict.winner, null);

  // One decisive metric, but the winner is clearly worse on another that is
  // not decisive on its own: still a conflict.
  const worse = decideBar({ labels: ['A', 'B', 'C'], thresholds: T, fidelity: { available: true, values: { A: 0, B: 0, C: 0 } }, metrics: {
    roughness: metric({ A: 0.001, B: 0.03, C: 0.031 }), smear: metric({ A: 0.5, B: 0.3, C: 0.36 }),
  } });
  assert.equal(worse.verdict, VERDICT.NEEDS_HUMAN);
  assert.deepEqual(worse.reasons, [REASON.METRICS_CONFLICT]);
});

test('AP-15 a small margin, a missing metric or a fidelity trade-off each go to the owner with the reason', () => {
  const small = decideBar({ labels: ['A', 'B', 'C'], thresholds: T, fidelity: { available: true, values: { A: 0, B: 0, C: 0 } }, metrics: { roughness: metric({ A: 0.010, B: 0.011, C: 0.05 }) } });
  assert.deepEqual(small.reasons, [REASON.MARGIN_TOO_SMALL]);
  assert.deepEqual(contenders({ labels: ['A', 'B', 'C'], thresholds: T, fidelity: { available: true, values: { A: 0, B: 0, C: 0 } }, metrics: { roughness: metric({ A: 0.010, B: 0.011, C: 0.05 }) } }), ['A', 'B'], 'the clearly worse one is not offered');

  const missing = decideBar({ labels: LABELS, thresholds: T, fidelity: faithful, metrics: {
    roughness: metric({ A: 0.002, B: 0.03 }), original_similarity: { available: false, reason: 'UNSUPPORTED_AUDIO_ENCODING' },
  } });
  assert.equal(missing.verdict, VERDICT.NEEDS_HUMAN);
  assert.deepEqual(missing.reasons, [REASON.METRIC_UNAVAILABLE]);
  assert.equal(missing.detail[0].why, 'UNSUPPORTED_AUDIO_ENCODING');

  const tradeoff = decideBar({ labels: LABELS, thresholds: T, fidelity: { available: true, values: { A: 5, B: 0 } }, metrics: { roughness: metric({ A: 0.002, B: 0.03 }) } });
  assert.deepEqual(tradeoff.reasons, [REASON.SOURCE_FIDELITY_TRADEOFF], 'the smoother version omits source material: never obvious on sound alone');
  assert.equal(tradeoff.machine_leader, 'A');

  const blind = decideBar({ labels: LABELS, thresholds: T, fidelity: { available: false, reason: 'NO_REFERENCE' }, metrics: { roughness: metric({ A: 0.002, B: 0.03 }) } });
  assert.deepEqual(blind.reasons, [REASON.SOURCE_FIDELITY_UNAVAILABLE]);
  const sameNotes = decideBar({ labels: LABELS, thresholds: T, symbolicSame: true, fidelity: { available: false }, metrics: { roughness: metric({ A: 0.002, B: 0.03 }) } });
  assert.equal(sameNotes.verdict, VERDICT.OBVIOUS, 'same notes, different instruments: fidelity cannot differ');

  const none = decideBar({ labels: LABELS, thresholds: T, fidelity: faithful, metrics: { roughness: metric({ A: 0.002, B: 0.0021 }) } });
  assert.deepEqual(none.reasons, [REASON.NO_MACHINE_PREFERENCE]);
  assert.equal(decideBar({ labels: LABELS, thresholds: T, identical: true, metrics: {} }).verdict, VERDICT.NO_DIFFERENCE);
});

test('AP-16 thresholds are explicit, closed and content-addressed; a change changes the report id', async () => {
  assert.deepEqual(T.values, DEFAULT_THRESHOLDS);
  assert.match(T.id, /^apt:[0-9a-f]{64}$/);
  assert.equal(normalizeThresholds().id, T.id);
  const tighter = normalizeThresholds({ roughness: { margin_abs: 0.01 } });
  assert.notEqual(tighter.id, T.id);
  assert.equal(tighter.values.roughness.margin_rel, DEFAULT_THRESHOLDS.roughness.margin_rel);
  assert.throws(() => normalizeThresholds({ loudness: {} }), /unknown threshold metric/);
  assert.throws(() => normalizeThresholds({ roughness: { margin: 1 } }), /unknown threshold field/);
  assert.throws(() => normalizeThresholds({ roughness: { margin_abs: -1 } }), /non-negative/);
  const mmls = ['MML@t120o3v12c1,t120o3v12c+1,,,,;', 'MML@t120o3v12c1,t120o3v12g1,,,,;'];
  const a = await screen(mmls);
  const b = await screen(mmls, { thresholds: { roughness: { margin_abs: 0.01 } } });
  assert.notEqual(a.report.report_id, b.report.report_id);
  assert.equal(b.report.thresholds.id, tighter.id);
});

test('AP-17 a synthetic song: a machine-obvious defect is decided, a thinner arrangement goes to the owner', async () => {
  const base = syntheticSongMml({ bars: 8 });
  const crunch = syntheticSongMml({ bars: 8, variant: 'crunch' });
  const thin = syntheticSongMml({ bars: 8, variant: 'thin' });
  const instruments = ['flute', 'piano', 'piano', 'harp', 'violin', 'lute'];
  const clean = (await screen([base, crunch], { instruments, reference: base })).report;
  assert.deepEqual(clean.regions.map(region => [region.region_id, region.verdict, region.winner]), [
    ['bars-1-1', 'NO_DIFFERENCE', null], ['bars-2-2', 'OBVIOUS', 'A'], ['bars-3-3', 'NO_DIFFERENCE', null], ['bars-4-4', 'OBVIOUS', 'A'],
    ['bars-5-5', 'NO_DIFFERENCE', null], ['bars-6-6', 'OBVIOUS', 'A'], ['bars-7-7', 'NO_DIFFERENCE', null], ['bars-8-8', 'OBVIOUS', 'A'],
  ]);
  assert.equal(clean.regions[1].category, 'roughness');
  assert.deepEqual(clean.human_review, []);
  // The thinner arrangement drops source events. Wherever it sounds better it
  // is still never the obvious winner: every bar goes to the owner, and the
  // bars it leads on sound say why.
  const thinner = (await screen([base, thin], { instruments, reference: base })).report;
  assert.ok(thinner.bars.every(bar => bar.verdict === VERDICT.NEEDS_HUMAN), JSON.stringify(thinner.summary));
  const led = thinner.bars.filter(bar => bar.machine_leader === 'B');
  assert.ok(led.length > 0);
  assert.ok(led.every(bar => bar.reasons.includes(REASON.SOURCE_FIDELITY_TRADEOFF)));
  assert.ok(thinner.bars.every(bar => bar.fidelity.B.omitted > 0 && bar.fidelity.A.distance === 0));
  assert.deepEqual([thinner.human_review[0].bars[0], thinner.human_review.at(-1).bars[1]], [1, 8]);
  assert.ok(thinner.human_review.every(item => item.alternatives.join() === 'A,B' && item.listen_link === null), 'the listen-link hook is present and empty');
  assert.equal(thinner.authority.auto_apply.active, false);
  assert.equal(thinner.authority.gate_effects, 'NONE');
});

test('AP-18 a bar range renders only what it needs and numbers bars as the meter map does', async () => {
  const base = syntheticSongMml({ bars: 8 });
  const crunch = syntheticSongMml({ bars: 8, variant: 'crunch' });
  const { report } = await runPrescreen({
    alternatives: [base, crunch].map((text, index) => ({ label: 'AB'[index], source: { kind: 'mml' }, mml_sha256: sha256(text), performance: perf(text, SIX('piano')) })),
    reference: { kind: 'mml', id: null, sha256: sha256(base), notes: referenceFromPerformance(perf(base)).notes },
    meter: meterFromText(SYNTHETIC_METER), barRange: { from: 3, to: 4 }, thresholds: T, bankProvider: provider, pool, profileCache,
  });
  assert.deepEqual(report.bars.map(bar => bar.bar), [3, 4]);
  assert.deepEqual(report.inputs.bar_range, { from: 3, to: 4 });
  assert.equal(report.bars[1].verdict, VERDICT.OBVIOUS);
  assert.ok(report.alternatives[0].render.start_seconds > 0, 'the render starts at the pre-roll before bar 3');
});

test('AP-19 the render pool keeps no thread alive once idle', async () => {
  const small = createRenderPool({ size: 1, idleMs: 50 });
  const loaded = await provider.load();
  const profiles = await small.run('calibrate', { sampleRate: 22050, voices: [gmVoiceFor('piano')] }, { bank: { sha256: loaded.identity.sha256, bytes: loaded.bytes } });
  assert.ok(profiles.profiles[voiceKey(gmVoiceFor('piano'))]);
  await new Promise(resolve => setTimeout(resolve, 200));
  await small.close();
});

test('AP-22 a drum role sounds its two kit notes, split at o4c, in the render model and its calibration', async () => {
  const drum = gmVoiceFor('bass-drum');
  assert.deepEqual([drum.drumNote, [...drum.drumNotes]], [35, [35, 36]]);
  assert.deepEqual([soundingPitch(drum, 59), soundingPitch(drum, 60), soundingPitch(gmVoiceFor('cymbals'), 72), soundingPitch(gmVoiceFor('piano'), 72)], [35, 36, 57, 72]);
  assert.equal(voiceKey(drum), 'd35+36');
  assert.equal(voiceKey({ program: 0, drumNote: 35 }), 'd35+35', 'a voice naming one drum note sounds it for every pitch');
  const loaded = await provider.load();
  const { profiles } = await pool.run('calibrate', { sampleRate: 22050, voices: [drum] }, { bank: { sha256: loaded.identity.sha256, bytes: loaded.bytes } });
  const profile = profiles['d35+36'];
  assert.equal(profile.drum, true);
  assert.deepEqual(profile.anchors.map(anchor => anchor.pitch), [35, 36], 'each kit note is measured');
  // The model reads the anchor of the kit note each written pitch strikes.
  const tagged = { 'd35+36': { ...profile, anchors: profile.anchors.map(anchor => ({ ...anchor, level: anchor.pitch })) } };
  const note = (pitch, start) => ({ pitch, start, on: start, off: start + 0.5, volume: 15 });
  const modelled = modelNotes({ roles: [{ index: 0, ...drum, notes: [note(48, 0), note(72, 1)] }] }, tagged);
  assert.deepEqual(modelled.map(item => Math.round(item.amplitude)), [35, 36]);
});

test('AP-21 a job that outlives the pool\'s time limit fails, its worker is stopped, and the queue goes on with a fresh one', async () => {
  const limited = createRenderPool({ size: 1, idleMs: 1000, jobTimeoutMs: 3000 });
  try {
    const loaded = await provider.load();
    const bank = { sha256: loaded.identity.sha256, bytes: loaded.bytes };
    // Six roles of 400 whole notes at T32: 3,000 s, far more than three
    // seconds of rendering and analysis on any machine.
    const role = `t32o4l1${'c'.repeat(400)}`;
    const long = perf(`MML@${Array(6).fill(role).join(',')};`, SIX('piano'));
    const analyze = { performance: long, profiles: {}, bars: [], reference: null, sampleRate: 22050, channels: 1, window: null, returnPcm: false };
    const started = performance.now();
    const stuck = limited.run('analyze', analyze, { bank });
    // Queued behind it on the pool's only worker.
    const next = limited.run('original', { mono: new Float32Array(16), sampleRate: 22050, spans: [] });
    await assert.rejects(stuck, error => error.code === 'AUDIO_RENDER_FAILED' && /exceeded 3000 ms; its worker was stopped/.test(error.message));
    assert.ok(performance.now() - started < 20000, 'it failed at the limit, not when the render would have ended');
    assert.deepEqual(await next, [], 'the queued job ran on a fresh worker');
    // Closing the pool settles a job still running instead of leaving it pending.
    const running = assert.rejects(limited.run('analyze', analyze, { bank }), /render pool closed/);
    await new Promise(resolve => setTimeout(resolve, 100));
    await limited.close();
    await running;
  } finally {
    await limited.close();
  }
  assert.throws(() => createRenderPool({ jobTimeoutMs: Infinity }), RangeError, 'a timer cannot wait forever; it would fire at once');
});

test('AP-20 no sound bank is stored in the repository, and the browser bundle excludes the server prescreen', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const banks = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'web-build', 'browser-results'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(sf2|sf3|sfogg|dls)$/i.test(entry.name)) banks.push(path);
    }
  };
  walk(root);
  assert.deepEqual(banks, []);
  const build = readFileSync(join(root, 'scripts/build-studio-web.mjs'), 'utf8');
  assert.match(build, /'studio\/backend\/audio\/prescreen'/);
});
