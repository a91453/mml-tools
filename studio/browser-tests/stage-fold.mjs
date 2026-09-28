import assert from 'node:assert/strict';

// The Studio page numbers its stages 01–09 in page order, the side navigation
// names the same numbers, and a stage with nothing to act on yet folds to its
// heading and one line naming what it waits for. Run on a project that has its
// settings saved but no source yet; the caller goes on to add the sources.
const STAGES = [
  ['intake', '01'], ['raw-midi', '02'], ['gates', '03'], ['review', '04'], ['audio', '05'],
  ['final-reduction', '06'], ['mobile-adaptation', '07'], ['final-delivery', '08'], ['delivery', '09'],
];

const folded = async (page, id) => {
  const fold = page.locator(`#${id} > details.stage-fold`);
  return await fold.count() === 1 && await fold.evaluate(details => !details.open);
};

export async function runStageFoldChecks({ page, idle }) {
  // Numbers: page order, no gap, and the navigation points at the same stages.
  const headings = await page.locator('#app > section > .section-heading > h2').allTextContents();
  assert.deepEqual(headings.map(text => text.slice(0, 2)), STAGES.map(([, number]) => number), 'stage headings run 01–09 in page order');
  const links = await page.locator('aside nav a').evaluateAll(anchors => anchors.map(a => [a.hash.slice(1), a.textContent.slice(0, 2)]));
  assert.deepEqual(links, STAGES, 'the side navigation names every stage with its number');

  // Nothing to act on yet: every stage after the sources is folded, 02 is one line.
  assert.equal(await page.locator('#intake details.stage-fold').count(), 0, 'the sources stage is never folded');
  assert.ok(await page.locator('#raw-midi .stage-wait').isVisible(), 'Raw MIDI says it needs a MIDI source');
  for (const [id] of STAGES.slice(2)) {
    assert.equal(await folded(page, id), true, `${id} waits folded`);
    assert.ok(await page.locator(`#${id} h2`).isVisible(), `${id} keeps its heading`);
    assert.ok((await page.locator(`#${id} > details.stage-fold > summary`).textContent()).includes('01'), `${id} names what it waits for`);
  }
  assert.equal(await page.locator('#request-audio').isVisible(), false, 'a folded stage hides its controls');

  // The side navigation opens the stage it points at, and a re-render keeps it open.
  await page.locator('aside nav a[href="#audio"]').click();
  assert.ok(await page.locator('#request-audio').isVisible(), 'the navigation opened 05');
  await page.getByRole('button', { name: '儲存專案設定', exact: true }).click();
  await idle();
  assert.equal(await page.locator('#audio > details.stage-fold').count(), 0, 'an opened stage stays open after a render');
  assert.ok(await page.locator('#request-audio').isVisible());
  assert.equal(await folded(page, 'gates'), true, 'the others still wait');
}
