// Published Canonical provenance and the Canonical-aware engine gate.
//
// Status: IMPLEMENTATION NOTES. This module loads nothing of its own: it calls
// the existing bootstrap through `backend/rules/index.mjs` and reports what
// that load returned. It cannot republish a release, move a snapshot, or
// approve a rule.
//
// Why the engines are loaded lazily and dynamically
// -------------------------------------------------
// `backend/rules/index.mjs` performs the Published Canonical load at module
// evaluation, and every Canonical-aware engine (source, score, arrangement,
// arbitration, compare, final) imports it transitively. A static import here
// would therefore make *constructing* the Application Service throw in any
// environment without the published Git history — a deployed container, a
// tarball, a sandbox — and would take the whole transport down with it,
// including the capability endpoint an agent needs in order to discover that
// Canonical is unavailable.
//
// So the gate is explicit instead: capability discovery, project records and
// asset storage work without Canonical, and every operation that would apply a
// Canonical-aware rule goes through `engines()`, which either returns the real
// backend modules or fails closed with `CANONICAL_NOT_LOADED`.
//
// There is deliberately no fallback. Not a legacy Skill, not an old Master, not
// a cached rule set, not a working-tree replacement, not a bundled copy of the
// documents. A failed load yields an error, and the caller is told which
// identity was unavailable.
//
// One property is inherited from the ES module system and is stated rather than
// hidden: once `rules/index.mjs` has thrown during evaluation, that module
// record stays errored for the life of the realm, so a later call re-raises the
// same failure without re-running Git. A process that started without the
// published history does not silently acquire it.

import {
  ERROR_CODES,
  StudioApplicationError,
} from './contracts.mjs';

const freeze = Object.freeze;

// The Canonical-aware engines this layer orchestrates. Every entry is an
// existing backend module; this list is a wiring manifest, not an abstraction
// over them, and the Application Service calls their exported functions
// directly rather than re-implementing anything they do.
const ENGINE_MODULES = freeze({
  rules: '../rules/index.mjs',
  canonical: '../canonical/index.mjs',
  merge: '../canonical/merge.mjs',
  source: '../source/index.mjs',
  score: '../score/index.mjs',
  mml: '../mml/parser.mjs',
  canonicalize: '../mml/canonicalize.mjs',
  arrangement: '../arrangement/index.mjs',
  core3: '../arbitration/core3.mjs',
  harmony: '../arbitration/harmony.mjs',
  leadDemotion: '../arbitration/lead-demotion.mjs',
  compare: '../compare/version-drift.mjs',
  audio: '../audio/index.mjs',
  final: '../final/index.mjs',
  emitterContract: '../final/emitter-contract.mjs',
});

// `rules` is imported on its own, first, and its failure is the only failure
// that means CANONICAL_NOT_LOADED. Everything after it is ordinary module
// loading: a missing runtime dependency or a partial deployment is an
// environment problem, and reporting it as a Canonical failure would both blame
// the published rules for it and make the Canonical signal untrustworthy — a
// test for `CANONICAL_NOT_LOADED` would start passing for the wrong reason.
//
// `recordPublished` is called the moment the rules module resolves and before
// any other engine is imported. That ordering is the whole point: if a later
// import fails, the published identity has already been retained, so the
// provenance answer can say CANONICAL_LOADED with the real snapshot beside the
// engine failure. Without it the two answers contradict each other — the
// operation refuses with ENGINE_UNAVAILABLE while provenance claims the rules
// never loaded, which is the opposite of what happened.
async function importEngines({ recordPublished } = {}) {
  const rules = await import(ENGINE_MODULES.rules);
  recordPublished?.(rules?.PUBLISHED_CANONICAL);
  const names = Object.keys(ENGINE_MODULES).filter(name => name !== 'rules');
  let loaded;
  try {
    loaded = await Promise.all(names.map(name => import(ENGINE_MODULES[name])));
  } catch (error) {
    throw new EngineUnavailableError(error?.message ?? 'a Canonical-aware engine module could not be imported', error);
  }
  return freeze({ rules, ...Object.fromEntries(names.map((name, index) => [name, loaded[index]])) });
}

export class EngineUnavailableError extends Error {
  constructor(reason, cause) {
    super(`ENGINE_UNAVAILABLE: ${reason}`, { cause });
    this.name = 'EngineUnavailableError';
    this.code = ERROR_CODES.ENGINE_UNAVAILABLE;
  }
}

/**
 * The Canonical provenance envelope carried by every significant response.
 *
 * The five identities stay five fields. `rules_snapshot_sha` selects the
 * reviewed rules; `manifest_commit` is the commit that introduced the loaded
 * Manifest revision; `published_main_head`, `repository_head` and `pr_head` are
 * Git provenance for the process that answered. None of them is a Canonical
 * version, none substitutes for another, and none may be folded into a single
 * "version" field.
 */
