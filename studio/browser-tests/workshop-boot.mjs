// Holds one step of the Workshop's boot in the page until the check says so,
// so a bank can be picked at that point: the SpessaSynth processor's module
// load (the engine is still booting), the read of the bank kept in the store
// (the engine is ready and the kept bank has been asked for), or the new
// synth's readiness (that bank's load waits for it). Each is installed with
// page.addInitScript and armed for one load by a sessionStorage flag,
// holdProcessor, holdKeptBankRead or holdSynthReady, set before the reload;
// window.processorHold, window.keptBankReadHold and window.synthReadyHold
// then report how many requests are held and release them. Playwright does
// not route an AudioWorklet's module request (a page.route for processor.js
// sees nothing in Chromium), so the module load is held at
// Worklet.addModule instead.

export function processorHold() {
  if (sessionStorage.getItem('holdProcessor') !== 'yes') return;
  sessionStorage.removeItem('holdProcessor');
  const addModule = Worklet.prototype.addModule;
  let release;
  const released = new Promise(resolve => { release = resolve; });
  window.processorHold = { held: 0, release: () => release() };
  Worklet.prototype.addModule = function (url, ...rest) {
    if (!String(url).endsWith('/vendor/spessasynth/processor.js')) return addModule.call(this, url, ...rest);
    window.processorHold.held += 1;
    return released.then(() => addModule.call(this, url, ...rest));
  };
}

// The new synth's first reply, the one its readiness waits for
// (synth-ready.mjs), reaches the page only once released, armed by the
// sessionStorage flag holdSynthReady: the load that made the synth (the
// boot-time load of the kept bank) waits for it before sending any bank.
export function synthReadyHold() {
  if (sessionStorage.getItem('holdSynthReady') !== 'yes') return;
  sessionStorage.removeItem('holdSynthReady');
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const ready = data => data?.type === 'isFullyInitialized' && data?.data?.type === 'sf3Decoder';
  let release;
  const released = new Promise(resolve => { release = resolve; });
  window.synthReadyHold = { held: 0, release: () => release() };
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    configurable: true,
    enumerable: onmessage.enumerable,
    get() { return onmessage.get.call(this); },
    set(handler) {
      onmessage.set.call(this, typeof handler !== 'function' ? handler : function (event) {
        if (!ready(event?.data)) return handler.call(this, event);
        window.synthReadyHold.held += 1;
        released.then(() => handler.call(this, event));
        return undefined;
      });
    },
  });
}

// The first opening of Studio's bank store after the load (the Workshop's
// boot-time loadStoredBank; nothing else opens it at boot) answers only once
// released: its success event is held back from the page's handler.
export function keptBankReadHold() {
  if (sessionStorage.getItem('holdKeptBankRead') !== 'yes') return;
  sessionStorage.removeItem('holdKeptBankRead');
  const open = IDBFactory.prototype.open;
  const onsuccess = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
  let release;
  const released = new Promise(resolve => { release = resolve; });
  window.keptBankReadHold = { held: 0, release: () => release() };
  IDBFactory.prototype.open = function (name, ...rest) {
    const request = open.call(this, name, ...rest);
    if (name !== 'mml-studio-soundbank' || window.keptBankReadHold.held) return request;
    window.keptBankReadHold.held += 1;
    Object.defineProperty(request, 'onsuccess', {
      configurable: true,
      get() { return onsuccess.get.call(this); },
      set(handler) {
        onsuccess.set.call(this, typeof handler !== 'function' ? handler : function (event) { released.then(() => handler.call(this, event)); });
      },
    });
    return request;
  };
}
