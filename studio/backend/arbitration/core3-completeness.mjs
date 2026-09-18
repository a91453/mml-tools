// Core3 musical completeness — ACCEPTANCE_CRITERIA.md Gate 4.
//
// Why this is a second module and not a branch of `core3.mjs`
// ----------------------------------------------------------
// `evaluateCore3Continuity()` answers a source-*relative* question: did this
// candidate remove, modify or move Core3 material away from the baseline
// without an approved reason, and does any source-supported Lead interval end
// up uncovered. That is a real gate, and it is the one that catches cleanup
// damage. It is not Gate 4.
//
// Gate 4 asks something a diff cannot answer:
//
//   Melody + Chord1 + Chord2 form a musically complete one-player arrangement
//   for a three-chord-capable instrument; Lead + Core Harmony + essential
//   Bass/inner support are present; Core3 remains intelligible without
//   Chord3-Chord5.
//
// A candidate identical to its baseline has a perfectly clean continuity audit
// and can still fail every clause of that: a baseline that only ever carried a
// Melody is unchanged and incomplete at the same time. So the two questions get
// two gates, and passing one never implies the other.
//
// Why this does not introduce a heuristic
// ---------------------------------------
// It introduces no evaluator at all. `suggestRoleCandidates()` already contains
// the Gate 4 evaluation, written in Gate 4's own vocabulary, and this module
// calls that one implementation rather than adding a second opinion beside it.
// What that evaluator answers is five musical FUNCTIONS -- lead continuity,
// principal harmony, bass skeleton, essential inner support and concurrent
// harmony resolution -- not note counts, and specifically NOT
// "Chord1 and Chord2 must contain notes":
//
//   * essentiality is established positively, by the silence-gap test against
//     the SOURCE: a lane that sounds while Core3 is silent is proven essential.
//     A true source rest produces no such window, so rests and sparse passages
//     stay legal by construction and there is no density threshold to tune;
//   * a legitimately reduced texture that the source supports satisfies the
//     five functions and reads COMPLETE;
//   * coverage windows stay diagnostic. Gate 4 says coverage metrics are not
//     optimization targets, and nothing here fills a window or asks for one to
//     be filled;
//   * "we could not tell" is never a verdict, in either direction. An empty
//     Chord2 is not read as a failure (that would be the density rule again)
//     and not read as a pass either: it is unresolved until Gate 4 is answered.
//
// What passes, fails and waits
// ----------------------------
//   PASS     the five functions are satisfied, or a reviewer answered Gate 4
//            for this candidate with evidence
//   FAIL     proven-essential material -- material that sounds while Core3 is
//            silent -- is sitting in Chord3-Chord5. The arrangement's identity
//            depends on enrichment, which is a deficiency in the arrangement
//            and is never reviewable away
//   PENDING  anything else, including a missing function whose material the
//            source may simply not carry
//
// A reviewer resolves the PENDING residue with candidate-bound, evidence-backed
// judgement -- that is what `reviewed` is for, and it is the same shape as the
// Gate 8 and Gate 9 reviews beside it. What a reviewer may not do is review away
// a Core3 whose identity depends on Chord3-Chord5.
//
// A role decision, a Lead evidence record and a Lead promotion PASS are none of
// them a Gate 4 answer, and nothing converts one into another.

import { suggestRoleCandidates } from '../arrangement/role-candidates.mjs';

const CORE3_ROLES = new Set(['Melody', 'Chord1', 'Chord2']);

export const CORE3_COMPLETENESS_BLOCKERS = Object.freeze({
  INCOMPLETE: 'CORE3_INCOMPLETE',
  UNRESOLVED: 'CORE3_COMPLETENESS_UNRESOLVED',
  NOT_EVALUATED: 'CORE3_COMPLETENESS_NOT_EVALUATED',
});

/**
 * Grade the candidate's Core3 as a standalone three-role arrangement.
 *
 * `reviewed` is an explicit, candidate-bound, evidence-backed Gate 4 review. It
 * can only resolve the *unproven* residue; it never clears a proven-absent
 * function or an identity that depends on enrichment. It is deliberately not a
 * parameter a role decision, Lead evidence or a Lead promotion PASS can set:
 * those are different review axes and say nothing about whether Core3 stands up
 * on its own.
 */
