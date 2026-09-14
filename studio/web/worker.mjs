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
    else if (['newWorkspace', 'intake', 'analyzeWorkspace', 'invalidate', 'importWorkspace', 'recordReview', 'recordAcceptance'].includes(data.action)) result = model[data.action](...data.args);
    else throw Error('UNSUPPORTED: worker action');
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
