import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as model from '../web/model.mjs';
import { MIDI_SOURCE_ID_PREFIX, midiSourceId } from '../web/midi-source.mjs';
import { createTaskQueue } from '../web/task-queue.mjs';
import { createSourceRequestLedger } from '../web/source-requests.mjs';
import { createBankChoices, sameBank } from '../web/preview/bank-choices.mjs';
import { mergeCanonicalProjects } from '../backend/canonical/merge.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// Deterministic Canonical identity for Raw MIDI.
//
// A source identity is provenance: recorded evidence, arbitration decisions and
// the micro-timing gate all bind to source ids and to the event ids derived
// from them. If picking the same file twice produces two identities, none of
// those bindings survive a re-pick, an app restart or a backup round trip --
// and nothing downstream can tell that it is the same file.
//
// The defect these cover was invisible to the suites that already existed
// because every one of them handed `intakeMidi` a fixed id of its own, so the
// production path's random UUID was never exercised. Everything below therefore
// drives the real path and derives its expectations from the bytes; no test in
// this file may pass an id, and none can, because the parameter is gone.

const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const expectedSourceId = bytes => `${MIDI_SOURCE_ID_PREFIX}${digest(bytes)}`;

// Every identity a Canonical consumer can bind to, in one comparable shape.
const identityOf = asset => ({
  sourceId: asset.source.id,
  canonicalSourceIds: asset.project.sources.map(source => source.id),
  projectId: asset.project.id,
  noteEventIds: asset.project.events.map(event => event.id),
  tempoEventIds: asset.project.tempoEvents.map(event => event.id),
  meterEventIds: asset.project.meterEvents.map(event => event.id),
  sourceEventIds: asset.project.events.map(event => [...event.sourceEventIds]),
  eventSourceIds: asset.project.events.map(event => [...event.sourceIds]),
});

// ─── the real production intake path ────────────────────────────────────────

// app.mjs's own handlers, wired to the real model through the same action
// allowlist studio/web/worker.mjs uses. Only the DOM, storage and the Worker
// transport are doubled: the routing, the request ledger, the replacement
// transaction, the decode and the Canonical construction are all production
// code. Calling intakeMidi directly is what hid this defect, so nothing here
// calls it directly.
const WORKER_ACTIONS = ['newWorkspace', 'intake', 'intakeMidi', 'analyzeWorkspace', 'invalidate', 'importWorkspace', 'recordReview', 'recordAcceptance'];
const appSource = await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8');

function studio({ intercept = null } = {}) {
  const nodes = new Map(), collections = new Map(), stored = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', setAttribute() {}, set innerHTML(_) {} });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: selector => collections.get(selector) ?? [] },
    createTaskQueue, createSourceRequestLedger, createBankChoices, sameBank,
    createWorkerClient: () => ({ call: (...args) => context.workerCall(...args) }),
    Worker: function () {}, URL, structuredClone, crypto, TextEncoder, TextDecoder, btoa, atob,
    FormData: class { constructor(form) { return Object.entries(form.fields); } },
    setTimeout: () => 0, clearTimeout() {}, navigator: {},
    listProjects: async () => [...stored.values()],
    listProjectSummaries: async () => [...stored.values()].map(({ id, title, savedAt, revision }) => ({ id, title, savedAt, revision })),
    loadProject: async id => stored.get(id),
    storageHealth: async () => ({ usage: null, quota: null, persisted: null }),
    saveProject: async workspace => { const saved = { ...workspace, savedAt: 'saved' }; stored.set(workspace.id, saved); return saved; },
    render() {},
  });
  const run = code => vm.runInContext(code.replaceAll('import.meta.url', JSON.stringify(import.meta.url)), context);
  run(appSource.slice(appSource.indexOf('const $'), appSource.indexOf('const input =')));
  run(appSource.slice(appSource.indexOf('async function putSource'), appSource.indexOf('async function copyText')));
  run(appSource.slice(appSource.indexOf('function bind()'), appSource.indexOf("$('#new-project').onclick=")));
  context.workerCall = async (action, ...args) => {
    if (intercept) { const held = await intercept(action, args); if (held !== undefined) return held; }
    if (!WORKER_ACTIONS.includes(action)) throw Error('UNSUPPORTED: worker action');
    return model[action](...args);
  };
  run("identity={metadata:{fixture:1}}");
  return { run, node, collections, context, stored };
}

const bytesFile = (name, bytes) => ({
  name,
  size: bytes.length,
  slice: (start, end) => ({ arrayBuffer: async () => Uint8Array.from(bytes).slice(start, end).buffer }),
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  text: async () => { throw Error('the MIDI path must never read a source as text'); },
});

