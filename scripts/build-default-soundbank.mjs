// Reproduces, in Node, the free default preview bank's subset that each
// browser derives for itself (studio/web/preview/default-bank.mjs): the same
// trim (studio/web/preview/default-bank-trim.mjs) run with the npm
// spessasynth_core that the build vendors for the browser.
//
//   node scripts/build-default-soundbank.mjs [<path/to/FluidR3Mono_GM.sf3>]
//   node scripts/build-default-soundbank.mjs <input> --out <file outside this checkout>
//   node scripts/build-default-soundbank.mjs <input> --record   (after an intended change)
//
// The input defaults to STUDIO_DEFAULT_BANK_SOURCE. Neither the upstream file
// nor the subset is stored in this repository or shipped in the build: the
// upstream file asks not to be redistributed, so the Studio Web fetches it from
// its original source at first use. The input must hash to the upstream
// SHA-256 pinned in studio/web/default-bank/provenance.json. By default the
// script only checks that the subset reproduces the recorded SHA-256 and
// writes nothing. --out writes the subset to a path outside this checkout;
// --record rewrites the recorded output in provenance.json (the browser's pin
// in default-bank.mjs must then follow, which a unit test enforces).
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SoundBankLoader } from 'spessasynth_core';
import { trimDefaultBank as trim } from '../studio/web/preview/default-bank-trim.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const provenancePath = resolve(root, 'studio/web/default-bank/provenance.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const trimDefaultBank = input => trim(input, { SoundBankLoader });

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const inputPath = args.find((arg, i) => !arg.startsWith('--') && (outIndex < 0 || i !== outIndex + 1)) ?? process.env.STUDIO_DEFAULT_BANK_SOURCE;
  if (!inputPath || (outIndex >= 0 && !outPath)) { console.error('usage: node scripts/build-default-soundbank.mjs [<FluidR3Mono_GM.sf3>] [--out <file outside this checkout>] [--record]'); process.exit(2); }
  if (outPath) {
    const inside = relative(root, resolve(outPath));
    if (!inside.startsWith('..') && !isAbsolute(inside)) throw Error('--out must be outside this checkout: the bank is never stored in the repository');
  }
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const input = new Uint8Array(await readFile(inputPath));
  if (sha256(input) !== provenance.upstream.sha256) throw Error(`input SHA-256 ${sha256(input)} is not the pinned upstream ${provenance.upstream.sha256}`);
  const { bytes, presets, samples } = trimDefaultBank(input);
  const digest = sha256(bytes);
  if (record) {
    provenance.output = { ...provenance.output, sha256: digest, bytes: bytes.length, samples, presets };
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  } else if (digest !== provenance.output.sha256) {
    throw Error(`trimmed bank SHA-256 ${digest} does not reproduce the recorded ${provenance.output.sha256}; nothing was written`);
  }
  if (outPath) await writeFile(outPath, bytes);
  console.log(JSON.stringify({ reproduced: digest === provenance.output.sha256, written: outPath ?? null, bytes: bytes.length, sha256: digest, samples, presets }));
}
