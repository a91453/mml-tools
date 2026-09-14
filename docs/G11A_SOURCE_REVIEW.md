# G11-A — Source / Reference Review and MIDI Intake

Status: WORKING NOTE — NOT CANONICAL
Stage: G11-A (Source Intake)

This file is a working record of a reference review and of the G11-A intake
implementation. It is not a Canonical authority. Under
`docs/CANONICAL_MANIFEST.md` the only Canonical rule sources are the four
human-readable documents pinned at `rules_snapshot_sha`; nothing recorded here
adds, amends, or reinterprets them. Where this note describes external tool
behavior, that behavior is an **interoperability reference only** and is
explicitly not a Published Canonical rule.

Canonical release loaded for this stage:

| Field | Value |
| --- | --- |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |

---

## 1. mml.mabi.tw production review — NOT PERFORMED (blocked)

**No file, module, bundle, source map, or network asset belonging to
`mml.mabi.tw` was inspected.** The review could not be started, and nothing in
this repository is derived from that site.

The session's egress policy refuses the host at the proxy's CONNECT stage:

```
mml.mabi.tw:443 — connect_rejected
gateway answered 403 to CONNECT (policy denial or upstream failure)
```

Confirmed against every access path available to this session:

| Path attempted | Result |
| --- | --- |
| `curl https://mml.mabi.tw/` (and `/index.html`, `/assets/index.js`, `/main.js`, `/sw.js`, `/manifest.json`) | 403 at CONNECT, all paths |
| WebFetch tool | `EGRESS_BLOCKED` |
| `mabi.tw`, `www.mabi.tw` | 403 at CONNECT |
| `web.archive.org` (for an archived copy) | 403 at CONNECT |
| `cdn.jsdelivr.net`, `unpkg.com` (for any CDN-hosted bundle) | 403 at CONNECT |

Only `github.com`, `raw.githubusercontent.com`, `api.github.com` and
`registry.npmjs.org` are reachable. The proxy documentation states that a 403
is an organization egress-policy denial and must be reported rather than
routed around, so no workaround was attempted.

**Consequence.** Every item on the requested inspection list — delivered
JavaScript, source maps, network-loaded modules, the MIDI parser, note/event
representation, track/channel handling, program handling, tempo/meter handling,
note-on/note-off matching, sustain/overlap handling, percussion handling, MML
generation, track merge behavior, polyphony extraction, Smart voice split, full
chord / 15-track decomposition, playback architecture, and import/export
formats — requires fetching the site. None of it could be observed.

The requested methodology (`production observed behavior → synthetic fixture →
expected semantics → independent implementation → differential comparison`)
depends on its first step. With no observation, the differential comparison
against `mml.mabi.tw` **does not exist** and is not claimed anywhere in this
work. The fixtures in `studio/tests/midi-intake.test.mjs` are derived from the
Standard MIDI File specification and from this project's own Canonical rules,
never from observed third-party behavior.

**To unblock:** add `mml.mabi.tw` to the environment's network allowlist, then
re-run this review. It is most valuable before G11-B/G11-C, where the deferred
arrangement questions live.

## 2. Open-source dependencies found

**None attributable to `mml.mabi.tw`.** Identifying a site's dependencies
requires reading its delivered bundles, which was not possible. Any claim that
this site uses a given library would be a guess, so none is made.

For context only, a public survey of Mabinogi MML/MIDI projects reachable on
GitHub. **None of these is a confirmed dependency of `mml.mabi.tw`, none was
consulted while implementing G11-A, and no code from any of them is present in
this repository.** All convert in the opposite direction to G11-A.