const settle = async harness => { while (harness.run('busy')) await new Promise(resolve => setImmediate(resolve)); };

// Picks files through the real change handler and returns the resulting assets.
async function pickThrough(harness, picks) {
  const input = { dataset: { intake: 'candidate' }, value: '', files: [] };
  harness.collections.set('[data-intake]', [input]);
  harness.run('bind()');
  const applied = [];
  for (const [name, bytes] of picks) {
    input.files = [bytesFile(name, bytes)];
    input.onchange();
    await settle(harness);
    applied.push(harness.run('workspace.assets.candidate'));
  }
  return applied;
}

const freshWorkspace = harness => harness.run('workspace');

function newStudio(options) {
  const harness = studio(options);
  harness.context.seed = model.newWorkspace();
  harness.run('workspace=seed');
  return harness;
}

// ─── A. the same bytes, picked twice through the real path ──────────────────

test('A: re-picking one file through the real intake path reproduces every identity', async () => {
  const bytes = fixtures.format1();
  const harness = newStudio();
  const [first, second] = await pickThrough(harness, [['song.mid', bytes], ['song.mid', bytes]]);

  assert.equal(first.source.sha256, digest(bytes));
  assert.equal(first.source.id, expectedSourceId(bytes));
  // The identity is the digest and nothing else: no UUID, no slot, no revision,
  // no timestamp anywhere in it.
  assert.match(first.source.id, /^midi:sha256:[a-f0-9]{64}$/);
  assert.equal(first.source.id.includes('candidate'), false);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(first.source.id), false, 'no UUID may appear in a source identity');

  assert.deepEqual(identityOf(second), identityOf(first));
  // And the whole Canonical project, byte for byte.
  assert.equal(JSON.stringify(second.project), JSON.stringify(first.project));
  assert.ok(first.project.events.length > 0 && first.project.tempoEvents.length > 0);
  for (const event of first.project.events) assert.ok(event.id.startsWith(`${first.source.id}:note:`));
});

test('A: every identity derived from the source survives a re-pick too', async () => {
  const bytes = fixtures.sixSourceVoices();
  const harness = newStudio();
  const [first, second] = await pickThrough(harness, [['six.mid', bytes], ['six.mid', bytes]]);

  const report = one => model.analyzeWorkspace({ ...model.newWorkspace(), assets: { candidate: one } }).rawMidi[0];
  const a = report(first), b = report(second);
  assert.equal(a.integrity.verified, true);
  assert.equal(JSON.stringify(b.arrangement.derivation), JSON.stringify(a.arrangement.derivation));
  assert.equal(JSON.stringify(b.arrangement.voiceSplit), JSON.stringify(a.arrangement.voiceSplit));
  assert.equal(JSON.stringify(b.arrangement.candidate.lanes), JSON.stringify(a.arrangement.candidate.lanes));
  assert.equal(JSON.stringify(b.arrangement.candidate.ledger), JSON.stringify(a.arrangement.candidate.ledger));
  assert.equal(b.arrangement.derivation.eventIdDigest, a.arrangement.derivation.eventIdDigest);
});

// ─── B. export and re-import ────────────────────────────────────────────────

test('B: a backup round trip reproduces the source, project and event identities', async () => {
  const bytes = fixtures.format1();
  const harness = newStudio();
  const [picked] = await pickThrough(harness, [['song.mid', bytes]]);
  const before = identityOf(picked);

  // Exactly what #export-project writes and #restore-project reads.
  const backup = JSON.stringify({ ...freshWorkspace(harness), canonical: { canonical_version: '2026-09-13-v1' } });
  const restored = model.importWorkspace(backup);
  const after = restored.assets.candidate;

  assert.deepEqual(identityOf(after), before);
  assert.equal(after.source.id, expectedSourceId(bytes));
  // The slot it lands in is not part of the identity.
  assert.equal(after.source.id.includes('import'), false);

  // A backup restored into a different slot is still the same source.
  const moved = JSON.parse(backup);
  moved.assets = { baseline: moved.assets.candidate };
  assert.deepEqual(identityOf(model.importWorkspace(JSON.stringify(moved)).assets.baseline), before);
});

// ─── C / D. bytes decide, filenames do not ──────────────────────────────────

test('C: the same filename with different bytes is a different Canonical source', () => {
  const first = model.intakeMidi({ name: 'song.mid', bytes: fixtures.format0() });
  const second = model.intakeMidi({ name: 'song.mid', bytes: fixtures.format1() });

  assert.equal(first.name, second.name);
  assert.notEqual(first.source.sha256, second.source.sha256);
  assert.notEqual(first.source.id, second.source.id);
  assert.notEqual(first.project.id, second.project.id);
  assert.equal(first.project.events.some(event => second.project.events.some(other => other.id === event.id)), false,
    'no event id may be shared between two different sources');
});

