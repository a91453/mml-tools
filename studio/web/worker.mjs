import { canonical, canonicalDigest } from './published.mjs';
import { verifyCanonicalPackage } from './canonical-package.mjs';

let model, initializationError;
// Verification stays fail-closed, but it must not run as top-level await: a
// module worker's message queue is enabled while its top-level await is still
// pending, so a handler installed afterwards silently drops every request
// posted in that window. Install the handler first and await this instead.
const initialized = (async () => {
  try {
    await verifyCanonicalPackage(canonical, canonicalDigest);
    model = await import('./model.mjs');
    const { PUBLISHED_CANONICAL } = await import('../backend/rules/index.mjs');
    if (JSON.stringify(PUBLISHED_CANONICAL) !== JSON.stringify(canonical)) throw Error('Runtime Canonical differs from verified package');
  } catch (error) { initializationError = `CANONICAL_NOT_LOADED: ${error.message}`; }
})();
self.onmessage = async ({ data }) => {
  try {
    await initialized;
    if (initializationError) throw Error(initializationError);
    let result;
    if (data.action === 'identity') result = { metadata: canonical.metadata, documents: canonical.documents };
    // intakeMidi receives an ArrayBuffer by structured clone, so the page keeps
    // its own copy of the bytes: the buffer is never transferred and never
    // detached, and persistence does not race the decode for ownership.
    // Final generation stays on this side of the boundary with the rest of the
    // model: it reconstructs the Canonical project and runs the emitter, so it
    // must not be reachable unless the published Canonical package verified.
    else if (['newWorkspace', 'intake', 'intakeMidi', 'analyzeWorkspace', 'invalidate', 'importWorkspace', 'recordReview', 'recordLeadEvidence', 'recordLeadPromotionEvidence', 'recordAcceptedDecision', 'clearAcceptedDecisions', 'recordAcceptance', 'recordPlayerReadback', 'clearPlayerReadback', 'generateFinalDelivery', 'applyFinalDelivery', 'previewMobileAdaptation', 'applyWorkspaceMobileAdaptation', 'clearMobileAdaptation', 'previewFinalReduction', 'applyWorkspaceFinalReduction', 'clearFinalReduction'].includes(data.action)) result = model[data.action](...data.args);
    else throw Error('UNSUPPORTED: worker action');
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
