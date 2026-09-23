import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/index.mjs';

// Every score here is synthetic: one note per 4/4 measure unless a measure says
// otherwise, so the playback order can be read back from the notes' written
// measure indices sorted by onset.

const NOTE = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>';
const direction = (inner, sound = '') => `<direction><direction-type>${inner}</direction-type>${sound}</direction>`;
const words = text => `<words>${text}</words>`;

/**
 * `spec[m]` (1-based): `left` / `right` barline children, `start` / `end`
 * content placed before / after the measure's note, `content` replacing the
 * note, `attrs` extra measure attributes.
 */
function score(count, spec = {}, { parts = ['P1'], tempo = 120, partSpec = null } = {}) {
  const partList = parts.map(id => `<score-part id="${id}"><part-name>${id}</part-name></score-part>`).join('');
  const body = parts.map((id, partIndex) => {
    let measures = '';
    for (let m = 1; m <= count; m += 1) {
      const item = { ...(spec[m] ?? {}), ...(partSpec?.[id]?.[m] ?? {}) };
      let inner = '';
      if (item.left) inner += `<barline location="left">${item.left}</barline>`;
      if (m === 1) inner += `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${partIndex === 0 && tempo ? `<direction><sound tempo="${tempo}"/></direction>` : ''}`;
      if (item.start) inner += item.start;
      inner += item.content ?? NOTE;
      if (item.end) inner += item.end;
      if (item.right) inner += `<barline location="right">${item.right}</barline>`;
      measures += `<measure number="${m}"${item.attrs ?? ''}>${inner}</measure>`;
    }
    return `<part id="${id}">${measures}</part>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list>${partList}</part-list>${body}</score-partwise>`;
}

const order = (fragment, partId = 'P1') => fragment.events
  .filter(event => event.kind === 'note' && event.metadata.partId === partId)
  .sort((a, b) => Number(a.start.split('/')[0]) / Number(a.start.split('/')[1] ?? 1) - Number(b.start.split('/')[0]) / Number(b.start.split('/')[1] ?? 1))
  .map(event => event.metadata.measureIndex);

const FWD = '<repeat direction="forward"/>';
const BACK = (times = null) => `<repeat direction="backward"${times ? ` times="${times}"` : ''}/>`;
const ENDING = (number, type) => `<ending number="${number}" type="${type}"/>`;

function expanded(xml, expectedOrder) {
  const fragment = ingestMusicXML(xml, { sourceId: 'nav', label: 'Navigation fixture' });
  assert.equal(fragment.complete, true, JSON.stringify(fragment.unsupported));
  assert.deepEqual(order(fragment), expectedOrder);
  const ids = fragment.events.map(event => event.id);
  assert.equal(new Set(ids).size, ids.length, 'every played event has its own id');
  // Contiguous: every measure starts where the previous one ended.
  const notes = fragment.events.filter(event => event.kind === 'note' && event.metadata.partId === 'P1').sort((a, b) => a.metadata.playbackMeasureIndex - b.metadata.playbackMeasureIndex);
  for (let k = 1; k < notes.length; k += 1) assert.equal(notes[k].start, notes[k - 1].end);
  return fragment;
}

function refused(xml, code, reason) {
  const fragment = ingestMusicXML(xml, { sourceId: 'nav', label: 'Navigation fixture' });
  assert.equal(fragment.complete, false);
  const finding = fragment.unsupported.find(item => item.code === code && item.reason === reason);
  assert.ok(finding, `${code}/${reason} not in ${JSON.stringify(fragment.unsupported)}`);
  assert.ok(typeof finding.message === 'string' && finding.message.length > 0);
  // The written order is kept, nothing is dropped or duplicated.
  const written = fragment.events.filter(event => event.kind === 'note' && event.metadata.partId === 'P1').map(event => event.metadata.measureIndex);
  assert.deepEqual(order(fragment), written);
  assert.equal(fragment.events.some(event => event.metadata.pass !== 1), false);
  assert.equal(fragment.navigation.refused, true);
  return { fragment, finding };
}

// ── repeats ────────────────────────────────────────────────────────────────

test('a simple |: :| is played twice; later passes keep a traceable, deterministic identity', () => {
  const xml = score(4, { 2: { left: FWD }, 3: { right: BACK() } });
  const fragment = expanded(xml, [1, 2, 3, 2, 3, 4]);
  const second = fragment.events.filter(event => event.metadata.measureIndex === 2);
  assert.deepEqual(second.map(event => event.id), ['nav:note:P1:2:2', 'nav:note:P1:2:2:pass2']);
  assert.deepEqual(second.map(event => event.sourceEventIds[0]), ['part:P1/measure:2/note:2', 'part:P1/measure:2/note:2/pass:2']);
  assert.deepEqual(second.map(event => [event.metadata.pass, event.metadata.playbackMeasureIndex]), [[1, 2], [2, 4]]);
  assert.equal(second[1].metadata.writtenSourceEventId, 'part:P1/measure:2/note:2');
  assert.equal(second[1].start, '12');
  // Deterministic: the same bytes give the same events.
  assert.deepEqual(ingestMusicXML(xml, { sourceId: 'nav', label: 'Navigation fixture' }).events, fragment.events);
  // The playback order is recorded on the source.
  const project = musicXMLFragmentToProject(fragment);
  assert.deepEqual(project.sources[0].metadata.navigation.playbackOrder, [[1, 3], [2, 4]]);
  assert.equal(project.sources[0].metadata.navigation.playbackOrderText, '1–3 | 2–4');
  assert.equal(project.metadata.navigation.playedMeasures, 6);
  assert.equal(project.metadata.sourceComplete, true);
});

test('an end repeat with no start repeats from the piece start, or from after the previous repeat', () => {
  expanded(score(3, { 2: { right: BACK() } }), [1, 2, 1, 2, 3]);
  const fragment = expanded(score(5, { 2: { right: BACK() }, 4: { right: BACK() } }), [1, 2, 1, 2, 3, 4, 3, 4, 5]);
  assert.deepEqual(fragment.navigation.sections.map(section => [section.start, section.end, section.implicitStart]), [[1, 2, true], [3, 4, true]]);
});

test('times="3" plays the passage three times', () => {
  expanded(score(4, { 2: { left: FWD }, 3: { right: BACK(3) } }), [1, 2, 3, 2, 3, 2, 3, 4]);
});

// ── voltas ─────────────────────────────────────────────────────────────────

test('first and second endings play on their own passes', () => {
  const xml = score(6, {
    2: { left: FWD },
    4: { left: ENDING(1, 'start'), right: ENDING(1, 'stop') + BACK() },
    5: { left: ENDING(2, 'start'), right: ENDING(2, 'discontinue') },
  });
  const fragment = expanded(xml, [1, 2, 3, 4, 2, 3, 5, 6]);
  assert.deepEqual(fragment.navigation.sections[0].endings.map(ending => [ending.numbers, ending.start, ending.end]), [[[1], 4, 4], [[2], 5, 5]]);
});

test('an ending that names several passes ("1, 2") and a third ending', () => {
  const xml = score(4, {
    2: { left: ENDING('1, 2', 'start'), right: ENDING('1, 2', 'stop') + BACK() },
    3: { left: ENDING(3, 'start'), right: ENDING(3, 'stop') },
  });
  expanded(xml, [1, 2, 1, 2, 1, 3, 4]);
});

test('an ending spanning several measures and exported as two segments across a system break is one ending', () => {
  const xml = score(7, {
    2: { left: FWD },
    4: { left: ENDING(1, 'start'), right: ENDING(1, 'stop') },
    5: { left: ENDING(1, 'start'), right: ENDING(1, 'stop') + BACK() },
    6: { left: ENDING(2, 'start'), right: ENDING(2, 'discontinue') },
  });
  const fragment = expanded(xml, [1, 2, 3, 4, 5, 2, 3, 6, 7]);
  assert.ok(fragment.warnings.some(item => item.code === 'VOLTA_SEGMENTS_JOINED' && item.measureIndex === 5));
  assert.deepEqual(fragment.navigation.sections[0].endings[0], { numbers: [1], start: 4, end: 5, repeats: true, segments: 2 });
});

test('a lone first ending that repeats leaves the last pass without a bracket', () => {
  expanded(score(3, { 2: { left: ENDING(1, 'start'), right: ENDING(1, 'stop') + BACK() } }), [1, 2, 1, 3]);
});

// ── jumps ──────────────────────────────────────────────────────────────────

test('D.S. al Coda: to the segno, then from To Coda to the coda', () => {
  const xml = score(7, {
    2: { start: direction('<segno/>', '<sound segno="segno"/>') },
    3: { end: direction(words('To Coda'), '<sound tocoda="coda"/>') },
    5: { end: direction(words('D.S. al Coda'), '<sound dalsegno="segno"/>') },
    6: { start: direction('<coda/>', '<sound coda="coda"/>') },
  });
  const fragment = expanded(xml, [1, 2, 3, 4, 5, 2, 3, 6, 7]);
  assert.deepEqual(fragment.navigation.jump, { kind: 'dalsegno', from: 5, to: 2, variant: 'al-coda', playRepeats: false, evidence: 'sound+words', toCoda: { from: 3, to: 6 }, fine: null });
});

test('To Coda drawn as a coda sign with a tocoda sound is a jump, not a second coda', () => {
  const xml = score(7, {
    2: { start: direction('<segno/>', '<sound segno="segno"/>') },
    3: { end: direction('<coda/>', '<sound tocoda="coda"/>') },
    5: { end: direction(words('D.S. al Coda'), '<sound dalsegno="segno"/>') },
    6: { start: direction('<coda/>', '<sound coda="coda"/>') },
  });
  expanded(xml, [1, 2, 3, 4, 5, 2, 3, 6, 7]);
});

test('D.C. al Fine: back to the start, stop at Fine', () => {
  const xml = score(4, {
    2: { end: direction(words('Fine'), '<sound fine="yes"/>') },
    4: { end: direction(words('D.C. al Fine'), '<sound dacapo="yes"/>') },
  });
  const fragment = expanded(xml, [1, 2, 3, 4, 1, 2]);
  assert.equal(fragment.navigation.jump.fine, 2);
});

test('navigation written only as direction words is read, and says so', () => {
  const xml = score(7, {
    2: { start: direction('<segno/>') },
    3: { end: direction(words('To Coda')) },
    5: { end: direction(words('D.S. al Coda')) },
    6: { start: direction(words('Coda')) },
  });
  const fragment = expanded(xml, [1, 2, 3, 4, 5, 2, 3, 6, 7]);
  assert.ok(fragment.warnings.filter(item => item.code === 'NAVIGATION_FROM_WORDS').length >= 2);
});

test('the word "Coda" as a section title, with no jump anywhere, is not navigation', () => {
  const fragment = expanded(score(3, { 3: { start: direction(words('Coda')) } }), [1, 2, 3]);
  assert.equal(fragment.navigation.expanded, false);
});

test('after a D.C. repeats are not re-taken and the last ending is played', () => {
  const plain = score(3, {
    1: { left: FWD },
    2: { right: BACK() + '', end: direction(words('Fine'), '<sound fine="yes"/>') },
    3: { end: direction(words('D.C. al Fine'), '<sound dacapo="yes"/>') },
  });
  expanded(plain, [1, 2, 1, 2, 3, 1, 2]);
  const voltas = score(4, {
    2: { left: ENDING(1, 'start'), right: ENDING(1, 'stop') + BACK() },
    3: { left: ENDING(2, 'start'), right: ENDING(2, 'discontinue'), end: direction(words('Fine'), '<sound fine="yes"/>') },
    4: { end: direction(words('D.C. al Fine'), '<sound dacapo="yes"/>') },
  });
  expanded(voltas, [1, 2, 1, 3, 4, 1, 3]);
});

test('a jump marked "with repeats" does re-take them', () => {
  const xml = score(3, {
    2: { right: BACK() },
    3: { end: direction(words('D.C. con rip.'), '<sound dacapo="yes"/>') },
  });
  expanded(xml, [1, 2, 1, 2, 3, 1, 2, 1, 2, 3]);
});

test('a jump on a measure that also ends a repeat is taken on the last pass, and says so', () => {
  const xml = score(2, {
    1: { end: direction(words('Fine'), '<sound fine="yes"/>') },
    2: { right: BACK(), end: direction(words('D.C. al Fine'), '<sound dacapo="yes"/>') },
  });
  const fragment = expanded(xml, [1, 2, 1, 2, 1]);
  assert.ok(fragment.warnings.some(item => item.code === 'NAVIGATION_JUMP_AFTER_REPEAT'));
});

test('segno and coda marks written only in the first part drive every part', () => {
  const xml = score(7, {
    2: { left: FWD },
    3: { right: BACK() },
  }, {
    parts: ['P1', 'P2'],
    partSpec: {
      P1: {
        4: { start: direction('<segno/>', '<sound segno="segno"/>') },
        5: { end: direction(words('To Coda'), '<sound tocoda="coda"/>') },
        6: { end: direction(words('D.S. al Coda'), '<sound dalsegno="segno"/>') },
        7: { start: direction('<coda/>', '<sound coda="coda"/>') },
      },
    },
  });
  const fragment = expanded(xml, [1, 2, 3, 2, 3, 4, 5, 6, 4, 5, 7]);
  assert.deepEqual(order(fragment, 'P2'), order(fragment, 'P1'));
  // Both parts wrote 4/4 at beat 0: one meter, both witnesses cited.
  assert.deepEqual(fragment.meterEvents.map(event => [event.beat, `${event.numerator}/${event.denominator}`]), [['0', '4/4']]);
  assert.equal(fragment.meterEvents[0].sourceEventIds.length, 2);
});

test('tempo and meter in force at a written measure are restated when playback returns to it', () => {
  const xml = score(4, {
    2: { left: FWD },
    3: { start: direction('<metronome><beat-unit>quarter</beat-unit><per-minute>80</per-minute></metronome>', '<sound tempo="80"/>'), right: BACK() },
  }, { tempo: 100 });
  const fragment = expanded(xml, [1, 2, 3, 2, 3, 4]);
  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm, event.metadata.restated === true]), [
    ['0', 100, false],
    ['8', 80, false],
    ['12', 100, true],
    ['16', 80, false],
  ]);
  const dotted = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice></note>';
  const metered = expanded(score(4, {
    2: { left: FWD },
    3: { start: '<attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>', content: dotted, right: BACK() },
    4: { content: dotted },
  }), [1, 2, 3, 2, 3, 4]);
  assert.deepEqual(metered.meterEvents.map(event => [event.beat, `${event.numerator}/${event.denominator}`, event.metadata.restated === true]), [
    ['0', '4/4', false],
    ['8', '3/4', false],
    ['11', '4/4', true],
    ['15', '3/4', false],
  ]);
  assert.deepEqual(metered.meterEvents[2].sourceEventIds, ['part:P1/measure:1/attributes/time:1']);
  const restated = fragment.tempoEvents.find(event => event.metadata.restated);
  assert.deepEqual(restated.sourceEventIds, ['part:P1/measure:1/direction/tempo:2']);
  assert.equal(restated.metadata.restatedFromMeasureIndex, 1);
});

