// Studio Workshop ⇄ Studio Web hand-off: the MML conversion keeps the pitch
// each page's own parser reads (the two disagree on Nxx; LG-1), and the
// return record can never carry a verification claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAll } from '../web/workshop/mml.mjs';
import { workshopToStudio, studioToWorkshop, rewriteTrack, N_OFFSET } from '../web/workshop/studio-mml.mjs';
import { parseTrack as studioTrack, splitMML as studioSplit } from '../backend/mml/parser.mjs';
import {
  projectSources, putReturn, takeReturn, workshopUrl, parseWorkshopHash, parseReturnHash,
  returnFileName, RETURN_KEY, RETURN_TTL_MS, UNVERIFIED_LABEL,
} from '../web/workshop-link.mjs';

const workshopPitches = texts => parseAll(texts).tracks.map(t => t.notes.map(n => n.midi));
const studioPitches = mml => studioSplit(mml).map(part => studioTrack(part, 'Melody', { mode: 'ingest' }).events.filter(e => e.pitch !== undefined && e.pitch !== null).map(e => e.pitch));

test('Workshop → Studio keeps every pitch as Studio reads it, with six slots', () => {
  const texts = ['t120l4o4cdn48e', 'l4o3h8p8c#4d', 'o5l8n60n36', '', '', '', 'l4o4c'];
  const { mml, warnings, dropped } = workshopToStudio(texts);
  assert.match(mml, /^MML@[^;]*;$/);
  assert.equal(mml.slice(4, -1).split(',').length, 6);
  assert.deepEqual(dropped, [6], 'the auxiliary track is reported, not sent');
  assert.ok(warnings.some(w => w.code === 'N_REWRITTEN' && w.track === 0));
  assert.equal(mml, 'MML@t120l4o4cdn60e,l4o3b8r8c+4d,o5l8n72n48,,,;', 'h/p/# rewritten, Nxx shifted to Studio\'s reading');
  const want = workshopPitches(texts.slice(0, 6));
  const got = studioPitches(mml);
  assert.deepEqual(got.slice(0, 3), want.slice(0, 3));
  assert.equal(N_OFFSET, 12);
});

test('Studio → Workshop keeps every pitch as the Workshop reads it', () => {
  const studio = 'MML@t120o4c4n60e4,l8o3n48c,,,,;';
  const { mml, parts } = studioToWorkshop(studio);
  assert.equal(mml, 'MML@t120o4c4n48e4,l8o3n36c,,,,;');
  assert.deepEqual(workshopPitches(parts).slice(0, 2), studioPitches(studio).slice(0, 2));
  assert.deepEqual(rewriteTrack('n5c', { nDelta: -12 }), { text: 'n5c', warnings: ['N_OUT_OF_RANGE'] }, 'an unconvertible Nxx is kept, never folded');
});

test('project sources list the Final/delivery MML and only MML assets', () => {
  const workspace = {
    id: 'p1', deliveryMml: ' MML@t120o4c1,,,,,; ',
    assets: {
      candidate: { format: 'MML', name: 'cand.mml', content: 'MML@t120o4d1,,,,,;' },
      baseline: { format: 'MusicXML', name: 'b.musicxml', content: '<score-partwise/>' },
      previous: { format: 'MML', name: 'prev.mml', content: 'not mml' },
    },
  };
  assert.deepEqual(projectSources(workspace).map(s => [s.slot, s.mml]), [['delivery', 'MML@t120o4c1,,,,,;'], ['candidate', 'MML@t120o4d1,,,,,;']]);
  assert.deepEqual(projectSources(null), []);
  const url = workshopUrl('p 1', 'delivery');
  assert.equal(url, './studio/web/workshop/index.html#studio-project=p+1&asset=delivery');
  assert.deepEqual(parseWorkshopHash(url.slice(url.indexOf('#'))), { projectId: 'p 1', slot: 'delivery' });
  assert.equal(parseWorkshopHash('#asset=x'), null);
});

test('the return record is read once, expires, and is never a verification claim', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  const now = Date.UTC(2026, 8, 23);
  const id = putReturn({ mml: 'MML@t120o4c1,,,,,;', name: 'Song', origin: { projectId: 'p1' }, warnings: ['w'] }, storage, now);
  assert.ok(store.has(RETURN_KEY));
  assert.equal(takeReturn('other-id', storage, now), null, 'another id is not imported');
  assert.ok(store.has(RETURN_KEY), 'and does not consume the record');
  const record = takeReturn(id, storage, now + 1000);
  assert.deepEqual({ ...record, at: undefined }, { id, at: undefined, mml: 'MML@t120o4c1,,,,,;', name: 'Song', origin: { projectId: 'p1' }, warnings: ['w'], label: UNVERIFIED_LABEL, verified: false });
  assert.equal(takeReturn(id, storage, now + 2000), null, 'read once');

  const stale = putReturn({ mml: 'MML@c,,,,,;' }, storage, now);
  assert.equal(takeReturn(stale, storage, now + RETURN_TTL_MS + 1), null, 'expired');
  store.set(RETURN_KEY, JSON.stringify({ schema: 'mml-studio/workshop-return@1', id: 'x', at: now, mml: 'MML@c,,,,,;', verified: true, state: 'VALIDATED' }));
  assert.equal(takeReturn('x', storage, now).verified, false, 'a forged claim is dropped');
  assert.equal(takeReturn('x', storage, now), null);
  assert.throws(() => putReturn({ mml: 'not mml' }, storage, now), /WORKSHOP_RETURN_INVALID/);
  assert.equal(parseReturnHash('#workshop-return=abc'), 'abc');
  assert.equal(returnFileName({ name: 'My/Song' }, new Date(Date.UTC(2026, 8, 23, 4, 5))), 'My_Song-workshop-edit-202609230405.mml');
});
