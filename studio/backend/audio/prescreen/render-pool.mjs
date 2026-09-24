// A small pool of render workers for the audio prescreen.
//
// Status: IMPLEMENTATION NOTES. Workers start on first use, hold a reference
// on the process only while they have a job, and are terminated after a
// period of idleness, so an idle service (and a finished test) keeps no
// thread alive. A worker keeps the last bank it parsed; the pool sends the
// bank bytes only to a worker that has not seen that bank yet. A worker that
// dies fails its job and is replaced on the next one.
//
// A job still running `jobTimeoutMs` after it was dispatched fails, and its
// worker is terminated rather than reused. A render is one synchronous loop
// inside the worker, so it cannot be asked to stop; terminating the thread
// stops it outright and frees its heap. Nothing a worker holds is shared with
// the pool or another worker (its bank is re-sent to the fresh worker that
// takes the next job), so no state of the stopped job survives.
//
// The limit is a backstop against a job that never ends, not a performance
// budget: the Application Service already refuses, before dispatching
// anything, a render longer than PRESCREEN_LIMITS.maxRenderSeconds (1,200 s).
// Fifteen minutes is well above what such a render costs: a real song's
// density takes about 15 ms of CPU per second of audio at 22.05 kHz mono (33
// ms at 44.1 kHz stereo), and the densest arrangement measured for this
// limit, six roles of sixteenth notes at T120 on a ringing voice, about 120 ms
// at 22.05 kHz mono: about 2.5 minutes of CPU for a 1,200 s render, and by
// the real song's stereo-to-mono ratio about 5.5 minutes at 44.1 kHz stereo.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

const WORKER_URL = new URL('./render-worker.mjs', import.meta.url);

export const defaultPoolSize = () => Math.max(1, Math.min(4, (availableParallelism?.() ?? 2) - 1));
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

export function createRenderPool({ size = defaultPoolSize(), idleMs = 30000, jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
  // A timer's longest delay; a longer one would fire at once.
  if (!Number.isInteger(jobTimeoutMs) || jobTimeoutMs < 1 || jobTimeoutMs > 2 ** 31 - 1) throw RangeError('jobTimeoutMs must be an integer from 1 to 2147483647');
  const slots = [];
  const queue = [];
  let sequence = 0;

  const spawn = () => {
    const worker = new Worker(WORKER_URL);
    const slot = { worker, busy: null, bankSha256: null, idle: null, dead: false };
    worker.unref();
    worker.on('message', message => {
      const job = slot.busy;
      if (!job || message.id !== job.id) return;
      clearTimeout(job.timer);
      slot.busy = null;
      worker.unref();
      if (message.ok) {
        if (job.bank) slot.bankSha256 = job.bank.sha256;
        job.resolve(message.result);
      } else {
        job.reject(Object.assign(Error(message.error?.message ?? 'render worker failed'), { code: 'AUDIO_RENDER_FAILED' }));
      }
      release(slot);
    });
    const die = error => {
      if (slot.dead) return;
      slot.dead = true;
      clearTimeout(slot.idle);
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      const job = slot.busy;
      slot.busy = null;
      if (job) {
        clearTimeout(job.timer);
        job.reject(Object.assign(Error(`render worker stopped: ${String(error?.message ?? error).slice(0, 200)}`), { code: 'AUDIO_RENDER_FAILED' }));
      }
      pump();
    };
    worker.on('error', die);
    worker.on('exit', code => die(`exit ${code}`));
    slots.push(slot);
    return slot;
  };

  // Retire a worker before terminating it, so no job can be dispatched to a
  // thread that is already on its way out.
  const retire = slot => {
    if (slot.dead) return;
    slot.dead = true;
    clearTimeout(slot.idle);
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    slot.worker.terminate();
  };

  const release = slot => {
    clearTimeout(slot.idle);
    slot.idle = setTimeout(() => { if (!slot.busy) retire(slot); }, idleMs);
    slot.idle.unref();
    pump();
  };

  // The job has run too long: fail it and retire its worker (see the header).
  // The slot leaves the pool before its thread is terminated, so the next job
  // goes to a fresh worker, and a result the old thread still sends is ignored.
  const timeOut = (slot, job) => {
    if (slot.busy !== job) return;
    slot.busy = null;
    retire(slot);
    job.reject(Object.assign(Error(`render job ${job.type} exceeded ${jobTimeoutMs} ms; its worker was stopped`), { code: 'AUDIO_RENDER_FAILED' }));
    pump();
  };

  const dispatch = (slot, job) => {
    clearTimeout(slot.idle);
    slot.busy = job;
    slot.worker.ref();
    const payload = { ...job.payload };
    if (job.bank) {
      payload.bankSha256 = job.bank.sha256;
      payload.bankBytes = slot.bankSha256 === job.bank.sha256 ? null : job.bank.bytes;
    }
    job.timer = setTimeout(() => timeOut(slot, job), jobTimeoutMs);
    job.timer.unref();
    slot.worker.postMessage({ id: job.id, type: job.type, payload }, job.transfer ?? []);
  };

  function pump() {
    while (queue.length) {
      const job = queue[0];
      let slot = slots.find(entry => !entry.busy && !entry.dead && job.bank && entry.bankSha256 === job.bank.sha256)
        ?? slots.find(entry => !entry.busy && !entry.dead);
      if (!slot && slots.length < size) slot = spawn();
      if (!slot) return;
      queue.shift();
      dispatch(slot, job);
    }
  }

  return Object.freeze({
    size,
    /** Run one job. `bank` ({ sha256, bytes }) is required for render and calibration jobs. */
    run(type, payload, { bank = null, transfer = [] } = {}) {
      return new Promise((resolve, reject) => {
        queue.push({ id: ++sequence, type, payload, bank, transfer, resolve, reject });
        pump();
      });
    },
    async close() {
      for (const job of queue.splice(0)) job.reject(Object.assign(Error('render pool closed'), { code: 'AUDIO_RENDER_FAILED' }));
      const closing = [...slots];
      for (const slot of closing) {
        slot.dead = true;
        clearTimeout(slot.idle);
        const job = slot.busy;
        slot.busy = null;
        if (job) {
          clearTimeout(job.timer);
          job.reject(Object.assign(Error('render pool closed'), { code: 'AUDIO_RENDER_FAILED' }));
        }
      }
      slots.length = 0;
      await Promise.all(closing.map(slot => slot.worker.terminate()));
    },
  });
}
