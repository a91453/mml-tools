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

The **Decision Composer** (section 04, under the review roll) records these
decisions from the page. You gather events on the roll (one by one, or a whole
G11-C voice), choose the move (assign, move, omit, duplicate with evidence, or
keep), and write the reason. 「預覽」 is a dry run in the Worker: it fills
the acceptance bindings itself (the page never supplies them, nor an id),
re-derives the whole chain with the new record appended, writes nothing, and
can show the result on the roll, labelled 「決策預覽（尚未接受）」.
「接受此決策」 records only the record whose digest was previewed, and only a
PASS preview; any edit drops the preview. A move's source role comes from the
verified head, never from the page. Moves into or out of Melody still need
Lead evidence the composer does not collect, so they preview as not PASS. The
roll can then show the accepted head, labelled as such; gates and reviews still
read the analysed candidate. The composer is closed when a Final reduction or
Mobile adaptation is applied, or when the recorded chain does not fully apply.
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

These three surfaces were ported from the repository owner's earlier frontend editor
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
    the two together on thousands of generated inputs. The earlier frontend dialect extras
    (`h`, `p`, `@n`, `[ ]`, comments) and whitespace inside a role are shown as
    errors, because Studio rejects them.
  - **Parser findings.** Errors and cautions from the Worker's validation mark
    their tokens.
  - **Per-role counts.** Characters beyond 2,400 are banded, never removed. The
    paste box shows per-role counts with the P1 disclaimer.
- **Timbre preview** (section 06; `preview/player.mjs`, `preview/schedule.mjs`,
  `preview/soundbank-store.mjs`, `preview/default-bank.mjs`).
  - **What it plays.** The current delivery MML (generated, pasted, or a
    candidate that is itself valid MML), played through SpessaSynth with a
    DLS/SF2/SF3 bank you pick on your device, or, until you pick one, the
    free default bank.
  - **Where your bank lives.** In its own IndexedDB database on that device. It
    is never uploaded, never in a project backup, and never in the build, and
    it always takes precedence over the default bank.
  - **A damaged bank.** Before a picked bank is kept, a Worker parses it with
    the vendored spessasynth_core (`preview/bank-check.mjs`), the loader the
    synth worklet runs on it. One that does not parse, such as a file cut
    short behind an intact header, is refused with 「音色庫無法解析，沒有儲存」
    and nothing is stored; the kept bank stays as it was. The check has a
    time limit, 5 s plus 1 s for every 2 MiB (37 s at the 64 MiB cap),
    counted from the moment the Worker has loaded its parser: a damaged
    bank can instead keep the parser allocating until the tab crashes, so a
    check still running then is stopped and the bank refused with
    「音色庫在 N 秒內沒有完成檢查，沒有儲存」, which does not call it
    damaged. Loading the parser (about 740 KB, downloaded on a first visit
    before the Service Worker has cached it) has a limit of its own, 30 s;
    a Worker that has not loaded by then is stopped and the bank refused
    with 「檢查音色庫的程式在 30 秒內沒有載入，音色庫沒有檢查，也沒有儲存」.
    The Workshop keeps its picks in the same store, which refuses them the
    same way; it still hands a bank that does not parse to its synth, whose
    parse error is what it shows, but a pick whose check ran out of time, or
    whose checker did not load, is refused in the page language and never
    reaches the synth, which would run the same parse. If the engine
    still cannot load a bank (the worklet reports a parse error, or nothing
    arrives within 60 s), the load stops with 「音色庫無法解析，已停止載入」 or
    the timeout message, the player leaves its loading state, and the next
    play tries again. The Workshop's bank loads stop the same way. Before
    any bank is sent, a new synth must report ready: its processor answers
    once its decoder is set up, and one that fails to start or never does
    would leave the load, and in the Workshop every bank load queued behind
    it, waiting. A processor error, or no answer within 20 s of the audio
    context running (a context still waiting for a user gesture is not
    timed), stops the load with 「音色試聽引擎無法啟動，已停止載入」 or
    「音色試聽引擎在 20 秒內沒有就緒，已停止載入」 (the Workshop says it in
    its page language), and the next load starts a new synth. When the
    bank kept on the device fails to load as the Workshop opens, its log
    says why, as it does for a pick.
  - **The default bank.** A General MIDI subset of FluidR3Mono_GM.sf3 (MIT).
    It is not in this repository and not in the build: the upstream file asks
    not to be redistributed. Nothing is downloaded when the page loads. The
    first time you press play without a bank of your own, the page says
    「第一次使用免費音色：將從 MuseScore 官方來源下載約 14.6 MB，只存在這台裝置」,
    downloads the pinned upstream file from MuseScore's repository with
    progress, and refuses it unless its SHA-256 matches. A Worker trims it
    with the vendored spessasynth_core (`preview/default-bank-trim.mjs`, the
    same operations `scripts/build-default-soundbank.mjs` runs in Node), and
    the subset is refused unless its SHA-256 matches too. Both digests are
    pinned in `preview/default-bank.mjs` and `default-bank/provenance.json`.
    Only the subset (about 1.6 MB) is kept, in the same IndexedDB database as
    your bank, under its digest; later sessions use it offline, and
    「刪除這台裝置上的免費音色」 removes it. If the download fails (offline,
    blocked, altered), playback says so and suggests picking your own bank;
    nothing else changes. Everywhere it is active it is labelled
    「免費通用音色（近似），不是遊戲音色」. Each role can pick one of eleven
    game instrument names mapped to GM (`preview/instruments.mjs`): 魯特琴
    Lute→24, 曼陀林 Mandolin→25, 夏盧莫管 Chalumeau→71, 木琴 Xylophone→13,
    長笛 Flute→73, 小提琴 Violin→40, 鋼琴 Piano→0, 豎琴 Harp→46, 音樂盒 Music
    Box→10 (0-based programs), 大鼓 BassDrum→drum-kit note 35 (36 also kept),
    鈸 Cymbals→drum-kit note 49 (57 also kept). With your own bank the picker
    lists that bank's presets. Per-role instruments or a drum kit make a
    playback's capture incomplete, so Gate 6 readback still needs one program
    on every role.
  - **How the engine is loaded.** Vendored at build time from the pinned npm
    packages (Apache-2.0; license text in the header of `vendor/spessasynth/lib.js`) and only when you press
    play. The CSP adds `'wasm-unsafe-eval'` for its bundled WebAssembly decoder;
    no JavaScript eval is allowed.
  - **Scheduling.** Beats are converted to seconds through the exact tempo map,
    and only the resulting times become floats. Volume and channel mapping
    follow the owner's earlier frontend player. Per-role mute and live instrument
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
    expected events share no code with the preview scheduler
    (`preview/schedule.mjs`): the readback integrates the tempo map with its
    own exact rationals, restates the role → channel rule (the six roles on the
    melodic GM channels in order, never channel 9), and takes volume →
    velocity from the backend renderer's table
    (`studio/backend/audio/instruments.mjs`). A fault in the scheduler's
    timing, channels or velocities is therefore a mismatch. A stored verdict
    is never read.
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

