// Module Worker: trims the verified upstream bank to the default subset off the
// main thread (default-bank.mjs checks both SHA-256 digests; this only trims).
// It uses the spessasynth_core copy the build vendors for the preview engine,
// so no other code is loaded to make the subset.
import * as core from '../../../vendor/spessasynth/core.js';
import { trimDefaultBank } from './default-bank-trim.mjs';

self.onmessage = ({ data }) => {
  try {
    const { bytes } = trimDefaultBank(new Uint8Array(data.upstream), core);
    self.postMessage({ ok: true, bytes: bytes.buffer }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: String(error?.message ?? error) });
  }
};
