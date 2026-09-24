// A sound bank that does not parse, caught before it is kept and while it is
// loaded. spessasynth_core's own loader (SoundBankLoader.fromArrayBuffer) is
// what the synth worklet runs on a bank before it can play it, so a bank whose
// RIFF header is intact but whose body is truncated or corrupt fails here the
// same way it would fail there. No DOM, no network, no storage.
//
// checkSoundBank runs in two places, like the default bank's trim:
//   * the Studio Web's Worker (bank-check-worker.mjs), with the vendored
//     spessasynth_core the build already ships (vendor/spessasynth/core.js),
//     before soundbank-store.mjs keeps a picked bank;
//   * Node, with the npm spessasynth_core the build vendors that copy from.
// addSoundBankOrFail is the load itself, and synthReadyOrFail the wait for a
// new synth before it, both used by the preview (player.mjs) and the Workshop
// (workshop/engine.mjs).

// How long a bank may take to load into the worklet before the load stops
// waiting for it. A bank the worklet cannot parse is reported at once; this
// bounds whatever else keeps the worklet from answering.
export const BANK_LOAD_TIMEOUT_MS = 60000;

// The engine's own error text, fit to show on a page: a damaged bank's bytes
// can be quoted in it (a chunk name of NULs), so control characters go.
export function bankErrorDetail(error) {
  const text = String(error?.message ?? error ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * @param {Uint8Array|ArrayBuffer} input the bank's bytes
 * @param {{ SoundBankLoader }} core spessasynth_core, npm or vendored
 * @returns {{ presets: number }} throws the loader's own error when it does not parse
 */
export function checkSoundBank(input, { SoundBankLoader }) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  const bank = SoundBankLoader.fromArrayBuffer(whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { presets: bank.presets.length };
}

// How long a new synth may take to report ready once its audio context runs.
// The processor answers as soon as its bundled decoder is set up, within a
// fraction of a second on a desktop; this bounds one that never does.
export const SYNTH_READY_TIMEOUT_MS = 20000;

// Why a load did not finish: BANK_UNPARSABLE (the worklet reported a parse
// error; the message is the engine's own text), BANK_LOAD_TIMEOUT,
// SYNTH_FAILED (the processor stopped with an error while starting) or
// SYNTH_READY_TIMEOUT. Each page words it in its own language.
export class BankLoadError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'BankLoadError'; this.code = code; Object.assign(this, extra); }
}

/**
 * Loads `buffer` into a spessasynth_lib WorkletSynthesizer, or rejects.
 * When the worklet cannot parse a bank it posts only a `soundBankError`
 * event, never the reply soundBankManager.addSoundBank() waits for, so that
 * call alone would wait forever. The error listener is in place before the
 * bank is sent, and it and the timer are gone once the load is settled.
 * @returns {Promise<void>} rejects with a BankLoadError
 */
export function addSoundBankOrFail(synth, buffer, id, { timeoutMs = BANK_LOAD_TIMEOUT_MS } = {}) {
  const listener = `${id}:load-error`;
  let timer = 0;
  const failed = new Promise((resolve, reject) => {
    synth.eventHandler.addEvent('soundBankError', listener, error => reject(new BankLoadError('BANK_UNPARSABLE', bankErrorDetail(error))));
    timer = setTimeout(() => reject(new BankLoadError('BANK_LOAD_TIMEOUT', `sound bank not loaded within ${timeoutMs} ms`, { timeoutMs })), timeoutMs);
  });
  let added;
  try { added = synth.soundBankManager.addSoundBank(buffer, id); }
  catch (error) { added = Promise.reject(error); }
  return Promise.race([added, failed]).finally(() => {
    clearTimeout(timer);
    synth.eventHandler.removeEvent('soundBankError', listener);
  });
}

/**
 * Waits for a new WorkletSynthesizer's `isReady`, or rejects. isReady
 * resolves only on the processor's first reply, sent once its decoder is set
 * up; a processor that throws while it is constructed (reported only as the
 * node's `processorerror` event) or never finishes setting up leaves it
 * pending forever, and with it every bank load waiting behind. The clock
 * starts once `context` is running: the Web Audio spec constructs the
 * processor from the rendering thread, so a context still suspended (made
 * before any user gesture) may rightly not answer until it runs. Chromium
 * answers while suspended as well. A context that is closed never will.
 * Listeners and timer are gone once settled.
 * @returns {Promise<void>} rejects with a BankLoadError
 */
export function synthReadyOrFail(synth, context, { timeoutMs = SYNTH_READY_TIMEOUT_MS } = {}) {
  const node = synth.worklet;
  let timer = 0, onError = null, onState = null;
  const failed = new Promise((resolve, reject) => {
    onError = event => reject(new BankLoadError('SYNTH_FAILED', bankErrorDetail(event?.message || event?.error?.message) || 'processorerror'));
    onState = () => {
      if (context?.state === 'closed') reject(new BankLoadError('SYNTH_FAILED', 'the audio context was closed'));
      if (timer || context?.state !== 'running') return;
      timer = setTimeout(() => reject(new BankLoadError('SYNTH_READY_TIMEOUT', `synth not ready within ${timeoutMs} ms`, { timeoutMs })), timeoutMs);
    };
    node?.addEventListener?.('processorerror', onError);
    context?.addEventListener?.('statechange', onState);
    onState();
  });
  return Promise.race([synth.isReady, failed]).finally(() => {
    clearTimeout(timer);
    node?.removeEventListener?.('processorerror', onError);
    context?.removeEventListener?.('statechange', onState);
  });
}
