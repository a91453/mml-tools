import { canonical, canonicalDigest } from './published.mjs';
import { verifyCanonicalPackage } from './canonical-package.mjs';

let model, initializationError;
try {
  await verifyCanonicalPackage(canonical, canonicalDigest);
  model = await import('./model.mjs');
  const { PUBLISHED_CANONICAL } = await import('../backend/rules/index.mjs');
  if (JSON.stringify(PUBLISHED_CANONICAL) !== JSON.stringify(canonical)) throw Error('Runtime Canonical differs from verified package');
} catch (error) { initializationError = `CANONICAL_NOT_LOADED: ${error.message}`; }
self.onmessage = async ({ data }) => {
  try {
    if (initializationError) throw Error(initializationError);
    let result;
    if (data.action === 'identity') result = { metadata: canonical.metadata, provenance: canonical.provenance, documents: canonical.documents };
    else if (['newWorkspace', 'intake', 'analyzeWorkspace', 'invalidate', 'importWorkspace', 'recordReview', 'recordAcceptance'].includes(data.action)) result = model[data.action](...data.args);
    else throw Error('UNSUPPORTED: worker action');
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
