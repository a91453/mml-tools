import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication, createHttpServer, SERVICE_OWNER } from '../railway/server.mjs';
import { createRemoteAgentClient } from '../scripts/studio-agent-remote.mjs';
import { callAgentTool } from '../scripts/studio-agent.mjs';
import { sixSourceVoices } from '../studio/tests/fixtures/midi-fixtures.mjs';
import { readReportPage } from '../server/report-page.mjs';
import { staleCompletedRun } from './fixtures/stale-run.mjs';

// Actual OAuth consent/token exchange on a synthetic, isolated test service.
// No real user's password, grant or remote deployment is involved.
export async function startTestRemote(t, dataDirectory = null) {
  const origin = 'https://remote-agent-test.example';
  const password = 'SYNTHETIC_OWNER_PASSWORD_01234567890123456789';
  const verifier = 'synthetic_pkce_verifier_012345678901234567890123456789';
  const redirect = 'https://chatgpt.com/connector_platform/oauth_redirect';
  const app = createApplication({ origin, ownerPassword: password, database: ':memory:', studioDataDirectory: dataDirectory,
    studioDurability: dataDirectory ? 'persistent' : 'unknown' });
  const send = (path, options = {}) => app.fetch(new Request(origin + path, options));
  const form = (path, body, headers = {}) => send(path, { method: 'POST', body: new URLSearchParams(body), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  const client = await (await send('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Synthetic remote agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) })).json();
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'mml:read',
    resource: origin + '/mcp', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'synthetic' });
  const consent = await send('/oauth/authorize?' + params);
  const cookie = consent.headers.get('set-cookie').split(';')[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(await consent.text())[1];
  const approved = await form('/oauth/authorize', { csrf, password, decision: 'allow' }, { cookie, origin });
  assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const grant = await (await form('/oauth/token', { client_id: client.client_id, grant_type: 'authorization_code', code,
    redirect_uri: redirect, code_verifier: verifier, resource: origin + '/mcp' })).json();
  assert.ok(grant.access_token);
  const server = createHttpServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.close(); });
  return { app, origin: `http://127.0.0.1:${server.address().port}`, token: grant.access_token };
}

test('remote CLI uploads MIDI, starts/reopens the same run and saves hash-checked reports under real OAuth', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-remote-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const remote = await startTestRemote(t);
  let sequence = 0;
  const receipts = join(dir, 'client');
  async function command(args, status = 0) {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('../scripts/studio-agent.mjs', import.meta.url)),
      '--data-dir', receipts, '--actor', 'agent:codex', '--service-url', remote.origin, '--token-env', 'MML_TEST_REMOTE_TOKEN', ...args],
    { env: { ...process.env, MML_TEST_REMOTE_TOKEN: remote.token }, windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
    const [exit] = await once(proc, 'close');
    assert.equal(exit, status, stdout + stderr);
    assert.ok(!(stdout + stderr).includes(remote.token));
    return JSON.parse(stdout || stderr);
  }
  async function call(name, input, status = 0) {
    const path = join(dir, `request-${sequence++}.json`); writeFileSync(path, JSON.stringify(input));
    return command(['call', name, '--input', path], status);
  }
  assert.ok((await command(['tools'])).tools.some(tool => tool.name === 'studio_run_start'));
  const project_id = (await call('studio_project_create', { title: 'Remote synthetic MIDI' })).project.project_id;
  const source = join(dir, '合成.mid'); writeFileSync(source, sixSourceVoices());
  const asset = (await command(['upload', '--file', source, '--kind', 'third_party_midi', '--project-id', project_id])).asset;
  assert.equal(asset.filename, '合成.mid');
  const start = { project_id, asset_ids: [asset.asset_id], idempotency_key: 'remote-repeat' };
  const { run } = await call('studio_run_start', start);
  assert.equal(run.halt.reason, 'AWAITING_ACCEPTED_DECISIONS');
  assert.equal((await call('studio_run_start', start)).run.run_id, run.run_id);
  assert.equal((await call('studio_run_status', { project_id, run_id: run.run_id })).run.revision, run.revision);
  const out = join(dir, 'suggestion.json');
  await command(['report', '--kind', 'suggestion', '--project-id', project_id, '--out', out]);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), await remote.app.studio.suggestArrangement(SERVICE_OWNER, project_id));
  const denied = await call('studio_run_resume', { project_id, run_id: run.run_id, confirmations: {} }, 1);
  assert.equal(denied.error.code, 'AGENT_INPUT_REFUSED');
  const exported = join(dir, 'blocked.mml');
  await command(['export', '--project-id', project_id, '--run-id', run.run_id, '--out', exported], 1);
  assert.equal(existsSync(exported), false);
  assert.equal(existsSync(join(receipts, 'store')), false, 'remote mode creates no parallel local project store');
  const logs = readdirSync(join(receipts, 'receipts')).map(name => readFileSync(join(receipts, 'receipts', name), 'utf8'));
  assert.ok(logs.length >= 9);
  for (const text of logs) {
    assert.ok(!text.includes(remote.token));
    const receipt = JSON.parse(text);
    assert.equal(receipt.owner, null);
    assert.equal(receipt.service_origin, remote.origin);
    assert.equal(receipt.actor, 'agent:codex');
  }
});

