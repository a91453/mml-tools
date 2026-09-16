// Exact-rational Final duration decomposition.
//
// The problem: a Canonical event has an exact rational duration D in quarter-note
// beats. Final MML can only write a small set of length tokens. Which sequence of
// tokens sums to *exactly* D, and which of the exact sequences is shortest to
// write?
//
// Two properties are non-negotiable and the rest of the module is arranged
// around them:
//
//   1. exactness — `sum(emitted token durations) === D` as exact rationals. Not
//      within an epsilon, not within a tick, not after rounding. There is no
//      float anywhere in this file; every comparison goes through `F`.
//   2. fail closed — when no exact sequence exists, the answer is `null` and the
//      caller refuses to emit. Approximating to the nearest legal token would be
//      a silent musical mutation, which MASTER_RULES §7 and MOBILE_SYNTAX §11
//      both forbid.
//
// The admitted token set is read from the executable contract, never hard-coded
// here, because MOBILE_SYNTAX §3 protects plain non-power-of-two lengths from
// being called illegal and §4 forbids exactly six dotted forms. A local copy of
// either list would be a second rule source.
import { F, f } from '../mml/index.mjs';
import { EFFECTIVE_RULESET } from '../rules/index.mjs';
import { SAFE_GRID } from '../canonical/micro-timing.mjs';

const syntax = EFFECTIVE_RULESET.mobileSyntax;

// How many off-grid (caution) tokens one decomposition may use. See
// `planDuration` for why the search is organised around the grid at all; three
// is far beyond what real source timing needs — a triplet group costs one — and
// it is what keeps the caution search bounded instead of combinatorial.
export const MAX_OFF_GRID_SEGMENTS = 3;

/**
 * Why a decomposition request produced no plan.
 *
 * Only `NON_POSITIVE_DURATION` is a claim about the duration itself. The other
 * two are claims about this bounded search, and neither is evidence that no
 * exact token decomposition exists.
 */
export const PLAN_FAILURE = Object.freeze({
  NON_POSITIVE_DURATION: 'non-positive-duration',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  SEARCH_POLICY_LIMIT: 'search-policy-limit',
});

// A duration is grid-aligned when it is a whole number of 1/64 notes. `SAFE_GRID`
// is the published grid, read from the analyzer rather than restated.
const onGrid = value => f(value).div(SAFE_GRID).d === 1n;

export const LENGTH_CLASS = Object.freeze({
  // MOBILE_SYNTAX §3: simple stable lengths.
  PREFERRED: 'FINAL_PREFERRED',
  // MOBILE_SYNTAX §3: other plain integer lengths 1–64, admitted only when the
  // caller has opted in because source timing requires them.
  CAUTION: 'FINAL_ALLOWED_WITH_CAUTION',
});

// A token of plain length n lasts 4/n quarter-note beats; a single dot adds half
// again, so n-dotted lasts 6/n. Written as the derivation rather than a table so
// the relation to the parser stays visible.
const plainDuration = n => new F(4, n);
const dottedDuration = n => new F(6, n);

function digits(value) {
  return String(value).length;
}

/**
 * Build the admitted Final token lattice.
 *
 * Determinism matters more than it looks: the searches below improve only on a
 * strict `<`, so the order in which equal-cost candidates appear decides the
 * output. Tokens are therefore sorted by descending duration and then by
 * ascending written form, which is a total order.
 */
