# Studio Web v1 implementation record

Status: implementation evidence only; not a Canonical rule authority.

This record retains earlier-session checkpoints. See the
[final pre-PR audit](STUDIO_WEB_V1_FINAL_AUDIT.md) and
[Draft PR #7](https://github.com/a91453/mml-tools/pull/7) for final findings,
checkpoint identities, exact-HEAD CI and device limitations.

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

One reused module was changed rather than only wired up. Cross-source harmony
review compares every pair of note events, and its per-pair test was rebuilding
exact-rational beat values and source sets; at song length that alone exceeded
the Worker call timeout the UI enforces, so a normal-length song could not be
analysed on the target device. The per-pair test now reuses values parsed once
and is ordered cheapest-first. The reviewed pairs, reported conflicts, their
fields and their order are unchanged, verified against the previous
implementation over randomised multi-source fixtures. No Canonical rule,
threshold or reviewed interval was touched.

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

## CI verification since that session

The three items this record previously listed as unrun have now run. Studio CI
run 145 on branch HEAD `33cf6900f8454e4b822811dcfdc3731303760f27` completed with
all three jobs successful:

| Job | Covers | Result |
| --- | --- | --- |
| `symbolic` | Canonical Bootstrap, Node regressions, Studio PWA build, legacy build | success |
| `audio-worker` | native FFmpeg/librosa alignment regressions on Python 3.12 | success |
| `studio-web` | iPhone-size WebKit, iPad-size WebKit and desktop Chromium user flows | success |

The `studio-web` job runs all three browser profiles in one job, so the profile
names are its results, not separate jobs. Screenshots and `results.json` are
uploaded as run artifacts. Later branch commits re-run the same three jobs; a
green run certifies the commit it ran on, never a later one.

## Verification still outstanding

- Real iPhone/iPad Safari Files providers, Home Screen lifecycle, storage eviction,
  clipboard permission/fallback, and actual Mabinogi client playback/acceptance.
  CI exercises WebKit at iPhone/iPad viewport size, which is not a real device.
- A separately configured HTTPS Audio Worker integration with real source audio.
  CI covers the HTTP adapter boundary with an injected aligner only.
- Named historical-song regressions remain `FIXTURE_PENDING`. A green CI run
  never certifies those songs.

Passing CI is a `TECHNICAL_PASS` for the implementation, not song acceptance and
not release readiness. Draft PR #7 is open; it remains draft and unmerged.

Usage, local/cloud behavior and supported/unsupported paths are documented in
[studio/web/README.md](../studio/web/README.md).
