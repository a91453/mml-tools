# Mabinogi Mobile MML Studio

Studio is the source-aware orchestration layer built beside the existing MML Workbench. Its purpose is to reduce repetitive verification work while keeping every musical decision traceable to evidence.

## Rule authority

Start only at [docs/CANONICAL_MANIFEST.md](../docs/CANONICAL_MANIFEST.md), then
load its pinned Published Canonical human-readable rules. This README and
`studio/backend/rules/index.mjs` describe/implement the system; neither defines
rules. The authority map is derived from the Manifest, with inventory and
supporting evidence separate from rule sources.

After refreshing `origin/main`, run `npm run canonical:bootstrap` from the
repository root to read the Manifest, documents and Git provenance.
`npm run canonical:bootstrap -- --summary` checks identity without displaying
the document text. The loader performs no network fetch and requires the
published main ref and snapshot history. Studio's contract/parser imports fail
with `CANONICAL_NOT_LOADED` if loading fails; they never substitute a local Skill,
standalone Master, an unmerged PR Manifest, or the legacy parser as rule authority.
An archive without Git provenance is insufficient for this Bootstrap.

## Current layout

```text
studio/
  backend/
    bootstrap/      Manifest discovery and pinned published-document loading
    rules/          executable contract implementing Canonical docs
    canonical/      source-traceable Canonical Music IR
    source/         source adapters including Standard MIDI File intake
    mml/            ingest parser, Final validator, source normalization
    score/          MusicXML ingestion and source completeness checks
    compare/        deterministic version/source drift reports
    arrangement/    G11-B voice decomposition and G11-C role candidates
    arbitration/    Core3, Lead Demotion and cross-source harmony gates
    reduction/      G12 Final Six-Role Reduction and its accounting ledger
    adaptation/     Mobile Adaptation v1 register and volume mapping
    final/           per-song readiness evaluation
    application/     the Application Service: one orchestration boundary for
                     the HTTP and MCP adapters, including the One-Click
                     Orchestrator run (run-service.mjs)
    audio/           Node audio-evidence bridge
  audio-worker/      Python/FFmpeg original-audio alignment
  web/               local-first iPhone/iPad UI and PWA sources
  browser-tests/     WebKit and Chromium user-flow regressions
  tests/             Studio regression tests
```

## Implemented pipeline

The following are implemented and covered by the combined legacy + Studio CI suite:

- current MML ingest and Final validation split;
- plain 1/64 support and 1–64 caution handling;
- Nxx ingest preservation with opt-in/evidence Final policy;
- Canonical Music IR with note/rest/Tempo/meter provenance;
- score-partwise MusicXML ingestion;
- fail-closed handling of unsupported MusicXML constructs;
- Current/Historical MML → Canonical evidence normalization;
- source/previous/candidate version-drift reporting;
- Source-Faithful Baseline with runtime event diff;
- source-relative Core3 Continuity Gate;
- evidence-first Lead Demotion Gate;
- cross-source same-pitch / m2 / M7 / m9 harmony arbitration;
- original-audio alignment worker and Node evidence bridge;
- per-song Project Readiness;
- evidence-backed Mobile Adaptation v1: uniform role octave shifts, relative
  volume offsets and explicit defaults, with preview/apply/review and rollback,
  refusing any event a Lead evidence record still binds;
- G11-A Standard MIDI File intake into source-faithful Canonical evidence;
- G11-B lossless, source-aware monophonic voice decomposition;
- G11-C traceable six-role candidate suggestions with explicit pending/unassigned material;
- local Studio Web Raw MIDI `.mid` / `.midi` intake, persistence, re-ingest and presentation;
- content-derived Raw MIDI source identity using the full SHA-256 of the exact source bytes;
- WebKit/Chromium regression coverage for the local Web path, including Raw MIDI.

The implemented pipeline above has no known module-level blocker that prevents
continued Studio development on `main`. That does not certify any song and does
not mean the Studio roadmap is complete. In particular, the current Raw MIDI path
ends at preserved source evidence, G11-B decomposition, G11-C candidate suggestions,
G11-D application of explicitly accepted arrangement decisions, and existing
readiness information; the G12 Final Six-Role Reduction, Final MML generation,
Mobile adaptation and target-client acceptance remain separate stages, each of
which has to be run and reviewed on its own.

