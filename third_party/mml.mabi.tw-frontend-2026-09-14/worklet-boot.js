// worklet console shim — snapshot from mml.mabi.tw 2026-09-14
const NEED = [
  "log", "info", "warn", "error", "debug", "trace",
  "group", "groupEnd", "groupCollapsed",
  "table", "dir", "assert", "time", "timeEnd", "count",
];
const patched = [];
try {
  if (typeof globalThis.console !== "object" || globalThis.console === null) {
    globalThis.console = {};
  }
  const base = typeof console.log === "function" ? console.log.bind(console) : () => {};
  for (const name of NEED) {
    if (typeof console[name] !== "function") {
      console[name] = base;
      patched.push(name);
    }
  }
} catch {
  const noop = () => {};
  const replacement = {};
  for (const name of NEED) replacement[name] = noop;
  Object.defineProperty(globalThis, "console", {
    value: replacement, writable: true, configurable: true,
  });
  patched.push("*whole-console*");
}
class ConsoleProbe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage(patched);
  }
  process() {
    return false;
  }
}
registerProcessor("mmlworkshop-console-probe", ConsoleProbe);
