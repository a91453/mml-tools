// What the audio prescreen plays: six roles of timed notes, a tempo map and a
// bar grid. Pure: no I/O, no rendering.
//
// Built from Studio's own parser output (an MML) or from a Canonical project
// (a candidate or the Source-Faithful Baseline). Beats stay exact rationals
// until the last step, where they become seconds through the tempo map.
import { F, f, ROLES, parseMeter } from '../../../../dist/core.js';
import { DEFAULT_INSTRUMENT, gmVoiceFor, velocityForVolume } from '../instruments.mjs';

export const PERFORMANCE_SCHEMA = 'mml-studio/prescreen-performance@1';
export const MAX_BARS = 10000;

const DEFAULT_TEMPO = 120;

/** Beat → seconds through a tempo map [{ beat, bpm }], exact until returned. */
export function tempoClock(tempo) {
  const points = (tempo?.length ? tempo : [{ beat: '0', bpm: DEFAULT_TEMPO }])
    .map(point => ({ beat: f(point.beat), bpm: Number(point.bpm) }))
    .sort((a, b) => a.beat.cmp(b.beat));
  if (points[0].beat.cmp(0) > 0) points.unshift({ beat: f(0), bpm: points[0].bpm });
  const at = [f(0)];
  for (let i = 1; i < points.length; i++) {
    at.push(at[i - 1].add(points[i].beat.sub(points[i - 1].beat).mul(new F(60)).div(new F(points[i - 1].bpm))));
  }
  const exact = beat => {
    const b = f(beat);
    let i = points.length - 1;
    while (i > 0 && points[i].beat.cmp(b) > 0) i--;
    return at[i].add(b.sub(points[i].beat).mul(new F(60)).div(new F(points[i].bpm)));
  };
  return Object.freeze({
    seconds: beat => exact(beat).num(),
    beatAtSeconds(seconds) {
      let i = points.length - 1;
      while (i > 0 && at[i].num() > seconds) i--;
      return points[i].beat.num() + ((seconds - at[i].num()) * points[i].bpm) / 60;
    },
    points: points.map(point => ({ beat: point.beat.toString(), bpm: point.bpm })),
  });
}

const instrumentsFor = instruments => {
  const ids = Array.from({ length: ROLES.length }, (_, index) => instruments?.[index] ?? DEFAULT_INSTRUMENT);
  return ids.map(id => gmVoiceFor(id));
};

function finish(roles, tempo, warnings) {
  const clock = tempoClock(tempo);
  let total = f(0);
  for (const role of roles) {
    for (const note of role.notes) if (f(note.endExact).cmp(total) > 0) total = f(note.endExact);
  }
  for (const role of roles) {
    for (const note of role.notes) {
      note.on = clock.seconds(note.startExact);
      note.off = clock.seconds(note.endExact);
    }
    role.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.end - b.end);
  }
  return Object.freeze({
    schema: PERFORMANCE_SCHEMA,
    roles,
    tempo: clock.points,
    totalExact: total.toString(),
    totalBeats: total.num(),
    durationSeconds: clock.seconds(total),
    warnings: Object.freeze([...new Set(warnings)].sort()),
  });
}

const noteOf = (roleIndex, pitch, start, end, volume) => {
  const s = f(start), e = f(end);
  const vol = Number.isInteger(volume) && volume >= 0 && volume <= 15 ? volume : 8;
  return {
    role: roleIndex,
    pitch,
    startExact: s.toString(),
    endExact: e.toString(),
    start: s.num(),
    end: e.num(),
    volume: vol,
    velocity: velocityForVolume(vol),
  };
};

/**
 * A performance from six parsed tracks (Studio parser `parseTrack` output).
 * The tempo map is the first non-empty track's, which is the one Final
 * requires every non-empty track to repeat; a mismatch is reported.
 */
export function performanceFromTracks(tracks, { instruments = null } = {}) {
  if (!Array.isArray(tracks) || tracks.length !== ROLES.length) throw Error('six parsed tracks are required');
  const voices = instrumentsFor(instruments);
  const warnings = [];
  const active = tracks.filter(track => !track.empty && track.events.length);
  const tempo = active[0]?.tempo?.length ? active[0].tempo : [];
  if (!tempo.length) warnings.push('DEFAULT_TEMPO_120_ASSUMED');
  else if (f(tempo[0].beat).cmp(0) !== 0) warnings.push('FIRST_TEMPO_AFTER_BEAT_0');
  if (active.some(track => JSON.stringify(track.tempo) !== JSON.stringify(tempo))) warnings.push('TEMPO_MAP_MISMATCH_FIRST_TRACK_USED');
  const roles = tracks.map((track, index) => ({
    index,
    name: ROLES[index],
    ...voices[index],
    notes: track.events.map(event => noteOf(index, event.pitch, event.start, event.end, event.volume)),
  }));
  return finish(roles, tempo, warnings);
}