## Listening sessions (試聽工作階段)

Studio delivers a machine-checked Final first and flags what still needs a
person's ear. A listening session is where the owner hears exactly those
places, writes down what they heard and hands it to the next revision. It is a
listening aid: it passes no gate and records no review, readback or acceptance.

- **Opening one.** 「送到試聽」 next to the Final MML (section 06), the complete
  MML@ (section 07) and any MML source card opens a new session for that exact
  string, or open a listen link: `<studio-web-origin>/#listen=<payload>`
  (`?listen=` also works; see `listen-link.mjs`). A session is stored in its own
  IndexedDB database (`listen-store.mjs`), listed under 「試聽工作階段」 in the
  sidebar and deletable there. Opening a link never creates, opens or
  overwrites a project, never plays by itself, and removes the payload from
  the address bar as soon as it is read.
- **Listen links.** `payload` is base64url (no padding) of deflate-raw of the
  UTF-8 JSON `mml-studio/listen-link@1` document: `mml` (required), `title`,
  `meter_text`, `start` (`{bar}` or `{beat}`), up to 500 `markers` (`beat`,
  `end_beat`, `role`, `kind` = `provisional-release | lead-unverified | pending
  | changed | note`, `label`), `compare_mml` and display-only `source`. The
  decoded JSON is capped at 256 KiB (reading stops at the cap), each MML at
  40,000 characters; an unknown schema or any invalid field refuses the whole
  link, unknown keys are dropped, and every string is shown as escaped text.
  Golden vectors shared with the MCP side are in
  `studio/tests/fixtures/listen-link-vectors.json`.
- **Playing (L1).** Play from a bar, a time (m:ss) or a marker; a marker, a
  note or a changed bar starts whole bars earlier (1 by default, 0/1/2/4
  selectable). The current bar, beat and time are shown while playing. Stop
  returns to the start point and 「重播」 plays the same range again. Every
  role can be muted or soloed. Playback reuses the section 06 preview engine,
  bank and scheduler; a ranged playback queues nothing past its end.
- **Markers.** From the link, and for a verified local delivery from its
  analysis: the unresolved-evidence ledger of the machine-delivery projection
  (whole-song entries), Lead evidence still pending at its events, and
  unresolved cross-source harmony. Clicking one plays it and highlights the
  region on the session's roll.
- **Changed bars (L2).** Against `compare_mml`, or another MML the project sent
  along or another session: an exact event-level diff per role (pitch, onset,
  duration, volume) plus tempo changes, read by the repository MML parser in
  the Worker (`listen-model.mjs`, `listen-timeline.mjs`). Bars come from the
  meter text; without one they are 4/4 and the session says 「4/4 假設」.
  「只播放變更小節」 plays each changed region in order with its lead-in; the
  A/B switch plays the same bars in the previous version, timed by its own
  tempo map.
