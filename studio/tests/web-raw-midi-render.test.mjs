import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { intakeMidi, newWorkspace, analyzeWorkspace, recordReview, REVIEW_NAMES } from '../web/model.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/index.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// What the Raw MIDI section actually renders.
//
// The presentation rules are not cosmetic: a page that shows Melody as
// required and Chord1/Chord2 as optional, or that lets a filled Chord3-Chord5
// read as a finished arrangement, contradicts the backend it is displaying.
// These run the real render helpers out of app.mjs against a real analysis, so
// they fail if the markup ever stops saying what the report says.
//
// Real layout, real WebKit and real viewports are covered in
// studio/browser-tests.

const source = await readFile(new URL('../web/app.mjs', import.meta.url), 'utf8');
const context = vm.createContext({ document: { querySelector: () => ({ value: '', textContent: '' }) } });
const slice = (from, to) => vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context);
slice('const $ ', 'const roles =');
slice('const bytesLabel', 'function diffTable');

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const asset = (name, bytes) => intakeMidi({ name, bytes });
const reportFor = (name, bytes) => analyzeWorkspace({ ...newWorkspace(), title: 'fixture', settings, assets: { candidate: asset(name, bytes) } });
const renderRawMidi = entries => context.rawMidiSection(entries);

// Non-void elements must open and close in equal numbers, or the browser will
// silently reinterpret the tree and the assertions below stop meaning anything.
function assertBalanced(html) {
  const voids = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
  const counts = new Map();
  for (const [, closing, tag] of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)/g)) {
    if (voids.has(tag.toLowerCase())) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + (closing ? -1 : 1));
  }
  for (const [tag, balance] of counts) assert.equal(balance, 0, `<${tag}> is unbalanced by ${balance}`);
}

test('a project with no Raw MIDI renders no Raw MIDI section at all', () => {
  assert.equal(renderRawMidi([]), '');
  assert.equal(renderRawMidi(undefined), '');
});

test('the section states the source facts a reviewer needs', () => {
  const report = reportFor('six.mid', fixtures.sixSourceVoices());
  const html = renderRawMidi(report.rawMidi);
  assertBalanced(html);

  const entry = report.rawMidi[0];
  for (const fragment of [
    'six.mid',
    entry.source.sha256,
    `${entry.source.byteLength} bytes`,
    'SMF format',
    'Division',
    'PPQ 360',
    'Tracks（宣告／實際）',
    'Note events',
  ]) assert.ok(html.includes(fragment), `the source card must state ${fragment}`);
  // Local processing is claimed where the claim is true, and the audio section
  // is the only thing in this app that uploads anything.
  assert.match(html, /位元組只留在這台裝置/);
});

test('Core3 and Full6 are rendered as separate groups, with all three Core3 roles equal', () => {
  const html = renderRawMidi(reportFor('six.mid', fixtures.sixSourceVoices()).rawMidi);
  const core3Start = html.indexOf('Core3 候選');
  const full6Start = html.indexOf('Full6 加值角色');
  assert.ok(core3Start > 0 && full6Start > core3Start, 'Core3 is its own block and Full6 follows it');

  const core3Block = html.slice(core3Start, full6Start);
  const full6Block = html.slice(full6Start);
  for (const role of ['Melody', 'Chord1', 'Chord2']) {
    assert.ok(core3Block.includes(`>${role}</th>`), `${role} belongs to the Core3 table`);
    assert.equal(full6Block.includes(`>${role}</th>`), false, `${role} must not appear in the Full6 table`);
  }
  for (const role of ['Chord3', 'Chord4', 'Chord5']) {
    assert.ok(full6Block.includes(`>${role}</th>`), `${role} belongs to the Full6 table`);
    assert.equal(core3Block.includes(`>${role}</th>`), false, `${role} must not appear in the Core3 table`);
  }
  // The three Core3 roles are described as one unit with no ranking.
  assert.ok(core3Block.includes('三者同為必要'));
  assert.ok(core3Block.includes('三者皆必要'));
  assert.ok(core3Block.includes('NONE'), 'the no-priority fact is shown, not just asserted in prose');
});

test('an incomplete Core3 is never presented as repairable by enrichment', () => {
  const report = reportFor('six.mid', fixtures.sixSourceVoices());
  const entry = report.rawMidi[0];
  assert.notEqual(entry.arrangement.candidate.core3.status, 'COMPLETE');

  const html = renderRawMidi(report.rawMidi);
  assert.match(html, /不能替代、不能補足、也不能掩蓋尚未成立的 Core3/);
  assert.match(html, /即使 Chord3–Chord5 全部填滿，Core3 仍然不完整/);
  // No completion score exists to override the gate. The only place the idea is
  // mentioned at all is the sentence that denies it.
  assert.equal(/\d+\s*%/.test(html), false, 'no percentage may stand in for the Core3 verdict');
  assert.deepEqual(html.match(/完成度|完成率/g), ['完成度']);
  assert.ok(html.includes('這裡不計算任何「完成度百分比」'));
  // And the Core3 badge is the backend's status, not a friendlier one.
  assert.ok(html.includes(`<span class="badge PENDING">PENDING</span>`));
});

