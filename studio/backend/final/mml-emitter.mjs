// Canonical-aware Final MML emitter.
//
// Turns a candidate Canonical project into paste-ready six-role MML, or refuses
// and says exactly why. It is an implementer of the published rules, never an
// author of them: `MOBILE_SYNTAX.md`, `MASTER_RULES.md`, `SOURCE_POLICY.md` and
// `ACCEPTANCE_CRITERIA.md` at the pinned rules snapshot decide what is legal,
// `rules/index.mjs` carries the executable echo of those values, and
// `mml/parser.mjs` is the authority this emitter has to satisfy.
//
// The ordering the whole module obeys, highest first:
//
//   1. exact semantics — every emitted event must re-parse to the same exact
//      rational start, end and pitch. No epsilon, no tick, no rounding.
//   2. attack identity — a source attack stays an attack. Two adjacent
//      same-pitch notes never become one tie, and one attack split for a tempo
//      token never becomes two.
//   3. the safer published Final form — preferred lengths and preferred dotted
//      bases before caution forms, ordinary notation before `Nxx`.
//   4. characters.
//
// Character optimization never reaches above its own line. When the exact,
// legal, attack-preserving output does not fit the 2,400-character budget, the
// emitter fails and reports; it does not drop a note, shorten a rest, quantize,
// or simplify the music. That is an arrangement decision and it belongs to the
// user, not to a serializer.
import { F, f, ROLES } from '../mml/index.mjs';
import { EFFECTIVE_RULESET, studioFinalBlockers } from '../rules/index.mjs';
import { BOUNDARY_COVERAGE, FINAL_REPRESENTABILITY_PROOFS, LEADING_ONSET_REASON, MICRO_GAP_BLOCKERS, SHORTEST_ADMITTED_TOKEN_BEATS, enforceMicroGaps } from './micro-gap-enforcement.mjs';
import { POSITION_CLASS, classifyPosition } from '../canonical/release-timing.mjs';
import {
  DELIVERY_CLASS,
  MACHINE_DELIVERY_SCHEMA_V2,
  deliveryBlockingGates,
  deliveryClassOf,
  machineDeliveryAuthority,
  machineDeliverySchemaOf,
} from './delivery-evaluator.mjs';
import {
  PROVISIONAL_RENDERING_NOTICE,
  REPAIR_STATUS,
  renderProvisionalReleases,
  repairTechnicalTiming,
} from './technical-timing-repair.mjs';
import {
  EMIT_STATUS,
  DIAGNOSTIC_SEVERITY,
  EMIT_DIAGNOSTICS,
  EMITTER_NOTICE,
  diagnostic,
  parserFacts,
  normalizeEmitOptions,
  canonicalIdentity,
} from './emitter-contract.mjs';
import { verifyFinalReadback, expectedRoleSemantics } from './round-trip.mjs';
import {
  PLAN_FAILURE,
  buildTokenLattice,
  planDuration,
  planRestDuration,
  createPlanState,
  defaultLengthSwitchCost,
  plainDuration,
} from './duration-plan.mjs';

const syntax = EFFECTIVE_RULESET.mobileSyntax;
const ROLE_SET = new Set(ROLES);
const SPAN_KINDS = new Set(['note', 'rest']);

// How many `lN` candidates the default-length planner may consider. Restricting
// the candidate set is a deterministic implementer policy for search cost, not a
// rule: it can only make the output longer, never wrong, because representability
// does not depend on which default length is in force.
const MAX_DEFAULT_LENGTH_CANDIDATES = 12;
// Always-offered default lengths for long tie/rest segments; see the
// default-length candidates block in serializeItems().
const LONG_SEGMENT_DEFAULTS = Object.freeze([1, 2]);
// How many G10 boundaries a diagnostic lists by location; the true total is
// reported beside them. The same bound as the unassigned-event list.
const MAX_REPORTED_BOUNDARIES = 20;

const digits = value => String(value).length;

/** `t150` / `v12` — one letter plus the digits. */
const stateTokenCost = value => 1 + digits(value);

/**
 * Written form of an octave move. One step is `<`/`>`; anything else names the
 * octave outright. `null` means no octave has been set yet, which the parser
 * requires before the first note.
 */
function octaveShift(from, to) {
  if (from === to) return '';
  if (from !== null && Math.abs(to - from) === 1) return to > from ? '>' : '<';
  return `o${to}`;
}

const sortSpans = spans => [...spans].sort((left, right) => f(left.start).cmp(right.start)
  || f(left.end).cmp(right.end)
  || (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0));

// ── role stream ────────────────────────────────────────────────────────────

/**
 * Build one role's ordered, gap-free span list.
 *
 * A single MML role is a sequential cursor: each token advances time, so a role
 * cannot carry two simultaneous notes. Overlap is therefore refused rather than
 * silently flattened — dropping or truncating one of two overlapping notes is
 * exactly the silent musical mutation this emitter exists to avoid.
 *
 * Silence between two spans is written as a rest. That is not an invented rest:
 * the gap *is* the candidate's own decision about when the next attack starts,
 * and `mml/canonicalize.mjs` already treats the same gap as silence in the
 * opposite direction. The spans are reported so the inference stays auditable.
 */
function buildRoleStream(role, spans) {
  const diagnostics = [];
  const ordered = sortSpans(spans);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (f(current.start).cmp(previous.end) < 0) {
      diagnostics.push(diagnostic(
        current.kind === 'rest' || previous.kind === 'rest'
          ? EMIT_DIAGNOSTICS.REST_OVERLAPS_NOTE
          : EMIT_DIAGNOSTICS.ROLE_POLYPHONY_UNSUPPORTED,
        DIAGNOSTIC_SEVERITY.ERROR,
        `${role}: ${previous.id} (${previous.start}..${previous.end}) overlaps ${current.id} (${current.start}..${current.end}). A single MML role is one sequential voice; the emitter will not drop or truncate either event.`,
        { role, eventIds: [previous.id, current.id] },
      ));
    }
  }
  if (diagnostics.length) return { diagnostics, pieces: null, end: null };

  const pieces = [];
  const derivedSilence = [];
  let cursor = new F(0);
  for (const span of ordered) {
    const start = f(span.start);
    const end = f(span.end);
    if (start.cmp(cursor) > 0) {
      derivedSilence.push({ start: cursor.toString(), end: start.toString() });
      pieces.push({ kind: 'rest', start: cursor, end: start, id: null });
    }
    pieces.push({
      kind: span.kind,
      start,
      end,
      id: span.id,
      pitch: span.kind === 'note' ? span.pitch : null,
      volume: span.kind === 'note' ? span.volume : null,
    });
    cursor = end;
  }

  if (derivedSilence.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.SILENCE_DERIVED_FROM_GAP,
      DIAGNOSTIC_SEVERITY.NOTICE,
      `${role}: ${derivedSilence.length} silence span(s) were written as rests because the candidate's own event onsets require them.`,
      { role, spans: Object.freeze(derivedSilence) },
    ));
  }

  // Adjacent silence is merged before tokenizing. A rest carries no attack, so
  // how many rest tokens express one span of silence is purely a representation
  // choice; the span itself is preserved exactly.
  const merged = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (piece.kind === 'rest' && last?.kind === 'rest' && last.end.cmp(piece.start) === 0) {
      last.end = piece.end;
      last.id = last.id ?? piece.id;
      continue;
    }
    merged.push({ ...piece });
  }

  return { diagnostics, pieces: merged, end: cursor };
}

/**
 * Split the role's spans wherever a tempo change falls, and interleave the tempo
 * tokens.
 *
 * MML has nowhere to put a `t` inside a length token, so a tempo change during a
 * sustained note forces the note's *representation* into tied segments. The
 * attack is not duplicated: every piece after the first is marked a
 * continuation and the authoritative parser merges them back into one event,
 * which the round-trip gate then checks.
 */
