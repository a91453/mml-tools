import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createTaskQueue } from '../web/task-queue.mjs';

const source = await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

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
    createTaskQueue, createWorkerClient: () => ({ call: (...args) => context.workerCall(...args) }),
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
  const input = { dataset: { intake: 'baseline' }, files: [{ name: 'score.xml', size: 100, text: () => read.promise }] };
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
