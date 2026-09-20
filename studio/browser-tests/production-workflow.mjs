// Shared by the live, interactive driver and the existing local browser CI.
// Only a new isolated project is mutated. No reviewer confirmations or retries.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRemoteAgentClient } from '../../scripts/studio-agent-remote.mjs';

export async function exerciseProductionWorkspace({ page, origin, token, source, sourceName,
  fetchImpl = fetch, checkpoint = async () => {} }) {
  const evidence = { status: 'IN_PROGRESS', profile: 'current-browser', project_id: null, run_id: null,
    source_kind: 'third_party_midi', source_sha256: createHash('sha256').update(source).digest('hex'),
    source_bytes: source.length, checked: [] };
  const record = async name => { evidence.pending_step = null; evidence.checked.push(name); await checkpoint({ ...evidence, checked: [...evidence.checked] }); };
  const pending = async name => { evidence.pending_step = name; await checkpoint({ ...evidence, checked: [...evidence.checked] }); };
  const idle = () => page.waitForFunction(() => document.querySelector('#workspace')?.getAttribute('aria-busy') === 'false');
  await page.locator('#workspace').waitFor({ state: 'visible' }); await idle();
  assert.equal(new URL(page.url()).origin, origin);
  const title = 'E2E acceptance ' + randomUUID();
  evidence.project_title = title;
  await pending('create-project');
  await page.locator('#create-project input').fill(title);
  await page.getByRole('button', { name: '建立服務專案', exact: true }).click(); await idle();
  assert.equal(await page.locator('#projects option:checked').textContent(), title, 'a new isolated project must be selected');
  evidence.project_id = (await page.locator('#project-identity').textContent()).trim();
  assert.match(evidence.project_id, /^prj_[0-9a-f]{32}$/);
  await record('new-isolated-project');
  await pending('upload-midi-and-start-run');
  await page.locator('#source-kind').selectOption('third_party_midi');
  await page.locator('#midi').setInputFiles({ name: sourceName, mimeType: 'audio/midi', buffer: source });
  await page.getByRole('button', { name: '上傳 MIDI 並啟動任務', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#run-state')?.textContent === 'awaiting_review'
    && document.querySelector('#workspace')?.getAttribute('aria-busy') === 'false', null, { timeout: 120000 });
  evidence.run_id = (await page.locator('#run-identity').textContent()).split(' · ')[0];
  assert.match(evidence.run_id, /^run_[0-9a-f]{32}$/);
  await record('browser-upload-and-run-awaiting-review');
  assert.ok(token(), 'bearer observed from actual browser OAuth session');
  const remote = createRemoteAgentClient({ origin, token: token(), fetchImpl });
  const call = async (name, args) => {
    const result = await remote.call(name, args);
    assert.ok(!result.error, 'MCP operation failed: ' + name);
    return result;
  };
  const input = { project_id: evidence.project_id, run_id: evidence.run_id };
  const read = name => remote.read(name, input, (tool, args) => call(tool, args));
  const names = new Set((await remote.list()).map(tool => tool.name));
  for (const name of ['studio_run_status', 'studio_proposal_targets', 'studio_proposal_submit', 'studio_proposal_status']) assert.ok(names.has(name));
  const status = await read('studio_run_status');
  assert.equal(status.run.run_id, evidence.run_id); assert.equal(status.run.state, 'awaiting_review');
  assert.ok(!status.staleness?.length); assert.equal(status.run.final_artifact_id, null);
  assert.equal(await page.locator('#run-identity').textContent(), `${evidence.run_id} · revision ${status.run.revision}`);
  evidence.revision = status.run.revision; evidence.halt_reason = status.run.halt?.reason;
  await record('same-browser-and-mcp-run-and-revision');
  const targets = await read('studio_proposal_targets');
  assert.ok(targets.targets?.length, 'awaiting-review target is required');
  await pending('submit-evidence-needed-proposal');
  const proposal = await call('studio_proposal_submit', { ...input, request_key: targets.targets[0].request_key,
    kind: 'evidence_needed', proposed_by: 'agent:production-e2e',
    rationale: 'Transport acceptance only. No source, Lead, Core3 or game acceptance is asserted.',
    missing_evidence: ['Source-confirmed role review and human evidence remain required.'] });
  evidence.proposal_id = proposal.proposal?.proposal_id;
  assert.ok(evidence.proposal_id);
  await record('mcp-evidence-needed-proposal-created');
  await page.locator('#refresh').click(); await idle();
  const proposalButton = page.locator('#proposals').getByRole('button').filter({ hasText: evidence.proposal_id });
  await proposalButton.click(); await idle();
  assert.ok((await page.locator('#proposals details').textContent()).includes(evidence.proposal_id));
  await page.locator('#handoff').click(); await idle();
  const handoff = await page.locator('#handoff-text').inputValue();
  for (const value of [origin, evidence.project_id, evidence.run_id]) assert.ok(handoff.includes(value));
  assert.ok((await page.locator('#proposals').textContent()).includes(evidence.proposal_id));
  const after = await read('studio_run_status');
  assert.equal(after.run.state, 'awaiting_review'); assert.equal(after.run.final_artifact_id, null);
  assert.ok(!after.staleness?.length);
  assert.equal(await page.locator('#download-final').isEnabled(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const storage = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
  assert.ok(!storage.includes(token()), 'bearer must stay out of persistent browser storage');
  await record('proposal-visible-handoff-preserved-final-blocked');
  await page.reload(); await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace').isVisible(), false);
  // Independent MCP read after reload proves remote state survived loss of page state.
  // It is not evidence of survival across a server restart.
  assert.equal((await read('studio_run_status')).run.run_id, evidence.run_id);
  await record('reload-requires-login-remote-run-remains');
  evidence.status = 'PASS'; await checkpoint(evidence);
  return evidence;
}
