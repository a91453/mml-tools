// MCP responses stay bounded for a real-song-sized run, and nothing is lost.
//
// A synthetic project shaped like an exported MIDI: 2,000 role-less notes, every
// note-off one 480-tpq tick before the 1/64 grid, assigned to Melody, Chord1 and
// Chord2 by lane-sized ASSIGN_ROLE decisions (Melody without Lead evidence).
// Under machine-delivery schema @2 every release is held provisionally and every
// Melody note is "Lead unverified", so the machine-delivery ledger a run embeds
// lists 2,000 per-release records, twice. Before server/mcp-compaction.mjs the
// run, decision and Final responses exceeded the 512 KiB MCP result cap although
// the operation had succeeded.
//
// The identity machine delivery is classified under is injected, so this holds
// whichever release the published Manifest names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { F, f } from '../studio/backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalTempoEvent,
  createCanonicalMeterEvent,
  createCanonicalProject,
} from '../studio/backend/canonical/index.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { MACHINE_DELIVERY_SCHEMA_V2 } from '../studio/backend/final/delivery-evaluator.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { RESPONSE_COMPACTION, compactStudioResponse } from '../server/mcp-compaction.mjs';
import { readReportPage } from '../server/report-page.mjs';

const OWNER = 'owner:compaction';
const LIMIT = 128 * 1024;
const SOURCE_ID = 'fixture:third-party-midi';
const TICK = new F(1, 480);
const AT2 = Object.freeze({ canonical_version: '2026-09-23-v3', canonical_status: 'PUBLISHED', rules_snapshot_sha: 'd'.repeat(40), machine_delivery_schema: MACHINE_DELIVERY_SCHEMA_V2 });
const hash = text => createHash('sha256').update(text).digest('hex');

function bulkBaseline(lead = 1000) {
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const early = beat => f(beat).sub(TICK).toString();
  const note = (id, pitch, start, end, voice) => createCanonicalNoteEvent({
    id, pitch, start: String(start), end: String(end), sourceIds: [SOURCE_ID], sourceEventIds: [`${SOURCE_ID}#${id}`],
    role: null, voice, volume: null, metadata: { ticksPerQuarter: 480 },
  });
  const events = [];
  for (let i = 0; i < lead; i += 1) events.push(note(`lead-${i}`, 72 + scale[i % 7], i, early(i + 1), 'lead'));
  for (let i = 0; i < lead / 2; i += 1) events.push(note(`harm-${i}`, 60 + scale[(i * 3) % 7], 2 * i, early(2 * i + 2), 'harm'));
  for (let i = 0; i < lead / 2; i += 1) events.push(note(`bass-${i}`, 43 + scale[(i * 5) % 7], 2 * i, early(2 * i + 1), 'bass'));
  return createCanonicalProject({
    id: 'fixture:bulk-one-tick-early',
    title: 'Bulk one-tick-early releases (synthetic)',
    sources: [createSource({ id: SOURCE_ID, label: 'Synthetic third-party MIDI', kind: 'third-party-midi', authority: 'supporting', sha256: 'c'.repeat(64) })],
    events,
    tempoEvents: [createCanonicalTempoEvent({ id: 'tempo-1', beat: '0', bpm: 150, sourceIds: [SOURCE_ID] })],
    meterEvents: [createCanonicalMeterEvent({ id: 'meter-1', beat: '0', numerator: 4, denominator: 4, sourceIds: [SOURCE_ID] })],
    metadata: {},
  });
}

const ROLE_OF = { lead: 'Melody', harm: 'Chord1', bass: 'Chord2' };
function laneDecisions(project) {
  const decisions = [];
  for (const [prefix, role] of Object.entries(ROLE_OF)) {
    const ids = project.events.filter(event => event.id.startsWith(`${prefix}-`)).map(event => event.id);
    for (let index = 0; index < ids.length; index += 100) {
      decisions.push({
        id: `assign:${role}:${index}`, type: 'ASSIGN_ROLE', target: { eventIds: ids.slice(index, index + 100) }, toRole: role,
        reason: `Fixture: the ${prefix} lane is ${role} material.`, evidence: [`${SOURCE_ID}#${prefix}`],
        // Initial role-less material into Melody without Lead evidence: a
        // review-pending candidate, delivered "Lead unverified" under @2.
        ...(role === 'Melody' ? { leadEvidence: null } : {}),
      });
    }
  }
  return decisions;
}

