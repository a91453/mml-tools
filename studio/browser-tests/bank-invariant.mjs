import assert from 'node:assert/strict';

// The bank invariant, observed from outside the pages' own bookkeeping.
// Studio's timbre preview and the Workshop share one bank store, the single
// source of truth for the user's sound bank (studio/web/preview/
// bank-choices.mjs). Whatever order picks, removals, store writes, checks,
// engine builds and plays happen in:
//
//   1. once a choice has settled, the page names exactly the bank the store
//      keeps (the free default bank, in Studio, when it keeps none);
//   2. the engine never plays a bank the page does not name: every note-on
//      the page sends to a synth goes to one that holds the bank the page
//      names at that moment;
//   3. an export renders the bank the page names when the render starts;
//   4. once a choice has settled, no live synth holds any other bank.
//
// bankProbe runs in the page (page.addInitScript, before any hold that wraps
// the same calls, so it sees a message when it is really posted, and
// page.evaluate for the page already open). It follows every AudioWorklet
// node's port the page posts on: the banks sent to it (addSoundBank),
// whether it was destroyed (destroyWorklet) or its context closed, and every
// note-on, recorded with the bank the page named at that moment. It records
// every render handed to a Worker ({type: 'render'}, the Workshop's mix
// worker) the same way. Banks are told apart by a fingerprint of their
// bytes (length and FNV-1a), computed the same way here in Node, so every
// bank a check uses must have bytes of its own (namedBank).
export function bankProbe() {
  if (window.bankProbe) return;
  const print = buffer => {
    const bytes = new Uint8Array(buffer);
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) { hash ^= bytes[i]; hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `${bytes.length}:${hash.toString(16)}`;
  };
  const probe = window.bankProbe = { names: {}, sends: [], notes: [], renders: [], print, defaultLabel: null };
  // The names a check registered (watchBanks) outlive a reload of the page.
  try {
    Object.assign(probe.names, JSON.parse(sessionStorage.getItem('bankProbeNames') ?? '{}'));
    probe.defaultLabel = sessionStorage.getItem('bankProbeDefaultLabel');
  } catch { /* a page without sessionStorage starts with none */ }
  // The bank a Studio bank line names: section 06's (#bank-status: "name ·
  // size · sha256 … · …", or the default bank's label) or the listening
  // player's (#listen-bank: "音色庫：name（…）", or the default bank's label).
  const studioLine = (element, status) => {
    const text = element.textContent ?? '';
    if (probe.defaultLabel && text.includes(probe.defaultLabel)) return '(default)';
    if (status) return text.includes(' · ') ? text.split(' · ')[0] : null;
    return text.startsWith('音色庫：') && text.includes('（') ? text.slice(4, text.indexOf('（')) : null;
  };
  // What the page names now, and that name's fingerprint (the check
  // registers each name's bytes). The Workshop names its bank in #dlsName
  // ("name · 0.0 MB · …"; while a pick is read, "… · reading"). In Studio,
  // where both bank lines are shown they must name the same bank.
  probe.named = () => {
    const workshop = document.querySelector('#dlsName');
    let text = '', name = null;
    if (workshop) {
      text = workshop.textContent ?? '';
      if (text.includes(' · ')) name = text.split(' · ')[0];
    } else {
      const lines = [[document.querySelector('#bank-status'), true], [document.querySelector('#listen-bank'), false]].filter(([element]) => element);
      text = lines.map(([element]) => element.textContent ?? '').join(' | ');
      const names = [...new Set(lines.map(([element, status]) => studioLine(element, status)))];
      name = names.length > 1 ? `two bank lines naming ${names.join(' and ')}` : names[0] ?? null;
    }
    return { text: text.slice(0, 160), name, print: name === null ? null : probe.names[name] ?? `unknown name ${name}` };
  };
  const ports = new Map();
  const portOf = Object.getOwnPropertyDescriptor(AudioWorkletNode.prototype, 'port');
  Object.defineProperty(AudioWorkletNode.prototype, 'port', {
    configurable: true,
    enumerable: portOf.enumerable,
    get() {
      const port = portOf.get.call(this);
      if (!ports.has(port)) ports.set(port, { node: this, bank: null, dead: false, id: ports.size + 1 });
      return port;
    },
  });
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    const synth = ports.get(this);
    if (synth && message?.type === 'soundBankManager' && message?.data?.type === 'addSoundBank') {
      synth.bank = print(message.data.data.soundBankBuffer);
      probe.sends.push({ synth: synth.id, bank: synth.bank, named: probe.named() });
    } else if (synth && message?.type === 'destroyWorklet') synth.dead = true;
    else if (synth && message?.type === 'midiMessage') {
      const [status, , velocity] = message.data?.messageData ?? [];
      if ((status & 0xf0) === 0x90 && velocity > 0) {
        const named = probe.named();
        const last = probe.notes.at(-1);
        // Consecutive notes on the same synth and bank under the same name are one entry.
        if (last?.synth === synth.id && last.bank === synth.bank && last.named.text === named.text) last.count += 1;
        else probe.notes.push({ synth: synth.id, bank: synth.bank, named, count: 1 });
      }
    }
    return post.call(this, message, ...rest);
  };
  let proto = window.Worker.prototype;
  while (!Object.hasOwn(proto, 'postMessage')) proto = Object.getPrototypeOf(proto);
  const workerPost = proto.postMessage;
  proto.postMessage = function (message, ...rest) {
    if (message?.type === 'render' && message.bytes) probe.renders.push({ bank: print(message.bytes), named: probe.named() });
    return workerPost.call(this, message, ...rest);
  };
  probe.live = () => [...ports.values()].filter(s => !s.dead && s.bank && s.node.context.state !== 'closed').map(s => s.bank);
  probe.counts = () => ({ notes: probe.notes.reduce((sum, note) => sum + note.count, 0), sends: probe.sends.length, renders: probe.renders.length });
}

