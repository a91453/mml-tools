import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMusicXML, musicXMLFragmentToProject } from '../backend/score/musicxml.mjs';

const SIMPLE_SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Fixture Song</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="120"/></direction>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff>
      </note>
      <note>
        <chord/>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff>
      </note>
      <note>
        <rest/><duration>4</duration><voice>1</voice><type>quarter</type>
      </note>
      <forward><duration>4</duration></forward>
      <note>
        <pitch><step>G</step><alter>1</alter><octave>4</octave></pitch>
        <duration>4</duration><voice>1</voice><type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

const TWO_VOICE_SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice></note>
      <forward><duration>4</duration></forward>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;

const UNSUPPORTED_SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Clarinet</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <transpose><chromatic>-2</chromatic></transpose>
      </attributes>
      <note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice></note>
      <note><pitch><step>C</step><alter>0.5</alter><octave>5</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure>
  </part>
</score-partwise>`;

test('MusicXML imports chord, rest, forward, meter and tempo with exact provenance', () => {
  const fragment = ingestMusicXML(SIMPLE_SCORE, { sourceId: 'official', label: 'Official score' });
  assert.equal(fragment.complete, true, JSON.stringify(fragment.unsupported));
  assert.equal(fragment.title, 'Fixture Song');
  assert.equal(fragment.source.kind, 'official-musicxml');
  assert.equal(fragment.parts.length, 1);
  assert.deepEqual(fragment.parts[0], {
    id: 'P1', name: 'Piano', measures: 1, endBeat: '4', noteEvents: 3, restEvents: 1,
  });

  const notes = fragment.events.filter(event => event.kind === 'note');
  const rests = fragment.events.filter(event => event.kind === 'rest');
  assert.deepEqual(notes.map(event => [event.pitch, event.start, event.end, event.metadata.chord]), [
    [60, '0', '1', false],
    [64, '0', '1', true],
    [68, '3', '4', false],
  ]);
  assert.deepEqual(rests.map(event => [event.start, event.end]), [['1', '2']]);
  assert.equal(notes[0].metadata.voice ?? notes[0].voice, '1');
  assert.ok(notes[0].sourceEventIds[0].startsWith('part:P1/measure:1/note:'));

  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 120]]);
  assert.deepEqual(fragment.meterEvents.map(event => [event.beat, event.numerator, event.denominator]), [['0', 4, 4]]);

  const project = musicXMLFragmentToProject(fragment, { id: 'fixture-song' });
  assert.equal(project.schema, 'mabinogi-mobile-mml-studio/canonical-project@2');
  assert.equal(project.metadata.sourceComplete, true);
  assert.equal(project.events.length, 4);
});

test('backup and forward preserve independent MusicXML voices without flattening them', () => {
  const fragment = ingestMusicXML(TWO_VOICE_SCORE, { sourceId: 'voices', label: 'Two voices' });
  assert.equal(fragment.complete, true, JSON.stringify(fragment.unsupported));
  const notes = fragment.events.filter(event => event.kind === 'note');
  assert.deepEqual(notes.map(event => [event.pitch, event.start, event.end, event.voice]), [
    [60, '0', '2', '1'],
    [55, '0', '1', '2'],
    [57, '2', '4', '2'],
  ]);
  assert.equal(fragment.parts[0].endBeat, '4');
});

test('unsupported symbolic constructs are surfaced instead of silently invented', () => {
  const fragment = ingestMusicXML(UNSUPPORTED_SCORE, { sourceId: 'unsupported', label: 'Unsupported fixture' });
  assert.equal(fragment.complete, false);
  const codes = new Set(fragment.unsupported.map(item => item.code));
  assert.ok(codes.has('TRANSPOSING_PART'));
  assert.ok(codes.has('GRACE_NOTE'));
  assert.ok(codes.has('MICROTONAL_PITCH'));
  assert.equal(fragment.events.length, 0);
});

test('MusicXML rejects timewise scores and entity-bearing DTD subsets', () => {
  assert.throws(
    () => ingestMusicXML('<score-timewise version="4.0"></score-timewise>'),
    /score-timewise/,
  );
  assert.throws(
    () => ingestMusicXML('<!DOCTYPE score-partwise [<!ENTITY x "bad">]><score-partwise>&x;</score-partwise>'),
    /entities|DTD/i,
  );
});

test('metronome half=60 is normalized to quarter-note BPM 120', () => {
  const xml = `<?xml version="1.0"?><score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>half</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
    </measure></part>
  </score-partwise>`;
  const fragment = ingestMusicXML(xml, { sourceId: 'metro', label: 'Metronome fixture' });
  assert.deepEqual(fragment.tempoEvents.map(event => [event.beat, event.bpm]), [['0', 120]]);
});
