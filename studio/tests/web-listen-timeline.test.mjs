import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListening } from '../web/listen-model.mjs';
import {
  barIndexAt, barStart, beatInBarLabel, changedBars, changedPlaybackPlan, changedRegions, diffSongs, formatClock, listenBars, parseClock,
  parseMeterText, positionAt, positionAtNumber, preRollStart, rollProjection, seekPlan, snapToMeterBeat, songClock, songsEnd,
} from '../web/listen-timeline.mjs';

// Synthetic MML only.
const song = mml => { const result = parseListening(mml); assert.equal(result.ok, true, JSON.stringify(result.errors)); return result.song; };

test('the listening parser reads the repository parser exactly and reports what it cannot read', () => {
  const s = song('MML@t120o4l4cd8.e16f2&f4,t120o3l1c,,,,;');
  assert.deepEqual(s.tracks[0].events.map(e => [e.pitch, e.start, e.end]), [[60, '0', '1'], [62, '1', '7/4'], [64, '7/4', '2'], [65, '2', '5']]);
  assert.equal(s.total, '5');
  assert.deepEqual(s.tempo, [{ beat: '0', bpm: 120 }]);
  const bad = parseListening('MML@t120c4,,,,,;');
  assert.equal(bad.ok, false, 'a note before any octave is an error, not a guess');
  assert.ok(bad.errors.some(error => error.role === 'Melody'));
  assert.equal(parseListening('MML@c,d;').ok, false);
  assert.equal(parseListening('MML@,,,,,;').errors.at(-1).code, 'ALL_ROLES_EMPTY');
  // Caution forms a candidate may carry are warnings when listening.
  assert.equal(parseListening('MML@t120o4c6c6c6,,,,,;').ok, true);
});

test('bars come from the meter text; without one they are 4/4 and marked assumed', () => {
  const assumed = listenBars(null, '10');
  assert.equal(assumed.assumed, true);
  assert.deepEqual(assumed.bars.map(b => [b.number, b.start, b.end, b.partial]), [[1, '0', '4', false], [2, '4', '8', false], [3, '8', '12', false]]);
  const mixed = listenBars('0 2/4\n2 4/4\n10 6/8', '16');
  assert.equal(mixed.assumed, false);
  assert.deepEqual(mixed.bars.map(b => [b.start, b.end, `${b.numerator}/${b.denominator}`]), [['0', '2', '2/4'], ['2', '6', '4/4'], ['6', '10', '4/4'], ['10', '13', '6/8'], ['13', '16', '6/8']]);
  // A meter change inside a bar cuts that bar short at the change.
  const cut = listenBars('0 4/4\n6 3/4', '9');
  assert.deepEqual(cut.bars.map(b => [b.start, b.end, b.partial]), [['0', '4', false], ['4', '6', true], ['6', '9', false]]);
  // Decimal and fractional meter beats stay exact.
  assert.deepEqual(parseMeterText('0 4/4\n6.5 3/8\n15/2 2/4'), [{ beat: '0', numerator: 4, denominator: 4 }, { beat: '13/2', numerator: 3, denominator: 8 }, { beat: '15/2', numerator: 2, denominator: 4 }]);
  assert.throws(() => parseMeterText('2 4/4'), /第 0 拍/);
  assert.throws(() => parseMeterText('0 4/5'), /2 次方/);
  assert.equal(listenBars('', '0').bars.length, 1, 'there is always a bar');
});

