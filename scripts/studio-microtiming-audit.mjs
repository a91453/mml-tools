// Local, read-only micro-timing audit of a production candidate.
// Implementation notes, not Canonical policy.
//
// Rebuilds the candidate from service read exports — `studio_baseline_events`
// pages (exact event ids, pitch and timing) and the applied arrangement_decision
// proposal (`studio_proposal_status`) — through the unchanged Canonical IR intake,
// arrangement suggestion and decision application, in an ISOLATED throwaway
// store. It then:
//
//   1. re-runs the Published-v1 micro-timing gate and prints the SHA-256 of its
//      JSON value, so it can be compared with the service's report_page
//      `value_sha256` for review.readiness.gates.microTiming;
//   2. describes every sub-grid interval and every off-grid release boundary
//      (counts, histograms, sampled identities — never the full note list);
//   3. evaluates the UNPUBLISHED release-regrid candidate on the reproduction,
//      clearly labelled as candidate-only.
//
// No network, no service write, no source bytes read or written. The Canonical IR
// rebuilt here carries no tempo map and no per-event MIDI metadata, so only
// timing/pitch/role facts are reproduced; the full candidate review is not.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { createStore } from '../studio/backend/application/store.mjs';
import { f } from '../studio/backend/mml/index.mjs';
import { SAFE_GRID } from '../studio/backend/canonical/micro-timing.mjs';
import { applyReleaseRegridCandidate } from '../studio/backend/canonical/release-regrid-candidate.mjs';
import { analyzeProjectMicroTiming } from '../studio/backend/canonical/micro-timing.mjs';
import { enforceMicroGaps } from '../studio/backend/final/micro-gap-enforcement.mjs';

const HELP = `Local micro-timing audit (no network, no service write)
  node scripts/studio-microtiming-audit.mjs --work-dir NEW_DIR --events page1.json[,page2.json...]
       --decisions proposal.json [--expect-microtiming-sha256 HEX] [--out receipt.json]
`;
const OWNER = 'local:microtiming-audit';
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const onGrid = value => f(value).div(SAFE_GRID).d === 1n;
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const sorted = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const shortId = id => id.split(':').slice(-2).join(':');

export function loadBaselineEvents(paths) {
  const byId = new Map();
  let total = null;
  for (const path of paths) {
    const page = readJson(path);
    total ??= page.total ?? null;
    for (const event of page.events ?? []) byId.set(event.event_id, event);
  }
  const events = [...byId.values()];
  if (total !== null && events.length !== total) throw Error(`baseline export incomplete: ${events.length} of ${total} events`);
  return events;
}

function canonicalProjectFromExport(events) {
  const sources = [...new Set(events.flatMap(event => event.source_ids))].sort().map(id => ({
    id, label: 'exported source identity', kind: 'third-party-midi', authority: 'supporting',
    sha256: /^midi:sha256:([0-9a-f]{64})$/.exec(id)?.[1] ?? null, metadata: {},
  }));
  const projectId = sources.length === 1 ? `${sources[0].id}-project` : 'exported-baseline-project';
  return {
    schema: 'mabinogi-mobile-mml-studio/canonical-project@2', id: projectId, title: 'micro-timing audit reconstruction',
    sources,
    events: events.map(event => ({
      kind: event.kind, id: event.event_id, pitch: event.pitch, start: event.start, end: event.end,
      sourceIds: event.source_ids, sourceEventIds: event.source_event_ids, role: event.role, voice: event.voice,
      tags: ['source-faithful'], metadata: {},
    })),
    tempoEvents: [], meterEvents: [], decisions: [], metadata: {},
  };
}

function describeBoundaries(candidate) {
  const byRole = {};
  for (const event of candidate.events) if (event.kind === 'note') (byRole[event.role] ??= []).push(event);
  const boundaries = {};
  for (const [role, list] of Object.entries(byRole)) {
    const segments = [];
    for (const event of [...list].sort((a, b) => f(a.start).cmp(b.start))) {
      const last = segments.at(-1);
      if (!last || f(event.start).cmp(last.end) > 0) segments.push({ start: f(event.start), end: f(event.end) });
      else if (f(event.end).cmp(last.end) > 0) last.end = f(event.end);
    }
    const entry = { segments: segments.length, subGridGap: 0, restAtLeastGrid: 0, roleEnd: 0, offGridSegmentEnds: 0, restLengthsTicks: {} };
    segments.forEach((segment, index) => {
      if (!onGrid(segment.end)) entry.offGridSegmentEnds += 1;
      const next = segments[index + 1];
      if (!next) { entry.roleEnd += 1; return; }
      const gap = next.start.sub(segment.end);
      if (gap.cmp(SAFE_GRID) < 0) entry.subGridGap += 1;
      else { entry.restAtLeastGrid += 1; bump(entry.restLengthsTicks, gap.mul(480).toString()); }
    });
    entry.restLengthsTicks = sorted(entry.restLengthsTicks);
    boundaries[role] = entry;
  }
  return sorted(boundaries);
}

