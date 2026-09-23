// A minimal SoundFont 2 reader for the listening widget.
//
// The owner may load a sound bank of their own from their own disk into the
// player. The file is read in the iframe's memory only: it is never uploaded,
// stored, cached or sent anywhere, and closing the player drops it. Nothing in
// this repository ships, names or fetches a bank.
//
// Inlined into the widget like mml-events.mjs (no imports, `export` stripped),
// so the parsing half runs in Node for tests. It reads what a preview needs --
// presets, key/velocity ranges, sample, root key, tuning, loop, attenuation,
// pan and the attack/release of the volume envelope -- and says plainly what it
// does not: DLS banks, SF3 (compressed) samples and modulators.

const GEN = Object.freeze({
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, endAddrsCoarseOffset: 12, pan: 17, attackVolEnv: 34, holdVolEnv: 35,
  decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38, instrument: 41, keyRange: 43, velRange: 44,
  startloopAddrsCoarseOffset: 45, initialAttenuation: 48, endloopAddrsCoarseOffset: 50, coarseTune: 51,
  fineTune: 52, sampleID: 53, sampleModes: 54, overridingRootKey: 58,
});
// Generators a preset zone adds to the instrument's value (SF2.04 §9.4).
const ADDITIVE = new Set([GEN.pan, GEN.attackVolEnv, GEN.releaseVolEnv, GEN.initialAttenuation, GEN.coarseTune, GEN.fineTune]);
const RANGE_GENERATORS = new Set([GEN.keyRange, GEN.velRange]);
export const SF2_MAX_BYTES = 512 * 1024 * 1024;

export class SoundFontError extends Error {}
const refuseBank = message => { throw new SoundFontError(message); };

/** Parse an ArrayBuffer holding an .sf2 file. Throws SoundFontError. */
export function parseSoundFont(buffer) {
  if (!(buffer instanceof ArrayBuffer)) refuseBank('需要檔案內容');
  if (buffer.byteLength > SF2_MAX_BYTES) refuseBank('音色庫超過 512 MB，無法在播放器中載入');
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const fourcc = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (buffer.byteLength < 12 || fourcc(0) !== 'RIFF') refuseBank('不是 RIFF 音色庫檔');
  const form = fourcc(8);
  if (form === 'DLS ') refuseBank('DLS 音色庫目前不支援；請先轉成 .sf2');
  if (form !== 'sfbk') refuseBank('不是 SoundFont 2（sfbk）檔');
  const riffEnd = Math.min(buffer.byteLength, 8 + view.getUint32(4, true));
  let smpl = null;
  const pdta = {};
  for (let at = 12; at + 8 <= riffEnd;) {
    const id = fourcc(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + size > buffer.byteLength) refuseBank('音色庫檔案被截斷');
    if (id === 'LIST' && size >= 4) {
      const type = fourcc(body);
      for (let sub = body + 4; sub + 8 <= body + size;) {
        const subId = fourcc(sub);
        const subSize = view.getUint32(sub + 4, true);
        const subBody = sub + 8;
        if (subBody + subSize > body + size) refuseBank('音色庫子區塊被截斷');
        if (type === 'sdta' && subId === 'smpl') smpl = { offset: subBody, size: subSize };
        if (type === 'pdta') pdta[subId] = { offset: subBody, size: subSize };
        sub = subBody + subSize + (subSize & 1);
      }
    }
    at = body + size + (size & 1);
  }
  if (!smpl) refuseBank('音色庫沒有取樣資料（smpl）');
  const records = (name, length) => {
    const chunk = pdta[name];
    if (!chunk || chunk.size % length || chunk.size < length) refuseBank(`音色庫 ${name} 區塊格式錯誤`);
    return { chunk, count: chunk.size / length };
  };
  const name20 = at => {
    let text = '';
    for (let i = 0; i < 20 && bytes[at + i]; i++) text += bytes[at + i] >= 32 && bytes[at + i] < 127 ? String.fromCharCode(bytes[at + i]) : '?';
    return text.trim();
  };
  const readBags = name => {
    const { chunk, count } = records(name, 4);
    return Array.from({ length: count }, (_, i) => view.getUint16(chunk.offset + i * 4, true));
  };
  const readGens = name => {
    const { chunk, count } = records(name, 4);
    return Array.from({ length: count }, (_, i) => {
      const at = chunk.offset + i * 4;
      return { oper: view.getUint16(at, true), amount: view.getInt16(at + 2, true), lo: bytes[at + 2], hi: bytes[at + 3] };
    });
  };
  const zonesOf = (bagStart, bagEnd, bags, gens, terminal) => {
    const zones = [];
    let global = null;
    for (let bag = bagStart; bag < bagEnd && bag + 1 < bags.length; bag++) {
      const map = new Map();
      for (let g = bags[bag]; g < bags[bag + 1] && g < gens.length; g++) {
        const gen = gens[g];
        map.set(gen.oper, RANGE_GENERATORS.has(gen.oper) ? [gen.lo, gen.hi] : gen.amount);
      }
      if (map.has(terminal)) zones.push(map);
      else if (bag === bagStart && !global) global = map;
    }
    return { zones, global };
  };

  const shdr = records('shdr', 46);
  const samples = [];
  for (let i = 0; i < shdr.count - 1; i++) {
    const at = shdr.chunk.offset + i * 46;
    samples.push({
      name: name20(at),
      start: view.getUint32(at + 20, true), end: view.getUint32(at + 24, true),
      startLoop: view.getUint32(at + 28, true), endLoop: view.getUint32(at + 32, true),
      sampleRate: view.getUint32(at + 36, true), originalPitch: bytes[at + 40], pitchCorrection: view.getInt8(at + 41),
      sampleType: view.getUint16(at + 44, true),
    });
  }
  const ibag = readBags('ibag');
  const igen = readGens('igen');
  const inst = records('inst', 22);
  const instruments = [];
  for (let i = 0; i < inst.count - 1; i++) {
    const at = inst.chunk.offset + i * 22;
    const next = inst.chunk.offset + (i + 1) * 22;
    instruments.push({ name: name20(at), ...zonesOf(view.getUint16(at + 20, true), view.getUint16(next + 20, true), ibag, igen, GEN.sampleID) });
  }
  const pbag = readBags('pbag');
  const pgen = readGens('pgen');
  const phdr = records('phdr', 38);
  const presets = [];
  for (let i = 0; i < phdr.count - 1; i++) {
    const at = phdr.chunk.offset + i * 38;
    const next = phdr.chunk.offset + (i + 1) * 38;
    presets.push({
      name: name20(at), program: view.getUint16(at + 20, true), bank: view.getUint16(at + 22, true),
      ...zonesOf(view.getUint16(at + 24, true), view.getUint16(next + 24, true), pbag, pgen, GEN.instrument),
    });
  }
  presets.sort((a, b) => a.bank - b.bank || a.program - b.program);
  if (!presets.length) refuseBank('音色庫沒有任何 preset');
  const compressed = samples.some(sample => sample.sampleType & 0x10);
  return { presets, instruments, samples, smpl, buffer, compressed };
}