// Holds for the steps a bank choice, a reconcile or a play waits on, each
// armed for one step with window.bankHolds.arm(what, options) and released
// with the returned hold's release(); `held` and `answered` count the step.
// Nothing is changed about the step itself, only when the page hears of it:
//   check  a bank check Worker's answer (stage 'answer', the default) or its
//          "loaded" message (stage 'loaded': a slow first load of the parser);
//   write  the completion of the store transaction that writes the bank
//          named `name` (the write itself runs and is kept);
//   read   the completion of the next read-only transaction that reads the
//          kept bank (a reconcile's store read, or a play's);
//   send   the next bank posted to a synth (addSoundBank), posted only once
//          released.
// A hold can be armed for the next page load too (armOnLoad, in Node): the
// page's first read of the store happens as it loads.
// Installed after bankProbe, so the probe sees a held send when it is posted.
export function bankHolds() {
  if (window.bankHolds) return;
  const holds = window.bankHolds = {};
  holds.arm = (what, options = {}) => {
    let release;
    const released = new Promise(resolve => { release = resolve; });
    holds[what] = { ...options, armed: true, held: 0, answered: 0, released, release: () => release() };
    return holds[what];
  };
  const RealWorker = window.Worker;
  let proto = RealWorker.prototype, onmessage;
  while (!(onmessage = Object.getOwnPropertyDescriptor(proto, 'onmessage'))) proto = Object.getPrototypeOf(proto);
  window.Worker = function (url, options) {
    const worker = new RealWorker(url, options);
    const hold = holds.check;
    if (!hold?.armed || !String(url).endsWith('/preview/bank-check-worker.mjs')) return worker;
    hold.armed = false;
    Object.defineProperty(worker, 'onmessage', {
      configurable: true,
      get() { return onmessage.get.call(this); },
      set(handler) {
        onmessage.set.call(this, typeof handler !== 'function' ? handler : function (event) {
          const loaded = event.data?.loaded === true;
          if ((hold.stage ?? 'answer') === 'answer' ? loaded : !loaded) return handler.call(this, event);
          hold.held += 1;
          hold.released.then(() => { hold.answered += 1; handler.call(this, event); });
          return undefined;
        });
      },
    });
    return worker;
  };
  window.Worker.prototype = RealWorker.prototype;
  const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
  const holdCompletion = (tx, hold) => {
    hold.held += 1;
    Object.defineProperty(tx, 'oncomplete', {
      configurable: true,
      get() { return complete.get.call(this); },
      set(handler) {
        complete.set.call(this, typeof handler !== 'function' ? handler : function (event) {
          hold.released.then(() => { hold.answered += 1; handler.call(this, event); });
        });
      },
    });
  };
  const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.put = function (value, key, ...rest) {
    const request = put.call(this, value, key, ...rest);
    const hold = holds.write;
    if (hold?.armed && key === 'current' && value?.name === hold.name) { hold.armed = false; holdCompletion(this.transaction, hold); }
    return request;
  };
  IDBObjectStore.prototype.get = function (key, ...rest) {
    const request = get.call(this, key, ...rest);
    const hold = holds.read;
    if (hold?.armed && key === 'current' && this.transaction.mode === 'readonly') { hold.armed = false; holdCompletion(this.transaction, hold); }
    return request;
  };
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    const hold = holds.send;
    if (hold?.armed && message?.type === 'soundBankManager' && message?.data?.type === 'addSoundBank') {
      hold.armed = false;
      hold.held += 1;
      hold.released.then(() => { hold.answered += 1; post.call(this, message, ...rest); });
      return undefined;
    }
    return post.call(this, message, ...rest);
  };
  try {
    const onLoad = JSON.parse(sessionStorage.getItem('bankHoldsOnLoad') ?? 'null');
    sessionStorage.removeItem('bankHoldsOnLoad');
    if (onLoad) holds.arm(onLoad.what, onLoad.options);
  } catch { /* nothing armed */ }
}