// ── the real-world shape: a notation-software export, 91 written measures ──────

test('a 91-measure export with split voltas, segno, To Coda, D.S. al Coda and coda expands to pickup + 136 bars', () => {
  const spec = {};
  const put = (m, key, value) => { spec[m] = { ...(spec[m] ?? {}), [key]: `${spec[m]?.[key] ?? ''}${value}` }; };
  put(18, 'left', FWD);
  put(41, 'left', ENDING(1, 'start')); put(44, 'right', ENDING(1, 'stop'));
  put(45, 'left', ENDING(1, 'start')); put(49, 'right', ENDING(1, 'stop') + BACK());
  put(50, 'left', ENDING(2, 'start')); put(50, 'right', ENDING(2, 'discontinue'));
  put(26, 'start', direction('<segno/>', '<sound segno="segno"/>'));
  put(38, 'end', direction(words('To Coda'), '<sound tocoda="coda"/>'));
  put(66, 'end', direction(words('D.S. al Coda'), '<sound dalsegno="segno"/>'));
  put(67, 'start', direction('<coda/>', '<sound coda="coda"/>'));
  put(70, 'left', FWD);
  put(75, 'left', ENDING(1, 'start')); put(77, 'right', ENDING(1, 'stop') + BACK());
  put(78, 'left', ENDING(2, 'start')); put(78, 'right', ENDING(2, 'discontinue'));
  put(82, 'left', FWD);
  put(87, 'left', ENDING(1, 'start')); put(89, 'right', ENDING(1, 'stop') + BACK());
  put(90, 'left', ENDING(2, 'start')); put(91, 'right', ENDING(2, 'stop'));
  // Written 4/4, holding 1.5 beats, not marked implicit (divisions 2 here).
  spec[1] = { content: '<note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice></note><note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>' };
  const xml = score(91, spec).replace('<divisions>1</divisions>', '<divisions>2</divisions>').replaceAll('<duration>4</duration><voice>1</voice><type>whole</type>', '<duration>8</duration><voice>1</voice><type>whole</type>');
  const fragment = ingestMusicXML(xml, { sourceId: 'real-shape', label: 'Real-shape fixture' });
  assert.equal(fragment.complete, true, JSON.stringify(fragment.unsupported));
  assert.deepEqual(fragment.navigation.playbackOrder, [[1, 49], [18, 40], [50, 66], [26, 38], [67, 77], [70, 74], [78, 89], [82, 86], [90, 91]]);
  assert.equal(fragment.navigation.playedMeasures, 137);
  assert.equal(fragment.pickup.status, 'inferred');
  assert.deepEqual(fragment.meterEvents.map(event => [event.beat, `${event.numerator}/${event.denominator}`]), [['0', '2/4'], ['2', '4/4']]);
  const notes = fragment.events.filter(event => event.kind === 'note');
  assert.equal(notes.find(event => event.metadata.measureIndex === 2).start, '2');
  assert.equal(notes.reduce((end, event) => Math.max(end, Number(event.end)), 0), 2 + 136 * 4);
  assert.deepEqual(notes.filter(event => event.metadata.measureIndex === 26).map(event => event.metadata.pass), [1, 2, 3]);
  assert.deepEqual(fragment.warnings.map(item => item.code).sort(), ['PICKUP_INFERRED', 'VOLTA_SEGMENTS_JOINED']);
});

