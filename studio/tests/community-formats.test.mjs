// 3MLE .mml / .mmi intake: file text → the raw MML@ string it carries and the
// file's own metadata, then the ordinary MML intake. Fixtures are written by
// the Workshop's own writer (studio/web/workshop/mml-out.mjs), so the reading
// half ported into the backend is checked against the half that stayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCommunityMML, readExtension, sniffCommunityFormat } from '../backend/mml/community-formats.mjs';
import { decompress } from '../backend/mml/bzip2-decode.mjs';
import { toMml, toMmi } from '../web/workshop/mml-out.mjs';
import { parseScore } from '../web/workshop/mml-in.mjs';
import { compress } from '../web/workshop/bzip2.mjs';
import { analyzeWorkspace, importWorkspace, intake, newWorkspace } from '../web/model.mjs';
import { portableBackup } from '../web/backup-zip.mjs';
import { projectSources } from '../web/workshop-link.mjs';
import { assetMml } from '../web/asset-mml.mjs';

const texts = ['t120v12l8o5ceg>c<gec4', 't120v10l2o4eg', 't120l1o3c'];
const MML = `MML@${texts.join(',')},,,;`;
const events = project => project.events.map(e => [e.kind, e.pitch ?? null, e.start, e.end, e.metadata?.role ?? e.role ?? null]);

test('the formats are told apart by their section headers, and a pasted MML@ string is neither', () => {
  assert.equal(sniffCommunityFormat(toMml(texts)), '3mle-mml');
  assert.equal(sniffCommunityFormat(toMmi(texts)), 'mmi');
  assert.equal(sniffCommunityFormat(MML), null);
  assert.equal(sniffCommunityFormat('{"schema":"x"}'), null);
  assert.throws(() => readCommunityMML(MML), /UNSUPPORTED: not a 3MLE/);
});

test('the ported bzip2 decoder reads what the Workshop compressor writes, and refuses a damaged block', () => {
  const data = new TextEncoder().encode('Mabinogi '.repeat(4000));
  const packed = compress(data);
  assert.deepEqual(decompress(packed), data);
  // A flipped bit inside the block's coded data (past the stream and block headers).
  const damaged = packed.slice();
  damaged[20] ^= 0x40;
  assert.throws(() => decompress(damaged), /bzip2/);
});

test('.mml: tracks, names, programs, head meter and markers come out as the Workshop wrote them', () => {
  const file = toMml(texts, { title: '測試曲', programs: [24, 40, 0], meters: [{ tick: 0, num: 3, den: 4 }], marks: [{ tick: 1920, text: 'A 段' }] });
  const read = readCommunityMML(file);
  assert.equal(read.format, '3MLE .mml');
  assert.equal(read.mml, MML);
  assert.equal(read.title, '測試曲');
  assert.equal(read.extension, 'verified');
  assert.deepEqual(read.tracks.slice(0, 3).map(t => [t.position, t.label, t.program, t.empty]), [[0, 'main', 24, false], [1, 'chord1', 40, false], [2, 'chord2', 0, false]]);
  assert.deepEqual(read.tracks.slice(3).map(t => t.empty), [true, true, true]);
  assert.deepEqual(read.declaredMeter, [{ tick: 0, ppq: 96, numerator: 3, denominator: 4 }]);
  assert.deepEqual(read.markers, [{ tick: 384, ppq: 96, text: 'A 段' }]);
  assert.deepEqual(read.warnings, []);
  // The same tracks the Workshop's own reader finds.
  assert.deepEqual(parseScore(file).parts.map(p => p.text.replace(/\s+/g, '')), read.mml.slice(4, -1).split(',').filter(Boolean));
});

test('a damaged extension block costs only the names and programs; the tracks still come from the channels', () => {
  const file = toMml(texts, { programs: [24, 40, 0] });
  const tampered = file.replace(/^(d=.{10})(.)/m, (_, head, ch) => head + (ch === 'A' ? 'B' : 'A'));
  assert.notEqual(tampered, file);
  const read = readCommunityMML(tampered);
  assert.equal(read.mml, MML);
  assert.equal(read.extension, 'refused');
  assert.deepEqual(read.warnings, ['COMMUNITY_EXTENSION_UNREADABLE']);
  assert.deepEqual(read.tracks.slice(0, 3).map(t => [t.label, t.program]), [['Channel1', null], ['Channel2', null], ['Channel3', null]]);
  assert.equal(readExtension('c=1\nd=AAAA'), null, 'a text CRC mismatch is refused');
});

test('.mml: an empty channel keeps its position; wrapped lines are joined; other whitespace is left for the parser', () => {
  const file = '[Settings]\r\nTitle=x\r\n[Channel1]\r\nt120o4c4\r\nd4e4\r\n[Channel2]\r\n\r\n[Channel3]\r\no3c 1\r\n';
  const read = readCommunityMML(file);
  assert.equal(read.mml, 'MML@t120o4c4d4e4,,o3c 1,,,;');
  assert.deepEqual(read.tracks.map(t => t.empty), [false, true, false, true, true, true]);
  assert.deepEqual(read.warnings, ['COMMUNITY_LINES_JOINED']);
  assert.equal(read.extension, 'absent');
  // The space is not deleted: "c 1" is not silently turned into "c1".
  const asset = intake({ name: 'x.mml', content: file, id: 'x' });
  assert.ok(asset.errors.some(error => /空白/.test(error.message)), 'the parser reports the whitespace');
});