export function buildTokenLattice({ cautionLengthOptIn = false } = {}) {
  const preferred = new Set(syntax.preferredLengthDenominators);
  const dottedBases = new Set(syntax.preferredDottedBaseDenominators);
  const forbiddenDotted = new Set(syntax.rejectDottedBasesInFinal);
  const tokens = [];

  for (let n = syntax.officialLengthMin; n <= syntax.officialLengthMax; n += 1) {
    const isPreferred = preferred.has(n);
    if (!isPreferred && !cautionLengthOptIn) continue;
    tokens.push({
      denominator: n,
      dots: 0,
      duration: plainDuration(n),
      suffix: String(n),
      lengthClass: isPreferred ? LENGTH_CLASS.PREFERRED : LENGTH_CLASS.CAUTION,
      onGrid: onGrid(plainDuration(n)),
    });
  }

  for (const n of syntax.preferredDottedBaseDenominators) {
    // Belt and braces: the contract lists the preferred dotted bases and the
    // forbidden ones separately, and a contract that ever put a base in both
    // must not produce a fragile token.
    if (forbiddenDotted.has(n)) continue;
    if (!dottedBases.has(n)) continue;
    tokens.push({
      denominator: n,
      dots: 1,
      duration: dottedDuration(n),
      suffix: `${n}.`,
      lengthClass: LENGTH_CLASS.PREFERRED,
      onGrid: onGrid(dottedDuration(n)),
    });
  }

  tokens.sort((left, right) => right.duration.cmp(left.duration)
    || (left.suffix < right.suffix ? -1 : left.suffix > right.suffix ? 1 : 0));

  // Default lengths the emitter may switch to with `lN`. The parser reads only
  // digits after `l` — a dot after it is an unrecognised character (verified) —
  // so a dotted default is not a legal state and is not offered here.
  const defaultLengthCandidates = tokens
    .filter(token => token.dots === 0)
    .map(token => token.denominator)
    .sort((left, right) => left - right);

  return Object.freeze({
    tokens: Object.freeze(tokens.map(Object.freeze)),
    defaultLengthCandidates: Object.freeze(defaultLengthCandidates),
    cautionLengthOptIn,
  });
}

/**
 * Cheapest written suffix for `duration` given the current default length `L`.
 *
 * Three shapes, cheapest first:
 *   ""     the duration already equals plain L, so nothing is written
 *   "."    the duration equals dotted L, and L is an admitted dotted base
 *   "n"/"n."  an explicit token
 *
 * Returns `null` when no single token matches exactly.
 */
export function spellDuration(duration, defaultLength, lattice, offGridAllowed = Infinity) {
  const target = f(duration);
  if (defaultLength !== null && target.cmp(plainDuration(defaultLength)) === 0) {
    return { suffix: '', cost: 0, denominator: defaultLength, dots: 0, lengthClass: null, onGrid: onGrid(target) };
  }
  let best = null;
  for (const token of lattice.tokens) {
    if (token.duration.cmp(target) !== 0) continue;
    if (!token.onGrid && offGridAllowed < 1) continue;
    // A dot on the current default length is one character regardless of how
    // many digits the denominator has.
    const useBareDot = token.dots === 1 && token.denominator === defaultLength;
    const suffix = useBareDot ? '.' : token.suffix;
    const cost = suffix.length;
    if (best === null || cost < best.cost) {
      best = { suffix, cost, denominator: token.denominator, dots: token.dots, lengthClass: token.lengthClass, onGrid: token.onGrid };
    }
  }
  return best;
}

