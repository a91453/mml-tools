# Studio Status / Readiness Snapshot — 2026-09-15

Status: CURRENT IMPLEMENTATION / READINESS RECORD — NOT A CANONICAL AUTHORITY

This document is a dated snapshot of the repository state after PR #21 merged to
`main`. It is intentionally separate from older readiness/audit records. It does
not amend, replace, reinterpret, or republish Canonical rules.

For rule loading, start only from `docs/CANONICAL_MANIFEST.md` on Published
`main`, then load the Manifest-pinned rules snapshot. If that cannot be loaded,
Canonical judgment must fail closed with `CANONICAL_NOT_LOADED`.

## 1. Snapshot identity

| Field | Value |
| --- | --- |
| Snapshot date | `2026-09-15` |
| Published `main` HEAD | `c78c5b1c938540562c66688db5f485bcdc9ae806` |
| Main HEAD meaning | merge of PR #21, `Studio Web: integrate local Raw MIDI pipeline` |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest addition commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |

The repository HEAD and Canonical rules snapshot are deliberately different Git
identities. Studio implementation work after publication does not move the rules
snapshot and does not publish a new Canonical version.

## 2. Canonical authority state

No Canonical rule source was changed by PR #21. The Published Manifest still
selects the same `2026-09-13-v1` rules snapshot.

Canonical rule authority remains the four human-readable rule sources selected
by the Manifest:

- `docs/MASTER_RULES.md`
- `docs/SOURCE_POLICY.md`
- `docs/MOBILE_SYNTAX.md`
- `docs/ACCEPTANCE_CRITERIA.md`

`docs/PENDING.md` remains a historical/pending inventory and
`docs/OFFICIAL_EVIDENCE.md` remains supporting evidence. Studio executable code,
schemas, parsers, validators, tests and this snapshot are implementers/verifiers
or status records only; none can define Canonical in reverse.

**Readiness result:** Canonical identity is stable for this snapshot. No Manifest
or rules-snapshot update is required merely because Studio gained Raw MIDI Web
integration.

## 3. Current Studio implementation state

At this main HEAD, the repository contains the source-aware Studio architecture
plus the current Web/PWA integration.

Implemented layers include:

- Published Canonical bootstrap with fail-closed snapshot loading;
- MML ingest and Final validation separation;
- Canonical Music IR with source/event provenance;
- score-partwise MusicXML ingestion with unsupported constructs surfaced;
- current/historical MML normalization and version-drift reporting;
- Source-Faithful Baseline and event-level diff;
- Lead demotion evidence gate;
- Core3 continuity diagnostics;
- cross-source harmony review signals/arbitration support;
- original-audio alignment worker and Node evidence bridge;
- per-song readiness evaluation;
- local-first Studio Web/PWA;
- G11-A Raw MIDI intake to source-faithful Canonical evidence;
- G11-B clean-room, source-preserving monophonic voice decomposition;
- G11-C traceable six-role candidate suggestions;
- local Web Raw MIDI `.mid` / `.midi` intake, persistence, reload and browser
  presentation;
- deterministic Raw MIDI source identity derived from the full SHA-256 of source
  bytes;
- WebKit/Chromium browser regression coverage for the current Web path.

These are implementation capabilities. They do not mean any song automatically
passes Lead, Core3, Full6, audio, Mobile adaptation, player/readback or in-game
acceptance gates.

## 4. Raw MIDI path now present on Published `main`

The merged Web path is:

```text
.mid / .midi file
  -> browser File / ArrayBuffer
  -> local Web Worker
  -> existing Studio MIDI ingest
  -> Canonical source project
  -> G11-B voice decomposition
  -> G11-C role candidate suggestion
  -> Web report / persistence
```

Important boundaries retained by the implementation:

- source bytes are the provenance authority for the Raw MIDI source identity;
- Raw MIDI source identity is content-derived, not a random request id;
- request/race identity remains ephemeral and separate from source provenance;
- G11-B remains lossless decomposition, not role assignment;
- G11-C remains a candidate suggestion layer, not an accepted arrangement;
- percussion/unsupported source material is retained separately rather than
  silently treated as pitched notes;
- derived G11-B/G11-C material is re-derived rather than accepted as persisted
  truth;
- source replacement invalidates review state bound to the replaced revision.

The Raw MIDI Web integration adds no new Canonical rule, evidence class or gate.

## 5. G11 scope boundary

The current G11 chain is intentionally staged:

```text
G11-A  Raw MIDI -> Source-Faithful Canonical evidence
G11-B  source voices -> lossless source-aware candidate lanes
G11-C  evidence + lanes -> traceable six-role candidate suggestions
```

G11-C still does **not** perform Final MML generation, Final canonicalization,
octave/Mobile audibility adaptation, instrument assignment, volume mapping,
Tempo-map emission, automatic collision repair, performer allocation or
in-game acceptance.

Accordingly, the presence of a G11-C candidate must never be reported as
`VALIDATED`, `IN_GAME_ACCEPTED`, or an accepted six-role arrangement without the
later evidence/gates that those states require.

## 6. Verification at the exact Published main HEAD

GitHub Actions run `34983969015` was triggered by the push of
`c78c5b1c938540562c66688db5f485bcdc9ae806` to `main` and completed with
`success`.

The exact-head Studio CI jobs recorded as successful were:

