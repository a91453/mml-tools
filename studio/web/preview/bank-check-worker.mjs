// Module Worker: parses a user-picked bank off the main thread before it is
// kept (soundbank-store.mjs). It uses the spessasynth_core copy the build
// vendors for the preview engine, so no other code is loaded to check it.
// It says so once that copy has loaded, and only then is it handed the bank:
// the check's time limit counts the parse, not the download of the parser.
import * as core from '../../../vendor/spessasynth/core.js';
import { checkSoundBank } from './bank-check.mjs';

self.onmessage = ({ data }) => {
  try {
    const { presets } = checkSoundBank(new Uint8Array(data.bytes), core);
    self.postMessage({ ok: true, presets });
  } catch (error) {
    self.postMessage({ ok: false, message: String(error?.message ?? error) });
  }
};
self.postMessage({ loaded: true });
