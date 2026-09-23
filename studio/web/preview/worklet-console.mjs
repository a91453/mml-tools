// Loaded into the AudioWorklet scope before the SpessaSynth processor.
// Safari's AudioWorkletGlobalScope exposes little or no `console`, and the
// processor logs while it loads, so without these stubs addModule() fails
// there. (Lesson from the owner's earlier frontend worklet boot.)
const scope = globalThis;
if (typeof scope.console !== 'object' || scope.console === null) scope.console = {};
for (const name of ['log', 'info', 'warn', 'error', 'debug', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd', 'table', 'trace']) {
  if (typeof scope.console[name] !== 'function') scope.console[name] = () => {};
}
