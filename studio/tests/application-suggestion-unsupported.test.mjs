// Studio Application Service — unsupported source material in a suggestion.
//
// G11-C keeps percussion-channel and percussion / drum / unsupported-tagged
// notes out of the pitched roles and reports them once, as unsupported source
// material (MASTER_RULES.md §8). The service used to hand the engine a lane
// decomposition of the WHOLE baseline, which put that material into a lane:
// the lane could then receive a pitched role (even Chord2) and every such note
// was counted twice, once in a lane and once as unsupported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication } from '../backend/application/index.mjs';
import { blobName } from '../backend/application/store.mjs';
import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { createCanonicalProject, createCanonicalNoteEvent } from '../backend/canonical/index.mjs';
import { canonicalProjectBytes, sixRoleBaseline, FIXTURE_SOURCE_ID } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:unsupported-material';
const DRUM_IDS = ['drum-0', 'drum-1', 'drum-2', 'drum-3'];
// The cache epoch whose blobs could still give percussion a pitched role.
const RETIRED_EPOCH = 'g11c-role-candidate-v2-merge-diagnostics';

const note = (id, pitch, start, end, voice, extra = {}) => createCanonicalNoteEvent({
  id,
  pitch,
  start,
  end,
  sourceIds: [FIXTURE_SOURCE_ID],
  sourceEventIds: [`${FIXTURE_SOURCE_ID}#${id}`],
  role: null,
  voice,
  volume: null,
  ...extra,
});

// A role-less lead line, a sustained accompaniment and a drum voice. The drum
// notes are tagged percussion (and one also sits on the GM drum channel).
function baselineWithTaggedPercussion() {
  const base = sixRoleBaseline({ id: 'fixture:tagged-percussion', title: 'Tagged percussion' });
  const events = [
    ...[72, 74, 76, 77, 79, 77, 76, 74].map((pitch, index) => note(`lead-${index}`, pitch, `${index}/2`, `${index + 1}/2`, 'lead')),
    ...[0, 1, 2, 3].map(index => note(`pad-${index}`, 60, String(index), String(index + 1), 'pad')),
    ...DRUM_IDS.map((id, index) => note(id, 36, String(index), String(index + 1), 'drums', {
      tags: ['percussion'],
      metadata: index === 0 ? { channel: 9 } : {},
    })),
  ];
  return createCanonicalProject({ ...base, events });
}

async function projectWithBaseline(app, baseline) {
  const project = (await app.createProject(OWNER, { title: baseline.title })).project;
  await app.uploadAsset(OWNER, project.project_id, {
    kind: 'canonical_project', filename: 'baseline.json', mediaType: 'application/json', bytes: canonicalProjectBytes(baseline),
  });
  const { baseline: analyzed } = await app.analyzeSources(OWNER, project.project_id);
  return { projectId: project.project_id, baselineId: analyzed.baseline_id };
}

function assertPercussionStaysUnsupported(suggestion) {
  // No role, and no lane at all, carries the percussion notes.
  for (const [role, entry] of Object.entries(suggestion.roles)) {
    assert.ok(entry.lane_ids.every(laneId => !laneId.startsWith('lane:drums')), `${role} must not receive the drum lane: ${entry.lane_ids}`);
  }
  assert.ok((suggestion.unassigned ?? []).every(entry => !entry.laneId.startsWith('lane:drums')), 'the drum lane must not be listed as unassigned pitched material');
  assert.equal(suggestion.lane_count, 2, 'only the lead and pad voices are decomposed into lanes');

  // Reported once, as unsupported.
  assert.deepEqual(suggestion.unsupported_source_material.map(item => item.eventId), DRUM_IDS);
  assert.deepEqual(suggestion.unsupported_source_material.map(item => item.status), DRUM_IDS.map(() => 'PENDING'));

  // Exact accounting: every source note is counted in exactly one bucket.
  const coverage = suggestion.coverage;
  assert.equal(coverage.complete, true);
  assert.equal(coverage.sourceEventCount, 16);
  assert.equal(coverage.unsupportedEventCount, 4);
  assert.equal(coverage.assignedEventCount + coverage.pendingEventCount + coverage.unassignedEventCount + coverage.unsupportedEventCount,
    coverage.sourceEventCount, JSON.stringify(coverage));
}

test('a percussion-tagged Canonical IR note never gets a pitched role or a second count in the service suggestion', async () => {
  const app = createStudioApplication({});
  const baseline = baselineWithTaggedPercussion();
  const { projectId } = await projectWithBaseline(app, baseline);

  const { suggestion } = await app.suggestArrangement(OWNER, projectId);
  assertPercussionStaysUnsupported(suggestion);

  // The service answers exactly what the engine answers on its own.
  const direct = suggestRoleCandidates(baseline);
  for (const [role, entry] of Object.entries(direct.roles)) {
    assert.deepEqual(suggestion.roles[role].lane_ids, [...entry.laneIds], `${role} differs from the engine's own suggestion`);
  }
  assert.deepEqual(suggestion.coverage, JSON.parse(JSON.stringify(direct.coverage)));

  // A lane id is resolved against the same suggestion; the drum lane does not exist.
  await assert.rejects(app.listBaselineEvents(OWNER, projectId, { laneId: 'lane:drums#0' }), /Unknown lane/);
});

test('a suggestion cached under a retired epoch is not served and is retired on rebuild', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mml-tools-suggestion-epoch-'));
  try {
    const app = createStudioApplication({ dataDirectory: directory, durability: 'persistent' });
    const { projectId, baselineId } = await projectWithBaseline(app, baselineWithTaggedPercussion());
    const { canonical } = await app.capabilities();

    // What a pre-fix deployment stored for this baseline: the drum lane in Chord2.
    const stale = {
      schema: 'mabinogi-mobile-mml-studio/role-candidate-arrangement@1',
      lanes: [{ id: 'lane:drums#0', eventIds: DRUM_IDS }],
      roles: { Chord2: { role: 'Chord2', laneIds: ['lane:drums#0'], eventIds: DRUM_IDS } },
      pending: [],
      coverage: null,
      core3: null,
      full6: null,
      unassigned: [],
      unsupportedSourceMaterial: [],
      diagnostics: [],
    };
    const stalePath = join(directory, 'blobs', `${blobName(`suggestion:${RETIRED_EPOCH}:${projectId}:${baselineId}:${canonical.rules_snapshot_sha}`)}.bin`);
    writeFileSync(stalePath, JSON.stringify(stale));

    const { suggestion } = await app.suggestArrangement(OWNER, projectId);
    assertPercussionStaysUnsupported(suggestion);
    assert.equal(existsSync(stalePath), false, 'the retired-epoch blob is removed once its replacement is derived');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
