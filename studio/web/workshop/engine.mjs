// Studio Workshop — ported from the owner's earlier frontend (owner-authorized port).
// SpessaSynth worklet engine wrapper (Studio vendored build, user-supplied bank).
// Workshop edits sit outside the Canonical/verified pipeline and are never evidence.
import { WORKLET, BOOT, ENGINE_LIB } from "./config.mjs";
import * as i18n from "./i18n.mjs";
import { addSoundBankOrFail, synthReadyOrFail } from "../preview/bank-check.mjs";

let ctx = null, synth = null, out = null, WorkletSynthesizer = null, booting = null;

let onStatus = () => {};
let onPresetList = () => {};
export const setStatusHandler     = fn => { onStatus = fn; };
export const setPresetListHandler = fn => { onPresetList = fn; };

async function step(id, fn) {
  const name = i18n.t(`engine.step.${id}`);
  onStatus(name + "…");
  try {
    return await fn();
  } catch (err) {
    console.error(`[Workshop] ${name}:`, err);
    err.step = id;
    throw err;
  }
}

export function boot() {
  if (booting) return booting;
  booting = (async () => {
    await step("lib", async () => {
      ({ WorkletSynthesizer } = await import(ENGINE_LIB));
    });

    await step("ctx", async () => { ctx = new AudioContext(); });

    // Safari's worklet scope has no console; Studio's shim fills it in first.
    try { await ctx.audioWorklet.addModule(BOOT); }
    catch (err) { console.warn("[Workshop] worklet console shim:", err); }

    await step("worklet", () => ctx.audioWorklet.addModule(WORKLET));

    onStatus(i18n.t("engine.ready", { hz: ctx.sampleRate }));
  })();
  booting.catch(() => { booting = null; });
  return booting;
}

// `current` says whether this bank is still the one wanted. It is asked once
// the engine has booted and its synth is ready, right before the bank is
// sent, with nothing awaited in between: a load no longer wanted stops there,
// sends nothing and resolves to null.
export async function loadBank(buf, { current = () => true } = {}) {
  const mb = (buf.byteLength / 1048576).toFixed(1);
  await boot();
  if (!synth) {
    const made = new WorkletSynthesizer(ctx);
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    made.connect(gain);
    made.eventHandler.addEvent("presetListChange", "ui", list => onPresetList(list));
    // isReady waits for the processor's first reply. One that fails to start,
    // or never finishes setting up, would leave this load, and every bank
    // load queued behind it, waiting forever. A synth that is not ready is
    // dropped, so the next load starts a new one.
    try { await synthReadyOrFail(made, ctx); }
    catch (err) {
      try { made.destroy(); } catch (e) { console.warn("[Workshop] synth not destroyed:", e); }
      gain.disconnect();
      if (err?.code === "SYNTH_READY_TIMEOUT") throw Error(i18n.t("engine.synthTimeout", { s: Math.round(err.timeoutMs / 1000) }));
      if (err?.code === "SYNTH_FAILED") throw Error(i18n.t("engine.synthFailed", { detail: err.message }));
      throw err;
    }
    synth = made; out = gain;

    synth.addNewChannel();
  }
  if (!current()) return null;
  // A bank the worklet cannot parse is reported only as an event; without the
  // guard this load, and every bank load queued behind it, would never end.
  // The synth keeps the bank it had.
  try { await addSoundBankOrFail(synth, buf, "main"); }
  catch (err) {
    if (err?.code === "BANK_UNPARSABLE") throw Error(i18n.t("engine.bankUnparsable", { detail: err.message }));
    if (err?.code === "BANK_LOAD_TIMEOUT") throw Error(i18n.t("engine.bankTimeout", { s: Math.round(err.timeoutMs / 1000) }));
    throw err;
  }
  return { list: synth.presetList, mb };
}

export const context = () => ctx;

export const now = () => ctx ? ctx.currentTime : performance.now() / 1000;
export const resume = () => ctx?.resume();

export const suspend = () => ctx?.suspend();

export const noteOn  = (ch, midi, vel, time) => synth?.noteOn(ch, midi, vel, { time });
export const noteOff = (ch, midi, time)      => synth?.noteOff(ch, midi, { time });
export const stopAll = () => synth?.stopAll(true);

const gainTo = (v, at) => {
  if (!out) return;
  const t = Math.max(at, ctx.currentTime);
  out.gain.cancelScheduledValues(t);
  out.gain.setValueAtTime(v, t);
};

export const mute   = (at = 0) => gainTo(0, at);
export const unmute = (at = 0) => gainTo(1, at);

export function setChannelMute(ch, on) {
  synth?.midiChannels?.[ch]?.setSystemParameter("isMuted", !!on);
}

// `drum` selects the bank's percussion kit on this channel (GM drum mode)
// instead of a melodic program; the Mabinogi Mobile BassDrum and Cymbals
// instruments are previewed that way (see instruments.mjs).
export function selectProgram(ch, msb, lsb, prog, drum = false) {
  if (!synth) return;
  synth.midiChannels?.[ch]?.setDrums?.(!!drum);
  synth.controllerChange(ch, 0, drum ? 0 : msb);
  synth.controllerChange(ch, 32, drum ? 0 : lsb);
  synth.programChange(ch, prog);
}
