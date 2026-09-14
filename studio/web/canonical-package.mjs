// A browser consumes a build-time verified Published main snapshot. This is
// integrity/provenance validation, never a second musical rule definition.
import { assertStableCanonicalPackage } from './canonical-contract.mjs';

export async function verifyCanonicalPackage(bundle, expectedDigest, cryptoApi = globalThis.crypto) {
  const fail = () => { throw Error('CANONICAL_NOT_LOADED'); };
  if (!bundle || !cryptoApi?.subtle || !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) fail();
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const digest = [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (digest !== expectedDigest || bundle.status !== 'CANONICAL_LOADED') fail();
  // Structural invariants are shared with the Node artifact verifier so the two
  // cannot drift; only the byte-digest check below is environment-specific.
  assertStableCanonicalPackage(bundle);
  return bundle;
}