const CONFIRMATIONS = Object.freeze({
  source_complete: { value: true, reason: 'The synthetic fixture project is the complete material.' },
  player_readback: { value: 'N/A', reason: 'No preview or verification player is used for this synthetic cue.' },
  original_audio_required: { value: false, reason: 'The synthetic workflow has no recording.' },
});

async function applicationUnder(canonical) {
  const engines = await createStudioApplication({}).canonical.engines();
  return createStudioApplication({
    loadEngines: async () => ({
      ...engines,
      final: {
        ...engines.final,
        evaluateProjectReadiness: input => engines.final.evaluateProjectReadiness({ ...input, canonical }),
        emitFinalMml: (project, options = {}) => engines.final.emitFinalMml(project, { ...options, canonical }),
      },
    }),
  });
}

async function rpc(application, name, args) {
  const response = await handleMcp(new Request('https://mml.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { application, owner: OWNER });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.result.isError, false, `${name}: ${JSON.stringify(body.result.structuredContent?.error ?? null).slice(0, 400)}`);
  assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent);
  return { result: body.result.structuredContent, bytes: Buffer.byteLength(text) };
}

const ledgerEntry = (ledger, gate) => ledger.non_blocking_pending.find(entry => entry.gate === gate);

// Page one JSON value through report_page and return its text and hashes.
async function pageAll(application, pointer, { pages = Infinity } = {}) {
  let offset = 0;
  let expected_sha256;
  let text = '';
  let first = null;
  let count = 0;
  do {
    const { result, bytes } = await rpc(application, pointer.tool, { ...pointer.arguments, report_page: { path: pointer.path, offset, ...(expected_sha256 ? { expected_sha256 } : {}) } });
    assert.ok(bytes < LIMIT);
    const page = result.report_page;
    first ??= page;
    expected_sha256 = page.report_sha256;
    text += page.json_fragment;
    offset = page.next_offset;
    count += 1;
  } while (offset !== null && count < pages);
  return { text, complete: offset === null, value_sha256: first.value_sha256, total_units: first.total_units };
}

test('a 2,000-release @2 run: every MCP response stays bounded, summaries point at the full lists, and report_page returns them', async () => {
  const application = await applicationUnder(AT2);
  const baseline = bulkBaseline();
  const project_id = (await application.createProject(OWNER, { title: 'Bulk provisional releases' })).project.project_id;
  const asset = (await application.uploadAsset(OWNER, project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(baseline)) })).asset;
  const decisions = laneDecisions(baseline);
  const sizes = {};

  const started = await rpc(application, 'studio_run_start', { project_id, idempotency_key: 'bulk-run', asset_ids: [asset.asset_id], decisions, accepted_by: 'reviewer:fixture' });
  sizes.run_start = started.bytes;
  const run_id = started.result.run.run_id;
  assert.equal(started.result.run.state, 'awaiting_review');
  const startLedger = ledgerEntry(started.result.run.machine_delivery, 'microTiming');
  assert.equal(startLedger.delivery_flag, 'RELEASES_RENDERED_PROVISIONALLY');
  assert.equal(startLedger.provisional_releases.compacted, true);
  assert.equal(startLedger.provisional_releases.total, 2000);
  assert.deepEqual(startLedger.provisional_releases.report_page, {
    tool: 'studio_run_status', arguments: { project_id, run_id },
    path: ['run', 'machine_delivery', 'non_blocking_pending', String(started.result.run.machine_delivery.non_blocking_pending.indexOf(startLedger)), 'provisional_releases'],
  });

  const resumed = await rpc(application, 'studio_run_resume', { project_id, run_id, confirmations: CONFIRMATIONS });
  sizes.run_resume = resumed.bytes;
  const run = resumed.result.run;
  assert.equal(run.state, 'completed', JSON.stringify(run.blockers));
  assert.ok(run.final_artifact_id);
  assert.deepEqual(run.machine_delivery.delivery_flags, ['RELEASES_RENDERED_PROVISIONALLY', 'LEAD_UNVERIFIED']);

  const status = await rpc(application, 'studio_run_status', { project_id, run_id });
  sizes.run_status = status.bytes;
  const ledger = status.result.run.machine_delivery;
  const releases = ledgerEntry(ledger, 'microTiming').provisional_releases;
  assert.equal(releases.compacted, true);
  assert.equal(releases.truncated, true);
  assert.equal(releases.total, 2000);
  assert.equal(releases.first.length, RESPONSE_COMPACTION.ledgerFirstItems);
  assert.deepEqual(releases.by_role, { Chord1: 500, Chord2: 500, Melody: 1000 });
  assert.equal(releases.report_page.tool, 'studio_run_status');
  const unverified = ledgerEntry(ledger, 'leadPromotion').unverified_lead_event_ids;
  assert.equal(unverified.compacted, true);
  assert.equal(unverified.total, 1000);
  // Per-source figures are small and stay whole.
  assert.deepEqual(ledgerEntry(ledger, 'microTiming').release_offset_sources.map(item => [item.source_id, item.share, item.qualifies]), [[SOURCE_ID, '2000/2000', true]]);
  assert.equal(status.result.response_compaction.schema, RESPONSE_COMPACTION.schema);
  assert.ok(status.result.response_compaction.compacted.some(entry => entry.path.at(-1) === 'provisional_releases' && entry.total === 2000));
  // The resumed run and the status read name the same list.
  assert.equal(ledgerEntry(run.machine_delivery, 'microTiming').provisional_releases.sha256, releases.sha256);

  // report_page returns the whole list, bound to the summary's SHA-256.
  const paged = await pageAll(application, releases.report_page);
  assert.equal(paged.complete, true);
  assert.equal(paged.value_sha256, releases.sha256);
  assert.equal(hash(paged.text), releases.sha256);
  const full = JSON.parse(paged.text);
  assert.equal(full.length, 2000);
  assert.deepEqual(full.slice(0, releases.first.length), releases.first);
  assert.ok(full.every(item => item.representation === 'EXTEND_TO_NEXT_GRID' && f(item.rendered_release).sub(item.release).cmp(TICK) === 0));

  // The stored run is complete: the service (and HTTP) still returns every record.
  const stored = (await application.getRun(OWNER, project_id, run_id)).run.machine_delivery;
  assert.deepEqual(ledgerEntry(stored, 'microTiming').provisional_releases, full);
  assert.equal(ledgerEntry(stored, 'leadPromotion').unverified_lead_event_ids.length, 1000);

  const next = await rpc(application, 'studio_run_next', { project_id, run_id });
  sizes.run_next = next.bytes;

  // A decision set over 2,000 events answers with ids, counts and digests; its
  // event-level diff is the new candidate's review lineage, named exactly.
  const applied = await rpc(application, 'studio_decisions_apply', { project_id, decisions, accepted_by: 'reviewer:fixture' });
  sizes.decisions_apply = applied.bytes;
  assert.equal(applied.result.operation, 'succeeded');
  assert.equal(applied.result.decisions.decision_count, decisions.length);
  const roleMoved = applied.result.decisions.diff_from_baseline.notes.roleMoved;
  assert.equal(roleMoved.compacted, true);
  assert.equal(roleMoved.total, 2000);
  assert.deepEqual(roleMoved.report_page, {
    tool: 'studio_candidate_review', arguments: { project_id, candidate_id: applied.result.decisions.candidate_id },
    path: ['review', 'lineage', 'sourceToCandidate', 'notes', 'roleMoved'],
  });
  const firstPage = await pageAll(application, roleMoved.report_page, { pages: 1 });
  assert.equal(firstPage.value_sha256, roleMoved.sha256, 'the pointer addresses exactly the omitted list');

  const artifact = await rpc(application, 'studio_artifact_get', { artifact_id: run.final_artifact_id });
  sizes.artifact_get = artifact.bytes;
  const renderings = artifact.result.artifact.provisional_release_rendering.renderings;
  assert.equal(renderings.compacted, true);
  assert.equal(renderings.total, 2000);
  assert.equal(renderings.report_page.tool, 'studio_artifact_get');

  const finalized = await rpc(application, 'studio_finalize', { project_id, candidate_id: run.candidate_id });
  sizes.finalize = finalized.bytes;
  assert.equal(finalized.result.operation, 'succeeded');
  const finalRenderings = finalized.result.provisional_release_rendering.renderings;
  assert.deepEqual(finalRenderings.report_page, { tool: 'studio_artifact_get', arguments: { artifact_id: finalized.result.artifact_id }, path: ['artifact', 'provisional_release_rendering', 'renderings'] });
  assert.equal((await pageAll(application, finalRenderings.report_page, { pages: 1 })).value_sha256, finalRenderings.sha256);

  const reviewed = await rpc(application, 'studio_candidate_review', { project_id, candidate_id: run.candidate_id });
  sizes.candidate_review = reviewed.bytes;

  for (const [name, bytes] of Object.entries(sizes)) assert.ok(bytes < LIMIT, `${name}: ${bytes} bytes`);
});

