import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createTaskQueue } from '../web/task-queue.mjs';
import { createSourceRequestLedger } from '../web/source-requests.mjs';

const source = (await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// A File-like double. The intake handler reads the first four bytes of whatever
// is chosen, so a plain object with a name is no longer enough to stand in for
// a file the user picked.
const bytesOf = head => Uint8Array.from(head, character => character.charCodeAt(0));
const file = (name, head, overrides = {}) => ({
  name,
  size: overrides.size ?? head.length,
  slice: (start, end) => ({ arrayBuffer: async () => bytesOf(head).slice(start, end).buffer }),
  arrayBuffer: async () => bytesOf(head).buffer,
  text: async () => head,
  ...overrides,
});

// Run the actual app controller and handlers, with DOM/Worker/storage boundaries
// doubled. This checks app wiring as well as the queue without copying its logic.
// Real DOM, IndexedDB and browser lifecycle coverage lives in browser-tests/.
function controller() {
  const nodes = new Map(), collections = new Map(), stored = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', setAttribute() {},
      set innerHTML(html) {
        const values = [...html.matchAll(/<option value="([^"]*)"\s*(selected)?/g)];
        if (selector === '#projects') this.value = (values.find(m => m[2]) ?? values[0])?.[1] ?? '';
      },
    });
    return nodes.get(selector);
  };
  const saved = [];
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: selector => collections.get(selector) ?? [] },
    createTaskQueue, createSourceRequestLedger, createWorkerClient: () => ({ call: (...args) => context.workerCall(...args) }),
    Worker: function () {}, URL, structuredClone, crypto,
    FormData: class { constructor(form) { return Object.entries(form.fields); } },
    setTimeout: () => 0, clearTimeout() {}, navigator: {},
    listProjects: async () => [...stored.values()],
    saveProject: async w => { const result = { ...w, savedAt: 'new-save' }; stored.set(w.id, result); saved.push(result); return result; },
    render() {},
  });
  const run = code => vm.runInContext(code.replaceAll('import.meta.url', JSON.stringify(import.meta.url)), context);
  run(source.slice(source.indexOf('const $'), source.indexOf('const input =')));
  run(source.slice(source.indexOf('async function putSource'), source.indexOf('async function copyText')));
  run(source.slice(source.indexOf('function bind()'), source.indexOf("$('#new-project').onclick=")));
  run(source.slice(source.indexOf("$('#new-project').onclick="), source.indexOf('function network()')));
  context.workerCall = async (action, value) => {
    if (action === 'identity') return { metadata: { fixture: 1 } };
    if (action === 'newWorkspace') return { id: 'B', revision: 0, settings: {}, assets: {} };
    if (action === 'invalidate') return { ...value, revision: value.revision + 1 };
    return { state: 'CANDIDATE', gates: {}, tracks: null };
  };
  run("identity={metadata:{fixture:1}};workspace={id:'A',revision:0,settings:{},assets:{},reviews:{},core3Approvals:[]}");
  return { run, node, collections, context, stored, saved };
}

test('boot drains actions queued while its analysis was in flight', async () => {
  const t = controller(), started = deferred(), answer = deferred();
  const normal = t.context.workerCall;
  t.context.workerCall = (action, ...args) => {
    if (action === 'analyzeWorkspace') { started.resolve(); return answer.promise; }
    return normal(action, ...args);
  };
  const boot = t.run(`(async()=>{${source.slice(source.lastIndexOf('try {\n  identity='))}})()`);
  await started.promise;
  t.run('run(async()=>{globalThis.applied=true},{revisionBound:false})');
  answer.resolve({ state: 'CANDIDATE', gates: {} });
  await boot;
  assert.equal(t.run('globalThis.applied'), true);
  assert.equal(t.run('queued.length'), 0);
  assert.equal(t.run('busy'), 0);
});

test('a review queued for A cannot attach to B with the same revision number', async () => {
  const t = controller(), hold = deferred(); t.context.hold = hold.promise;
  const first = t.run('run(()=>hold,{revisionBound:false})');
  t.node('#new-project').onclick();
  t.run('run(async()=>{globalThis.reviewAttachedTo=workspace.id})');
  hold.resolve(); await first;
  assert.equal(t.run('workspace.id'), 'B');
  assert.equal(t.run('globalThis.reviewAttachedTo'), undefined);
});

test('same-project intake keeps FIFO across revisions while a stale review is refused', async () => {
  const t = controller(), hold = deferred(); t.context.hold = hold.promise;
  t.run('globalThis.applied=[]');
  const first = t.run('run(()=>hold,{revisionBound:false})');
  t.run("run(async()=>{workspace.revision++;applied.push('baseline')},{revisionBound:false})");
  t.run("run(async()=>{workspace.revision++;applied.push('previous')},{revisionBound:false})");
  t.run("run(async()=>{applied.push('stale-review')})");
  hold.resolve(); await first;
  assert.deepEqual(Array.from(t.run('applied')), ['baseline', 'previous']);
});