test('D: the same bytes under a different filename are the same Canonical source', () => {
  const bytes = fixtures.format1();
  const first = model.intakeMidi({ name: 'original.mid', bytes });
  const renamed = model.intakeMidi({ name: 'a copy (2).mid', bytes });

  assert.notEqual(first.name, renamed.name);
  assert.deepEqual(identityOf(renamed), identityOf(first));

  // Display metadata is free to differ -- it just is not provenance.
  assert.equal(renamed.name, 'a copy (2).mid');
  assert.equal(renamed.project.sources[0].label, 'a copy (2).mid');
  assert.equal(first.project.sources[0].label, 'original.mid');
  assert.equal(renamed.project.title, first.project.title, 'this file names itself from a track title, not the filename');

  // A different authority claim changes the source record, not the identity.
  const official = model.intakeMidi({ name: 'official.mid', bytes, authority: 'primary-symbolic' });
  assert.equal(official.source.id, first.source.id);
  assert.equal(official.source.kind, 'official-midi');
  assert.equal(first.source.kind, 'third-party-midi');
});

test('D: a file whose title comes from its own bytes keeps that title when renamed', () => {
  const bytes = fixtures.format0();
  const a = model.intakeMidi({ name: 'one.mid', bytes });
  const b = model.intakeMidi({ name: 'two.mid', bytes });
  assert.equal(a.project.title, 'Single track');
  assert.equal(b.project.title, a.project.title);
  assert.equal(b.project.id, a.project.id);
});

// ─── E. the request token stays ephemeral ───────────────────────────────────

test('E: a stale in-flight pick still cannot overwrite the newer one', async () => {
  const held = new Map();
  const harness = newStudio({
    intercept: (action, args) => {
      if (action !== 'intakeMidi') return undefined;
      const name = args[0].name;
      if (!held.has(name)) return undefined;
      return held.get(name).promise;
    },
  });
  for (const name of ['a.mid', 'b.mid']) {
    let resolve; const promise = new Promise(r => { resolve = r; });
    held.set(name, { promise, resolve });
  }

  const input = { dataset: { intake: 'candidate' }, value: '', files: [] };
  harness.collections.set('[data-intake]', [input]);
  harness.run('bind()');

  input.files = [bytesFile('a.mid', fixtures.format0())];
  input.onchange();
  // B is chosen while A is still decoding.
  input.files = [bytesFile('b.mid', fixtures.format1())];
  input.onchange();

  held.get('a.mid').resolve(model.intakeMidi({ name: 'a.mid', bytes: fixtures.format0() }));
  held.get('b.mid').resolve(model.intakeMidi({ name: 'b.mid', bytes: fixtures.format1() }));
  await settle(harness);

  assert.equal(harness.run('workspace.assets.candidate.name'), 'b.mid');
  assert.equal(harness.run('workspace.assets.candidate.source.id'), expectedSourceId(fixtures.format1()));
  assert.match(harness.node('#message').textContent, /STALE_SOURCE_REQUEST/);
  assert.deepEqual([...harness.stored.values()].map(record => record.assets.candidate.name), ['b.mid']);
});

test('E: the request token is ephemeral and is not the content hash', () => {
  const ledger = createSourceRequestLedger();
  const first = ledger.begin('candidate', { projectId: 'p1' });
  const second = ledger.begin('candidate', { projectId: 'p1' });

  // Two picks of the very same file are two requests. A content-derived token
  // would make the second pick look like the first and defeat the suppression
  // the ledger exists for.
  assert.notDeepEqual(first, second);
  assert.equal(typeof first.sequence, 'number');
  for (const token of [first, second]) {
    assert.equal(JSON.stringify(token).includes(MIDI_SOURCE_ID_PREFIX), false, 'a request token must not carry a source identity');
    assert.equal('sha256' in token, false);
  }
  assert.equal(ledger.evaluate(first, { projectId: 'p1' }).accepted, false);
  assert.equal(ledger.evaluate(second, { projectId: 'p1' }).accepted, true);
});

// ─── F. import tampering stays fail-closed ──────────────────────────────────

