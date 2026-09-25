import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../web/preview/player.mjs';
import { parseListening } from '../web/listen-model.mjs';

// The preview transport with its audio boundary doubled: a fake AudioContext
// clock, a synth that records what it is sent, and the scheduler's interval
// driven by hand. What is checked is the scheduler's own state -- what it
// queued and when it stopped -- not audio.
function rig() {
  const sent = [];
  const context = { currentTime: 10, state: 'running', resume: async () => {} };
  const synth = {
    noteOn: (channel, pitch, velocity, { time } = {}) => sent.push({ on: true, channel, pitch, time }),
    noteOff: (channel, pitch, { time } = {}) => sent.push({ on: false, channel, pitch, time }),
    controllerChange() {}, programChange() {}, stopAll() {}, destroy() {}, voiceCount: 0,
    midiChannels: Array.from({ length: 16 }, () => ({ setSystemParameter() {} })),
  };
  const out = { gain: { cancelScheduledValues() {}, setValueAtTime() {} } };
  const engine = { context, synth, out, presets: [{ program: 0, bankMSB: 0, name: 'fixture' }], bank: { name: 'fixture', sha256: '0'.repeat(64) } };
  const ends = [];
  let tick = null, frames = 0;
  const saved = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, setTimeout: globalThis.setTimeout };
  globalThis.setInterval = fn => { tick = fn; return 1; };
  globalThis.clearInterval = () => { tick = null; };
  globalThis.requestAnimationFrame = () => { frames += 1; return 0; };
  globalThis.cancelAnimationFrame = () => {};
  const restore = () => Object.assign(globalThis, { setInterval: saved.setInterval, clearInterval: saved.clearInterval, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf });
  const transport = createTransport(engine, { onEnd: (capture, info) => ends.push({ capture, info }) });
  return { transport, context, sent, ends, step: () => tick?.(), get ticking() { return tick !== null; }, get frames() { return frames; }, restore };
}
// Eight quarter notes at 120 bpm: one every half second.
const song = parseListening('MML@t120o4l4cdefgabc,,,,,;').song;

test('a ranged playback queues only its range, starts at the requested second and stops at its end', async t => {
  const r = rig();
  t.after(r.restore);
  r.transport.load(song);
  // "Play from bar 2, until the end of bar 2" at 120 bpm 4/4: seconds 2..4 would
  // be beyond this 4-second song, so use beats 1..3 = seconds 0.5..1.5.
  await r.transport.play(0.5, { until: 1.5 });
  assert.deepEqual({ ...r.transport.state, next: undefined }, { playing: true, from: 0.5, until: 1.5, duration: 4, next: undefined });
  r.context.currentTime += 5; // everything is inside the look-ahead window now
  r.step();
  const ons = r.sent.filter(event => event.on);
  assert.deepEqual(ons.map(event => event.pitch), [62, 64], 'only the notes that start inside [0.5, 1.5) are queued');
  const t0 = ons[0].time - 0.5;
  assert.ok(ons.every(event => event.time - t0 < 1.5));
  assert.equal(r.transport.state.next, 1.5, 'the scheduler is holding at the range end');
  // Past the range end the playback halts by itself, as a ranged end.
  r.context.currentTime = t0 + 1.6;
  r.step();
  assert.equal(r.transport.playing, false);
  assert.equal(r.ends.length, 1);
  assert.equal(r.ends[0].info.ranged, true);
});

test('a ranged playback from the start is never a complete readback capture; an unranged one still is', async t => {
  const r = rig();
  t.after(r.restore);
  r.transport.load(song);
  await r.transport.play(0, { until: 1 });
  r.context.currentTime += 5; r.step(); r.step();
  assert.equal(r.ends.length, 1);
  assert.equal(r.ends[0].capture.complete, false);
  assert.ok(r.ends[0].capture.incomplete.includes('RANGE_LIMITED'));
  // The settle wait before a from-zero capture uses real timers; skip it.
  r.context.currentTime += 10;
  await r.transport.play(0);
  assert.equal(r.transport.state.until, null);
  r.context.currentTime += 5; r.step();
  assert.equal(r.sent.filter(event => event.on).length, 2 + 8);
  r.context.currentTime += 10; r.step();
  assert.equal(r.ends.length, 2);
  assert.equal(r.ends[1].info.ranged, false);
  assert.deepEqual(r.ends[1].capture.incomplete, [], 'nothing about an unranged playback marks its capture incomplete');
});

test('a playback still waiting to start when the transport is stopped or destroyed never starts', async t => {
  const r = rig();
  t.after(r.restore);
  r.transport.load(song);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const [what, end] of [['destroyed (a bank change)', () => r.transport.destroy()], ['stopped', () => r.transport.stop()]]) {
    await r.transport.play(0);
    assert.equal(r.ticking, true);
    // A quick restart from the start waits (real timers, up to 0.4 s) for
    // the stopped playback's queued notes to pass; it ends meanwhile.
    r.transport.stop();
    const restart = r.transport.play(0);
    await pause(50);
    const sentBefore = r.sent.length, framesBefore = r.frames;
    end();
    await restart;
    assert.equal(r.transport.playing, false, `${what}: the playback did not start`);
    assert.equal(r.ticking, false, `${what}: no scheduler interval is left running`);
    assert.equal(r.frames, framesBefore, `${what}: no position loop was started`);
    assert.equal(r.sent.length, sentBefore, `${what}: nothing was sent to the engine`);
  }

  // A context closed while it resumes rejects the resume (Chromium rejects
  // a pending resume on close): a playback overtaken that way ends quietly.
  const closing = rig();
  t.after(closing.restore);
  closing.transport.load(song);
  closing.context.resume = () => new Promise((resolve, reject) => { closing.context.close = () => reject(Object.assign(Error('Audio context is going away'), { name: 'InvalidStateError' })); });
  const starting = closing.transport.play(0.5);
  closing.transport.destroy();
  await starting;
  assert.equal(closing.transport.playing, false);
  assert.equal(closing.ticking, false);
});
