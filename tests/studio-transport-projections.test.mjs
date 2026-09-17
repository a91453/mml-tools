// Transport parity — the reads an agent needs are reachable on both adapters.
//
// Lead evidence must cite the source identity of the event it is about, and a
// client that lost its project id must be able to find it again. Neither read
// belongs to a transport: both are Application Service reads, served
// identically over HTTP and MCP. These regressions pin that the per-event
// provenance of the Source-Faithful Baseline and the owner's project list are
// answered the same on both, and that the projection is read-only and paged.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { STUDIO_MCP_TOOLS } from '../server/mcp-studio.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { FIXTURE_SOURCE_ID, canonicalProjectBytes, sixRoleBaseline } from '../studio/tests/fixtures/application-fixtures.mjs';

const ORIGIN = 'https://mml.example';
const OWNER = 'owner:service';
const rpcHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function transports() {
  const application = createStudioApplication({ transports: ['http', 'mcp'] });
  const route = createApiRouter({ application, ownerOf: () => OWNER });
  const http = async (method, path, payload) => {
    const response = await route(new Request(`${ORIGIN}${API_PREFIX}${path}`, { method, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) }), { authenticated: true });
    return { status: response.status, body: await response.json() };
  };
  const mcp = async (name, args = {}) => {
    const response = await handleMcp(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: rpcHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { application, owner: OWNER });
    return (await response.json()).result;
  };
  return { application, http, mcp };
}

const stripTiming = value => JSON.parse(JSON.stringify(value, (key, entry) => (['created_at', 'updated_at', 'at', 'attached_at'].includes(key) ? undefined : entry)));

test('the per-event provenance of the baseline is one projection, served identically over HTTP and MCP', async () => {
  const { application, http, mcp } = transports();
  const fixture = sixRoleBaseline();
  const projectId = (await application.createProject(OWNER, { title: 'Provenance' })).project.project_id;
  await application.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes(fixture) });
  const { baseline } = await application.analyzeSources(OWNER, projectId);
  const { suggestion } = await application.suggestArrangement(OWNER, projectId);
  const laneId = Object.values(suggestion.roles).flatMap(entry => entry.lane_ids ?? []).concat(suggestion.pending.lanes.map(lane => lane.lane_id))[0];
  assert.ok(laneId, 'the suggestion names at least one lane');

  const overHttp = await http('GET', `/projects/${projectId}/baseline/events`);
  assert.equal(overHttp.status, 200, JSON.stringify(overHttp.body).slice(0, 200));
  const overMcp = await mcp('studio_baseline_events', { project_id: projectId });
  assert.equal(overMcp.isError, false, JSON.stringify(overMcp).slice(0, 200));
  assert.deepEqual(stripTiming(overMcp.structuredContent), stripTiming(overHttp.body), 'both transports serve the same projection');

  const projection = overHttp.body;
  assert.equal(projection.baseline_id, baseline.baseline_id);
  assert.equal(projection.total, fixture.events.length);
  assert.equal(projection.events.length, fixture.events.length);
  const noteEvents = projection.events.filter(event => event.kind === 'note');
  assert.ok(noteEvents.length > 0);
  for (const event of noteEvents) {
    assert.deepEqual(event.source_ids, [FIXTURE_SOURCE_ID], `${event.event_id} names its source`);
    assert.equal(event.source_event_ids.length, 1, `${event.event_id} names its source event`);
    assert.equal(typeof event.pitch, 'number');
  }
  const bytes = JSON.stringify(projection);
  assert.doesNotMatch(bytes, /"bytes"|base64/, 'identities and statistics only');

  const byLane = await http('GET', `/projects/${projectId}/baseline/events?lane_id=${encodeURIComponent(laneId)}`);
  assert.equal(byLane.status, 200);
  assert.equal(byLane.body.lane_id, laneId);
  assert.ok(byLane.body.total > 0 && byLane.body.total < projection.total, 'a lane is a strict subset of the baseline');
  const laneOverMcp = await mcp('studio_baseline_events', { project_id: projectId, lane_id: laneId });
  assert.deepEqual(stripTiming(laneOverMcp.structuredContent), stripTiming(byLane.body));

  const wanted = noteEvents.slice(0, 2).map(event => event.event_id);
  const byId = await http('GET', `/projects/${projectId}/baseline/events?event_ids=${encodeURIComponent(wanted.join(','))}`);
  assert.deepEqual(byId.body.events.map(event => event.event_id), wanted);

  const page = await http('GET', `/projects/${projectId}/baseline/events?limit=2`);
  assert.equal(page.body.events.length, 2);
  assert.equal(page.body.next_offset, 2);
  const next = await http('GET', `/projects/${projectId}/baseline/events?limit=2&offset=${page.body.next_offset}`);
  assert.equal(next.body.offset, 2);
  assert.notDeepEqual(next.body.events.map(event => event.event_id), page.body.events.map(event => event.event_id));

  for (const query of ['limit=0', 'limit=501', 'offset=-1', 'offset=x', `lane_id=${encodeURIComponent('lane:nope')}`]) {
    const refused = await http('GET', `/projects/${projectId}/baseline/events?${query}`);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.body.error.code, 'INVALID_REQUEST', query);
  }
  const unknownLane = await mcp('studio_baseline_events', { project_id: projectId, lane_id: 'lane:nope' });
  assert.equal(unknownLane.isError, true);
  assert.equal(unknownLane.structuredContent.error.code, 'INVALID_REQUEST');

  const before = stripTiming((await application.getProject(OWNER, projectId)).project);
  await http('GET', `/projects/${projectId}/baseline/events`);
  assert.deepEqual(stripTiming((await application.getProject(OWNER, projectId)).project), before, 'the projection writes nothing');
  const tool = STUDIO_MCP_TOOLS.find(entry => entry.name === 'studio_baseline_events');
  assert.equal(tool.annotations.readOnlyHint, true);
});

test('an owner can recover their project ids over MCP exactly as over HTTP', async () => {
  const { application, http, mcp } = transports();
  const ids = [];
  for (const title of ['First', 'Second']) ids.push((await application.createProject(OWNER, { title })).project.project_id);

  const overHttp = await http('GET', '/projects');
  assert.equal(overHttp.status, 200);
  const overMcp = await mcp('studio_project_get', {});
  assert.equal(overMcp.isError, false, JSON.stringify(overMcp).slice(0, 200));
  assert.deepEqual(stripTiming(overMcp.structuredContent), stripTiming(overHttp.body));
  assert.deepEqual(overMcp.structuredContent.projects.map(project => project.project_id).sort(), [...ids].sort());
  assert.doesNotMatch(JSON.stringify(overMcp.structuredContent), /"bytes"|base64/);

  const single = await mcp('studio_project_get', { project_id: ids[0] });
  assert.equal(single.structuredContent.project.project_id, ids[0], 'naming a project still reads that project');
  const missing = await mcp('studio_project_get', { project_id: 'prj_00000000000000000000000000000000' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'PROJECT_NOT_FOUND');

  const stranger = createApiRouter({ application, ownerOf: () => 'owner:stranger' });
  const response = await stranger(new Request(`${ORIGIN}${API_PREFIX}/projects`, { method: 'GET' }), { authenticated: true });
  assert.deepEqual((await response.json()).projects, [], 'a list is scoped to its owner');
});
