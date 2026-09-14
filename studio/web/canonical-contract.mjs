// Structural invariants of the stable Published Canonical runtime package.
//
// The browser package verifier and the Node artifact verifier both apply this
// contract, so a deployment can never approve an artifact the browser would
// refuse to boot. Keep it free of Node-only and Web-only APIs: it is imported
// from both, and it is copied into the browser bundle.
//
// This validates published identity and package structure only. It defines no
// musical rule and cannot override the Canonical documents it describes.
export const REQUIRED_DOCUMENTS = 6;

export class CanonicalContractError extends Error {
  constructor(reason) {
    super(`CANONICAL_NOT_LOADED: ${reason}`);
    this.name = 'CanonicalContractError';
    this.code = 'CANONICAL_NOT_LOADED';
  }
}

const need = (condition, reason) => { if (!condition) throw new CanonicalContractError(reason); };

export function assertStableCanonicalPackage(bundle) {
  need(bundle && typeof bundle === 'object' && !Array.isArray(bundle), 'Runtime bundle is not an object');
  need(bundle.status === 'CANONICAL_LOADED', 'Runtime bundle is not a loaded Canonical package');

  // Dynamic Git provenance must never reach the hashed runtime bundle: it made
  // buildId move with main and cost the release its reproducibility.
  need(bundle.provenance === undefined, 'Runtime bundle carries dynamic Git provenance');

  const metadata = bundle.metadata;
  need(metadata && typeof metadata === 'object', 'Runtime bundle has no Canonical metadata');
  need(metadata.canonical_status === 'PUBLISHED', 'Canonical metadata does not designate a published release');
  need(/^\d{4}-\d{2}-\d{2}-v\d+$/.test(metadata.canonical_version ?? ''), 'Canonical metadata has no valid canonical_version');
  need(String(metadata.manifest_version ?? '').startsWith(`${metadata.canonical_version}-manifest`), 'manifest_version does not identify this Canonical release');
  need(/^[a-f0-9]{40}$/.test(metadata.rules_snapshot_sha ?? ''), 'Canonical metadata has no valid rules_snapshot_sha');

  need(Array.isArray(bundle.documents) && bundle.documents.length === REQUIRED_DOCUMENTS, `Runtime bundle must carry exactly ${REQUIRED_DOCUMENTS} published documents`);
  for (const document of bundle.documents) {
    need(document?.content?.includes(`Version: ${metadata.canonical_version}`), `Document version mismatch: ${document?.path}`);
    need(document?.url?.includes(`/${metadata.rules_snapshot_sha}/`), `Document is not pinned to the rules snapshot: ${document?.path}`);
  }

  need(Array.isArray(bundle.authority?.map) && bundle.authority.map.length >= bundle.documents.length, 'Runtime bundle has no usable authority map');
  need(bundle.authority.localSkillDefinesRules === false && bundle.authority.executableContractDefinesRules === false, 'Authority map must not let a local Skill or executable contract define rules');
  return bundle;
}