// The same fingerprint as the page's.
export function fingerprint(buffer) {
  const bytes = new Uint8Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) { hash ^= bytes[i]; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${bytes.length}:${hash.toString(16)}`;
}

// A copy of a SoundFont whose INFO name (INAM) is `name`, so that every bank
// a check picks has bytes of its own and a fingerprint of its own. The
// bank still parses and plays the same.
export function namedBank(bank, name) {
  const bytes = Buffer.from(bank);
  const at = bytes.indexOf('INAM');
  assert.ok(at > 0, 'the bank has an INAM chunk');
  const size = bytes.readUInt32LE(at + 4);
  assert.ok(Buffer.byteLength(name) < size, `${name} fits the INAM chunk`);
  bytes.fill(0, at + 8, at + 8 + size);
  bytes.write(name, at + 8, 'latin1');
  return bytes;
}

// Follows one page: `banks` maps each name the page may show to its bytes
// (`defaultBank`, with `defaultLabel`, names the free default bank's subset
// for Studio). check() asserts invariants 2 and 3 over everything recorded
// so far; settled() asserts 1 and 4 as well, at a moment when no choice is
// pending. The probe and the holds go in every document the page loads from
// now on (before any hold a check adds later), and in the one already open.
export async function watchBanks(page, { banks = {}, defaultBank = null, defaultLabel = null } = {}) {
  const names = Object.fromEntries(Object.entries(banks).map(([name, bytes]) => [name, fingerprint(bytes)]));
  if (defaultBank) names['(default)'] = fingerprint(defaultBank);
  await page.addInitScript(bankProbe);
  await page.addInitScript(bankHolds);
  const register = async () => {
    await page.evaluate(bankProbe);
    await page.evaluate(bankHolds);
    await page.evaluate(({ names, defaultLabel }) => {
      Object.assign(window.bankProbe.names, names);
      window.bankProbe.defaultLabel = defaultLabel;
      sessionStorage.setItem('bankProbeNames', JSON.stringify(window.bankProbe.names));
      if (defaultLabel) sessionStorage.setItem('bankProbeDefaultLabel', defaultLabel);
    }, { names, defaultLabel });
  };
  await register();
  const seen = () => page.evaluate(() => ({ notes: window.bankProbe.notes, renders: window.bankProbe.renders, sends: window.bankProbe.sends }));
  const nameOf = print => Object.entries(names).find(([, p]) => p === print)?.[0] ?? `an unregistered bank (${print})`;
  const watcher = {
    names,
    // Call after a navigation: the probe starts again with the new document.
    register,
    async add(more) { for (const [name, bytes] of Object.entries(more)) names[name] = fingerprint(bytes); await register(); },
    // What the probe has counted so far: note-ons, banks sent, renders.
    counts: () => page.evaluate(() => window.bankProbe.counts()),
    // Arms a hold for the page's next load.
    armOnLoad: (what, options = {}) => page.evaluate(value => sessionStorage.setItem('bankHoldsOnLoad', JSON.stringify(value)), { what, options }),
    async check(where) {
      const { notes, renders } = await seen();
      for (const note of notes) assert.equal(note.bank, note.named.print, `${where}: a note was played on the bank ${nameOf(note.bank)} while the page named ${note.named.name ?? 'no bank'} (${note.named.text})`);
      for (const render of renders) assert.equal(render.bank, render.named.print, `${where}: an export rendered the bank ${nameOf(render.bank)} while the page named ${render.named.name ?? 'no bank'} (${render.named.text})`);
      return { notes: notes.reduce((sum, note) => sum + note.count, 0), renders: renders.length };
    },
    async settled(where, { stored: expected } = {}) {
      const counts = await watcher.check(where);
      const now = await page.evaluate(async () => {
        const store = await import(new URL('/studio/web/preview/soundbank-store.mjs', location.href).href);
        const kept = await store.loadBank();
        return { named: window.bankProbe.named(), stored: kept ? { name: kept.name, print: window.bankProbe.print(kept.bytes) } : null, live: window.bankProbe.live() };
      });
      const keptPrint = now.stored?.print ?? (defaultBank ? names['(default)'] : null);
      if (expected !== undefined) assert.equal(now.stored?.name ?? null, expected, `${where}: the store keeps ${expected ?? 'no bank'}`);
      assert.equal(now.named.print, keptPrint, `${where}: the page names the bank the store keeps (${now.stored?.name ?? (defaultBank ? 'the default bank' : 'none')}): ${now.named.text}`);
      for (const live of now.live) assert.equal(live, now.named.print, `${where}: no live synth holds a bank the page does not name (${nameOf(live)} while it names ${now.named.name})`);
      return { ...counts, named: now.named.name, stored: now.stored?.name ?? null };
    },
    seen,
  };
  return watcher;
}
