import assert from 'node:assert/strict';
import * as fixtures from '../tests/fixtures/midi-fixtures.mjs';

// The G11-D Decision Composer in a real browser: events gathered on the roll,
// a dry run that writes nothing, and an acceptance that records exactly the
// previewed record and changes no gate.
export async function runDecisionComposerChecks({ page, idle, screenshot }) {
  await page.locator('#new-project').click(); await idle();
  await page.locator('[data-intake="candidate"]').setInputFiles({ name: 'composer.mid', mimeType: 'audio/midi', buffer: Buffer.from(fixtures.sixSourceVoices()) });
  await page.locator('#decision-composer').waitFor(); await idle();
  const stored = () => page.evaluate(async () => (await (await import('./studio/web/storage.mjs')).listProjects()).find(w => w.assets?.candidate?.name === 'composer.mid')?.acceptedDecisions ?? []);
  assert.equal((await stored()).length, 0);
  const gatesBefore = await page.locator('#gates').textContent();

  // Gather one G11-C voice, then one more event straight from the roll.
  const lane = page.locator('#compose-lane');
  const laneValue = await lane.locator('option').nth(1).getAttribute('value');
  await lane.selectOption(laneValue);
  const selected = Number((await page.locator('#decision-composer').textContent()).match(/已選取 (\d+) 個事件/)[1]);
  assert.ok(selected > 0, 'a whole voice is gathered');
  assert.equal(await page.locator('#compose-form button[type="submit"]').isEnabled(), true);

  await page.locator('#compose-form [name="type"]').selectOption('ASSIGN_ROLE');
  await page.locator('#compose-form [name="toRole"]').selectOption('Chord3');
  await page.locator('#compose-form [name="reason"]').fill('Reviewed on the roll: this voice is enrichment.');
  await page.locator('#compose-form [name="evidence"]').fill('fixture:roll review');
  await page.locator('#compose-form button[type="submit"]').click(); await idle();
  await page.locator('#decision-composer .composer-preview').waitFor();
  assert.equal(await page.locator('#decision-composer .composer-preview .badge').textContent(), 'PASS');
  assert.equal((await stored()).length, 0, 'a preview writes nothing');
  assert.equal(await page.locator('[data-roll-view="preview"][aria-pressed="true"]').count(), 1, 'the roll switches to the labelled preview');
  assert.ok((await page.locator('.roll-card').textContent()).includes('決策預覽'));
  assert.ok((await page.locator('.roll-card .roll-lane.lane-3 small').textContent()) === String(selected), 'the preview roll shows the voice in Chord3');

  // Typing after a preview drops it without stealing focus.
  await page.locator('#compose-form [name="note"]').fill('x');
  assert.equal(await page.locator('#decision-composer .composer-preview').count(), 0, 'an edit drops the dry run');
  assert.equal(await page.evaluate(() => document.activeElement?.name), 'note', 'typing keeps focus');
  await page.locator('#compose-form [name="note"]').fill('');
  await page.locator('#compose-form button[type="submit"]').click(); await idle();
  await page.locator('#accept-decision').waitFor();
  await screenshot?.();
  await page.locator('#accept-decision').click(); await idle();
  await page.locator('#decision-composer .codes li').first().waitFor();
  const records = await stored();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision.toRole, 'Chord3');
  assert.equal(records[0].decision.acceptance.acceptedBy, 'local-workspace-user');
  assert.equal(records[0].decision.target.eventIds.length, selected);
  assert.equal(await page.locator('[data-roll-view="accepted"][aria-pressed="true"]').count(), 1, 'the roll shows the accepted head');
  assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE', 'an accepted decision validates nothing');
  assert.equal(await page.locator('#gates').textContent(), gatesBefore, 'no gate moved');

  await page.locator('#clear-decisions').click(); await idle();
  assert.equal((await stored()).length, 0);
}