/**
 * Rebuild a candidate from service read exports in an isolated throwaway store.
 * Shared by the micro-timing audit and the Lead review queue.
 */
export async function reconstructFromExports({ workDir, eventPaths, decisionsPath, owner = OWNER }) {
  if (existsSync(workDir)) throw Error(`${workDir} already exists; use a new isolated directory.`);
  mkdirSync(workDir, { recursive: true });
  const events = loadBaselineEvents(eventPaths);
  const proposalFile = readJson(decisionsPath);
  const proposal = proposalFile.proposal ?? proposalFile;
  const app = createStudioApplication({ dataDirectory: join(workDir, 'store'), durability: 'persistent' });
  const { project } = await app.createProject(owner, { title: 'isolated reconstruction from read exports' });
  const exported = canonicalProjectFromExport(events);
  const upload = await app.uploadAsset(owner, project.project_id, { kind: 'canonical_project', filename: 'baseline.json', bytes: Buffer.from(JSON.stringify(exported)), mediaType: 'application/json' });
  await app.analyzeSources(owner, project.project_id, { assetIds: [(upload.asset ?? upload).asset_id], meterText: '' });
  await app.suggestArrangement(owner, project.project_id, {});
  const applied = await app.applyDecisions(owner, project.project_id, { decisions: proposal.action.decisions, acceptedBy: proposal.resolution?.accepted_by ?? null });
  const candidateId = applied.decisions?.candidate_id;
  if (!candidateId) throw Error('decision application produced no candidate');
  const store = createStore({ directory: join(workDir, 'store'), durability: 'persistent' });
  const candidate = store.getJson(`application:${project.project_id}:${candidateId}`).candidate;
  return { app, owner, projectId: project.project_id, candidateId, candidate, store, events, proposal };
}