test('the candidate is labelled a candidate and certifies nothing', () => {
  const html = renderRawMidi(reportFor('format1.mid', fixtures.format1()).rawMidi);
  assert.match(html, /這是<strong>候選建議<\/strong>，不是已接受的編排/);
  assert.match(html, /來源事件仍然沒有角色/);
  for (const gate of ['TECHNICAL_PASS', 'SOURCE_PASS', 'PLAYER_READBACK_PASS', 'AUDIO_ALIGNMENT_PASS', 'MOBILE_ADAPTATION_PASS', 'IN_GAME_ACCEPTED']) {
    assert.ok(html.includes(gate), `the banner must name ${gate} as not certified`);
  }
  assert.ok(html.includes('ARRANGEMENT_CANDIDATE'));
  assert.match(html, /本節不產生 Final MML/);
});

test('percussion is shown as percussion and never as a pitched role', () => {
  const report = reportFor('drums.mid', fixtures.percussion());
  const html = renderRawMidi(report.rawMidi);
  assertBalanced(html);

  const start = html.indexOf('打擊材料');
  assert.ok(start > 0, 'percussion gets its own card');
  const card = html.slice(start, html.indexOf('</div>', html.indexOf('逐一打擊事件')));
  assert.ok(card.includes('36, 38, 42'), 'the drum note numbers are shown as drum selectors');
  assert.match(card, /不是音高/);
  assert.match(card, /drum-face/);

  // They are not presented anywhere as candidate material.
  const core3Block = html.slice(html.indexOf('Core3 候選'));
  for (const drum of ['36', '38', '42']) {
    assert.equal(new RegExp(`>${drum}</td>`).test(core3Block), false, `drum number ${drum} must not appear as candidate data`);
  }
  assert.ok(html.includes('<span class="badge UNSUPPORTED">UNSUPPORTED</span>'));
});

test('unsupported material and pending lanes stay on screen', () => {
  const report = reportFor('after-eot.mid', fixtures.dataAfterEndOfTrack());
  const html = renderRawMidi(report.rawMidi);
  assertBalanced(html);
  assert.ok(html.includes('DATA_AFTER_END_OF_TRACK'), 'the code itself is shown, not a friendly summary');
  assert.match(html, /未支援材料不會被修補、量化或丟棄/);
  assert.match(html, /來源未完整/);

  const pendingReport = reportFor('six.mid', fixtures.sixSourceVoices());
  const pendingHtml = renderRawMidi(pendingReport.rawMidi);
  const pending = pendingReport.rawMidi[0].arrangement.candidate.pending;
  assert.ok(pending.length > 0);
  for (const item of pending) {
    assert.ok(pendingHtml.includes(item.laneId), `pending lane ${item.laneId} must be listed`);
    for (const blocker of item.blockers) assert.ok(pendingHtml.includes(blocker));
  }
  // Every source event is accounted for on screen, in one bucket or another.
  const coverage = pendingReport.rawMidi[0].arrangement.candidate.coverage;
  assert.ok(pendingHtml.includes('已指派角色'));
  assert.ok(pendingHtml.includes('待決（證據不足或衝突）'));
  assert.ok(pendingHtml.includes('未指派（超出六角色或保留）'));
  assert.equal(coverage.assignedEventCount + coverage.pendingEventCount + coverage.unassignedEventCount + coverage.unsupportedEventCount, coverage.sourceEventCount);
});

test('G11-B is reported as a decomposition, with its losslessness visible', () => {
  const report = reportFor('six.mid', fixtures.sixSourceVoices());
  const html = renderRawMidi(report.rawMidi);
  assert.ok(html.includes('G11-B'));
  assert.match(html, /不指派角色、不合併、不刪除任何事件/);
  assert.ok(html.includes('遺失事件'));
  assert.ok(html.includes('重複事件'));
  for (const voice of report.rawMidi[0].midi.sourceVoices) assert.ok(html.includes(voice), `source voice ${voice} must be listed`);
});

test('a source whose bytes fail verification renders no candidate at all', () => {
  const record = asset('zero.mid', fixtures.format0());
  const tampered = structuredClone(record);
  tampered.source.sha256 = '0'.repeat(64);
  const report = analyzeWorkspace({ ...newWorkspace(), title: 'fixture', settings, assets: { candidate: tampered } });
  const html = renderRawMidi(report.rawMidi);
  assertBalanced(html);
  assert.ok(html.includes('SOURCE_DIGEST_MISMATCH'));
  assert.match(html, /位元組完整性未通過，因此不進行分解與角色候選/);
  assert.equal(html.includes('Core3 候選'), false, 'nothing may be suggested from a source that cannot be identified');
});