The separate [Mobile Adaptation v1](../docs/MOBILE_ADAPTATION_V1.md) stage now
implements register and volume transformations for assigned, source-traceable
candidates. It is available through HTTP/MCP and the local Web Worker. It does
not supply an instrument audibility database, drum mapping, performer allocation,
automatic collision repair or instrument assignment, and does not certify Gate 8. Six-role reduction is the separate G12 stage (`docs/G12_FINAL_SIX_ROLE_REDUCTION.md`), which runs before it.

G11-D produces a derived Candidate Canonical project from decisions a reviewer has
explicitly accepted, without modifying the Source-Faithful Baseline. Its `PASS`
means the decisions were applied faithfully, deterministically and traceably; it
certifies no acceptance gate, and the candidate still has to pass the existing
diff, Lead, Core3, harmony, micro-timing and readiness pipeline. `G11-D` is an
implementation stage name used by this repository, not a Published Canonical rule
identifier. See [docs/G11D_DECISION_APPLICATION.md](../docs/G11D_DECISION_APPLICATION.md).

Every song still needs its own source, baseline, technical, Core3, Lead, harmony,
version, audio, player/readback, Mobile-adaptation and in-game evidence as applicable.
A repository capability cannot pass a song gate automatically.

MusicXML ingestion being implemented does not mean every file is complete. Repeat/navigation flow, grace realization, transposing-part concert pitch, microtones and unpitched mapping remain explicit unsupported/PENDING cases when encountered.

## Raw MIDI / G11 staging

The current source-to-candidate chain is intentionally separated:

```text
G11-A  Raw MIDI -> Source-Faithful Canonical evidence
G11-B  source voices -> lossless source-aware candidate lanes
G11-C  evidence + lanes -> traceable six-role candidate suggestions
```

G11-A preserves the source evidence rather than assigning an accepted six-role
arrangement. G11-B preserves every source event while decomposing polyphony into
candidate monophonic lanes. G11-C may suggest roles, but unresolved material stays
PENDING/unassigned and its result is not Final acceptance.

The Studio Web integration exposes this chain locally for `.mid` / `.midi` files.
It does not turn a MIDI source into paste-ready Final MML automatically, does not
perform instrument/octave/volume/drum-face mapping, and does not assert Mobile or
in-game acceptance. See [Studio Web Raw MIDI](../docs/STUDIO_WEB_RAW_MIDI.md) for
the implementation record and [studio/web/README.md](web/README.md) for current
user-facing limits.

## Intended input set

- official/trusted MusicXML or score export;
- trusted/official MIDI when available, including direct local `.mid` / `.midi` intake;
- third-party MuseScore/MIDI export as supporting evidence when independently appropriate;
- current six-track MML;
- historical MML versions;
- original M4A/FLAC/WAV for audio evidence.

Input support does not assign evidence authority by file type alone. Source class,
version identity, completeness and allowed claims still follow Published Canonical.

## Intended user-facing result

The phone/iPad UI presents evidence for questions such as:

- Which current notes differ from the trusted symbolic source?
- Which changes are new relative to the last accepted version?
- Did a later candidate drift farther from the source baseline?
- Did a role move create a false Lead gap or damage Core3?
- Are Chord3–Chord5 additions colliding with Core3?
- Which conflicts have explicit evidence-backed arbitration?
- Where does the original recording disagree in timing/structure/foreground role?
- What source voices and candidate lanes were recovered from a Raw MIDI file?
- Which G11-C role suggestions are supported, competing, pending or left unassigned?
- Does the final MML still pass the current Mobile technical policy?

The local-first UI/PWA is implemented under `studio/web/`; see its
[usage, local/cloud boundary and v1 limitations](web/README.md).
Build it separately with `npm run build:studio-web`. Studio has not replaced the
current production Railway/MCP route, and source/docs changes on `main` do not by
themselves perform a production cutover or deployment.

Use the Manifest for current policy discovery. `docs/RULES_AUDIT_2026-09-13.md`,
`docs/STUDIO_MIGRATION.md`, and `docs/RELEASE_READINESS_2026-09-13.md` are dated
historical/status records, not alternate rule-loading entry points. Their
pre-Bootstrap descriptions are retained as history. The newer
`docs/STUDIO_STATUS_READINESS_2026-09-15.md` is also a dated implementation/status
snapshot rather than a rule source. References to a song `candidate` or
`candidateReady` describe musical artifacts/readiness, not a candidate Canonical
rules release.