function splitAtTempo(role, pieces, tempoEvents, roleEnd) {
  const diagnostics = [];
  const items = [];
  const cuts = tempoEvents.map(event => f(event.beat));

  const split = [];
  for (const piece of pieces) {
    const inside = cuts.filter(beat => beat.cmp(piece.start) > 0 && beat.cmp(piece.end) < 0);
    let start = piece.start;
    inside.forEach((beat, index) => {
      split.push({ ...piece, start, end: beat, continuation: piece.kind === 'note' && start.cmp(piece.start) !== 0 });
      start = beat;
    });
    split.push({ ...piece, start, end: piece.end, continuation: piece.kind === 'note' && start.cmp(piece.start) !== 0 });
  }

  let cursor = new F(0);
  let tempoIndex = 0;
  const flush = () => {
    while (tempoIndex < tempoEvents.length && cuts[tempoIndex].cmp(cursor) === 0) {
      items.push({ kind: 'tempo', bpm: tempoEvents[tempoIndex].bpm });
      tempoIndex += 1;
    }
  };

  for (const piece of split) {
    flush();
    items.push({
      kind: piece.kind,
      duration: piece.end.sub(piece.start),
      pitch: piece.pitch,
      volume: piece.volume,
      continuation: piece.continuation === true,
      eventId: piece.id,
      start: piece.start.toString(),
    });
    cursor = piece.end;
  }
  flush();

  if (tempoIndex < tempoEvents.length) {
    const unreachable = tempoEvents.slice(tempoIndex);
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.TEMPO_POSITION_BEYOND_ROLE_END,
      DIAGNOSTIC_SEVERITY.ERROR,
      `${role}: the synchronization-safe Tempo policy places ${unreachable.length} Tempo change(s) at or after beat ${unreachable[0].beat}, but this non-empty role's content ends at beat ${roleEnd}. The emitter will not pad the role with filler rests to reach them (MASTER_RULES §7, PENDING P2/P14).`,
      { role, roleEnd: roleEnd.toString(), unreachableBeats: Object.freeze(unreachable.map(event => event.beat)) },
    ));
  }

  return { diagnostics, items };
}

// ── serialization ──────────────────────────────────────────────────────────

/**
 * Choose the default-length switch points, the octave route and the spelling of
 * every note, jointly.
 *
 * They are planned together rather than in two passes because they are coupled:
 * how many tie segments a duration needs depends on the default length in force,
 * and how much each segment costs depends on the note spelling chosen for it.
 * A two-pass plan has to guess one of the two, and its guess shows up as
 * non-determinism at the seams.
 *
 * The state is exactly what changes the *future* cost: the default length and
 * the octave. Nothing else is carried — volume transitions are forced by the
 * candidate, so they are priced in a pre-pass.
 */