test('F: a backup whose bytes disagree with its recorded identity is still refused', () => {
  const workspace = model.newWorkspace();
  workspace.assets.candidate = model.intakeMidi({ name: 'song.mid', bytes: fixtures.format1() });
  const backup = JSON.stringify(workspace);

  const tampered = JSON.parse(backup);
  tampered.assets.candidate.source.bytesBase64 = Buffer.from(fixtures.format0()).toString('base64');
  assert.throws(() => model.importWorkspace(JSON.stringify(tampered)), /SOURCE_DIGEST_MISMATCH/);

  // An edited project is rebuilt from the bytes, and gets the bytes' identity.
  const edited = JSON.parse(backup);
  edited.assets.candidate.project.events = [];
  edited.assets.candidate.source.id = 'attacker-chosen-identity';
  const rebuilt = model.importWorkspace(JSON.stringify(edited)).assets.candidate;
  assert.equal(rebuilt.source.id, expectedSourceId(fixtures.format1()));
  assert.deepEqual(identityOf(rebuilt), identityOf(workspace.assets.candidate));

  // A stored arrangement from the old record is not carried across either.
  assert.equal(rebuilt.arrangement, undefined);
});

// ─── the identity helper itself ─────────────────────────────────────────────

test('the content identity is a pure function of the digest', () => {
  assert.equal(midiSourceId('a'.repeat(64)), `${MIDI_SOURCE_ID_PREFIX}${'a'.repeat(64)}`);
  // Full digest, not a prefix: a truncation would be a weaker identity than the
  // one the source record already carries.
  const bytes = fixtures.format1();
  assert.equal(midiSourceId(digest(bytes)).slice(MIDI_SOURCE_ID_PREFIX.length).length, 64);
  assert.equal(model.intakeMidi({ name: 'x.mid', bytes }).source.id, midiSourceId(digest(bytes)));
});

test('no Raw MIDI entry point accepts a caller-supplied identity', () => {
  const bytes = fixtures.format1();
  // The parameter does not exist, so an id offered by a caller is inert rather
  // than authoritative -- there is no path by which one reaches provenance.
  const offered = model.intakeMidi({ name: 'x.mid', bytes, id: 'caller-chosen', sourceId: 'caller-chosen' });
  assert.equal(offered.source.id, expectedSourceId(bytes));
  assert.equal(String(model.intakeMidi.length), '1', 'intakeMidi takes one options object');
});

// ─── what a content-derived id means downstream ─────────────────────────────

test('two slots holding the same bytes are one source, and analyse without error', () => {
  const bytes = fixtures.format1();
  const workspace = {
    ...model.newWorkspace(),
    title: 'fixture',
    settings: { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' },
    assets: {
      candidate: model.intakeMidi({ name: 'candidate.mid', bytes }),
      baseline: model.intakeMidi({ name: 'baseline.mid', bytes }),
    },
  };
  // Same bytes really are the same source, and now say so.
  assert.equal(workspace.assets.baseline.source.id, workspace.assets.candidate.source.id);
  assert.equal(workspace.assets.baseline.project.id, workspace.assets.candidate.project.id);

  const report = model.analyzeWorkspace(workspace);
  assert.equal(report.rawMidi.length, 2);
  assert.ok(report.rawMidi.every(entry => entry.integrity.verified), 'both slots verify against their own bytes');
  assert.equal(report.gates.rawMidiSource.status, 'PASS');
  // Diffing a file against itself is zero drift, which is true -- and grants
  // nothing: the gates still require their reviews.
  assert.equal(report.lineage.sourceToCandidate.summary.noteAdded, 0);
  assert.equal(report.lineage.sourceToCandidate.summary.noteRemoved, 0);
  assert.equal(report.gates.source.status, 'PENDING');
  assert.equal(report.gates.versionDrift.status, 'PENDING');
  assert.equal(report.state, 'CANDIDATE');
});

test('merging content-equal sources dedupes, and a label disagreement fails closed', () => {
  const bytes = fixtures.format1();
  const first = model.intakeMidi({ name: 'song.mid', bytes });
  const same = model.intakeMidi({ name: 'song.mid', bytes });
  const renamed = model.intakeMidi({ name: 'renamed.mid', bytes });

  // One source, its events deduped by identity rather than doubled.
  const merged = mergeCanonicalProjects([first.project, same.project], { id: 'merged', title: 'merged' });
  assert.equal(merged.sources.length, 1);
  assert.equal(merged.events.length, first.project.events.length);
  assert.equal(merged.metadata.sourceComplete, true);

  // The merge's own identity check includes the source label, so the same bytes
  // under two filenames are refused rather than silently reconciled. That is
  // fail-closed, not laundering, and it is left as the merge's decision: this
  // integration has no merge caller, so nothing here depends on either outcome.
  assert.throws(() => mergeCanonicalProjects([first.project, renamed.project], { id: 'merged', title: 'merged' }),
    /conflicting duplicate source id/);
});
