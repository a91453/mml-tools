import assert from 'node:assert/strict';
import { PUBLISHED_CANONICAL } from '../backend/rules/index.mjs';

// Final MML generation and export, driven through the real page.
//
// What these protect, in order of how badly they would fail silently:
//
//   * the exported string. Displayed, copied, downloaded and stored must be one
//     string. A re-render, a re-join of the role bodies or a stray trim would
//     all still "look right" on screen and hand the user something the analysis
//     never verified;
//   * the clipboard fallback, which exists to hand over that same string when
//     the browser refuses the clipboard -- so it must show the string, not a
//     second rendering of it;
//   * the separation between the latest generation attempt and the currently
//     applied delivery, which are two different states that must never be read
//     as one;
//   * the P1 character-count disclaimer, which is the only thing standing
//     between a JavaScript string length and a claim about the target client.
export async function runFinalDeliveryChecks({ page, idle, file, mml }) {
  const section = page.locator('#final-delivery');

  // ── the two states are separate, and say which is which ──────────────────
  assert.equal(await section.count(), 1, 'the Final MML section must exist');
  assert.equal(await page.locator('#delivery').count(), 1, 'the acceptance section stays separate');
  assert.equal(await page.locator('#final-delivery h2').textContent(), '06　Final MML 產生與匯出');
  assert.equal(await page.locator('#delivery h2').textContent(), '07　Readiness 與實機接受');
  // Two sections both called "delivery" is exactly the ambiguity this avoids.
  assert.equal(await page.locator('nav a[href="#final-delivery"]').count(), 1);
  assert.equal(await page.locator('nav a[href="#delivery"]').count(), 1);

  // Before generating, the attempt card is empty and export is disabled: there
  // is no applied delivery to hand out, whatever the candidate happens to be.
  assert.ok((await section.textContent()).includes('尚未產生 Final MML'));
  assert.equal(await page.locator('#copy-final').isEnabled(), false);
  assert.equal(await page.locator('#download-final').isEnabled(), false);

  // ── generate ─────────────────────────────────────────────────────────────
  await page.locator('#generate-final').click();
  await page.locator('#final-mml').waitFor();
  await idle();

  const attempt = section.locator('.card', { hasText: '最近一次產生嘗試' });
  assert.equal(await attempt.locator('.badge').first().textContent(), 'PASS');
  const attemptText = await attempt.textContent();
  // The status is the emitter's, and the panel says so rather than letting a
  // green badge read as an in-game result.
  assert.ok(attemptText.includes('IN_GAME_ACCEPTED'), 'the attempt card must disclaim in-game acceptance');
  assert.ok(attemptText.includes('emitter／技術產生狀態'));

  // Six roles, with the emitter's own per-role figures.
  for (const role of ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']) {
    assert.ok(attemptText.includes(role), `the per-role table must list ${role}`);
  }
  assert.ok(attemptText.includes('/ 2400'), 'per-role character counts are shown against the published limit');
  assert.ok(attemptText.includes('空軌（保持空白）'), 'empty roles are reported as staying empty');
  // P1: a JavaScript string length is not a claim about the target client.
  assert.ok(attemptText.includes('JavaScript string length'));
  assert.ok(attemptText.includes('尚未驗證'));
  assert.ok(attemptText.includes('PENDING P1'));
  // G10, the round-trip and the Canonical identity the emitter actually used.
  assert.ok(attemptText.includes('安全格線'), 'the G10 safe grid is shown');
  assert.ok(attemptText.includes('保留區間') && attemptText.includes('拒絕區間') && attemptText.includes('封鎖區間'));
  assert.ok(attemptText.includes('往返讀回'), 'the emitter round-trip state is shown');
  assert.ok(attemptText.includes(PUBLISHED_CANONICAL.metadata.canonical_version), 'the Canonical release the emitter used is shown');
  assert.ok(attemptText.includes(PUBLISHED_CANONICAL.metadata.rules_snapshot_sha));

  const applied = section.locator('.card', { hasText: '目前套用的交付 MML' });
  assert.equal(await applied.count(), 1, 'the applied delivery is its own card, not part of the attempt');
  assert.ok((await applied.textContent()).includes('由本機 emitter 產生'), 'the applied delivery states its origin');
  // The delivery's PASS is a delivery-verification PASS and says so, so it
  // cannot be read as the project's state or as an in-game result.
  const appliedText = await applied.textContent();
  assert.ok(appliedText.includes('TECHNICAL_PASS'));
  assert.ok(appliedText.includes('VALIDATED') && appliedText.includes('IN_GAME_ACCEPTED'), 'it disclaims both higher states by name');

  // ── one string everywhere ────────────────────────────────────────────────
  const shown = await page.locator('#final-mml').inputValue();
  assert.ok(shown.startsWith('MML@') && shown.endsWith(';'), `unexpected Final MML: ${shown}`);
  assert.equal(shown, shown.trim(), 'the stored delivery carries no surrounding whitespace');

  // Copy: exactly what is displayed, not a re-render of it.
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
  });
  await page.locator('#copy-final').click();
  assert.equal(await page.evaluate(() => window.copied), shown, 'Copy must hand over the exact displayed string');

  // Download: the bytes handed to the Blob, captured before the browser's own
  // download plumbing, so this asserts the payload rather than the transport.
  await page.evaluate(() => {
    window.downloadedBlob = null;
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { window.downloadedBlob = blob; return original(blob); };
  });
  await page.locator('#download-final').click();
  const downloaded = await page.evaluate(() => window.downloadedBlob.text());
  assert.equal(downloaded, shown, 'Download must write the exact same string');
  assert.equal(await page.evaluate(() => window.downloadedBlob.type), 'text/plain');

  // The other button that also offers "the complete MML" must hand over the
  // same bytes. Two exports that read as equivalent and are not is the failure
  // this asserts away; the acceptance record binds this same string.
  await page.locator('#copy-mml').click();
  assert.equal(await page.evaluate(() => window.copied), shown, 'both whole-score copies must agree');

  // Per-role copy is the role body only, and is labelled as such.
  assert.ok((await applied.textContent()).includes('只會複製該角色的內容'));
  const melodyBody = await page.locator('#final-role-0').inputValue();
  await page.locator('[data-copy-role="0"]').click();
  assert.equal(await page.evaluate(() => window.copied), melodyBody);
  assert.notEqual(melodyBody, shown, 'a role body is not the whole six-role score');

  // ── clipboard refused: the fallback shows the identical string ───────────
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
  });
  // With the string already on screen, the fallback selects that field rather
  // than adding a second copy of the same text to the page.
  await page.locator('#copy-final').click();
  const selection = await page.evaluate(() => {
    const field = document.querySelector('#final-mml');
    return { value: field.value, selected: field.value.slice(field.selectionStart, field.selectionEnd), focused: document.activeElement === field };
  });
  assert.equal(selection.value, shown, 'the fallback must not rewrite the string');
  assert.equal(selection.selected, shown, 'the whole exact string is selected for manual copying');
  assert.ok(selection.focused);

  // With no such field on screen, a labelled read-only fallback is created, and
  // it carries the same bytes.
  await page.locator('#copy-mml').click();
  const fallback = page.locator('#copy-fallback');
  await fallback.waitFor();
  const fallbackText = await fallback.locator('textarea').inputValue();
  // `#copy-mml` hands over the verified delivery, which is the generated string
  // -- so the fallback is showing the same bytes the clipboard would have got.
  assert.equal(fallbackText, shown, 'the created fallback must carry the identical string');
  assert.equal(await fallback.locator('textarea').getAttribute('readonly'), '');
  // A second refusal replaces the fallback instead of stacking a second one.
  await page.locator('#copy-mml').click();
  assert.equal(await page.locator('#copy-fallback').count(), 1, 'fallbacks must never stack');
  await fallback.locator('button').click();
  assert.equal(await page.locator('#copy-fallback').count(), 0, 'the fallback can be dismissed');

  // Restore a working clipboard for whatever runs next.
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
  });

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the Final section must not overflow the viewport');

  // ── a superseded delivery does not survive the change that superseded it ──
  //
  // This is the reachable half of the staleness rule. `run()` serializes page
  // actions, so a generation already in flight cannot be overtaken by a user
  // action: the page-side re-check of the captured {projectId, revision} is
  // defence in depth for the day that changes, and the model-level guard is
  // covered by studio/tests/web-final-delivery.test.mjs. What a user *can* do is
  // change the candidate after a successful generation, and what must never
  // happen then is the old Final staying on screen and copyable.
  await file('candidate', mml.replace('o4c1', 'o4e1'), 'superseded.mml');
  await idle();
  assert.equal(await page.locator('.hero .badge').textContent(), 'CANDIDATE');
  assert.equal(await page.locator('#final-mml').count(), 0, 'the superseded delivery is gone, not merely greyed out');
  assert.equal(await page.locator('#copy-final').isEnabled(), false, 'a superseded Final must not stay copyable');
  assert.equal(await page.locator('#download-final').isEnabled(), false);
  const superseded = await page.locator('#final-delivery').textContent();
  assert.ok(superseded.includes('尚未產生 Final MML'), 'the attempt record is dropped with the delivery it described');
  assert.ok(!superseded.includes(shown), 'no part of the superseded string remains rendered');

  // And generation now refuses, because the change cleared every review.
  await page.locator('#generate-final').click();
  await idle();
  const blocked = await page.locator('#final-delivery').textContent();
  assert.ok(blocked.includes('在產生之前即被下列 Gate 擋下，未產生任何輸出'), 'a blocked attempt says so and emits nothing');
  assert.equal(await page.locator('#final-mml').count(), 0, 'a blocked attempt writes no delivery');
  assert.equal(await page.locator('#final-delivery .badge').first().textContent(), 'PENDING');

  // ── a refused attempt beside a valid pasted delivery ─────────────────────
  //
  // These two states genuinely coexist: the emitter must *produce* a string
  // under its own bounded search, while the delivery check only asks whether a
  // string it is handed is valid and reads back as the candidate. A user can
  // therefore hold a perfectly good pasted delivery that the emitter declines to
  // reproduce. The panel has to show both without letting the refusal read as
  // the delivery's status, or the delivery's badge as the attempt's.
  //
  // It is pasted *with surrounding whitespace* on purpose. A pasted delivery is
  // stored exactly as typed, so the raw stored field and the verified,
  // acceptance-bound form are then two different strings -- and every whole-score
  // surface has to agree on the second one. Generated output cannot exercise
  // this, because generation fails closed unless its string is already clean.
  const superseded_mml = mml.replace('o4c1', 'o4e1');
  await page.getByText('貼上 MML／Canonical IR，或附上交付 MML').click();
  await page.locator('#paste [name="slot"]').selectOption('delivery');
  await page.locator('#paste [name="content"]').fill(`\n  ${superseded_mml}\n\n`);
  await page.getByRole('button', { name: '在本機載入', exact: true }).click();
  await page.locator('#final-mml').waitFor();
  await idle();
  assert.ok((await page.locator('#final-delivery').textContent()).includes('使用者提供'), 'a pasted delivery is labelled as pasted, not as generated');

  // All four whole-score surfaces, against the verified form rather than the
  // padded text that was typed.
  assert.equal(await page.locator('#final-mml').inputValue(), superseded_mml, 'the panel displays the verified delivery, not the raw stored field');
  await page.locator('#copy-final').click();
  assert.equal(await page.evaluate(() => window.copied), superseded_mml, 'Copy Whole agrees');
  await page.evaluate(() => { window.downloadedBlob = null; });
  await page.locator('#download-final').click();
  assert.equal(await page.evaluate(() => window.downloadedBlob.text()), superseded_mml, 'Download agrees');
  await page.locator('#copy-mml').click();
  assert.equal(await page.evaluate(() => window.copied), superseded_mml, 'the acceptance section\'s whole-score copy agrees');

  await page.locator('#generate-final').click();
  await idle();
  const coexisting = await page.locator('#final-delivery').textContent();
  assert.ok(coexisting.includes('在產生之前即被下列 Gate 擋下'), 'the refused attempt is still reported');
  assert.ok(coexisting.includes('沒有覆寫任何內容'), 'and says plainly that it overwrote nothing');
  assert.equal(await page.locator('#final-mml').inputValue(), superseded_mml, 'the valid pasted delivery is untouched by the refusal');
  assert.ok((await page.locator('#final-delivery').textContent()).includes('使用者提供'), 'and is still not relabelled as generated');
  assert.equal(await page.locator('#copy-final').isEnabled(), true, 'a still-valid delivery stays exportable');
  await page.locator('#copy-final').click();
  assert.equal(await page.evaluate(() => window.copied), superseded_mml, 'and exports the pasted string, not the refused attempt');
}