function serializeItems(role, items, lattice, facts, options) {
  const diagnostics = [];

  // --- volume is a forced sequence, not a search dimension -----------------
  let decided = 0;
  let undecided = 0;
  for (const item of items) {
    if (item.kind !== 'note' || item.continuation) continue;
    if (item.volume === null || item.volume === undefined) undecided += 1;
    else decided += 1;
  }
  if (decided && undecided) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.EVENT_VOLUME_MIXED_DECISION,
      DIAGNOSTIC_SEVERITY.ERROR,
      `${role}: ${decided} note(s) carry a decided volume and ${undecided} do not. The emitter serializes decided volume semantics only; it will not invent a level for the rest.`,
      { role, decided, undecided },
    ));
    return { diagnostics, mml: null };
  }
  if (undecided) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.VOLUME_NOT_DECIDED,
      DIAGNOSTIC_SEVERITY.NOTICE,
      `${role}: no volume was decided for this role, so no V token is emitted and the parser's default level applies.`,
      { role, defaultVolume: facts.defaultVolume },
    ));
  }

  const volumeToken = new Array(items.length).fill(null);
  let currentVolume = facts.defaultVolume;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'note' || item.continuation) continue;
    if (item.volume === null || item.volume === undefined) continue;
    if (item.volume < syntax.volumeMin || item.volume > syntax.volumeMax) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.VOLUME_OUT_OF_RANGE,
        DIAGNOSTIC_SEVERITY.ERROR,
        `${role}: volume ${item.volume} is outside the official range ${syntax.volumeMin}–${syntax.volumeMax}.`,
        { role, eventId: item.eventId, volume: item.volume },
      ));
      continue;
    }
    if (item.volume !== currentVolume) {
      volumeToken[index] = `v${item.volume}`;
      currentVolume = item.volume;
    }
  }

  // --- pitch spellings -----------------------------------------------------
  const spellingsFor = new Map();
  for (const item of items) {
    if (item.kind !== 'note' || spellingsFor.has(item.pitch)) continue;
    if (item.pitch > facts.officialPitchMax) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.PITCH_ABOVE_OFFICIAL_RANGE,
        DIAGNOSTIC_SEVERITY.ERROR,
        `${role}: pitch ${item.pitch} is above the official pitch range 0–${facts.officialPitchMax}. The octave token mapping is an implementation mapping (PENDING P6), so the emitter refuses rather than re-spelling the note.`,
        { role, eventId: item.eventId, pitch: item.pitch },
      ));
      continue;
    }
    const options_ = facts.spellingsByPitch.get(item.pitch);
    if (!options_?.length) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.PITCH_NOT_SPELLABLE,
        DIAGNOSTIC_SEVERITY.ERROR,
        `${role}: pitch ${item.pitch} has no ordinary note spelling inside the octave mapping O${facts.octaveMin}–O${facts.octaveMax}. Numeric Nxx output is FINAL_ALLOWED_WITH_CAUTION and requires an opt-in plus evidence (PENDING P3), so the emitter fails closed.`,
        { role, eventId: item.eventId, pitch: item.pitch },
      ));
      continue;
    }
    spellingsFor.set(item.pitch, options_);
  }
  if (diagnostics.some(item => item.severity === DIAGNOSTIC_SEVERITY.ERROR)) return { diagnostics, mml: null };

  // --- default-length candidates ------------------------------------------
  // Lengths that some duration in this role spells as one token, the parser's
  // own starting default, and the long segment lengths `l1`/`l2`. The last pair
  // is the lesson from the owner's earlier frontend compressor, found by the
  // differential harness (scripts/fusion-emitter-diff.mjs): a default that no
  // single duration spells can still pay for itself as a tie or rest SEGMENT
  // length — `l1` turns `r1r1r1.` into `l1r.r.r2.` — and the occurrence rule
  // alone never offered it. On the song-reference corpus this shortens every
  // song by 287 characters (4.6%) with events unchanged. Offering all seven
  // preferred plain lengths saves nothing more and costs twice the planning
  // time; `l1`/`l2` alone cost about a quarter. The planner still picks by
  // exact cost, so within the search budget an extra candidate can only keep
  // or shorten a role; budget exhaustion still fails closed as before.
  const frequency = new Map();
  for (const item of items) {
    if (!item.duration) continue;
    for (const candidate of lattice.defaultLengthCandidates) {
      if (plainDuration(candidate).cmp(item.duration) !== 0) continue;
      frequency.set(candidate, (frequency.get(candidate) ?? 0) + 1);
    }
  }
  const ranked = [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, MAX_DEFAULT_LENGTH_CANDIDATES)
    .map(([candidate]) => candidate);
  const segmentLengths = lattice.defaultLengthCandidates.filter(candidate => LONG_SEGMENT_DEFAULTS.includes(candidate));
  const candidates = [...new Set([facts.defaultLength, ...ranked, ...segmentLengths])].sort((left, right) => left - right);

  // --- duration plans ------------------------------------------------------
  // One plan per (duration, default length, per-segment cost). The third key is
  // what an extra tie segment costs the caller: `1` for a rest's `r`, and
  // `spelling.length + 1` for a note's repeated name plus its `&`. Scoring the
  // suffix alone would pick `c&c&c` over `c2.`.
  const planState = createPlanState({ budget: options.budget, maxTieSegments: options.maxTieSegments });
  const plans = new Map();
  const REST_SEGMENT_COST = 1;
  const segmentCostsFor = item => (item.kind === 'rest'
    ? [REST_SEGMENT_COST]
    : [...new Set(spellingsFor.get(item.pitch).map(spelling => spelling.text.length + 1))]);
  // Rests go through `planRestDuration`: a silence has no attack and no tie, so a
  // long one may be written as consecutive whole-note rests plus an exact
  // remainder. Notes keep the ordinary tie-bounded search.
  const planFor = (item, candidate, perSegmentCost) => {
    const key = `${item.kind === 'rest' ? 'rest' : 'note'}|${item.duration.toString()}|${candidate}|${perSegmentCost}`;
    if (!plans.has(key)) {
      const planner = item.kind === 'rest' ? planRestDuration : planDuration;
      plans.set(key, planner(item.duration, candidate, lattice, planState, perSegmentCost));
    }
    return plans.get(key);
  };

  for (const item of items) {
    if (!item.duration) continue;
    const segmentCosts = segmentCostsFor(item);
    const results = [];
    for (const candidate of candidates) {
      for (const perSegmentCost of segmentCosts) results.push(planFor(item, candidate, perSegmentCost));
    }
    // Representability does not depend on which default length or per-segment
    // cost is in force — the lattice is the same either way — so one failing
    // result condemns the duration, and the reason distinguishes a proof from a
    // give-up.
    if (results.every(result => !result.ok)) {
      // Three outcomes, three meanings. Only the non-positive case is a claim
      // about the duration; the other two are claims about the bounded search,
      // and calling either of them "not representable" would assert a
      // completeness proof the planner does not have.
      const reasons = new Set(results.map(result => result.reason));
      const failure = reasons.has(PLAN_FAILURE.BUDGET_EXHAUSTED)
        ? PLAN_FAILURE.BUDGET_EXHAUSTED
        : reasons.has(PLAN_FAILURE.NON_POSITIVE_DURATION)
          ? PLAN_FAILURE.NON_POSITIVE_DURATION
          : PLAN_FAILURE.SEARCH_POLICY_LIMIT;
      // Either search outcome yields to a proof about where the span sits. A
      // role is written as consecutive tokens from beat 0, so a span boundary no
      // admitted token sequence reaches cannot be written whatever the search
      // bounds, the budget or the caution opt-in; saying "search limit" there
      // sends a reader looking for a bound to raise. Only a boundary
      // `classifyPosition` proves unreachable counts: an off-grid position it
      // calls CAUTION_REPRESENTABLE keeps the search's own code.
      if (failure !== PLAN_FAILURE.NON_POSITIVE_DURATION) {
        const start = f(item.start);
        const end = start.add(item.duration);
        const unreachable = [['start', start], ['end', end]]
          .filter(([, beat]) => classifyPosition(beat) === POSITION_CLASS.NOT_FINAL_REPRESENTABLE)
          .map(([boundary, beat]) => Object.freeze({ boundary, position: beat.toString() }));
        if (unreachable.length) {
          diagnostics.push(diagnostic(
            EMIT_DIAGNOSTICS.BOUNDARY_NOT_FINAL_REPRESENTABLE,
            DIAGNOSTIC_SEVERITY.ERROR,
            `${role}: the ${item.kind} span ${item.start}..${end} (${item.eventId ?? 'silence between events'}) ${unreachable.map(entry => `${entry.boundary}s at beat ${entry.position}`).join(' and ')}, and no sequence of admitted Final length tokens reaches ${unreachable.length > 1 ? 'either position' : 'that position'}: every sum of admitted token lengths has a whole-note denominator dividing the lcm of the token denominators, and ${unreachable.length > 1 ? 'neither position\'s does' : 'that position\'s does not'}. This is a proof, not a search limit, and no search bound, budget or caution opt-in changes it. The emitter fails closed and does not move the boundary.`,
            {
              role,
              eventId: item.eventId,
              duration: item.duration.toString(),
              start: item.start,
              end: end.toString(),
              unreachableBoundaries: Object.freeze(unreachable),
              planFailure: failure,
              completenessProven: true,
            },
          ));
          continue;
        }
      }
      const cautionHint = lattice.cautionLengthOptIn
        ? ''
        : ' FINAL_ALLOWED_WITH_CAUTION plain lengths are not admitted here; cautionLengthOptIn widens the lattice.';
      const messages = {
        [PLAN_FAILURE.BUDGET_EXHAUSTED]: `${role}: the exact Final duration search for ${item.duration} beats at ${item.start} ran out of node budget. This is a search limit, not proof that no exact token decomposition exists. The emitter fails closed rather than approximating.`,
        [PLAN_FAILURE.NON_POSITIVE_DURATION]: `${role}: event ${item.eventId} has a non-positive duration ${item.duration}. MOBILE_SYNTAX §4 makes zero-duration events FINAL_FORBIDDEN.`,
        [PLAN_FAILURE.SEARCH_POLICY_LIMIT]: `${role}: the bounded exact Final duration search found no plan for ${item.duration} beats at ${item.start} within the current implementer limits (tie-segment cap, off-grid-token cap, grid-aligned head restriction). This is not proof that no exact token decomposition exists — a duration that needs more segments or more off-grid tokens than those bounds allow lands here too. The emitter fails closed and does not approximate.${cautionHint}`,
      };
      const codes = {
        [PLAN_FAILURE.BUDGET_EXHAUSTED]: EMIT_DIAGNOSTICS.DURATION_SEARCH_BUDGET_EXHAUSTED,
        [PLAN_FAILURE.NON_POSITIVE_DURATION]: EMIT_DIAGNOSTICS.DURATION_NON_POSITIVE,
        [PLAN_FAILURE.SEARCH_POLICY_LIMIT]: EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT,
      };
      diagnostics.push(diagnostic(
        codes[failure],
        DIAGNOSTIC_SEVERITY.ERROR,
        messages[failure],
        {
          role,
          eventId: item.eventId,
          duration: item.duration.toString(),
          start: item.start,
          planFailure: failure,
          completenessProven: false,
        },
      ));
    }
  }
  if (diagnostics.some(item => item.severity === DIAGNOSTIC_SEVERITY.ERROR)) return { diagnostics, mml: null };

  // --- joint DP over (default length, octave) ------------------------------
  const stateKey = (length, octave) => `${length}|${octave === null ? 'unset' : octave}`;
  let states = new Map([[stateKey(facts.defaultLength, null), {
    cost: 0,
    length: facts.defaultLength,
    octave: null,
    back: null,
    choice: null,
  }]]);
  const history = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = new Map();
    const offer = (key, entry) => {
      const existing = next.get(key);
      // Strict improvement only: equal-cost candidates keep the first one
      // reached, and every candidate list below has a fixed order, so the whole
      // plan is deterministic.
      if (!existing || entry.cost < existing.cost) next.set(key, entry);
    };

    for (const [fromKey, state] of states) {
      if (item.kind === 'tempo') {
        offer(stateKey(state.length, state.octave), {
          cost: state.cost + stateTokenCost(item.bpm),
          length: state.length,
          octave: state.octave,
          back: fromKey,
          choice: { text: `t${item.bpm}` },
        });
        continue;
      }

      const volumeCost = volumeToken[index] ? volumeToken[index].length : 0;
      for (const candidate of candidates) {
        const switchCost = candidate === state.length ? 0 : defaultLengthSwitchCost(candidate);

        if (item.kind === 'rest') {
          // Rests carry no attack, so their segments are consecutive `r` tokens
          // with no tie between them; every segment pays exactly its own `r`.
          const restPlan = planFor(item, candidate, REST_SEGMENT_COST);
          if (!restPlan.ok) continue;
          offer(stateKey(candidate, state.octave), {
            cost: state.cost + switchCost + restPlan.plan.cost,
            length: candidate,
            octave: state.octave,
            back: fromKey,
            choice: { candidate, segments: restPlan.plan.segments, kind: 'rest' },
          });
          continue;
        }

        for (const spelling of spellingsFor.get(item.pitch)) {
          // `plan.cost` already charges every segment its repeated note name and
          // its `&`; the first segment has no `&` to pay, so one comes back off.
          const notePlan = planFor(item, candidate, spelling.text.length + 1);
          if (!notePlan.ok) continue;
          const shift = octaveShift(state.octave, spelling.octave);
          const cost = state.cost
            + (item.continuation ? 1 : 0)
            + volumeCost
            + shift.length
            + switchCost
            + notePlan.plan.cost - 1;
          offer(stateKey(candidate, spelling.octave), {
            cost,
            length: candidate,
            octave: spelling.octave,
            back: fromKey,
            choice: { candidate, segments: notePlan.plan.segments, kind: 'note', spelling, shift, volume: volumeToken[index] },
          });
        }
      }
    }

    if (!next.size) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT,
        DIAGNOSTIC_SEVERITY.ERROR,
        `${role}: no legal Final serialization state survives at event ${item.eventId ?? index} within the current implementer search limits. This is not proof that no exact serialization exists.`,
        { role, eventId: item.eventId ?? null, planFailure: PLAN_FAILURE.SEARCH_POLICY_LIMIT, completenessProven: false },
      ));
      return { diagnostics, mml: null };
    }
    history.push(states);
    states = next;
  }

  // Deterministic tie-break on the final state: cheapest, then lowest default
  // length, then lowest octave.
  let best = null;
  for (const [, state] of [...states].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    if (!best || state.cost < best.cost) best = state;
  }

  const chosen = [];
  let cursor = best;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    chosen[index] = cursor.choice;
    cursor = history[index].get(cursor.back);
  }

  // --- render --------------------------------------------------------------
  let out = '';
  let currentLength = facts.defaultLength;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const choice = chosen[index];
    if (item.kind === 'tempo') {
      out += choice.text;
      continue;
    }
    if (item.kind === 'note' && item.continuation) out += '&';
    if (choice.kind === 'note') {
      if (choice.volume) out += choice.volume;
      out += choice.shift;
    }
    if (choice.candidate !== currentLength) {
      out += `l${choice.candidate}`;
      currentLength = choice.candidate;
    }
    const head = choice.kind === 'note' ? choice.spelling.text : 'r';
    const joiner = choice.kind === 'note' ? '&' : '';
    out += choice.segments.map(segment => head + segment.suffix).join(joiner);
  }

  return { diagnostics, mml: out };
}

