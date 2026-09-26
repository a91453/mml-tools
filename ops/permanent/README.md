# Studio v1 durable deployment

> Railway resource IDs are kept out of this public repository and appear as `<redacted-id-N>` (the same N is the same resource). Read them from the Railway dashboard.

Current release: main `718c8452dd4f` (v9), which carries Published Canonical
`2026-09-23-v3`. See [RELEASE_2026-09-26-v9.md](RELEASE_2026-09-26-v9.md) for
its identity, runs, startup log and rollback. Before it ran v8 (main
`d59836cf4a0d`, Canonical v3, pinned in commit `530b82679d3f`); the releases
before that are [RELEASE_2026-09-25-v7.md](RELEASE_2026-09-25-v7.md) (main
`5dbf42a51c83`, Canonical v3),
[RELEASE_2026-09-25-v6.md](RELEASE_2026-09-25-v6.md) (main `8613d0c40db2`,
Canonical v3), [RELEASE_2026-09-25-v5.md](RELEASE_2026-09-25-v5.md) (main `25b8acd2ed21`,
Canonical v3), [RELEASE_2026-09-24-v4.md](RELEASE_2026-09-24-v4.md) (main `d7ec3c6ea7bd`,
Canonical v3), [RELEASE_2026-09-23-v3.md](RELEASE_2026-09-23-v3.md) (main `e8d7a998d926`,
Canonical v3), [RELEASE_2026-09-23-v2.md](RELEASE_2026-09-23-v2.md) (main
`45c5a2963b1e`, Canonical v2) and [RELEASE_2026-09-23.md](RELEASE_2026-09-23.md)
(main `66e9244f89e2`, Canonical v1). The original migration (main `5769e76849e5`) is recorded in
[MIGRATION_RESULT.md](MIGRATION_RESULT.md); the sections below keep describing
that historical release where they name its pins.

This is deployment operations material, not Canonical policy or a Studio feature release.
The current release serves Published Canonical `2026-09-23-v3` / `PUBLISHED`, with
Manifest revision `2026-09-23-v3-manifest1`, rules snapshot
`ff1a9df054f5ca1ae42571067fc95feb274755ef` and Manifest commit
`44f3f0082cf5c30328edf1c251398b844488ad0a`. The historical migration below served
`2026-09-13-v1` at snapshot `0a172900a01fdf39c2e9e84cf176961320b779ea`.

## Fixed sources

| Identity | Pinned source |
| --- | --- |
| Reviewed runtime and trusted verifier/template | Merged main `5769e76849e5ef8dad03b4080050cafcf1c2eabe` |
| Reviewed PR parent | `bdc16f443724e3c9e24c883a31513d7ac5871359` |
| Runtime ZIP immutable Git blob | `3803dcc07e9a6f2da122935dd0cbab21d818852d` |
| Trust ZIP immutable Git blob | `62753f1cacd19d1d638bd1737d1feb261719d0d3` |
| Commit retaining both ZIPs under `ops/permanent/assets/` | `574c8973a9f8b1ef5c9f7bb32ef589dcb57ec43b` |
| Tested bootstrap source checkpoint | `3f51500786676083cf2e0a7a0e8f093e9fd4fb04` |
| Rendered Railway function SHA256 | `5017a2e2035bc67799dfe662a23ca1a109c3192dc742c8515f90032b8cc750cb` |

[GitHub Release](https://github.com/a91453/mml-tools/releases/tag/studio-v1-durable-5769e76849e5)
is a durable distribution copy of the fixed ZIPs. GitHub currently reports
`immutable: false` for this release: native Release immutability is **not** enabled.
Content immutability is anchored independently by the Git blob/commit identities
above and the SHA256 pins in [release-lock.json](release-lock.json). No deployment
accepts replacement bytes just because they are at the same URL, tag or object key.
The publishing workflow refuses to overwrite an existing asset. A re-run after
a run that failed during the uploads resumes that run's draft (found by listing
releases, since a draft does not own its tag yet) and uploads only the missing
assets; it refuses if more than one draft matches the lock's tag and source.

The private Railway bucket `studio-release-artifacts`
(`<redacted-id-5>`) contains byte-identical runtime and trust
ZIP mirrors under SHA256-addressed keys. Both were read back after upload. It
is independent of the production/isolated volumes. No Actions artifact or
temporary service URL is a permanent source. Never delete the release, pinned
asset history, or bucket as part of test-service cleanup.

## Trust and startup

The generated function embeds the separately pinned trust ZIP and release lock.
It hashes that ZIP before extraction, verifies all four trusted source files, then
imports the unchanged repository verifier. The shipped runtime never supplies its
own verifier or expected SW template. The verifier checks all asset hashes,
mandatory `sw.js`, embedded Canonical consistency, runtime bundle digest, trusted
Stage A cacheId, deterministic SW rendering and Stage B buildId. The adapter adds
the exact cacheId and complete `build.json` SHA256 pins and checks audit provenance.

The release lives at `$CACHE_DIR/durable-v1/<buildId>/artifact`; its `.ready` is
outside the verified artifact. Every startup fully verifies cache bytes before
opening a listening socket. Downloads are extracted into a separate staging
directory, verified, flushed and atomically renamed. `.ready` is written only
after verification and commit. HTTP serves a verified in-memory snapshot, so a
subsequent disk mutation cannot leak corrupted bytes from a running instance.

