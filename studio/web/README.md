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

The sidebar says whether the open project is saved, how much of the browser's
quota Studio uses, and whether the browser has agreed to keep the data.
「保留離線資料」 asks for persistent storage only when pressed (Safari may
ignore it). 「匯出全部專案（ZIP）」 writes every project as its usual backup
JSON into one ZIP; choosing a ZIP under 「匯入專案備份」 imports each entry
as a new project through the same restore path as a single backup. The ZIP
reader verifies each entry's CRC-32 and limits entry count and size.

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

This path ends before the G12 Final Six-Role Reduction, Final MML emission,
Mobile audibility/octave adaptation, instrument assignment, volume mapping,
drum-face mapping or in-game acceptance. Reduction and adaptation are two
further, separately reviewed stages in this workspace, in that order. A Raw MIDI file therefore cannot make a song `VALIDATED` or
`IN_GAME_ACCEPTED` by intake alone, and neither can an accepted arrangement.

Implementation guards currently refuse Raw MIDI input over 4 MiB or a decoded
Canonical event set over 30,000 events. Those are implementation guards, not
Canonical game rules. Large portable backups can also hit the existing 16 MiB
restore ceiling. See the
[Raw MIDI integration record](../../docs/STUDIO_WEB_RAW_MIDI.md) for implementation
details and scope.

## Review roll, MML highlighting and release updates

These three surfaces were ported from the repository owner's MML 工房 editor
(owner authorization 2026-09-23) and merged with Studio's rules. The owner's
code supplied the viewport, rendering and gesture handling. Studio supplied
exact timing, event identity and the evidence boundaries. See
[the fusion analysis](../../docs/FRONTEND_FUSION_ANALYSIS_2026-09-23.md) §11–§12.

- **Six-role review roll** (section 04, `review-roll.mjs`, `roll-geometry.mjs`,
  `roll-model.mjs`).
  - **Layout.** A read-only, virtualised canvas of the analysed candidate.
    Core3 is solid, Chord3–Chord5 are outlined, and unassigned pitched
    material is hatched.
  - **Review signals.** Cross-source harmony conflicts link to their existing
    arbitration form. Same-pitch overlaps and low-register m2/M7 crowding come
    from the same `reviewSong()` 15-pair review the technical validator uses.
  - **Zoom and touch.** Ctrl/⌘+wheel or two-finger pinch zooms one axis at a
    time. One finger pans, and a tap selects the nearest note.
  - **Read-only.** The roll never edits, accepts or reviews anything. Selecting
    a note reports its event ID, role, pitch and exact start/end beats.
  - **Exact timing.** Beats stay exact rationals until the pixel step. Bar
    lines come from the source meter map, and without one only beat lines are
    drawn; 4/4 is never assumed. Pitches are never folded.
  - **Not evidence.** It is a visualisation, not source, listening or in-game
    evidence.
- **MML highlighting** (`mml-highlight.mjs`).
  - **Where.** Final MML, per-role and section 07 text boxes, plus the paste
    box as you type.
  - **How it works.** The textarea keeps the exact string for selection and
    copy, and a layer painted behind it carries the colour.
  - **Same rules as the parser.** Tokens follow `parser.mjs`, and a test holds
    the two together on thousands of generated inputs. MML 工房 dialect extras
    (`h`, `p`, `@n`, `[ ]`, comments) and whitespace inside a role are shown as
    errors, because Studio rejects them.
  - **Parser findings.** Errors and cautions from the Worker's validation mark
    their tokens.
  - **Per-role counts.** Characters beyond 2,400 are banded, never removed. The
    paste box shows per-role counts with the P1 disclaimer.
- **Timbre preview** (section 06; `preview/player.mjs`, `preview/schedule.mjs`,
  `preview/soundbank-store.mjs`).
  - **What it plays.** The current delivery MML (generated, pasted, or a
    candidate that is itself valid MML), played through SpessaSynth with a
    DLS/SF2/SF3 bank you pick on your device.
  - **Where the bank lives.** In its own IndexedDB database on that device. It
    is never uploaded, never in a project backup, and never in the build.
  - **How the engine is loaded.** Vendored at build time from the pinned npm
    packages (Apache-2.0; license text in the header of `vendor/spessasynth/lib.js`) and only when you press
    play. The CSP adds `'wasm-unsafe-eval'` for its bundled WebAssembly decoder;
    no JavaScript eval is allowed.
  - **Scheduling.** Beats are converted to seconds through the exact tempo map,
    and only the resulting times become floats. Volume and channel mapping
    follow the owner's MML 工房 player. Per-role mute and live instrument
    switching are supported.
  - **What it is not.** It is a listening aid, not in-game acceptance.
    Playing it passes no gate.