// ── gates and entry point ──────────────────────────────────────────────────

// A rest is silence, not material a role plays. A rest placed in a role is
// written as that role's rest; a rest no role holds -- a notated MusicXML rest
// carried through from the Source-Faithful Baseline -- occupies no slot, exactly
// as the silence between MIDI notes (which have no rest events at all) occupies
// none. It is left out of the role streams rather than reported as unassigned
// material, and the baseline keeps it untouched.
const isRoleSpan = event => event && SPAN_KINDS.has(event.kind)
  && (event.kind === 'note' || ROLE_SET.has(event.role));

function collectSpanEvents(project) {
  const events = Array.isArray(project?.events) ? project.events : [];
  return events.filter(isRoleSpan);
}

function normalizeTempoEvents(project) {
  const diagnostics = [];
  const events = [...(Array.isArray(project?.tempoEvents) ? project.tempoEvents : [])]
    .sort((left, right) => f(left.beat).cmp(right.beat)
      || (String(left.id) < String(right.id) ? -1 : 1));

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!Number.isInteger(event.bpm)) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.TEMPO_NOT_INTEGER,
        DIAGNOSTIC_SEVERITY.ERROR,
        `Tempo ${event.bpm} at beat ${event.beat} is not an integer. Final MML writes an integer T value and the emitter will not round the tempo.`,
        { tempoId: event.id, beat: event.beat, bpm: event.bpm },
      ));
    } else if (event.bpm < syntax.tempoMin || event.bpm > syntax.tempoMax) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.TEMPO_OUT_OF_FINAL_RANGE,
        DIAGNOSTIC_SEVERITY.ERROR,
        `Tempo ${event.bpm} at beat ${event.beat} is outside the official range ${syntax.tempoMin}–${syntax.tempoMax}. It is not clamped.`,
        { tempoId: event.id, beat: event.beat, bpm: event.bpm },
      ));
    }
    if (index > 0 && f(event.beat).cmp(events[index - 1].beat) <= 0) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.TEMPO_POSITION_NOT_STRICTLY_INCREASING,
        DIAGNOSTIC_SEVERITY.ERROR,
        `Two Tempo events share beat ${event.beat} (${events[index - 1].bpm} from ${(events[index - 1].sourceIds ?? []).join(', ') || 'no source'}; ${event.bpm} from ${(event.sourceIds ?? []).join(', ') || 'no source'}). The emitter will not choose between them.`,
        { beat: event.beat, tempoIds: [events[index - 1].id, event.id], bpms: [events[index - 1].bpm, event.bpm] },
      ));
    }
  }

  if (events.length && f(events[0].beat).cmp(0) !== 0) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.TEMPO_INITIAL_MISSING,
      DIAGNOSTIC_SEVERITY.ERROR,
      `The first Tempo event is at beat ${events[0].beat}. Every non-empty role must carry the same initial Tempo at beat 0 (MOBILE_SYNTAX §7).`,
      { beat: events[0].beat },
    ));
  }
  if (!events.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.TEMPO_INITIAL_MISSING,
      DIAGNOSTIC_SEVERITY.ERROR,
      'The candidate carries no Tempo event. A non-empty Final role must set Tempo at beat 0.',
      {},
    ));
  }

  return { diagnostics, events };
}

/**
 * Drop every Tempo event that restates the Tempo already in effect.
 *
 * MOBILE_SYNTAX §7 (2026-09-23-v3): such an event changes no timing and is not
 * part of the Tempo Map; a Final delivered under machine delivery collapses it.
 * Exact and machine-determined: the Tempo in force at every beat is the same
 * before and after, and the round trip compares the emitted string against the
 * collapsed map. A Tempo *change* is never dropped, wherever it falls. Runs on
 * events `normalizeTempoEvents` accepted, so they are strictly increasing.
 */
function collapseTempoRestatements(events) {
  const kept = [];
  const collapsed = [];
  for (const event of events) {
    const inEffect = kept.at(-1);
    if (inEffect && f(event.beat).cmp(inEffect.beat) > 0 && event.bpm === inEffect.bpm) {
      collapsed.push(Object.freeze({ tempoId: event.id ?? null, beat: String(event.beat), bpm: event.bpm, inEffectSince: String(inEffect.beat), inEffectTempoId: inEffect.id ?? null }));
      continue;
    }
    kept.push(event);
  }
  return { kept, collapsed };
}