// ── ambiguity is refused, precisely, with the written order kept ──────────

test('ambiguous or unsupported navigation keeps the written order and marks the source incomplete', () => {
  refused(score(6, {
    2: { start: direction('<segno/>', '<sound segno="segno"/>') },
    4: { end: direction(words('D.S.'), '<sound dalsegno="segno"/>') },
    6: { end: direction(words('D.C.'), '<sound dacapo="yes"/>') },
  }), 'DA_CAPO', 'MULTIPLE_JUMPS');
  refused(score(4, { 2: { left: ENDING(1, 'start') } }), 'VOLTA_ENDING', 'ENDING_UNCLOSED');
  refused(score(4, {
    2: { left: ENDING(1, 'start'), right: ENDING(1, 'stop') },
    3: { left: ENDING(2, 'start'), right: ENDING(2, 'stop') },
  }), 'VOLTA_ENDING', 'ENDING_WITHOUT_REPEAT');
  refused(score(4, { 2: { left: FWD } }), 'REPEAT_BARLINE', 'UNMATCHED_FORWARD_REPEAT');
  refused(score(4, { 2: { left: FWD }, 3: { left: FWD }, 4: { right: BACK() } }), 'REPEAT_BARLINE', 'NESTED_OR_UNCLOSED_FORWARD_REPEAT');
  refused(score(4, { 2: { start: direction('<segno/>') } }), 'SEGNO', 'SEGNO_WITHOUT_JUMP');
  refused(score(4, { 3: { end: direction(words('D.S. al Coda'), '<sound dalsegno="segno"/>') }, 1: { start: direction('<segno/>') } }), 'TO_CODA', 'TO_CODA_MISSING');
  refused(score(4, { 3: { right: BACK(99) } }), 'REPEAT_BARLINE', 'REPEAT_TIMES_OVER_LIMIT');
  refused(score(4, { 3: { end: direction(words('D.C.'), '<sound dacapo="yes" time-only="2"/>') } }), 'NAVIGATION_PLAN', 'NAVIGATION_TIME_ONLY_UNSUPPORTED');
  refused(score(4, { 2: { start: '<direction><direction-type><segno/></direction-type><offset>2</offset></direction>' } }), 'SEGNO', 'SEGNO_MID_MEASURE');
  refused(score(4, {
    2: { start: direction('<segno/>', '<sound segno="a"/>') },
    3: { start: direction('<segno/>', '<sound segno="b"/>') },
    4: { end: direction(words('D.S.'), '<sound dalsegno="c"/>') },
  }), 'SEGNO', 'SEGNO_AMBIGUOUS');
  const { finding } = refused(score(4, { 3: { right: BACK() } }, { parts: ['P1', 'P2'], partSpec: { P2: { 3: { right: '' }, 2: { right: BACK() } } } }), 'REPEAT_BARLINE', 'PARTS_DISAGREE');
  assert.deepEqual(finding.partIds, ['P1', 'P2']);
});

test('a navigation mark where the reader does not look is reported, not ignored', () => {
  const hidden = score(2, { 1: { content: '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><notations><segno/></notations></note>' } });
  const fragment = ingestMusicXML(hidden, { sourceId: 'nav', label: 'Navigation fixture' });
  assert.equal(fragment.complete, false);
  assert.ok(fragment.unsupported.some(item => item.code === 'SEGNO' && item.reason === 'NAVIGATION_MARKER_UNACCOUNTED'));
});

test('the expansion is bounded: a plan longer than its cap is refused, never truncated', async () => {
  const { planPlayback } = await import('../backend/score/navigation.mjs');
  const measures = Array.from({ length: 4 }, () => ({ repeats: [], endings: [], markers: [], problems: [] }));
  measures[3].repeats.push({ direction: 'backward', times: '16', location: 'right' });
  const result = planPlayback({ parts: [{ partId: 'P1', measures }], measureCount: 4, limits: { maxRepeatTimes: 16, maxPlaybackMeasures: 20, maxPlaybackFactor: 16 } });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].reason, 'PLAYBACK_TOO_LONG');
  assert.equal(result.plan.length, 4);
});
