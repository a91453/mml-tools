// Synthetic browser regression only. No values or confirmations in this file
// are supplied to a real song, or offered as instrument recommendations.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { projectWithSymbolicAsset, runDecisionsFor, FIXTURE_CONFIRMATIONS } from '../tests/fixtures/run-fixtures.mjs';

export async function exerciseMobileReview({ page, app, owner, out }) {
  const fixture = await projectWithSymbolicAsset(app, owner);
  const started = await app.startRun(owner, fixture.projectId, {
    asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project), accepted_by: 'fixture-reviewer',
  });
  const runId = started.run.run_id;
  assert.equal(started.run.gates.mobile_adaptation, 'PENDING');
  const idle = () => page.waitForFunction(() => document.querySelector('#workspace').getAttribute('aria-busy') === 'false');
  const status = async () => (await app.getRun(owner, fixture.projectId, runId)).run;
  await page.locator('#refresh').click(); await idle();
  await page.locator('#projects').selectOption(fixture.projectId); await idle();
  assert.equal(await page.locator('#mobile-preview').isEnabled(), true);
  assert.equal(await page.locator('#mobile-apply').isEnabled(), false);
  assert.equal(await page.locator('#gate8-submit').isEnabled(), false);
  for (const input of await page.locator('#mobile-roles input').all()) assert.equal(await input.inputValue(), '');
  await page.locator('#mobile-profile-id').fill('synthetic-browser-profile');
  await page.locator('#mobile-reason').fill('Synthetic fixture target; exercise the real reviewer input path.');
  await page.locator('#mobile-evidence').fill('fixture:mobile-browser-calibration');
  await page.locator('#mobile-reviewer').fill('fixture-browser-reviewer');
  await page.locator('#mobile-Chord5-default').fill('9');
  await page.locator('#mobile-Chord5-delta').fill('-1');
  await page.locator('#mobile-preview').click(); await idle();
  assert.equal(await page.locator('#mobile-apply').isEnabled(), true);
  assert.equal((await status()).revision, started.run.revision, 'preview is read only');
  await page.locator('#mobile-reason').fill('Reworded synthetic fixture target.');
  assert.equal(await page.locator('#mobile-apply').isEnabled(), false, 'editing evidence invalidates the preview');
  await page.locator('#mobile-preview').click(); await idle();
  // A second reviewer advances the same run while the browser holds a plan.
  await app.resumeRun(owner, fixture.projectId, runId, { confirmations: {
    mobile_adaptation_reviewed: { value: false, candidate_id: started.run.candidate_id, reason: 'Fixture review remains open.' },
  } });
  const concurrentRevision = (await status()).revision;
  await page.locator('#mobile-apply').click(); await idle();
  assert.match(await page.locator('#message').textContent(), /revision 已變動/);
  assert.equal((await status()).revision, concurrentRevision, 'stale acceptance writes nothing');
  assert.equal(await page.locator('#mobile-apply').isEnabled(), false);
  await page.locator('#mobile-preview').click(); await idle();
  await page.locator('#mobile-plan details').evaluate(node => { node.open = true; });
  await page.locator('#mobile-workflow').screenshot({ path: join(out, 'mobile-profile-preview.png') });
  // Lose the response after a real adaptation. The UI must not silently retry.
  let lost = false;
  const resumeURL = `**/api/v1/projects/${fixture.projectId}/runs/${runId}/resume`;
  await page.route(resumeURL, async route => {
    if (!lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await page.locator('#mobile-apply').click(); await idle();
  assert.equal(lost, true);
  assert.equal(await page.locator('#mobile-apply').isEnabled(), false);
  const adapted = await status();
  assert.notEqual(adapted.candidate_id, started.run.candidate_id);
  assert.equal(adapted.gates.mobile_adaptation, 'PENDING');
  await page.unroute(resumeURL);
  await page.locator('#refresh').click(); await idle();
  assert.equal((await status()).revision, adapted.revision);
  assert.equal(await page.locator('#gate8-submit').isEnabled(), false);
  await page.locator('#review').click(); await idle();
  assert.equal(await page.locator('#gate8-submit').isEnabled(), true);
  const fillReview = async value => {
    await page.locator('#gate8-reviewer').fill('fixture-browser-reviewer');
    await page.locator('#gate8-outcome').selectOption(value);
    await page.locator('#gate8-reason').fill('Synthetic fixture candidate inspected after the volume-only adaptation.');
    await page.locator('#gate8-evidence').fill('fixture:mobile-browser-review');
  };
  await fillReview('true');
  // Stale review is rejected even if the candidate id itself did not change.
  await app.resumeRun(owner, fixture.projectId, runId, { confirmations: {
    mobile_adaptation_reviewed: { value: false, candidate_id: adapted.candidate_id, reason: 'Concurrent fixture reviewer.' },
  } });
  await page.locator('#gate8-submit').click(); await idle();
  assert.match(await page.locator('#message').textContent(), /revision 已變動/);
  assert.equal((await status()).gates.mobile_adaptation, 'PENDING');
  await page.locator('#review').click(); await idle(); await fillReview('false');
  await page.locator('#gate8-submit').click(); await idle();
  assert.equal((await status()).gates.mobile_adaptation, 'PENDING');
  await page.locator('#review').click(); await idle(); await fillReview('true');
  await page.locator('#gate8-evidence').fill('');
  const beforeEmpty = (await status()).revision;
  await page.locator('#gate8-submit').click(); await idle();
  assert.equal((await status()).revision, beforeEmpty, 'empty evidence cannot record a PASS');
  await page.locator('#gate8-evidence').fill('fixture:mobile-browser-review');
  await page.locator('#gate8-submit').click(); await idle();
  const reviewed = await status();
  assert.equal(reviewed.gates.mobile_adaptation, 'PASS');
  for (const gate of ['source', 'regression', 'audio', 'in_game']) assert.equal(reviewed.gates[gate], adapted.gates[gate]);
  assert.equal(reviewed.final_artifact_id, null);
  const stored = (await app.reviewCandidate(owner, fixture.projectId, { candidateId: adapted.candidate_id })).review.confirmations.mobile_adaptation_reviewed;
  assert.equal(stored.candidate_id, adapted.candidate_id);
  assert.match(stored.reason, /fixture-browser-reviewer/);
  assert.deepEqual(stored.evidence, ['fixture:mobile-browser-review']);
  // A further real change invalidates the preceding candidate's Gate 8 review.
  await page.locator('#mobile-Chord5-delta').fill('-2');
  await page.locator('#mobile-preview').click(); await idle();
  await page.locator('#mobile-apply').click(); await idle();
  const changed = await status();
  assert.notEqual(changed.candidate_id, reviewed.candidate_id);
  assert.equal(changed.gates.mobile_adaptation, 'PENDING');
  assert.equal(await page.locator('#gate8-submit').isEnabled(), false);
  await page.locator('#review').click(); await idle(); await fillReview('true');
  await page.locator('#gate8-submit').click(); await idle();
  // Other gates are supplied only at the explicitly labelled synthetic seam.
  const { mobile_adaptation_reviewed: _gate8, ...otherFixtureReviews } = FIXTURE_CONFIRMATIONS;
  const finished = await app.resumeRun(owner, fixture.projectId, runId, { confirmations: otherFixtureReviews });
  assert.equal(finished.run.state, 'completed');
  const artifact = (await app.getArtifact(owner, finished.run.final_artifact_id)).artifact;
  assert.equal(artifact.round_trip.status, 'PASS');
  assert.equal(artifact.gates.in_game, 'PENDING');
  await page.locator('#refresh').click(); await idle();
  assert.equal(await page.locator('#mobile-preview').isEnabled(), false, 'completed run is closed');
  assert.equal(await page.locator('#gate8-submit').isEnabled(), false);
  return { synthetic: true, profile_input_preview_apply: true, same_run: true,
    stale_preview_and_review_refused: true, lost_apply_response_readback: true,
    explicit_candidate_review: true, changed_candidate_reopens_gate8: true,
    final_round_trip: artifact.round_trip.status, in_game: artifact.gates.in_game };
}
