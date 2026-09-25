import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankChoices, sameBank } from '../web/preview/bank-choices.mjs';

// The rule both pages follow (preview/bank-choices.mjs): a choice only
// decides what the bank store holds; the latest choice, and only it, reports
// its own outcome and is then reconciled; plays and exports wait for that.
// The browser checks (studio/browser-tests/bank-choices.mjs and
// workshop-bank.mjs) drive the real pages and store; here every step is a
// promise the test settles by hand, so each interleaving is exact.

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// Lets every step that is ready run.
const flush = () => new Promise(resolve => setImmediate(resolve));

// A page: every reconcile is recorded with a `current` it must ask, and
// waits for the test to let its store read end (`read`); a stale one is
// recorded as stopping there. `events` is what the page showed, in order.
function page() {
  const events = [], reads = [];
  const choices = createBankChoices({
    async reconcile(current) {
      const read = deferred();
      reads.push(read);
      events.push('reconcile starts');
      const kept = await read.promise;
      if (!current()) { events.push(`stale reconcile of ${kept} changes nothing`); return; }
      events.push(`names ${kept}`);
    },
  });
  const choose = name => {
    const decided = deferred();
    const done = choices.choose(() => decided.promise, (error, value) => events.push(error ? `${name} refused: ${error.message}` : `${name}: ${value}`));
    return { decided, done };
  };
  return { choices, events, reads, choose };
}

test('the latest choice reports its outcome, then is reconciled, and only then is the page settled', async () => {
  const { choices, events, reads, choose } = page();
  assert.equal(choices.pending(), true, 'before the first read of the store, nothing is settled');
  const opened = choices.open();
  await flush();
  reads[0].resolve('saw.sf2');
  await opened;
  assert.equal(choices.pending(), false);
  assert.deepEqual(events, ['reconcile starts', 'names saw.sf2']);

  let waited = false;
  const pick = choose('first.sf2');
  assert.equal(choices.latest(), 1, 'the choice is numbered as it is made');
  assert.equal(choices.pending(), true);
  const settled = choices.settled().then(() => { waited = true; });
  pick.decided.resolve('kept');
  await flush();
  assert.deepEqual(events.slice(2), ['first.sf2: kept', 'reconcile starts'], 'its outcome is said before the store is read again');
  assert.equal(waited, false, 'a play waits while the store is read');
  reads[1].resolve('first.sf2');
  await pick.done;
  await settled;
  assert.equal(waited, true);
  assert.equal(choices.pending(), false);
  assert.deepEqual(events.slice(4), ['names first.sf2']);
});

test('a refused choice is reconciled too: the page names what the store keeps, whatever that is', async () => {
  const { choices, events, reads, choose } = page();
  const opened = choices.open(); await flush(); reads[0].resolve('saw.sf2'); await opened;
  const pick = choose('damaged.sf2');
  pick.decided.reject(Error('does not parse'));
  await flush();
  // An older pick's write, sent before this one was made, may have landed.
  reads[1].resolve('first.sf2');
  await pick.done;
  assert.deepEqual(events.slice(2), ['damaged.sf2 refused: does not parse', 'reconcile starts', 'names first.sf2']);
});

test('an overtaken choice reports nothing and reconciles nothing, whatever became of it', async () => {
  for (const outcome of ['kept', 'refused']) {
    const { choices, events, reads, choose } = page();
    const opened = choices.open(); await flush(); reads[0].resolve('saw.sf2'); await opened;
    const older = choose('older.sf2');
    const newer = choose('newer.sf2');
    assert.equal(choices.latest(), 2);
    newer.decided.resolve('kept');
    await flush();
    reads[1].resolve('newer.sf2');
    await newer.done;
    if (outcome === 'kept') older.decided.resolve('kept'); else older.decided.reject(Error('does not parse'));
    await older.done;
    await flush();
    assert.equal(reads.length, 2, `${outcome}: the overtaken choice never reads the store`);
    assert.deepEqual(events.slice(2), ['newer.sf2: kept', 'reconcile starts', 'names newer.sf2'], `${outcome}: only the newer choice is said and named`);
    assert.equal(choices.pending(), false);
  }
});

test('a choice made while an older one is reconciled stops that reconcile, and the page is settled only by the newer one', async () => {
  const { choices, events, reads, choose } = page();
  const opened = choices.open(); await flush(); reads[0].resolve('saw.sf2'); await opened;
  const older = choose('damaged.sf2');
  older.decided.reject(Error('does not parse'));
  await flush();
  assert.deepEqual(events.slice(2), ['damaged.sf2 refused: does not parse', 'reconcile starts'], 'refused while it was still the latest: said at once');
  const newer = choose('newer.sf2');
  let waited = false;
  const settled = choices.settled().then(() => { waited = true; });
  // The older reconcile's read ends after the newer choice was made.
  reads[1].resolve('saw.sf2');
  await older.done;
  await flush();
  assert.equal(waited, false, 'the stale reconcile does not settle the page');
  assert.equal(choices.pending(), true);
  newer.decided.resolve('kept');
  await flush();
  reads[2].resolve('newer.sf2');
  await newer.done; await settled;
  assert.deepEqual(events.slice(4), ['stale reconcile of saw.sf2 changes nothing', 'newer.sf2: kept', 'reconcile starts', 'names newer.sf2']);
  assert.ok(!events.slice(4).some(event => event.startsWith('damaged.sf2')), 'the refusal is never said again after the newer choice');
});

