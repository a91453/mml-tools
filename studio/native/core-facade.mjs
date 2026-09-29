// The native host facade over the shared Studio engines.
//
// Status: IMPLEMENTATION NOTES. This is a transport adapter, like server/mcp.mjs
// and server/api.mjs: it holds no MML logic of its own. A native App (the iOS
// App's JavaScriptCore bridge, apps/ios/) reaches the same operations the MCP
// tools reach, through the same modules:
//
//   technical check   application/technical-service.mjs  (what mml_validate and
//                     mml_overlap_details call), answered by mml/parser.mjs
//   Canonical gate    application/provenance.mjs createCanonicalGate, with a
//                     loader that verifies the bundled runtime package first
//   package check     studio/web/canonical-package.mjs, the verifier Studio Web
//                     runs before first use
//
// So an App verdict and an MCP verdict for the same request come from one
// implementation, and a report has one shape wherever it is produced. Nothing
// here can define, relax or relabel a Canonical rule. When the bundled
// package fails verification, every Canonical operation refuses with
// CANONICAL_NOT_LOADED; there is no legacy fallback, exactly as on the server.
//
// The boundary is JSON text in, JSON text out, so a host needs no object
// bridging: `submit(operation, json)` starts an operation and returns a ticket,
// and `collect(ticket)` returns the settled envelope
//   { ok: true, result } | { ok: false, error: { code, message, details } }.
// The two calls exist because the Application Service is asynchronous while a
// JavaScriptCore host call is not. JavaScriptCore drains the microtask queue
// when the outermost API call returns, so an operation over the bundled engines
// has settled by the time the host makes its next call. A ticket that has not
// settled is reported as NOT_SETTLED rather than waited on.
//
// The facade performs no I/O. It has no network, file, clock or randomness
// dependency, so the same request gives the same envelope on every host.
import { verifyCanonicalPackage } from '../web/canonical-package.mjs';
import { ERROR_CODES, StudioApplicationError, fail } from '../backend/application/contracts.mjs';
import { createCanonicalGate } from '../backend/application/provenance.mjs';
import { createTechnicalService } from '../backend/application/technical-service.mjs';
import { sha256Hex } from '../backend/source/sha256.mjs';

export const NATIVE_CORE_API_VERSION = 1;
export const NATIVE_CORE_FORMAT = 'mml-tools/native-core@1';
// The `service_version` a native technical report carries. It names the host
// that answered, as the MCP service's own version does on the server; it is not
// a Canonical version or rule profile.
export const NATIVE_SERVICE_VERSION = 'native-core-1';

// verifyCanonicalPackage takes a Web Crypto-shaped digest API. A JavaScriptCore
// host has no Web Crypto, so the repository's own synchronous SHA-256 (verified
// byte for byte against node:crypto in its tests) answers the same call.
const hostDigest = Object.freeze({
  subtle: Object.freeze({
    async digest(algorithm, bytes) {
      if (algorithm !== 'SHA-256') throw Error(`Unsupported digest algorithm: ${algorithm}`);
      const hex = sha256Hex(new Uint8Array(bytes));
      return Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16)).buffer;
    },
  }),
});

// The default loader: the bundled rules module, verified against the digest
// the build recorded, then the Canonical MML validator. The imports are
// dynamic so that a package that fails verification is refused through the
// gate, with its code, instead of stopping the whole host from evaluating.
async function loadBundledEngines({ expectedCanonicalDigest, recordPublished }) {
  const rules = await import('../backend/rules/index.mjs');
  await verifyCanonicalPackage(rules.PUBLISHED_CANONICAL, expectedCanonicalDigest, hostDigest);
  recordPublished?.(rules.PUBLISHED_CANONICAL);
  const mml = await import('../backend/mml/parser.mjs');
  return Object.freeze({ rules, mml });
}

function errorEnvelope(error) {
  if (error?.name === 'StudioApplicationError') {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details ?? {} } };
  }
  // A host fault, not a verdict. The message stays on the device: the facade
  // sends nothing anywhere, and a developer needs it to see what broke.
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: String(error?.message ?? error), details: { name: String(error?.name ?? typeof error) } } };
}