// Whether this emission may collapse restatements: asked for, and the identity
// it is decided under has machine-delivery authority under the schema that
// carries the rule.
function tempoCollapseDecision(settings) {
  if (!settings.collapseTempoRestatements) return null;
  const identity = settings.canonical ?? EFFECTIVE_RULESET.canonical;
  const schema = machineDeliverySchemaOf(identity);
  const effective = machineDeliveryAuthority(identity).active && schema === MACHINE_DELIVERY_SCHEMA_V2;
  return { requested: true, effective, schema, applied: false, collapsed: [] };
}

function tempoBlock(tempo) {
  if (!tempo) return null;
  return Object.freeze({
    requested: true,
    applied: tempo.applied === true,
    machineDeliverySchema: tempo.schema,
    reason: tempo.effective ? null : `${tempo.schema} does not collapse Tempo restatements; the Tempo Map is written as the candidate carries it`,
    collapsed: Object.freeze([...tempo.collapsed]),
  });
}

/**
 * The gates that must hold before any serialization is attempted.
 *
 * G10 is consumed here rather than re-derived: `enforceMicroGaps` owns the
 * published sub-1/64 policy and this emitter is its second declared consumer.
 * No threshold, grid or per-class outcome is re-implemented.
 *
 * When Technical Timing Repair is enabled it runs *between* the enforcement pass
 * and these gates, and the gates then grade the repaired candidate. That
 * ordering matters: repair never answers a gate, it only changes which candidate
 * the gates are asked about, and the candidate it produces is re-graded by the
 * same `enforceMicroGaps` that rejected the original.
 */
