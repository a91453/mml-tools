# Studio Web / PWA v1

Status: implemented on Published `main`; not deployed as the production Railway/MCP path.
This document describes the UI implementation, not Canonical rules.
Rule loading starts only at Published main's
[Canonical Manifest](../../docs/CANONICAL_MANIFEST.md).

## Everyday use on iPhone / iPad

Open the separately hosted HTTPS Studio build in Safari. Use Share → Add to Home
Screen to install. No terminal is needed for project work. Hosting is an operator
step; the repository does not deploy a site or switch Railway/MCP traffic by
merging Studio source.

1. Create a project. Record the song/recording version, effective start/end seconds,
   source-confirmed meter map, original-audio applicability and preview usage.
2. Use Files to select the candidate, Source-Faithful Baseline and accepted previous
   version (when available). Paste is also supported. MML remains derived evidence;
   MusicXML defaults to supporting unless the user confirms official symbolic authority.
   A `.mid` / `.midi` file may also be selected as Raw MIDI source evidence; that path
   is decoded locally and feeds the preserved G11-A source project, G11-B decomposition
   and G11-C candidate suggestion described below.
3. Inspect source authority, completeness, warnings and unsupported constructs.
   Read the Analysis Gate dashboard and event-level Version Drift tables.
4. Review Lead/Core3 continuity, the 15 cross-track pair report, density and
   cross-source Harmony. Record reasons and exact source/section evidence.
   Keep decisions can be reviewed locally. Omit/move/octave/redistribution proposals
   remain pending until the symbolic candidate is actually edited and re-imported.
5. Complete each applicable musical review. Technical PASS alone leaves the song
   Candidate. Unknown statuses remain PENDING; unsupported inputs remain blocked.
6. Copy the complete MML@ or individual roles, and export the six-role text,
   Canonical IR, analysis report or portable project backup when those artifacts
   exist for the current workflow. Raw MIDI intake by itself does not generate Final
   MML.
7. Only after every necessary non-game gate passes does the state become Validated.
   Explicit client/region/version, instrument setup and user evidence tied to the
   exact pasted MML are required for In-game Accepted.

Projects persist in IndexedDB after transaction completion. Storage failures remain
visible and portable export stays available. Concurrent tabs use optimistic save
tokens to avoid silently overwriting each other. Export backups regularly: Safari
can evict local data. Backup imports preserve old reviews as history and require
new review; they cannot import a ready-made acceptance claim.

Files and review actions are serialized in FIFO order, including during boot.
Pending evidence stays bound to its project and revision; choosing a different
project cannot transfer queued reviews or source files to it.

Any source/settings/delivery revision clears its previous reviews and acceptance.
Changing the pinned Canonical identity also invalidates saved reviews, including
when switching between local projects. Imported IR is reconstructed using the
existing Canonical constructors; embedded PASS/audio/acceptance metadata is not
readiness evidence. Imported accepted arbitration decisions need fresh review.

## Local / cloud boundary

| Capability | Execution / data movement |
| --- | --- |
| MusicXML, MML and Canonical IR intake | Local module Web Worker; original bytes never uploaded |
| Raw MIDI `.mid` / `.midi` intake | Local browser + Worker path; original MIDI bytes remain local, are content-hashed for source identity, and feed existing G11-A/B/C modules |
| Version Drift, Lead, Core3, Harmony, Readiness | Existing Studio modules in the local Worker |
| Project/source files and review records | IndexedDB; user-initiated file exports |
| M4A/FLAC/WAV selection | Local only; selection does not start a request |
| Audio Alignment | Explicit button sends the selected audio and a minimal derived event/tempo projection |
| Audio report | Evidence only, with audio SHA-256 and exact derived-project SHA-256 binding; never edits symbolic events |

There is no default cloud endpoint or telemetry. Optional audio setup requires an
operator-provided HTTPS endpoint and session-only token. The token is never saved
in a project. Requests omit cookies, forbid redirects and are not cached. Selecting
audio invalidates older applicability/review state. Cancellation stops browser
upload/waiting; an already-running remote alignment may continue until its host's
job timeout. No automatic retry uploads occur.

