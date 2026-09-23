import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MARKER_KINDS, validateListenLink } from '../web/listen-link.mjs';
import { NOTE_KINDS, markersFromReport, normalizeNote, notesAsMarkers, notesExportText, sanitizeStoredNotes } from '../web/listen-notes.mjs';
import { parseListening } from '../web/listen-model.mjs';
import { listenBars, songClock } from '../web/listen-timeline.mjs';
import { analyzeWorkspace, importWorkspace, intake, newWorkspace, invalidate } from '../web/model.mjs';

const MML = 'MML@t120o4l4cdefgabcdefgabcdefg,t120o3l1cccc,,,,;';
const sha = createHash('sha256').update(MML).digest('hex');
let clockTick = 0;
const fixed = { now: () => `2026-09-23T00:00:0${clockTick++ % 10}.000Z`, id: (() => { let n = 0; return () => `note-${++n}`; })() };

test('a note is a position, a role, a kind and text; anything else is refused', () => {
  const note = normalizeNote({ beat: '13/2', role: 'Melody', kind: 'wrong-note', text: '  主旋律不對\u0007  ', mmlSha256: sha }, fixed);
  assert.deepEqual(Object.keys(note), ['id', 'beat', 'role', 'kind', 'text', 'createdAt', 'updatedAt', 'mmlSha256']);
  assert.equal(note.text, '主旋律不對');
  assert.equal(note.role, 'Melody');
  assert.equal(normalizeNote({ beat: '0', role: '', kind: 'other', text: 'x' }, fixed).role, null);
  for (const bad of [{ beat: '1.5', kind: 'other', text: 'x' }, { beat: '-1', kind: 'other', text: 'x' }, { beat: '0', kind: 'loud', text: 'x' }, { beat: '0', kind: 'other', text: '   ' }, { beat: '0', kind: 'other', role: 'Drums', text: 'x' }, { beat: '0', kind: 'other', text: 'x'.repeat(501) }]) {
    assert.throws(() => normalizeNote(bad, fixed), undefined, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(NOTE_KINDS.map(kind => kind.id), ['too-loud', 'wrong-note', 'timing', 'balance', 'other']);
  // Editing keeps the id and creation time.
  const edited = normalizeNote({ ...note, text: '改好了' }, fixed);
  assert.equal(edited.id, note.id);
  assert.equal(edited.createdAt, note.createdAt);
});

test('"Copy for AI" is a compact plain-text list: title, MML identity, one line per note', () => {
  const song = parseListening(MML).song;
  const { bars, assumed } = listenBars(null, song.total);
  const notes = [
    normalizeNote({ beat: '13/2', role: 'Melody', kind: 'wrong-note', text: '主旋律不對\n第二行', mmlSha256: sha }, fixed),
    normalizeNote({ beat: '4', role: null, kind: 'too-loud', text: '這裡太吵', mmlSha256: sha }, fixed),
  ];
  const text = notesExportText({ title: '合成測試', mmlSha256: sha, meterText: null, meterAssumed: assumed, notes, bars, clock: songClock(song) });
  assert.deepEqual(text.split('\n'), [
    'MML Studio 試聽備註（listening notes）',
    'title: 合成測試',
    `mml_sha256: ${sha}`,
    'meter: 0 4/4（未提供拍號，假設 4/4）',
    'notes: 2',
    'format: bar | beat-in-bar | quarter-beat position | time | role | kind | text',
    'bar 2 | beat 1 | q=4 | 0:02.00 | all roles | too-loud | 這裡太吵',
    'bar 2 | beat 3+1/2 | q=13/2 | 0:03.25 | Melody | wrong-note | 主旋律不對 第二行',
  ]);
  const withMeter = notesExportText({ title: 't', mmlSha256: sha, meterText: '0 2/4\n2 4/4', meterAssumed: false, notes: notes.slice(1), bars: listenBars('0 2/4\n2 4/4', song.total).bars, clock: songClock(song) });
  assert.ok(withMeter.includes('meter: 0 2/4; 2 4/4'));
  assert.ok(withMeter.endsWith('bar 2 | beat 3 | q=4 | 0:02.00 | all roles | too-loud | 這裡太吵'));
});

test('notes come back as markers when a session is reopened, and are valid listen-link markers', () => {
  const notes = [normalizeNote({ beat: '8', role: 'Chord1', kind: 'balance', text: '太小聲', mmlSha256: sha }, fixed), normalizeNote({ beat: '2', kind: 'timing', text: '搶拍', mmlSha256: sha }, fixed)];
  const markers = notesAsMarkers(notes);
  assert.deepEqual(markers.map(m => [m.beat, m.kind, m.role ?? null, m.label]), [['2', 'note', null, '節奏／時值：搶拍'], ['8', 'note', 'Chord1', '聲部平衡：太小聲']]);
  const link = validateListenLink({ schema: 'mml-studio/listen-link@1', mml: MML, markers: markers.map(({ noteId, ...marker }) => marker) });
  assert.equal(link.markers.length, 2);
});

test('stored notes are cleaned note by note, and travel through a project backup', () => {
  const good = normalizeNote({ beat: '4', kind: 'other', text: 'ok', mmlSha256: sha }, fixed);
  const cleaned = sanitizeStoredNotes([good, { ...good, id: 'bad id!' }, { beat: 'x' }, null, 'text', { ...good, id: 'other-1', mmlSha256: undefined }]);
  assert.deepEqual(cleaned.map(n => n.id), [good.id], 'only whole notes bound to an MML survive');
  assert.deepEqual(sanitizeStoredNotes('nope'), []);
  const workspace = { ...newWorkspace(), title: 'fixture', listeningNotes: [good, { beat: '<script>' }] };
  const restored = importWorkspace(JSON.stringify(workspace));
  assert.deepEqual(restored.listeningNotes, [good]);
  assert.equal(importWorkspace(JSON.stringify(newWorkspace())).listeningNotes, undefined);
  // Notes are not evidence: a revision change keeps them, and analysis ignores them.
  assert.deepEqual(invalidate(workspace).listeningNotes, workspace.listeningNotes);
});

test('a local project report yields listening markers: the unresolved-evidence ledger and unresolved places', () => {
  const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
  const w = { ...newWorkspace(), title: 'fixture', settings };
  w.assets.candidate = intake({ name: 'c.mml', content: 'MML@t120o4c1,t120o3e1,t120o2c1,,,;', id: 'c', meterText: '0 4/4' });
  const report = analyzeWorkspace(w);
  const markers = markersFromReport(report);
  const ledger = report.readiness.machineDelivery.unresolved_evidence_ledger;
  assert.ok(ledger.length > 0, 'an unreviewed fixture has unresolved evidence');
  const song = markers.filter(m => m.scope === 'song');
  assert.equal(song.length, ledger.length);
  for (const marker of song) {
    assert.equal(marker.beat, '0');
    assert.equal(marker.end_beat, report.roll.end);
    assert.ok(marker.label.startsWith('整首待審：'));
  }
  assert.ok(markers.every(m => MARKER_KINDS.includes(m.kind)));
  // Positional ones come from the report's own places.
  const synthetic = markersFromReport({
    roll: { end: '8', lanes: [{ role: 'Melody', events: [{ id: 'e1', start: '2', end: '3' }] }] },
    leadPromotionReports: [{ status: 'PENDING', pass: false, eventId: 'e1', blockers: ['LEAD_EVIDENCE_REQUIRED'] }, { status: 'PASS', pass: true, eventId: 'e1' }],
    harmony: { conflicts: [{ start: '4', end: '5', leftRole: 'Chord1', rightRole: 'Chord2', intervalName: 'm2', resolved: false }, { start: '6', end: '7', resolved: true }] },
  });
  assert.deepEqual(synthetic.map(m => [m.beat, m.end_beat, m.role, m.kind]), [['2', '3', 'Melody', 'lead-unverified'], ['4', '5', 'Chord1', 'pending']]);
  assert.deepEqual(markersFromReport(null), []);
});
