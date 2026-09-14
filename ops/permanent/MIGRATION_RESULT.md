# PERMANENT_STUDIO_DURABLE

Verified on 2026-09-14. Production is serving the reviewed, reproducible Studio v1
release from an independent durable source. The historical production cache and
volume are preserved for rollback. No Canonical or Studio feature changes were made.

## Release and trust identity

| Field | Verified value |
| --- | --- |
| Repository | `a91453/mml-tools` |
| Release/tag | [studio-v1-durable-5769e76849e5](https://github.com/a91453/mml-tools/releases/tag/studio-v1-durable-5769e76849e5) |
| Artifact filename | `mml-studio-34c67a4a1284eee1243ee51858096660c16cbf22cf0347e139abb15f2dc3e258.zip` |
| ZIP SHA256 | `ff464a35b00bb490cef3873e191b6dd870cdc6b5a10699badcb3788607f24088` |
| ZIP bytes | 391839 |
| Merged main/source SHA | `5769e76849e5ef8dad03b4080050cafcf1c2eabe` |
| Reviewed PR SHA | `bdc16f443724e3c9e24c883a31513d7ac5871359` |
| buildId | `34c67a4a1284eee1243ee51858096660c16cbf22cf0347e139abb15f2dc3e258` |
| cacheId | `1e78713ad6bb57aff5dd5c4ef2cf841aa01f9c550471fe9aa4f216ed51596a92` |
| Trusted verifier/template source SHA | `5769e76849e5ef8dad03b4080050cafcf1c2eabe` |
| Trusted bundle SHA256 | `2bfa4aa942bff469ffec254cd4e5b187c241484067ecbb5fdc31e004a350a499` |
| Rendered bootstrap SHA256 | `5017a2e2035bc67799dfe662a23ca1a109c3192dc742c8515f90032b8cc750cb` |
| canonical_version | `2026-09-13-v1` |
| canonical_status | `PUBLISHED` |
| manifest_version | `2026-09-13-v1-manifest1` |
| rules_snapshot_sha | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |

The GitHub Release is published and durable, but GitHub reports native
`immutable: false`. Exact ZIP content is independently anchored by immutable Git
blob `3803dcc07e9a6f2da122935dd0cbab21d818852d`, retained in commit
`574c8973a9f8b1ef5c9f7bb32ef589dcb57ec43b`, and the SHA256 pins above. The trust ZIP
has independent Git blob `62753f1cacd19d1d638bd1737d1feb261719d0d3`. Replacement bytes
at a mutable URL or bucket key cannot pass bootstrap. The runtime downloads from
the private `studio-release-artifacts` bucket using Railway references; both ZIPs
were read back and verified against the Release and Git copies. Neither Actions
artifacts nor an isolated/temporary service is a runtime source.

## Isolated proof

The isolated service `studio-durable-isolated` used its own 1 GiB volume
`a75fd368-2dcc-4e4f-8637-f242d3c2738d`. The final bootstrap's cold proof used the
previously unused `/studio-cache/final-proof` namespace. No preview was available
or configured. Production remained unchanged until all proofs passed.

| Proof | Deployment | Result |
| --- | --- | --- |
| Final empty-cache cold bootstrap | `25caeae1-17dd-44fd-b1c4-9ed33b466859` | SUCCESS: trusted source, durable download, ZIP and artifact verification, atomic commit, then `.ready` and server |
| Initial offline cached restart | `ed6f76e1-850d-4131-a0ce-699e3d7b88ff` | SUCCESS with `refetch:false` |
| Deliberately corrupt cached `studio/web/app.mjs` with `.ready` retained | `228033e5-9b58-45ea-bebd-7b8f4dfb91b4` | Expected FAILED deployment: asset hash mismatch, no server start, no download; health request did not succeed |
| Explicit whole-artifact durable recovery | `cec4e4a2-71ac-4a48-bd38-1192c8596434` | SUCCESS: rejected cache quarantined; full ZIP downloaded and reverified; 34/34 HTTP asset hashes match |
| Final cached restart with downloading disabled | `055831dd-85ec-48ab-a4ef-994746267a43` | SUCCESS: full verification, `refetch:false`, health 200 and expected identity |

`/health`, `/`, `/build.json`, all 34 runtime assets, and `sw.js` returned 200 in
the stable HTTP audit. The actual browser initialized the PWA module/worker graph
and all six pinned Canonical documents. Evidence is in
[isolated-phases.json](evidence/isolated-phases.json),
[isolated-recovery-http.json](evidence/isolated-recovery-http.json),
[final-cached-health.json](evidence/final-cached-health.json), and
[final-cached-logs.json](evidence/final-cached-logs.json).

## Production verification

| Field | Result |
| --- | --- |
| Railway project | `mml-tools-studio-permanent` / `8382ec4b-8da6-4f27-947b-b325ea5aadfa` |
| Service | `studio-web-permanent` / `311e2f06-bad4-415c-b020-d52e1a6bf064` |
| Production deployment | `9ddaad2c-fc64-4822-a011-3924e3aae629` / SUCCESS |
| Permanent URL | https://studio-web-permanent-production.up.railway.app |
| Health, root, build.json | 200 / 200 / 200 |
| Runtime and PWA assets | 34/34 status 200 and exact SHA256 matches, including final `sw.js` |
| Bootstrap mode | `durable-source` |
| Existing production volume | `fba8d8a3-0c88-4f9b-b2a4-54a772217388`, unchanged at `/studio-cache` |
| Historical rollback deployment | `f9a9bd99-4809-4a3b-8612-07b96c196d4a` |
| Historical deployment snapshot | `229e86e2-2b2d-4003-9903-fed319edbb0f`, retained in deployment history |

Production logs show this order on 2026-09-14 UTC:

1. `01:16:21.460` trusted verifier/template verified.
2. `01:16:21.464` durable bucket download started at the pinned object key.
3. `01:16:21.629` exact ZIP verified.
4. `01:16:21.635` all 34 assets and release identity verified by the repository verifier.
5. `01:16:21.694` artifact atomically committed to the new durable namespace.
6. `01:16:21.699` `.ready` written after verification.
7. `01:16:21.703` server started.

The production function matches the isolated-tested function byte for byte.
Railway dependency discovery reported `{}` and skipped package installation.
`PREVIEW_URL` is absent from service variables and from the active function.
The deleted-preview hostname is absent from both the active function and runtime
artifact. The only artifact-fetch callback accesses the fixed durable S3 key;
startup logs record that source and no preview request. Historical fallback code
exists solely in the preserved rollback configuration, outside the active runtime.

The actual browser updated through the existing service worker lifecycle: its
first navigation used the historical worker; after closing that client and
reopening, the reviewed release initialized and displayed the exact merged main
and Manifest provenance. No browser storage was cleared and no SW activation was
forced. No Studio errors were observed; browser-extension metadata errors were
unrelated to the application.

Read-only container inspection confirmed the historical `.ready` (5 bytes) and
`artifact/build.json` (4526 bytes) are byte-identical before/after migration. Their
timestamps and the historical artifact directory timestamp are unchanged. The new
cache was added under `/studio-cache/durable-v1/`; the old namespace was not reused.
The old deployment is stopped (`REMOVED` in Railway history), with its snapshot and
full non-secret restoration configuration preserved. Rollback was not exercised on
production because the migration succeeded. The [runbook](README.md#rollback)
restores the old expected identity variables and start command against the intact
old cache, without needing the deleted preview.

See [production-http.json](evidence/production-http.json),
[production-logs.json](evidence/production-logs.json),
[production-config.json](evidence/production-config.json),
[production-browser.json](evidence/production-browser.json), and
[production-cache-after.json](evidence/production-cache-after.json).

## Review and CI

Operations changes and evidence are on branch `studio-permanent-durable-migration`
in [PR #9](https://github.com/a91453/mml-tools/pull/9), left unmerged.
[Release CI](https://github.com/a91453/mml-tools/actions/runs/34793481305) reproduced
and published the pinned ZIPs successfully. Full Studio CI and durable bootstrap
CI passed on the pre-production evidence checkpoint `17a847a81a7b7038c5eddfcff15afe7cb5467a39`.
The PR checks track the final evidence checkpoint's CI.
