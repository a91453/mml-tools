import { canonical, canonicalDigest } from './published.mjs';
import { verifyCanonicalPackage } from './canonical-package.mjs';

let model, initializationError, initializationRetryable = false;
// Verification stays fail-closed, but it must not run as top-level await: a
// module worker's message queue is enabled while its top-level await is still
// pending, so a handler installed afterwards silently drops every request
// posted in that window. Install the handler first and await this instead.
const initialized = (async () => {
  try { await verifyCanonicalPackage(canonical, canonicalDigest); }
  catch (error) { initializationError = `CANONICAL_NOT_LOADED: ${error.message}`; return; }
  let runtime;
  try { model = await import('./model.mjs'); runtime = await import('../backend/rules/index.mjs'); }
  catch (error) {
    // import() rejects with a TypeError when a module of the graph could not
    // be fetched: a dropped connection, or a request the browser abandoned.
    // This instance cannot recover from that, since it answers every request
    // with this failure for the rest of its life, but a new Worker fetches the
    // graph again and re-verifies the package. So the answer says a
    // replacement may succeed. A module that fetched but failed to parse or
    // link rejects with a SyntaxError and is not retried. One whose own
    // top-level code throws a TypeError is retried, and fails closed once the
    // client's replacement budget is spent.
    initializationError = `CANONICAL_NOT_LOADED: ${error.message}`;
    initializationRetryable = error instanceof TypeError;
    return;
  }
  if (JSON.stringify(runtime.PUBLISHED_CANONICAL) !== JSON.stringify(canonical)) initializationError = 'CANONICAL_NOT_LOADED: Runtime Canonical differs from verified package';
})();
self.onmessage = async ({ data }) => {
  await initialized;
  // No request ran, so the client may send it to a replacement unchanged.
  if (initializationError) return self.postMessage({ id: data.id, error: initializationError, ...(initializationRetryable ? { initializationRetryable: true } : {}) });
  try {
    let result;
    if (data.action === 'identity') result = { metadata: canonical.metadata, documents: canonical.documents };
    // intakeMidi receives an ArrayBuffer by structured clone, so the page keeps
    // its own copy of the bytes: the buffer is never transferred and never
    // detached, and persistence does not race the decode for ownership.
    // Final generation stays on this side of the boundary with the rest of the
    // model: it reconstructs the Canonical project and runs the emitter, so it
    // must not be reachable unless the published Canonical package verified.
    // Listening sessions: read an MML string with the repository parser. It
    // reads a string and returns a song; it never sees a workspace.
    // The listen model is imported on first use, after initialization, but a
    // failed fetch of it (a TypeError, as for model.mjs) breaks this instance
    // the same way: the browser keeps the failed import for the Worker's
    // lifetime, so every later session would get it back. From then on the
    // instance answers as one that could not initialize, without running this
    // request or any later one, so the client replaces it and moves what it
    // held. None of that has run: an answer posted before this one reaches the
    // client first, and a request dispatched after it is refused above.
    else if (data.action === 'parseListening') {
      let listen;
      try { listen = await import('./listen-model.mjs'); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        initializationError = error.message;
        initializationRetryable = true;
        return self.postMessage({ id: data.id, error: initializationError, initializationRetryable });
      }
      result = listen.parseListening(...data.args);
    }
    else if (['newWorkspace', 'intake', 'intakeMxl', 'intakeMidi', 'analyzeWorkspace', 'invalidate', 'importWorkspace', 'recordReview', 'recordLeadEvidence', 'recordLeadPromotionEvidence', 'recordAcceptedDecision', 'previewAcceptedDecision', 'acceptPreviewedDecision', 'clearAcceptedDecisions', 'recordAcceptance', 'recordPlayerReadback', 'clearPlayerReadback', 'generateFinalDelivery', 'applyFinalDelivery', 'previewMobileAdaptation', 'applyWorkspaceMobileAdaptation', 'clearMobileAdaptation', 'previewFinalReduction', 'applyWorkspaceFinalReduction', 'clearFinalReduction'].includes(data.action)) result = model[data.action](...data.args);
    else throw Error('UNSUPPORTED: worker action');
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
