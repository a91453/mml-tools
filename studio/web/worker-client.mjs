// The analysis Worker owns one computation at a time and dispatches messages in
// order. A request that times out or dies is therefore not just a failed
// request: its computation still owns the Worker, so every later request queues
// behind work nobody is waiting for and times out in turn. Recovery has to
// replace the instance, not only reject the caller.
//
// Replacing it is also what keeps the failure fail-closed. A fresh Worker
// re-verifies the published Canonical package before it answers anything, so a
// recovered session cannot answer from a half-initialised runtime; and while no
// Worker can be started, every call rejects instead of hanging, which leaves the
// gates that depend on it PENDING rather than silently unevaluated.
//
// A Worker whose script loaded but which could not fetch part of its module
// graph is broken the same way, though it still answers: every request gets
// that failure back for the rest of its life. It says so
// (initializationRetryable), and it ran none of the requests, so they are
// replayed unchanged on the replacement. It is replaced within the same budget
// as a Worker that fails to start. Before this, one dropped module request
// left the page on its boot error until it was reloaded.
export const WORKER_TIMEOUT = '本機分析逾時，未完成的 Gate 保持 PENDING';
export const WORKER_UNAVAILABLE = '本機分析 Worker 無法啟動，請重新開啟；未完成的 Gate 保持 PENDING';
export const WORKER_GIVEN_UP = '本機分析 Worker 反覆失敗，請重新開啟頁面；未完成的 Gate 保持 PENDING';

export function createWorkerClient({ spawn, timeoutMs = 45000, maxRestarts = 3 } = {}) {
  if (typeof spawn !== 'function') throw Error('worker client requires a spawn function');
  const pending = new Map();
  let worker = null, sequence = 0, restarts = 0, givenUp = false;

  function attach() {
    const instance = spawn();
    instance.onmessage = ({ data }) => {
      // An instance that has been replaced is not heard again, by message or
      // by error: its requests were rejected with it, or moved to its
      // replacement.
      if (instance !== worker) return;
      const request = pending.get(data?.id);
      if (!request) return;
      if (data.error && data.initializationRetryable) return replaceUninitialized(data.error);
      clearTimeout(request.timer);
      pending.delete(data.id);
      // Only an answered request proves this instance is healthy, so the restart
      // budget is spent by consecutive failures and reset by real progress.
      restarts = 0;
      data.error ? request.reject(Error(data.error)) : request.resolve(data.result);
    };
    // Chromium still delivers an error event from an instance after terminate(),
    // though it drops its messages, so a late error must not take down the
    // replacement.
    instance.onerror = () => { if (instance === worker) recycle(WORKER_UNAVAILABLE); };
    return instance;
  }

  function recycle(reason) {
    const dying = worker;
    worker = null;
    try { dying?.terminate?.(); } catch { /* already gone; the replacement is what matters */ }
    // Nothing in flight can still be answered: the instance that owned those ids
    // is gone, and ids are not replayed onto its replacement.
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error(reason)); }
    pending.clear();
    if (++restarts > maxRestarts) { givenUp = true; return; }
    worker = attach();
  }

  // Every request this instance holds would get the same failure, and none of
  // them ran, so each keeps its deadline and moves to the replacement. It is
  // posted again from the caller's own arguments, which every caller awaits
  // without changing them.
  function replaceUninitialized(reason) {
    const dying = worker;
    worker = null;
    try { dying?.terminate?.(); } catch { /* already gone; the replacement is what matters */ }
    if (++restarts > maxRestarts) {
      givenUp = true;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error(reason)); }
      pending.clear();
      return;
    }
    worker = attach();
    for (const [id, request] of pending) {
      try { worker.postMessage({ id, action: request.action, args: request.args }); }
      catch (error) { clearTimeout(request.timer); pending.delete(id); request.reject(error); }
    }
  }

  return {
    call(action, ...args) {
      return new Promise((resolve, reject) => {
        if (givenUp) return reject(Error(WORKER_GIVEN_UP));
        if (!worker) worker = attach();
        const id = ++sequence;
        const timer = setTimeout(() => recycle(WORKER_TIMEOUT), timeoutMs);
        pending.set(id, { resolve, reject, timer, action, args });
        try { worker.postMessage({ id, action, args }); }
        catch (error) { clearTimeout(timer); pending.delete(id); recycle(WORKER_UNAVAILABLE); reject(error); }
      });
    },
    get state() { return { pending: pending.size, restarts, givenUp, running: Boolean(worker) }; },
  };
}
