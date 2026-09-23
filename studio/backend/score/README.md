# Score ingestion

Purpose: convert symbolic sources into Canonical Music IR without arranging them.

Planned V1 inputs, in priority order:

1. official/trusted MusicXML;
2. official/trusted MIDI;
3. third-party MuseScore MusicXML/MIDI as supporting evidence.

The importer must preserve source IDs, part/staff/voice identity, exact onset/duration, pitch, written dynamics when available, repeat-expanded order, and source navigation metadata.

The importer must not:

- decide the final six-track role while reading a score;
- discard inner/counter/bass voices merely because six tracks are the final target;
- promote a Piano top note to Vocal without evidence;
- normalize away a source conflict.

PDF/OMR and audio transcription are intentionally outside the first symbolic-source milestone.

## MusicXML intake v2 (implementation notes)

This section describes what `musicxml.mjs`, `navigation.mjs` and `mxl.mjs` do.
It is implementation behaviour, not a Canonical rule; `docs/SOURCE_POLICY.md`
§1.A (repeats/navigation are symbolic-source evidence "when explicitly
represented") and `docs/MASTER_RULES.md` §3/§9 (source-faithful baseline, fully
expanded playback order) are the authority it serves.

### Playback order

The score is read in written order, then laid out in the order a performer plays
the written measures. The expansion is the written performance order: no
measure is added, dropped or edited, and nothing inside a measure is re-timed,
padded or quantized. All parts share one timeline; a measure lasts as long as
its longest part (`MEASURE_LENGTH_DIFFERS_ACROSS_PARTS` when they differ).

Supported, from `<barline>`, `<sound>` attributes and the standard direction
words:

| Written | Played |
| --- | --- |
| `|: … :|` | twice |
| `:|` with no `|:` | from the piece start, or from the measure after the previous repeat structure |
| `times="n"` | n times (at most 16) |
| `<ending number="1, 2" type="start|stop|discontinue">` | on the passes it names; multi-measure endings; an ending split into two adjacent segments with the same numbers and no repeat barline between them is one ending (`VOLTA_SEGMENTS_JOINED`); a last ending that itself repeats leaves the final pass without a bracket |
| segno / `dalsegno`, "D.S.", "Dal Segno" | back to the segno, once |
| `dacapo`, "D.C.", "Da Capo" | back to the start, once |
| `tocoda`, "To Coda" (also a coda sign carrying `tocoda`) and coda / `coda` | after the jump, from the To Coda measure to the coda |
| `fine`, "Fine" | after the jump, stop at the end of that measure |
| `<sound forward-repeat="yes">` | an implied `|:` |

Conventions, each recorded on the result: D.C./D.S. are taken once, the first
time they are reached; after the jump, repeats are not re-taken and the last
ending is played up to the jump measure, unless the jump text says "with
repeats" / "con rip."; To Coda and Fine act only after the jump; jump marks act
at the end of their measure (`NAVIGATION_MARKER_NOT_AT_MEASURE_END` when written
earlier); a jump on a measure that also ends a repeat is taken on the repeat's
last pass (`NAVIGATION_JUMP_AFTER_REPEAT`); a jump read only from words says so
(`NAVIGATION_FROM_WORDS`). A replayed or jumped-to measure that writes no tempo
or meter of its own gets the one in force at that written measure restated
(`metadata.restated`), the way notation and notation software carry them.

Refused rather than guessed — the written order is kept, the source is marked
incomplete and `unsupported` names the family (`REPEAT_BARLINE`,
`VOLTA_ENDING`, `SEGNO`, `CODA`, `DA_CAPO`, `DAL_SEGNO`, `TO_CODA`,
`FINE_NAVIGATION`, `NAVIGATION_PLAN`), the `reason` and the measure: parts that
disagree on barlines, unmatched or overlapping endings, endings with no repeat
to return through, a `|:` never closed or nested, `times` over the limit, two
D.C./D.S. jumps, a segno/coda/To Coda/Fine no jump uses, "al Coda"/"al Fine"
that is never reached, ambiguous labels, a mid-measure target, `time-only`,
parts with different measure counts, a plan over 20,000 measures (or 16× the
written length), and any navigation mark the text shows in a place the reader
does not interpret (`NAVIGATION_MARKER_UNACCOUNTED`).

The order is recorded on the source (`source.metadata.navigation`:
`playbackOrder` as runs of written measure indices, `playbackOrderText`,
`sections`, `jump`, `conventions`) and on the project metadata.

### Event identity

The first pass through a written measure keeps the id and source path an
unexpanded ingest always produced (`<source>:note:<part>:<measure>:<sequence>`,
`part:<part>/measure:<measure>/note:<sequence>`). A later pass appends
`:pass<N>` to the id and `/pass:<N>` to the source path, and carries `pass`,
`playbackMeasureIndex` and `writtenSourceEventId` in metadata. Every played
event therefore traces to exactly one written note or rest, and ids are a pure
function of the bytes.

### Pickup

`implicit="yes"` on measure 1 declares a pickup. When the attribute is absent
and measure 1 holds less than its written time signature, it is read as a pickup
as a declared inference, reported as `PICKUP_INFERRED` with the lengths
(`implicit="no"` is taken at its word). The pickup occupies the end of a partial
first bar whose length is the pickup rounded up to whole beats of the written
signature, and the meter map says so: a partial-bar meter at beat 0
(`partialFirstBar: true`) and the written signature from the first full bar. A
1.5-beat pickup under 4/4 therefore makes a 2/4 first bar, the pickup from beat
1/2, bar 2 at beat 2. The initial tempo stays at beat 0.

Across sources the pickup is not aligned by guesswork. A MIDI whose first bar is
2/4 with a half-beat rest lines up with such a MusicXML and their equal meters
merge. A MIDI with a different map (say 4/4 from beat 0, pickup at beat 0) is
merged as it is: both timelines are kept, `METER_CONFLICT_AT_POSITION` names
the disagreement at beat 0, and the Final meter map refuses it. Aligning the two
needs source-confirmed input the files do not carry (which bar the other source
treats as bar 1, or a corrected export); no such alignment is invented.

### Compressed MusicXML (.mxl)

Recognised by the ZIP magic bytes, never the filename. `META-INF/container.xml`
names the rootfile (the first `<rootfile>`, per the MusicXML container spec).
The reader is dependency-free, so the Node service and the offline Studio Web use
the same code. Limits: archive 16 MiB, 256 entries, container.xml 64 KiB,
rootfile 16 MiB uncompressed; stored and deflate only. An entry's declared size
is checked before inflating and the output is capped at that size, so a zip bomb
stops at the cap. Refused: encryption, ZIP64, multi-disk, other methods,
duplicate names, `..`/absolute/drive/backslash paths, a local header that
disagrees with the central directory, CRC mismatch. The asset is stored and
hashed as the uploaded archive; the XML is derived and recorded
(`source.metadata.container`: rootfile path, size, sha256; the baseline's
`formats[].container`).
