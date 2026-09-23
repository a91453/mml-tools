// MusicXML repeat / navigation expansion: the written measures in the order a
// performer plays them.
//
// Status: IMPLEMENTATION NOTES. SOURCE_POLICY §1.A makes an official symbolic
// source the authority for "repeats/navigation when explicitly represented";
// MASTER_RULES §9 asks previews to "fully expand playback order". This module
// reads only what the score writes -- repeat barlines, `times`, volta endings,
// segno / coda / fine / D.C. / D.S. / To Coda, from `<sound>` attributes or the
// standard direction words -- and turns it into a measure order. It is the
// written performance order, not an arrangement: no measure is added, dropped
// or edited, and a measure played twice is the same written measure twice.
//
// Conventions applied (each one is the standard reading of the notation, and
// each is recorded in the result so a reader can see it was applied):
//
//   * `:|` with no `|:` repeats from the start of the piece, or from the
//     measure after the previous repeat structure;
//   * `times="n"` plays the repeated passage n times (default 2);
//   * volta endings play on the passes their numbers name; an ending bracket
//     split across two segments with the same numbers and no repeat barline
//     between them is one ending (reported as VOLTA_SEGMENTS_JOINED); a last
//     ending that itself repeats means the final pass plays no bracket;
//   * D.C. / D.S. are taken once, the first time they are reached; after the
//     jump, repeats are not re-taken and the last ending is played, up to the
//     measure that held the jump, unless the jump text says "with repeats" /
//     "con rip."; To Coda and Fine act only after the jump (MusicXML `<sound>`
//     semantics); a jump written on a measure that also ends a repeat is taken
//     on the last pass (reported as NAVIGATION_JUMP_AFTER_REPEAT);
//   * a D.C./D.S./To Coda/Fine mark applies at the end of the measure that
//     holds it; a segno/coda target applies at the start of its measure (or of
//     the next measure when it sits on the right barline).
//
// Anything outside that -- markers the parts disagree on, an ending with no
// repeat to return to, a `|:` never closed, two jumps, a segno or coda no jump
// uses, a jump whose "al Coda"/"al Fine" is never reached, a mid-measure target,
// `time-only` -- is not guessed. The plan is refused with a precise diagnostic
// and the caller keeps the written order and marks the source incomplete.

export const NAVIGATION_LIMITS = Object.freeze({
  maxRepeatTimes: 16,
  maxPlaybackMeasures: 20000,
  maxPlaybackFactor: 16,
});

// Diagnostic families. They are the codes the pre-expansion guard reported, so
// a consumer that keyed on them keeps working; `reason` says exactly why.
export const NAVIGATION_CODES = Object.freeze({
  REPEAT: 'REPEAT_BARLINE',
  ENDING: 'VOLTA_ENDING',
  SEGNO: 'SEGNO',
  CODA: 'CODA',
  DA_CAPO: 'DA_CAPO',
  DAL_SEGNO: 'DAL_SEGNO',
  TO_CODA: 'TO_CODA',
  FINE: 'FINE_NAVIGATION',
  PLAN: 'NAVIGATION_PLAN',
});

const JUMP_CODE = kind => (kind === 'dacapo' ? NAVIGATION_CODES.DA_CAPO : NAVIGATION_CODES.DAL_SEGNO);

function parseEndingNumbers(raw) {
  if (typeof raw !== 'string' || !/^\s*[1-9]\d*(\s*,\s*[1-9]\d*)*\s*$/.test(raw)) return null;
  const numbers = raw.split(',').map(value => Number(value.trim()));
  if (numbers.some(value => !Number.isSafeInteger(value))) return null;
  if (new Set(numbers).size !== numbers.length) return null;
  return numbers.sort((a, b) => a - b);
}

const sameNumbers = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Plan the playback order.
 *
 * `parts` is `[{ partId, measures: [measureNav] }]`, where every part lists its
 * measures in written order and `measureNav` is what the MusicXML reader found
 * at that measure (see `score/musicxml.mjs#scanNavigation`). `measureCount` is
 * the number of written measures the timeline has.
 *
 * Returns `{ ok, plan, diagnostics, warnings, summary }`. `plan` is
 * `[{ index, pass }]` with 0-based written measure indices and 1-based pass
 * numbers (how many times that written measure has been played so far). When
 * `ok` is false the plan is the written order and `diagnostics` says why.
 */
