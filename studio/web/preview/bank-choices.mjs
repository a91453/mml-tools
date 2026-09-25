// Bank choices, and the one step that follows them, shared by Studio's timbre
// preview (app.mjs) and the Workshop (workshop/ui.mjs). No DOM and no storage
// of its own: each page passes in its own reconcile step.
//
// The bank store (soundbank-store.mjs) is the single source of truth for the
// user's sound bank; both pages read and write the same one.
//
//   * A choice (picking a bank, or removing it) only decides what the store
//     should hold. `decide(current)` checks the file and writes, or deletes,
//     only while the choice is still the latest: soundbank-store.mjs asks
//     `current` after the check and again inside the store's own transaction,
//     right before the write or delete request, with nothing awaited between.
//   * When `decide` ends, a choice that is still the latest reports its own
//     outcome (`report`: kept, refused, removed or failed), and then
//     `reconcile(current)` re-reads the store and makes everything the page
//     shows, plays or exports match exactly the bank the store keeps, or
//     none. A choice that is no longer the latest reports nothing and
//     reconciles nothing, whatever became of it. `reconcile` asks `current`
//     after every await and, once it is false, changes nothing more: the
//     newer choice reconciles when it ends.
//   * `pending()` is true from the moment a choice is made until the latest
//     choice has been reconciled, and before any choice until the page's
//     first read of the store (`open`) has been. `settled()` resolves once it
//     is false. Playback and export wait for it, so they only ever use what a
//     reconcile installed.
//
// Why a settled page names what the store keeps: IndexedDB runs a
// transaction on the store only after every read/write transaction made
// before it has finished. The latest choice's own write or delete has
// finished before its reconcile reads. An older choice's write either had
// been sent before the latest choice was made, so it runs before that read,
// or is never sent, since `current` is asked right before it. So the
// reconcile reads the store as this page's choices left it, and no write
// from this page follows. A write that cannot be stopped needs no undoing:
// the reconcile names and loads what it left.
//
// What this does not cover: another page or tab writing to the same store.
// That is found by this page's next reconcile, or where a page checks the
// store before it uses the bank (Studio before it builds an engine, the
// Workshop before an export), which then calls `refresh`.
export function createBankChoices({ reconcile }) {
  let latest = 0;
  let reconciled = -1;
  let opened = false;
  let waiting = [];
  const wake = () => {
    if (reconciled !== latest) return;
    const woken = waiting;
    waiting = [];
    for (const resolve of woken) resolve();
  };
  async function finish(id, current) {
    try { await reconcile(current); }
    catch (error) { console.error('[bank] reconcile failed:', error); }
    if (!current()) return;
    reconciled = id;
    wake();
  }
  return Object.freeze({
    // The newest choice's number; 0 before any choice.
    latest: () => latest,
    pending: () => reconciled !== latest,
    settled: () => (reconciled === latest ? Promise.resolve() : new Promise(resolve => { waiting.push(resolve); })),
    // The page's first read of the store, older than every choice: once a
    // choice has been made it changes nothing, however late it is asked for
    // or ends.
    async open() {
      if (opened || latest !== 0) return;
      opened = true;
      await finish(0, () => latest === 0);
    },
    // A reconcile with no choice, when a page found, where it uses the bank,
    // that the store no longer keeps the bank it names (another page or tab
    // wrote it). Does nothing while a choice is pending: that choice's own
    // reconcile follows.
    async refresh() {
      const id = latest;
      if (reconciled !== id) return;
      await finish(id, () => id === latest);
    },
    // Makes a choice. Its number is taken now, synchronously, inside the
    // user's event, so a choice made later is always newer. `decide(current)`
    // resolves or rejects with the choice's outcome. `report(error, value)`
    // shows it; it is called only if this is still the latest choice when
    // `decide` ends, with nothing awaited between that check and the call,
    // and the reconcile follows. Resolves once the choice has been
    // reconciled or overtaken; never rejects for the choice's own outcome.
    async choose(decide, report = () => {}) {
      const id = ++latest;
      const current = () => id === latest;
      let value, failure = null;
      try { value = await decide(current); } catch (error) { failure = error; }
      if (!current()) return;
      try { report(failure, value); } catch (error) { console.error('[bank] report failed:', error); }
      await finish(id, current);
    },
  });
}

// The identity of a kept bank, as the store describes it: the same record
// (name, size, SHA-256 and the moment it was saved), or both none. A bank not
// read yet (`undefined`) is the same as nothing.
export function sameBank(a, b) {
  if (a === undefined || b === undefined) return false;
  if (!a || !b) return !a && !b;
  return a.name === b.name && a.size === b.size && a.sha256 === b.sha256 && a.savedAt === b.savedAt;
}
