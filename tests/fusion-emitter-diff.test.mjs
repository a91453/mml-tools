// Fusion emitter diff harness (scripts/fusion-emitter-diff.mjs).
//
// Needs the owner-authorized third-party bundle ("MML 工房"), which is never
// committed: set MML_WORKSHOP_FE to the directory that contains
// js/mml-compress.js. Without it every test here is reported as SKIPPED — a
// skipped run proves nothing and is not a pass
// (docs/FRONTEND_FUSION_ANALYSIS_2026-09-23.md §11.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWorkshop,
  loadWorkshop,
  runSongCase,
  runNxxDiff,
  readRole,
  compareExact,
  ensureExplicitOctave,
  songReferenceInputs,
  SYNTHETIC_CASES,
  FE_VARIANTS,
} from '../scripts/fusion-emitter-diff.mjs';

const located = resolveWorkshop();
const skip = located.ok ? false : `SKIPPED: ${located.reason} — the third-party bundle is required; this is not a pass`;
let workshopPromise = null;
const workshop = () => (workshopPromise ??= loadWorkshop(located.dir));

test('every in-memory patch finds its anchor and every variant loads', { skip }, async () => {
  const loaded = await workshop();
  assert.deepEqual(Object.keys(loaded.variants).sort(), Object.keys(FE_VARIANTS).sort());
  for (const variant of Object.values(loaded.variants)) assert.equal(typeof variant.module.itemsToMML, 'function');
  for (const sha of Object.values(loaded.provenance)) assert.match(sha, /^[0-9a-f]{64}$/);
});

test('the exact judge rejects pairs the third-party float judge accepts', { skip }, async () => {
  const { stock, mml } = await workshop();
  for (const [left, right] of [['t120o0c', 't120o1c'], ['t120o4n48', 't120o4c'], ['t120o8c', 't120o7c']]) {
    assert.equal(stock.sameEvents(mml.parseAll([left]), mml.parseAll([right])), true, `${left} ≡ ${right} to sameEvents`);
    assert.equal(compareExact(readRole(left, 'Melody'), readRole(right, 'Melody')).equal, false, `${left} ≠ ${right} to the repo parser`);
  }
});

test('Nxx and o0/o8 readings differ exactly as LG-1 predicts', { skip }, async () => {
  const rows = runNxxDiff(await workshop());
  const at = (mml, index = 0) => rows.find(row => row.mml === mml && row.index === index);
  assert.deepEqual([at('t120o4n60').fe, at('t120o4n60').repo], [72, 60]);
  assert.deepEqual([at('t120o4n24').fe, at('t120o4n24').repo], [36, 24]);
  // In-range named notes agree; the third-party parser folds o0/o8 into o1–o7.
  assert.deepEqual([at('t120o4c').fe, at('t120o4c').repo], [60, 60]);
  assert.deepEqual([at('t120o0c').fe, at('t120o0c').repo], [24, 12]);
  assert.deepEqual([at('t120o8c').fe, at('t120o8c').repo], [96, 108]);
  assert.ok(at('t120o8c').repoFinalCodes.includes('NAMED_NOTE_FINAL_RANGE_UNVERIFIED'));
  assert.ok(at('t120o4n60').repoFinalCodes.includes('NUMERIC_NOTE_OPT_IN_REQUIRED'));
});

test('first-octave post-fix only ever adds an explicit oN', { skip }, () => {
  assert.deepEqual(ensureExplicitOctave('t120>c'), { text: 't120o5c', added: 1 });
  assert.deepEqual(ensureExplicitOctave('t120r4<b+'), { text: 't120r4o3b+', added: 1 });
  assert.deepEqual(ensureExplicitOctave('t120c'), { text: 't120o4c', added: 2 });
  assert.deepEqual(ensureExplicitOctave('t120o3c>c'), { text: 't120o3c>c', added: 0 });
});

test('Final-constrained third-party output is exact and legal; regions account for every character', { skip }, async () => {
  const loaded = await workshop();
  const cases = [
    ...songReferenceInputs().filter(input => input.id.endsWith('current-accepted.mml')),
    ...SYNTHETIC_CASES.filter(item => ['tempo-mid-note', 'octave-boundary', 'dotted-lengths', 'long-rests', 'dot-tail-32'].includes(item.id)),
  ];
  assert.ok(cases.length >= 5, 'song reference and synthetic inputs are present');
  for (const input of cases) {
    const result = await runSongCase(loaded, input);
    assert.equal(result.repo.ok, true, `${input.id}: repo emitter`);
    for (const row of result.rows) {
      const label = `${input.id}/${row.input}/${row.role}`;
      assert.equal(row.repoEqualsSource, true, `${label}: repo output reads back as the source`);
      const legal = row.variants.final;
      assert.equal(legal.ok, true, `${label}: Final-constrained variant emits`);
      assert.equal(legal.eventsEqual && legal.endEqual, true, `${label}: exact events and end`);
      assert.deepEqual(legal.finalErrors, [], `${label}: passes repo Final validation`);
      for (const variant of Object.values(row.variants).filter(entry => entry.ok && entry.regions)) {
        const sum = variant.regions.reduce((acc, region) => acc + region.delta, 0);
        assert.equal(sum, variant.delta, `${label}: region deltas sum to the role delta`);
        if (variant.delta < 0) assert.ok(variant.smallestWin?.delta < 0, `${label}: a shorter output names a winning region`);
      }
    }
  }
});

test('Nxx spelling that the compressor emits for savings reads back at another pitch in the repo', { skip }, async () => {
  const result = await runSongCase(await workshop(), SYNTHETIC_CASES.find(item => item.id === 'octave-leaps'));
  const row = result.rows.find(entry => entry.input === 'source');
  assert.ok(row.variants.raw.forms['numeric-note'] > 0, 'the unpatched compressor spends Nxx here');
  assert.equal(row.variants.raw.eventsEqual, false);
  assert.ok(row.variants.raw.diffs.some(diff => diff.field === 'pitch' && diff.b - diff.a === 12));
  assert.equal(row.variants.stock.forms['numeric-note'] ?? 0, 0, 'the patched lossless variant spends none');
  assert.equal(row.variants.stock.eventsEqual, true);
});
