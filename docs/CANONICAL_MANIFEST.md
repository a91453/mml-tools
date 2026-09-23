---
canonical_version: 2026-09-23-v3
canonical_status: PUBLISHED
manifest_version: 2026-09-23-v3-manifest1
rules_snapshot_sha: ff1a9df054f5ca1ae42571067fc95feb274755ef
machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@2
---

# Mabinogi Mobile MML — Canonical Manifest

This is the single GitHub source-of-truth entry point and loading map for the published Canonical rules
in `a91453/mml-tools`. It indexes the `2026-09-23-v3` release; it adds no music
rules, syntax rules, exceptions, or acceptance gates. `PUBLISHED` describes that rules
release. This Manifest becomes the published entry point when its PR is merged
into `main`; a branch or PR copy is a proposed index until then.

## Release identity and Git identity

| Field | Meaning | Resolution |
| --- | --- | --- |
| `canonical_version` | Version of the published human-readable rules. | Fixed metadata above; never inferred from HEAD, a date, a contract, or a test result. |
| `canonical_status` | Publication state of that rules release. | `PUBLISHED` corresponds to the rule documents' `Status: PUBLISHED CANONICAL`. |
| `manifest_version` | Version of this index/loading map. | Independent of the Canonical rules version. |
| `rules_snapshot_sha` | Immutable commit containing the reviewed, published rules of this release. | The full commit SHA above; load all indexed resources from this commit. It is a strict ancestor of the Manifest revision that names it, never that revision itself. |
| `machine_delivery_schema` | Machine-delivery contract this release activates (`ACCEPTANCE_CRITERIA.md`, "Machine delivery"). | Optional; declared from `2026-09-23-v2` (`@1`); `2026-09-23-v3` declares `@2`. Without it, `AUTOMATED_VALIDATED` has no authority. The Manifest carries no other optional field. |
| `manifest_commit` | Git commit that introduced the loaded Manifest revision; for manifest1, its addition commit. | Obtain from Git history at load time; do not store a literal commit in this file. |
| `repository_head` / `pr_head` | Current repository checkout or actual PR source commit. | Obtain from Git / PR metadata at load time; provenance only, never a Canonical version or substitute rules snapshot. |

For the chosen Manifest ref, resolve `manifest_commit` with
`git log -1 --format=%H <manifest_ref> -- docs/CANONICAL_MANIFEST.md`.
Resolve the checkout with `git rev-parse --verify HEAD`. Obtain `pr_head` from the
PR's source head, not the synthetic merge commit used by pull-request CI.
The Manifest ref itself may be resolved to a full SHA first to keep one load
consistent. None of these dynamic identities changes the fixed release metadata.

## Snapshot authority map

Every link below is pinned to `rules_snapshot_sha`, not to `main` or a PR head.
All six document headers declare `Version: 2026-09-23-v3`. The four rule sources
and `PENDING.md` declare `Status: PUBLISHED CANONICAL`; `OFFICIAL_EVIDENCE.md`
declares `Status: CANONICAL SUPPORTING EVIDENCE`. Publication of an inventory or
evidence file does not turn its contents into an independent rule authority.

