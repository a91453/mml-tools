// Studio Workshop: local MusicXML import (studio/web/workshop/musicxml-in.mjs)
// and the song name an imported file gives the Workshop. The Workshop is
// outside the Canonical pipeline; these tests pin the ported editor's own
// behaviour, not any Canonical rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMusicXML } from '../web/workshop/musicxml-in.mjs';
import { stripExt, safeFileName } from '../web/workshop/mml-out.mjs';

// One part, 4/4, one quarter per division: a whole note is one bar (1920
// ticks). Each entry is [step, notations]; notations are raw XML placed as
// <tie> elements and inside <notations>.
function score(bars) {
  const measures = bars.map(([step, { ties = [], tied = [], slurs = [] } = {}], i) => {
    const note = `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration>`
      + ties.map(type => `<tie type="${type}"/>`).join('')
      + `<notations>${tied.map(type => `<tied type="${type}"/>`).join('')}${slurs.map(type => `<slur type="${type}" number="1"/>`).join('')}</notations></note>`;
    const head = i === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction>' : '';
    return `<measure number="${i + 1}">${head}${note}</measure>`;
  }).join('');
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}
const notes = xml => parseMusicXML([xml]).tracks[0].notes.map(n => `${n.midi}@${n.tick}-${n.endTick}`);
const chain = (length, mark) => Array.from({ length }, (_, i) => ['C', mark(i === 0 ? ['start'] : i === length - 1 ? ['stop'] : ['stop', 'start'])]);

test('a tie chain over three or four notes keeps its whole length', () => {
  for (const length of [3, 4]) {
    const end = length * 1920;
    const want = [`60@0-${end}`, `62@${end}-${end + 1920}`];
    // <tie> alone, <tied> alone, and both (what most notation programs write).
    for (const [how, mark] of [
      ['tie', types => ({ ties: types })],
      ['tied', types => ({ tied: types })],
      ['tie + tied', types => ({ ties: types, tied: types })],
    ]) {
      assert.deepEqual(notes(score([...chain(length, mark), ['D']])), want, `${length} notes, ${how}`);
    }
  }
});

test('the middle of a chain may list its start before its stop', () => {
  const tiesReversed = types => ({ ties: [...types].reverse(), tied: [...types].reverse() });
  assert.deepEqual(notes(score([...chain(4, tiesReversed), ['D']])), ['60@0-7680', '62@7680-9600']);
  const slursReversed = types => ({ slurs: [...types].reverse() });
  assert.deepEqual(notes(score([...chain(4, slursReversed), ['D']])), ['60@0-7680', '62@7680-9600']);
});

test('a chain of same-pitch slurs, read as a tie, keeps its whole length', () => {
  const slurred = types => ({ slurs: types });
  for (const length of [3, 4]) {
    const end = length * 1920;
    assert.deepEqual(notes(score([...chain(length, slurred), ['D']])), [`60@0-${end}`, `62@${end}-${end + 1920}`], `${length} notes`);
  }
  // A slur that stops and restarts on a note (same number) continues from
  // the note it ended on; one tie, then a slur, joins all three.
  assert.deepEqual(notes(score([['C', { ties: ['start'] }], ['C', { ties: ['stop'], slurs: ['start'] }], ['C', { slurs: ['stop'] }], ['D']])), ['60@0-5760', '62@5760-7680']);
});

test('an imported MusicXML file names the song without its extension', () => {
  for (const name of ['score.mxl', 'score.musicxml', 'score.xml', 'score.MXL', 'score.MusicXML', 'score.mid', 'score.mml']) {
    assert.equal(stripExt(name), 'score', name);
    assert.equal(safeFileName(name), 'score', name);
  }
  assert.equal(stripExt('score.xml.bak'), 'score.xml.bak', 'only a trailing import extension is removed');
});
