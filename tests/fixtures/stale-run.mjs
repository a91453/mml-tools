// A completed synthetic run whose status the MCP view compacts by size. Test-only
// reviewer inputs for a synthetic cue; never real-song, listening or game evidence.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactStudioResponse } from '../../server/mcp-compaction.mjs';
import { projectWithSymbolicAsset, runDecisionsFor, FIXTURE_CONFIRMATIONS } from '../../studio/tests/fixtures/run-fixtures.mjs';

/**
 * Complete a synthetic run through `application` (whose store lives in
 * `storeDirectory`), then bind `removed` extra asset digests the project does
 * not hold into its stored record. Each one is a real ASSET_REMOVED staleness
 * entry, as a run bound to many changed inputs reports. The status is then far
 * above the MCP view's size trigger, and the view summarizes both
 * run.inputs.asset_digests and the top-level `staleness` list.
 */
export async function staleCompletedRun(application, storeDirectory, owner, removed = 500) {
  const fixture = await projectWithSymbolicAsset(application, owner);
  const { run } = await application.startRun(owner, fixture.projectId, {
    asset_ids: [fixture.assetId], decisions: runDecisionsFor(fixture.project),
    accepted_by: 'fixture-run-reviewer', confirmations: FIXTURE_CONFIRMATIONS,
  });
  assert.equal(run.state, 'completed');
  assert.ok(run.final_artifact_id);
  const records = join(storeDirectory, 'records');
  const file = readdirSync(records).filter(name => name.endsWith('.json')).map(name => join(records, name))
    .find(path => JSON.parse(readFileSync(path, 'utf8')).project_id === fixture.projectId);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const stored = record.runs.find(entry => entry.run_id === run.run_id);
  for (let index = 0; index < removed; index += 1) {
    const hex = index.toString(16).padStart(32, '0');
    stored.inputs.asset_digests.push({ asset_id: `ast_${hex}`, kind: 'third_party_midi', sha256: hex.repeat(2), size: 1024 + index });
  }
  writeFileSync(file, JSON.stringify(record));
  const identity = { project_id: fixture.projectId, run_id: run.run_id };
  const status = JSON.parse(JSON.stringify(await application.getRun(owner, identity.project_id, identity.run_id)));
  assert.equal(status.run.state, 'completed', 'historical completion itself is unchanged');
  assert.equal(status.staleness.length, removed);
  const view = compactStudioResponse('studio_run_status', identity, status);
  assert.ok(view.response_compaction?.compacted.some(entry => entry.path.join('.') === 'staleness'),
    'precondition: the MCP view summarizes this status staleness list by size');
  assert.equal(view.staleness.compacted, true);
  return { ...identity, status, view };
}