export function planPlayback({ parts, measureCount, numberOf = index => String(index + 1), limits = NAVIGATION_LIMITS }) {
  const diagnostics = [];
  const warnings = [];
  const n = measureCount;
  const at = index => ({ measureIndex: index + 1, measureNumber: numberOf(index) });
  const problem = (code, reason, index, message, extra = {}) => {
    diagnostics.push(Object.freeze({ code, reason, ...(index === null ? {} : at(index)), message, ...extra }));
  };
  const warn = (code, index, message, extra = {}) => {
    warnings.push(Object.freeze({ code, ...(index === null ? {} : at(index)), message, ...extra }));
  };
  const written = () => Array.from({ length: n }, (_, index) => ({ index, pass: 1 }));
  const refused = () => ({ ok: false, plan: written(), diagnostics, warnings, summary: null });

  // ── 1. per-part barline markers, normalized to measure boundaries ────────
  const perPart = parts.map(part => {
    const forward = new Set();
    const backward = new Map();
    const endingStarts = new Map();
    const endingStops = new Map();
    const markers = [];
    part.measures.forEach((measure, index) => {
      if (!measure) return;
      for (const item of measure.problems ?? []) problem(item.code, item.reason, index, item.message, { partId: part.partId });
      if (measure.forwardRepeatSound) forward.add(index);
      for (const repeat of measure.repeats ?? []) {
        const location = repeat.location ?? 'right';
        if (location === 'middle') { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_ON_MID_MEASURE_BARLINE', index, 'A repeat sign on a mid-measure barline cannot be expanded at measure granularity.', { partId: part.partId }); continue; }
        if (repeat.direction === 'forward') {
          const target = location === 'left' ? index : index + 1;
          if (target >= n) { problem(NAVIGATION_CODES.REPEAT, 'FORWARD_REPEAT_AT_END', index, 'A forward repeat on the final barline starts nothing.', { partId: part.partId }); continue; }
          forward.add(target);
        } else if (repeat.direction === 'backward') {
          const target = location === 'right' ? index : index - 1;
          if (target < 0) { problem(NAVIGATION_CODES.REPEAT, 'BACKWARD_REPEAT_AT_START', index, 'A backward repeat on the first barline repeats nothing.', { partId: part.partId }); continue; }
          let times = null;
          if (repeat.times !== null && repeat.times !== undefined) {
            if (!/^\d+$/.test(String(repeat.times).trim())) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_TIMES_INVALID', index, `times="${repeat.times}" is not a whole number.`, { partId: part.partId }); continue; }
            times = Number(String(repeat.times).trim());
            if (times < 2) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_TIMES_INVALID', index, `times="${repeat.times}" does not repeat anything.`, { partId: part.partId }); continue; }
            if (times > limits.maxRepeatTimes) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_TIMES_OVER_LIMIT', index, `times="${times}" exceeds the expansion limit of ${limits.maxRepeatTimes}.`, { partId: part.partId, max: limits.maxRepeatTimes }); continue; }
          }
          const prior = backward.get(target);
          if (prior && prior.times !== times) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_TIMES_CONFLICT', target, 'Two backward repeats on one barline disagree about times.', { partId: part.partId }); continue; }
          backward.set(target, { times });
        } else {
          problem(NAVIGATION_CODES.REPEAT, 'REPEAT_DIRECTION_MISSING', index, 'A repeat element without direction="forward|backward" cannot be expanded.', { partId: part.partId });
        }
      }
      for (const ending of measure.endings ?? []) {
        const numbers = parseEndingNumbers(ending.number);
        const type = ending.type;
        if (!numbers) { problem(NAVIGATION_CODES.ENDING, 'ENDING_NUMBER_INVALID', index, `Ending number "${ending.number ?? ''}" does not name the passes it plays on.`, { partId: part.partId }); continue; }
        const location = ending.location ?? 'right';
        if (location === 'middle') { problem(NAVIGATION_CODES.ENDING, 'ENDING_ON_MID_MEASURE_BARLINE', index, 'An ending on a mid-measure barline cannot be expanded.', { partId: part.partId }); continue; }
        if (type === 'start') {
          const target = location === 'left' ? index : index + 1;
          if (target >= n) { problem(NAVIGATION_CODES.ENDING, 'ENDING_START_AT_END', index, 'An ending starts on the final barline.', { partId: part.partId }); continue; }
          if (!endingStarts.has(target)) endingStarts.set(target, []);
          endingStarts.get(target).push({ numbers, raw: ending.number });
        } else if (type === 'stop' || type === 'discontinue') {
          const target = location === 'right' ? index : index - 1;
          if (target < 0) { problem(NAVIGATION_CODES.ENDING, 'ENDING_STOP_AT_START', index, 'An ending stops on the first barline.', { partId: part.partId }); continue; }
          if (!endingStops.has(target)) endingStops.set(target, []);
          endingStops.get(target).push({ numbers, type, raw: ending.number });
        } else {
          problem(NAVIGATION_CODES.ENDING, 'ENDING_TYPE_INVALID', index, `Ending type "${type ?? ''}" is not start, stop or discontinue.`, { partId: part.partId });
        }
      }
      for (const marker of measure.markers ?? []) markers.push({ ...marker, index });
    });
    return { partId: part.partId, forward, backward, endingStarts, endingStops, markers };
  });
  if (diagnostics.length) return refused();

  // Barline markers are measure structure: every part that writes them must
  // write the same ones. A part that writes none (exporters often put system marks
  // on one part only) is not a disagreement.
  const repeatSignature = part => JSON.stringify([[...part.forward].sort((a, b) => a - b), [...part.backward.entries()].sort(([a], [b]) => a - b)]);
  const endingSignature = part => JSON.stringify([
    [...part.endingStarts.entries()].sort(([a], [b]) => a - b).map(([index, list]) => [index, list.map(item => item.numbers)]),
    [...part.endingStops.entries()].sort(([a], [b]) => a - b).map(([index, list]) => [index, list.map(item => [item.numbers, item.type])]),
  ]);
  const withRepeats = perPart.filter(part => part.forward.size || part.backward.size);
  const withEndings = perPart.filter(part => part.endingStarts.size || part.endingStops.size);
  if (new Set(withRepeats.map(repeatSignature)).size > 1) {
    problem(NAVIGATION_CODES.REPEAT, 'PARTS_DISAGREE', null, 'Parts write different repeat barlines; which one the score means is not guessed.', { partIds: withRepeats.map(part => part.partId) });
  }
  if (new Set(withEndings.map(endingSignature)).size > 1) {
    problem(NAVIGATION_CODES.ENDING, 'PARTS_DISAGREE', null, 'Parts write different volta endings; which one the score means is not guessed.', { partIds: withEndings.map(part => part.partId) });
  }
  if (diagnostics.length) return refused();

  const forward = withRepeats[0]?.forward ?? new Set();
  const backward = withRepeats[0]?.backward ?? new Map();
  const endingStarts = withEndings[0]?.endingStarts ?? new Map();
  const endingStops = withEndings[0]?.endingStops ?? new Map();
  for (const list of [...endingStarts.values(), ...endingStops.values()]) {
    if (list.length > 1) {
      const first = list[0];
      if (list.some(item => !sameNumbers(item.numbers, first.numbers) || item.type !== first.type)) {
        problem(NAVIGATION_CODES.ENDING, 'ENDING_BOUNDARY_CONFLICT', null, 'Two different endings share one barline.');
      }
    }
  }
  if (diagnostics.length) return refused();

  // ── 2. ending ranges ──────────────────────────────────────────────────────
  const ranges = [];
  let open = null;
  for (let index = 0; index < n; index += 1) {
    const start = endingStarts.get(index)?.[0];
    if (start) {
      if (open) { problem(NAVIGATION_CODES.ENDING, 'ENDING_OVERLAP', index, `An ending starts while the ending from measure ${open.start + 1} is still open.`); break; }
      open = { numbers: start.numbers, raw: start.raw, start: index };
    }
    const stop = endingStops.get(index)?.[0];
    if (stop) {
      if (!open) { problem(NAVIGATION_CODES.ENDING, 'ENDING_STOP_WITHOUT_START', index, 'An ending stops that never started.'); break; }
      if (!sameNumbers(open.numbers, stop.numbers)) { problem(NAVIGATION_CODES.ENDING, 'ENDING_NUMBER_MISMATCH', index, `An ending started as "${open.raw}" stops as "${stop.raw}".`); break; }
      ranges.push({ numbers: open.numbers, start: open.start, end: index, type: stop.type, segments: 1 });
      open = null;
    }
  }
  if (!diagnostics.length && open) problem(NAVIGATION_CODES.ENDING, 'ENDING_UNCLOSED', open.start, `The ending "${open.raw}" is never closed.`);
  if (diagnostics.length) return refused();

  // One ending bracket drawn as two segments (typically across a system
  // break): same numbers, adjacent, no repeat barline between them.
  const endings = [];
  for (const range of ranges) {
    const previous = endings.at(-1);
    if (previous && previous.end + 1 === range.start && sameNumbers(previous.numbers, range.numbers) && !backward.has(previous.end)) {
      warn('VOLTA_SEGMENTS_JOINED', range.start, `Ending ${range.numbers.join(', ')} is written as two adjacent segments (measures ${previous.start + 1}–${previous.end + 1} and ${range.start + 1}–${range.end + 1}) with no repeat barline between them; they are read as one ending.`);
      previous.end = range.end;
      previous.type = range.type;
      previous.segments += 1;
      continue;
    }
    endings.push({ ...range });
  }

  // ── 3. ending groups ─────────────────────────────────────────────────────
  const groups = [];
  for (const ending of endings) {
    const previous = groups.at(-1)?.endings.at(-1);
    if (previous && previous.end + 1 === ending.start) groups.at(-1).endings.push(ending);
    else groups.push({ endings: [ending] });
  }
  const endingAt = new Map();
  for (const group of groups) {
    group.start = group.endings[0].start;
    group.end = group.endings.at(-1).end;
    const all = group.endings.flatMap(ending => ending.numbers);
    if (new Set(all).size !== all.length) { problem(NAVIGATION_CODES.ENDING, 'ENDING_NUMBER_REPEATED', group.start, 'Two endings of one group play on the same pass.'); continue; }
    for (let k = 1; k < group.endings.length; k += 1) {
      if (Math.max(...group.endings[k - 1].numbers) > Math.min(...group.endings[k].numbers)) problem(NAVIGATION_CODES.ENDING, 'ENDINGS_OUT_OF_ORDER', group.endings[k].start, 'Endings are not written in pass order.');
    }
    const max = Math.max(...all);
    if (all.length !== max) { problem(NAVIGATION_CODES.ENDING, 'ENDING_NUMBERS_NOT_CONTIGUOUS', group.start, `Endings name passes ${[...all].sort((a, b) => a - b).join(', ')}, which is not 1..${max}.`); continue; }
    group.endings.forEach((ending, k) => {
      ending.group = group;
      ending.last = k === group.endings.length - 1;
      ending.repeats = backward.has(ending.end);
      if (!ending.last && !ending.repeats) problem(NAVIGATION_CODES.ENDING, 'ENDING_WITHOUT_REPEAT', ending.end, `Ending ${ending.numbers.join(', ')} is followed by another ending but has no backward repeat to return to.`);
      for (let index = ending.start; index <= ending.end; index += 1) {
        if (index < ending.end && backward.has(index)) problem(NAVIGATION_CODES.REPEAT, 'BACKWARD_REPEAT_INSIDE_ENDING', index, 'A backward repeat sits inside an ending rather than at its end.');
        // Only the first ending may open on a forward repeat (a passage whose
        // common part is empty); anywhere else it would nest inside the endings.
        if (forward.has(index) && !(k === 0 && index === ending.start)) problem(NAVIGATION_CODES.REPEAT, 'FORWARD_REPEAT_INSIDE_ENDING', index, 'A forward repeat sits inside an ending.');
      }
      for (let index = ending.start; index <= ending.end; index += 1) endingAt.set(index, ending);
    });
    const lastRepeats = group.endings.at(-1).repeats;
    // A last ending that itself repeats leaves the final pass without a
    // bracket: `|: A [1. B :|] C` plays A B A C.
    group.total = lastRepeats ? max + 1 : max;
    if (group.total < 2) problem(NAVIGATION_CODES.ENDING, 'ENDING_WITHOUT_REPEAT', group.start, 'A single first ending with no repeat does not select anything.');
  }
  if (diagnostics.length) return refused();

  // ── 4. repeat sections ───────────────────────────────────────────────────
  const sections = [];
  const sectionByBackward = new Map();
  const sectionOfGroup = new Map();
  let boundary = 0;
  let openForward = null;
  for (let index = 0; index < n; index += 1) {
    if (forward.has(index)) {
      if (openForward !== null) { problem(NAVIGATION_CODES.REPEAT, 'NESTED_OR_UNCLOSED_FORWARD_REPEAT', index, `A forward repeat opens while the one at measure ${openForward + 1} is still open.`); break; }
      openForward = index;
    }
    const back = backward.get(index);
    if (back) {
      const ending = endingAt.get(index);
      if (ending) {
        const group = ending.group;
        let section = sectionOfGroup.get(group);
        if (!section) {
          const start = openForward ?? boundary;
          if (start > group.start) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_START_INSIDE_ENDINGS', index, 'The repeat returns to a measure inside its own endings.'); break; }
          if (back.times !== null && back.times !== group.total) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_TIMES_CONFLICT_WITH_ENDINGS', index, `times="${back.times}" disagrees with endings that make ${group.total} passes.`); break; }
          section = { start, end: index, total: group.total, group, implicitStart: openForward === null };
          sections.push(section);
          sectionOfGroup.set(group, section);
          openForward = null;
        } else {
          if (back.times !== null && back.times !== group.total) { problem(NAVIGATION_CODES.REPEAT, 'REPEAT_TIMES_CONFLICT_WITH_ENDINGS', index, `times="${back.times}" disagrees with endings that make ${group.total} passes.`); break; }
          section.end = index;
        }
        sectionByBackward.set(index, section);
      } else {
        const start = openForward ?? boundary;
        const section = { start, end: index, total: back.times ?? 2, group: null, implicitStart: openForward === null };
        sections.push(section);
        sectionByBackward.set(index, section);
        openForward = null;
        boundary = index + 1;
      }
    }
    const ending = endingAt.get(index);
    if (ending?.last && ending.end === index) {
      if (!sectionOfGroup.has(ending.group)) { problem(NAVIGATION_CODES.ENDING, 'ENDING_WITHOUT_REPEAT', ending.group.start, 'These endings have no backward repeat to return through them.'); break; }
      boundary = index + 1;
    }
  }
  if (!diagnostics.length && openForward !== null) problem(NAVIGATION_CODES.REPEAT, 'UNMATCHED_FORWARD_REPEAT', openForward, 'A forward repeat is never closed by a backward repeat.');
  if (diagnostics.length) return refused();

  // ── 5. jumps and their targets ───────────────────────────────────────────
  const seen = new Set();
  const markers = [];
  for (const part of perPart) {
    for (const marker of part.markers) {
      const key = JSON.stringify([marker.type, marker.index, marker.kind ?? null, marker.label ?? null, marker.variant ?? null, marker.where ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({ ...marker, partId: part.partId });
    }
  }
  const targetIndex = (marker, code, what) => {
    if (marker.where === 'start') return marker.index;
    if (marker.where === 'end') {
      if (marker.index + 1 >= n) { problem(code, `${what}_AT_END`, marker.index, `A ${what.toLowerCase()} on the final barline marks nothing to return to.`); return null; }
      return marker.index + 1;
    }
    problem(code, `${what}_MID_MEASURE`, marker.index, `A ${what.toLowerCase()} sits inside the measure; a jump target is only read at a barline.`);
    return null;
  };
  const segnos = [];
  const codas = [];
  const wordCodas = [];
  const tocodas = [];
  const fines = [];
  const jumps = [];
  for (const marker of markers) {
    if (marker.type === 'segno') { const index = targetIndex(marker, NAVIGATION_CODES.SEGNO, 'SEGNO'); if (index !== null) segnos.push({ index, label: marker.label ?? null }); }
    else if (marker.type === 'coda') {
      if (marker.evidence === 'words') { wordCodas.push(marker); continue; }
      const index = targetIndex(marker, NAVIGATION_CODES.CODA, 'CODA');
      if (index !== null) codas.push({ index, label: marker.label ?? null });
    }
    else if (marker.type === 'tocoda') tocodas.push(marker);
    else if (marker.type === 'fine') fines.push(marker);
    else if (marker.type === 'jump') jumps.push(marker);
  }
  const dedupeTargets = list => {
    const byKey = new Map();
    for (const item of list) {
      const key = `${item.index}|${item.label ?? ''}`;
      if (!byKey.has(key)) byKey.set(key, item);
    }
    // A glyph without a label and a labelled sound at the same measure are one
    // target, not two.
    const result = [];
    for (const item of byKey.values()) {
      const same = result.find(other => other.index === item.index && (other.label === null || item.label === null));
      if (same) { same.label = same.label ?? item.label; continue; }
      result.push({ ...item });
    }
    return result;
  };
  const segnoTargets = dedupeTargets(segnos);
  // A coda sign or `coda` sound is a target in its own right. The bare word
  // "Coda" counts only when a To Coda needs a target and no sign provides one.
  const needsWordCoda = !codas.length && markers.some(marker => marker.type === 'tocoda');
  if (needsWordCoda) {
    for (const marker of wordCodas) {
      const index = targetIndex(marker, NAVIGATION_CODES.CODA, 'CODA');
      if (index !== null) codas.push({ index, label: null });
    }
  }
  const codaTargets = dedupeTargets(codas);
  const byMeasure = list => {
    const result = new Map();
    for (const item of list) {
      const prior = result.get(item.index);
      if (prior && (prior.label ?? null) !== (item.label ?? null) && prior.label && item.label) {
        problem(item.type === 'tocoda' ? NAVIGATION_CODES.TO_CODA : NAVIGATION_CODES.FINE, 'CONFLICTING_MARKERS', item.index, 'Two different marks of one kind sit on one measure.');
      }
      if (!prior) result.set(item.index, item);
      else if (!prior.label && item.label) result.set(item.index, { ...prior, label: item.label });
    }
    return result;
  };
  const tocodaAt = byMeasure(tocodas);
  const fineAt = byMeasure(fines);
  const jumpAt = new Map();
  for (const jump of jumps) {
    const prior = jumpAt.get(jump.index);
    if (prior && (prior.kind !== jump.kind || (prior.variant && jump.variant && prior.variant !== jump.variant))) {
      problem(JUMP_CODE(jump.kind), 'CONFLICTING_JUMPS', jump.index, 'Two different jumps are written on one measure.');
      continue;
    }
    if (!prior) jumpAt.set(jump.index, { ...jump });
    else jumpAt.set(jump.index, { ...prior, label: prior.label ?? jump.label, variant: prior.variant ?? jump.variant, playRepeats: prior.playRepeats || jump.playRepeats, evidence: prior.evidence === jump.evidence ? prior.evidence : 'sound+words' });
  }
  if (diagnostics.length) return refused();

  for (const item of [...tocodaAt.values(), ...fineAt.values(), ...jumpAt.values()]) {
    if (item.where === 'start' || item.where === 'middle') {
      warn('NAVIGATION_MARKER_NOT_AT_MEASURE_END', item.index, `${item.type === 'jump' ? (item.kind === 'dacapo' ? 'D.C.' : 'D.S.') : item.type === 'tocoda' ? 'To Coda' : 'Fine'} is written before the end of its measure; it is applied at the end of that measure, the reading this expansion uses for every such mark.`);
    }
    if (item.evidence === 'words') {
      warn('NAVIGATION_FROM_WORDS', item.index, `"${item.words}" carries no <sound> playback attribute; the jump is read from its standard text.`);
    }
  }

  if (jumpAt.size > 1) {
    const [first, second] = [...jumpAt.values()].sort((a, b) => a.index - b.index);
    problem(JUMP_CODE(second.kind), 'MULTIPLE_JUMPS', second.index, `A second D.C./D.S. (after measure ${first.index + 1}) makes the order depend on nested jumps; it is not guessed.`);
  }
  if (tocodaAt.size > 1) problem(NAVIGATION_CODES.TO_CODA, 'MULTIPLE_TO_CODA', [...tocodaAt.keys()][1], 'More than one To Coda mark.');
  if (fineAt.size > 1) problem(NAVIGATION_CODES.FINE, 'MULTIPLE_FINE', [...fineAt.keys()][1], 'More than one Fine mark.');
  if (diagnostics.length) return refused();

  const jump = [...jumpAt.values()][0] ?? null;
  const tocoda = [...tocodaAt.values()][0] ?? null;
  const fine = [...fineAt.values()][0] ?? null;
  const resolveTarget = (targets, label, code, what, from) => {
    if (!targets.length) { problem(code, `${what}_MISSING`, from, `No ${what.toLowerCase()} is written for this jump to reach.`); return null; }
    if (targets.length === 1) {
      const [only] = targets;
      if (label && only.label && label !== only.label) { problem(code, `${what}_LABEL_MISMATCH`, from, `The jump names "${label}" but the only ${what.toLowerCase()} is "${only.label}".`); return null; }
      return only.index;
    }
    const matches = label ? targets.filter(target => target.label === label) : [];
    if (matches.length !== 1) { problem(code, `${what}_AMBIGUOUS`, from, `${targets.length} ${what.toLowerCase()} marks exist and the jump does not name exactly one of them.`); return null; }
    return matches[0].index;
  };

  let jumpTarget = null;
  let codaTarget = null;
  if (jump) {
    if (jump.kind === 'dacapo') jumpTarget = 0;
    else {
      jumpTarget = resolveTarget(segnoTargets, jump.label, NAVIGATION_CODES.SEGNO, 'SEGNO', jump.index);
      if (jumpTarget !== null && jumpTarget > jump.index) problem(NAVIGATION_CODES.DAL_SEGNO, 'SEGNO_AFTER_JUMP', jump.index, 'The segno comes after the D.S. that returns to it.');
    }
    if (jump.variant === 'al-coda' && !tocoda) problem(NAVIGATION_CODES.TO_CODA, 'TO_CODA_MISSING', jump.index, 'The jump says "al Coda" but no To Coda mark is written.');
    if (jump.variant === 'al-fine' && !fine) problem(NAVIGATION_CODES.FINE, 'FINE_MISSING', jump.index, 'The jump says "al Fine" but no Fine is written.');
    if (tocoda && fine) problem(NAVIGATION_CODES.FINE, 'FINE_AND_TO_CODA', fine.index, 'Both a Fine and a To Coda are written; where the jump ends is not guessed.');
    if (jump.variant === 'al-fine' && tocoda) problem(NAVIGATION_CODES.TO_CODA, 'TO_CODA_WITH_AL_FINE', tocoda.index, 'A To Coda is written but the jump says "al Fine".');
    if (jump.variant === 'al-coda' && fine) problem(NAVIGATION_CODES.FINE, 'FINE_WITH_AL_CODA', fine.index, 'A Fine is written but the jump says "al Coda".');
  } else {
    for (const segno of segnoTargets) problem(NAVIGATION_CODES.SEGNO, 'SEGNO_WITHOUT_JUMP', segno.index, 'A segno is written but no D.S. returns to it; a D.S. written in a form this reader does not recognise is not assumed away.');
    if (tocoda) problem(NAVIGATION_CODES.TO_CODA, 'TO_CODA_WITHOUT_JUMP', tocoda.index, 'A To Coda is written but no D.C./D.S. makes it act.');
    for (const coda of codaTargets) if (!tocoda) problem(NAVIGATION_CODES.CODA, 'CODA_WITHOUT_JUMP', coda.index, 'A coda is written but nothing jumps to it.');
    // A Fine on the last measure with no jump ends the piece where it ends anyway.
    if (fine && fine.index !== n - 1) problem(NAVIGATION_CODES.FINE, 'FINE_WITHOUT_JUMP', fine.index, 'A Fine is written before the last measure but no D.C./D.S. makes it act.');
  }
  if (tocoda) {
    codaTarget = resolveTarget(codaTargets, tocoda.label, NAVIGATION_CODES.CODA, 'CODA', tocoda.index);
    if (codaTarget !== null && codaTarget <= tocoda.index) problem(NAVIGATION_CODES.CODA, 'CODA_BEFORE_TO_CODA', tocoda.index, 'The coda is not after the To Coda that jumps to it.');
  } else if (jump && codaTargets.length) {
    problem(NAVIGATION_CODES.CODA, 'CODA_WITHOUT_TO_CODA', codaTargets[0].index, 'A coda is written but no To Coda jumps to it.');
  }
  if (jump && segnoTargets.length && jump.kind === 'dacapo') problem(NAVIGATION_CODES.SEGNO, 'SEGNO_WITHOUT_JUMP', segnoTargets[0].index, 'A segno is written but the only jump is a D.C.');
  if (jump && segnoTargets.length > 1 && jump.kind === 'dalsegno') {
    for (const segno of segnoTargets) if (segno.index !== jumpTarget) problem(NAVIGATION_CODES.SEGNO, 'SEGNO_WITHOUT_JUMP', segno.index, 'A segno is written that no jump returns to.');
  }
  if (jump && backward.has(jump.index)) {
    warn('NAVIGATION_JUMP_AFTER_REPEAT', jump.index, 'The measure holding the jump also ends a repeat; the repeat is played first and the jump is taken on its last pass.');
  }
  if (diagnostics.length) return refused();

  // ── 6. unwind ─────────────────────────────────────────────────────────────
  const cap = Math.min(limits.maxPlaybackMeasures, Math.max(n, n * limits.maxPlaybackFactor));
  const plan = [];
  const occurrences = new Array(n).fill(0);
  let index = 0;
  let pass = 1;
  let jumped = null;
  let tocodaTaken = false;
  let fineApplied = false;
  let steps = 0;
  const inNoRepeatWindow = position => jumped !== null && jumped.active && !jumped.playRepeats && position <= jumped.origin;
  while (index < n) {
    steps += 1;
    if (plan.length >= cap || steps > cap * 4) {
      problem(NAVIGATION_CODES.PLAN, 'PLAYBACK_TOO_LONG', index, `The expanded order exceeds ${cap} measures; the expansion is refused rather than truncated.`, { max: cap });
      return refused();
    }
    const ending = endingAt.get(index);
    if (ending && ending.start === index) {
      const group = ending.group;
      const want = inNoRepeatWindow(index) ? group.total : pass;
      if (!ending.numbers.includes(want)) {
        if (ending.last) pass = 1;
        index = ending.end + 1;
        continue;
      }
      if (!ending.repeats) pass = 1;
    }
    occurrences[index] += 1;
    plan.push({ index, pass: occurrences[index] });

    if (jumped?.active && index <= jumped.origin) {
      if (fine && fine.index === index && jumped.variant !== 'al-coda') { fineApplied = true; break; }
      if (tocoda && tocoda.index === index && jumped.variant !== 'al-fine') {
        tocodaTaken = true;
        jumped.active = false;
        pass = 1;
        index = codaTarget;
        continue;
      }
    }
    const back = backward.get(index);
    if (back && !inNoRepeatWindow(index)) {
      const section = sectionByBackward.get(index);
      if (pass < section.total) {
        pass += 1;
        index = section.start;
        continue;
      }
      pass = 1;
    }
    if (jump && jump.index === index && jumped === null) {
      jumped = { origin: index, active: true, playRepeats: jump.playRepeats === true, variant: jump.variant ?? null };
      pass = 1;
      index = jumpTarget;
      continue;
    }
    index += 1;
  }

  if (jump && !jumped) problem(JUMP_CODE(jump.kind), 'JUMP_NOT_REACHED', jump.index, 'The D.C./D.S. is never reached in playback order.');
  if (tocoda && !tocodaTaken) problem(NAVIGATION_CODES.TO_CODA, 'TO_CODA_NOT_REACHED', tocoda.index, 'The To Coda is never reached after the jump.');
  if (fine && jump && !fineApplied) problem(NAVIGATION_CODES.FINE, 'FINE_NOT_REACHED', fine.index, 'The Fine is never reached after the jump.');
  if (diagnostics.length) return refused();

  const runs = [];
  for (const entry of plan) {
    const last = runs.at(-1);
    if (last && last[1] + 1 === entry.index + 1) last[1] = entry.index + 1;
    else runs.push([entry.index + 1, entry.index + 1]);
  }
  const identity = plan.length === n && plan.every((entry, position) => entry.index === position);
  const summary = Object.freeze({
    expanded: !identity,
    writtenMeasures: n,
    playedMeasures: plan.length,
    playbackOrder: Object.freeze(runs.map(run => Object.freeze(run))),
    playbackOrderText: runs.map(([a, b]) => (a === b ? numberOf(a - 1) : `${numberOf(a - 1)}–${numberOf(b - 1)}`)).join(' | '),
    sections: Object.freeze(sections.map(section => Object.freeze({
      start: section.start + 1,
      end: section.end + 1,
      passes: section.total,
      implicitStart: section.implicitStart,
      endings: section.group ? Object.freeze(section.group.endings.map(ending => Object.freeze({ numbers: [...ending.numbers], start: ending.start + 1, end: ending.end + 1, repeats: ending.repeats, segments: ending.segments }))) : null,
    }))),
    jump: jump ? Object.freeze({
      kind: jump.kind,
      from: jump.index + 1,
      to: jumpTarget + 1,
      variant: jump.variant ?? null,
      playRepeats: jump.playRepeats === true,
      evidence: jump.evidence,
      toCoda: tocoda ? Object.freeze({ from: tocoda.index + 1, to: codaTarget + 1 }) : null,
      fine: fine ? fine.index + 1 : null,
    }) : null,
    conventions: Object.freeze([
      'implicit-repeat-start: piece start or the measure after the previous repeat structure',
      'jumps taken once; repeats not re-taken and last ending played after a D.C./D.S. up to the jump measure unless marked with repeats',
      'To Coda / Fine act only after the jump; jump marks act at the end of their measure',
    ]),
  });
  return { ok: true, plan, diagnostics, warnings, summary };
}
