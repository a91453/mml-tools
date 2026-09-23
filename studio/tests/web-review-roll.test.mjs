import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalMeterEvent, createCanonicalNoteEvent, createCanonicalProject, createSource } from '../backend/canonical/index.mjs';
import {
  DEFAULT_ZOOM, GUTTER_W, HIT_RADIUS, RULER_H, ZOOM_H, ZOOM_W,
  barStarts, beatDivisions, beatNumber, eachEvent, hitTest, parseBeat, pinchAxis, pitchName, pitchSpan, prepareProjection, zoomScroll, zoomStep, zoomTick,
} from '../web/roll-geometry.mjs';
import { buildRollProjection } from '../web/roll-model.mjs';

const source = createSource({ id: 'fixture:roll', label: 'roll fixture', kind: 'official-midi', authority: 'primary-symbolic' });
const note = (id, pitch, start, end, role = null) => createCanonicalNoteEvent({ id, pitch, start, end, role, sourceIds: [source.id] });
function project(events, meters = []) {
  return createCanonicalProject({ id: 'fixture:roll:project', title: 'roll', sources: [source], events, meterEvents: meters, metadata: { sourceComplete: true } });
}

test('bar lines follow the meter map exactly; a mid-bar change starts a bar; no map means no bars', () => {
  const meters = [
    { beat: '0', numerator: 4, denominator: 4 },
    { beat: '6', numerator: 3, denominator: 8 },  // lands mid-bar 2: bar 2 is cut to 2 beats
  ];
  const bars = barStarts(meters, '12', { padBeats: 0 });
  assert.deepEqual(bars.map(b => b.beat), ['0', '4', '6', '15/2', '9', '21/2', '12']);
  assert.deepEqual(bars.map(b => b.changed), [true, false, true, false, false, false, false]);
  assert.deepEqual(barStarts([], '12'), [], 'Studio never assumes 4/4');
  // 7/16 for a long run stays exact: bar 300 starts at 300 * 7/4 beats.
  const odd = barStarts([{ beat: '0', numerator: 7, denominator: 16 }], '600', { padBeats: 0 });
  assert.equal(odd[300].beat, '525');
});

test('zoom keeps the content under the anchor fixed, measured in beats, with no drift over many steps', () => {
  let scroll = 1234;
  let size = DEFAULT_ZOOM.w;
  const anchor = 300;
  const beatUnder = () => (scroll + anchor) / size;
  const before = beatUnder();
  for (const dir of [1, 1, 1, -1, -1, 1, -1, -1, -1, 1]) {
    const next = zoomStep(ZOOM_W, size, dir);
    if (next === null) continue;
    scroll = zoomScroll(scroll, anchor, size, next);
    size = next;
  }
  assert.ok(Math.abs(beatUnder() - before) < 1e-9);
  assert.equal(zoomStep(ZOOM_W, ZOOM_W.at(-1), 1), null);
  assert.equal(zoomStep(ZOOM_H, 7, 1), null, 'an off-table value is never silently snapped');
  assert.equal(zoomScroll(0, 10, 48, 12), 0, 'scroll never goes negative');
});

test('pinch decides one axis from spread change, not from finger angle, and steps by ratio', () => {
  assert.equal(pinchAxis({ x: 100, y: 60 }, { x: 100, y: 60 }, 0), null, 'no spread change');
  assert.equal(pinchAxis({ x: 160, y: 62 }, { x: 100, y: 60 }, 3), 'w');
  assert.equal(pinchAxis({ x: 102, y: 120 }, { x: 100, y: 60 }, 3), 'h');
  assert.equal(pinchAxis({ x: 130, y: 60 }, { x: 100, y: 60 }, 80), null, 'moving both fingers together is a pan');
  assert.equal(pinchAxis({ x: 10, y: 120 }, { x: 20, y: 60 }, 0), 'h', 'a near-zero axis never decides');
  assert.equal(zoomTick(140, 100), 1);
  assert.equal(zoomTick(70, 100), -1);
  assert.equal(zoomTick(110, 100), 0);
});

test('grid density follows line spacing', () => {
  assert.equal(beatDivisions(12), 1);
  assert.equal(beatDivisions(48), 4);
  assert.equal(beatDivisions(256), 16);
});