function evaluateGates(project, options) {
  const diagnostics = [];
  let status = EMIT_STATUS.PASS;

  const implementationBlockers = studioFinalBlockers();
  if (implementationBlockers.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.IMPLEMENTATION_BLOCKED,
      DIAGNOSTIC_SEVERITY.PENDING,
      `Studio Final implementation is blocked: ${implementationBlockers.join(', ')}.`,
      { blockers: Object.freeze(implementationBlockers) },
    ));
    status = EMIT_STATUS.PENDING;
  }

  let microGap = enforceMicroGaps(project, { releaseEvidenceRegistry: options.releaseEvidenceRegistry });
  let candidate = project;
  const repair = { requested: options.technicalTimingRepair === true, applied: false, result: null };

  // Opt-in, and never a shortcut. A repair that does not reach PASS, or that
  // leaves the candidate ineligible for Final emission, changes nothing at all:
  // `microGap` keeps the original verdict and the gates below refuse exactly as
  // they did before this layer existed.
  if (repair.requested && microGap.rejectedIntervalKeys.length) {
    repair.result = repairTechnicalTiming(project, { enforcement: microGap, releaseEvidenceRegistry: options.releaseEvidenceRegistry });
    if (repair.result.status === REPAIR_STATUS.PASS
      && repair.result.finalEmissionEligible
      && repair.result.repairedProject) {
      candidate = repair.result.repairedProject;
      // The re-grade of the repaired candidate by the authoritative enforcement
      // pass, not this module's own opinion of its own output.
      microGap = repair.result.verification;
      repair.applied = true;
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.TECHNICAL_TIMING_REPAIR_APPLIED,
        DIAGNOSTIC_SEVERITY.NOTICE,
        `Technical Timing Repair normalized ${repair.result.repairedIntervalKeys.length} Canonically classified technical interval(s). Everything below grades the repaired candidate "${candidate.id}"; the pre-repair timing is recorded in this result and in the candidate's own provenance.`,
        {
          repairedProjectId: candidate.id,
          baselineProjectId: project.id,
          repairedIntervalKeys: repair.result.repairedIntervalKeys,
        },
      ));
    } else {
      // A notice, not a verdict. The unrepaired original is still graded below,
      // and its own blockers decide the outcome.
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.TECHNICAL_TIMING_REPAIR_UNAVAILABLE,
        DIAGNOSTIC_SEVERITY.NOTICE,
        `Technical Timing Repair returned ${repair.result.status} and did not produce a Final-eligible candidate. The original candidate is graded unchanged.`,
        {
          repairStatus: repair.result.status,
          unrepairedIntervalKeys: repair.result.unrepairedIntervalKeys,
          repairDiagnostics: Object.freeze(repair.result.diagnostics.map(item => item.code)),
        },
      ));
    }
  }

  // Provisional release rendering (ACCEPTANCE_CRITERIA "Delivered first,
  // flagged for listening", 2026-09-23-v3). Only on request, only under an
  // active machine-delivery identity whose schema classifies this very result
  // NON_BLOCKING_PENDING, and only through the renderer's own worklist
  // discipline. Like the repair above, it never answers a gate: it changes which
  // project is serialized, the rendering is re-graded by the same enforcement,
  // and anything short of a clean rendering leaves the original verdict in place.
  //
  // What the result reports is the stored candidate's micro-timing, not the
  // rendering's: the stored intervals stay UNKNOWN and the report says so.
  const storedMicroGap = microGap;
  const provisional = { requested: options.provisionalReleaseRendering === true, applied: false, classification: null, schema: null, result: null, reason: null };
  if (provisional.requested) {
    const identity = options.canonical ?? EFFECTIVE_RULESET.canonical;
    provisional.schema = machineDeliverySchemaOf(identity);
    provisional.classification = deliveryClassOf('microTiming', { status: microGap.status, blockers: microGap.blockers }, { canonical: identity });
    if (repair.applied || microGap.status !== 'PENDING') {
      provisional.reason = `micro-timing is ${microGap.status}; there is nothing to render provisionally`;
    } else if (!machineDeliveryAuthority(identity).active) {
      provisional.reason = 'the Canonical identity has no machine-delivery authority';
    } else if (provisional.classification !== DELIVERY_CLASS.NON_BLOCKING_PENDING) {
      provisional.reason = `micro-timing is ${provisional.classification} under ${provisional.schema}`;
    } else {
      provisional.result = renderProvisionalReleases(candidate, { enforcement: microGap, releaseEvidenceRegistry: options.releaseEvidenceRegistry });
      if (provisional.result.status === REPAIR_STATUS.PASS && provisional.result.renderedProject) {
        candidate = provisional.result.renderedProject;
        microGap = provisional.result.verification;
        provisional.applied = true;
        diagnostics.push(diagnostic(
          EMIT_DIAGNOSTICS.PROVISIONAL_RELEASES_RENDERED,
          DIAGNOSTIC_SEVERITY.NOTICE,
          `${provisional.result.renderings.length} release(s) whose meaning is unproven are held provisionally to the following attack or next grid point for delivery (${provisional.schema}). The emitted MML describes the rendering "${candidate.id}"; the stored candidate "${project.id}" is unchanged and its intervals stay UNKNOWN. The result's provisionalReleaseRendering lists each one.`,
          {
            renderedProjectId: candidate.id,
            storedProjectId: project.id,
            heldEventCount: provisional.result.heldEventIds.length,
          },
        ));
      } else {
        diagnostics.push(diagnostic(
          EMIT_DIAGNOSTICS.PROVISIONAL_RELEASE_RENDERING_UNAVAILABLE,
          DIAGNOSTIC_SEVERITY.NOTICE,
          `Provisional release rendering returned ${provisional.result.status} and produced no deliverable rendering. The stored candidate is graded unchanged.`,
          { renderingStatus: provisional.result.status, renderingDiagnostics: Object.freeze(provisional.result.diagnostics.map(item => item.code)) },
        ));
      }
    }
  }

  // G10's two proof codes (FINAL_REPRESENTABILITY_PROOFS) are proofs about this
  // candidate, not open questions: MICRO_TIMING_BOUNDARY_NOT_FINAL_REPRESENTABLE
  // (a position no admitted token sequence reaches) and
  // MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE (preserved
  // source-supported material no admitted token can carry). They are kept out of
  // MICRO_GAP_BLOCKED_PENDING (whose "unproven" wording would be false for them)
  // and reported below as the confirmed negatives they are:
  // MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE and
  // SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE. Every other G10 blocker keeps
  // exactly the diagnostic it had, and MICRO_GAP_BLOCKED_PENDING is never raised
  // with an empty list.
  const boundaryProven = microGap.blockers.includes(MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE);
  const anyProof = microGap.blockers.some(code => FINAL_REPRESENTABILITY_PROOFS.includes(code));
  const openBlockers = microGap.blockers.filter(code => !FINAL_REPRESENTABILITY_PROOFS.includes(code));
  if (microGap.status === 'FAIL') {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.MICRO_GAP_TECHNICAL_RESIDUE,
      DIAGNOSTIC_SEVERITY.ERROR,
      `G10 rejected ${microGap.rejectedIntervalKeys.length} confirmed technical sub-1/64 interval(s). ${repair.requested ? 'Technical Timing Repair could not normalize them exactly, and a correct refusal is preferred to a guessed normalization.' : 'Technical Timing Repair was not requested; a correct refusal is preferred to a guessed normalization.'}`,
      { blockers: microGap.blockers, rejectedIntervalKeys: microGap.rejectedIntervalKeys },
    ));
    status = EMIT_STATUS.FAIL;
  } else if (microGap.status !== 'PASS' && (openBlockers.length || !anyProof)) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.MICRO_GAP_BLOCKED_PENDING,
      DIAGNOSTIC_SEVERITY.PENDING,
      `G10 could not clear this candidate: ${openBlockers.join(', ')}. Unproven sub-grid material is never acted on.`,
      { blockers: Object.freeze(openBlockers), blockedIntervalKeys: microGap.blockedIntervalKeys },
    ));
    if (status !== EMIT_STATUS.FAIL) status = EMIT_STATUS.PENDING;
  }

  // A position a role has to reach -- an onset (a role's earliest onset after
  // a silence shorter than any Final token among them), a rest boundary, or a
  // note release no release representation can move -- that G10 proves no
  // admitted Final token sequence reaches and that no other G10 outcome decides
  // (coverage NONE). FAIL, not PENDING. DIAGNOSTIC_SEVERITY.ERROR is "a
  // confirmed negative: this candidate cannot be Final-emitted as it stands",
  // and PENDING is "an unresolved Canonical/evidence question"; this is the
  // first and not the second. Nothing in this build answers it the way evidence
  // answers an unproven interval (a classification, and for confirmed residue
  // Technical Timing Repair), or the way an evidence-backed release
  // representation answers MICRO_TIMING_RELEASE_NOT_FINAL_REPRESENTABLE -- which
  // G10 raises only for a release with no keep claim and at least one valid
  // representation, and which under machine delivery a qualifying release may
  // also meet by the provisional hold. An onset is an attack and is never
  // moved, no rest is moved to make a role writable, release representation
  // refuses a release under a keep claim and every invalid option, the
  // provisional hold only ever takes a valid extension, and the arithmetic does
  // not depend on any search bound, budget, caution opt-in or evidence. So a
  // release whose every representation is invalid, and that no analysed
  // interval of its own decides (its sub-grid duration or the sub-grid gap
  // after it; a sub-grid rest starting at it decides only the rest's start),
  // gets this FAIL whether a keep claim on it is accepted,
  // pending, rejected or absent, and a release with a valid representation
  // gets it only while a keep claim takes that representation away.
  // The same proof met at serialization is BOUNDARY_NOT_FINAL_REPRESENTABLE,
  // and the other provable G10-side negative,
  // SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE, is FAIL too. G10's own status
  // is unchanged; this is the emitter's answer to whether the candidate can be
  // written. The locations are named, bounded like the other lists a
  // diagnostic carries, with the true count beside them.
  if (boundaryProven) {
    const unreachable = (microGap.unsupportedBoundaries ?? []).filter(item => item.coverage === BOUNDARY_COVERAGE.NONE);
    const count = unreachable.length;
    const where = item => `${item.role} event ${item.eventId} (${item.kind} ${item.boundary}) at beat ${item.position}`;
    const isRelease = item => item.kind === 'note' && item.boundary === 'end';
    const what = item => (item.kind === 'rest' ? 'a rest boundary' : isRelease(item) ? 'a note release' : 'an onset');
    const named = count === 1
      ? `${where(unreachable[0])} is ${what(unreachable[0])} its Final role has to reach, and no admitted Final token sequence reaches it`
      : `${count} ${unreachable.some(isRelease) ? 'onset, note release or rest boundaries' : 'onset or rest boundaries'} a Final role has to reach sit where no admitted Final token sequence reaches${count ? `, the first ${where(unreachable[0])}; unreachableBoundaries lists ${count > MAX_REPORTED_BOUNDARIES ? `the first ${MAX_REPORTED_BOUNDARIES}` : 'them'}` : ''}`;
    // Two arithmetic facts back these entries, and the message states the ones
    // that apply. A position whose whole-note denominator does not divide the
    // lcm of the admitted token denominators is never a sum of token lengths;
    // a role's earliest onset after beat 0 and before the shortest admitted
    // token (LEADING_ONSET_REASON) is not either, whatever its denominator.
    // With no leading-onset entry the sentence is exactly the one this proof
    // has always carried.
    const leading = unreachable.filter(item => item.reason === LEADING_ONSET_REASON);
    const byDenominator = unreachable.filter(item => item.reason !== LEADING_ONSET_REASON);
    const shortest = SHORTEST_ADMITTED_TOKEN_BEATS;
    const arithmetic = !leading.length
      ? `, whose whole-note denominator divides the lcm of the admitted token denominators; ${count > 1 ? 'none of these positions\' does' : 'this position\'s does not'}`
      : [
        byDenominator.length
          ? `, whose whole-note denominator divides the lcm of the admitted token denominators; ${byDenominator.length > 1 ? `the denominators of ${byDenominator.map(item => item.position).join(', ')} do not` : `the denominator of ${byDenominator[0].position} does not`}; and`
          : ',',
        ` no admitted Final token is shorter than ${shortest.toString()} beat (${shortest.div(4).toString()} of a whole note), so no position after beat 0 and before beat ${shortest.toString()} is reached; ${leading.map(item => item.position).join(', ')} ${leading.length > 1 ? 'are such positions' : 'is such a position'}`,
      ].join('');
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.MICRO_GAP_BOUNDARY_NOT_FINAL_REPRESENTABLE,
      DIAGNOSTIC_SEVERITY.ERROR,
      `G10 (${MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE}): ${named}. A role is written as consecutive tokens from beat 0, so every position it reaches is a sum of admitted token lengths${arithmetic}. This is a proof about ${count > 1 ? 'those positions' : 'the position'}, not a search limit and not an unproven question: no search bound, budget, caution opt-in or evidence changes where ${count > 1 ? 'they are' : 'it is'}, and nothing is moved to make the role writable -- no attack, no rest, and no release that release representation refuses (one under a keep claim, or one with no valid representation). This candidate cannot be Final-emitted as it stands; the emitter fails closed.`,
      {
        blocker: MICRO_GAP_BLOCKERS.BOUNDARY_NOT_FINAL_REPRESENTABLE,
        unreachableBoundaryCount: count,
        unreachableBoundaries: Object.freeze(unreachable.slice(0, MAX_REPORTED_BOUNDARIES).map(item => Object.freeze({
          role: item.role,
          eventId: item.eventId,
          kind: item.kind,
          boundary: item.boundary,
          position: item.position,
          reason: item.reason,
        }))),
        unreachableBoundariesTruncated: count > MAX_REPORTED_BOUNDARIES,
        completenessProven: true,
      },
    ));
    status = EMIT_STATUS.FAIL;
  }

  // A source-supported sub-grid interval must survive untouched, and no admitted
  // Final token is shorter than the grid, so it cannot be written at all. The
  // emitter refuses instead of shortening, absorbing or quantizing it. This is
  // the emitter's answer to G10's
  // MICRO_TIMING_SOURCE_SUPPORTED_NOT_FINAL_REPRESENTABLE, which G10 raises
  // exactly when `preservedIntervalKeys` is non-empty.
  if (microGap.preservedIntervalKeys?.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.SOURCE_SUPPORTED_INTERVAL_NOT_REPRESENTABLE,
      DIAGNOSTIC_SEVERITY.ERROR,
      `${microGap.preservedIntervalKeys.length} source-supported sub-1/64 interval(s) must be preserved exactly, but no Final token is shorter than the 1/64 safe grid. The emitter fails closed rather than destroying them.`,
      { preservedIntervalKeys: microGap.preservedIntervalKeys },
    ));
    status = EMIT_STATUS.FAIL;
  }

  const pendingDecisions = (project.decisions ?? []).filter(decision => decision.status === 'pending');
  if (pendingDecisions.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.PENDING_DECISIONS_PRESENT,
      DIAGNOSTIC_SEVERITY.PENDING,
      `${pendingDecisions.length} arbitration decision(s) are still pending.`,
      { decisionIds: Object.freeze(pendingDecisions.map(decision => decision.id)) },
    ));
    if (status !== EMIT_STATUS.FAIL) status = EMIT_STATUS.PENDING;
  }

  // The emitter must never become a readiness bypass. When the caller supplies a
  // readiness report, every blocking gate counts except `technical` — that one
  // grades the MML this emitter has not produced yet, so requiring it here would
  // be circular.
  if (options.readiness) {
    const blocking = deliveryBlockingGates(options.readiness).filter(name => name !== 'technical');
    if (blocking.length) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.READINESS_BLOCKED,
        DIAGNOSTIC_SEVERITY.PENDING,
        `Final readiness is blocked on: ${blocking.join(', ')}. The emitter does not emit past a blocking gate.`,
        { blocking: Object.freeze(blocking) },
      ));
      if (status !== EMIT_STATUS.FAIL) status = EMIT_STATUS.PENDING;
    }
  }

  return { status, diagnostics, microGap: provisional.applied ? storedMicroGap : microGap, repair, provisional, candidate };
}

