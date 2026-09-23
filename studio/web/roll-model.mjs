// What the review roll draws, projected from the analysed Canonical candidate.
// Runs in the Worker beside the analysis, so the main thread receives plain
// data and never imports the Canonical engines.
//
// A projection, not a copy of authority: event IDs, pitches and exact rational
// beats are carried as-is; nothing is quantised, folded, merged or dropped.
// Pitched notes without a role stay visible as unassigned material instead of
// being hidden, and harmony conflicts are carried as review signals that point
// back at the existing arbitration forms by index.
import { reviewSong } from '../../dist/core.js';
import { ROLL_ROLES, cmpBeat, parseBeat } from './roll-geometry.mjs';

// Events of `lanes[role]` at `pitches` that overlap [start, end).
function eventsIn(index, role, pitches, start, end) {
  const from = parseBeat(start), to = parseBeat(end);
  const out = [];
  for (const pitch of pitches) {
    for (const event of index.get(`${role}:${pitch}`) ?? []) {
      if (cmpBeat(parseBeat(event.start), to) < 0 && cmpBeat(parseBeat(event.end), from) > 0) out.push(event.id);
    }
  }
  return out;
}

export function buildRollProjection(candidate, { harmony = null } = {}) {
  if (!candidate || !Array.isArray(candidate.events)) return null;
  const lanes = ROLL_ROLES.map(role => ({ role, events: [] }));
  const unassigned = [];
  let end = parseBeat('0');
  let endText = '0';
  for (const event of candidate.events) {
    if (event?.kind !== 'note') continue;
    const item = { id: event.id, pitch: event.pitch, start: event.start, end: event.end };
    const lane = ROLL_ROLES.indexOf(event.role);
    (lane >= 0 ? lanes[lane].events : unassigned).push(item);
    const eventEnd = parseBeat(event.end);
    if (cmpBeat(eventEnd, end) > 0) { end = eventEnd; endText = event.end; }
  }
  const byStart = (a, b) => cmpBeat(parseBeat(a.start), parseBeat(b.start)) || a.pitch - b.pitch;
  for (const lane of lanes) lane.events.sort(byStart);
  unassigned.sort(byStart);
  const meters = (candidate.meterEvents ?? []).map(m => ({ beat: m.beat, numerator: m.numerator, denominator: m.denominator }));
  // Harmony signals keep the index of their arbitration form in report.harmony.
  const signals = (harmony?.conflicts ?? []).map((conflict, index) => ({
    kind: 'harmony',
    index,
    form: index,
    start: conflict.start,
    end: conflict.end,
    eventIds: [conflict.leftEventId, conflict.rightEventId].filter(Boolean),
    label: `${conflict.intervalName ?? conflict.type ?? 'conflict'} · ${conflict.leftRole ?? '—'} / ${conflict.rightRole ?? '—'}`,
    resolved: conflict.resolved === true,
  })).filter(signal => signal.start !== undefined && signal.end !== undefined);
  // The Full6 15-pair review, computed by the same reviewSong() the technical
  // validator uses, over the candidate's role lanes instead of a delivery
  // string, then tied back to event IDs. Same-pitch overlap is a review signal
  // (MASTER_RULES §6); low-register m2/M7 crowding is a density signal.
  const index = new Map();
  for (const lane of lanes) for (const event of lane.events) {
    const key = `${lane.role}:${event.pitch}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(event);
  }
  const review = reviewSong({ tracks: lanes.map(lane => ({ role: lane.role, events: lane.events })), drums: null });
  for (const pair of review.pairs) {
    for (const overlap of pair.overlaps) {
      signals.push({ kind: 'overlap', index: signals.length, start: overlap.start, end: overlap.end,
        eventIds: [...eventsIn(index, pair.left, [overlap.pitch], overlap.start, overlap.end), ...eventsIn(index, pair.right, [overlap.pitch], overlap.start, overlap.end)],
        label: `同音重疊（${overlap.kind === 'exact' ? '完全重合' : '延續中'}）· ${pair.left} / ${pair.right} · pitch ${overlap.pitch}`, resolved: false });
    }
  }
  for (const crowd of review.crowding) {
    signals.push({ kind: 'crowding', index: signals.length, start: crowd.start, end: crowd.end,
      eventIds: [...eventsIn(index, crowd.left, crowd.pitches, crowd.start, crowd.end), ...eventsIn(index, crowd.right, crowd.pitches, crowd.start, crowd.end)],
      label: `低音區 m2／M7 擁擠 · ${crowd.left} / ${crowd.right} · pitch ${crowd.pitches.join(' / ')}`, resolved: false });
  }
  return { lanes, unassigned, meters, end: endText, signals };
}
