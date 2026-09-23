// Tempo and meter maps gathered from more than one place.
//
// Status: IMPLEMENTATION NOTES. A Canonical project has one tempo map and one
// meter map. When several parts of one score, or several merged sources, each
// state a control at the same beat, two cases are kept apart:
//
//   * they state the SAME value: that is one fact with several witnesses. One
//     event is kept and it carries every witness's `sourceIds` and
//     `sourceEventIds`, plus the ids it absorbed, so nothing is lost and the
//     map no longer shows two controls where the sources agree on one;
//   * they state DIFFERENT values: that is a disagreement, and choosing one
//     would be deciding it. Every event is kept unchanged and the conflict is
//     reported with each value and who stated it. Downstream the Final emitter
//     still refuses two tempi at one beat and the Final meter map refuses two
//     meters at one beat, so the conflict stays blocking and is named here.
//
// Equality is exact: a tempo of 120 and one of 119.99998 are different values.

import { f } from '../mml/index.mjs';
import { createCanonicalTempoEvent, createCanonicalMeterEvent } from './index.mjs';

const beatKey = beat => f(beat).toString();
const tempoValue = event => String(event.bpm);
const meterValue = event => `${event.numerator}/${event.denominator}`;
const union = lists => [...new Set(lists.flat())];

function normalizeKind(events, { kind, valueOf, rebuild }) {
  const byBeat = new Map();
  events.forEach((event, order) => {
    const key = beatKey(event.beat);
    if (!byBeat.has(key)) byBeat.set(key, []);
    byBeat.get(key).push({ event, order });
  });
  const kept = [];
  const collapsed = [];
  const conflicts = [];
  for (const [beat, entries] of byBeat) {
    const byValue = new Map();
    for (const entry of entries) {
      const value = valueOf(entry.event);
      if (!byValue.has(value)) byValue.set(value, []);
      byValue.get(value).push(entry);
    }
    for (const [value, same] of byValue) {
      if (same.length === 1) { kept.push(same[0]); continue; }
      const [first, ...rest] = same;
      const merged = rebuild(first.event, {
        sourceIds: union(same.map(entry => [...entry.event.sourceIds])),
        sourceEventIds: union(same.map(entry => [...(entry.event.sourceEventIds ?? [])])),
        metadata: {
          ...structuredClone(first.event.metadata ?? {}),
          corroboratedBy: rest.map(entry => ({
            id: entry.event.id,
            sourceIds: [...entry.event.sourceIds],
            sourceEventIds: [...(entry.event.sourceEventIds ?? [])],
          })),
        },
      });
      kept.push({ event: merged, order: first.order });
      collapsed.push(Object.freeze({ kind, beat, value, keptId: first.event.id, absorbedIds: Object.freeze(rest.map(entry => entry.event.id)) }));
    }
    if (byValue.size > 1) {
      conflicts.push(Object.freeze({
        kind,
        beat,
        values: Object.freeze([...byValue.entries()].map(([value, same]) => Object.freeze({
          value,
          eventIds: Object.freeze(same.map(entry => entry.event.id)),
          sourceIds: Object.freeze(union(same.map(entry => [...entry.event.sourceIds]))),
        }))),
      }));
    }
  }
  kept.sort((a, b) => f(a.event.beat).cmp(b.event.beat) || a.order - b.order);
  return { events: kept.map(entry => entry.event), collapsed, conflicts };
}

/**
 * Collapse same-beat, same-value tempo/meter events and report same-beat
 * disagreements. Returns events sorted by beat (input order within a beat).
 */
export function normalizeControlEvents({ tempoEvents = [], meterEvents = [] } = {}) {
  const tempo = normalizeKind(tempoEvents, {
    kind: 'tempo',
    valueOf: tempoValue,
    rebuild: (event, patch) => createCanonicalTempoEvent({ id: event.id, beat: event.beat, bpm: event.bpm, ...patch }),
  });
  const meter = normalizeKind(meterEvents, {
    kind: 'meter',
    valueOf: meterValue,
    rebuild: (event, patch) => createCanonicalMeterEvent({ id: event.id, beat: event.beat, numerator: event.numerator, denominator: event.denominator, ...patch }),
  });
  return Object.freeze({
    tempoEvents: Object.freeze(tempo.events),
    meterEvents: Object.freeze(meter.events),
    collapsed: Object.freeze([...tempo.collapsed, ...meter.collapsed]),
    conflicts: Object.freeze([...tempo.conflicts, ...meter.conflicts]),
  });
}

/** The diagnostic a control conflict is reported under. */
export function controlConflictDiagnostic(conflict) {
  const code = conflict.kind === 'tempo' ? 'TEMPO_CONFLICT_AT_POSITION' : 'METER_CONFLICT_AT_POSITION';
  const stated = conflict.values.map(item => `${item.value} (${item.sourceIds.join(', ')})`).join(' vs ');
  return Object.freeze({
    code,
    beat: conflict.beat,
    values: conflict.values,
    message: `Sources state different ${conflict.kind === 'tempo' ? 'tempi' : 'meters'} at beat ${conflict.beat}: ${stated}. Neither is chosen; the disagreement has to be resolved in the sources.`,
  });
}

/**
 * The Final meter-map text (`<beat> <n>/<d>` per line) for a project's meter
 * events, or the conflicts that prevent one. Identical same-beat meters are one
 * line; different ones are refused by name instead of reaching the bar builder
 * as an anonymous duplicate position.
 */
export function meterMapText(meterEvents = []) {
  const { meterEvents: events, conflicts } = normalizeControlEvents({ meterEvents });
  const meterConflicts = conflicts.filter(item => item.kind === 'meter');
  if (meterConflicts.length) return Object.freeze({ text: null, conflicts: Object.freeze(meterConflicts.map(controlConflictDiagnostic)) });
  return Object.freeze({ text: events.map(event => `${event.beat} ${event.numerator}/${event.denominator}`).join('\n'), conflicts: Object.freeze([]) });
}
