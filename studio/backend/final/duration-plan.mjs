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

const syntax = EFFECTIVE_RULESET.mobileSyntax;

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
export function spellDuration(duration, defaultLength, lattice) {
  const target = f(duration);
  if (defaultLength !== null && target.cmp(plainDuration(defaultLength)) === 0) {
    return { suffix: '', cost: 0, denominator: defaultLength, dots: 0, lengthClass: null };
  }
  let best = null;
  for (const token of lattice.tokens) {
    if (token.duration.cmp(target) !== 0) continue;
    // A dot on the current default length is one character regardless of how
    // many digits the denominator has.
    const useBareDot = token.dots === 1 && token.denominator === defaultLength;
    const suffix = useBareDot ? '.' : token.suffix;
    const cost = suffix.length;
    if (best === null || cost < best.cost) {
      best = { suffix, cost, denominator: token.denominator, dots: token.dots, lengthClass: token.lengthClass };
    }
  }
  return best;
}

/**
 * Exact decomposition of `duration` into tie segments under default length `L`.
 *
 * Returns `{ segments, cost }` where `segments` is an ordered list of written
 * suffixes whose token durations sum to exactly `duration`, and `cost` is the
 * character cost of the *length text alone* — the caller adds the per-segment
 * note name and the `&` joiners, because those depend on the pitch spelling it
 * has not chosen yet.
 *
 * Greedy does not work. "Take the largest token that fits" happily produces a
 * long tail of tiny tokens where a different first token lands exactly. The
 * search is therefore exhaustive over the admitted lattice, memoized on the
 * exact remaining rational, and bounded by an explicit node budget so that a
 * pathological input fails rather than hangs.
 *
 * Failure modes are distinguished, because they mean different things: a
 * duration that is provably not a lattice sum is `not-representable`, while an
 * exhausted budget is `budget-exhausted` and says only that this search gave up.
 * Neither ever returns an approximate answer.
 */
export function planDuration(duration, defaultLength, lattice, state) {
  const target = f(duration);
  if (target.cmp(0) <= 0) return { ok: false, reason: 'non-positive-duration', plan: null };
  // Once the budget is gone the memo may hold `null`s that mean "cut short",
  // not "impossible". Every later request on this state therefore reports the
  // exhaustion rather than mistaking a poisoned entry for a proof.
  if (state.exhausted) return { ok: false, reason: 'budget-exhausted', plan: null };

  const memo = state.memo;
  const maxSegments = state.maxTieSegments;

  const search = (remaining, segmentsLeft) => {
    if (state.exhausted) return null;
    // The plan depends on the default length in force, so the memo is keyed on
    // it too. One state object serves every default-length candidate the
    // planner tries, and sharing a key across them would return a plan written
    // against the wrong `lN`.
    const key = `${remaining.toString()}|${segmentsLeft}|${defaultLength}`;
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
    const single = spellDuration(remaining, defaultLength, lattice);
    if (single) best = { segments: [single], cost: single.cost };

    if (segmentsLeft > 1) {
      for (const token of lattice.tokens) {
        // Every head must be strictly shorter than the remainder, so the
        // recursion always decreases and terminates.
        if (token.duration.cmp(remaining) >= 0) continue;
        const useBareDot = token.dots === 1 && token.denominator === defaultLength;
        const suffix = useBareDot ? '.' : token.suffix;
        const head = {
          suffix,
          cost: suffix.length,
          denominator: token.denominator,
          dots: token.dots,
          lengthClass: token.lengthClass,
        };
        // A token equal to the default length writes nothing at all.
        if (token.dots === 0 && token.denominator === defaultLength) {
          head.suffix = '';
          head.cost = 0;
        }
        const tail = search(remaining.sub(token.duration), segmentsLeft - 1);
        if (!tail) continue;
        const cost = head.cost + tail.cost;
        if (best === null || cost < best.cost) {
          best = { segments: [head, ...tail.segments], cost };
        }
      }
    }

    memo.set(key, best);
    return best;
  };

  const plan = search(target, maxSegments);
  if (plan) return { ok: true, reason: null, plan };
  return {
    ok: false,
    reason: state.exhausted ? 'budget-exhausted' : 'not-representable',
    plan: null,
  };
}

export function createPlanState({ budget, maxTieSegments }) {
  return {
    budget,
    maxTieSegments,
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