/**
 * A performance from a Canonical project's note events. Notes with no
 * assigned role cannot be played by a role and are counted, not guessed.
 */
export function performanceFromCanonical(project, { instruments = null } = {}) {
  const voices = instrumentsFor(instruments);
  const warnings = [];
  const roles = ROLES.map((name, index) => ({ index, name, ...voices[index], notes: [] }));
  let unassigned = 0;
  for (const event of project?.events ?? []) {
    if (event.kind !== 'note') continue;
    const index = ROLES.indexOf(event.role);
    if (index < 0) { unassigned++; continue; }
    roles[index].notes.push(noteOf(index, event.pitch, event.start, event.end, event.volume ?? null));
  }
  if (unassigned) warnings.push('UNASSIGNED_EVENTS_NOT_RENDERED');
  const tempo = (project?.tempoEvents ?? []).map(event => ({ beat: event.beat, bpm: event.bpm }));
  if (!tempo.length) warnings.push('DEFAULT_TEMPO_120_ASSUMED');
  const performance = finish(roles, tempo, warnings);
  return Object.freeze({ ...performance, unassignedNotes: unassigned });
}

/**
 * The symbolic reference an alternative's source fidelity is measured
 * against: notes with pitch, exact onset/end, volume and (possibly null) role.
 */
export function referenceFromCanonical(project) {
  const notes = [];
  for (const event of project?.events ?? []) {
    if (event.kind !== 'note') continue;
    const s = f(event.start), e = f(event.end);
    notes.push({ role: ROLES.includes(event.role) ? ROLES.indexOf(event.role) : null, pitch: event.pitch, start: s.num(), end: e.num(), volume: Number.isInteger(event.volume) ? event.volume : null });
  }
  return Object.freeze({ notes: notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch) });
}

export function referenceFromPerformance(performance) {
  const notes = performance.roles.flatMap(role => role.notes.map(note => ({ role: role.index, pitch: note.pitch, start: note.start, end: note.end, volume: note.volume })));
  return Object.freeze({ notes: notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch) });
}

/** A meter map from source-confirmed meter text ("beat numerator/denominator" lines). */
export const meterFromText = text => parseMeter(text).map(entry => ({ beat: entry.beat, numerator: entry.numerator, denominator: entry.denominator }));
export const meterFromCanonical = project => (project?.meterEvents ?? [])
  .map(event => ({ beat: f(event.beat).toString(), numerator: event.numerator, denominator: event.denominator }))
  .sort((a, b) => f(a.beat).cmp(b.beat));
export const meterText = meter => meter.map(entry => `${entry.beat} ${entry.numerator}/${entry.denominator}`).join('\n');

/**
 * Bars over [0, total) from a meter map. Unlike the Final validator this is
 * lenient about a short last bar (the prescreen grades sound, not closure),
 * but a meter change inside a bar is refused as it is there.
 */
export function barsFor(totalExact, meter, { pickup = null } = {}) {
  const total = f(totalExact);
  if (total.cmp(0) <= 0) throw Error('the alternatives contain no notes');
  if (!meter.length || f(meter[0].beat).cmp(0) !== 0) throw Error('the meter map must start at beat 0');
  const pickupLength = pickup ? f(pickup) : null;
  if (pickupLength && pickupLength.cmp(0) <= 0) throw Error('pickup must be a positive beat length');
  const bars = [];
  let cursor = f(0);
  let mi = 0;
  while (cursor.cmp(total) < 0) {
    if (bars.length >= MAX_BARS) throw Error(`more than ${MAX_BARS} bars`);
    while (mi + 1 < meter.length && f(meter[mi + 1].beat).cmp(cursor) <= 0) mi++;
    const sig = meter[mi];
    const full = new F(sig.numerator * 4, sig.denominator);
    let size = bars.length === 0 && pickupLength ? pickupLength : full;
    if (mi + 1 < meter.length && f(meter[mi + 1].beat).cmp(cursor.add(size)) < 0) {
      throw Error(`meter change at beat ${meter[mi + 1].beat} falls inside a bar`);
    }
    const remain = total.sub(cursor);
    const partial = size.cmp(remain) > 0 || size.cmp(full) !== 0;
    const end = cursor.add(size);
    bars.push(Object.freeze({
      bar: bars.length + 1,
      startExact: cursor.toString(),
      endExact: end.toString(),
      start: cursor.num(),
      end: end.num(),
      numerator: sig.numerator,
      denominator: sig.denominator,
      partial,
    }));
    cursor = end;
  }
  return bars;
}

/** The notes of a role that sound (are held) at a beat. */
export const heldAt = (notes, beat) => notes.filter(note => note.start <= beat && note.end > beat);
