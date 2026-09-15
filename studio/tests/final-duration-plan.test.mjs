// Exact-rational Final duration decomposition regressions.
//
// The published rule these serve is MOBILE_SYNTAX §3 (plain 1–64 lengths are not
// engine-illegal for being non-power-of-two; other plain lengths are
// `FINAL_ALLOWED_WITH_CAUTION`), §4 (single dots only on 1/2/4/8/16/32; `64.`,
// `3.`, `6.`, `12.`, `24.`, `48.` and multiple dots are `FINAL_FORBIDDEN`; the
// safe grid is 1/64) and §11 step 5.
//
// Every assertion below is about behaviour. None reads a constant back to
// itself, and none accepts an approximate duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { F, f } from '../backend/mml/index.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import { SAFE_GRID } from '../backend/canonical/micro-timing.mjs';
import {
  LENGTH_CLASS,
  MAX_OFF_GRID_SEGMENTS,
  buildTokenLattice,
  spellDuration,
  planDuration,
  createPlanState,
  planExactDuration,
  defaultLengthSwitchCost,
} from '../backend/final/duration-plan.mjs';

const lattice = buildTokenLattice();
const cautionLattice = buildTokenLattice({ cautionLengthOptIn: true });
const state = () => createPlanState({ budget: 200000, maxTieSegments: 12 });

const plan = (duration, defaultLength = 4, which = lattice) => planDuration(duration, defaultLength, which, state());
const written = result => result.plan.segments.map(segment => segment.suffix).join('&');

test('every admitted plain token stays inside the official 1–64 length range', () => {
  for (const token of lattice.tokens) {
    assert.ok(token.denominator >= EFFECTIVE_RULESET.mobileSyntax.officialLengthMin);
    assert.ok(token.denominator <= EFFECTIVE_RULESET.mobileSyntax.officialLengthMax);
    assert.ok(token.dots === 0 || token.dots === 1, 'multiple dots are FINAL_FORBIDDEN');
  }
});

test('no admitted token is shorter than the published 1/64 safe grid', () => {
  // MOBILE_SYNTAX §4 forbids decomposition components finer than 1/64 without
  // source-supported meaning. The lattice makes that unreachable by
  // construction rather than by a later filter.
  for (const token of cautionLattice.tokens) {
    assert.ok(token.duration.cmp(SAFE_GRID) >= 0, `${token.suffix} is below the safe grid`);
  }
});

test('the forbidden dotted forms are never admitted', () => {
  const dotted = cautionLattice.tokens.filter(token => token.dots === 1).map(token => token.denominator);
  for (const base of EFFECTIVE_RULESET.mobileSyntax.rejectDottedBasesInFinal) {
    assert.equal(dotted.includes(base), false, `${base}. must never be emittable`);
  }
  assert.deepEqual([...dotted].sort((a, b) => a - b), [1, 2, 4, 8, 16, 32]);
});

test('plain non-power-of-two lengths are caution-gated, never called illegal', () => {
  // The failure this pins is treating every non-power-of-two denominator as
  // engine-illegal, which MOBILE_SYNTAX §3 explicitly forbids.
  const plain = n => cautionLattice.tokens.find(token => token.denominator === n && token.dots === 0);
  for (const n of [3, 5, 6, 7, 9, 12, 19, 21, 24, 27, 38, 48]) {
    const token = plain(n);
    assert.ok(token, `plain ${n} must be representable under the caution opt-in`);
    assert.equal(token.lengthClass, LENGTH_CLASS.CAUTION);
  }
  assert.equal(lattice.tokens.some(token => token.denominator === 48), false,
    'caution lengths stay out of the default lattice');
});

test('plain 64 is preferred, not banned', () => {
  // PENDING P16 must not become a blanket ban on plain 64.
  const token = lattice.tokens.find(item => item.denominator === 64 && item.dots === 0);
  assert.ok(token);
  assert.equal(token.lengthClass, LENGTH_CLASS.PREFERRED);
  assert.equal(token.duration.cmp(SAFE_GRID), 0);
});