test('the projection keeps every note, exact beats, unassigned material and harmony signals', () => {
  const candidate = project([
    note('m1', 72, '0', '1/3', 'Melody'),
    note('m2', 74, '1/3', '2/3', 'Melody'),
    note('c1', 60, '0', '2', 'Chord1'),
    note('c5', 48, '1', '3/2', 'Chord5'),
    note('u1', 110, '2', '5/2', null),
  ], [createCanonicalMeterEvent({ id: 'meter:0', beat: '0', numerator: 3, denominator: 4, sourceIds: [source.id] })]);
  const harmony = { conflicts: [{ leftEventId: 'm1', rightEventId: 'c1', start: '0', end: '1/3', intervalName: 'm9', leftRole: 'Melody', rightRole: 'Chord1', resolved: false }] };
  const roll = buildRollProjection(candidate, { harmony });
  const all = [...eachEvent(roll)];
  assert.equal(all.length, candidate.events.filter(e => e.kind === 'note').length, 'nothing dropped');
  assert.deepEqual(roll.lanes[0].events.map(e => [e.id, e.start, e.end]), [['m1', '0', '1/3'], ['m2', '1/3', '2/3']]);
  assert.deepEqual(roll.unassigned.map(e => e.id), ['u1'], 'unassigned stays visible, pitch 110 is not folded');
  assert.equal(roll.unassigned[0].pitch, 110);
  assert.equal(roll.end, '5/2');
  assert.deepEqual(roll.meters, [{ beat: '0', numerator: 3, denominator: 4 }]);
  assert.deepEqual(roll.signals, [{ kind: 'harmony', index: 0, form: 0, start: '0', end: '1/3', eventIds: ['m1', 'c1'], label: 'm9 · Melody / Chord1', resolved: false }]);
  assert.equal(buildRollProjection(null), null);
  JSON.parse(JSON.stringify(roll)); // structured-clone/JSON safe: no BigInt leaks out of the worker
  assert.equal(pitchSpan(roll).high, 113);
});

test('hit testing returns event IDs, never times; a fingertip gets the nearest note', () => {
  const roll = prepareProjection(buildRollProjection(project([
    note('a', 60, '0', '1', 'Melody'),
    note('b', 64, '1', '2', 'Chord1'),
  ])));
  const span = pitchSpan(roll);
  const view = { pxPerBeat: 48, rowH: 8, scrollX: 0, scrollY: 0, width: 600, height: 300, low: span.low, high: span.high };
  const yOf = pitch => RULER_H + (view.high - pitch) * view.rowH + view.rowH / 2;
  assert.deepEqual(hitTest(roll, view, GUTTER_W + 10, yOf(60)), { id: 'a', lane: 0 });
  assert.deepEqual(hitTest(roll, view, GUTTER_W + 60, yOf(64)), { id: 'b', lane: 1 });
  assert.equal(hitTest(roll, view, GUTTER_W + 10, yOf(62)), null, 'a mouse miss selects nothing');
  assert.deepEqual(hitTest(roll, view, GUTTER_W + 10, yOf(61), { radius: HIT_RADIUS }), { id: 'a', lane: 0 });
  assert.equal(hitTest(roll, view, GUTTER_W + 10, yOf(60), { visible: [false, true, true, true, true, true, true] }), null, 'hidden lanes are not hit');
  assert.equal(hitTest(roll, view, 5, yOf(60)), null, 'the keyboard gutter is not the score');
});

test('exact beats survive parsing and display conversion only happens at the end', () => {
  assert.deepEqual(parseBeat('6/4'), { n: 3n, d: 2n });
  assert.equal(beatNumber('1/3'), 1 / 3);
  assert.throws(() => parseBeat('0.5'), /not an exact beat/);
  assert.equal(pitchName(60), 'C4');
  assert.equal(pitchName(61), 'C#4');
});

test('the Full6 15-pair review becomes overlap and crowding signals tied to event IDs', () => {
  const roll = buildRollProjection(project([
    note('m', 67, '0', '2', 'Melody'),
    note('c2', 67, '1', '3', 'Chord2'),      // same pitch, overlapping 1..2
    note('c3', 50, '0', '1', 'Chord3'),
    note('c4', 51, '0', '1', 'Chord4'),      // m2 below pitch 60
  ]));
  const overlap = roll.signals.find(s => s.kind === 'overlap');
  assert.equal(overlap.start, '1');
  assert.equal(overlap.end, '2');
  assert.deepEqual(overlap.eventIds.sort(), ['c2', 'm']);
  assert.equal(overlap.form, undefined, 'only harmony conflicts have an arbitration form');
  const crowding = roll.signals.find(s => s.kind === 'crowding');
  assert.deepEqual(crowding.eventIds.sort(), ['c3', 'c4']);
  assert.deepEqual(roll.signals.map(s => s.index), roll.signals.map((_, i) => i), 'index is the position in the list');
});
