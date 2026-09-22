// UNPUBLISHED CANONICAL CANDIDATE — sub-grid systematic release offset.
//
// Status: implementation of a *candidate* rule, not of Published Canonical.
// Rule text, rationale and scope: docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md
//
// Published Canonical 2026-09-13-v1 permits normalizing a technical micro-gap
// without musical meaning (MASTER_RULES §7) and forbids one in Final
// (MOBILE_SYNTAX §4, §11 step 5), but it does not decide (a) what evidence
// establishes that a note-preceded sub-grid gap carries no musical meaning when
// the only symbolic source is third-party, nor (b) which of several musically
// different rewrites normalizes it. docs/TECHNICAL_TIMING_REPAIR.md §13 records
// the same open question. This module implements one precise answer to both
// questions so that the answer can be reviewed, tested and — only after a
// reviewed publication — activated. Until then:
//
//   * `RELEASE_REGRID_CANDIDATE.activeInCanonicalVersions` is empty, so
//     `isReleaseRegridCandidateActive()` is false for every loaded release;
//   * every project this module produces carries a candidate marker on the
//     project AND on every event it changed, and the shared Final micro-gap
//     enforcement (final/micro-gap-enforcement.mjs) refuses any project that
//     carries an inactive marker, so readiness and the Final emitter both fail
//     closed on it;
//   * nothing in the application service, readiness or the emitter calls this
//     module. It is a reviewer/diagnostic tool.
//
// Exact rational arithmetic only. No float, no epsilon, no rounding, no snapping
// of onsets. The only mutation is moving a note's release forward by exactly the
// source's uniform offset, and it is refused whenever it would cross an onset,
// introduce a same-pitch overlap, shrink a rest below the safe grid, touch an
// interval with any keep decision, or act on a non-uniform source.
import { f, F, ROLES } from '../mml/index.mjs';
import {
  SAFE_GRID,
  MICRO_TIMING_KEEP_ACTION,
} from './micro-timing.mjs';

export const RELEASE_REGRID_CANDIDATE = Object.freeze({
  id: 'CANDIDATE-2026-09-22-SUBGRID-RELEASE-OFFSET',
  status: 'UNPUBLISHED_CANONICAL_CANDIDATE',
  document: 'docs/canonical-candidates/SUBGRID_RELEASE_OFFSET.md',
  basedOnCanonicalVersion: '2026-09-13-v1',
  basedOnRulesSnapshotSha: '0a172900a01fdf39c2e9e84cf176961320b779ea',
  // Empty on purpose. A Canonical release that publishes this rule must add its
  // own version here in the same reviewed change that publishes the prose.
  activeInCanonicalVersions: Object.freeze([]),
  evidenceClass: 'SOURCE_ENCODING_PATTERN (machine-derived, symbolic structure); not source-supported musical meaning, not audio, not human, not in-game',
});

export const CANDIDATE_MARKER_KEY = 'canonicalCandidate';

export const REGRID_OPERATION = 'regrid-release-to-safe-grid';

export const REGRID_REFUSAL = Object.freeze({
  SOURCE_PATTERN_NOT_UNIFORM: 'source-release-offset-not-uniform',
  SOURCE_ONSET_OFF_GRID: 'source-has-off-grid-onsets',
  SOURCE_OFFSET_NOT_SUB_GRID: 'source-release-offset-not-below-safe-grid',
  SOURCE_OFFSET_NOT_ONE_TICK: 'source-release-offset-is-not-one-source-tick',
  MIXED_PROVENANCE: 'event-has-mixed-or-missing-source-provenance',
  ROLE_UNASSIGNED: 'event-role-unassigned',
  KEEP_DECISION_PRESENT: 'interval-has-a-keep-decision',
  EXTENSION_CROSSES_ONSET: 'extension-would-cross-a-same-role-onset',
  EXPLICIT_REST_IN_WINDOW: 'extension-window-holds-an-explicit-rest',
  SAME_PITCH_OVERLAP: 'extension-would-introduce-same-pitch-overlap',
  REST_WOULD_BECOME_SUB_GRID: 'following-rest-would-become-shorter-than-the-safe-grid',
  ALREADY_MARKED: 'project-already-carries-a-candidate-transform',
});

export function isReleaseRegridCandidateActive(canonicalVersion) {
  return RELEASE_REGRID_CANDIDATE.activeInCanonicalVersions.includes(canonicalVersion);
}

