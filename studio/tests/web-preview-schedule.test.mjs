import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMML } from '../backend/mml/parser.mjs';
import { buildSchedule, channelFor, indexAt, soundingAt, tempoClock, velocityFor } from '../web/preview/schedule.mjs';

const song = mml => {
  const result = validateMML(mml, { meterText: '0 4/4' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.song;
};

test('beats become seconds through the exact tempo map, including a mid-song change', () => {
  const seconds = tempoClock([{ beat: '0', bpm: 120 }, { beat: '4', bpm: 60 }]);
  assert.equal(seconds('0'), 0);
  assert.equal(seconds('1'), 0.5);
  assert.equal(seconds('4'), 2);
  assert.equal(seconds('5'), 3);
  assert.equal(seconds('9/2'), 2.5);
  // 1/3 beat at 90 bpm is exactly 2/9 s; the float comes only at the end.
  assert.equal(tempoClock([{ beat: '0', bpm: 90 }])('1/3'), 2 / 9);
});

test('the validated Final song schedules every note with the owner model for volume and channel', () => {
  // Every role fills whole 4/4 bars, so the song validates as Final.
  const { events, duration } = buildSchedule(song('MML@t120o4v15c4v0d8r8e2,t120o3l1g,,,,;'));
  const ons = events.filter(e => e.type === 'on');
  assert.deepEqual(ons.map(e => [e.role, e.channel, e.pitch, e.velocity, e.time]), [
    [0, 0, 60, 127, 0],
    [1, 1, 55, 68, 0],
    [0, 0, 62, 1, 0.5],
    [0, 0, 64, 1, 1],
  ]);
  assert.equal(velocityFor(15), 127);
  assert.equal(velocityFor(0), 1, 'v0 is still a struck note in the owner model');
  assert.equal(velocityFor(8), 68);
  assert.equal(duration, 2);
  assert.equal(events.filter(e => e.type === 'off').length, ons.length);
});

test('a release sorts before an attack at the same instant, so repeated pitches re-strike', () => {
  const { events } = buildSchedule(song('MML@t120o4c4c4r2,,,,,;'));
  const atHalf = events.filter(e => e.time === 0.5).map(e => e.type);
  assert.deepEqual(atHalf, ['off', 'on']);
});

test('channels skip GM percussion and muted roles are left out', () => {
  assert.deepEqual([0, 5, 8, 9].map(channelFor), [0, 5, 8, 10]);
  const { events } = buildSchedule(song('MML@t120o4c1,t120o4e1,,,,;'), { muted: [true] });
  assert.ok(events.every(e => e.role === 1));
});

test('seeking finds the next event and re-strikes notes already sounding', () => {
  const { events } = buildSchedule(song('MML@t120o4c1,t120o4r4e4r2,,,,;'));
  assert.equal(events[indexAt(events, 0.5)].time, 0.5);
  const held = soundingAt(events, 0.75);
  assert.deepEqual(held.map(e => e.pitch).sort(), [60, 64]);
  assert.deepEqual(soundingAt(events, 1).map(e => e.pitch), [60], 'a note ending exactly at the seek point is not re-struck');
});