test('remote client rejects unsafe endpoints, preserves uncertain outcomes and never retries a mutation', async () => {
  for (const origin of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=x']) {
    assert.throws(() => createRemoteAgentClient({ origin, token: 'synthetic' }), { code: 'REMOTE_CONFIGURATION' });
  }
  let calls = 0;
  const remote = createRemoteAgentClient({ origin: 'https://example.com', token: 'SYNTHETIC_SECRET', fetchImpl: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw Error('SYNTHETIC_SECRET must never reach receipt');
  } });
  const outcome = await callAgentTool(null, 'studio_project_create', { title: 'x' }, 'agent:codex', remote);
  assert.equal(outcome.error.code, 'REMOTE_REQUEST_UNCERTAIN');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_SECRET'));
  await assert.rejects(callAgentTool(null, 'studio_candidate_review', { confirmations: {} }, 'agent:codex', remote), { code: 'AGENT_INPUT_REFUSED' });
  assert.equal(calls, 1, 'agent policy rejects before any remote request');
});

test('remote complete reads verify Unicode content, stale refusals and tampered page hashes', async () => {
  const remote = createRemoteAgentClient({ origin: 'https://example.com', token: 'synthetic' });
  const report = { suggestion: { text: '音樂🎵'.repeat(15000) } };
  let calls = 0;
  const invoke = async (_name, args) => {
    calls++;
    return readReportPage(report, { path: [], offset: args.report_page.offset, length: 16000, expected_sha256: args.report_page.expected_sha256 });
  };
  assert.deepEqual(await remote.read('studio_arrangement_suggest', {}, invoke), report);
  assert.ok(calls > 1);
  await assert.rejects(remote.read('studio_arrangement_suggest', {}, async (name, args) => {
    const result = await invoke(name, args);
    result.report_page.json_fragment = result.report_page.json_fragment.replace('音', '樂');
    return result;
  }), { code: 'REMOTE_REPORT_INVALID' });
  await assert.rejects(remote.read('studio_arrangement_suggest', {}, async (_name, args) => args.report_page.offset
    ? { error: { code: 'INVALID_REQUEST', message: 'changed', details: { reason: 'REPORT_CHANGED' } } } : invoke(_name, args)),
  error => error.remoteResult.error.details.reason === 'REPORT_CHANGED');
  await assert.rejects(remote.read('studio_run_start', {}, invoke), { code: 'REMOTE_CONFIGURATION' });
});

// The agent CLI in remote mode, as a separate process: the in-process test
// service must keep answering while it runs.
async function remoteAgent({ origin, token }, dataDirectory, args, status) {
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../scripts/studio-agent.mjs', import.meta.url)),
    '--data-dir', dataDirectory, '--actor', 'agent:codex', '--service-url', origin, '--token-env', 'MML_TEST_REMOTE_TOKEN', ...args],
  { env: { ...process.env, MML_TEST_REMOTE_TOKEN: token }, windowsHide: true });
  let stdout = '', stderr = '';
  proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
  const [exit] = await once(proc, 'close');
  assert.equal(exit, status, stdout + stderr);
  return JSON.parse(stdout || stderr);
}