export function evaluateCore3Completeness({ candidate, decompositions = null, reviewed = false } = {}) {
  if (!candidate?.events) throw Error('Core3 completeness requires a candidate Canonical project');

  let core3;
  try {
    core3 = suggestRoleCandidates(candidate, decompositions ? { decompositions } : {}).core3;
  } catch (error) {
    // An arrangement the role evaluator cannot read is not a complete one. It
    // fails closed and says why, rather than taking the caller down or passing.
    return Object.freeze({
      status: 'PENDING',
      pass: false,
      blockers: Object.freeze([CORE3_COMPLETENESS_BLOCKERS.NOT_EVALUATED]),
      error: error.message,
      reviewed: false,
      notice: 'Core3 musical completeness could not be evaluated for this candidate, so Gate 4 is unresolved.',
    });
  }

  const absentFunctions = [...(core3.absentFunctions ?? [])];
  const unprovenFunctions = [...(core3.unprovenFunctions ?? [])];

  // Gate 4 is about the arrangement as *delivered*, and the evaluator is a
  // proposal engine: it honours the candidate's declared roles as tier-1
  // evidence, but where the silence-gap test proves an enrichment lane
  // essential it proposes pulling that lane into Chord2. Its own
  // `identityDependsOnEnrichment` therefore asks whether the *proposal* leaves
  // essential material outside Core3, which it never does.
  //
  // So the same proof is read against the candidate instead: a lane the
  // silence-gap test proved essential (`promotedToChord2`) whose events the
  // candidate keeps outside Melody/Chord1/Chord2 means the delivered Core3 goes
  // silent where proven-essential material is still sounding in Chord3-Chord5.
  // That is Gate 4's "Core3 remains intelligible without Chord3-Chord5" failing,
  // established by evidence rather than by counting notes.
  const candidateCore3EventIds = new Set(
    (candidate.events ?? []).filter(event => event?.kind === 'note' && CORE3_ROLES.has(event.role)).map(event => event.id),
  );
  const essentialOutsideCore3 = (core3.sourceCoverage?.core3EventIds ?? [])
    .filter(id => !candidateCore3EventIds.has(id));
  const provenEssentialMisplaced = (core3.functions?.essentialInnerSupport?.promotedToChord2?.length ?? 0) > 0
    && essentialOutsideCore3.length > 0;
  const identityDependsOnEnrichment = core3.identityDependsOnEnrichment === true || provenEssentialMisplaced;

  // Which outcomes are a *deficiency*, and which are merely unresolved.
  //
  // This is the line the whole gate turns on, so it is drawn from evidence and
  // not from note counts. Gate 4 requires "essential Bass/inner support ...
  // where source/context requires it", and an empty Chord2 has two completely
  // different meanings:
  //
  //   the source carries no such material   a legitimately reduced texture
  //   the material exists, outside Core3    cleanup damaged the arrangement
  //
  // Only the second is a deficiency, and the evaluator proves it by the
  // silence-gap test against the SOURCE: material that sounds while Core3 is
  // silent is proven essential, and `identityDependsOnEnrichment` says that
  // proven-essential material is sitting in Chord3-Chord5. That is the one
  // outcome this gate FAILs on, because it is the one it can prove.
  //
  // An absent function on its own is NOT treated as a deficiency. Doing so
  // would be "Chord1 and Chord2 must always contain notes" wearing a different
  // name, and it would fail every source that genuinely has no bass line, every
  // true rest and every source-supported reduced texture. Nor does it pass: a
  // Core3 missing a function is unresolved until someone says, with evidence,
  // that the reduced realization is the complete one for this source. The
  // material a candidate *dropped* is not this gate's question either -- the
  // source-continuity audit already reports removals and role moves out of
  // Core3, with its own approval path.
  //
  // So nothing here auto-passes on "unchanged from baseline": an unchanged,
  // musically incomplete Core3 lands on PENDING and stays blocked until Gate 4
  // is actually answered.
  const deficient = identityDependsOnEnrichment;

  let status;
  let blockers = [];
  if (deficient) {
    // Not reviewable away: this is a statement about the arrangement, not a gap
    // in the evidence.
    status = 'FAIL';
    blockers = [CORE3_COMPLETENESS_BLOCKERS.INCOMPLETE];
  } else if (core3.status === 'COMPLETE') {
    status = 'PASS';
  } else if (reviewed === true) {
    // A reviewer has answered Gate 4 for this candidate with evidence.
    status = 'PASS';
  } else {
    status = 'PENDING';
    blockers = [CORE3_COMPLETENESS_BLOCKERS.UNRESOLVED];
  }

  return Object.freeze({
    status,
    pass: status === 'PASS',
    blockers: Object.freeze(blockers),
    evaluation: core3.status,
    reviewed: reviewed === true,
    reviewable: !deficient && core3.status !== 'COMPLETE',
    missingFunctions: Object.freeze([...(core3.missingFunctions ?? [])]),
    absentFunctions: Object.freeze(absentFunctions),
    unprovenFunctions: Object.freeze(unprovenFunctions),
    identityDependsOnEnrichment,
    identityMayDependOnEnrichment: core3.identityMayDependOnEnrichment === true,
    essentialEventIdsOutsideCore3: Object.freeze([...essentialOutsideCore3]),
    functions: core3.functions ?? null,
    sourceCoverage: core3.sourceCoverage ?? null,
    conflicts: Object.freeze([...(core3.conflicts ?? [])]),
    rationale: Object.freeze([...(core3.rationale ?? [])]),
    notice: 'ACCEPTANCE_CRITERIA.md Gate 4 asks whether Melody + Chord1 + Chord2 stand up as a one-player arrangement. It is answered by musical function, never by track density: true source rests, sparse passages and source-supported reduced textures are complete. Coverage windows are diagnostic. An unchanged candidate is not thereby a complete one, and a clean source-continuity audit answers a different question.',
  });
}