test('the bounded view leaves ordinary responses exactly as they were, and never cuts a string', () => {
  const small = { operation: 'succeeded', run: { steps: Array.from({ length: 40 }, (_, index) => ({ step: `s${index}` })) } };
  assert.equal(compactStudioResponse('studio_run_status', { project_id: 'p', run_id: 'r' }, small), small, 'under budget: the same object');
  const text = { operation: 'succeeded', diagnostics: 'x'.repeat(600_000) };
  assert.equal(compactStudioResponse('studio_run_start', {}, text), text, 'a long string is not a list');
  // A bulk source read keeps its documented report_page contract.
  const rows = { suggestion: { rows: Array.from({ length: 5000 }, (_, index) => ({ event_id: `e${index}`, evidence: 'y'.repeat(40) })) } };
  assert.equal(compactStudioResponse('studio_arrangement_suggest', { project_id: 'p' }, rows), rows);
  // A ledger's per-release lists are always summarized, so their shape is stable.
  const ledger = { machine_delivery: { schema: MACHINE_DELIVERY_SCHEMA_V2, blocking: [], post_delivery: [],
    non_blocking_pending: [{ gate: 'microTiming', provisional_releases: [{ event_id: 'a', role: 'Melody' }] }],
    unresolved_evidence_ledger: [{ gate: 'microTiming', provisional_releases: [{ event_id: 'a', role: 'Melody' }] }] } };
  const view = compactStudioResponse('studio_run_status', { project_id: 'p', run_id: 'r' }, ledger);
  const summary = view.machine_delivery.non_blocking_pending[0].provisional_releases;
  assert.deepEqual([summary.compacted, summary.truncated, summary.total, summary.by_role], [true, false, 1, { Melody: 1 }]);
  assert.equal(summary.sha256, hash(JSON.stringify(ledger.machine_delivery.non_blocking_pending[0].provisional_releases)));
  assert.equal(ledger.machine_delivery.non_blocking_pending[0].provisional_releases.length, 1, 'the service result is never modified');
});

