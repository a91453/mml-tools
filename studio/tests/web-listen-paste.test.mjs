import test from 'node:test';
import assert from 'node:assert/strict';
import { LISTEN_LIMITS } from '../web/listen-link.mjs';
import { PASTE_MAX_VERSIONS, defaultVersionLabel, isPasteFile, labelFromFileName, preparePastedVersions } from '../web/listen-paste.mjs';

const A = 'MML@t120o4l4cdefgabc,t120o3l1cc,,,,;';
const B = 'MML@t120o4l4cdefgab>c,t120o3l1cc,,,,;';

test('pasted versions: the first filled one is A, empty slots are skipped, labels default by slot', () => {
  const out = preparePastedVersions({ versions: [{ label: '', mml: `  ${A}\n` }, { label: '', mml: '   ' }, { label: '別人的', mml: B }] });
  assert.deepEqual(out.versions, [{ label: '版本 A', mml: A }, { label: '別人的', mml: B }]);
  assert.equal(out.title, '版本 A vs 別人的');
  assert.equal(out.meterText, null);
  assert.equal(defaultVersionLabel(3), '版本 D');
});

test('pasted versions: a single version gets a plain title, an explicit title wins', () => {
  assert.equal(preparePastedVersions({ versions: [{ mml: A }] }).title, '貼上的 MML');
  assert.equal(preparePastedVersions({ versions: [{ label: '我的', mml: A }] }).title, '我的');
  assert.equal(preparePastedVersions({ title: '  測試曲  ', versions: [{ mml: A }, { mml: B }] }).title, '測試曲');
  assert.equal(preparePastedVersions({ title: 'x'.repeat(500), versions: [{ mml: A }] }).title.length, LISTEN_LIMITS.titleChars);
});

test('pasted versions: anything that is not a usable set of complete MML strings is refused by name', () => {
  assert.throws(() => preparePastedVersions({ versions: [{ mml: '' }] }), /至少一份/);
  assert.throws(() => preparePastedVersions({ versions: [{ label: '我的', mml: 't120cde' }] }), /「我的」不是完整的 MML@…; 字串/);
  assert.throws(() => preparePastedVersions({ versions: [{ mml: A }, { mml: A }] }), /「版本 B」與「版本 A」完全相同/);
  assert.throws(() => preparePastedVersions({ versions: [{ label: 'x', mml: A }, { label: 'x', mml: B }] }), /都叫「x」/);
  const five = Array.from({ length: PASTE_MAX_VERSIONS + 1 }, (_, i) => ({ mml: `MML@t120o4c${i + 1},,,,,;` }));
  assert.throws(() => preparePastedVersions({ versions: five }), /最多比較 4 個版本/);
  assert.throws(() => preparePastedVersions({ versions: [{ mml: `MML@${'c'.repeat(LISTEN_LIMITS.mmlChars)},,,,,;` }] }), /超過 40000 字/);
});

test('pasted versions: a meter text is checked with the listening parser and kept as typed', () => {
  assert.equal(preparePastedVersions({ meter: ' 0 3/4\n6 4/4 ', versions: [{ mml: A }] }).meterText, '0 3/4\n6 4/4');
  assert.throws(() => preparePastedVersions({ meter: '3/4', versions: [{ mml: A }] }), /拍號圖無法使用：拍號圖第 1 行/);
  assert.throws(() => preparePastedVersions({ meter: '4 4/4', versions: [{ mml: A }] }), /從第 0 拍開始/);
});

test('picked files: only .mml and .txt, labelled by their base name', () => {
  assert.equal(isPasteFile({ name: 'Song.MML' }), true);
  assert.equal(isPasteFile({ name: 'song.txt' }), true);
  assert.equal(isPasteFile({ name: 'song.mid' }), false);
  assert.equal(labelFromFileName('C:\\music\\my song.v2.mml'), 'my song.v2');
  assert.equal(labelFromFileName('a/b/別人的版本.txt'), '別人的版本');
});