test('a ledger too large to print inline says so instead of dropping entries', () => {
  // Built directly rather than from a fixture: the point is the display bound,
  // and a real file with 500+ events would only make the test slow.
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const candidate = suggestRoleCandidates(record.project);
  const inflated = { ...candidate, ledger: Array.from({ length: 900 }, (_, index) => ({ ...candidate.ledger[0], eventId: `synthetic:${index}` })) };
  const html = context.pendingCard(inflated);
  assert.match(html, /共 900 筆，超過畫面顯示上限 500/);
  assert.match(html, /完整內容包含在「下載分析報告」中，沒有任何一筆被捨棄/);
  // Under the bound it is printed in full.
  assert.ok(context.pendingCard(candidate).includes('逐事件角色帳'));
});

test('a workspace under full review still shows the Raw MIDI candidate as a candidate', () => {
  let workspace = { ...newWorkspace(), title: 'fixture', settings, assets: { candidate: asset('six.mid', fixtures.sixSourceVoices()) } };
  for (const name of REVIEW_NAMES) workspace = recordReview(workspace, name, 'reviewed', 'synthetic');
  const report = analyzeWorkspace(workspace);
  const html = renderRawMidi(report.rawMidi);
  assert.match(html, /這是<strong>候選建議<\/strong>/);
  assert.ok(html.includes('已接受</dt><dd>否</dd>'), 'recording reviews does not accept the arrangement');
  assert.notEqual(report.state, 'VALIDATED');
});

test('an unmet Core3 role reads as PENDING, never as not-applicable', () => {
  const report = reportFor('six.mid', fixtures.sixSourceVoices());
  const candidate = report.rawMidi[0].arrangement.candidate;
  assert.equal(candidate.roles.Melody.status, 'EMPTY', 'the fixture has no evidenced Lead');
  assert.equal(candidate.roles.Chord3.status, 'EMPTY', 'and no enrichment either');

  const html = renderRawMidi(report.rawMidi);
  const core3Block = html.slice(html.indexOf('Core3 候選'), html.indexOf('Full6 加值角色'));
  const full6Block = html.slice(html.indexOf('Full6 加值角色'));
  // An empty required role is an unmet requirement; an empty optional one is not.
  assert.match(core3Block, /<th scope="row">Melody<\/th><td><span class="badge PENDING">PENDING<\/span>/);
  assert.match(full6Block, /<th scope="row">Chord3<\/th><td><span class="badge na">N\/A<\/span>/);
  assert.equal(core3Block.includes('badge na'), false, 'no Core3 role may render as N/A');
});

test('each fact keeps its own label and value together', () => {
  const html = renderRawMidi(reportFor('format1.mid', fixtures.format1()).rawMidi);
  // dt and dd are wrapped per pair, so a multi-column grid cannot separate a
  // value from the label it belongs to.
  assert.equal(/<dt>[^<]*<\/dt><dd>/.test(html), true);
  assert.equal(html.match(/<dt>/g).length, html.match(/<div class="fact">/g).length);
  assert.equal(html.match(/<dd>/g).length, html.match(/<div class="fact">/g).length);
  assert.equal(/<\/dd><dt>/.test(html), false, 'pairs must not be emitted as bare siblings');
});

test('a hostile track name is rendered as text, never as markup', () => {
  const report = reportFor('hostile.mid', fixtures.hostileTrackName());
  const entry = report.rawMidi[0];
  // The name is preserved verbatim as source evidence...
  assert.equal(entry.midi.tracks[0].name, '<script>alert("x")</script> & "quoted" \'name\'');

  const html = renderRawMidi(report.rawMidi);
  assertBalanced(html);
  // ...and escaped everywhere it is shown, including inside the JSON details.
  assert.equal(html.includes('<script>'), false, 'no track name may open a tag');
  assert.equal(/<\/script>/.test(html), false);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'it is shown, escaped, rather than dropped');
});

test('the sidebar navigation numbering matches the section headings it points at', async () => {
  // The nav lives in index.html and the headings in app.mjs, so nothing but a
  // check keeps them in step -- inserting the Raw MIDI section moved four of
  // them, and inserting Final MML generation moved in-game acceptance to 07.
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const nav = [...html.matchAll(/<a href="#([a-z-]+)">(\d\d)　/g)].map(([, id, number]) => [id, number]);
  const headings = new Map([...source.matchAll(/<section id="([a-z-]+)"><div class="section-heading"><h2>(\d\d)　/g)].map(([, id, number]) => [id, number]));
  // The Raw MIDI section renders only when a Raw MIDI source is present, so its
  // heading lives in its own function rather than the main template.
  headings.set('raw-midi', source.match(/<section id="raw-midi">[\s\S]*?<h2>(\d\d)　/)[1]);

  assert.equal(nav.length, 7);
  for (const [id, number] of nav) {
    assert.ok(headings.has(id), `nav points at #${id}, which is not a section`);
    assert.equal(headings.get(id), number, `#${id} is ${number} in the nav and ${headings.get(id)} in its heading`);
  }
  assert.deepEqual(nav.map(([, number]) => number), ['01', '02', '03', '04', '05', '06', '07']);
});