test('a duration equal to the default length writes no suffix at all', () => {
  const spelled = spellDuration(new F(4, 8), 8, lattice);
  assert.equal(spelled.suffix, '');
  assert.equal(spelled.cost, 0);
});

test('a dot on the current default length costs one character', () => {
  const spelled = spellDuration(new F(6, 8), 8, lattice);
  assert.equal(spelled.suffix, '.');
  assert.equal(spelled.cost, 1);
});

test('a single exact token is found for each preferred length', () => {
  for (const n of EFFECTIVE_RULESET.mobileSyntax.preferredLengthDenominators) {
    const result = plan(new F(4, n), null);
    assert.equal(result.ok, true, `4/${n} must be representable`);
    assert.equal(result.plan.segments.length, 1);
    assert.equal(planExactDuration(result.plan).cmp(new F(4, n)), 0);
  }
});

test('decomposition sums to the exact rational, never an approximation', () => {
  // 5/8 of a beat is not a single token: 1/2 + 1/8 exactly.
  const target = new F(5, 8);
  const result = plan(target);
  assert.equal(result.ok, true);
  assert.equal(planExactDuration(result.plan).cmp(target), 0);
  assert.ok(result.plan.segments.length >= 2);
});

test('a multi-token duration is exact and beats the greedy tail', () => {
  // 7/4 beats = a dotted half (3/2) plus an eighth (1/4)... and also 1 + 1/2 +
  // 1/4. The planner must return an exact sum and must not be longer than the
  // best two-token answer.
  const target = new F(7, 4);
  const result = plan(target);
  assert.equal(result.ok, true);
  assert.equal(planExactDuration(result.plan).cmp(target), 0);
  assert.ok(result.plan.segments.length <= 2, `expected at most two segments, got ${written(result)}`);
});

test('an unrepresentable exact duration fails closed instead of rounding', () => {
  // A third of a beat is not a sum of the preferred lattice. The planner must
  // refuse rather than return the nearest legal token.
  const target = new F(1, 3);
  const result = plan(target);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-representable');
  assert.equal(result.plan, null);
});

test('the same unrepresentable duration becomes exact under the caution opt-in', () => {
  // 1/3 beat = 4/12, i.e. plain length 12 — inside the official range and
  // `FINAL_ALLOWED_WITH_CAUTION`. This is the pair that proves the refusal above
  // is a policy boundary, not an arithmetic failure.
  const target = new F(1, 3);
  const result = plan(target, 4, cautionLattice);
  assert.equal(result.ok, true);
  assert.equal(planExactDuration(result.plan).cmp(target), 0);
});

test('a duration one part in 10^20 off a token is not accepted', () => {
  // The float images of these two are the same double. Only exact rational
  // arithmetic can tell them apart, so this is the test that fails the moment
  // anything in the planner compares with Number or an epsilon.
  const exact = new F(4, 8);
  const off = exact.sub(new F(1, 10n ** 20n));
  assert.equal(Number(exact.toString().split('/')[0]) / Number(exact.toString().split('/')[1]),
    off.num(), 'the two values must be indistinguishable as doubles');
  assert.equal(plan(exact).ok, true);
  const result = plan(off);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-representable');
});

test('a sub-grid duration is never representable', () => {
  const belowGrid = SAFE_GRID.sub(new F(1, 10n ** 20n));
  const result = plan(belowGrid, 4, cautionLattice);
  assert.equal(result.ok, false);
  assert.equal(result.plan, null);
});

test('a zero or negative duration is rejected, never emitted', () => {
  // MOBILE_SYNTAX §4 makes zero-duration events FINAL_FORBIDDEN.
  assert.equal(plan(new F(0)).ok, false);
  assert.equal(plan(new F(0)).reason, 'non-positive-duration');
  assert.equal(plan(new F(-1, 2)).ok, false);
});

test('an exhausted search budget is reported as such, not as a proof', () => {
  const tiny = createPlanState({ budget: 3, maxTieSegments: 12 });
  const result = planDuration(new F(123, 64), 4, cautionLattice, tiny);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'budget-exhausted');
  assert.equal(result.plan, null);
  // A later request on the same exhausted state must not be mistaken for a
  // representability proof by a poisoned memo entry.
  assert.equal(planDuration(new F(1), 4, cautionLattice, tiny).reason, 'budget-exhausted');
});