test('clients are told never to retry a succeeded call whose response was too large, and to read with report_page', async () => {
  const application = createStudioApplication({});
  const initialize = await handleMcp(new Request('https://mml.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't', version: '1' }, capabilities: {} } }),
  }), { application, owner: OWNER });
  const { instructions } = (await initialize.json()).result;
  assert.match(instructions, /operation_returned: true .*never retry it/);
  assert.match(instructions, /report_page/);
  for (const name of ['studio_run_start', 'studio_run_resume', 'studio_run_status', 'studio_decisions_apply', 'studio_final_reduction_apply', 'studio_finalize']) {
    const { description } = STUDIO_MCP_TOOLS.find(tool => tool.name === name);
    assert.match(description, /never retry it/, name);
    assert.match(description, /report_page/, name);
  }

  const project_id = (await application.createProject(OWNER, { title: 'Oversized' })).project.project_id;
  const oversized = { ...application, startRun: async (...args) => ({ ...(await application.startRun(...args)), diagnostics: 'x'.repeat(600_000) }) };
  const response = await handleMcp(new Request('https://mml.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_run_start', arguments: { project_id, idempotency_key: 'too-large' } } }),
  }), { application: oversized, owner: OWNER });
  const { error } = (await response.json()).result.structuredContent;
  assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(error.details.operation, 'succeeded');
  assert.match(error.details.recovery_notice, /already taken effect, so never retry it/);
});