const isNote = event => event && event.kind === 'note' && event.id && event.start != null && event.end != null;
const isSpan = event => event && (event.kind === 'note' || event.kind === 'rest') && event.id && event.start != null && event.end != null;
const onGrid = value => f(value).div(SAFE_GRID).d === 1n;

// Smallest safe-grid multiple >= value, exact.
function ceilToGrid(value) {
  const units = f(value).div(SAFE_GRID);
  const whole = units.n / units.d + (units.n % units.d === 0n ? 0n : (units.n > 0n ? 1n : 0n));
  return new F(whole, 1n).mul(SAFE_GRID);
}

function tickOf(event) {
  const tpq = event?.metadata?.ticksPerQuarter;
  return Number.isInteger(tpq) && tpq > 0 ? new F(1, tpq) : null;
}

/**
 * Describe each source's release encoding. Pure description; no verdict.
 *
 * A source is `uniform` when every note it carries has an on-grid onset, and
 * every off-grid release lies exactly the same distance `delta` before a
 * safe-grid point, with `0 < delta < SAFE_GRID`. When the events carry a tick
 * resolution, `delta` must also be exactly one source tick.
 */
export function analyzeReleaseOffsetPattern(project) {
  const bySource = new Map();
  for (const event of project?.events ?? []) {
    if (!isNote(event)) continue;
    const ids = Array.isArray(event.sourceIds) ? event.sourceIds : [];
    if (ids.length !== 1) continue;
    const key = ids[0];
    if (!bySource.has(key)) {
      bySource.set(key, { sourceId: key, noteCount: 0, onsetsOffGrid: 0, releasesOnGrid: 0, releaseOffsets: new Map(), ticks: new Set(), ticksKnown: true });
    }
    const entry = bySource.get(key);
    entry.noteCount += 1;
    if (!onGrid(event.start)) entry.onsetsOffGrid += 1;
    const tick = tickOf(event);
    if (tick) entry.ticks.add(tick.toString()); else entry.ticksKnown = false;
    if (onGrid(event.end)) { entry.releasesOnGrid += 1; continue; }
    const delta = ceilToGrid(event.end).sub(event.end).toString();
    entry.releaseOffsets.set(delta, (entry.releaseOffsets.get(delta) ?? 0) + 1);
  }
  const sources = [...bySource.values()].map(entry => {
    const offsets = [...entry.releaseOffsets.entries()].sort(([a], [b]) => f(a).cmp(b));
    const refusals = [];
    if (entry.onsetsOffGrid) refusals.push(REGRID_REFUSAL.SOURCE_ONSET_OFF_GRID);
    if (offsets.length !== 1) refusals.push(REGRID_REFUSAL.SOURCE_PATTERN_NOT_UNIFORM);
    const delta = offsets.length === 1 ? f(offsets[0][0]) : null;
    if (delta && delta.cmp(SAFE_GRID) >= 0) refusals.push(REGRID_REFUSAL.SOURCE_OFFSET_NOT_SUB_GRID);
    let deltaEqualsOneSourceTick = null;
    if (delta && entry.ticksKnown && entry.ticks.size === 1) {
      deltaEqualsOneSourceTick = delta.cmp([...entry.ticks][0]) === 0;
      if (!deltaEqualsOneSourceTick) refusals.push(REGRID_REFUSAL.SOURCE_OFFSET_NOT_ONE_TICK);
    } else if (delta && entry.ticks.size > 1) {
      deltaEqualsOneSourceTick = false;
      refusals.push(REGRID_REFUSAL.SOURCE_OFFSET_NOT_ONE_TICK);
    }
    return Object.freeze({
      sourceId: entry.sourceId,
      noteCount: entry.noteCount,
      onsetsOffGrid: entry.onsetsOffGrid,
      releasesOnGrid: entry.releasesOnGrid,
      releaseOffsets: Object.freeze(offsets.map(([value, count]) => Object.freeze({ delta: value, count }))),
      delta: delta ? delta.toString() : null,
      deltaEqualsOneSourceTick,
      uniform: refusals.length === 0,
      refusals: Object.freeze(refusals),
    });
  }).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return Object.freeze({ candidate: RELEASE_REGRID_CANDIDATE, safeGrid: SAFE_GRID.toString(), sources: Object.freeze(sources) });
}

