// The Published Canonical runtime package an offline host ships.
//
// Studio Web (scripts/build-studio-web.mjs) and the native App core
// (scripts/build-native-core.mjs) both replace the Git-backed loader in
// studio/backend/bootstrap/index.mjs with a static copy of what that loader
// returned at build time. This module is the one definition of that copy, so
// the two hosts cannot ship two different packages for the same release: for
// one Published Canonical load they carry the same bytes and the same digest.
//
// It packages what the loader returned and nothing else. It reads no rule,
// defines no rule and cannot relabel a release. Dynamic Git provenance
// (repository_head / published_main_head / pr_head and the Manifest commit) is
// audit metadata, not runtime content: embedding it in hashed assets would make
// a host's identity move whenever main advanced, even with identical sources and
// an unchanged Canonical release. It is returned separately for the caller's
// audit record.
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function canonicalRuntimePackage(canonical) {
  const { provenance, ...runtimeCanonical } = canonical;
  const data = JSON.stringify(runtimeCanonical);
  const digest = sha256(data);
  return Object.freeze({
    provenance,
    metadata: runtimeCanonical.metadata,
    data,
    digest,
    // Replaces studio/backend/bootstrap/index.mjs. It keeps the loader's
    // signature and its one refusal: a host built for another release fails
    // closed with CANONICAL_NOT_LOADED instead of relabelling itself.
    bootstrapModule: `const loaded = ${data};\nfunction freeze(x){for(const v of Object.values(x))if(v&&typeof v==='object')freeze(v);return Object.freeze(x)}\nfreeze(loaded);\nexport function loadPublishedCanonical({supportedCanonicalVersion=null}={}){if(supportedCanonicalVersion&&![].concat(supportedCanonicalVersion).includes(loaded.metadata.canonical_version))throw Error('CANONICAL_NOT_LOADED');return loaded}\n`,
    // The package and its digest as one module, verified before first use by
    // studio/web/canonical-package.mjs.
    publishedModule: `export const canonical = ${data};\nexport const canonicalDigest = '${digest}';\n`,
  });
}