test('positions: bar, beat-in-bar in the meter unit, exact to the fraction', () => {
  const { bars } = listenBars('0 4/4\n8 6/8', '20');
  assert.deepEqual(positionAt(bars, '0'), { bar: 1, beat: '1', offset: '0', exact: '0' });
  assert.deepEqual(positionAt(bars, '13/2'), { bar: 2, beat: '3+1/2', offset: '5/2', exact: '13/2' });
  // 6/8 counts eighths: beat 9 is the 3rd eighth of bar 3.
  assert.equal(positionAt(bars, '9').beat, '3');
  assert.equal(beatInBarLabel('3/4', 8), '2+1/2');
  assert.equal(barIndexAt(bars, '1000'), bars.length - 1);
  assert.deepEqual(positionAtNumber(bars, 6.4), { bar: 2, beat: 3 });
  assert.equal(snapToMeterBeat(bars, 6.4), '6');
  assert.equal(snapToMeterBeat(bars, 9.7), '19/2', 'snaps to the eighth in 6/8');
});

test('clock: beats to seconds through the exact tempo map, and back for display', () => {
  const s = song('MML@t120o4l1cct60cc,,,,,;');
  const clock = songClock(s);
  assert.equal(clock.secondsAt('4'), 2);
  assert.equal(clock.secondsAt('8'), 4);
  assert.equal(clock.secondsAt('12'), 8);
  assert.equal(clock.duration, 12);
  assert.equal(clock.beatAt(3), 6);
  assert.equal(clock.beatAt(6), 10, 'after the change to 60 bpm a second is one beat');
  assert.equal(clock.beatAt(1), 2);
  assert.equal(songClock(null).secondsAt('4'), 2, 'no tempo map reads as 120 bpm');
  assert.equal(formatClock(65.25, 2), '1:05.25');
  assert.equal(formatClock(3725, 0), '1:02:05');
  assert.equal(parseClock('1:05.25'), 65.25);
  assert.equal(parseClock('75'), 75);
  assert.equal(parseClock('1:02:05'), 3725);
  assert.throws(() => parseClock('1:75'));
  assert.throws(() => parseClock('abc'));
});

test('seek maths: play from a bar starts on its barline; a marker gets whole bars of lead-in', () => {
  const s = song('MML@t120o4l1cccccccc,,,,,;');
  const { bars } = listenBars('0 4/4', s.total);
  const clock = songClock(s);
  assert.equal(barStart(bars, 3), '8');
  assert.throws(() => barStart(bars, 0));
  assert.throws(() => barStart(bars, 9));
  assert.deepEqual(seekPlan({ bars, clock, beat: barStart(bars, 3) }), { fromBeat: '8', targetBeat: '8', fromSeconds: 4, targetSeconds: 4, untilBeat: null, untilSeconds: null });
  // A marker in the middle of bar 5 with one bar of lead-in starts at bar 4.
  assert.equal(preRollStart(bars, '35/2', 1), '12');
  const marker = seekPlan({ bars, clock, beat: '35/2', preRollBars: 1 });
  assert.equal(marker.fromSeconds, 6);
  assert.equal(marker.targetSeconds, 8.75);
  assert.equal(preRollStart(bars, '2', 1), '0', 'never before the first bar');
  assert.equal(preRollStart(bars, '35/2', 0), '16');
  assert.equal(preRollStart(bars, '35/2', 2), '8');
  const ranged = seekPlan({ bars, clock, beat: '16', preRollBars: 1, untilBeat: '20' });
  assert.deepEqual([ranged.fromSeconds, ranged.untilSeconds], [6, 10]);
});