// A ledger phase list holds the per-release lists step 1 always summarizes.
// When the response is still over budget, the size pass summarizes the phase
// list too, and its summary used to describe the half-compacted view: its
// sha256 was not report_page's value_sha256, and response_compaction still
// listed the inner paths the outer summary had replaced. Observed live on
// studio_artifact_get for a delivered Final.
test('a list summarized around earlier summaries describes the stored list, and every listed path is in the view', () => {
  const releases = count => Array.from({ length: count }, (_, index) => ({
    event_id: `midi:sha256:${'a'.repeat(64)}:note:0:${index}`, role: 'Melody', release: `${index}/480`, rendered_release: `${index}`, representation: 'EXTEND_TO_NEXT_GRID',
  }));
  const entry = gate => ({ gate, classification: 'NON_BLOCKING_PENDING', status: 'PENDING', blockers: [`X_${gate}`], provisional_releases: releases(300) });
  const ledger = () => ({
    schema: 'mabinogi-mobile-mml-studio/machine-delivery@2',
    blocking: [],
    non_blocking_pending: [...'abcdefg'].map(entry),
    post_delivery: [],
    unresolved_evidence_ledger: [...'abcdefghi'].map(entry),
  });
  const result = { operation: 'succeeded', artifact: {
    readiness_summary: { machine_delivery: ledger() }, machine_delivery: ledger(), run: { machine_delivery: ledger() },
    bulk: releases(1500).map(item => ({ ...item, note: 'x'.repeat(40) })),
  } };
  const view = compactStudioResponse('studio_artifact_get', { artifact_id: `art_${'b'.repeat(64)}` }, result);
  const listed = view.response_compaction.compacted;
  assert.ok(listed.some(item => item.path.at(-1) === 'unresolved_evidence_ledger' || item.path.at(-1) === 'non_blocking_pending'),
    'the fixture needs the size pass to summarize a ledger phase list');
  for (const { path, total } of listed) {
    let node = view;
    for (const key of path) {
      assert.ok(node !== null && typeof node === 'object' && key in node, `listed path ${path.join('.')} is in the view`);
      node = node[key];
    }
    assert.equal(node.compacted, true, path.join('.'));
    let stored = result;
    for (const key of path) stored = stored[key];
    assert.equal(total, stored.length, path.join('.'));
    assert.equal(node.total, stored.length, path.join('.'));
    assert.equal(node.sha256, hash(JSON.stringify(stored)), `${path.join('.')} sha256 is the stored list's`);
    const page = readReportPage(result, { path: node.report_page.path, offset: 0, length: 16000 });
    assert.equal(page.report_page.value_sha256, node.sha256, `${path.join('.')} sha256 is report_page's value_sha256`);
    for (const [index, item] of node.first.entries()) assert.deepEqual(item, stored[index], `${path.join('.')} first[${index}] is the stored item`);
  }
});