const inRange = (range, value) => !range || (value >= range[0] && value <= range[1]);
const pick = (local, global, oper, fallback) => (local.has(oper) ? local.get(oper) : global && global.has(oper) ? global.get(oper) : fallback);

/**
 * The sample regions that sound for one key and velocity (0–127) of a preset:
 * sample index, root key, tuning, loop, gain, pan and envelope times. Pure.
 */
export function soundFontRegions(bank, presetIndex, key, velocity) {
  const preset = bank.presets[presetIndex];
  if (!preset) return [];
  const regions = [];
  for (const pzone of preset.zones) {
    if (!inRange(pick(pzone, preset.global, GEN.keyRange, null), key) || !inRange(pick(pzone, preset.global, GEN.velRange, null), velocity)) continue;
    const instrument = bank.instruments[pzone.get(GEN.instrument)];
    if (!instrument) continue;
    for (const izone of instrument.zones) {
      if (!inRange(pick(izone, instrument.global, GEN.keyRange, null), key) || !inRange(pick(izone, instrument.global, GEN.velRange, null), velocity)) continue;
      const sampleIndex = izone.get(GEN.sampleID);
      const sample = bank.samples[sampleIndex];
      if (!sample || sample.sampleType & 0x8000) continue;
      const value = (oper, fallback) => {
        const base = pick(izone, instrument.global, oper, fallback);
        return ADDITIVE.has(oper) ? base + pick(pzone, preset.global, oper, 0) : base;
      };
      const rootOverride = value(GEN.overridingRootKey, -1);
      const root = rootOverride >= 0 && rootOverride <= 127 ? rootOverride : (sample.originalPitch <= 127 ? sample.originalPitch : 60);
      const offset = (fine, coarse) => value(fine, 0) + value(coarse, 0) * 32768;
      const start = sample.start + offset(GEN.startAddrsOffset, GEN.startAddrsCoarseOffset);
      const end = sample.end + offset(GEN.endAddrsOffset, GEN.endAddrsCoarseOffset);
      const loopStart = sample.startLoop + offset(GEN.startloopAddrsOffset, GEN.startloopAddrsCoarseOffset);
      const loopEnd = sample.endLoop + offset(GEN.endloopAddrsOffset, GEN.endloopAddrsCoarseOffset);
      const timecents = (oper, fallback) => 2 ** (value(oper, fallback) / 1200);
      regions.push({
        sampleIndex,
        start, end, loopStart, loopEnd,
        sampleRate: sample.sampleRate,
        loop: (value(GEN.sampleModes, 0) & 1) === 1 && loopEnd > loopStart && loopStart >= start && loopEnd <= end,
        semitones: key - root + value(GEN.coarseTune, 0) + (value(GEN.fineTune, 0) + sample.pitchCorrection) / 100,
        gain: 10 ** (-Math.max(0, value(GEN.initialAttenuation, 0)) / 200),
        pan: Math.max(-1, Math.min(1, value(GEN.pan, 0) / 500)),
        attack: Math.min(2, timecents(GEN.attackVolEnv, -12000)),
        release: Math.max(0.02, Math.min(2, timecents(GEN.releaseVolEnv, -12000))),
      });
    }
  }
  return regions;
}

/** Mono float samples for one region's sample range, from the bank's 16-bit PCM. */
export function soundFontSampleData(bank, region) {
  const first = Math.max(0, region.start);
  const last = Math.min(bank.smpl.size / 2, region.end);
  const length = Math.max(0, last - first);
  const pcm = new DataView(bank.buffer, bank.smpl.offset + first * 2, length * 2);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = pcm.getInt16(i * 2, true) / 32768;
  return out;
}
