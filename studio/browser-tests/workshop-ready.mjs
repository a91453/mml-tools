// Waiting for the Workshop to show itself, with a failure that says why not.
//
// A module of the Workshop that never arrives, or fails to load, can leave
// the page unready without a page error: only a console message says so, and
// a bare 30 s timeout on #unverified said nothing more (desktop Chromium, once
// in CI on 90bb6db, when a non-zh-Hant page stayed hidden until its language
// file loaded; the Workshop is zh-Hant only since). `watchPage` records,
// per page, the requests still in flight, the requests that failed and the
// console errors and warnings, so `workshopShown` can name them when it gives
// up.
const watched = new WeakMap();

export function watchPage(page) {
  if (watched.has(page)) return;
  const state = { inFlight: new Map(), failed: [], console: [] };
  watched.set(page, state);
  const since = () => Math.round(performance.now());
  page.on('request', r => state.inFlight.set(r, since()));
  page.on('requestfinished', r => state.inFlight.delete(r));
  page.on('requestfailed', r => {
    state.inFlight.delete(r);
    state.failed.push(`${r.url()}: ${r.failure()?.errorText ?? 'failed'}`);
  });
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') state.console.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
}

export async function workshopShown(page, options) {
  try {
    await page.locator('#unverified').waitFor(options);
  } catch (error) {
    const state = watched.get(page);
    const now = Math.round(performance.now());
    const seen = await page.evaluate(() => ({
      url: location.href,
      ready_state: document.readyState,
      lang: document.documentElement.lang,
      unverified: document.querySelector('#unverified') ? 'present' : 'absent',
      worker_controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
      workshop_modules_loaded: performance.getEntriesByType('resource')
        .filter(e => /\/workshop\/[^/]+\.m?js$/.test(e.name))
        .map(e => e.name.slice(e.name.lastIndexOf('/') + 1)),
    })).catch(e => ({ unreadable: e.message }));
    const detail = state
      ? {
          ...seen,
          requests_in_flight: [...state.inFlight].slice(-20).map(([r, at]) => `${r.url()} (${now - at} ms)`),
          requests_failed: state.failed.slice(-20),
          console: state.console.slice(-20),
        }
      : { ...seen, requests: 'not watched' };
    throw Object.assign(new Error(`The Workshop never showed itself: ${JSON.stringify(detail)}`), { cause: error });
  }
}
