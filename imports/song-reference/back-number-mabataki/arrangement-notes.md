# Arrangement Notes — back number〈瞬き〉

## Scope

These notes are **song-specific arrangement context**, not Canonical rules and not artist-wide rules.

## Source separation

- Official audio: recording prominence, sustain/articulation, practical register, timing/alignment evidence.
- Trusted symbolic MIDI references: pitch/onset/duration/voicing evidence used in historical audits.
- Third-party arrangement: supporting ideas for voicing, spacing, role allocation and community convention only.
- Current accepted MML: v29R.
- Historical accepted/reference versions: v13, v23 milestone evidence, SF6R, TL1.

## Track roles

1. Melody — Lead Role.
2. Chord1 — Core Harmony / principal accompaniment / essential response.
3. Chord2 — Bass skeleton plus essential inner support for Core3 completeness.
4. Chord3 — enrichment / inner voice.
5. Chord4 — enrichment / piano-derived or secondary texture.
6. Chord5 — enrichment / piano-derived or secondary texture.

## Important v29R decisions

The retained historical v29R audit records these as accepted song-specific decisions, not universal rules:

- 102–110: truncate the C#5 sustain rather than invent a source-unsupported re-entry.
- 278–279 and 793–795: retreat held D5 tails where the piano/audio foreground role pointed elsewhere.
- 853–855: redistribute D#5 into Chord1 to preserve Core3 while conflicting enrichment retreats.
- 1047–1053: D5 → D4 register adaptation, historically supported by piano/audio evidence.
- 1148–1149 and 1189–1190: retreat D5 tails under stronger Melody/recorded D#5 role.
- 1231–1232: move source-supported D#5 into Core3 rather than duplicate it in the outer role.
- 711–717: Bass D#2 → D#3 register adaptation, historically supported by piano/audio register evidence.
- 179–182, 378–383, 433–435: Chord3 retreats retained from v23 in-game improvement.
- 207–213: paired cross-source arbitration — E-source C#4 retreats while piano/audio-supported D4 remains at low volume as enrichment.
- Several piano-derived enrichment candidates remain omitted where they would create stronger same-pitch duplication or low/mid semitone/M7/m9 compression without stronger role evidence.

## v29R vs source-faithful reference

Historical drift record versus v13/SF6R:
- Melody changed beats: 0
- Core3 changed beats: 28 / 3733.5 ≈ 0.75%
- Full6 changed beats: 92 / 7467 ≈ 1.23%

These values are review triggers, not quality scores.

Historical source verification for the SF6R bridge:
- Melody 555/555 exact onset+pitch against E-source role
- Chord1 229/229
- Bass 625/625
- Chord3 275/275
- Track5 115/115 selected piano-derived events
- Track6 53/53 selected piano-derived events

v29R note counts:
- 555 / 229 / 625 / 271 / 110 / 51

## Fuller vs cleaner trade-off

SF6R/TL1 retained more enrichment and initially sounded fuller. TL1 also proved that lowering prominence could help without deleting source note events.

However, the final user preference returned to v29R because same/similar-instrument thickening sounded more cluttered, while v29R had cleaner separation.

This observation is retained as:
- valid `USER_DEVICE_FEEDBACK` for this song/setup;
- a `REUSABLE_INSIGHT_CANDIDATE` for future cross-song study;
- **not** `CANONICAL_RULE`;
- **not** `ARTIST_RULE_CONFIRMED`.

## Unresolved

The individual contribution of the two TL1+C register changes is not isolated. The combined C bundle was rejected on TL1, but current v29R containing those changes plus broader cleanup was later accepted overall. Do not infer either register change is independently proven good or bad.