test('planning is deterministic for the same input', () => {
  const target = new F(15, 16);
  const first = plan(target);
  const second = plan(target);
  assert.equal(first.ok, true);
  assert.equal(written(first), written(second));
});

test('the memo does not leak a plan across different default lengths', () => {
  const shared = createPlanState({ budget: 200000, maxTieSegments: 12 });
  const target = new F(4, 8);
  const underEight = planDuration(target, 8, lattice, shared);
  const underFour = planDuration(target, 4, lattice, shared);
  assert.equal(underEight.plan.segments[0].suffix, '', 'under l8 an eighth writes nothing');
  assert.equal(underFour.plan.segments[0].suffix, '8', 'under l4 it must still write its denominator');
});

test('the lN switch cost counts the instruction itself', () => {
  assert.equal(defaultLengthSwitchCost(4), 2);
  assert.equal(defaultLengthSwitchCost(16), 3);
});

test('default-length candidates never include a dotted form', () => {
  // Verified against the parser: `l16.` leaves the dot unrecognised.
  for (const candidate of cautionLattice.defaultLengthCandidates) {
    assert.equal(Number.isInteger(candidate), true);
  }
});

test('a long duration decomposes exactly into tied segments', () => {
  const target = new F(13);
  const result = plan(target);
  assert.equal(result.ok, true);
  assert.equal(planExactDuration(result.plan).cmp(target), 0);
  assert.equal(f(planExactDuration(result.plan)).cmp(13), 0);
});

test('the caution search stays bounded instead of exploring arbitrary rationals', () => {
  // Admitting all 64 caution lengths at every step turns the reachable state
  // set into arbitrary rationals and burns the whole node budget on durations
  // that are plainly representable. Organising the search around the grid keeps
  // it small. This observes the search *shape*, not wall-clock time.
  for (const numerator of [7, 13, 19, 29, 37]) {
    const shared = createPlanState({ budget: 200000, maxTieSegments: 12 });
    const result = planDuration(new F(numerator, 16), 4, cautionLattice, shared, 2);
    assert.equal(result.ok, true, `${numerator}/16 must be representable`);
    assert.equal(planExactDuration(result.plan).cmp(new F(numerator, 16)), 0);
    assert.equal(shared.exhausted, false, `${numerator}/16 exhausted the budget`);
    assert.ok(shared.memo.size < 2000, `${numerator}/16 visited ${shared.memo.size} states`);
  }
});

test('a grid-aligned duration is decomposed with grid-aligned tokens only', () => {
  // Every preferred token is a whole number of 1/64 notes; every caution length
  // is not. A grid-aligned duration therefore never needs to leave the grid,
  // and the planner does not.
  const result = plan(new F(29, 16), 4, cautionLattice);
  assert.equal(result.ok, true);
  for (const segment of result.plan.segments) {
    assert.equal(segment.onGrid, true, `${segment.suffix} left the grid unnecessarily`);
  }
});

test('an off-grid duration may use caution tokens, within the declared bound', () => {
  const state = createPlanState({ budget: 200000, maxTieSegments: 12 });
  const target = new F(1, 3).add(new F(1, 2));
  const result = planDuration(target, 4, cautionLattice, state, 2);
  assert.equal(result.ok, true);
  assert.equal(planExactDuration(result.plan).cmp(target), 0);
  const offGrid = result.plan.segments.filter(segment => !segment.onGrid).length;
  assert.ok(offGrid >= 1 && offGrid <= MAX_OFF_GRID_SEGMENTS);
});

test('exhausting the off-grid allowance fails closed, never approximates', () => {
  const state = createPlanState({ budget: 200000, maxTieSegments: 12, maxOffGridSegments: 0 });
  const result = planDuration(new F(1, 3), 4, cautionLattice, state, 2);
  assert.equal(result.ok, false);
  assert.equal(result.plan, null);
});