test('queued project selection captures the selected ID before the current save rerenders it', async () => {
  const t = controller(), hold = deferred(); t.context.hold = hold.promise;
  t.stored.set('A', { id: 'A', title: 'A', revision: 0 });
  t.stored.set('B', { id: 'B', title: 'B', revision: 0 });
  await t.run('refreshProjects()');
  const first = t.run('run(()=>hold,{revisionBound:false})');
  t.node('#projects').value = 'B'; t.node('#projects').onchange();
  await t.run('refreshProjects()');
  assert.equal(t.node('#projects').value, 'A', 'the in-flight commit restores A in the selector');
  hold.resolve(); await first;
  assert.equal(t.run('workspace.id'), 'B');
});

test('failed analysis clears the prior saved stamp and leaves no deliverable', async () => {
  const t = controller();
  t.run("workspace.savedAt='previous-save';workspace.canonicalKey=JSON.stringify(identity.metadata)");
  t.context.workerCall = async () => { throw Error('worker failure'); };
  await assert.rejects(t.run('commit({...workspace,revision:1})'), /worker failure/);
  assert.equal(t.run('workspace.savedAt'), null);
  assert.equal(t.saved.length, 0);
  assert.equal(t.run('report.gates.analysis.status'), 'PENDING');
  assert.equal(t.run('report.tracks'), null);
});

test('queued Core3 approvals stay attached to the chosen events when the list shrinks', async () => {
  const t = controller(), hold = deferred(); t.context.hold = hold.promise;
  t.context.changes = ['one', 'two', 'three'].map(eventId => ({ eventId, type: 'modify' }));
  t.run('report={core3:{unapproved:changes}}');
  const forms = [0, 1].map(index => ({ dataset: { core3: String(index) }, fields: { reason: `reason-${index}`, evidence: `event-${index}` } }));
  t.collections.set('[data-core3]', forms); t.run('bind()');
  t.context.workerCall = async (_action, w) => ({ state: 'CANDIDATE', core3: { unapproved: t.context.changes.filter(change => !w.core3Approvals.some(a => a.eventId === change.eventId)) } });
  const first = t.run('run(()=>hold,{revisionBound:false})');
  for (const form of forms) form.onsubmit({ preventDefault() {} });
  hold.resolve(); await first;
  assert.deepEqual(Array.from(t.run('workspace.core3Approvals'), a => [a.eventId, a.reason]), [['one', 'reason-0'], ['two', 'reason-1']]);
});