- **Player readback** (Gate 6; `preview/readback.mjs`).
  - **What is captured.** A playback that starts at the beginning records every
    note and program event the SpessaSynth worklet reports as processed, with
    the worklet's own audio clock. A seek, a stop, a muted role or an
    instrument switch makes the capture incomplete, and an incomplete capture
    cannot be recorded.
  - **Recording.** Only on 「記錄為播放器實際回讀」, only when the project
    declares that a verification player was used, and only for the project,
    revision and exact delivery string that were playing. It is stored with
    the bank name and SHA-256, the program, the engine versions and
    `scope: processed_engine_events_not_hardware_audio`,
    `gameTimbreEquivalent: false`.
  - **Verdict.** Every analysis parses the exact delivery string again and
    compares, per channel, the order, pitch and velocity of every note on and
    off exactly, and the timing within 25 ms of the exact tempo-map time. The
    expected events are derived without the preview scheduler, so a scheduling
    fault is a mismatch. A stored verdict is never read.
  - **Gate.** PASS needs a matching readback and a current Tempo review. The
    N/A path is unchanged (no player declared, Tempo reviewed). Anything else,
    including a mismatch, is PENDING. A new revision, a new delivery string or
    an import drops the readback (an import keeps it as history only).
  - **What it is not.** It is not a hardware recording, not a proof that
    anyone listened, not the game's timbre and not in-game acceptance.
  - **Order of work.** Gate 6 blocks Final generation, so with a player
    declared the readback is of a pasted delivery, or of a candidate that is
    itself valid MML.
- **Release updates** (`pwa-update.mjs`, `sw.js`).
  - **Download.** Install fetches bypass the HTTP cache, so a new release can
    never be stored with an older module.
  - **Detection.** A waiting or still-installing release is detected even if
    the browser found it before the page listened. The page checks again on
    focus and when it becomes visible, at most once an hour.
  - **Apply.** 「套用新版」 appears only when a release is waiting. It runs
    after queued actions and refuses an unsaved project.
  - **Other tabs.** A tab that another tab updated is marked stale and must
    reload before doing more work, so old and new modules never mix.
- **Project library v2** (`storage.mjs`, `backup-zip.mjs`).
  - **List records.** The database keeps a small list record per project
    (ID, title, save time, revision) next to the full workspace, written in
    the same transaction. The project picker reads only those records; a
    project is loaded in full when opened.
  - **Upgrade.** Opening a v1 database derives the list records from the
    stored workspaces. The workspaces themselves are not rewritten.
- **In-game probe kit** (section 07; `engine-probe.mjs`,
  `engine-probe-store.mjs`).
  - **What it is.** Fixed test strings for open engine questions (Nxx
    octave, tie/length order) that you paste into the game, with the outcomes
    you can observe.
  - **What a record is.** Class E evidence for the exact client, version and
    instrument you name, bound to the SHA-256 of the pasted string. It is kept
    on this device, outside project backups, and exported explicitly as JSON.
  - **What it is not.** It never changes a Canonical rule. Applying it goes
    through the published Canonical process.

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
suggestion report. An event whose role differs from its Source-Faithful origin's
in a way that involves Melody carries Lead evidence the existing re-review binds
to its source pitch, timing and volume, so v1 refuses to adapt it rather than
produce a gate no review could answer. See
[Mobile Adaptation v1](../../docs/MOBILE_ADAPTATION_V1.md) for profiles,
persistence, scope and remaining work.

- Uncompressed score-partwise MusicXML, complete six-slot MML, Canonical IR @2 and
  Raw MIDI `.mid` / `.midi` intake are supported. Compressed MXL and unrecognized
  IR schemas remain unsupported in this Web intake.
- Raw MIDI support stops at preserved source evidence, G11-B decomposition,
  G11-C candidate suggestions, G11-D application of explicitly accepted
  arrangement decisions, and existing readiness information. It does not
  automatically perform the G12 Final Six-Role Reduction, Final MML emission,
  Mobile adaptation, instrument/octave assignment or drum-face mapping. Each is
  an explicit, separately reviewed step. No
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
- The verification player is the section 06 preview. If one was used, the
  readback gate stays PENDING until a complete playback of the exact delivery
  string is recorded and matches, with the Tempo review current. Declaring
  that no preview/player was used, with the Tempo review, still makes that
  conditional gate N/A.
- Named historical-song regressions without reproducible fixtures remain
  `FIXTURE_PENDING`. Synthetic tests never certify those songs.

The [final pre-PR audit](../../docs/STUDIO_WEB_V1_FINAL_AUDIT.md) remains a dated
historical implementation record. Current Raw MIDI behavior is documented in
[Studio Web Raw MIDI](../../docs/STUDIO_WEB_RAW_MIDI.md), and the current repository
status/readiness baseline is recorded in
[Studio Status / Readiness Snapshot — 2026-09-15](../../docs/STUDIO_STATUS_READINESS_2026-09-15.md).
