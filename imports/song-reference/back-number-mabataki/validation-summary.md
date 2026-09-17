# Validation Summary — back number〈瞬き〉

## Important distinction

This package separates:

- **NEWLY_RUN_DURING_EXPORT** — checks actually executed while assembling this ZIP.
- **HISTORICAL_RECORDED_RESULT** — results retained from prior validation work in this conversation.
- **USER_DEVICE_FEEDBACK** — target-client/listening acceptance from the user.
- **NOT_RUN** — not executed during package assembly.

No parser/CI/preview result is used to manufacture `IN_GAME_ACCEPTED`.

## Newly run during export

| Check | Status | Evidence |
|---|---|---|
| Published Canonical manifest load | PASS | Read-only GitHub raw/GET load |
| Published rule-source headers | PASS | MASTER_RULES / SOURCE_POLICY / MOBILE_SYNTAX / ACCEPTANCE_CRITERIA loaded from snapshot `0a172900...` |
| main HEAD resolution | PASS | `d47f64c3413b96eccf13423e90c75993152828d2` |
| accepted MML integrity | PASS | SHA-256 `bfbfb8b77416e6abca47f75ce7687b43dded6fd9f72ef848d1e129ae1fab15ed` |
| JSON parse validation | PASS | All package JSON parsed successfully before ZIP |
| required Markdown/MML presence | PASS | Verified before ZIP |
| prohibited source-binary omission | PASS | No source audio/MIDI/PDF binary in package |

## Historical recorded v29R validation

The retained v29R offline validation report recorded:

- Gate0 Intake: PASS
- Gate1 Technical: TECHNICAL_PASS
- Gate2 SourceTraceability: SOURCE_PASS
- Gate3 Melody/Lead: PASS
- Gate4 Core3: PASS
- Gate5 Full6 arbitration: PASS
- Gate6 Tempo/duration/preview: PASS
- Gate7 Original audio: AUDIO_ALIGNMENT_PASS
- Gate8 Mobile adaptation: MOBILE_ADAPTATION_PASS
- Gate9 Regression: PASS
- Gate10 In-game: **PENDING at the time of that offline revalidation**

Recorded MML statistics:
- chars: `1524 / 1048 / 1567 / 1144 / 944 / 853`
- beats: `1244.5` on all six roles
- note counts: `555 / 229 / 625 / 271 / 110 / 51`
- tempo: `T240` on all six roles

Recorded Preview readback:
- music-track note counts: `555 / 229 / 625 / 271 / 110 / 51`
- duration: `311.125 s`
- meter map in expanded preview: `3/4 → 12/4 → 6/4 → 12/4` under the project's doubled-beat MML representation

Recorded Final canonicalization:
- six roles
- each role under 2400 characters
- Tempo/pitch/volume/length ranges OK
- forbidden fragile dotted forms absent
- double dots absent
- rest ties absent
- Nxx absent
- zero-duration absent

Recorded source-aware microTiming from the later full validation turn:
- candidateCount: `0`
- sourceSupportedCount: `0`
- technicalResidueCount: `0`
- unknownCount: `0`
- unresolvedStreamIssueCount: `0`
- status: `PASS`

**This microTiming result was NOT re-run during package assembly.**

Recorded audio alignment:
- scale: `1.0`
- offset: about `+2.92 s`
- local offset range: about `+2.915 to +2.925 s`
- sustained cumulative tempo drift: recorded PASS
- candidate dry duration: `311.125 s`
- historical E-source duration: about `311.1 s`

**Audio alignment was NOT re-run during package assembly.**

## Current in-game acceptance

Current `IN_GAME_ACCEPTED` comes from subsequent explicit user feedback, not from the old offline report:

> 「V29r好了 如果同聲的樂器變厚好像有點雜 不同樂器還好」

Therefore the portable package records:

- `candidateReady = true` — from the latest full validation record.
- `finalAccepted = true` — because the user subsequently selected v29R on the target listening/device workflow.

## NOT_RUN during package assembly

- Full event-level source comparison
- Original-audio alignment
- Expanded Preview MIDI readback
- Studio readiness execution
- source-aware microTiming analyzer
- New Mabinogi Mobile playback session

Future importing agents must not relabel these as newly-run PASSes.
