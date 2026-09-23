// A tiny synthetic stand-in for the upstream FluidR3Mono_GM.sf3, generated on
// demand so tests never need the network or the real bank. It has the preset
// layout the default-bank trim expects (studio/web/preview/default-bank-trim.mjs):
// the mapped GM programs plus programs it must drop, and a Standard kit with
// the mapped drum notes plus a note it must drop. Samples are flagged SF3 and
// carry a few placeholder bytes, not Ogg Vorbis: the trim copies them
// unchanged, and SpessaSynth plays a sample it cannot decode as silence. The
// INFO date is the upstream's own text, which the trim must not read in the
// local time zone.
import { BasicInstrument, BasicPreset, BasicSample, BasicSoundBank, SampleTypes } from 'spessasynth_core';
import { DEFAULT_BANK_DRUM_NOTES, DEFAULT_BANK_PROGRAMS } from '../../web/preview/instruments.mjs';

const EXTRA_PROGRAMS = [1, 56];
const EXTRA_DRUM_NOTE = 60;
const ISO_DATE = '2016-12-05T00:00:00Z';
export const SYNTHETIC_INFO_DATE = '5th December 2016';

function sample(bank, name, key) {
  const item = new BasicSample(name, 22050, key, 0, SampleTypes.monoSample, 0, 32);
  item.setCompressedData(new Uint8Array([...new TextEncoder().encode(`OggS placeholder ${name}`)]));
  bank.addSamples(item);
  return item;
}

export function syntheticUpstreamBank() {
  const bank = new BasicSoundBank();
  Object.assign(bank.soundBankInfo, { name: 'Synthetic default-bank fixture', comment: 'Synthetic test fixture; not an instrument bank.', creationDate: new Date(ISO_DATE) });
  for (const program of [...DEFAULT_BANK_PROGRAMS, ...EXTRA_PROGRAMS].sort((a, b) => a - b)) {
    const instrument = new BasicInstrument();
    instrument.name = `tone ${program}`;
    instrument.createZone(sample(bank, `tone ${program}`, 60));
    bank.addInstruments(instrument);
    const preset = new BasicPreset(bank);
    Object.assign(preset, { name: `Program ${program}`, program, bankMSB: 0, bankLSB: 0 });
    preset.createZone(instrument);
    bank.addPresets(preset);
  }
  const kit = new BasicInstrument();
  kit.name = 'kit';
  for (const note of [...DEFAULT_BANK_DRUM_NOTES, EXTRA_DRUM_NOTE]) {
    const zone = kit.createZone(sample(bank, `drum ${note}`, note));
    zone.keyRange = { min: note, max: note };
  }
  bank.addInstruments(kit);
  const standard = new BasicPreset(bank);
  Object.assign(standard, { name: 'Standard', program: 0, bankMSB: 128, bankLSB: 0, isGMGSDrum: true });
  standard.createZone(kit);
  bank.addPresets(standard);
  const bytes = new Uint8Array(bank.writeSF2({ software: 'synthetic fixture' }));
  // writeSF2 records the date in ISO form; put the upstream's wording back
  // (same chunk length, NUL-padded) so the fixture exercises the same parse.
  const iso = new TextEncoder().encode(ISO_DATE);
  const at = bytes.findIndex((_, i) => iso.every((byte, j) => bytes[i + j] === byte));
  if (at < 0) throw Error('synthetic bank: INFO date not found');
  bytes.fill(0, at, at + iso.length);
  bytes.set(new TextEncoder().encode(SYNTHETIC_INFO_DATE), at);
  return bytes;
}