export function createNativeCore({ expectedCanonicalDigest, load = null, hostShims = [] } = {}) {
  const gate = createCanonicalGate({
    load: load ?? (({ recordPublished }) => loadBundledEngines({ expectedCanonicalDigest, recordPublished })),
  });
  const technical = createTechnicalService({ serviceVersion: NATIVE_SERVICE_VERSION, canonical: gate });

  const publishedDocuments = async () => {
    if (!(await gate.loaded())) return [];
    return (await gate.engines()).rules.PUBLISHED_CANONICAL.documents;
  };

  const operations = Object.freeze({
    // What this host runs: the Canonical release (or the refusal code), the
    // validation profile, the runtime package digest and the published
    // documents it carries. Answers even when Canonical did not load, because
    // a host must be able to say so.
    async identity() {
      const canonical = await gate.provenance();
      const service = await technical.describe();
      const documents = (await publishedDocuments()).map(({ path, authority, blob_sha, url }) => ({ path, authority, blob_sha, url }));
      return {
        api_version: NATIVE_CORE_API_VERSION,
        native_core: { format: NATIVE_CORE_FORMAT, service_version: NATIVE_SERVICE_VERSION },
        runtime_package_digest: expectedCanonicalDigest ?? null,
        canonical,
        service,
        documents,
        host_shims: [...hostShims],
      };
    },

    // The MCP mml_validate operation, over the same technical service.
    validate: input => technical.validate(input),

    // The MCP mml_overlap_details operation, over the same technical service.
    overlapDetails: input => technical.overlapDetails(input),

    // One published document's text, so a host can show the rules it runs
    // under without a network. Only a document the loaded package carries.
    async canonicalDocument(input) {
      if (!input || typeof input.path !== 'string') fail(ERROR_CODES.INVALID_REQUEST, 'canonicalDocument takes { path }');
      await gate.engines();
      const document = (await publishedDocuments()).find(entry => entry.path === input.path);
      if (!document) fail(ERROR_CODES.INVALID_REQUEST, `${input.path} is not a document of the loaded Published Canonical package`);
      const { path, authority, blob_sha, url, content } = document;
      return { path, authority, blob_sha, url, content };
    },
  });

  const tickets = new Map();
  let nextTicket = 1;

  function submit(operation, json) {
    const ticket = nextTicket++;
    const slot = { settled: false, envelope: null };
    tickets.set(ticket, slot);
    // Serialized before the slot is marked settled, so `collect` always
    // returns an envelope: a result that cannot be serialized is a host fault.
    const settle = envelope => {
      let text;
      try {
        text = JSON.stringify(envelope);
      } catch (error) {
        text = JSON.stringify(errorEnvelope(error));
      }
      slot.envelope = text;
      slot.settled = true;
    };
    Promise.resolve()
      .then(() => {
        if (!Object.hasOwn(operations, operation)) {
          throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, `Unknown native core operation: ${operation}`, { operations: Object.keys(operations) });
        }
        let input;
        if (json !== undefined && json !== null && json !== '') {
          try {
            input = JSON.parse(json);
          } catch {
            throw new StudioApplicationError(ERROR_CODES.INVALID_REQUEST, 'The request is not valid JSON.');
          }
        }
        return operations[operation](input);
      })
      .then(result => settle({ ok: true, result }), error => settle(errorEnvelope(error)));
    return ticket;
  }

  function collect(ticket) {
    const slot = tickets.get(ticket);
    if (!slot) return JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TICKET', message: `No operation has ticket ${ticket}.`, details: {} } });
    if (!slot.settled) return JSON.stringify({ ok: false, error: { code: 'NOT_SETTLED', message: `Operation ${ticket} has not settled; the host did not drain the microtask queue.`, details: {} } });
    tickets.delete(ticket);
    return slot.envelope;
  }

  return Object.freeze({
    apiVersion: NATIVE_CORE_API_VERSION,
    format: NATIVE_CORE_FORMAT,
    operations: Object.freeze(Object.keys(operations)),
    submit,
    collect,
  });
}