test('.mmi: a block\'s written parts take consecutive positions, an empty block keeps its place, meter changes are reported', () => {
  const file = toMmi([texts[0], '', texts[2]], { programs: [24, 0, 40], meters: [{ tick: 0, num: 4, den: 4 }, { tick: 3840, num: 3, den: 4 }] });
  const read = readCommunityMML(file);
  assert.equal(read.format, '.mmi');
  assert.equal(read.mml, `MML@${texts[0]},,${texts[2]},,,;`);
  assert.deepEqual(read.tracks.slice(0, 3).map(t => [t.label, t.program, t.empty]), [['main', 24, false], ['chord1', 0, true], ['chord2', 40, false]]);
  assert.deepEqual(read.declaredMeter, [{ tick: 0, ppq: null, numerator: 4, denominator: 4 }, { tick: 768, ppq: null, numerator: 3, denominator: 4 }]);
  const pc = '[mml-score]\r\nmml-track=MML@o4c,o3e,o3g;\r\nname=Lute\r\nprogram=0\r\n';
  const block = readCommunityMML(pc);
  assert.equal(block.mml, 'MML@o4c,o3e,o3g,,,;', 'a three-part block fills three positions');
  assert.deepEqual(block.tracks.slice(0, 3).map(t => t.label), ['Lute #1', 'Lute #2', 'Lute #3']);
});

test('a file that cannot be laid out as six role slots is refused, not cut or rewritten', () => {
  const seven = toMml(['o4c', 'o4d', 'o4e', 'o4f', 'o4g', 'o4a', 'o4b']);
  assert.throws(() => readCommunityMML(seven), /UNSUPPORTED: .*7 tracks.*does not drop tracks/);
  // Trailing empty positions are not tracks.
  assert.equal(readCommunityMML(toMml(['o4c', '', '', '', '', '', ''])).mml, 'MML@o4c,,,,,;');
  assert.throws(() => readCommunityMML('[Settings]\r\n[Channel1]\r\no4c,o4d\r\n'), /separator/);
  assert.throws(() => readCommunityMML('[Settings]\r\n[Channel1]\r\n\r\n'), /no MML track/);
});

test('intake: the file goes through the same MML path as the MML@ string it carries', () => {
  const file = toMml(texts, { title: '曲', programs: [24, 40, 0] });
  const fromFile = intake({ name: 'song.mml', content: file, id: 'same' });
  const pasted = intake({ name: 'song.mml', content: MML, id: 'same' });
  assert.equal(fromFile.format, 'MML');
  assert.equal(fromFile.content, file, 'the file text stays the asset content');
  assert.equal(fromFile.mml, MML);
  assert.equal(assetMml(fromFile), MML);
  assert.equal(assetMml(pasted), MML);
  assert.deepEqual(events(fromFile.project), events(pasted.project), 'identical events: no Workshop tick model in between');
  assert.deepEqual(fromFile.warnings, pasted.warnings);
  assert.equal(fromFile.community.format, '3MLE .mml');
  assert.equal(fromFile.community.mml, undefined, 'the MML is kept once, as asset.mml');
  assert.equal(pasted.community, undefined);
});

test('the declared meter is reported, never applied as the meter map', () => {
  const file = toMml(texts, { programs: [0, 0, 0], meters: [{ tick: 0, num: 3, den: 4 }] });
  const asset = intake({ name: 'song.mml', content: file, id: 'm' });
  assert.equal(asset.community.declaredMeter[0].numerator, 3);
  assert.deepEqual(asset.project.meterEvents, [], 'no caller-confirmed meter map was given');
});

test('a 3MLE candidate is analysed, read back and handed to the Workshop as its MML@ string; a backup re-reads the file', () => {
  const whole = ['t120o4c1', 't120o3e1', 't120o2c1'];
  const expected = `MML@${whole.join(',')},,,;`;
  const file = toMml(whole, { title: '曲', programs: [24, 40, 0] });
  const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
  const workspace = { ...newWorkspace(), title: 't', settings, assets: { candidate: intake({ name: 'song.mml', content: file, id: 'c', meterText: '0 4/4' }) } };
  const report = analyzeWorkspace(workspace);
  assert.equal(report.deliveryOrigin, 'candidate-source');
  assert.equal(report.rawMml, expected, 'the readback compares the MML@ string, not the file text');
  assert.equal(report.gates.technical.status, 'PASS');
  assert.equal(report.state, 'CANDIDATE', 'intake certifies nothing');
  assert.deepEqual(projectSources(workspace).map(s => [s.slot, s.mml]), [['candidate', expected]]);
  const restored = importWorkspace(portableBackup(workspace, { canonical_version: 'test' }));
  assert.equal(restored.assets.candidate.content, file);
  assert.equal(restored.assets.candidate.mml, expected);
  assert.equal(restored.assets.candidate.community.format, '3MLE .mml');
});
