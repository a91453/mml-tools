# Studio v1 — PR #2 Release Readiness Audit

Date: 2026-09-13
Target: `studio-v1` → `main`
Status: READY FOR REVIEW — PUBLISHED CANONICAL v1 + CURRENT-HEAD CI VERIFIED

## Scope

This audit evaluates whether PR #2 can safely place the Studio v1 source architecture into `main` without silently replacing the existing production Workbench/Railway/MCP behavior or reintroducing a second rule authority.

It does **not** certify any song as Final and does **not** deploy Studio to production.

## Production boundary

PR #2 changes do not include existing production implementation paths under:

- `server/`
- `railway/`
- legacy `dist/` application/runtime files

The legacy Workbench remains the production deployment path until a separate explicit migration decision. Studio v1 entering `main` means the source/docs/tests become version-controlled on the default branch; it does not itself switch Railway/MCP traffic to Studio.

## Canonical authority boundary

Human-readable rule authority remains:

- `docs/MASTER_RULES.md`
- `docs/SOURCE_POLICY.md`
- `docs/MOBILE_SYNTAX.md`
- `docs/ACCEPTANCE_CRITERIA.md`
- `docs/PENDING.md`

The reviewed rule set is published as `2026-09-13-v1` with status `PUBLISHED CANONICAL`.

`studio/backend/rules/index.mjs` implements that policy and explicitly does not define it.

Legacy Workbench behavior, old tests, community examples and old skills remain evidence/reference only.

## Release blockers found during audit

### R1 — stale status documents

Found:

- `docs/RULES_AUDIT_2026-09-13.md` still claimed original-audio alignment was pending;
- `docs/STUDIO_MIGRATION.md` still listed audio alignment as the next global blocker;
- `studio/README.md` repeated the same stale blocker;
- root `README.md` described old Workbench syntax rejection in a way that could be mistaken for current Canonical rules.

Disposition: **fixed on `studio-v1`**. Status docs now distinguish legacy Workbench behavior, current Canonical policy and current implementation state.

### R2 — Lead removal could bypass Lead Demotion gate

Found: baseline diff could show a Melody/Lead event removed or moved while `leadDemotionReports=[]` produced `N/A`, allowing readiness to miss the Canonical requirement for positive demotion evidence.

Disposition: **fixed on `studio-v1`**. `evaluateProjectReadiness()` now requires every baseline Lead removal/role move to have a matching `PASS` demotion report; otherwise the Lead gate is `PENDING` with `LEAD_DEMOTION_EVIDENCE_REQUIRED`.

Regression coverage was added for both missing and matching reports.

### R3 — CI only re-ran after Studio branch pushes

Found: PR validation existed, but post-merge `main` pushes were not included in the Studio CI push trigger.

Disposition: **fixed on `studio-v1`**. Studio CI now runs on pushes to both `studio-v1` and `main`, plus pull requests and manual dispatch.

## Existing reviewed alignment retained

The earlier Canonical/Studio reviews remain in force:

- ingest vs Final validation are separate;
- plain 64 is accepted;
- arbitrary plain 1–64 caution values are preserved at ingest;
- plain 48 is not called engine-illegal;
- Nxx is preserved at ingest and requires explicit opt-in + evidence references for Final preservation;
- fragile dotted forms remain Final-forbidden by project policy;
- Tempo-map delivery policy is explicit for non-empty roles while engine necessity remains pending;
- empty roles remain empty;
- cross-role end-time mismatch is review-only;
- Source-Faithful Baseline uses a real snapshot and computed event diff;
- Chord2 is not Bass-only;
- executable code implements Canonical docs rather than defining them.

## Module readiness vs song readiness

All required Studio implementation modules are present, including original-audio alignment. An empty `studioFinalBlockers()` list means only that required modules exist.

Per-song readiness still requires its own evidence/gates. `candidateReady=true` is not Final acceptance; `finalAccepted=true` additionally requires explicit in-game acceptance.

## Known non-blocking debt carried forward

These remain visible and must not be overstated:

- caution-length opt-in is candidate-level rather than per-token;
- exact O-token edge mapping versus official pitch 0–107 remains pending;
- baseline snapshot provenance/deep-freeze workflow can be hardened further;
- generic sub-1/64 technical micro-gap analysis is incomplete;
- Final-forbidden dotted tokens may still exist in low-level parse events when callers intentionally inspect an errored Final parse; callers must honor validation errors;
- not all named historical song regressions have committed reproducible fixtures;
- the Studio Web UI is only a scaffold;
- Studio production deployment is not wired;
- Node dependency installation currently uses exact direct versions without a committed lockfile, so transitive install reproducibility can be hardened later.

None of these items may be represented as completed capabilities.

## Independent release review

Grok's release-level adversarial review of PR #2 at pre-finalization head `7e9df8d` reported:

`APPROVE_FOR_MAIN_RELEASE_FINALIZATION`

No P0/P1 merge blocker was identified. The remaining P2/P3 items are tracked as non-blocking debt and were not folded into Canonical finalization.

## Canonical finalization

Published Canonical metadata was finalized without changing the reviewed musical policy:

- Canonical version: `2026-09-13-v1`;
- Canonical status: `PUBLISHED CANONICAL`;
- executable contract: `implements-published-canonical`;
- finalization diff was limited to governance/status metadata, corresponding documentation, and contract-test wording.

## Current-head verification

Current head: `0380f2af5907ee3558a7cea4cca0edd6afadbc21`.

Studio CI #118, run `34725564943`, completed successfully on this head:

- symbolic regressions: **SUCCESS**;
- legacy production bundle build: **SUCCESS**;
- audio-worker regressions: **SUCCESS**.

The final `main...studio-v1` diff was rechecked and still contains no `server/`, `railway/`, or legacy `dist/` runtime modifications.

## Merge gate

All conditions required to move PR #2 from Draft to Ready are satisfied:

1. independent release-level review found no P0/P1 blocker;
2. Published Canonical v1 metadata is finalized;
3. current-head symbolic/audio/build CI is green;
4. final production-boundary diff is clean.

PR #2 may be marked Ready for Review. Merging into `main` remains a separate explicit action.
