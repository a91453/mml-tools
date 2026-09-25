// Holds the next bank check a page starts (soundbank-store.mjs), as if its
// bank were a big one: the check's Worker is replaced by a stand-in that says
// it has loaded, takes the bank, and answers that it parses only once the
// test calls window.heldBankCheck.release(). Every later check uses the real
// Worker again. `handed` says the stand-in has been given the bank, and
// `stopped` that the page has stopped it (after its answer, or at a limit).
//
// Installed on the live page (again after every navigation).
export async function holdNextBankCheck(page) {
  await page.evaluate(() => {
    const RealWorker = window.Worker;
    window.heldBankCheck = null;
    window.Worker = function (url, options) {
      if (!String(url).endsWith('/preview/bank-check-worker.mjs')) return new RealWorker(url, options);
      window.Worker = RealWorker;
      const held = window.heldBankCheck = { handed: false, stopped: false };
      const stand = { postMessage() { held.handed = true; }, terminate() { held.stopped = true; } };
      held.release = () => stand.onmessage?.({ data: { ok: true, presets: 1 } });
      setTimeout(() => stand.onmessage?.({ data: { loaded: true } }), 0);
      return stand;
    };
  });
}
