import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionRanges, renderSourceReview } from '../scripts/studio-source-review.mjs';

test('audition sections retain the short final section and exact end without padding', () => {
  const sections = sectionRanges([{ end: '262079/480' }]);
  assert.equal(sections.length, 18);
  assert.deepEqual(sections.at(-1), { start: 544, end: 262079 / 480 });
  assert.equal(sectionRanges([{ end: '64' }]).length, 2);
  assert.deepEqual(sectionRanges([]), []);
  assert.throws(() => sectionRanges([], 0));
});

test('untrusted source labels cannot terminate the embedded JSON script', () => {
  const html = renderSourceReview({ binding: { title: '</script><script>alert(1)</script>' } });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const json = html.match(/id="packet">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(json).binding.title, '</script><script>alert(1)</script>');
  assert.ok(!html.includes('fetch(')); // packet cannot submit a confirmation
});
