// A browser consumes a build-time verified Published main snapshot. This is
// integrity/provenance validation, never a second musical rule definition.
export async function verifyCanonicalPackage(bundle, expectedDigest, cryptoApi = globalThis.crypto) {
  const fail = () => { throw Error('CANONICAL_NOT_LOADED'); };
  if (!bundle || !cryptoApi?.subtle || !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) fail();
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const digest = [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (digest !== expectedDigest || bundle.status !== 'CANONICAL_LOADED') fail();
  if (bundle.metadata?.canonical_status !== 'PUBLISHED' || bundle.documents?.length !== 6) fail();
  const ids = [bundle.metadata.rules_snapshot_sha, bundle.provenance?.manifest_commit, bundle.provenance?.published_main_head, bundle.provenance?.repository_head];
  if (ids.some(id => !/^[a-f0-9]{40}$/.test(id ?? ''))) fail();
  for (const doc of bundle.documents) {
    if (!doc.content?.includes(`Version: ${bundle.metadata.canonical_version}`) || !doc.url?.includes(`/${bundle.metadata.rules_snapshot_sha}/`)) fail();
  }
  return bundle;
}