| Repository | License | Language | Direction | Relevance to G11-A |
| --- | --- | --- | --- | --- |
| [logue/PSGConverter](https://github.com/logue/PSGConverter) | GPL-2.0 (README notes newer versions relicensed MIT) | PHP / JS | MML → MIDI | None — opposite direction; upstream describes it as no longer usable in browsers |
| [rajephon/YKSConverter](https://github.com/rajephon/YKSConverter) | BSD-2-Clause | C++ / Rust | MML → MIDI | None — opposite direction; derived from PSGConverter |
| [Veryyes/mml2midi](https://github.com/Veryyes/mml2midi) | not verified | Python | MML → MIDI | None — opposite direction |

G11-A adds **no runtime dependency of any kind**. The intake modules import
only from within this repository.

## 3. License status

- `mml.mabi.tw`: **unknown and undetermined.** The site was unreachable, so no
  license file, header, or footer notice was read. It is treated as
  all-rights-reserved by default.
- Because nothing was read, nothing could be copied. The clean-room requirement
  is satisfied trivially rather than by discipline: there was no source to
  copy from.
- G11-A is implemented from the Standard MIDI File specification and from the
  Canonical rule sources pinned at `rules_snapshot_sha`.
- The surveyed GPL-2.0 / BSD-2-Clause projects above contributed no code, no
  algorithm, and no data. Their licenses impose no obligation on this
  repository.

---

## 4. What G11-A implements

Scope, as instructed: **Raw MIDI → lossless evidence → Canonical IR.** No
arrangement work.

| Module | Role |
| --- | --- |
| `studio/backend/source/midi-file.mjs` | Lossless SMF decoder. Records every chunk and event, interprets none. |
| `studio/backend/source/midi.mjs` | Projects the decoded evidence into Canonical IR with per-event provenance. |
| `studio/backend/source/index.mjs` | Facade plus `MIDI_INGESTION_STATUS`, a factual capability record. |
| `studio/tests/midi-intake.test.mjs` | 21 fixture tests built from raw bytes. |

The existing `readMidi` in `dist/core.js` was examined and deliberately **not**
extended. It requires Type 1, exactly 7 tracks and PPQ timing, and throws on
any meta type it does not know. That is correct for its actual job — verifying
readback of MIDI this project itself wrote — and unusable for third-party
intake. The new decoder sits alongside it; neither was changed.

Why the evidence layer is separate: `SOURCE_POLICY.md` §3 forbids deletion
before arbitration is possible, and `ACCEPTANCE_CRITERIA.md` Gate 2 requires an
event-level baseline rather than a prose inventory. A reader that threw on the
first unknown meta event, or silently skipped a malformed byte, would destroy
the evidence the later gates diff against. So unknown meta types, SysEx,
truncated tracks and malformed control events are all recorded **as data, with
their raw bytes**, and the caller decides what they mean.

Every Canonical note carries `sourceEventIds` pointing at the exact raw note-on
and note-off indices it came from, so the baseline is diffable at event level
as Gate 2 requires.

## 5. Behaviors reproduced by fixtures

All 21 fixtures are synthetic, byte-level, and reproducible. Sources are the
SMF specification and the Canonical rules — **not** observed `mml.mabi.tw`
behavior, which was unavailable.

| Behavior | Fixture assertion |
| --- | --- |
| Exact rational beats | A 160-tick note at 480 ppq is `1/3`, not `0.3333…` |
| Both endpoints notated, duration derived | `timing.start`/`timing.end` = `source-notated`, `timing.duration` = `source-derived` |
| Note-on velocity 0 is a release | One note, not an attack plus a silent note |
| Running status | Expands to byte-identical events versus the explicit encoding |
| Key restruck before release | FIFO pairing; `0–480` and `240–720`, not LIFO's swapped durations |
| Orphan note-off | Recorded as `ORPHAN_NOTE_OFF`, never dropped |
| Unclosed note-on | Recorded as `UNCLOSED_NOTE_ON`, no invented end |
| Zero-duration note | Refused, not widened to satisfy the IR |
| Percussion (channel 10) | Never becomes a pitched note; timing retained as evidence |
| Unknown meta / SysEx | Survive with raw bytes; do not fail the file |
| Non-UTF-8 text meta | Raw bytes preserved |
| SMPTE division | Refused — absolute time, not musical time |
| Format 2 | Refused — independent sequences, no shared timeline |
| Sustain pedal | Recorded; the written release stands, unextended |
| Missing End of Track | Reported; decoded events kept |
| Truncated track | Everything before the damage kept |
| Velocity | Preserved as evidence; `volume` stays `null` |
| Multi-track identity | Track and channel kept distinct, unmerged |
| Real-file round-trip | MML → MIDI → IR preserves every note, onset and endpoint exactly |
| Determinism | Two ingests of the same bytes are identical |

## 6. Behaviors intentionally implemented differently

Differently from what a typical MIDI importer does. These are decisions, each
traceable to a Canonical rule — not gaps.

| Common importer behavior | G11-A behavior | Reason |
| --- | --- | --- |
| Map velocity 0–127 onto the target volume scale | `volume: null`; velocity kept in metadata | Mobile 0–15 mapping is a Gate 8 adaptation, not an intake fact |
| Extend notes to the sustain-pedal release | Written release stands; pedal recorded separately | Performance interpretation, not something the file states |
| Quantize onsets to a grid | Never | `MASTER_RULES.md` §2 — would erase source-supported timing |
| Emit rests for gaps between notes | Never | A gap is not an asserted notated rest; §7 protects meaningful rests |
| Drop or clamp zero-length notes | Recorded as unsupported | `MOBILE_SYNTAX.md` §4 forbids zero-duration; widening invents data |
| Drop unmatched note-ons/offs silently | Recorded with raw indices | Gate 2 needs the anomaly visible |
| Map GM drum numbers as pitches | Refused; held as evidence | `MASTER_RULES.md` §8 — drum numbers are kit selectors |
| Throw on the first unknown meta event | Record and continue | Evidence preservation over strictness |
| Concatenate Format 2 sequences | Refused | Would assert a relationship the file does not state |
| Convert SMPTE by assuming a tempo | Refused | Absolute time cannot become musical time without an assumption |
| Merge tracks sharing a channel | Never | Merge behavior is G11-B |
| Float seconds/beats | Exact rationals throughout | Project-wide exact-timing requirement |

## 7. Deferred to G11-B / G11-C

Recorded, not implemented. The intake layer produces the baseline these stages
need; none may run before that baseline exists (`MASTER_RULES.md` §3).

**G11-B — arrangement intelligence**

- Smart voice split: separating polyphony inside one track/channel into lines.
  The `RESTRUCK_BEFORE_RELEASE` warning already marks where a single channel
  carries overlapping strikes of one key — the cheapest available signal that a
  track holds more than one line.
- Track/channel merge: which of the decoded tracks become one Mobile role.
  Intake keeps `track:N/channel:M` distinct precisely so merging stays a later,
  reviewable decision.
- Polyphony extraction and role assignment (Lead / Chord1 / Chord2). Governed by
  `MASTER_RULES.md` §4 and `SOURCE_POLICY.md` §4 — a demotion needs positive
  evidence, and `not proven Vocal` is not evidence.
- Velocity → Mobile volume, under Gate 8.
- Sustain-pedal realization, if evidence supports it.
- Percussion mapping to Mobile drum-face positions. Blocked on drum-face
  evidence; `MASTER_RULES.md` §8 requires a safe non-drum version otherwise.
  Every percussion event is already retained with full timing.

**G11-C — decomposition and delivery**

- Core3 / Full6 decomposition and the 15-track question.
- Six-role reduction and the 2,400-character-per-role budget.
- Synchronization-safe Tempo delivery (`MOBILE_SYNTAX.md` §7).
- Final canonicalization to paste-ready MML (`MOBILE_SYNTAX.md` §11).

**Blocked on the review that could not run**

The `mml.mabi.tw` behaviors most worth knowing — how it splits voices, how it
merges tracks, how it decomposes chords, how it fits a 2,400-character budget —
all sit in G11-B/G11-C. That is the strongest argument for unblocking egress
before those stages rather than before G11-A, whose semantics are fixed by the
SMF specification and the Canonical rules instead.
