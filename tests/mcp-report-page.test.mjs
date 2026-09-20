import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleMcp } from '../server/mcp.mjs';
import { runStudioTool, STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';

const owner = 'owner:report-pages';
const project_id = `prj_${'1'.repeat(32)}`;
const candidate_id = `g11d:rev:${'2'.repeat(64)}`;
const hash = text => createHash('sha256').update(text).digest('hex');
async function rpc(application, name, args, caller = owner) {
  const response = await handleMcp(new Request('https://mml.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { application, owner: caller });
  const text = await response.text();
  return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

test('large reports survive the actual MCP response cap through exact, hash-bound pages', async () => {
  const app = createStudioApplication({});
  const report = { canonical: { status: 'CANONICAL_LOADED', rules_snapshot_sha: 'a'.repeat(40) },
    suggestion: { title: '真實字元邊界 🎹', rows: Array.from({ length: 6500 }, (_, i) => ({ event_id: `event:${i}`, evidence: '來源\\\"\n🎵'.repeat(10) })) } };
  const application = { ...app, suggestArrangement: async () => report };
  const original = JSON.stringify(report);
  assert.ok(Buffer.byteLength(original) > 524288);
  const unpaged = await rpc(application, 'studio_arrangement_suggest', { project_id });
  assert.equal(unpaged.body.result.structuredContent.error.code, 'PAYLOAD_TOO_LARGE');

  let offset = 0, expected_sha256, assembled = '', pages = 0;
  do {
    const { body, bytes } = await rpc(application, 'studio_arrangement_suggest', {
      project_id, report_page: { offset, ...(expected_sha256 ? { expected_sha256 } : {}) },
    });
    assert.equal(body.result.isError, false);
    assert.ok(bytes < 524288, 'even the duplicated MCP text/structured envelope must be bounded');
    const result = body.result.structuredContent;
    assert.deepEqual(JSON.parse(body.result.content[0].text), result);
    assert.deepEqual(result.canonical, report.canonical);
    const page = result.report_page;
    assert.equal(page.offset, offset);
    assert.equal(page.report_sha256, hash(original));
    assert.equal(page.value_sha256, hash(original));
    expected_sha256 = page.report_sha256;
    assembled += page.json_fragment;
    offset = page.next_offset;
    pages++;
  } while (offset !== null);
  assert.ok(pages > 30);
  assert.equal(assembled, original);
  assert.deepEqual(JSON.parse(assembled), report);
});

test('selected JSON values remain bound to the entire report and its current provenance', async () => {
  const app = createStudioApplication({});
  let report = { canonical: { rules_snapshot_sha: 'a'.repeat(40) }, review: { gates: [{ status: 'PENDING' }], events: [] } };
  const application = { ...app, reviewCandidate: async () => report };
  const args = { project_id, candidate_id, report_page: { path: ['review', 'gates', '0'], length: 4 } };
  const first = (await rpc(application, 'studio_candidate_review', args)).body.result.structuredContent.report_page;
  assert.equal(first.value_sha256, hash(JSON.stringify(report.review.gates[0])));
  assert.equal(first.report_sha256, hash(JSON.stringify(report)));
  report = { ...report, canonical: { rules_snapshot_sha: 'b'.repeat(40) } };
  const changed = (await rpc(application, 'studio_candidate_review', { ...args, report_page: {
    ...args.report_page, offset: first.next_offset, expected_sha256: first.report_sha256,
  } })).body.result;
  assert.equal(changed.isError, true);
  assert.equal(changed.structuredContent.error.details.reason, 'REPORT_CHANGED');
  assert.equal(changed.structuredContent.report_page, undefined);
});

test('unsafe paging requests are refused before any service call, including direct dispatch', async () => {
  let calls = 0;
  const context = { owner, application: new Proxy({}, { get: () => () => { calls++; return {}; } }) };
  const bad = [
    ['studio_finalize', { report_page: {} }],
    ['studio_run_resume', { report_page: {} }],
    ['studio_candidate_review', { confirmations: {}, report_page: {} }],
    ['studio_arrangement_suggest', { refresh: true, report_page: {} }],
    ['studio_artifact_get', { report_page: { offset: 1 } }],
    ['studio_artifact_get', { report_page: { length: 16001 } }],
    ['studio_artifact_get', { report_page: { path: ['__proto__'] } }],
    ['studio_artifact_get', { report_page: { expected_sha256: 'x'.repeat(64) } }],
  ];
  for (const [name, args] of bad) await assert.rejects(runStudioTool(name, args, context), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  for (const name of ['studio_finalize', 'studio_run_start', 'studio_proposal_resolve']) {
    assert.equal(STUDIO_MCP_TOOLS.find(tool => tool.name === name).inputSchema.properties.report_page, undefined);
  }
});

test('the MCP schema and dispatcher both enforce bounded, read-only paging', async () => {
  const app = createStudioApplication({});
  let calls = 0;
  const application = { ...app, reviewCandidate: async () => { calls++; return {}; } };
  for (const report_page of [{ length: 16001 }, { offset: -1 }, { path: 'review' }, { unknown: true }]) {
    const result = await rpc(application, 'studio_candidate_review', { project_id, candidate_id, report_page });
    assert.equal(result.body.error.code, -32602);
  }
  const refused = (await rpc(application, 'studio_candidate_review', { project_id, candidate_id, confirmations: {}, report_page: {} })).body.result;
  assert.equal(refused.structuredContent.error.details.reason, 'REPORT_PAGE_REQUIRES_READ');
  assert.equal(calls, 0);
});

test('paging retains ownership checks and leaves project state unchanged', async () => {
  const app = createStudioApplication({});
  const created = await app.createProject(owner, { title: 'Private project' });
  const before = await app.getProject(owner, created.project.project_id);
  const args = { project_id: created.project.project_id, report_page: { path: ['project', 'title'] } };
  const allowed = (await rpc(app, 'studio_project_get', args)).body.result;
  assert.equal(allowed.isError, false);
  assert.equal(JSON.parse(allowed.structuredContent.report_page.json_fragment), 'Private project');
  const refused = (await rpc(app, 'studio_project_get', args, 'owner:someone-else')).body.result;
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.report_page, undefined);
  const after = await app.getProject(owner, args.project_id);
  assert.deepEqual(after.project, before.project);
});

test('run plan paging is consumed by the transport and never becomes a service input', async () => {
  let received;
  const report = { operation: 'succeeded', plan: { state: 'awaiting_review' } };
  const result = await runStudioTool('studio_run_plan', { project_id, target_candidate_id: candidate_id, report_page: {} }, {
    owner, application: { planRun: async (...args) => { received = args; return report; } },
  });
  assert.deepEqual(received, [owner, project_id, { target_candidate_id: candidate_id }]);
  assert.deepEqual(JSON.parse(result.report_page.json_fragment), report);
});

test('JSON fragments reconstruct surrogate pairs and reject absent paths and out-of-range offsets', async () => {
  const report = { text: '🎵' };
  const context = { owner, application: { getArtifact: async () => report } };
  let assembled = '', offset = 0, expected_sha256;
  do {
    const result = await runStudioTool('studio_artifact_get', { report_page: {
      path: ['text'], offset, length: 1, ...(expected_sha256 ? { expected_sha256 } : {}),
    } }, context);
    const page = JSON.parse(JSON.stringify(result)).report_page;
    assembled += page.json_fragment;
    offset = page.next_offset;
    expected_sha256 = page.report_sha256;
  } while (offset !== null);
  assert.equal(JSON.parse(assembled), '🎵');
  for (const [options, reason] of [
    [{ path: ['absent'] }, 'REPORT_PATH_NOT_FOUND'],
    [{ offset: 500, expected_sha256 }, 'REPORT_OFFSET_OUT_OF_RANGE'],
  ]) {
    await assert.rejects(runStudioTool('studio_artifact_get', { report_page: options }, context),
      error => error.code === 'INVALID_REQUEST' && error.details.reason === reason);
  }
});
