// 這支檔案跑在 AudioWorkletGlobalScope，必須在 spessasynth_processor.js 之前 addModule。
//
// worklet 的 console 是闕割版（Safari 連 console.log 都沒有，見 WebKit Bug 220039；其他
// 瀏覽器多半缺 group / groupEnd / groupCollapsed），而 spessasynth 的 processor 在「模組
// 求值階段」就執行 `static logFunctions = { group: console.group.bind(console), … }` ——
// 缺哪個方法就是 undefined.bind → addModule() 直接失敗。先補齊就沒事。
//
// 同一個 AudioContext 的所有 worklet 模組共用同一個 global scope，所以在這裡改 console，
// 後面載入竹的 processor 就看得到。

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
  // console 不給寫（frozen / 只有 getter）→ 整個換掉
  const noop = () => {};
  const replacement = {};
  for (const name of NEED) replacement[name] = noop;
  Object.defineProperty(globalThis, "console", {
    value: replacement, writable: true, configurable: true,
  });
  patched.push("*whole-console*");
}

// 診斷用：讓主執行緒問得到剛才補了什麼
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