- **Notes (L3).** A note has a position (the playing position snapped to its
  beat, a bar, or a note picked on the roll), an optional role, a kind
  (too-loud, wrong-note, timing, balance, other) and text. Notes are kept in
  the session and, for a session opened from a project, on that project as
  `listeningNotes` keyed by the MML's SHA-256 (no revision change; project
  backups carry them). They reappear as markers when the session is reopened.
  「複製給 AI」 copies plain text: the title, the MML's SHA-256, the meter, then
  one line per note (`bar | beat-in-bar | quarter-beat position | time | role
  | kind | text`). 「複製試聽連結」 makes a listen link for the session.

## Workshop (工作坊) — the MML editor, outside the verified pipeline

`studio/web/workshop/index.html` (sidebar: 「工作坊 · MML 編輯器」) is the owner's
earlier MML editor, ported into Studio Web (owner-authorized port). Studio is its
upgraded version: the editor works as before, and Studio adds the checks.

- **What it does.** Up to 15 tracks; text editing with syntax colour; a piano roll
  (select, move, resize, draw, delete, marquee, touch nudge pad); undo/redo; per-track
  instruments; a local song library (IndexedDB `studio-workshop-library`) and autosave
  (`studio-workshop/…` keys); MIDI, MusicXML, MML and 3MLE `.mml` / `.mmi` import and
  export, including the bzip2 extension block; playback; offline WAV export; the piano
  waterfall video (WebCodecs H.264 + AAC, MP4). 繁中／English／日本語／한국어 and a
  dark/light theme applied before first paint (`boot.js`).
- **Not evidence.** Everything edited there is labelled
  「工作坊編輯（未經 Studio 驗證）」. It never marks anything VALIDATED or accepted.
- **「在工作坊開啟（副本）」 / 「從 Studio 開啟」.** Opens a *copy* of a project's
  Final/delivery MML, or of an MML candidate, baseline or previous version. The project
  is read from Studio's own IndexedDB and is not changed.
- **「送回 Studio 驗證」.** Sends the six game tracks back
  (`workshop-link.mjs`, one localStorage record, read once). Studio shows it for
  confirmation and imports it through its ordinary intake as a derived candidate:
  technical validation runs again and every review restarts.
- **Nxx.** The Workshop reads `nN` as MIDI N+12 and Studio reads it as MIDI N (LG-1,
  still unverified in game), so the hand-off rewrites `n` values to keep the pitch.
  Workshop-only spellings (`h`, `p`, `#`, `@n`) are rewritten for Studio.
- **Sound.** Studio's vendored SpessaSynth and the bank you keep in Studio's local bank
  store (shared with the timbre preview; never uploaded, never built in). The eleven
  Mabinogi Mobile instruments map to General MIDI: Lute 24, Mandolin 25, Chalumeau 71,
  Xylophone 13, Flute 73, Violin 40, Piano 0, Harp 46, Music Box 10; BassDrum and
  Cymbals play the percussion kit on keys 35/36 and 49/57 (below o4c the first).
  A loaded bank's own presets stay selectable. It is a listening approximation.
- **Audio export.** WAV only (16-bit, gain only ever lowered). MP3 is not offered:
  the LGPL-3.0 encoder the earlier editor used is not shipped with this MIT-exported
  tree.
- **Loading.** The page loads only its own modules; the WAV and video exporters and
  the render worker load on first use. No fonts, icon font, analytics or network calls.
- **Tests.** `studio/tests/workshop-*.test.mjs` and `studio/browser-tests/workshop.mjs`.

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

- Score-partwise MusicXML (uncompressed, or compressed `.mxl` read through the
  same bounded container reader the service uses), complete six-slot MML,
  Canonical IR @2 and Raw MIDI `.mid` / `.midi` intake are supported. Repeats,
  voltas and D.C./D.S./Coda/Fine are expanded into playback order and a pickup
  is placed as described in `studio/backend/score/README.md`. An `.mxl` is
  stored in the workspace as the MusicXML it was read as, with the archive entry
  and its digest recorded; unrecognized IR schemas remain unsupported.
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

## Credits

- Timbre preview engine: SpessaSynth (`spessasynth_lib`, `spessasynth_core`),
  Apache License 2.0, vendored at build time.
- Default preview bank: a subset of FluidR3Mono_GM.sf3 2.312 — Fluid (R3)
  SoundFont by Frank Wen, mono version by Michael Cowgill, with Temple Blocks
  by Ethan Winer and Drumline Percussion by Michael Schorsch — MIT License, as
  distributed with MuseScore 2.3.2. Not redistributed: each browser downloads
  it from that source at first use. Licence text and acknowledgements:
  [`default-bank/LICENSE.md`](default-bank/LICENSE.md).