The historical `/studio-cache/artifact` and `/studio-cache/.ready` are not modified.
Corruption fails closed by default. Explicit `RELEASE_RECOVER_CORRUPT=1` moves the
rejected release to a quarantine directory and downloads/verifies the entire
durable ZIP before starting. It never serves the rejected cache or repairs only
one file. Set the flag back to `0` after recovery.

## Recover without a temporary preview

1. Obtain this operations source at checkpoint
   `3f51500786676083cf2e0a7a0e8f093e9fd4fb04` (or a later reviewed operations-only
   commit containing byte-identical bootstrap files).
2. Obtain the ZIPs from the Release or the fixed Git blobs, and verify the lock's
   SHA256 pins. The source repository is private; use an authorised GitHub client.
3. If the bucket is lost, create a replacement private bucket. Upload the exact
   ZIPs under the lock's object keys, then read them back and verify their hashes.
   `upload-mirror.mjs` is a temporary authenticated transfer helper; it is not a
   runtime source and must not remain the production bootstrap. Alternatively,
   `.github/workflows/studio-durable-mirror.yml` (manual dispatch) takes the Git
   copies of the Release assets, checks them against the lock, uploads any missing object and
   reads every object back. It needs the five `RELEASE_S3_*` values as
   repository secrets for the transfer only; delete them afterwards. It never
   overwrites an existing key.
4. Render the function:

   ```sh
   python ops/permanent/build_function.py ops/permanent/assets /tmp/studio-durable-function.ts
   ```

5. Use `ghcr.io/railwayapp/function-bun:1.4.0`, the rendered source as the Function
   start command, `/health`, one replica, and a volume mounted at `/studio-cache`.
   `CACHE_DIR=/studio-cache`, `RELEASE_OFFLINE_ONLY=0`,
   `RELEASE_RECOVER_CORRUPT=0`. There must be no `PREVIEW_URL` variable.
6. Map the following variables to the bucket's Railway references; do not copy
   secrets into code or evidence:

   | Variable | Reference |
   | --- | --- |
   | `RELEASE_S3_ENDPOINT` | `${{studio-release-artifacts.ENDPOINT}}` |
   | `RELEASE_S3_BUCKET` | `${{studio-release-artifacts.BUCKET}}` |
   | `RELEASE_S3_REGION` | `${{studio-release-artifacts.REGION}}` |
   | `RELEASE_S3_ACCESS_KEY_ID` | `${{studio-release-artifacts.ACCESS_KEY_ID}}` |
   | `RELEASE_S3_SECRET_ACCESS_KEY` | `${{studio-release-artifacts.SECRET_ACCESS_KEY}}` |

7. Create a **new deployment from current config**. In this session,
   `railway_redeploy` reused the old deployment's start command; Railway's
   `deployServiceTool` correctly applied current configuration. A historical
   snapshot redeploy is suitable only when that snapshot is intended.
8. Confirm logs show `TRUSTED_SOURCE_VERIFIED`, `ARTIFACT_VERIFIED`,
   `READY_MARKER_WRITTEN_AFTER_VERIFICATION`, and `SERVER_STARTED`; on cold start
   also require download, ZIP verification and atomic commit events. Function
   dependency discovery must report `{}` and skip dependency installation.
9. Run `verify_deployed.py <permanent-URL> <report.json>` and verify the actual
   browser initializes Published Canonical. For cached recovery, set
   `RELEASE_OFFLINE_ONLY=1`, restart with the same cache and verify success with
   no download event; restore `0` for normal durable recovery capability.

## Sound banks

A sound bank the owner provides (for example the game-style bank) is never
committed and never enters the reviewed artifact, whose verifier rejects sound
banks. `sound-banks.json` pins each file by SHA-256 and byte count, and
`build_function.py` embeds those pins. `.github/workflows/studio-sound-bank-mirror.yml`
copies the pinned files from the owner's draft Release into the private bucket
(no overwrite, then read back). The function serves them at
`/banks/<id>/<sha256>.<ext>`: it reads each from the bucket on first request,
checks the pin, keeps the bytes in memory and serves them as immutable. A failed
or mismatched read answers 503 and the next request tries again; it never
affects the Studio artifact.

## Rollback

The pre-migration production deployment is
`<redacted-id-3>`, service
`<redacted-id-2>`, original volume
`<redacted-id-4>`. [rollback-config.json](evidence/rollback-config.json)
preserves its full non-secret source/deploy/volume configuration and the restore
pins derived from its successfully validated historical artifact. OAuth hides
the original variable values, so this is not a claim to have exported secrets.

Restore those expected identity variables and historical start command, keep the
same volume/mount, and deploy the historical snapshot or a new deployment from
the restored configuration. Its old artifact and `.ready` must remain intact.
The historical bootstrap's deleted-preview fallback is unnecessary for validated
cached rollback and must never be used to reconstruct a missing historical cache.
Do not delete either cache namespace during rollback. Verify the historical
buildId `67733dd81d4b1351f2eff07e7f362bf0457cd79fdf3afb51d46de2c7485c7a9c`.

## Evidence

`evidence/isolated-phases.json` records cold bootstrap, offline cached startup,
intentional cached `app.mjs` corruption and durable recovery. The corruption
test retained `.ready`, correctly failed hash verification, did not refetch and
started no server. The failure was expected test behavior; production was untouched.
The generated runtime artifact remains the reviewed 34-asset release throughout.