export function provenanceOf(published) {
  const metadata = published?.metadata ?? {};
  const git = published?.provenance ?? {};
  return freeze({
    status: 'CANONICAL_LOADED',
    canonical_version: metadata.canonical_version ?? null,
    canonical_status: metadata.canonical_status ?? null,
    manifest_version: metadata.manifest_version ?? null,
    rules_snapshot_sha: metadata.rules_snapshot_sha ?? null,
    manifest_commit: git.manifest_commit ?? null,
    published_main_head: git.published_main_head ?? null,
    repository_head: git.repository_head ?? null,
    pr_head: git.pr_head ?? null,
    entry_point: published?.authority?.entryPoint ?? null,
    authority_notice: 'Executable contracts, schemas, this interface, its transports and its tests are implementers and verifiers. They cannot define or amend Canonical rules in reverse.',
  });
}

export function unloadedProvenance(reason) {
  return freeze({
    status: ERROR_CODES.CANONICAL_NOT_LOADED,
    canonical_version: null,
    canonical_status: null,
    manifest_version: null,
    rules_snapshot_sha: null,
    manifest_commit: null,
    published_main_head: null,
    repository_head: null,
    pr_head: null,
    entry_point: 'docs/CANONICAL_MANIFEST.md',
    reason: reason ?? 'Published Canonical was not loaded',
    legacy_fallback_allowed: false,
    authority_notice: 'No legacy Skill, old Master, memory, Draft2, cached rule set or working-tree replacement may stand in for the published rules snapshot. Canonical specification judgment is stopped.',
  });
}

/**
 * Build the Canonical gate.
 *
 * `load` exists so a regression can simulate an unavailable Published Canonical
 * without breaking the repository it runs in. Production passes nothing.
 *
 * `load` is called with `{ recordPublished }`. A loader that imports the rules
 * separately from the rest calls it as soon as the rules resolve, so a later
 * engine failure still has the real published identity to report.
 */
export function createCanonicalGate({ load = importEngines } = {}) {
  let attempt = null;
  // Retained so an engine-level failure can still report the real Canonical
  // identity. It is only ever written from a real rules load — either through
  // `recordPublished` the moment the rules module resolves, or from a fully
  // completed load below. Nothing else may write it: a fabricated identity here
  // would be indistinguishable from a real one to every caller downstream.
  let lastPublished = null;
  const recordPublished = published => {
    if (published?.status === 'CANONICAL_LOADED') lastPublished = published;
  };

  const attemptLoad = () => {
    if (!attempt) {
      attempt = Promise.resolve()
        .then(() => load({ recordPublished }))
        .then(engines => {
          const published = engines?.rules?.PUBLISHED_CANONICAL;
          recordPublished(published);
          if (!published || published.status !== 'CANONICAL_LOADED') {
            throw Error('rules module did not expose a loaded Published Canonical');
          }
          return freeze({ engines, published, provenance: provenanceOf(published) });
        });
      // A rejected attempt is kept, not retried: the ES module record that
      // failed is already permanently errored, so re-running the import would
      // only re-raise it while implying a retry happened.
      attempt.catch(() => {});
    }
    return attempt;
  };

  return freeze({
    /**
     * The Canonical-aware backend modules, or a fail-closed refusal.
     */
    async engines() {
      try {
        return (await attemptLoad()).engines;
      } catch (error) {
        if (error instanceof EngineUnavailableError) {
          throw new StudioApplicationError(ERROR_CODES.ENGINE_UNAVAILABLE, error.message, { reason: error.cause?.message ?? null });
        }
        throw new StudioApplicationError(
          ERROR_CODES.CANONICAL_NOT_LOADED,
          `CANONICAL_NOT_LOADED: ${error?.message ?? 'Published Canonical is unavailable'}`,
          unloadedProvenance(error?.message ?? null),
        );
      }
    },

    /**
     * The provenance envelope, without throwing.
     *
     * Capability discovery and error responses both need to say what the
     * Canonical status is, and neither can afford to fail while saying it.
     */
    async provenance() {
      try {
        return (await attemptLoad()).provenance;
      } catch (error) {
        // The rules did load if the failure came from a later engine import, so
        // the provenance is real and is reported as such, with the engine
        // problem named beside it rather than disguised as a Canonical one.
        // Reporting CANONICAL_NOT_LOADED here would contradict the operation,
        // which refuses with ENGINE_UNAVAILABLE, and would blame the published
        // rules for an environment fault they had nothing to do with.
        //
        // The signal is the stable code, not the underlying import message:
        // this envelope is served on the public root endpoint, and the raw
        // failure — which names modules and container paths — belongs to the
        // authenticated caller, who gets it in the thrown error's `reason`.
        if (error instanceof EngineUnavailableError && lastPublished) {
          return freeze({
            ...provenanceOf(lastPublished),
            engine_status: ERROR_CODES.ENGINE_UNAVAILABLE,
            engine_notice: 'Published Canonical loaded, but a Canonical-aware engine module could not be imported in this environment. Canonical-aware operations refuse with ENGINE_UNAVAILABLE; the published rules release is unaffected.',
          });
        }
        return unloadedProvenance(error?.message ?? null);
      }
    },

    async loaded() {
      try {
        await attemptLoad();
        return true;
      } catch {
        return false;
      }
    },
  });
}

export { ENGINE_MODULES };