/**
 * Serialize a candidate Canonical project into six Final MML role bodies.
 *
 * Never throws for a musical, representability or policy outcome — those are the
 * structured result. `throw` means the caller passed something that is not a
 * Canonical project.
 */
export function emitFinalMml(project, options = {}) {
  if (!project || typeof project !== 'object') throw Error('Canonical project is required');
  const settings = normalizeEmitOptions(options);
  const facts = parserFacts();
  const lattice = buildTokenLattice({ cautionLengthOptIn: settings.cautionLengthOptIn });

  const gates = evaluateGates(project, settings);
  gates.extra = { provisional: gates.provisional, tempo: tempoCollapseDecision(settings) };
  const diagnostics = [...gates.diagnostics];
  if (gates.status !== EMIT_STATUS.PASS) {
    return buildResult(gates.status, null, [], diagnostics, gates.microGap, null, facts, gates.repair, gates.extra);
  }

  // Everything below serializes `candidate`: the input project, or the repaired
  // one when Technical Timing Repair produced a Final-eligible result. The
  // round-trip gate therefore compares against the repaired semantics, which is
  // what the emitted string actually claims to mean.
  const candidate = gates.candidate;
  const spans = collectSpanEvents(candidate);
  const unassigned = spans.filter(event => !ROLE_SET.has(event.role));
  if (unassigned.length) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.EVENT_ROLE_UNASSIGNED,
      DIAGNOSTIC_SEVERITY.ERROR,
      `${unassigned.length} note event(s) carry no six-slot role. The emitter will not choose a slot for them.`,
      { eventIds: Object.freeze(unassigned.slice(0, 20).map(event => event.id)) },
    ));
    return buildResult(EMIT_STATUS.FAIL, null, [], diagnostics, gates.microGap, null, facts, gates.repair, gates.extra);
  }

  const tempo = normalizeTempoEvents(candidate);
  diagnostics.push(...tempo.diagnostics);
  if (tempo.diagnostics.some(item => item.severity === DIAGNOSTIC_SEVERITY.ERROR)) {
    return buildResult(EMIT_STATUS.FAIL, null, [], diagnostics, gates.microGap, null, facts, gates.repair, gates.extra);
  }
  // Only restatements go, and only where the rule is in force. Everything below
  // (role splits, the tempo tokens and the round trip) reads the collapsed map.
  if (gates.extra.tempo?.effective) {
    const { kept, collapsed } = collapseTempoRestatements(tempo.events);
    tempo.events = kept;
    gates.extra.tempo.applied = true;
    gates.extra.tempo.collapsed = collapsed;
    if (collapsed.length) {
      diagnostics.push(diagnostic(
        EMIT_DIAGNOSTICS.TEMPO_RESTATEMENTS_COLLAPSED,
        DIAGNOSTIC_SEVERITY.NOTICE,
        `${collapsed.length} Tempo event(s) restate the Tempo already in effect and change no timing. They are not part of the Tempo Map and are not written (MOBILE_SYNTAX §7, ${gates.extra.tempo.schema}).`,
        { collapsed: Object.freeze([...collapsed]) },
      ));
    }
  }

  const roles = [];
  const expected = [];
  for (const role of ROLES) {
    const roleSpans = spans.filter(event => event.role === role);
    if (!roleSpans.length) {
      roles.push({ role, empty: true, mml: '', characters: 0, attacks: 0, end: '0' });
      expected.push(Object.freeze({ role, empty: true }));
      continue;
    }
    const stream = buildRoleStream(role, roleSpans);
    diagnostics.push(...stream.diagnostics);
    if (!stream.pieces) {
      roles.push({ role, empty: false, mml: null, characters: null, attacks: null, end: null });
      continue;
    }
    const split = splitAtTempo(role, stream.pieces, tempo.events, stream.end);
    diagnostics.push(...split.diagnostics);
    if (split.diagnostics.some(item => item.severity === DIAGNOSTIC_SEVERITY.ERROR)) {
      roles.push({ role, empty: false, mml: null, characters: null, attacks: null, end: stream.end.toString() });
      continue;
    }
    const serialized = serializeItems(role, split.items, lattice, facts, settings);
    diagnostics.push(...serialized.diagnostics);
    expected.push(expectedRoleSemantics(role, stream.pieces, tempo.events, stream.end));
    roles.push({
      role,
      empty: false,
      mml: serialized.mml,
      characters: serialized.mml === null ? null : serialized.mml.length,
      attacks: stream.pieces.filter(piece => piece.kind === 'note').length,
      end: stream.end.toString(),
    });
  }

  if (roles.every(entry => entry.empty)) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.NO_NON_EMPTY_ROLE,
      DIAGNOSTIC_SEVERITY.ERROR,
      'The candidate assigns no note or rest event to any of the six roles.',
      {},
    ));
  }

  if (diagnostics.some(item => item.severity === DIAGNOSTIC_SEVERITY.ERROR)) {
    return buildResult(EMIT_STATUS.FAIL, null, roles, diagnostics, gates.microGap, null, facts, gates.repair, gates.extra);
  }
  if (diagnostics.some(item => item.severity === DIAGNOSTIC_SEVERITY.PENDING)) {
    return buildResult(EMIT_STATUS.PENDING, null, roles, diagnostics, gates.microGap, null, facts, gates.repair, gates.extra);
  }

  // Character budget is checked against the one existing contract value. P1
  // leaves exact client counter semantics unverified, so the unit is named
  // rather than claimed.
  const overBudget = roles.filter(entry => entry.characters > facts.characterLimit);
  for (const entry of overBudget) {
    diagnostics.push(diagnostic(
      EMIT_DIAGNOSTICS.CHARACTER_BUDGET_EXCEEDED,
      DIAGNOSTIC_SEVERITY.ERROR,
      `${entry.role}: ${entry.characters} characters exceeds the ${facts.characterLimit} limit by ${entry.characters - facts.characterLimit}. Reducing the music to fit is an arrangement decision, not a serialization one; no note, attack or rest was removed.`,
      {
        role: entry.role,
        characters: entry.characters,
        limit: facts.characterLimit,
        overBy: entry.characters - facts.characterLimit,
        attacks: entry.attacks,
        unit: 'javascript-string-length',
      },
    ));
  }
  if (overBudget.length) {
    return buildResult(EMIT_STATUS.FAIL, null, roles, diagnostics, gates.microGap, null, facts, gates.repair, gates.extra);
  }

  const combined = `MML@${roles.map(entry => entry.mml).join(',')};`;
  return finalizeWithRoundTrip(combined, expected, roles, diagnostics, gates.microGap, settings, facts, gates.repair, gates.extra);
}

