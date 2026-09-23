import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateMML } from '../backend/mml/parser.mjs';
import { PROBES, buildObservation, summarize } from '../web/engine-probe.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const fields = { outcome: 'n48-equals-o4c', client: 'TW', version: '1.2.3', instrument: 'Lute' };

test('every probe string is well-formed six-role MML the repo parser reads', () => {
  for (const probe of PROBES) {
    const result = validateMML(probe.mml, { meterText: '0 4/4', validationMode: 'ingest' });
    assert.equal(result.ok, true, `${probe.id}: ${JSON.stringify(result.errors)}`);
    assert.ok(probe.outcomes.length >= 3);
  }
});

test('the Nxx probe asks exactly the open question: o4c against n48 and n60', () => {
  const probe = PROBES.find(p => p.id === 'nxx-octave-v1');
  const events = validateMML(probe.mml, { meterText: '0 4/4', validationMode: 'ingest' }).song.tracks[0].events;
  // The repo's current reading, which the probe is designed to confirm or refute.
  assert.deepEqual(events.map(e => e.pitch), [60, 48, 60]);
});

test('the tie/length probe writes both spellings of the same 1.5-beat note', () => {
  const probe = PROBES.find(p => p.id === 'tie-length-order-v1');
  const tracks = validateMML(probe.mml, { meterText: '0 4/4', validationMode: 'ingest' }).song.tracks;
  assert.deepEqual(tracks[0].events, tracks[1].events);
  assert.deepEqual(tracks[0].events.map(e => [e.start, e.end]), [['0', '3/2']]);
});

test('an observation is bound to the exact test string and refuses incomplete context', () => {
  const probe = PROBES[0];
  const observation = buildObservation(probe, fields, { mmlSha256: sha(probe.mml), observedAt: '2026-09-23T00:00:00.000Z' });
  assert.equal(observation.evidenceClass, 'E');
  assert.equal(observation.mmlSha256, sha(probe.mml));
  assert.equal(observation.canonicalEffect, 'none-until-published');
  assert.throws(() => buildObservation(probe, { ...fields, outcome: 'maybe' }, { mmlSha256: sha(probe.mml) }), /請選擇/);
  assert.throws(() => buildObservation(probe, { ...fields, instrument: ' ' }, { mmlSha256: sha(probe.mml) }), /樂器/);
  assert.throws(() => buildObservation(probe, fields, { mmlSha256: 'x' }), /SHA-256/);
});

test('disagreeing observations are reported, never resolved', () => {
  const probe = PROBES[0];
  const a = buildObservation(probe, fields, { mmlSha256: sha(probe.mml) });
  const b = buildObservation(probe, { ...fields, outcome: 'n60-equals-o4c', client: 'KR' }, { mmlSha256: sha(probe.mml) });
  const [nxx] = summarize([a, b]);
  assert.equal(nxx.count, 2);
  assert.equal(nxx.consistent, false);
  assert.deepEqual(nxx.outcomes.sort(), ['n48-equals-o4c', 'n60-equals-o4c']);
});
