// The Agent Review Policy's plan derivation, memoized on every input it reads.
//
// Status: IMPLEMENTATION NOTES. This module defines no Canonical rule and
// grades nothing. It holds the answers of an existing read-only plan
// operation, and hands one back only for the inputs it was derived from.
//
// Why it exists
// -------------
// The policy grades whether an acceptance could translate a reduction or
// adaptation proposal by running the same read-only plan derivation the
// acceptance runs (`proposal-service.planRefusal`). That derivation is the one
// step of the policy that runs an engine, and the engine is synchronous: on a
// song-length project a reduction plan, which includes a Final emission, holds
// the event loop for seconds. The policy runs on every read, on every
// submission, on the answer to a rejection or withdrawal and under the lock
// before an acceptance -- and clients poll the read. Derived afresh each time,
// one polling agent stalled every other request this process serves, for
// seconds per poll, and each acceptance held the project lock through one more
// derivation of an answer it had just been given.
//
// What is held, and on what key
// -----------------------------
// The OUTCOME of one derivation: the plan id it produced, or the plan
// operation's refusal (INVALID_REQUEST). Keyed on everything that determines
// it:
//
//   * the call: the owner, the project, the operation and the exact input it
//     receives (the bound candidate id, the action fields the operation reads,
//     the reviewer);
//   * the published rules snapshot the engines were loaded as, and the loaded
//     engines themselves, compared by identity;
//   * a digest of the stored BYTES the operation reads
//     (`arrangement-service.planInputIdentity`) -- bytes rather than ids,
//     because a blob can change under the id that names it.
//
// A held outcome is therefore the derivation's own answer for exactly these
// inputs; it is not a verdict. The policy grades its verdict from it on every
// call, against the proposal as it stands, and re-reads every other rung of
// its ladder as before.
//
// Not the proposal id or revision: the derivation reads neither, and keying on
// them would only re-derive, byte for byte, an answer already held -- on every
// change of a proposal's state, and for every proposal with the same action on
// the same material. Not persisted either: a result written on a record would
// be read back as a result, and a record can be restored, edited or migrated.
//
// What is never held
// ------------------
// * A failure to read the material or to load the engines. It is a fact about
//   this moment, not about the inputs, and the next call derives again.
// * An outcome derived while anything it depends on may have moved. Reads are
//   not serialized, so a write landing between taking the key and the
//   derivation's own reads could pair the key of one state with the answer of
//   another. So an outcome is held only when the store's write count did not
//   move from before the key was taken until after the derivation -- no write
//   of this process landed in between -- AND the rules snapshot, the engines
//   and the stored-bytes digest, read again after the derivation, are still
//   the ones the key was taken from, which also covers a change this process
//   did not write. What neither can see is a change made elsewhere AND undone
//   while one derivation ran: this process's own writes are counted, so only
//   another process's could do that, and the service runs one process and
//   reports `cross_process_run_coordination: false` for exactly this kind of
//   reason (`capabilities.mjs`).
// * A key that could not be taken. The derivation still runs, and fails the
//   way it fails: a memo is never a reason to skip the check.
//
// Bounded, least recently used out first; an evicted entry costs one
// derivation, which is what every call cost before.

import { ERROR_CODES } from './contracts.mjs';
import { sha256Of } from './store.mjs';

export const PLAN_DERIVATION_MEMO_LIMIT = 256;

const encoder = new TextEncoder();
const digestOf = value => sha256Of(encoder.encode(JSON.stringify(value)));

/**
 * @param {object}   deps
 * @param {object}   deps.canonical          `engines()` and `provenance()`.
 * @param {object}   deps.store              `writeCount()`.
 * @param {Function} deps.planInputIdentity  `(owner, projectId, candidateId)`:
 *   the digest of every stored byte the plan operations read for that
 *   candidate. Throws when the material cannot be read.
 * @param {Function} deps.derive             `(owner, projectId, { operation,
 *   input })`: the plan id the operation produces. Throws INVALID_REQUEST for
 *   the operation's refusal, anything else for a failure to read.
 * @param {number}   [deps.limit]
 */
export function createPlanDerivationMemo({ canonical, store, planInputIdentity, derive, limit = PLAN_DERIVATION_MEMO_LIMIT }) {
  const held = new Map();

  // The loaded engines by identity: one number per engines object this memo
  // has seen, never reused. A reload that reports the same release is still
  // another set of engines.
  const engineIds = new WeakMap();
  let lastEngineId = 0;
  const engineIdOf = engines => {
    if (!engineIds.has(engines)) engineIds.set(engines, ++lastEngineId);
    return engineIds.get(engines);
  };

  // What can move under one call between two reads of it, read now.
  const materialOf = async (owner, projectId, request) => {
    const engines = await canonical.engines();
    const provenance = await canonical.provenance();
    return digestOf({
      engines: engineIdOf(engines),
      rules_snapshot_sha: provenance?.rules_snapshot_sha ?? null,
      stored: planInputIdentity(owner, projectId, request.input.candidateId),
    });
  };

  return Object.freeze({
    /**
     * `{ plan_id, refusal }` for this call against what is stored now, or a
     * thrown error when the material or the engines could not be read.
     */
    async outcome(owner, projectId, request) {
      const writesBefore = store.writeCount();
      const call = digestOf({ owner, project_id: projectId, operation: request.operation, input: request.input });
      const before = await materialOf(owner, projectId, request).catch(() => null);
      const key = before === null ? null : digestOf({ call, material: before });
      if (key !== null && held.has(key)) {
        const outcome = held.get(key);
        held.delete(key);
        held.set(key, outcome);
        return outcome;
      }

      let outcome;
      try {
        outcome = Object.freeze({ plan_id: await derive(owner, projectId, request), refusal: null });
      } catch (error) {
        if (error?.code !== ERROR_CODES.INVALID_REQUEST) throw error;
        outcome = Object.freeze({ plan_id: null, refusal: Object.freeze({ code: error.code, message: String(error.message ?? '').slice(0, 500) }) });
      }

      if (key !== null) {
        const after = await materialOf(owner, projectId, request).catch(() => null);
        if (after === before && store.writeCount() === writesBefore) {
          held.delete(key);
          held.set(key, outcome);
          while (held.size > limit) held.delete(held.keys().next().value);
        }
      }
      return outcome;
    },

    /** How many outcomes are held. Never more than the limit. */
    size: () => held.size,
  });
}
