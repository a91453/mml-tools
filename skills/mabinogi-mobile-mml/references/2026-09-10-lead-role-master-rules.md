# Master Rules — Lead Role Arbitration / Source-role Evidence
Version: 2026-09-10

This is a normative extension for the Mabinogi Mobile MML master rules. If an older rule conflicts with this section, this section takes precedence for lead-role arbitration.

## MR-LR-01 — T1 is a role line, not a Vocal-only channel

T1 SHALL represent the **dominant perceptual lead** required by the current section.

Valid T1 sources include:
- sung Vocal lead;
- Piano top/lead line during instrumental passages;
- Guitar/Keyboard/other instrumental solo or answer phrase;
- a source-supported hand-off that preserves the lead when Vocal is resting.

The label `Melody` MUST NOT be interpreted as “Vocal only”.

Two prohibited inferences:
- `highest Piano note -> therefore Vocal`;
- `not proven Vocal -> therefore Inner/Harmony`.

Both directions require source-role evidence.

## MR-LR-02 — Source authorities are complementary, not interchangeable

Use each source only for claims it can support.

| Source | Primary authority | Must not be overclaimed as |
|---|---|---|
| Official/accepted MIDI | pitch, onset, duration, expanded order, exact event identity | proof every top note is sung Vocal |
| Official score/notation | staff/voice placement, lyrics alignment, voicing, dynamics, accents, phrasing, written navigation | proof of final-recording mix prominence by itself |
| Original audio | actual timbre, prominence, sustain, articulation, foreground/background role | exact isolated pitch truth when a dense mix prevents reliable separation |
| Mobile/in-game A/B | actual game timbre, register audibility, blend, practical role clarity | replacement for source truth |

Two compatible official sources SHOULD be retained together. One source SHALL NOT be discarded merely because another is easier to parse.

## MR-LR-03 — Source-Faithful Lead Baseline is mandatory

Before role cleanup or six-track reduction, save a `Source-Faithful Lead Baseline` that preserves every source-supported top/lead event with source IDs.

For every candidate, diff against that baseline and enumerate:
- T1 removed events;
- T1 added events;
- T1-to-other-track moves;
- other-track-to-T1 promotions;
- pitch/onset/duration/volume changes.

A silent role move is forbidden.

## MR-LR-04 — Lead Demotion Gate

A T1 event may be moved to another track only when the following evidence chain is satisfied.

1. **Source identity** — exact event is traceable to a source track/staff/voice.
2. **Section role** — Vocal/instrumental state of the section is known.
3. **Score-role evidence** — if official notation exists, classify the event as written lead/top voice, chord inner voice, accompaniment figure, countermelody, or duplicate.
4. **Audio-role evidence** — when audio is usable, determine whether the event behaves as foreground lead or background texture in the recording.
5. **Continuity** — moving it must not create an unsupported gap, false rest, broken sustain, or broken lead hand-off.
6. **Core3 integrity** — T1–T3 must still provide Lead + Core Harmony + Bass for the confirmed three-track-capable instrument.
7. **Positive reason** — the audit must state why the destination role is more correct.

The demotion SHALL FAIL or remain `PENDING` if the only reasons are:
- Vocal identity is uncertain;
- the event is a Piano top note;
- Full6 still contains the event;
- visual role purity improves;
- a metric improves without source/audio role support.

When evidence conflicts, preserve the Source-Faithful Lead event until stronger evidence resolves the conflict.

## MR-LR-05 — Instrumental Lead windows

INTRO, INTERLUDE, SOLO, OUTRO, instrumental pickups, and Vocal-rest answer phrases MUST be explicitly classified before cleanup.

In these windows:
- Piano/Guitar/Keyboard top lines may be T1;
- no “Vocal absence” penalty applies;
- accompaniment demotion still requires positive evidence;
- a high note does not become Inner merely because no lyric is printed on it.

## MR-LR-06 — Three-chord Core3 Gate

For the confirmed three-track-capable Piano/Lute/Mandolin-style configuration:
- T1 = Lead;
- T2 = Core Harmony;
- T3 = Core Bass;
- T4–T6 = enrichment unless a song-specific source role proves otherwise.

Before and after any important role move, compare:
- Melody/Lead continuity;
- Core3 source onset coverage;
- Core3 source pitch-duration coverage;
- register continuity;
- false gaps;
- large jumps introduced into T2/T3;
- low/mid m2/M7/M9 risk;
- all 15 cross-track sustained same-pitch pairs in Full6;
- Core3 vs Full6 original-audio A/B.

Coverage is diagnostic, not an optimization target. Do NOT promote T4–T6 material into T2 solely to maximize coverage.

If a promotion gives only a tiny similarity gain but creates severe T2 register jumps, role pollution, or removes useful multiplayer enrichment, reject the promotion.

## MR-LR-07 — Audio metrics are evidence, not identity labels

Chroma/correlation/onset similarity MAY be used to compare versions and locate likely problem sections.

They SHALL NOT, by themselves:
- identify a top note as Vocal;
- justify repitching a Vocal line from a dense stereo mix;
- prove an octave/register choice;
- convert a `PENDING` role decision into `PASS`.

Use source notation/MIDI for exact event identity and audio for perceptual role.

## MR-LR-08 — Role-volume preservation on moved events

Moving an event between tracks changes role but SHALL NOT automatically promote its foreground level.

When an Inner/Flex/Texture event is promoted into a Core track only to preserve single-player completeness:
- retain or re-arbitrate its original role prominence;
- do not blindly inherit the destination track's louder `V`;
- rerun audio-role and Core3/Full6 A/B.

Conversely, a restored Lead event SHOULD recover Lead-level prominence only when source/audio evidence supports that role.

## MR-LR-09 — Regression tests

Maintain permanent negative/positive tests from historical failures.

### Rashisa / らしさ over-cleaning regression

Fixture:
- 15 Source Top/Lead events historically moved `T1 -> T2`;
- includes beat 259 A4.

Negative test:
- demote them only because “not proven Vocal”;
- expected result: `LEAD_DEMOTION_EVIDENCE_MISSING` warning/fail.

Positive test:
- restore source-supported Lead events to T1;
- expected:
  - global source-event multiset unchanged;
  - no pitch/onset/duration invention;
  - monophonic track constraints retained;
  - Core3 structural gate passes;
  - Full6 structural gate passes.

This regression complements existing historical tests for rest-tie, mixed meter/Nxx, sustain truncation, Tempo/volume readback, and drum mapping.

## MR-LR-10 — Final reporting

Every final/canonical report involving role changes SHALL separately state:
- exact source evidence;
- exact score-role evidence;
- exact audio-role evidence;
- T1 demotions/promotions;
- Core3 effect;
- Full6 effect;
- what changed vs what stayed unchanged;
- which gates are `PASS / FAIL / PENDING / UNSUPPORTED / N/A`.

“All source notes preserved” is not sufficient to prove role assignment is correct. “Full6 matches better” is not sufficient to prove Core3 remains complete.

## Canonical decision principle

`source traceability`
→ `lead continuity`
→ `Core3 completeness`
→ `Mobile audibility/role clarity`
→ `minimal adaptation`
→ `theory/statistical cleanup`

If a later rule conflicts with this hierarchy, it must state the specific source or in-game evidence that justifies the exception.