test('file authority is captured with the file choice before asynchronous reading', async () => {
  const t = controller(), read = deferred();
  const input = { dataset: { intake: 'baseline' }, value: 'score.xml', files: [file('score.xml', '<score', { text: () => read.promise })] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  const seen = [];
  const normal = t.context.workerCall;
  t.context.workerCall = async (action, ...args) => {
    if (action === 'intake') { seen.push(args[0]); return { project: {} }; }
    return normal(action, ...args);
  };
  t.node('#authority').value = 'supporting'; input.onchange();
  t.node('#authority').value = 'primary-symbolic'; read.resolve('<score-partwise/>');
  while (t.run('busy')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen[0].authority, 'supporting');
});

// ─── Raw MIDI intake wiring ─────────────────────────────────────────────────

// Routes one chosen file and records what the Worker was asked to do with it.
function intakeController() {
  const t = controller();
  const calls = [];
  const normal = t.context.workerCall;
  t.context.workerCall = async (action, ...args) => {
    if (action === 'intake' || action === 'intakeMidi') {
      calls.push({ action, payload: args[0] });
      return { name: args[0].name, format: action === 'intakeMidi' ? 'MIDI' : 'MML', project: { events: [] } };
    }
    return normal(action, ...args);
  };
  return { ...t, calls };
}

const settle = async t => { while (t.run('busy')) await new Promise(resolve => setImmediate(resolve)); };

test('the header bytes route the file, not the extension', async () => {
  for (const [name, head, action] of [
    ['song.mid', 'MThd', 'intakeMidi'],
    ['song.midi', 'MThd', 'intakeMidi'],
    // A MIDI file the user renamed still reaches the MIDI decoder...
    ['song.txt', 'MThd', 'intakeMidi'],
    // ...and a .mid that is not MIDI is not quietly parsed as text: it goes to
    // the decoder, which is what fails visibly on it.
    ['lying.mid', 'MML@t1', 'intakeMidi'],
    ['song.mml', 'MML@t1', 'intake'],
    ['score.xml', '<scor', 'intake'],
  ]) {
    const t = intakeController();
    const input = { dataset: { intake: 'candidate' }, value: name, files: [file(name, head)] };
    t.collections.set('[data-intake]', [input]); t.run('bind()');
    input.onchange();
    await settle(t);
    assert.equal(t.calls.length, 1, `${name} must produce exactly one intake`);
    assert.equal(t.calls[0].action, action, `${name} (${head}) must route to ${action}`);
  }
});

test('MIDI reaches the Worker as bytes and never as text', async () => {
  const t = intakeController();
  const chosen = file('song.mid', 'MThd@!');
  let textReads = 0;
  chosen.text = async () => { textReads++; return ''; };
  const input = { dataset: { intake: 'candidate' }, value: 'song.mid', files: [chosen] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  await settle(t);

  assert.equal(textReads, 0, 'no text decode may happen anywhere on the MIDI path');
  const { payload } = t.calls[0];
  assert.equal(payload.name, 'song.mid');
  assert.ok(payload.bytes instanceof ArrayBuffer, 'the Worker receives an ArrayBuffer');
  assert.deepEqual([...new Uint8Array(payload.bytes)].slice(0, 4), [0x4d, 0x54, 0x68, 0x64]);
  assert.equal(payload.bytes.byteLength, 6, 'the page copy is intact, not detached by a transfer');
});

test('the file input is cleared so the same file can be chosen again', async () => {
  const t = intakeController();
  const input = { dataset: { intake: 'candidate' }, value: 'song.mid', files: [file('song.mid', 'MThd')] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  assert.equal(input.value, '', 'a change event only fires for a changed value');
  await settle(t);
  assert.equal(t.calls.length, 1);
});

test('an oversized file is refused before any decode', async () => {
  const t = intakeController();
  const input = { dataset: { intake: 'candidate' }, value: 'huge.mid', files: [file('huge.mid', 'MThd', { size: 5 * 1048576 })] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  await settle(t);
  assert.equal(t.calls.length, 0);
  assert.match(t.node('#message').textContent, /4 MiB/);
});

test('a late MIDI result for a superseded choice never becomes the active source', async () => {
  const t = intakeController();
  const first = deferred(), second = deferred();
  const pending = { 'a.mid': first, 'b.mid': second };
  const normal = t.context.workerCall;
  t.context.workerCall = async (action, ...args) => {
    if (action === 'intakeMidi') return pending[args[0].name].promise;
    return normal(action, ...args);
  };

  const input = { dataset: { intake: 'candidate' }, value: '', files: [file('a.mid', 'MThd')] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  // B is chosen while A is still decoding. The token is taken at selection
  // time, so A is superseded before its result exists.
  input.files = [file('b.mid', 'MThd')];
  input.onchange();

  // A returns late, then B.
  first.resolve({ name: 'a.mid', format: 'MIDI', project: { events: [] } });
  second.resolve({ name: 'b.mid', format: 'MIDI', project: { events: [] } });
  await settle(t);

  assert.equal(t.run('workspace.assets.candidate.name'), 'b.mid', 'the newest choice is what is active');
  assert.match(t.node('#message').textContent, /STALE_SOURCE_REQUEST/, 'the discarded result is marked stale, not dropped in silence');
  // A never reached a commit, so it never replaced the source even briefly.
  assert.deepEqual(t.saved.map(record => record.assets.candidate.name), ['b.mid']);
});

test('a MIDI result requested against another project is discarded', async () => {
  const t = intakeController();
  const held = deferred();
  const normal = t.context.workerCall;
  t.context.workerCall = async (action, ...args) => {
    if (action === 'intakeMidi') return held.promise;
    return normal(action, ...args);
  };
  const input = { dataset: { intake: 'candidate' }, value: 'a.mid', files: [file('a.mid', 'MThd')] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  // The user navigated to a different project while the decode was in flight.
  t.run("workspace={id:'OTHER',revision:0,settings:{},assets:{},reviews:{},core3Approvals:[]}");
  held.resolve({ name: 'a.mid', format: 'MIDI', project: { events: [] } });
  await settle(t);
  assert.equal(t.run('workspace.assets.candidate'), undefined);
  assert.match(t.node('#message').textContent, /SOURCE_REQUEST_PROJECT_CHANGED/);
});

test('replacing a MIDI source is one transaction that invalidates the old revision', async () => {
  const t = intakeController();
  const input = { dataset: { intake: 'candidate' }, value: '', files: [file('a.mid', 'MThd')] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  await settle(t);
  const firstRevision = t.run('workspace.revision');
  assert.equal(t.run('workspace.assets.candidate.name'), 'a.mid');

  input.files = [file('b.mid', 'MThd')];
  input.onchange();
  await settle(t);
  assert.equal(t.run('workspace.assets.candidate.name'), 'b.mid');
  assert.ok(t.run('workspace.revision') > firstRevision, 'a replacement is a new source revision');
});

test('a failed MIDI intake leaves the previous source in place', async () => {
  const t = intakeController();
  const input = { dataset: { intake: 'candidate' }, value: '', files: [file('good.mid', 'MThd')] };
  t.collections.set('[data-intake]', [input]); t.run('bind()');
  input.onchange();
  await settle(t);
  assert.equal(t.run('workspace.assets.candidate.name'), 'good.mid');

  const normal = t.context.workerCall;
  t.context.workerCall = async (action, ...args) => {
    if (action === 'intakeMidi') throw Error('missing MThd header chunk');
    return normal(action, ...args);
  };
  input.files = [file('bad.mid', 'MThd')];
  input.onchange();
  await settle(t);
  assert.equal(t.run('workspace.assets.candidate.name'), 'good.mid', 'a failed replacement must not erase the current source');
  assert.match(t.node('#message').textContent, /MThd/);
});