Raw MIDI does not reuse the audio upload path. The original MIDI bytes stay inside
the browser/Worker pipeline and are not sent to the optional alignment endpoint.
The Raw MIDI source id is derived from the full SHA-256 of the exact bytes; the
separate request token exists only to suppress stale in-flight results and never
becomes Canonical provenance.

The optional `studio/audio-worker/mml_audio_worker/http_server.py` adapter wraps
the existing audio implementation. It accepts only `POST /align`, a configured
exact HTTPS Origin and bearer token, with 4 MiB project / 64 MiB audio limits.
Payload framing is UTF-8 minimal project JSON followed by audio bytes;
`X-Project-Bytes` identifies the boundary and `X-Audio-Format` is `m4a|flac|wav`.
The adapter attaches `symbolic.web_project_sha256` to its report and removes temp
files on completion/failure. Existing CLI reports without this binding remain
unverified in Web v1. An operator must supply HTTPS termination, private token
distribution, workload timeouts and resource limits before exposing this optional
service. The repository supplies no deployment credentials or production wiring.

## Raw MIDI path and scope

The local Raw MIDI path on current `main` is:

```text
.mid / .midi file
  -> browser File / ArrayBuffer
  -> local Web Worker
  -> existing Studio MIDI ingest (G11-A source project)
  -> G11-B source-aware monophonic voice decomposition
  -> G11-C traceable six-role candidate suggestion
  -> Web report / persistence
```

The source project remains the preserved evidence layer. G11-B is lossless
source decomposition rather than role assignment. G11-C is a candidate-suggestion
layer rather than an accepted arrangement. Derived G11-B/G11-C material is
re-derived from the stored source instead of being persisted as new source truth.
Percussion/unsupported material stays separate rather than being silently emitted
as pitched notes.

G11-D applies arrangement decisions a reviewer has explicitly accepted, producing
a derived Candidate Canonical project and a content-addressed revision record.
Decision records are persisted; the applied candidate is not. It is re-derived
from the re-validated source project on every analysis, and every decision is
re-checked against the baseline, source, revision and Canonical identity it was
accepted under, so a record that outlives its inputs is refused rather than
replayed. Records chain: revision N is applied onto the revision N−1 the same
analysis just re-derived, never onto a stored or imported parent. Each record is
tamper-evident (a digest over the whole record) but not authenticated: nothing
proves who accepted it, and the code says so. A suggestion never becomes an
acceptance, and an accepted application never moves a workspace to `VALIDATED`.
Lead evidence recorded through the two pre-G11-D forms is built behind the
Worker; a form never supplies a source identity. Demotion evidence is keyed to
the exact baseline Melody event and bound to it by the Lead Demotion Gate itself.
Promotion evidence stores the candidate Melody event id together with the
baseline origin the reversible derived-duplicate chain resolves to
(`baselineOriginEvent`, shared with the Agent plane rather than copied), and is
graded by the shared Lead Promotion Gate against that origin — so a derived
duplicate's own id can never become source evidence. Re-recording replaces the
record for that candidate event, and a record is read only while it names the
current revision, so a later revision asks for the evidence again.

This path ends before G12, Final MML emission, Mobile audibility/octave
adaptation, instrument assignment, volume mapping, drum-face mapping or in-game
acceptance. A Raw MIDI file therefore cannot make a song `VALIDATED` or
`IN_GAME_ACCEPTED` by intake alone, and neither can an accepted arrangement.

Implementation guards currently refuse Raw MIDI input over 4 MiB or a decoded
Canonical event set over 30,000 events. Those are implementation guards, not
Canonical game rules. Large portable backups can also hit the existing 16 MiB
restore ceiling. See the
[Raw MIDI integration record](../../docs/STUDIO_WEB_RAW_MIDI.md) for implementation
details and scope.

## Build and CI (developer / operator only)

From a Git checkout with refreshed `origin/main` and the complete rules snapshot:

```sh
npm install --ignore-scripts --package-lock=false
npm run canonical:bootstrap -- --summary
npm test
npm run build:studio-web
npm run preview:studio-web
```

The static artifact is `studio/web-build/`, separate from the legacy `dist/`
production bundle. Serve it over HTTPS (localhost is sufficient for development).
Deploy the whole directory atomically at a path with a trailing slash, use correct
JavaScript MIME types and serve `sw.js` without a long HTTP cache lifetime. No SPA
fallback, server runtime, CDN or external script dependency is required.