/**
 * Exact decomposition of `duration` into tie segments under default length `L`.
 *
 * Returns `{ segments, cost }` where `segments` is an ordered list of written
 * suffixes whose token durations sum to exactly `duration`.
 *
 * `perSegmentCost` is what one extra segment costs the caller beyond its own
 * length text: `1` for a rest (the `r`), and `spelling.length + 1` for a note
 * (the repeated note name plus the `&` that joins it). It has to be part of the
 * search rather than added afterwards, because it changes which decomposition
 * wins. Under `l4`, three beats can be written `2.` (one segment, two suffix
 * characters) or as three default-length segments (zero suffix characters) —
 * scoring suffixes alone picks the second and emits `c&c&c` where `c2.` was
 * available. The caller subtracts the one `&` the first segment does not pay.
 *
 * Greedy does not work. "Take the largest token that fits" happily produces a
 * long tail of tiny tokens where a different first token lands exactly. The
 * search is therefore systematic over the admitted lattice, memoized on the
 * exact remaining rational, and bounded so that a pathological input fails
 * rather than hangs.
 *
 * The search is organised around the 1/64 grid, and that is what keeps it
 * bounded. Every preferred token is a whole number of 1/64 notes, so a
 * grid-aligned remainder minus a preferred token is still grid-aligned: the
 * reachable state set collapses onto the grid and stays small. Every *caution*
 * length is off-grid — a plain denominator divides 64 only inside the preferred
 * set — so admitting all 64 of them at every step instead explodes the state
 * space into arbitrary rationals.
 *
 * Several deterministic bounds keep that from happening. None of them can make
 * an emitted duration *wrong* — everything returned is still an exact sum — but
 * each of them can make the search *miss* a decomposition that does exist:
 *
 *   - `maxTieSegments` caps how many tie segments one decomposition may use.
 *     The longest preferred token is a dotted whole note, so a sustain longer
 *     than `maxTieSegments` of those is missed even though repeated whole notes
 *     would express it exactly.
 *   - `MAX_OFF_GRID_SEGMENTS` caps how many off-grid (caution) tokens one
 *     decomposition may use.
 *   - a grid-aligned remainder is decomposed with grid-aligned tokens only, so
 *     an answer that left the grid and came back is not considered.
 *   - the node budget stops the search outright.
 *
 * ## Failure taxonomy
 *
 * This module has **no completeness proof**, so it must not claim one. The three
 * failure reasons say exactly what is known and nothing more:
 *
 *   `non-positive-duration`  the input is not a duration at all. Provable, and
 *                            MOBILE_SYNTAX §4 makes zero duration
 *                            `FINAL_FORBIDDEN` regardless.
 *   `budget-exhausted`       the node budget ran out mid-search.
 *   `search-policy-limit`    the search finished within its bounds without
 *                            finding an exact plan.
 *
 * `search-policy-limit` is deliberately *not* called "not representable". It is
 * a statement about this bounded search, not about arithmetic: a duration that
 * is plainly an exact sum of admitted tokens lands here whenever expressing it
 * needs more segments, or more off-grid tokens, than the bounds allow. Reporting
 * it as mathematical impossibility would be an overclaim, and a caller that
 * believed it might go looking for a musical fix to a problem that is only a
 * search limit.
 *
 * What every failure does share is the property that matters: nothing is ever
 * approximated. The caller fails closed on all three.
 */