function keepDecisionEventIds(project) {
  const ids = new Set();
  for (const decision of project?.decisions ?? []) {
    if (decision?.action !== MICRO_TIMING_KEEP_ACTION) continue;
    // Any status: a pending or rejected keep is still an open musical claim on
    // the interval, and this candidate never overrides one.
    for (const id of decision.eventIds ?? []) ids.add(id);
  }
  return ids;
}

function hasCandidateMarker(project) {
  if (project?.metadata?.[CANDIDATE_MARKER_KEY]) return true;
  return (project?.events ?? []).some(event => event?.metadata?.[CANDIDATE_MARKER_KEY]);
}

/**
 * Plan the candidate transformation. Returns every planned change and every
 * refusal with its reason; never mutates `project`.
 */
export function planReleaseRegrid(project) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');
  const pattern = analyzeReleaseOffsetPattern(project);
  const plans = [];
  const refusals = [];
  if (hasCandidateMarker(project)) {
    return Object.freeze({ candidate: RELEASE_REGRID_CANDIDATE, pattern, plans: Object.freeze([]), refusals: Object.freeze([{ eventId: null, reason: REGRID_REFUSAL.ALREADY_MARKED }]) });
  }
  const uniformSources = new Map(pattern.sources.filter(s => s.uniform).map(s => [s.sourceId, f(s.delta)]));
  const nonUniformSources = new Map(pattern.sources.filter(s => !s.uniform).map(s => [s.sourceId, s.refusals]));
  const keepIds = keepDecisionEventIds(project);
  const spans = (project.events ?? []).filter(isSpan);
  const byRole = new Map();
  for (const span of spans) {
    if (!ROLES.includes(span.role)) continue;
    if (!byRole.has(span.role)) byRole.set(span.role, []);
    byRole.get(span.role).push(span);
  }

  for (const event of spans) {
    if (!isNote(event) || onGrid(event.end)) continue;
    const refuse = (reason, detail = null) => refusals.push(Object.freeze({ eventId: event.id, reason, ...(detail ? { detail } : {}) }));
    const ids = Array.isArray(event.sourceIds) ? event.sourceIds : [];
    if (ids.length !== 1) { refuse(REGRID_REFUSAL.MIXED_PROVENANCE); continue; }
    if (nonUniformSources.has(ids[0])) { refuse(nonUniformSources.get(ids[0])[0]); continue; }
    const delta = uniformSources.get(ids[0]);
    if (!delta) { refuse(REGRID_REFUSAL.SOURCE_PATTERN_NOT_UNIFORM); continue; }
    if (!ROLES.includes(event.role)) { refuse(REGRID_REFUSAL.ROLE_UNASSIGNED); continue; }
    if (keepIds.has(event.id)) { refuse(REGRID_REFUSAL.KEEP_DECISION_PRESENT); continue; }
    const end = f(event.end);
    const newEnd = end.add(delta);
    const peers = byRole.get(event.role).filter(peer => peer.id !== event.id);
    // Onsets strictly inside (end, newEnd) — extension would overlap a later attack.
    if (peers.some(peer => f(peer.start).cmp(end) > 0 && f(peer.start).cmp(newEnd) < 0)) { refuse(REGRID_REFUSAL.EXTENSION_CROSSES_ONSET); continue; }
    if (peers.some(peer => peer.kind === 'rest' && f(peer.start).cmp(newEnd) < 0 && f(peer.end).cmp(end) > 0)) { refuse(REGRID_REFUSAL.EXPLICIT_REST_IN_WINDOW); continue; }
    if (peers.some(peer => peer.kind === 'note' && peer.pitch === event.pitch
      && f(peer.start).cmp(newEnd) < 0 && f(peer.end).cmp(end) > 0)) { refuse(REGRID_REFUSAL.SAME_PITCH_OVERLAP); continue; }
    // The role's silence right after this release, before the change.
    const coveredAfter = peers.some(peer => f(peer.start).cmp(end) <= 0 && f(peer.end).cmp(end) > 0);
    let followingSilence = null;
    if (!coveredAfter) {
      const nextOnsets = peers.map(peer => f(peer.start)).filter(start => start.cmp(end) >= 0).sort((a, b) => a.cmp(b));
      const next = nextOnsets[0] ?? null;
      followingSilence = next ? next.sub(end) : null; // null: role ends here
      if (followingSilence && followingSilence.cmp(delta) > 0) {
        const after = followingSilence.sub(delta);
        if (after.cmp(SAFE_GRID) < 0) { refuse(REGRID_REFUSAL.REST_WOULD_BECOME_SUB_GRID, { before: followingSilence.toString(), after: after.toString() }); continue; }
      }
    }
    let effect;
    if (coveredAfter) effect = 'release-inside-role-coverage';
    else if (followingSilence === null) effect = 'role-end-moves-by-delta';
    else if (followingSilence.cmp(delta) === 0) effect = 'sub-grid-gap-closed';
    else effect = 'following-rest-shortened-by-delta';
    plans.push(Object.freeze({
      eventId: event.id,
      role: event.role,
      pitch: event.pitch,
      start: f(event.start).toString(),
      before: { end: end.toString() },
      after: { end: newEnd.toString() },
      delta: delta.toString(),
      effect,
      followingSilenceBefore: followingSilence ? followingSilence.toString() : null,
      followingSilenceAfter: followingSilence ? followingSilence.sub(delta).toString() : null,
    }));
  }
  return Object.freeze({ candidate: RELEASE_REGRID_CANDIDATE, pattern, plans: Object.freeze(plans), refusals: Object.freeze(refusals) });
}

