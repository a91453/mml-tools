// Actual browser/OAuth/API/MCP integration. Optional --midi uses a real source
// in fresh persistent test projects; real-source projects get no confirmations.
// Synthetic reviewer/export fixtures are separate and explicitly labelled.
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createApplication, createHttpServer, SERVICE_OWNER } from '../../railway/server.mjs';
import { createRemoteAgentClient } from '../../scripts/studio-agent-remote.mjs';
import { callAgentTool } from '../../scripts/studio-agent.mjs';
import { sixSourceVoices } from '../tests/fixtures/midi-fixtures.mjs';
import { projectWithSymbolicAsset, runDecisionsFor, FIXTURE_CONFIRMATIONS } from '../tests/fixtures/run-fixtures.mjs';

const { values } = parseArgs({ options: { midi: { type: 'string' }, out: { type: 'string' }, desktop: { type: 'boolean' } } });
const out = resolve(values.out ?? '.studio-agent/service-browser-' + Date.now()); await mkdir(out, { recursive: true });
// WebKit correctly refuses the Secure login cookie over plain loopback HTTP.
// Use a disposable test certificate, with trust scoped to this browser/context
// and the MCP probe, never a process-wide TLS override or a production key.
execFileSync(process.env.STUDIO_TEST_OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', join(out, 'test-only.key'), '-out', join(out, 'test-only.crt'), '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const key = await readFile(join(out, 'test-only.key')), cert = await readFile(join(out, 'test-only.crt'));
const source = values.midi ? await readFile(values.midi) : Buffer.from(sixSourceVoices());
const sourceName = values.midi ? basename(values.midi) : 'synthetic.mid';
const results = [];
for (const profile of [
  { name: 'desktop-chromium', engine: chromium, viewport: { width: 1440, height: 1000 } },
  ...values.desktop ? [] : [
    { name: 'iphone-webkit', engine: webkit, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: 'ipad-webkit', engine: webkit, viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
  ],
]) {
  let app, browser, origin;
  const handler = createHttpServer({ get origin() { return origin; }, fetch: request => app.fetch(request) }).listeners('request')[0];
  const server = createHttpsServer({ key, cert }, handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `https://127.0.0.1:${server.address().port}`;
  const password = 'SYNTHETIC_BROWSER_OWNER_PASSWORD_01234567890123456789';
  app = createApplication({ origin, ownerPassword: password, database: ':memory:',
    studioDataDirectory: join(out, profile.name, 'store'), studioDurability: 'persistent' });
  try {
    browser = await profile.engine.launch();
    const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, ignoreHTTPSErrors: true });
    const page = await context.newPage(), errors = []; let token;
    page.on('pageerror', error => errors.push(error.message));
    // Harness observes the actual bearer sent after browser login; never print
    // it or persist it. The MCP client uses the same authenticated service owner.
    page.on('request', request => { const auth = request.headers().authorization; if (auth?.startsWith('Bearer ')) token = auth.slice(7); });
    await page.goto(origin + '/studio/');
    await page.getByRole('button', { name: '登入服務', exact: true }).click();
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: '登入並允許', exact: true }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('aria-busy') === 'false');
    await page.locator('#create-project input').fill('Service browser test ' + sourceName);
    await page.getByRole('button', { name: '建立服務專案', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#project-identity').textContent.startsWith('prj_') && document.querySelector('#workspace').getAttribute('aria-busy') === 'false');
    const project_id = await page.locator('#project-identity').textContent();
    await page.locator('#midi').setInputFiles({ name: sourceName, mimeType: 'audio/midi', buffer: source });
    let lost = false;
    await page.route('**/api/v1/projects/*/runs', async route => {
      if (!lost && route.request().method() === 'POST') { lost = true; await route.fetch(); await route.abort(); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '上傳 MIDI 並啟動任務', exact: true }).click();
    await page.locator('#retry-start').waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('aria-busy') === 'false');
    const prior = await app.studio.getRun(SERVICE_OWNER, project_id);
    assert.equal(prior.runs.length, 1, 'the first response was lost after the real run was stored');
    await page.locator('#retry-start').click();
    await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'awaiting_review' && document.querySelector('#workspace').getAttribute('aria-busy') === 'false', null, { timeout: 120000 });
    const run_id = (await page.locator('#run-identity').textContent()).split(' · ')[0];
    assert.equal(run_id, prior.runs[0].run_id);
    assert.equal((await app.studio.getRun(SERVICE_OWNER, project_id)).runs.length, 1);
    assert.ok(token);
    const trustedFetch = (url, options) => new Promise((resolve, reject) => {
      assert.equal(new URL(url).origin, origin);
      const request = httpsRequest(url, { method: options.method, headers: options.headers, ca: cert, signal: options.signal }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      });
      request.on('error', reject); request.end(options.body);
    });
    const remote = createRemoteAgentClient({ origin, token, fetchImpl: trustedFetch });
    const call = (name, args) => callAgentTool(null, name, args, 'agent:codex', remote);
    const status = await call('studio_run_status', { project_id, run_id });
    assert.equal(status.run.run_id, run_id); assert.equal(status.run.state, 'awaiting_review');
    const targets = await call('studio_proposal_targets', { project_id, run_id });
    const proposal = await call('studio_proposal_submit', { project_id, run_id, request_key: targets.targets[0].request_key,
      kind: 'evidence_needed', proposed_by: 'agent:codex', rationale: 'Browser transport audit; musical role evidence remains unconfirmed.',
      missing_evidence: ['Source-confirmed role and Lead review; no acceptance in this transport test.'] });
    assert.ok(proposal.proposal?.proposal_id, JSON.stringify(proposal));
    await page.locator('#refresh').click();
    await page.locator('#proposals').getByRole('button').first().waitFor();
    await page.locator('#proposals').getByRole('button').first().click();
    await page.locator('#proposals summary').waitFor();
    await page.locator('#handoff').click(); await page.locator('#handoff-text').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#handoff-text').inputValue()).includes(run_id));
    assert.ok((await page.locator('#proposals').textContent()).includes(proposal.proposal.proposal_id), 'handoff refresh must preserve the proposal list');
    assert.equal(await page.locator('#download-final').isEnabled(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage, local: { ...localStorage } }));
    assert.ok(!storage.includes(token), 'bearer must not persist in browser storage');
    await page.screenshot({ path: join(out, profile.name + '.png'), fullPage: true });
    let fixtureReviewDownload = false;
    if (!values.midi) {
      // Reviewer statements are confined to a separate, synthetic Canonical
      // fixture. They are never applied to the uploaded MIDI test project.
      const fixture = await projectWithSymbolicAsset(app.studio, SERVICE_OWNER, { title: 'SYNTHETIC reviewer/export fixture' });
      const final = await app.studio.startRun(SERVICE_OWNER, fixture.projectId, {
        asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project),
        accepted_by: 'fixture-run-reviewer', confirmations: FIXTURE_CONFIRMATIONS,
      });
      assert.equal(final.run.state, 'completed');
      await page.locator('#refresh').click();
      await page.waitForFunction(() => document.querySelector('#workspace').getAttribute('aria-busy') === 'false');
      await page.locator('#projects').selectOption(fixture.projectId);
      await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'completed' && document.querySelector('#workspace').getAttribute('aria-busy') === 'false');
      await page.locator('#review').click();
      await page.locator('#review-summary summary').waitFor();
      const reportDownload = page.waitForEvent('download'); await page.locator('#save-review').click();
      const reportFile = await reportDownload;
      const downloadedReview = JSON.parse(await readFile(await reportFile.path(), 'utf8'));
      assert.deepEqual(downloadedReview, await app.studio.reviewCandidate(SERVICE_OWNER, fixture.projectId, { candidateId: final.run.candidate_id }));
      const mmlDownload = page.waitForEvent('download'); await page.locator('#download-final').click();
      const mmlFile = await mmlDownload;
      const artifact = (await app.studio.getArtifact(SERVICE_OWNER, final.run.final_artifact_id)).artifact;
      assert.equal(await readFile(await mmlFile.path(), 'utf8'), artifact.mml);
      assert.ok(artifact.mml.startsWith('MML@'));
      fixtureReviewDownload = true;
    }
    assert.deepEqual(errors, []);
    const result = { profile: profile.name, project_id, run_id, state: status.run.state, same_mcp_run: true,
      uncertain_start_replayed_same_run: true, proposal_visible: true, final_artifact_id: status.run.final_artifact_id,
      synthetic_fixture_review_and_download: fixtureReviewDownload };
    results.push(result); console.log(JSON.stringify(result));
    await page.reload(); await page.locator('#login').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#workspace').isVisible(), false);
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.close();
  }
}
await writeFile(join(out, 'verification.json'), JSON.stringify({ source: values.midi ? 'user-provided real MIDI' : 'synthetic regression fixture',
  source_sha256: createHash('sha256').update(source).digest('hex'), source_bytes: source.length,
  scope: 'Browser OAuth and shared HTTP/MCP project/run; not song, listening or game acceptance', results }, null, 2) + '\n');
