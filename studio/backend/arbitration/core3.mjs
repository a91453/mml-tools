import { f } from '../mml/index.mjs';
import { compareCanonicalVersions } from '../compare/version-drift.mjs';

export const CORE3_ROLES = Object.freeze(['Melody', 'Chord1', 'Chord2']);
const CORE3 = new Set(CORE3_ROLES);

const notes = project => (project?.events ?? []).filter(event => event.kind === 'note');
const isCore3 = event => CORE3.has(event?.role);
const isLead = event => event?.role === 'Melody';
const overlap = (aStart, aEnd, bStart, bEnd) => f(aStart).cmp(bEnd) < 0 && f(bStart).cmp(aEnd) < 0;
const maxF = (a, b) => f(a).cmp(b) >= 0 ? f(a) : f(b);
const minF = (a, b) => f(a).cmp(b) <= 0 ? f(a) : f(b);

function normalizeApprovals(approvals) {
  if (!Array.isArray(approvals)) throw Error('approvedChanges must be an array');
  const map = new Map();
  for (const approval of approvals) {
    if (!approval || typeof approval !== 'object') throw Error('approvedChanges contains an invalid item');
    if (typeof approval.eventId !== 'string' || !approval.eventId) throw Error('approved change requires eventId');
    if (!['remove', 'modify', 'role-move'].includes(approval.type)) throw Error('approved change type must be remove, modify, or role-move');
    if (typeof approval.reason !== 'string' || !approval.reason.trim()) throw Error('approved change requires a positive reason');
    if (!Array.isArray(approval.evidence) || !approval.evidence.length || approval.evidence.some(item => typeof item !== 'string' || !item.trim())) throw Error('approved change requires explicit evidence');
    map.set(`${approval.type}|${approval.eventId}`, Object.freeze({ ...approval, reason: approval.reason.trim(), evidence: [...approval.evidence] }));
  }
  return map;
}

function approved(approvalMap, type, eventId) {
  return approvalMap.get(`${type}|${eventId}`) ?? null;
}

function mergeIntervals(intervals) {
  const ordered = intervals
    .map(interval => ({ start: String(interval.start), end: String(interval.end) }))
    .sort((a, b) => f(a.start).cmp(b.start) || f(a.end).cmp(b.end));
  const merged = [];
  for (const interval of ordered) {
    const last = merged.at(-1);
    if (!last || f(interval.start).cmp(last.end) > 0) merged.push({ ...interval });
    else last.end = String(maxF(last.end, interval.end));
  }
  return merged;
}

function subtractCoverage(start, end, coverage) {
  const missing = [];
  let cursor = f(start);
  const targetEnd = f(end);
  for (const interval of coverage) {
    if (!overlap(cursor, targetEnd, interval.start, interval.end)) continue;
    const coveredStart = maxF(cursor, interval.start);
    const coveredEnd = minF(targetEnd, interval.end);
    if (coveredStart.cmp(cursor) > 0) missing.push({ start: String(cursor), end: String(coveredStart) });
    cursor = maxF(cursor, coveredEnd);
    if (cursor.cmp(targetEnd) >= 0) break;
  }
  if (cursor.cmp(targetEnd) < 0) missing.push({ start: String(cursor), end: String(targetEnd) });
  return missing;
}

function falseLeadGaps(baseline, candidate) {
  const candidateLeadCoverage = mergeIntervals(notes(candidate).filter(isLead).map(event => ({ start: event.start, end: event.end })));
  const gaps = [];
  for (const event of notes(baseline).filter(isLead)) {
    for (const gap of subtractCoverage(event.start, event.end, candidateLeadCoverage)) {
      gaps.push(Object.freeze({
        baselineEventId: event.id,
        pitch: event.pitch,
        start: gap.start,
        end: gap.end,
        sourceIds: [...(event.sourceIds ?? [])],
      }));
    }
  }
  return gaps;
}

function roleStats(project) {
  const result = {};
  for (const role of CORE3_ROLES) {
    const roleNotes = notes(project).filter(event => event.role === role).sort((a, b) => f(a.start).cmp(b.start));
    let largestAdjacentJump = 0;
    const jumps = [];
    for (let i = 1; i < roleNotes.length; i++) {
      const semitones = Math.abs(roleNotes[i].pitch - roleNotes[i - 1].pitch);
      largestAdjacentJump = Math.max(largestAdjacentJump, semitones);
      if (semitones >= 12) jumps.push(Object.freeze({
        fromEventId: roleNotes[i - 1].id,
        toEventId: roleNotes[i].id,
        fromPitch: roleNotes[i - 1].pitch,
        toPitch: roleNotes[i].pitch,
        semitones,
      }));
    }
    result[role] = Object.freeze({
      noteCount: roleNotes.length,
      largestAdjacentJump,
      octavePlusJumps: Object.freeze(jumps),
      notice: 'Register jumps are diagnostic only; an octave-or-larger jump is not automatically wrong.',
    });
  }
  return Object.freeze(result);
}

export function evaluateCore3Continuity({ baseline, candidate, approvedChanges = [] }) {
  if (!baseline?.events || !candidate?.events) throw Error('Core3 gate requires baseline and candidate Canonical projects');
  const approvals = normalizeApprovals(approvedChanges);
  const diff = compareCanonicalVersions(baseline, candidate);

  const removedCore3 = diff.notes.removed.filter(isCore3).map(event => Object.freeze({
    event,
    approval: approved(approvals, 'remove', event.id),
  }));
  const modifiedCore3 = diff.notes.modified.filter(pair => isCore3(pair.before)).map(pair => Object.freeze({
    ...pair,
    approval: approved(approvals, 'modify', pair.before.id),
  }));
  const roleMovesFromCore3 = diff.notes.roleMoved.filter(pair => isCore3(pair.before)).map(pair => Object.freeze({
    ...pair,
    approval: approved(approvals, 'role-move', pair.before.id),
    leavesCore3: !isCore3(pair.after),
    demotesLead: isLead(pair.before) && !isLead(pair.after),
  }));
  const gaps = falseLeadGaps(baseline, candidate);

  const unapproved = [];
  for (const item of removedCore3) if (!item.approval) unapproved.push({ type: 'remove', eventId: item.event.id, role: item.event.role });
  for (const item of modifiedCore3) if (!item.approval) unapproved.push({ type: 'modify', eventId: item.before.id, role: item.before.role, changes: item.changes });
  for (const item of roleMovesFromCore3) if (!item.approval) unapproved.push({ type: 'role-move', eventId: item.before.id, from: item.before.role, to: item.after.role });

  // A source-supported Lead gap is never cleared merely by approving a demotion.
  // It must be covered by another accepted Lead event in the candidate.
  const blockers = [];
  if (unapproved.length) blockers.push('UNAPPROVED_CORE3_SOURCE_CHANGE');
  if (gaps.length) blockers.push('SOURCE_SUPPORTED_LEAD_GAP');

  return Object.freeze({
    status: blockers.length ? 'PENDING' : 'PASS',
    pass: blockers.length === 0,
    blockers: Object.freeze(blockers),
    sourceDiff: diff,
    removedCore3: Object.freeze(removedCore3),
    modifiedCore3: Object.freeze(modifiedCore3),
    roleMovesFromCore3: Object.freeze(roleMovesFromCore3),
    falseLeadGaps: Object.freeze(gaps),
    unapproved: Object.freeze(unapproved),
    candidateRoleStats: roleStats(candidate),
    notice: 'Core3 coverage is source-relative. True source rests and source-supported sparse passages are preserved; density is not an optimization target.',
  });
}