function roleSilence(events, role) {
  // Exact sorted coverage segments for a role; silence is their complement.
  const segs = [];
  for (const event of events.filter(e => isNote(e) && e.role === role).sort((a, b) => f(a.start).cmp(b.start))) {
    const start = f(event.start); const end = f(event.end); const last = segs.at(-1);
    if (!last || start.cmp(last.end) > 0) segs.push({ start, end });
    else if (end.cmp(last.end) > 0) last.end = end;
  }
  return segs.map(s => `${s.start}-${s.end}`);
}

/**
 * Verify the produced candidate against the original, from the produced data.
 * Returns a list of violations; empty means every invariant holds.
 */
export function verifyReleaseRegridInvariants(original, candidate, plans) {
  const violations = [];
  const before = new Map((original.events ?? []).map(e => [e.id, e]));
  const after = new Map((candidate.events ?? []).map(e => [e.id, e]));
  const planned = new Map(plans.map(p => [p.eventId, p]));
  if (before.size !== after.size) violations.push('event-count-changed');
  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) { violations.push(`event-missing:${id}`); continue; }
    for (const field of ['kind', 'pitch', 'role', 'voice', 'volume']) if (a[field] !== b[field]) violations.push(`${field}-changed:${id}`);
    if (f(a.start).cmp(b.start) !== 0) violations.push(`onset-moved:${id}`);
    const plan = planned.get(id);
    if (!plan) { if (f(a.end).cmp(b.end) !== 0) violations.push(`unplanned-release-change:${id}`); continue; }
    if (f(b.end).sub(a.end).cmp(plan.delta) !== 0) violations.push(`release-moved-by-other-than-delta:${id}`);
    if (!onGrid(b.end)) violations.push(`release-still-off-grid:${id}`);
    if (a.kind !== 'note') violations.push(`non-note-regridded:${id}`);
  }
  for (const id of after.keys()) if (!before.has(id)) violations.push(`event-invented:${id}`);
  // No new same-role same-pitch overlap and no crossing of any onset.
  const byRole = new Map();
  for (const e of candidate.events ?? []) if (isNote(e) && ROLES.includes(e.role)) (byRole.get(e.role) ?? byRole.set(e.role, []).get(e.role)).push(e);
  for (const plan of plans) {
    const e = after.get(plan.eventId);
    for (const peer of byRole.get(e.role) ?? []) {
      if (peer.id === e.id) continue;
      if (f(peer.start).cmp(plan.before.end) > 0 && f(peer.start).cmp(e.end) < 0) violations.push(`onset-crossed:${e.id}`);
      if (peer.pitch === e.pitch && f(peer.start).cmp(e.end) < 0 && f(peer.end).cmp(plan.before.end) > 0) {
        const hadOverlap = f(peer.start).cmp(plan.before.end) < 0 && f(peer.end).cmp(e.start) > 0;
        if (!hadOverlap) violations.push(`same-pitch-overlap-introduced:${e.id}`);
      }
    }
  }
  for (const key of ['tempoEvents', 'meterEvents', 'sources', 'decisions']) {
    if (JSON.stringify(original[key] ?? []) !== JSON.stringify(candidate[key] ?? [])) violations.push(`${key}-changed`);
  }
  if (original.id === candidate.id) violations.push('candidate-indistinguishable-from-original');
  return Object.freeze(violations);
}