export async function auditMicroTiming({ workDir, eventPaths, decisionsPath }) {
  const { app, projectId, candidateId, candidate, events, proposal } = await reconstructFromExports({ workDir, eventPaths, decisionsPath });
  const review = await app.reviewCandidate(OWNER, projectId, { candidateId });
  const gate = review.review.readiness.gates.microTiming;
  const gateText = JSON.stringify(gate);
  const unknownText = JSON.stringify(gate.unknownIntervals);

  const byId = new Map(candidate.events.map(event => [event.id, event]));
  const shape = { intervalTypes: {}, lengths: {}, rolePairs: {}, previousDurationTicks: {}, nextOnsetOnSafeGrid: 0, previousNominalOnSafeGrid: 0, samePitch: 0, crossVoice: 0, byPositionDecile: {} };
  const lastBeat = candidate.events.reduce((max, event) => (f(event.end).cmp(max) > 0 ? f(event.end) : max), f(0));
  const samples = {};
  for (const interval of gate.unknownIntervals) {
    const identity = interval.identity;
    const previous = byId.get(identity.previousEventId);
    const next = byId.get(identity.nextEventId);
    bump(shape.intervalTypes, identity.type);
    bump(shape.lengths, identity.length);
    bump(shape.rolePairs, `${previous.role}->${next.role}`);
    bump(shape.previousDurationTicks, f(previous.end).sub(previous.start).mul(480).toString());
    if (onGrid(next.start)) shape.nextOnsetOnSafeGrid += 1;
    if (onGrid(f(previous.end).sub(previous.start).add(identity.length))) shape.previousNominalOnSafeGrid += 1;
    if (previous.pitch === next.pitch) shape.samePitch += 1;
    if (previous.voice !== next.voice) shape.crossVoice += 1;
    const decile = Math.min(9, Number((f(identity.start).div(lastBeat).mul(10).n) / f(identity.start).div(lastBeat).mul(10).d));
    bump(shape.byPositionDecile, String(decile));
    const bucket = `decile${decile}:${previous.role}`;
    if (!samples[bucket]) samples[bucket] = { previous: shortId(previous.id), next: shortId(next.id), gapStart: identity.start, length: identity.length, samePitch: previous.pitch === next.pitch };
  }
  const notes = candidate.events.filter(event => event.kind === 'note');
  const onsetsOnGrid = notes.filter(event => onGrid(event.start)).length;
  const releasesOnGrid = notes.filter(event => onGrid(event.end)).length;
  const releasesOneTickEarly = notes.filter(event => !onGrid(event.end) && onGrid(f(event.end).add(f('1/480')))).length;

  const regrid = applyReleaseRegridCandidate(candidate);
  const effects = {};
  for (const plan of regrid.plans) bump(effects, plan.effect);
  const refusals = {};
  for (const refusal of regrid.refusals) bump(refusals, refusal.reason);
  const afterTiming = regrid.project ? analyzeProjectMicroTiming(regrid.project) : null;
  const afterEnforcement = regrid.project ? enforceMicroGaps(regrid.project) : null;

  return {
    schema: 'mml-studio/local-microtiming-audit@1',
    notice: 'Isolated local reproduction from service read exports. Not a native backup, not a gate result, not reviewer evidence. Candidate section is an UNPUBLISHED CANONICAL CANDIDATE evaluation only.',
    exports: { baseline_event_count: events.length, baseline_events_sha256: sha(JSON.stringify([...events].sort((a, b) => (a.event_id < b.event_id ? -1 : 1)))), decision_count: proposal.action.decisions.length, decisions_sha256: sha(JSON.stringify(proposal.action.decisions)) },
    reproduction: { local_candidate_id: candidateId, microtiming_gate_value_sha256: sha(gateText), microtiming_gate_utf16_units: gateText.length, unknown_intervals_value_sha256: sha(unknownText), unknown_intervals_utf16_units: unknownText.length, status: gate.status, blockers: gate.blockers, candidateCount: gate.candidateCount, unknownCount: gate.unknownCount, technicalResidueCount: gate.technicalResidueCount, sourceSupportedCount: gate.sourceSupportedCount, unresolvedStreamIssueCount: gate.unresolvedStreamIssueCount },
    unknown_interval_shape: { ...shape, intervalTypes: sorted(shape.intervalTypes), lengths: sorted(shape.lengths), rolePairs: sorted(shape.rolePairs), previousDurationTicks: sorted(shape.previousDurationTicks), byPositionDecile: sorted(shape.byPositionDecile) },
    unknown_interval_samples_by_position_decile_and_role: sorted(samples),
    whole_source_timing: { notes: notes.length, onsetsOnSafeGrid: onsetsOnGrid, releasesOnSafeGrid: releasesOnGrid, releasesOneTickBeforeSafeGrid: releasesOneTickEarly, releasesOnGridEventIds: notes.filter(event => onGrid(event.end)).map(event => shortId(event.id)) },
    role_release_boundaries: describeBoundaries(candidate),
    unpublished_candidate_evaluation: {
      candidate: regrid.candidate, active: regrid.active, status: regrid.status,
      pattern: regrid.pattern.sources.map(({ sourceId, noteCount, onsetsOffGrid, releasesOnGrid, releaseOffsets, delta, deltaEqualsOneSourceTick, uniform }) => ({ sourceId, noteCount, onsetsOffGrid, releasesOnGrid, releaseOffsets, delta, deltaEqualsOneSourceTick, uniform })),
      planned: regrid.plans.length, effects: sorted(effects), refused: regrid.refusals.length, refusals: sorted(refusals), invariantViolations: regrid.violations.length,
      remainingMicroTimingIntervals: afterTiming?.candidateCount ?? null,
      publishedV1EnforcementOnCandidateProject: afterEnforcement ? { status: afterEnforcement.status, blockers: afterEnforcement.blockers } : null,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'work-dir': { type: 'string' }, events: { type: 'string' }, decisions: { type: 'string' },
    'expect-microtiming-sha256': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !values['work-dir'] || !values.events || !values.decisions) { process.stdout.write(HELP); return values.help ? 0 : 1; }
  const receipt = await auditMicroTiming({
    workDir: resolve(values['work-dir']), eventPaths: values.events.split(',').map(path => resolve(path)), decisionsPath: resolve(values.decisions),
  });
  if (values['expect-microtiming-sha256']) receipt.reproduction.matches_expected_microtiming_sha256 = receipt.reproduction.microtiming_gate_value_sha256 === values['expect-microtiming-sha256'];
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (values.out) writeFileSync(resolve(values.out), text, { flag: 'wx' });
  process.stdout.write(text);
  return receipt.reproduction.matches_expected_microtiming_sha256 === false ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
