# Pending Canonical catch-up for the permanent Studio Web

Status: DEPLOYMENT RECORD — not Canonical policy. Rule discovery starts only at
`docs/CANONICAL_MANIFEST.md`.

The permanent Studio Web serves the Canonical identity pinned in
`release-lock.json`. A new Published Canonical reaches it only through a new
durable release, and that release can only be packaged from a published `main`
that already carries the new Manifest. For that interval the two planes differ,
and this file records the difference so it is never silent.

| Plane | `canonical_version` | `rules_snapshot_sha` |
| --- | --- | --- |
| Published Canonical (agent plane, MCP service) | `2026-09-23-v2` | `1c84c95133990e3882a5770077c3d2d39b1a6b04` |
| Permanent Studio Web (`release-lock.json`) | `2026-09-13-v1` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |

`2026-09-23-v2` changes machine delivery only. The Studio Web keeps its v1
generation gating until it implements that rule, so the lag changes no result
the permanent site produces.

Closing this record:

1. Package and publish a durable release from the published `main` that carries
   the `2026-09-23-v2` Manifest (`package_release.py`, `release-lock.json`,
   `studio-durable-release.yml`), mirror it, and deploy it as for
   `RELEASE_2026-09-23.md`.
2. In the pull request that records that release, delete this file.
   `tests/deployment-topology.test.mjs` then requires the lock to name the
   loaded release again.