export function planDuration(duration, defaultLength, lattice, state, perSegmentCost = 0) {
  const target = f(duration);
  if (target.cmp(0) <= 0) return { ok: false, reason: PLAN_FAILURE.NON_POSITIVE_DURATION, plan: null };
  // Once the budget is gone the memo may hold `null`s that mean "cut short",
  // not "impossible". Every later request on this state therefore reports the
  // exhaustion rather than mistaking a poisoned entry for a proof.
  if (state.exhausted) return { ok: false, reason: PLAN_FAILURE.BUDGET_EXHAUSTED, plan: null };

  const memo = state.memo;
  const maxSegments = state.maxTieSegments;
  if (!Number.isSafeInteger(perSegmentCost) || perSegmentCost < 0) throw Error('perSegmentCost must be a non-negative integer');

  // Heads, priced once for this default length and ordered cheapest-first, then
  // longest-first. Finding a cheap answer early is what makes the bound below
  // bite: with 64 caution lengths admitted, an unordered search spends most of
  // its budget exploring branches it will never keep.
  const offGridBudget = Number.isSafeInteger(state.maxOffGridSegments)
    ? state.maxOffGridSegments
    : MAX_OFF_GRID_SEGMENTS;

  const heads = lattice.tokens.map(token => {
    const bareDot = token.dots === 1 && token.denominator === defaultLength;
    const bareDefault = token.dots === 0 && token.denominator === defaultLength;
    const suffix = bareDefault ? '' : bareDot ? '.' : token.suffix;
    return {
      duration: token.duration,
      onGrid: token.onGrid,
      segment: {
        suffix,
        cost: suffix.length,
        denominator: token.denominator,
        dots: token.dots,
        lengthClass: token.lengthClass,
        onGrid: token.onGrid,
      },
    };
  }).sort((left, right) => left.segment.cost - right.segment.cost
    || right.duration.cmp(left.duration)
    || (left.segment.suffix < right.segment.suffix ? -1 : 1));

  // A tail always has at least one segment, and the cheapest conceivable segment
  // writes no suffix at all, so any split costs at least
  // `head + 2 * perSegmentCost`. That bound is exact, not a heuristic: it can
  // only discard branches that provably cannot beat the best already found.
  const floorCost = perSegmentCost;

  const search = (remaining, segmentsLeft, offGridLeft) => {
    if (state.exhausted) return null;
    const aligned = onGrid(remaining);
    // A remainder that has left the grid with no allowance left can never come
    // back: every remaining head is grid-aligned and preserves the offset.
    if (!aligned && offGridLeft <= 0) return null;

    // The plan depends on the default length in force, so the memo is keyed on
    // it too. One state object serves every default-length candidate the
    // planner tries, and sharing a key across them would return a plan written
    // against the wrong `lN`.
    const key = `${remaining.toString()}|${segmentsLeft}|${defaultLength}|${perSegmentCost}|${offGridLeft}`;
    if (memo.has(key)) return memo.get(key);
    if (state.budget <= 0) {
      state.exhausted = true;
      return null;
    }
    state.budget -= 1;
    // Placeholder guards against re-entry on the same state; the lattice is
    // strictly positive so a cycle cannot actually occur, but a placeholder
    // keeps that from being a load-bearing assumption.
    memo.set(key, null);

    let best = null;
    const single = spellDuration(remaining, defaultLength, lattice, offGridLeft);
    if (single) best = { segments: [single], cost: single.cost + perSegmentCost };

    if (segmentsLeft > 1 && !(best && best.cost <= floorCost)) {
      for (const head of heads) {
        // A grid-aligned remainder is decomposed on the grid; see the note above
        // for why that costs no exactness.
        if (aligned && !head.onGrid) continue;
        if (!head.onGrid && offGridLeft <= 0) continue;
        // Every head must be strictly shorter than the remainder, so the
        // recursion always decreases and terminates.
        if (head.duration.cmp(remaining) >= 0) continue;
        if (best && head.segment.cost + floorCost + perSegmentCost >= best.cost) continue;
        const tail = search(
          remaining.sub(head.duration),
          segmentsLeft - 1,
          head.onGrid ? offGridLeft : offGridLeft - 1,
        );
        if (!tail) continue;
        const cost = head.segment.cost + perSegmentCost + tail.cost;
        if (best === null || cost < best.cost) {
          best = { segments: [head.segment, ...tail.segments], cost };
          if (best.cost <= floorCost) break;
        }
      }
    }

    memo.set(key, best);
    return best;
  };

  const plan = search(target, maxSegments, offGridBudget);
  if (plan) return { ok: true, reason: null, plan };
  return {
    ok: false,
    reason: state.exhausted ? PLAN_FAILURE.BUDGET_EXHAUSTED : PLAN_FAILURE.SEARCH_POLICY_LIMIT,
    plan: null,
  };
}

export function createPlanState({ budget, maxTieSegments, maxOffGridSegments = MAX_OFF_GRID_SEGMENTS }) {
  return {
    budget,
    maxTieSegments,
    maxOffGridSegments,
    exhausted: false,
    memo: new Map(),
  };
}

/**
 * Character cost of the `lN` switch instruction itself.
 */
export function defaultLengthSwitchCost(denominator) {
  return 1 + digits(denominator);
}

/**
 * Sum the exact durations a plan actually writes.
 *
 * This is the independent check that the search did what it claims. It
 * recomputes each written token's duration from its own denominator and dots
 * rather than trusting the search's bookkeeping, so a bug in the search surfaces
 * as an exactness failure instead of a silently wrong score.
 */
export function planExactDuration(plan) {
  let total = new F(0);
  for (const segment of plan.segments) {
    total = total.add(segment.dots === 1 ? dottedDuration(segment.denominator) : plainDuration(segment.denominator));
  }
  return total;
}

export { plainDuration, dottedDuration };
