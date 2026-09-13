---
name: mabinogi-mobile-mml
description: Bootstrap Mabinogi Mobile MML creation, conversion, arrangement, repair, and audit tasks from the repository's published Canonical Manifest before using implementation or validation tools.
---

# Mabinogi Mobile MML — Manifest Bootstrap

Act as a workflow consumer, not a Canonical rule authority. Do not keep or evolve
a second rule set in this Skill. Treat local Skills, Master copies, memory, and
conversation history as workflow/context or legacy references only; they cannot
override the published Canonical.

## Load before any Mabinogi Mobile MML task

1. Start with `docs/CANONICAL_MANIFEST.md` in the published `main` of
   `a91453/mml-tools`. This is the sole Canonical discovery/loading entry point.
   Use the connected GitHub source, or refresh the repository's `origin/main`
   before using a local checkout. Do not discover rules from a patch, contract,
   standalone Master file, or this Skill.
2. Read the Manifest, then load its designated human-readable Published Canonical
   documents from its exact `rules_snapshot_sha`. Follow its authority map and
   loading procedure, including the separate roles of inventory and evidence.
   Resolve relative references within that same snapshot.
3. Record the Manifest's release metadata and the dynamic Git/PR provenance.
   Keep the rules snapshot distinct from the Manifest commit and repository/PR
   HEAD. A repository update alone does not publish new rules.
4. Only after loading succeeds, use the requested sources and repository
   implementation/validation tools under the loaded Canonical rules. Treat
   executable contracts and tests as implementers/verifiers, never rule authors.

In a refreshed Git checkout, run `node scripts/bootstrap-canonical.mjs` from the
repository root. It returns the Manifest, pinned document text, authority map,
and provenance. `--summary` is an identity check only; read the full output before
applying rules. The loader reads the fetched `origin/main` and performs no network
fetch itself. Supply actual PR-head metadata when relevant; do not equate a CI
merge checkout with the PR's source head.

## Failed loading

If the Manifest, required snapshot documents, or necessary provenance cannot be
loaded or verified, report **CANONICAL_NOT_LOADED** with the missing resource.
Stop rule-dependent arrangement, repair, validation, and Final claims. Do not
fall back to a legacy Skill, local Master, historical patch, memory, or a cached
unverified rules copy. Restore access to the published entry point, then load
again before continuing. Source/file inventory can still be reported as such.

The former Lead Role patch files are historical evidence, not a second loading
route. Do not load historical extensions by default or automatically merge them
into this Skill. Proposed rule changes follow the Manifest's change control.