test('changed bars: an event-level diff per role, pitch, onset, duration, volume and tempo', () => {
  const before = song('MML@t120o4l4cdefgabcdefg,t120o3l1ccc,t120o2l2cccccc,,,;');
  const after = song('MML@t120o4l4cdefgab>c<defg,t120o3l1ccc,t120o2l2ccccv12cc,,t120o5r1r1c4,;');
  const changes = diffSongs(before, after);
  assert.deepEqual(changes.map(c => [c.role, c.type, c.start, c.fields ?? null]), [
    [2, 'modified', '8', ['volume']], [2, 'modified', '10', ['volume']],
    [4, 'added', '8', null],
    [0, 'modified', '7', ['pitch']],
  ].sort((a, b) => Number(a[2]) - Number(b[2]) || a[0] - b[0]));
  const { bars } = listenBars(null, songsEnd(before, after));
  const touched = changedBars(changes, bars);
  assert.deepEqual(touched.map(b => [b.number, b.roles]), [[2, ['Melody']], [3, ['Chord2', 'Chord4']]]);
  assert.deepEqual(touched[1].counts, { added: 1, removed: 0, modified: 2, tempo: 0 });
  assert.deepEqual(changedRegions(touched).map(r => [r.fromBar, r.toBar, r.start, r.end]), [[2, 3, '4', '12']]);
  // Identical songs: nothing changed.
  assert.deepEqual(diffSongs(before, before), []);
  // A held note whose duration changed touches every bar it covers.
  const long = diffSongs(song('MML@t120o4c1r1r1,,,,,;'), song('MML@t120o4c1&c1r1,,,,,;'));
  assert.deepEqual(long.map(c => [c.type, c.fields, c.start, c.end]), [['modified', ['duration'], '0', '8']]);
  assert.deepEqual(changedBars(long, listenBars(null, '12').bars).map(b => b.number), [1, 2]);
  // Tempo changes are changes too, in the bar they happen.
  const tempo = diffSongs(song('MML@t120o4l1cccc,,,,,;'), song('MML@t120o4l1cct90cc,,,,,;'));
  assert.deepEqual(tempo.map(c => [c.type, c.start, c.before, c.after]), [['tempo', '8', null, 90]]);
  assert.deepEqual(changedBars(tempo, listenBars(null, '16').bars).map(b => [b.number, b.roles, b.counts.tempo]), [[3, [], 1]]);
  // Removals are reported as removals.
  assert.deepEqual(diffSongs(song('MML@t120o4cde,,,,,;'), song('MML@t120o4cd,,,,,;')).map(c => [c.type, c.start]), [['removed', '2']]);
});

test('"play changed bars only" plays each region in order with bars of lead-in, ending at the region end', () => {
  const s = song('MML@t120o4l1cccccccccc,,,,,;');
  const { bars } = listenBars('0 4/4', s.total);
  const regions = changedRegions([{ number: 3, start: '8', end: '12', roles: ['Melody'] }, { number: 4, start: '12', end: '16', roles: ['Chord1'] }, { number: 8, start: '28', end: '32', roles: ['Melody'] }]);
  assert.deepEqual(regions.map(r => [r.fromBar, r.toBar, r.roles]), [[3, 4, ['Melody', 'Chord1']], [8, 8, ['Melody']]]);
  const plan = changedPlaybackPlan({ regions, bars, clock: songClock(s), preRollBars: 1 });
  assert.deepEqual(plan.map(p => [p.fromBeat, p.untilBeat, p.fromSeconds, p.untilSeconds]), [['4', '16', 2, 8], ['24', '32', 12, 16]]);
  // The old version keeps its own tempo: the same bars at a different speed.
  const slow = song('MML@t60o4l1cccccccccc,,,,,;');
  assert.deepEqual(changedPlaybackPlan({ regions, bars, clock: songClock(slow), preRollBars: 1 }).map(p => [p.fromSeconds, p.untilSeconds]), [[4, 16], [24, 32]]);
});

test('the listening roll projection keeps every note, exactly, per role', () => {
  const s = song('MML@t120o4c4d4,t120o3e2,,,,t120o5r2c8;');
  const projection = rollProjection(s, listenBars(null, s.total).meters);
  assert.deepEqual(projection.lanes.map(l => l.events.length), [2, 1, 0, 0, 0, 1]);
  assert.deepEqual(projection.lanes[5].events[0], { id: 'Chord5#1', pitch: 72, start: '2', end: '5/2' });
  assert.equal(projection.end, '5/2');
  assert.deepEqual(projection.meters, [{ beat: '0', numerator: 4, denominator: 4 }]);
});
