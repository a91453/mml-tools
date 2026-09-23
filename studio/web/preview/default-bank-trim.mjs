// The free default bank's subset: the one deterministic trim of the pinned
// upstream FluidR3Mono_GM.sf3 down to the presets the preview's instrument
// mapping uses (instruments.mjs). Pure: no DOM, no network, no storage.
//
// The same function runs in two places, so the subset a browser derives is the
// one scripts/build-default-soundbank.mjs reproduces and provenance.json pins:
//   * the Studio Web's Worker (default-bank-worker.mjs), with the vendored
//     spessasynth_core the build already ships (vendor/spessasynth/core.js);
//   * Node, with the npm spessasynth_core the build vendors that copy from.
// It uses spessasynth_core's own sound-bank tooling (SoundBankLoader,
// BasicSoundBank.trim, writeSF2); the SF3 (Ogg Vorbis) sample data is copied
// as-is, never decoded or re-encoded.
import { DEFAULT_BANK_DRUM_NOTES, DEFAULT_BANK_PROGRAMS } from './instruments.mjs';

export const DEFAULT_BANK_SOFTWARE = 'MML Studio default-bank subset (spessasynth_core)';
// The upstream INFO date reads "5th December 2016". spessasynth_core parses it
// in the machine's local time zone and writes it back as UTC, so the same
// input gave a different subset at UTC+8 than at UTC. The subset records that
// day at 00:00 UTC wherever it is made.
export const DEFAULT_BANK_CREATION_DATE = '2016-12-05T00:00:00Z';

/**
 * @param {Uint8Array|ArrayBuffer} input the upstream bank (its SHA-256 is the caller's to check)
 * @param {{ SoundBankLoader }} core spessasynth_core, npm or vendored
 * @returns {{ bytes: Uint8Array, presets: {program, drums, name}[], samples: number }}
 */
export function trimDefaultBank(input, { SoundBankLoader }) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const everyVelocity = new Set(Array.from({ length: 128 }, (_, v) => v));
  const everyKey = new Map(Array.from({ length: 128 }, (_, key) => [key, everyVelocity]));
  const drumKeys = new Map(DEFAULT_BANK_DRUM_NOTES.map(key => [key, everyVelocity]));
  // BasicSoundBank.trim: Map<preset, Map<key, Set<velocity>>>. Absent presets
  // are removed, and so is every zone and sample no kept key/velocity reaches.
  const keep = new Map();
  for (const preset of bank.presets) {
    if (!preset.isGMGSDrum && preset.bankMSB === 0 && preset.bankLSB === 0 && DEFAULT_BANK_PROGRAMS.includes(preset.program)) keep.set(preset, everyKey);
    else if (preset.isGMGSDrum && preset.program === 0 && preset.bankLSB === 0) keep.set(preset, drumKeys);
  }
  const kept = [...keep.keys()].map(preset => ({ program: preset.program, drums: preset.isGMGSDrum, name: preset.name }));
  const programs = kept.filter(p => !p.drums).map(p => p.program).sort((a, b) => a - b);
  if (JSON.stringify(programs) !== JSON.stringify([...DEFAULT_BANK_PROGRAMS].sort((a, b) => a - b)) || kept.filter(p => p.drums).length !== 1) {
    throw Error(`upstream bank does not carry the expected presets: ${JSON.stringify(kept)}`);
  }
  bank.trim(keep);
  if (!bank.samples.every(sample => sample.isCompressed)) throw Error('a kept sample is not SF3-compressed; refusing to write a PCM bank');
  bank.soundBankInfo.creationDate = new Date(DEFAULT_BANK_CREATION_DATE);
  const out = new Uint8Array(bank.writeSF2({ software: DEFAULT_BANK_SOFTWARE, writeDefaultModulators: true, writeExtendedLimits: true }));
  return { bytes: out, presets: kept, samples: bank.samples.length };
}
