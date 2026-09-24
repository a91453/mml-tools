// Gate 6 checks the preview scheduler; it must not share the scheduler's code.
//
// The player plays what studio/web/preview/schedule.mjs schedules, and a
// faithful engine processes exactly that. If the readback derived its
// expectation from the same tempoClock / channelFor / velocityFor, a fault in
// any of them would move playback and expectation together and Gate 6 would
// still report ENGINE_EVENTS_MATCH_EXACT_MML. These tests inject such faults
// into a copy of the scheduler and load readback.mjs next to that copy, the way
// it would be loaded in a build carrying the fault: whatever readback.mjs takes
// from schedule.mjs comes from the faulty copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateMML } from '../backend/mml/parser.mjs';
import { buildSchedule } from '../web/preview/schedule.mjs';
import { READBACK_KIND, READBACK_SCOPE, TIMING_TOLERANCE_SEC, compareReadback, expectedEvents, normalizeCapture } from '../web/preview/readback.mjs';

const SCHEDULE = new URL('../web/preview/schedule.mjs', import.meta.url).href;
const READBACK = new URL('../web/preview/readback.mjs', import.meta.url).href;
const RELATIVE_IMPORT = /(\b(?:from|import)\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g;

// A module from source text. A data: module has no base URL, so each relative
// specifier is made absolute against `base`; `swap` replaces chosen modules.
const asModule = (source, base, swap = {}) => `data:text/javascript,${encodeURIComponent(source.replace(RELATIVE_IMPORT, (_, lead, _quote, specifier) => {
  const url = new URL(specifier, base).href;
  return `${lead}${JSON.stringify(swap[url] ?? url)}`;
}))}`;

async function faultyPlayer(inject) {
  const original = await readFile(new URL(SCHEDULE), 'utf8');
  const faulty = inject(original);
  assert.notEqual(faulty, original, 'the fault was injected into the scheduler');
  const scheduleUrl = asModule(faulty, SCHEDULE);
  const readbackSource = await readFile(new URL(READBACK), 'utf8');
  return {
    schedule: await import(scheduleUrl),
    readback: await import(asModule(readbackSource, READBACK, { [SCHEDULE]: scheduleUrl })),
  };
}

// What a faithful engine reports for a player running `schedule` (or for one
// of its schedules): every event it scheduled, processed exactly on time, with
// the program loaded on the six role channels before the start.
function engineCapture(schedule, song) {
  const { events, duration } = schedule.buildSchedule ? schedule.buildSchedule(song) : schedule;
  return normalizeCapture({
    kind: READBACK_KIND, scope: READBACK_SCOPE, gameTimbreEquivalent: false, timeSource: 'engine',
    sessionId: 'session-1', capturedAt: '2026-09-24T00:00:00.000Z',
    bank: { name: 'fixture.sf2', sha256: 'a'.repeat(64) }, engine: { lib: 'spessasynth_lib@4.3.12', core: 'spessasynth_core@4.3.16' },
    program: { program: 0, bankMSB: 0, name: 'Fixture' }, audioContextState: 'running',
    muted: [false, false, false, false, false, false], complete: true, incomplete: [], from: 0, duration,
    events: events.map(event => [event.time, event.type === 'on' ? 1 : 0, event.channel, event.pitch, event.type === 'on' ? event.velocity : 0]),
    programs: [0, 1, 2, 3, 4, 5].map(channel => [-0.12, channel, 0, 0]),
  });
}

// Two different roles, a tempo change at beat 4 (t120 → t90) and three volumes.
const MML = 'MML@t120o4l4v12cdeft90v5gab>c,t120o3l2v8cet90gc,,,,;';
const parsed = (() => { const result = validateMML(MML, { meterText: '0 4/4' }); assert.equal(result.ok, true); return result.song; })();
const REAL = { buildSchedule };

test('a fault in the scheduler\'s tempoClock is a readback mismatch', async () => {
  assert.equal(compareReadback(parsed, engineCapture(REAL, parsed)).ok, true, 'the unmodified player matches');
  // The audit's demo fault: only the first tempo point is used.
  const { schedule, readback } = await faultyPlayer(source => source.replace('tempo?.length ? tempo :', 'tempo?.length ? tempo.slice(0, 1) :'));
  const played = schedule.buildSchedule(parsed).events.filter(event => event.channel === 0 && event.type === 'on').at(-1);
  assert.equal(played.time, 3.5, 'the faulty player strikes the last Melody note at t120 time');
  // Beat 7: four beats at t120 (2 s) and three at t90 (2 s).
  assert.equal(readback.expectedEvents(parsed).get(0).filter(event => event.on).at(-1).time, 4);
  const verdict = readback.compareReadback(parsed, engineCapture(schedule, parsed));
  assert.equal(verdict.ok, false, 'Gate 6 must not agree with a scheduler that ignores the tempo map');
  // The first event after the t90 change: the release at beat 5 (2.667 s,
  // played at 2.5 s) and Chord1's at beat 6 (3.333 s, played at 3 s).
  assert.deepEqual(verdict.errors, ['CHANNEL_0_EVENT_9_LATE: 167 ms from the tempo-map time', 'CHANNEL_1_EVENT_5_LATE: 333 ms from the tempo-map time']);
});

test('a fault in the scheduler\'s channelFor is a readback mismatch', async () => {
  assert.equal(compareReadback(parsed, engineCapture(REAL, parsed)).ok, true, 'the unmodified player matches');
  // Melody and Chord1 trade channels.
  const { schedule, readback } = await faultyPlayer(source => source.replace('(role < 9 ? role : role + 1)', '(role < 2 ? 1 - role : role < 9 ? role : role + 1)'));
  assert.deepEqual([0, 1, 2].map(schedule.channelFor), [1, 0, 2]);
  assert.deepEqual([...readback.expectedEvents(parsed).keys()], [0, 1], 'Melody on channel 0, Chord1 on channel 1');
  const verdict = readback.compareReadback(parsed, engineCapture(schedule, parsed));
  assert.equal(verdict.ok, false, 'Gate 6 must not agree with a scheduler that puts a role on the wrong channel');
  assert.ok(verdict.errors.includes('CHANNEL_0_EVENT_COUNT: expected 16, processed 8'), verdict.errors.join(' | '));
  assert.ok(verdict.errors.includes('CHANNEL_1_EVENT_COUNT: expected 8, processed 16'), verdict.errors.join(' | '));
});

test('a fault in the scheduler\'s velocityFor is a readback mismatch', async () => {
  assert.equal(compareReadback(parsed, engineCapture(REAL, parsed)).ok, true, 'the unmodified player matches');
  // Rounds down instead of to nearest: v12 → 101 instead of 102, v8 → 67 instead of 68.
  const { schedule, readback } = await faultyPlayer(source => source.replace('Math.round((Number(volume) * 127) / 15)', 'Math.floor((Number(volume) * 127) / 15)'));
  assert.deepEqual([12, 8, 5].map(schedule.velocityFor), [101, 67, 42]);
  const verdict = readback.compareReadback(parsed, engineCapture(schedule, parsed));
  assert.equal(verdict.ok, false, 'Gate 6 must not agree with a scheduler that maps volume to the wrong velocity');
  assert.ok(verdict.errors.includes('CHANNEL_0_EVENT_0: expected on 60 v102, processed on 60 v101'), verdict.errors.join(' | '));
  assert.ok(verdict.errors.includes('CHANNEL_1_EVENT_0: expected on 48 v68, processed on 48 v67'), verdict.errors.join(' | '));
});

test('readback.mjs reaches nothing of the scheduler it checks, directly or through another module', async () => {
  const seen = new Set();
  const walk = async url => {
    if (seen.has(url) || !url.startsWith('file:')) return;
    seen.add(url);
    const source = await readFile(new URL(url), 'utf8');
    for (const [, , , specifier] of source.matchAll(RELATIVE_IMPORT)) await walk(new URL(specifier, url).href);
  };
  await walk(READBACK);
  assert.ok(seen.size > 1, 'the import graph was walked');
  assert.equal(seen.has(SCHEDULE), false, [...seen].join('\n'));
});

// ─── property: random multi-tempo songs ─────────────────────────────────────
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const text = (n, d) => { const g = gcd(n, d); return d / g === 1n ? String(n / g) : `${n / g}/${d / g}`; };
// MML lengths in quarter-note beats (l1 … l64, dotted, tuplet lengths): 4/n and 6/n.
const LENGTHS = [1n, 2n, 3n, 4n, 6n, 8n, 12n, 16n, 24n, 32n, 48n, 64n].flatMap(n => [[4n, n], [6n, n]]);

// A song shaped like the parser's output: exact beat strings, integer BPM,
// monophonic roles with rests, V0–V15, some roles empty. The tempo map is
// sometimes absent (t120 default) or starts after beat 0.
function randomSong(next) {
  const pick = list => list[Math.floor(next() * list.length)];
  const D = 192n; // common denominator of every length above
  const tracks = Array.from({ length: 6 }, (_, role) => {
    if (role > 0 && next() < 0.3) return { role: ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'][role], events: [] };
    const events = [];
    let at = 0n;
    for (let count = 2 + Math.floor(next() * 30); count > 0; count--) {
      const [n, d] = pick(LENGTHS);
      const length = (n * D) / d;
      if (next() < 0.2) { at += length; continue; }
      events.push({ pitch: 24 + Math.floor(next() * 84), start: text(at, D), end: text(at + length, D), volume: Math.floor(next() * 16) });
      at += length;
    }
    return { role: ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'][role], events };
  });
  const tempo = [];
  const shape = next();
  if (shape > 0.1) {
    let at = shape < 0.2 ? BigInt(1 + Math.floor(next() * 4)) * 48n : 0n;
    for (let count = 1 + Math.floor(next() * 8); count > 0; count--) {
      tempo.push({ beat: text(at, D), bpm: 32 + Math.floor(next() * 224) });
      const [n, d] = pick(LENGTHS);
      at += (n * D) / d * BigInt(1 + Math.floor(next() * 6));
    }
  }
  return { tracks, tempo };
}

const byChannel = events => {
  const channels = new Map();
  for (const event of events) {
    if (!channels.has(event.channel)) channels.set(event.channel, []);
    channels.get(event.channel).push(event.type === 'on' ? { time: event.time, on: true, pitch: event.pitch, velocity: event.velocity } : { time: event.time, on: false, pitch: event.pitch });
  }
  return channels;
};
const TEMPO_FAULTS = {
  'only the first tempo point': 'tempo.slice(0, 1)',
  'the last tempo change dropped': '(tempo.length > 1 ? tempo.slice(0, -1) : tempo)',
  'every tempo one BPM fast': 'tempo.map(point => ({ ...point, bpm: point.bpm + 1 }))',
};

test('property: over random multi-tempo songs the unmodified scheduler matches the readback exactly, and a tempo-faulted one never passes', async () => {
  const faulty = {};
  for (const [name, replacement] of Object.entries(TEMPO_FAULTS)) faulty[name] = await faultyPlayer(source => source.replace('tempo?.length ? tempo :', `tempo?.length ? ${replacement} :`));
  const next = random(0x5eed6);
  const caught = Object.fromEntries(Object.keys(TEMPO_FAULTS).map(name => [name, 0]));
  let songs = 0, multiTempo = 0;
  for (let i = 0; i < 300; i++) {
    const song = randomSong(next);
    songs++;
    if (song.tempo.length > 1) multiTempo++;
    const notes = song.tracks.reduce((sum, track) => sum + track.events.length, 0);

    // Both implementations, event for event.
    const played = buildSchedule(song);
    const scheduled = byChannel(played.events);
    const expected = expectedEvents(song);
    assert.deepEqual([...expected.keys()], [...scheduled.keys()].sort((a, b) => a - b), `song ${i}: channels`);
    const untimed = list => list.map(({ time, ...event }) => event);
    for (const [channel, want] of expected) {
      const got = scheduled.get(channel);
      assert.deepEqual(untimed(got), untimed(want), `song ${i} channel ${channel}: order, pitch and velocity`);
      const off = want.findIndex((event, k) => !(Math.abs(got[k].time - event.time) <= 1e-9));
      assert.equal(off, -1, `song ${i} channel ${channel} event ${off}: ${got[off]?.time} vs ${want[off]?.time}`);
    }
    const verdict = compareReadback(song, engineCapture(played, song));
    assert.equal(verdict.ok, true, `song ${i}: ${verdict.errors.join(' | ')}`);
    assert.equal(verdict.maxDriftMs, 0);
    assert.equal(verdict.expectedNotes, notes);
    assert.equal(verdict.processedNotes, notes);

    // A tempo fault that moves any event past the tolerance is never a pass.
    for (const [name, { schedule, readback }] of Object.entries(faulty)) {
      const faultyPlayed = schedule.buildSchedule(song);
      assert.equal(faultyPlayed.events.length, played.events.length);
      const worst = Math.max(0, ...faultyPlayed.events.map((event, k) => Math.abs(event.time - played.events[k].time)));
      if (Math.abs(worst - TIMING_TOLERANCE_SEC) < 1e-6) continue; // too close to the tolerance to call
      const faultVerdict = readback.compareReadback(song, engineCapture(faultyPlayed, song));
      assert.equal(faultVerdict.ok, worst <= TIMING_TOLERANCE_SEC, `song ${i}, ${name}: moved ${worst} s, verdict ${JSON.stringify(faultVerdict.errors)}`);
      if (!faultVerdict.ok) caught[name]++;
    }
  }
  assert.equal(songs, 300);
  assert.ok(multiTempo > 150, `enough multi-tempo songs (${multiTempo})`);
  for (const [name, count] of Object.entries(caught)) assert.ok(count > 50, `${name}: caught in ${count} songs`);
});