// An MCP endpoint whose report_page reads are cut from fixed results -- here a
// bounded MCP view rather than the result itself. Synthetic; no OAuth.
async function pagedViewService(t, results) {
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const { id, params } = JSON.parse(text);
    const { report_page: page } = params.arguments;
    const structuredContent = readReportPage(results[params.name], {
      path: page.path ?? [], offset: page.offset ?? 0, length: page.length ?? 16000, expected_sha256: page.expected_sha256,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, token: 'SYNTHETIC_PAGED_VIEW_TOKEN' };
}

test('remote export never writes the Final of a stale run whose MCP view compacts the staleness list', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-remote-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const storeDirectory = join(dir, 'service');
  const remote = await startTestRemote(t, storeDirectory);
  const { project_id, run_id, status, view } = await staleCompletedRun(remote.app.studio, storeDirectory, SERVICE_OWNER);
  const artifact = JSON.parse(JSON.stringify(await remote.app.studio.getArtifact(SERVICE_OWNER, status.run.final_artifact_id)));
  const request = join(dir, 'status.json');
  writeFileSync(request, JSON.stringify({ project_id, run_id }));

  // The service itself: a remote call is the bounded view, and the export
  // reassembles the whole status through report_page, so it sees and keeps
  // every staleness entry.
  const client = join(dir, 'client');
  const called = await remoteAgent(remote, client, ['call', 'studio_run_status', '--input', request], 0);
  assert.equal(called.staleness.compacted, true, 'precondition: a remote call returns the compacted view');
  assert.equal(called.staleness.total, status.staleness.length);
  const output = join(dir, 'stale.mml');
  const refused = await remoteAgent(remote, client, ['export', '--project-id', project_id, '--run-id', run_id, '--out', output], 1);
  assert.equal(refused.error.code, 'AGENT_INPUT_REFUSED');
  assert.deepEqual(refused.error.details, {
    run_id, staleness: status.staleness, staleness_notice: status.staleness_notice, canonical: status.canonical,
  }, 'the refusal keeps the whole reassembled staleness list');
  assert.equal(existsSync(output), false);

  // A service whose paged status is cut from the compacted view (with or
  // without its response_compaction marker): the guard cannot see the list,
  // so it refuses rather than exporting.
  const { response_compaction: _marker, ...unmarked } = view;
  for (const [label, served] of [['marked view', view], ['unmarked view', unmarked]]) {
    const paged = await pagedViewService(t, { studio_run_status: served, studio_artifact_get: artifact });
    const out = join(dir, `${label.replace(' ', '-')}.mml`);
    const result = await remoteAgent(paged, join(dir, `client-${label.replace(' ', '-')}`),
      ['export', '--project-id', project_id, '--run-id', run_id, '--out', out], 1);
    assert.equal(existsSync(out), false, `${label}: no Final of a stale run is written`);
    assert.equal(result.error.code, 'AGENT_INPUT_REFUSED', label);
    assert.match(result.error.message, /not read whole/, label);
    assert.equal(result.error.details.staleness.compacted, true, `${label}: the refusal records what it was given`);
  }
});

// Every condition the export's fail-closed guard checks, one at a time, from a
// status and artifact the export accepts: each alone must refuse and write
// nothing, so none of them can be dropped without a test noticing.
test('remote export refuses each malformed status or artifact read on its own', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-remote-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const storeDirectory = join(dir, 'service');
  const remote = await startTestRemote(t, storeDirectory);
  const { project_id, run_id, status } = await staleCompletedRun(remote.app.studio, storeDirectory, SERVICE_OWNER);
  const artifact = JSON.parse(JSON.stringify(await remote.app.studio.getArtifact(SERVICE_OWNER, status.run.final_artifact_id)));
  const { response_compaction: _none, ...whole } = JSON.parse(JSON.stringify(status));
  const fresh = { ...whole, staleness: [] };

  const exportWith = async (label, served, exit) => {
    const paged = await pagedViewService(t, served);
    const out = join(dir, `${label}.mml`);
    const result = await remoteAgent(paged, join(dir, `client-${label}`), ['export', '--project-id', project_id, '--run-id', run_id, '--out', out], exit);
    return { result, written: existsSync(out) };
  };

  // The control: a whole, fresh status and the Final it names export.
  const accepted = await exportWith('control', { studio_run_status: fresh, studio_artifact_get: artifact }, 0);
  assert.equal(accepted.written, true, `precondition: the unmodified reads export (${JSON.stringify(accepted.result).slice(0, 300)})`);

  const cases = {
    'status-compaction-marker': { studio_run_status: { ...fresh, response_compaction: { compacted: [] } }, studio_artifact_get: artifact },
    'status-other-run': { studio_run_status: { ...fresh, run: { ...fresh.run, run_id: `${run_id}-other` } }, studio_artifact_get: artifact },
    'run-without-candidate': { studio_run_status: { ...fresh, run: { ...fresh.run, candidate_id: '' } }, studio_artifact_get: artifact },
    // Missing on both sides, so the candidate match alone cannot catch it.
    'no-candidate-anywhere': { studio_run_status: { ...fresh, run: { ...fresh.run, candidate_id: undefined } }, studio_artifact_get: { ...artifact, artifact: { ...artifact.artifact, candidate_id: undefined } } },
    'artifact-compaction-marker': { studio_run_status: fresh, studio_artifact_get: { ...artifact, response_compaction: { compacted: [] } } },
    'artifact-other-id': { studio_run_status: fresh, studio_artifact_get: { ...artifact, artifact: { ...artifact.artifact, artifact_id: `${artifact.artifact.artifact_id}-other` } } },
  };
  for (const [label, served] of Object.entries(cases)) {
    const { result, written } = await exportWith(label, served, 1);
    assert.equal(written, false, `${label}: nothing is written`);
    assert.equal(result.error?.code, 'AGENT_INPUT_REFUSED', `${label}: ${JSON.stringify(result).slice(0, 300)}`);
  }
});
