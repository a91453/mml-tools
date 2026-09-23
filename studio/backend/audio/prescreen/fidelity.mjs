// Symbolic distance of an alternative from its source reference. Pure.
//
// Status: IMPLEMENTATION NOTES. Source fidelity outranks smoothness: an
// alternative that departs further from the source can never be the machine's
// obvious winner on sound alone. This module counts, per bar, the event-level
// changes an alternative makes against a reference (the Source-Faithful
// Baseline, an accepted candidate, or a caller's reference MML):
//
//   omitted           a reference note the alternative does not carry
//   added             an alternative note the reference does not carry
//   pitch_changed     same onset (and role, when the reference has one), other pitch
//   onset_changed     same pitch, onset moved by at most one beat
//   duration_changed  matched note whose end differs by more than 1/16 beat
//   role_moved        matched note in another role than the reference's
//   volume_changed    matched note with another volume than the reference's
//
// Each change counts 1. Differences finer than the Final grid (onsets within
// 1/32 beat, ends within 1/16 beat) are not counted, so a Final's grid
// rendering of a source is not charged for what no Final can express. The
// distance is a count, not a verdict: it only orders alternatives.

export const FIDELITY_VERSION = 'mml-studio/prescreen-source-fidelity@1';
export const FIDELITY_CATEGORIES = Object.freeze(['omitted', 'added', 'pitch_changed', 'onset_changed', 'duration_changed', 'role_moved', 'volume_changed']);

const ONSET_TOLERANCE = 1 / 32;
const DURATION_TOLERANCE = 1 / 16;
const MOVE_WINDOW = 1;

function barLookup(bars) {
  return beat => {
    let lo = 0, hi = bars.length - 1;
    if (!bars.length || beat < bars[0].start || beat >= bars[hi].end) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].start <= beat) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
}

/** Notes of a performance as fidelity sees them. */
export const alternativeNotes = performance => performance.roles
  .flatMap(role => role.notes.map(note => ({ role: role.index, pitch: note.pitch, start: note.start, end: note.end, volume: note.volume })))
  .sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.role - b.role);

/**
 * Per-bar change counts of `notes` against `reference` notes. `bars` carry
 * numeric `start`/`end` beats; a change is filed under the bar of the
 * reference note's onset (or the added note's).
 */
export function fidelityByBar(notes, referenceNotes, bars) {
  const at = barLookup(bars);
  const perBar = bars.map(bar => ({ bar: bar.bar, distance: 0, counts: Object.fromEntries(FIDELITY_CATEGORIES.map(name => [name, 0])) }));
  const file = (beat, category) => {
    const b = at(beat);
    if (b < 0) return;
    perBar[b].counts[category]++;
    perBar[b].distance++;
  };
  const refs = referenceNotes.map((note, index) => ({ ...note, index, used: false }));
  const alts = notes.map((note, index) => ({ ...note, index, used: false }));
  const byPitch = new Map();
  for (const ref of refs) {
    if (!byPitch.has(ref.pitch)) byPitch.set(ref.pitch, []);
    byPitch.get(ref.pitch).push(ref);
  }
  const compareMatched = (alt, ref) => {
    if (Math.abs(alt.end - ref.end) > DURATION_TOLERANCE) file(ref.start, 'duration_changed');
    if (ref.role !== null && ref.role !== alt.role) file(ref.start, 'role_moved');
    if (ref.volume !== null && ref.volume !== undefined && ref.volume !== alt.volume) file(ref.start, 'volume_changed');
  };
  const pick = (candidates, alt, distance) => {
    let best = null;
    for (const ref of candidates) {
      if (ref.used) continue;
      const d = distance(ref);
      if (d === null) continue;
      const sameRole = ref.role === null || ref.role === alt.role ? 0 : 1;
      if (!best || sameRole < best.sameRole || (sameRole === best.sameRole && (d < best.d || (d === best.d && ref.index < best.ref.index)))) best = { ref, d, sameRole };
    }
    return best?.ref ?? null;
  };

  // 1. Same pitch, same onset.
  for (const alt of alts) {
    const ref = pick(byPitch.get(alt.pitch) ?? [], alt, r => (Math.abs(r.start - alt.start) <= ONSET_TOLERANCE ? Math.abs(r.start - alt.start) : null));
    if (!ref) continue;
    ref.used = alt.used = true;
    compareMatched(alt, ref);
  }
  // 2. Same onset and role, another pitch.
  const byOnset = new Map();
  for (const ref of refs) {
    if (ref.used) continue;
    const key = Math.round(ref.start / ONSET_TOLERANCE);
    for (const k of [key - 1, key, key + 1]) {
      if (!byOnset.has(k)) byOnset.set(k, []);
      byOnset.get(k).push(ref);
    }
  }
  for (const alt of alts) {
    if (alt.used) continue;
    const candidates = (byOnset.get(Math.round(alt.start / ONSET_TOLERANCE)) ?? []).filter(ref => ref.role === null || ref.role === alt.role);
    const ref = pick(candidates, alt, r => (Math.abs(r.start - alt.start) <= ONSET_TOLERANCE ? Math.abs(r.pitch - alt.pitch) : null));
    if (!ref) continue;
    ref.used = alt.used = true;
    file(ref.start, 'pitch_changed');
    if (Math.abs(alt.end - ref.end) > DURATION_TOLERANCE) file(ref.start, 'duration_changed');
  }
  // 3. Same pitch, onset moved within a beat.
  for (const alt of alts) {
    if (alt.used) continue;
    const ref = pick(byPitch.get(alt.pitch) ?? [], alt, r => (Math.abs(r.start - alt.start) <= MOVE_WINDOW ? Math.abs(r.start - alt.start) : null));
    if (!ref) continue;
    ref.used = alt.used = true;
    file(ref.start, 'onset_changed');
    if (Math.abs((alt.end - alt.start) - (ref.end - ref.start)) > DURATION_TOLERANCE) file(ref.start, 'duration_changed');
  }
  for (const ref of refs) if (!ref.used) file(ref.start, 'omitted');
  for (const alt of alts) if (!alt.used) file(alt.start, 'added');
  return perBar;
}

/**
 * Whether several note lists are identical within one bar (every note that
 * overlaps it, exactly). Alternatives that are symbolically the same there
 * cannot differ in source fidelity, whatever the reference is.
 */
export function barSignatures(performance, bars) {
  const at = barLookup(bars);
  const signatures = bars.map(() => []);
  for (const role of performance.roles) {
    for (const note of role.notes) {
      const found = at(note.start);
      const first = found >= 0 ? found : (note.start < bars[0]?.start ? 0 : bars.length);
      for (let b = first; b < bars.length && bars[b].start < note.end; b++) {
        if (bars[b].end <= note.start) continue;
        signatures[b].push(`${role.index}:${note.pitch}:${note.startExact}:${note.endExact}:${note.volume}`);
      }
    }
  }
  return signatures.map((list, b) => {
    const roles = new Set(list.map(entry => Number(entry.split(':')[0])));
    const voices = performance.roles.filter(role => roles.has(role.index)).map(role => `${role.index}=${role.instrument}`);
    return { notes: list.sort().join('|'), voices: voices.join(',') };
  });
}
