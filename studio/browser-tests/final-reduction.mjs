import assert from 'node:assert/strict';

/**
 * G12 in the browser: preview, accept a decision, apply, reload, roll back.
 *
 * The presentation assertions are the point of running this in a browser at
 * all. A reduction candidate with pending or overflow material must never read
 * as settled, and a reduction that could not be replayed must never read as
 * applied -- neither is something a Node test of the model can see.
 */
export async function runFinalReductionChecks({ page, idle, file, screenshot }) {
  // One source identity in both slots: the baseline mapping has to be
  // attestable, which separate MML uploads cannot be.
  const source = { id: 'reduction-browser-source', label: 'Synthetic fixture', kind: 'official-midi', authority: 'primary-symbolic', sha256: null, metadata: {} };
  const note = (id, pitch, start, role) => ({ kind: 'note', id, pitch, volume: 8, start: String(start), end: String(start + 1), role, voice: role ? role.toLowerCase() : null, sourceIds: [source.id], sourceEventIds: [`source-${id}`], tags: [], metadata: {} });
  // Five occupied roles and one lane with no role at all, so the plan has real
  // pending material and one free slot to place it in.
  const project = {
    schema: 'mabinogi-mobile-mml-studio/canonical-project@2', id: 'reduction-browser', title: 'Reduction browser fixture', sources: [source],
    events: [
      ...[0, 1, 2].flatMap(i => [
        note(`melody-${i}`, 72, i, 'Melody'),
        note(`chord1-${i}`, 67, i, 'Chord1'),
        note(`chord2-${i}`, 64, i, 'Chord2'),
        note(`chord3-${i}`, 60, i, 'Chord3'),
        note(`chord4-${i}`, 55, i, 'Chord4'),
        note(`loose-${i}`, 48, i, null),
      ]),
    ],
    tempoEvents: [{ kind: 'tempo', id: 'tempo', beat: '0', bpm: 120, sourceIds: [source.id], sourceEventIds: [], metadata: {} }],
    meterEvents: [{ kind: 'meter', id: 'meter', beat: '0', numerator: 4, denominator: 4, sourceIds: [source.id], sourceEventIds: [], metadata: {} }],
    decisions: [], metadata: {},
  };
  await file('candidate', JSON.stringify(project), 'reduction-candidate.json');
  await file('baseline', JSON.stringify(project), 'reduction-baseline.json');

  const section = page.locator('#final-reduction');
  await page.locator('#preview-reduction').click();
  await idle();
  const previewText = await section.textContent();
  assert.ok(previewText.includes('共 18 個來源事件'), `accounting summary missing: ${previewText.slice(0, 400)}`);
  assert.ok(previewText.includes('待決 3'), 'unassigned material must be presented as pending');
  // Pending is never presented as applied or as a pass.
  assert.equal(await page.locator('#apply-reduction').count(), 0, 'no decision has been accepted, so there is nothing to apply');
  assert.ok(previewText.includes('ROLE_DECISION_REQUIRED'), 'the pending reason code must be visible');
  if (screenshot) await screenshot();

  // Accept one event-level redistribution and re-preview.
  await section.locator('summary', { hasText: '記錄一筆收斂決策' }).click();
  await section.locator('#reduction-decision [name="action"]').selectOption('REDISTRIBUTE');
  await section.locator('#reduction-decision [name="toRole"]').selectOption('Chord5');
  await section.locator('#reduction-decision [name="eventIds"]').fill('loose-0 loose-1 loose-2');
  await section.locator('#reduction-decision [name="evidence"]').fill('fixture:source/loose-lane');
  await section.locator('#reduction-decision [name="reason"]').fill('The source carries this lane as secondary bass reinforcement.');
  await section.getByRole('button', { name: '加入待套用決策', exact: true }).click();
  await idle();
  await page.locator('#preview-reduction').click();
  await idle();
  const accepted = await section.textContent();
  assert.ok(accepted.includes('重新分配 3'), `redistribution not reflected: ${accepted.slice(0, 400)}`);
  assert.ok(accepted.includes('待決 0'), 'the accepted decision resolves the pending material');

  await page.locator('#apply-reduction').click();
  await page.locator('#clear-reduction').waitFor();
  await idle();
  // Applying certifies nothing: the project is still a CANDIDATE.
  assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE');
  assert.equal(await page.locator('#copy-mml').isEnabled(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at this viewport');

  await page.reload(); await page.locator('#app h1').waitFor(); await idle();
  assert.equal(await page.locator('#clear-reduction').count(), 1, 'IndexedDB restore replays the reduction');
  assert.ok((await page.locator('#final-reduction').textContent()).includes('重新分配 3'), 'the replayed reduction reports the same accounting');

  // Previewing again after an apply carries the decisions already accepted, so
  // the panel cannot show the pre-reduction picture beside a panel that says
  // the reduction is applied.
  await page.locator('#preview-reduction').click();
  await idle();
  const repreview = await section.textContent();
  assert.ok(repreview.includes('重新分配 3'), `re-preview lost the applied decisions: ${repreview.slice(0, 400)}`);
  assert.ok(repreview.includes('待決 0'), 're-preview must not report the resolved material as pending again');

  await page.locator('#clear-reduction').click(); await idle();
  assert.equal(await page.locator('#clear-reduction').count(), 0);
  assert.ok((await page.locator('#intake').textContent()).includes('reduction-candidate.json'), 'rollback retains the original source');
}
