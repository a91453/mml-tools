# Studio Web v1 implementation record

Status: implementation evidence only; not a Canonical rule authority.

Branch: `studio-web-v1`. Created from Published main
`cbbe14986e483f4158570cc873b7e1ce2b214408`.
No merge, production deployment, Railway/MCP switch or Canonical rule edit.

## Loaded Canonical identity

| Identity | Value |
| --- | --- |
| Canonical version | `2026-09-13-v1` |
| Rules snapshot | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest version | `2026-09-13-v1-manifest1` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| Published main used for implementation | `cbbe14986e483f4158570cc873b7e1ce2b214408` |
| Working / PR HEAD | Resolve from Git and PR metadata; not the rules snapshot |

All four rule documents and the separately classified inventory/evidence files
were loaded from the Manifest's exact snapshot. Implementation and tests remain
consumers/verifiers. No old Skill, Master, historical patch or migration document
was used to override the release.

## Reused main capabilities

| Existing module | Web integration |
| --- | --- |
| `backend/bootstrap` | Same Published-main Git loader during build; verified offline package at runtime |
| `backend/rules`, `backend/mml` | Existing ingest parser and Final validation, without opting into caution forms |
| `backend/canonical` | Existing IR constructors validate every imported item |
| `backend/score` | Existing MusicXML parser and unsupported-navigation guard |
| `backend/compare` | Existing source/baseline/accepted-version event-level lineage reports |
| `backend/arbitration` | Existing Lead demotion, Core3 continuity and cross-source harmony reports |
| `dist/core.js` helpers | Existing exact rational timing and 15-pair overlap/density diagnostics |
| `backend/final` | Existing Project Readiness plus separate missing manual-review gates |
| `backend/audio`, Python audio worker | Existing evidence validator/attacher and alignment engine |

New code consists of the touch-first UI, IndexedDB project storage, module Worker,
offline build/package verification, PWA resources, explicit audio client and a
small optional authenticated HTTP adapter around the existing Python worker.

## Validation completed in the development session

- 201 Node tests passed, including all 190 existing main tests.
- 2 new HTTP boundary tests passed with an injected aligner (independent of the
  native audio stack): auth/origin rejection, request framing, temp cleanup and
  configuration fail-closed behavior.
- Static Web/PWA build and native-browser-module imports passed. The built MML
  and MusicXML adapters match the Node implementations; repeat structures remain
  unsupported. Offline package hashes and complete precache coverage were checked.
- Legacy build succeeded. Its generated source ZIP was restored; no production
  artifact is included in the branch diff.
- Syntax and whitespace checks passed.

## Verification still outstanding

- Complete GitHub Actions on the final branch HEAD. At the time of this record,
  GitHub reported no Actions runs/check-runs for the pushed branch checkpoints.
  The connected GitHub tools do not expose workflow dispatch. A successful main
  run is not claimed as success for this branch.
- The new iPhone-size/iPad-size WebKit and Chromium browser suite is committed
  to CI, but has not yet run. Local browser download was blocked by network
  timeouts, and the cloud browser could not reach the local preview. Screenshots,
  touch layout, IndexedDB and offline restart are not yet visually verified.
- Full native audio regressions must run in CI. The restored local audio venv
  exited with signal 135; this is not reported as a passing audio suite.
- Real iPhone/iPad Safari Files providers, Home Screen lifecycle, storage eviction,
  clipboard permission/fallback, and actual Mabinogi client playback/acceptance.
- A separately configured HTTPS Audio Worker integration with real source audio.

The requested order is full CI success before opening a Draft PR. Until that
gate is satisfied or the user explicitly authorizes opening a Draft to trigger
PR CI, do not claim a Draft PR exists or that this implementation is release-ready.

Usage, local/cloud behavior and supported/unsupported paths are documented in
[studio/web/README.md](../studio/web/README.md).