| Job | Evidence at this HEAD |
| --- | --- |
| `symbolic` | Canonical Bootstrap verification, legacy + Studio symbolic regressions, Studio PWA build and legacy production bundle build all completed successfully |
| `studio-web` | Studio Web build and `npm run test:studio-web` completed successfully with Chromium/WebKit installed by CI |
| `audio-worker` | audio alignment regressions completed successfully |

This is exact-HEAD CI evidence for repository implementation. It is not song
validation, in-game testing, production deployment proof or a substitute for
Canonical source evidence.

The external deployment status associated with this merge reported:
`No deployment needed - watched paths not modified`.

Therefore this merge did **not** switch production Railway/MCP traffic to Studio.

## 7. Production / deployment boundary

The current repository still distinguishes Studio from the existing production
Workbench/Railway/MCP path.

For this snapshot:

- Studio source is present on `main`;
- Studio Web can be built and tested;
- the Raw MIDI Web path is implemented and CI-covered;
- the merge did not deploy Studio as the production Railway/MCP implementation;
- no production cutover should be inferred from a green Studio build;
- no production acceptance claim is made by this document.

A future deployment/cutover needs its own explicit task, target, review and
post-deployment verification.

## 8. Current open implementation debt / risk

The following are carried forward as real boundaries rather than hidden by the
new capability.

### P2 — Lead demotion source-identity containment

`evaluateLeadDemotion` does not independently verify that a supplied
`sourceIdentity` matches the event's own `sourceIds` / `sourceEventIds`.

Current production callers were reviewed as unable to construct the mismatch,
and the Raw MIDI work added preflight/regression containment, so this is not a
known reachable P1 at this snapshot. It remains debt and should be re-audited
whenever new Lead-demotion callers or evidence paths are added.

### P2 — Canonical project arrays are not deeply frozen

`createCanonicalProject` freezes the project object but does not make every
contained event array deeply immutable. Current reviewed paths do not mutate
those arrays after construction, and G11 processing protects its working input,
but the constructor itself does not guarantee deep immutability.

### Documentation drift

`studio/web/README.md` predates PR #21 in at least one material statement: its
explicit v1 limits still describe raw MIDI intake as unsupported. That is now an
implementation-documentation defect, not a Canonical defect.

This snapshot records the drift rather than rewriting an older dated audit. A
follow-up documentation cleanup should update current living README material
while retaining historical dated records unchanged.

### Raw MIDI path stops before Final delivery

The Web Raw MIDI path currently ends at preserved source evidence, G11-B
candidate lanes, G11-C candidate role suggestions and existing readiness
information. It does not itself perform later Final arrangement acceptance,
Mobile adaptation, Final MML emission or target-client acceptance.

### Song-specific evidence remains mandatory

A globally implemented module does not pass that gate for a song. Each song
still needs the applicable source/version identity, baseline, Lead, Core3,
Full6/cross-source arbitration, timing/audio, Mobile adaptation, regression,
player/readback and in-game evidence required by Published Canonical.

### Historical named regressions

A named historical regression without a committed reproducible fixture remains
`FIXTURE_PENDING`; synthetic coverage cannot be reported as having passed that
specific song regression.

## 9. Readiness assessment

### Repository / implementation readiness

**READY FOR CONTINUED STUDIO DEVELOPMENT ON MAIN.**

The current merged scope has exact-main CI coverage, Canonical Bootstrap remains
separate from implementation HEAD, and the Raw MIDI Web integration is present
without publishing new rules.

### Canonical release readiness

**NO NEW CANONICAL RELEASE REQUIRED BY THIS CHANGE.**

There is no rule change in the Raw MIDI Web integration that would justify moving
`rules_snapshot_sha` or incrementing `canonical_version`.

### Studio production deployment readiness

**NOT ASSERTED BY THIS SNAPSHOT.**

Green repository CI and a buildable PWA are necessary implementation evidence,
not a production cutover decision. Deployment remains a separate scope.

### Song Final readiness

**NOT GLOBAL. PER-SONG ONLY.**

No repository-level status can make a song Final or `IN_GAME_ACCEPTED` without
its own evidence and gate results.

## 10. Recommended next work from this baseline

1. Fix current living Studio documentation drift, especially
   `studio/web/README.md` Raw MIDI support/status text; do not rewrite older dated
   audit/readiness history.
2. Continue clean-room migration/audit work from this exact baseline, treating
   external/legacy packages only as `LEGACY_REFERENCE` / migration sources and
   never as a Canonical override.
3. Keep G11-D / later arrangement and Final-delivery work explicit about the
   boundary between candidate suggestion, accepted arrangement, Mobile
   adaptation and Final MML.
4. Revisit the two carried-forward P2 containment issues when a new caller makes
   either boundary reachable or when adjacent architecture is changed.
5. Keep production deployment as a separately reviewed change with explicit
   target and post-deploy verification.

## 11. Historical-record policy

This file supersedes no previous dated record. In particular,
`docs/RELEASE_READINESS_2026-09-13.md` remains evidence of the repository state
and release question at that earlier date.

When implementation state materially changes again, prefer a new dated status /
readiness snapshot over silently rewriting historical conclusions.

Living documentation such as `studio/README.md` and `studio/web/README.md` may be
updated to describe the current implementation, but those files still remain
implementation documentation rather than Canonical rule authority.
