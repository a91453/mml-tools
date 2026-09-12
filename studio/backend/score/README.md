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