/**
 * Produce the candidate-transformed project for review/diagnostics.
 *
 * `status` is always `CANDIDATE_ONLY`, never `PASS`: the result is marked with
 * the unpublished candidate identity, and Published-v1 readiness and Final
 * emission refuse it (see final/micro-gap-enforcement.mjs).
 */
export function applyReleaseRegridCandidate(project) {
  const planned = planReleaseRegrid(project);
  const plannedById = new Map(planned.plans.map(p => [p.eventId, p]));
  const marker = Object.freeze({
    id: RELEASE_REGRID_CANDIDATE.id,
    status: RELEASE_REGRID_CANDIDATE.status,
    document: RELEASE_REGRID_CANDIDATE.document,
    basedOnCanonicalVersion: RELEASE_REGRID_CANDIDATE.basedOnCanonicalVersion,
    publishedCanonicalEligible: false,
  });
  const events = (project.events ?? []).map(event => {
    const plan = plannedById.get(event.id);
    if (!plan) return event;
    return Object.freeze({
      ...event,
      end: plan.after.end,
      metadata: Object.freeze({
        ...(event.metadata ?? {}),
        [CANDIDATE_MARKER_KEY]: Object.freeze({
          ...marker,
          operation: REGRID_OPERATION,
          reversal: Object.freeze({ field: 'end', restore: plan.before.end }),
          delta: plan.delta,
          effect: plan.effect,
        }),
      }),
    });
  });
  const candidateProject = Object.freeze({
    ...project,
    id: `${project.id}#${RELEASE_REGRID_CANDIDATE.id}`,
    events: Object.freeze(events),
    metadata: Object.freeze({
      ...(project.metadata ?? {}),
      [CANDIDATE_MARKER_KEY]: Object.freeze({ ...marker, derivedFromProjectId: project.id, changedEventCount: planned.plans.length, refusedEventCount: planned.refusals.length }),
    }),
  });
  const violations = verifyReleaseRegridInvariants(project, candidateProject, planned.plans);
  const silenceChangedRoles = ROLES.filter(role => JSON.stringify(roleSilence(project.events ?? [], role)) !== JSON.stringify(roleSilence(events, role)));
  return Object.freeze({
    status: violations.length ? 'FAIL' : 'CANDIDATE_ONLY',
    candidate: RELEASE_REGRID_CANDIDATE,
    active: false,
    pattern: planned.pattern,
    plans: planned.plans,
    refusals: planned.refusals,
    violations,
    silenceChangedRoles: Object.freeze(silenceChangedRoles),
    project: violations.length ? null : candidateProject,
    notice: 'UNPUBLISHED CANONICAL CANDIDATE. Not a Published Canonical transformation, not a gate result, not VALIDATED, never IN_GAME_ACCEPTED. Published-v1 readiness and Final emission refuse the marked project.',
  });
}

/** Exact reversal: restore every candidate-changed release and drop the markers. */
export function reverseReleaseRegridCandidate(candidateProject) {
  const marker = candidateProject?.metadata?.[CANDIDATE_MARKER_KEY];
  if (!marker || marker.id !== RELEASE_REGRID_CANDIDATE.id) throw Error('project carries no release-regrid candidate marker');
  const events = candidateProject.events.map(event => {
    const record = event?.metadata?.[CANDIDATE_MARKER_KEY];
    if (!record) return event;
    const { [CANDIDATE_MARKER_KEY]: _dropped, ...metadata } = event.metadata;
    return Object.freeze({ ...event, end: record.reversal.restore, metadata: Object.freeze(metadata) });
  });
  const { [CANDIDATE_MARKER_KEY]: _marker, ...metadata } = candidateProject.metadata;
  return Object.freeze({ ...candidateProject, id: marker.derivedFromProjectId, events: Object.freeze(events), metadata: Object.freeze(metadata) });
}

/** True when a project carries any candidate transform marker (project or event level). */
export function carriesCanonicalCandidateMarker(project) {
  return hasCandidateMarker(project);
}
