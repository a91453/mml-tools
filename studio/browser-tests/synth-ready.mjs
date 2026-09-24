// Withholds the SpessaSynth processor's first reply from the page: the
// {type: "isFullyInitialized", data: {type: "sf3Decoder"}} message it posts
// once its bundled decoder is set up, which is all the lib's synth.isReady
// waits for. It stands in for a processor that never finishes starting.
// The lib receives worklet messages through the port's onmessage, so the
// setter wraps every handler and drops that one message while this tab's
// sessionStorage `withholdSynthReady` is "yes". web-build.test.mjs holds the
// vendored lib and processor to both halves. (Playwright does not route an
// AudioWorklet's module request, so the processor itself cannot be served
// altered.)
//
// Run it in the page: page.evaluate(readyGate) before a synth is made, or
// page.addInitScript(readyGate) for a synth made while the page loads.
export function readyGate() {
  if (window.readyGateInstalled) return;
  window.readyGateInstalled = true;
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  const withheld = data => data?.type === 'isFullyInitialized' && data?.data?.type === 'sf3Decoder' && sessionStorage.getItem('withholdSynthReady') === 'yes';
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    configurable: true,
    enumerable: onmessage.enumerable,
    get() { return onmessage.get.call(this); },
    set(handler) {
      onmessage.set.call(this, typeof handler !== 'function' ? handler : function (event) {
        if (withheld(event?.data)) return undefined;
        return handler.call(this, event);
      });
    },
  });
}

export const withholdSynthReady = (page, on) => page.evaluate(on => {
  if (on) sessionStorage.setItem('withholdSynthReady', 'yes'); else sessionStorage.removeItem('withholdSynthReady');
}, on);