<!-- authority-map:start -->
| Snapshot locator | Authority | Loading role |
| --- | --- | --- |
| [docs/MASTER_RULES.md](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/docs/MASTER_RULES.md) | `CANONICAL_RULE_SOURCE` | Human-readable project policy. |
| [docs/SOURCE_POLICY.md](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/docs/SOURCE_POLICY.md) | `CANONICAL_RULE_SOURCE` | Human-readable source and evidence policy. |
| [docs/MOBILE_SYNTAX.md](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/docs/MOBILE_SYNTAX.md) | `CANONICAL_RULE_SOURCE` | Human-readable Mobile syntax and delivery policy. |
| [docs/ACCEPTANCE_CRITERIA.md](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/docs/ACCEPTANCE_CRITERIA.md) | `CANONICAL_RULE_SOURCE` | Human-readable acceptance criteria. |
| [docs/PENDING.md](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/docs/PENDING.md) | `PENDING_HISTORICAL_INVENTORY` | Pending questions and historical inventory; cannot create or override rules. |
| [docs/OFFICIAL_EVIDENCE.md](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/docs/OFFICIAL_EVIDENCE.md) | `SUPPORTING_EVIDENCE` | Supporting evidence index; cannot override Canonical rules. |
| [studio/backend/rules/index.mjs](https://github.com/a91453/mml-tools/blob/ff1a9df054f5ca1ae42571067fc95feb274755ef/studio/backend/rules/index.mjs) | `IMPLEMENTER` | Executable contract implementing the human-readable rules. |
| [studio/backend/canonical/](https://github.com/a91453/mml-tools/tree/ff1a9df054f5ca1ae42571067fc95feb274755ef/studio/backend/canonical/) | `IMPLEMENTER` | Canonical IR/schema and merge implementation. |
| [studio/tests/](https://github.com/a91453/mml-tools/tree/ff1a9df054f5ca1ae42571067fc95feb274755ef/studio/tests/) | `VERIFIER` | Studio implementation regressions. |
| [studio/audio-worker/tests/](https://github.com/a91453/mml-tools/tree/ff1a9df054f5ca1ae42571067fc95feb274755ef/studio/audio-worker/tests/) | `VERIFIER` | Audio-worker implementation regressions. |
| [tests/](https://github.com/a91453/mml-tools/tree/ff1a9df054f5ca1ae42571067fc95feb274755ef/tests/) | `VERIFIER` | Legacy implementation regressions. |
<!-- authority-map:end -->

Executable contracts, schemas, parsers, validators, and tests throughout the
repository are implementers/verifiers only, whether or not individually indexed
above. They cannot define Canonical rules in reverse. A successful check does not
increase their authority. The new Manifest verifier belongs to the Manifest
revision, so it is not asserted to exist in the earlier rules snapshot.

## Release history

Earlier releases stay reproducible from their own Manifest revision in `main`
history; they are not loaded alongside the current one.

| `canonical_version` | `manifest_version` | `rules_snapshot_sha` | Change |
| --- | --- | --- | --- |
| `2026-09-13-v1` | `2026-09-13-v1-manifest1` | `0a172900a01fdf39c2e9e84cf176961320b779ea` | First published release. |
| `2026-09-23-v2` | `2026-09-23-v2-manifest1` | `1c84c95133990e3882a5770077c3d2d39b1a6b04` | Machine delivery: `AUTOMATED_VALIDATED` before human listening and in-game review; every other rule unchanged. Change record: `docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md`. |
| `2026-09-23-v3` | `2026-09-23-v3-manifest1` | `ff1a9df054f5ca1ae42571067fc95feb274755ef` | Delivered first, flagged for listening (machine-delivery schema `@2`): sub-grid releases at a source's systematic export offset held provisionally in the delivered Final, Lead promotion without primary evidence flagged "Lead unverified", same-value Tempo restatements collapsed; every other rule unchanged. Change record: `docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md`. |

## Conflict precedence for loading published rules

Apply this order from highest to lowest:

1. The rules snapshot designated by the **Published Canonical Manifest**.
2. The Canonical human-readable rule sources that this Manifest points to in that snapshot.
3. Executable contracts / schemas / tests, as implementers and verifiers only.
4. Explicit candidate changes that have not yet been published.
5. Conversation / task context.
6. Local / legacy Skill, Master, and memory.

The first item selects the release; the second contains its actual rules. This
order identifies what is published and what to load. It does not restate or amend
the musical decision hierarchy or evidence arbitration inside the rule sources.
Candidates and task instructions do not silently republish a release or move its
snapshot. Handle proposed rule changes through the existing change-control
section of `MASTER_RULES.md`; record unresolved conflicts without inventing a
replacement rule in this index.

`PENDING.md` is an inventory, not the unpublished-candidate tier. Supporting
evidence is interpreted under the Canonical rule sources and is not an override.
Audit, Migration, Release Readiness, Workbench documentation/output, Draft2
history, old local Skills, and old GitHub Skill patches are not Canonical
authorities. In particular, `docs/RULES_AUDIT_2026-09-13.md`,
`docs/STUDIO_MIGRATION.md`, `docs/RELEASE_READINESS_2026-09-13.md`, and
`skills/mabinogi-mobile-mml/` must not be loaded as replacements for the four
rule sources above.

## Loading procedure

1. Read `docs/CANONICAL_MANIFEST.md` from the published `main` history (or an
   explicitly selected Manifest revision for review/reproduction). Record the
   chosen ref and its publication/review context.
2. Read the four fixed metadata fields and, when present, `machine_delivery_schema`. Resolve `manifest_commit`,
   `repository_head`, and, when applicable, `pr_head` separately from Git/PR data.
3. Verify that `rules_snapshot_sha` is an available full commit and that the
   indexed paths exist in its tree. A shallow checkout must fetch the required
   history; do not fall back to current HEAD if the snapshot is unavailable.
4. Load the four `CANONICAL_RULE_SOURCE` documents from that exact commit, for
   example `git show <rules_snapshot_sha>:docs/MASTER_RULES.md`, and verify their
   version/publication headers. Load the inventory and evidence with their
   distinct roles. A relative cross-reference in a snapshot document resolves
   within the same snapshot, not against current HEAD.
5. Consult implementation/test resources only with their lower authority. Report
   drift against the selected rules; do not use implementation behavior to rewrite
   the release identity or the human-readable rules.

For 64, Nxx, Tempo, Lead, Core3, and Final Gate decisions, read the relevant
Canonical rule sources above. This index supplies no separate definitions of
those rules. Updates to repository HEAD or to this index alone do not publish a
new Canonical version; a new rules release requires an explicit, reviewed update
to its release metadata and snapshot reference.