The build invokes the existing Git Bootstrap, copies the unchanged analysis
modules and the installed fast-xml-parser browser distribution, and replaces only
the Node/Git environment loader. It packages all six Manifest-indexed documents,
their authority labels, rules snapshot, Manifest commit, Published main HEAD,
working HEAD and actual PR source HEAD when CI supplies it. Web initialization
checks package integrity and runtime identity before analyzing files. A missing
or inconsistent snapshot is `CANONICAL_NOT_LOADED`, never a legacy fallback.
Offline status means a verified **build-time** Published snapshot; it does not
claim a live check of the newest main.

The service worker precaches the complete native-module graph under a build hash.
It does not skip waiting while an existing Studio session is open, preventing a
mixed-version review. Source uploads, credentials and audio POSTs are never cached.

Browser regressions are committed under `studio/browser-tests/run.mjs`:

```sh
npx playwright install --with-deps chromium webkit
npm run build:studio-web
npm run test:studio-web
```

CI covers iPhone-size WebKit, iPad-size WebKit and desktop Chromium, with screenshots
and JSON results. It exercises text/Files intake, Raw MIDI intake and presentation,
review/state transitions, exact copy payloads, local persistence, unsupported
handling, no implicit upload, viewport overflow and offline restart. OS clipboard
permission, actual Safari Files provider behavior, Home Screen lifecycle and
Mabinogi acceptance still require real devices.

## Explicit v1 limits

The **Mobile 適配 v1** panel now previews and applies evidence-backed uniform
role octave shifts and volume offsets/defaults, then re-runs analysis. It retains
the original candidate for rollback and clears previous reviews and delivery.
It operates on the candidate asset's assigned roles, not directly on the Raw MIDI
suggestion report. See [Mobile Adaptation v1](../../docs/MOBILE_ADAPTATION_V1.md)
for profiles, persistence, scope and remaining work.

- Uncompressed score-partwise MusicXML, complete six-slot MML, Canonical IR @2 and
  Raw MIDI `.mid` / `.midi` intake are supported. Compressed MXL and unrecognized
  IR schemas remain unsupported in this Web intake.
- Raw MIDI support stops at preserved source evidence, G11-B decomposition,
  G11-C candidate suggestions, G11-D application of explicitly accepted
  arrangement decisions, and existing readiness information. It does not
  automatically perform Final six-role reduction, G12, Final MML emission,
  Mobile adaptation, instrument/octave assignment or drum-face mapping. No
  arrangement decision is ever accepted on the reviewer's behalf, and this
  release ships no Arrangement Editor UI: decisions are recorded through the
  model API, not by dragging notes.
- Existing MusicXML limitations (repeat/navigation expansion, grace realization,
  transposing parts, microtones, unpitched mapping) stay visible and block promotion.
- No automatic MusicXML/IR arrangement, role assignment or six-track reduction
  is added. Register/volume rewriting is limited to the cited Mobile profile.
  A supplied delivery MML must match candidate events and
  meter before copy is enabled. Caution-length/Nxx opt-ins are not exposed in v1;
  no implicit opt-in is granted. Named notes whose current mapping lies above
  pitch 107 remain source evidence but cannot pass Final delivery while unverified.
- The built-in Core3 continuity report is only a source-relative diagnostic.
  Musical Core3/Lead/Full6 completeness requires separate explicit review.
- This v1 does not implement a verification player. If one was used, the actual
  readback gate remains PENDING. Only explicitly declaring that no preview/player
  was used, with the Tempo review, makes that conditional gate N/A.
- Named historical-song regressions without reproducible fixtures remain
  `FIXTURE_PENDING`. Synthetic tests never certify those songs.

The [final pre-PR audit](../../docs/STUDIO_WEB_V1_FINAL_AUDIT.md) remains a dated
historical implementation record. Current Raw MIDI behavior is documented in
[Studio Web Raw MIDI](../../docs/STUDIO_WEB_RAW_MIDI.md), and the current repository
status/readiness baseline is recorded in
[Studio Status / Readiness Snapshot — 2026-09-15](../../docs/STUDIO_STATUS_READINESS_2026-09-15.md).