/**
 * The mandatory Final gate: read the emitted string back with the authoritative
 * parser, compare semantics rather than tokens, and refuse anything that does
 * not match.
 *
 * It is a separate exported step so the enforcement itself is directly
 * testable. By construction nothing the serializer produces should ever reach
 * here in a failing state, which is exactly why the enforcement needs its own
 * coverage: a redundant check that is never exercised silently stops being a
 * check at all.
 */
export function finalizeWithRoundTrip(combinedMml, expected, roles, diagnostics, microGap, settings, facts, repair = null, extra = {}) {
  const readback = verifyFinalReadback(combinedMml, expected, settings);
  const all = [...diagnostics, ...readback.diagnostics];
  if (readback.report.status !== 'PASS') {
    return buildResult(EMIT_STATUS.FAIL, null, roles, all, microGap, readback.report, facts, repair, extra);
  }
  return buildResult(EMIT_STATUS.PASS, combinedMml, roles, all, microGap, readback.report, facts, repair, extra);
}

/**
 * The repair block of an emit result.
 *
 * `microGap` above reports the *graded* candidate, which after a successful
 * repair is the repaired one and is therefore clean. This block is what keeps the
 * original visible: what was presented, what was normalized, the exact
 * before/after timing of each change, and which project the emitted MML
 * describes. The two must never collapse into one another.
 */
function repairBlock(repair) {
  if (!repair?.requested) return null;
  const result = repair.result;
  if (!result) {
    return Object.freeze({
      requested: true,
      applied: false,
      status: null,
      reason: 'no interval was rejected as technical residue, so no repair was attempted',
      presentedIntervalKeys: Object.freeze([]),
      repairedIntervalKeys: Object.freeze([]),
      unrepairedIntervalKeys: Object.freeze([]),
      repairs: Object.freeze([]),
      preRepair: null,
      baselineProjectId: null,
      repairedProjectId: null,
      diagnostics: Object.freeze([]),
    });
  }
  return Object.freeze({
    requested: true,
    applied: repair.applied === true,
    status: result.status,
    reason: null,
    presentedIntervalKeys: result.presentedIntervalKeys,
    repairedIntervalKeys: result.repairedIntervalKeys,
    unrepairedIntervalKeys: result.unrepairedIntervalKeys,
    repairs: result.repairs,
    // The pre-repair verdict, kept beside the post-repair one on purpose.
    preRepair: Object.freeze({
      rejectedIntervalKeys: result.presentedIntervalKeys,
      safeGrid: result.safeGrid,
    }),
    baselineProjectId: result.baselineProjectId,
    repairedProjectId: repair.applied === true ? result.repairedProjectId : null,
    diagnostics: result.diagnostics,
  });
}

/**
 * The provisional release block of an emit result: which releases the emitted
 * MML holds, where each one is held to, which unproven intervals that closes,
 * and the per-source offset figures the precondition read. `null` when the
 * caller did not ask for provisional rendering.
 *
 * The round trip compares the emitted MML with the rendering, the only
 * semantics that string claims. The rendering itself was checked against the
 * stored candidate (`verifyProvisionalRenderingInvariants`): it differs only in
 * the listed releases, each moved to exactly its listed point.
 */
function provisionalBlock(provisional) {
  if (!provisional?.requested) return null;
  const result = provisional.result;
  const applied = provisional.applied === true;
  return Object.freeze({
    requested: true,
    applied,
    status: result?.status ?? null,
    reason: result ? null : provisional.reason,
    classification: provisional.classification,
    machineDeliverySchema: provisional.schema,
    storedProjectId: result?.storedProjectId ?? null,
    renderedProjectId: applied ? result.renderedProjectId : null,
    // One record per held release: event, source and rendered release, and the
    // unproven intervals it closes. Everything else here is a count, so a Final
    // that holds many releases carries each one once.
    renderings: applied ? result.renderings : Object.freeze([]),
    heldEventCount: applied ? result.heldEventIds.length : 0,
    closedIntervalCount: applied ? result.intervalKeys.length : 0,
    releaseOffsetSources: result?.releaseOffsetSources ?? Object.freeze([]),
    preRendering: result?.preRendering ?? null,
    renderingVerification: applied ? Object.freeze({ status: result.verification.status, projectId: result.renderedProjectId }) : null,
    roundTripAgainst: applied ? 'rendered-project' : null,
    diagnostics: Object.freeze((result?.diagnostics ?? []).map(item => Object.freeze({ code: item.code, severity: item.severity, message: item.message }))),
    notice: PROVISIONAL_RENDERING_NOTICE,
  });
}

function buildResult(status, combinedMml, roles, diagnostics, microGap, roundTrip, facts, repair = null, { provisional = null, tempo = null } = {}) {
  return Object.freeze({
    status,
    combinedMml: status === EMIT_STATUS.PASS ? combinedMml : null,
    roles: Object.freeze(roles.map(Object.freeze)),
    characterCounts: Object.freeze({
      limit: facts.characterLimit,
      unit: 'javascript-string-length',
      clientEquivalenceVerified: false,
      perRole: Object.freeze(roles.map(entry => Object.freeze({ role: entry.role, characters: entry.characters }))),
    }),
    microGap: Object.freeze({
      status: microGap?.status ?? null,
      safeGrid: microGap?.safeGrid ?? null,
      preservedIntervalKeys: microGap?.preservedIntervalKeys ?? Object.freeze([]),
      rejectedIntervalKeys: microGap?.rejectedIntervalKeys ?? Object.freeze([]),
      blockedIntervalKeys: microGap?.blockedIntervalKeys ?? Object.freeze([]),
      policyConformant: microGap?.policy?.conformant ?? null,
      blockers: microGap?.blockers ?? Object.freeze([]),
      // Layer B / C counts: releases Final cannot express, and recorded
      // evidence-backed release representations that re-verified (or did not).
      releaseTiming: microGap?.releaseTiming ?? null,
      releaseRepresentationRecords: microGap?.releaseRepresentationRecords ?? null,
      // Which candidate the three lists above describe. After a successful
      // repair this is the repaired project, never the input.
      gradedProjectId: repair?.applied === true ? repair.result?.repairedProjectId ?? null : null,
    }),
    technicalTimingRepair: repairBlock(repair),
    provisionalReleaseRendering: provisionalBlock(provisional),
    tempoRestatements: tempoBlock(tempo),
    roundTrip,
    diagnostics: Object.freeze(diagnostics),
    canonical: canonicalIdentity(),
    notice: EMITTER_NOTICE,
  });
}

export { octaveShift };
