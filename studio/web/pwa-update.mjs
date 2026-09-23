// Service Worker update flow for Studio Web.
//
// Ported from the owner's earlier frontend `pwa.js` (frontend capture
// f1b7024f…baad9a, owner authorization 2026-09-23) and merged with Studio's own
// invariant. The two designs disagree on one point and the merge keeps Studio's:
//
//   * The earlier frontend serves its own code network-first, so an online page is already
//     running the new release and "update" only refreshes the offline snapshot.
//     It can therefore hide the update behind a quiet button.
//   * Studio serves every module cache-first from ONE versioned cache so a live
//     review never mixes old and new Canonical modules (see sw.js). A page keeps
//     running its release until it reloads, so a waiting release must be
//     announced, and applying it must never strand another tab on a mixed graph.
//
// Taken from the earlier frontend:
//   * three detection entry points — `reg.waiting` (a tab closed before
//     applying), `reg.installing` (the browser started fetching before this code
//     listened; missing it was a real race that hid updates in standalone
//     windows) and `updatefound`;
//   * a release is offered only once it is `installed` AND the page already has
//     a controller, so a first visit is never told to "update";
//   * explicit apply via a SKIP_WAITING message, never an automatic skipWaiting;
//   * the reload on `controllerchange` is guarded by "this tab asked for it",
//     because `clients.claim()` also fires controllerchange on a first visit;
//   * `reg.update()` on focus as well as visibilitychange (desktop standalone
//     windows rarely become hidden), throttled, errors ignored while offline;
//   * one pending worker that always points at the newest, and a click handler
//     bound once.
//
// Added for Studio:
//   * apply is gated by the caller (app.mjs runs it through the task queue and
//     refuses an unsaved project), because a reload discards anything that
//     exists only in memory;
//   * a tab that sees a controller change it did NOT request is marked stale:
//     its already-loaded modules are the old release while the new worker now
//     serves the new one, so it must reload before doing more work (`onStale`).

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function createUpdateFlow({
  serviceWorker,
  now = () => Date.now(),
  reload,
  onDownloading = () => {},
  onOffer = () => {},
  onStale = () => {},
  checkInterval = UPDATE_CHECK_INTERVAL_MS,
}) {
  let pending = null;
  let requested = false;
  let stale = false;
  let lastCheck = -Infinity;
  let registration = null;
  // Whether this page was loaded under a worker. An uncontrolled first visit
  // fetched its modules from the network, so the first clients.claim() is not
  // a version change; every later controller change is.
  let controlled = Boolean(serviceWorker.controller);

  serviceWorker.addEventListener('controllerchange', () => {
    const wasControlled = controlled;
    controlled = true;
    if (requested) {
      requested = false;
      reload();
      return;
    }
    if (!wasControlled || stale) return;
    stale = true;
    onStale();
  });

  function offer(worker) {
    pending = worker;
    onOffer(worker);
  }

  function track(worker) {
    const ready = () => worker.state === 'installed' && serviceWorker.controller;
    if (ready()) return offer(worker);
    worker.addEventListener('statechange', () => { if (ready()) offer(worker); });
  }

  return Object.freeze({
    attach(reg) {
      registration = reg;
      // register() has just asked the browser to re-fetch sw.js.
      lastCheck = now();
      if (reg.waiting && serviceWorker.controller) offer(reg.waiting);
      if (reg.installing) {
        if (serviceWorker.controller) onDownloading();
        track(reg.installing);
      }
      reg.addEventListener('updatefound', () => {
        if (!reg.installing) return;
        if (serviceWorker.controller) onDownloading();
        track(reg.installing);
      });
    },
    // Called from focus and visibilitychange. Offline this rejects, which only
    // means the question cannot be asked right now.
    check() {
      if (!registration) return false;
      const at = now();
      if (at - lastCheck < checkInterval) return false;
      lastCheck = at;
      Promise.resolve(registration.update()).catch(() => {});
      return true;
    },
    apply() {
      if (!pending) return false;
      requested = true;
      pending.postMessage({ type: 'SKIP_WAITING' });
      return true;
    },
    get pending() { return pending; },
    get stale() { return stale; },
  });
}