test('a reconcile overtaken by a newer choice that has already been reconciled leaves the page settled', async () => {
  const { choices, events, reads, choose } = page();
  const opened = choices.open(); await flush(); reads[0].resolve('saw.sf2'); await opened;
  const older = choose('damaged.sf2');
  older.decided.reject(Error('does not parse'));
  await flush();
  const newer = choose('newer.sf2');
  newer.decided.resolve('kept');
  await flush();
  // The newer choice's read ends first, and the page is settled on it.
  reads[2].resolve('newer.sf2');
  await newer.done;
  assert.equal(choices.pending(), false);
  // Then the older reconcile's read ends.
  reads[1].resolve('saw.sf2');
  await older.done;
  await flush();
  assert.equal(choices.pending(), false, 'plays and exports are not held again by a reconcile that was overtaken');
  assert.deepEqual(events.slice(2), ['damaged.sf2 refused: does not parse', 'reconcile starts', 'newer.sf2: kept', 'reconcile starts', 'names newer.sf2', 'stale reconcile of saw.sf2 changes nothing']);
});

test('the page\'s first read of the store is older than every choice', async () => {
  // A choice made while the first read is under way overtakes it.
  {
    const { choices, events, reads, choose } = page();
    const opened = choices.open();
    await flush();
    const pick = choose('picked.sf2');
    reads[0].resolve('saw.sf2');
    await opened;
    assert.equal(choices.pending(), true, 'the first read, overtaken, settles nothing');
    pick.decided.resolve('kept'); await flush();
    reads[1].resolve('picked.sf2'); await pick.done;
    assert.deepEqual(events, ['reconcile starts', 'stale reconcile of saw.sf2 changes nothing', 'picked.sf2: kept', 'reconcile starts', 'names picked.sf2']);
  }
  // Asked for after a choice, however late: it changes nothing.
  {
    const { choices, events, reads, choose } = page();
    const pick = choose('picked.sf2');
    await choices.open();
    assert.equal(reads.length, 0, 'the first read is never made once a choice has been');
    pick.decided.resolve('kept'); await flush();
    reads[0].resolve('picked.sf2'); await pick.done;
    await choices.open();
    assert.equal(reads.length, 1);
    assert.deepEqual(events, ['picked.sf2: kept', 'reconcile starts', 'names picked.sf2']);
  }
});

test('a refresh reconciles only while no choice is pending', async () => {
  const { choices, events, reads, choose } = page();
  const opened = choices.open(); await flush(); reads[0].resolve('saw.sf2'); await opened;
  const pick = choose('picked.sf2');
  await choices.refresh();
  assert.equal(reads.length, 1, 'no refresh while a choice is pending: its own reconcile follows');
  pick.decided.resolve('kept'); await flush();
  reads[1].resolve('picked.sf2'); await pick.done;
  const refreshed = choices.refresh(); await flush();
  reads[2].resolve('other-tab.sf2'); await refreshed;
  assert.deepEqual(events.slice(-2), ['reconcile starts', 'names other-tab.sf2']);
  assert.equal(choices.pending(), false);
});

test('a reconcile or a report that throws still settles the page, and says so in the console', async () => {
  const logged = [];
  const { error } = console;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    const choices = createBankChoices({ reconcile: async () => { throw Error('store unreadable'); } });
    await choices.choose(async () => 'kept', () => { throw Error('report broke'); });
    assert.equal(choices.pending(), false, 'plays and exports are not left waiting forever');
    await choices.settled();
    assert.deepEqual(logged, ['[bank] report failed: Error: report broke', '[bank] reconcile failed: Error: store unreadable']);
  } finally { console.error = error; }
});

test('two kept banks are the same only when the store describes the same record', () => {
  const saw = { name: 'saw.sf2', size: 890, sha256: 'ab', savedAt: '2026-09-24T00:00:00.000Z' };
  assert.equal(sameBank(saw, { ...saw }), true);
  assert.equal(sameBank(null, null), true, 'no bank is no bank');
  assert.equal(sameBank(saw, null), false);
  assert.equal(sameBank(undefined, undefined), false, 'a bank not read yet is not a bank read');
  assert.equal(sameBank(saw, { ...saw, savedAt: '2026-09-24T00:00:01.000Z' }), false, 'the same file kept again is another record');
  assert.equal(sameBank(saw, { ...saw, sha256: 'cd' }), false);
});
