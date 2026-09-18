import assert from 'node:assert/strict';

export async function runMobileAdaptationChecks({ page, idle, file, screenshot }) {
  // Re-use one event provenance set in both slots; MML uploads intentionally
  // have distinct source identities, which cannot attest a baseline mapping.
  const source = { id: 'mobile-browser-source', label: 'Synthetic fixture', kind: 'official-midi', authority: 'primary-symbolic', sha256: null, metadata: {} };
  const project = { schema: 'mabinogi-mobile-mml-studio/canonical-project@2', id: 'mobile-browser', title: 'Mobile browser fixture', sources: [source],
    events: [72, 74, 76].map((pitch, i) => ({ kind: 'note', id: `lead-${i}`, pitch, volume: 8 + i, start: String(i), end: String(i + 1), role: 'Melody', voice: 'lead', sourceIds: [source.id], sourceEventIds: [`source-${i}`], tags: [], metadata: {} })),
    tempoEvents: [{ kind: 'tempo', id: 'tempo', beat: '0', bpm: 120, sourceIds: [source.id], sourceEventIds: [], metadata: {} }],
    meterEvents: [{ kind: 'meter', id: 'meter', beat: '0', numerator: 4, denominator: 4, sourceIds: [source.id], sourceEventIds: [], metadata: {} }], decisions: [], metadata: {} };
  await file('candidate', JSON.stringify(project), 'mobile-candidate.json');
  await file('baseline', JSON.stringify(project), 'mobile-baseline.json');
  const section = page.locator('#mobile-adaptation');
  await section.locator('[name="profileId"]').fill('Synthetic target');
  await section.locator('[name="reason"]').fill('Fixture register adaptation');
  await section.locator('[name="evidence"]').fill('fixture:target-client');
  await section.locator('summary', { hasText: /^Melody$/ }).click();
  await section.locator('[name="Melody-min"]').fill('48');
  await section.locator('[name="Melody-max"]').fill('64');
  await section.locator('[name="Melody-delta"]').fill('2');
  await page.locator('#preview-mobile').click();
  await page.locator('#apply-mobile').waitFor();
  await idle();
  assert.ok((await section.textContent()).includes('3 個音符需調整'));
  await page.locator('#apply-mobile').click();
  await page.locator('#clear-mobile').waitFor();
  await idle();
  assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE');
  assert.equal(await page.locator('#copy-mml').isEnabled(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (screenshot) await screenshot();
  await page.reload(); await page.locator('#app h1').waitFor(); await idle();
  assert.equal(await page.locator('#clear-mobile').count(), 1, 'IndexedDB restore replays the adaptation');
  await page.locator('#clear-mobile').click(); await idle();
  assert.equal(await page.locator('#clear-mobile').count(), 0);
  assert.ok((await page.locator('#intake').textContent()).includes('mobile-candidate.json'), 'rollback retains the original source');
}
