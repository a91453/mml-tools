// Source-request identity for asynchronous intake.
//
// Decoding a source file happens off the main thread, so two selections into
// the same slot can be in flight at once and can settle out of order. The rule
// this enforces is narrow and absolute: only the newest request for a slot may
// become the active source, and only in the project it was made against.
//
// Filenames are explicitly not identity here. Two files can share a name and
// carry different bytes, and the same file can be re-selected after a failure,
// so a name-based comparison would both accept a stale result and reject a
// legitimate retry. A token is a monotonic sequence number instead, and the
// byte-level identity of what was actually decoded is the source digest the
// backend computes.
//
// Revision is recorded for diagnostics but is deliberately not part of the
// acceptance test. An intake carries its own captured bytes and invalidates the
// workspace itself, so it stays valid across revisions of the same project --
// the same rule the existing symbolic intake already follows.

export const STALE_SOURCE_REQUEST = 'STALE_SOURCE_REQUEST';
export const SOURCE_REQUEST_PROJECT_CHANGED = 'SOURCE_REQUEST_PROJECT_CHANGED';

export function createSourceRequestLedger() {
  const newest = new Map();
  let sequence = 0;

  return Object.freeze({
    // Supersedes any earlier request for the same slot the moment it is made,
    // so the older one is already stale before its result arrives.
    begin(slot, { projectId = null, revision = null } = {}) {
      const token = Object.freeze({ slot, sequence: ++sequence, projectId, revision });
      newest.set(slot, token);
      return token;
    },

    isCurrent(token) {
      return Boolean(token) && newest.get(token.slot) === token;
    },

    // The single decision point. A result may be applied only when it is the
    // newest request for its slot and the project it was requested against is
    // still the one on screen.
    evaluate(token, { projectId = null } = {}) {
      if (!this.isCurrent(token)) return { accepted: false, reason: STALE_SOURCE_REQUEST };
      if (token.projectId !== projectId) return { accepted: false, reason: SOURCE_REQUEST_PROJECT_CHANGED };
      return { accepted: true, reason: null };
    },

    // Called once a result has been applied or discarded. A slot with no
    // in-flight request holds no token, so a later stray result stays stale.
    settle(token) {
      if (this.isCurrent(token)) newest.delete(token.slot);
    },

    get inFlight() {
      return [...newest.values()].map(token => ({ slot: token.slot, sequence: token.sequence, projectId: token.projectId, revision: token.revision }));
    },
  });
}
