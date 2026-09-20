// Studio Application Service — suggestion cache identity.
//
// The G11-C suggestion is derived from the baseline under the loaded Published
// Canonical. It is cached per baseline so repeated reads are cheap, but the
// cache must be keyed by the rules release too: an image rebuilt under a new
// Canonical release must not keep answering with lanes computed under the old
// one while its bindings claim the new snapshot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioApplication } from '../backend/application/index.mjs';
import { ENGINE_MODULES } from '../backend/application/provenance.mjs';
import { canonicalProjectBytes } from './fixtures/application-fixtures.mjs';

const OWNER = 'owner:alice';

// The real engines, loaded the way provenance.mjs loads them.
async function realEngines({ recordPublished } = {}) {
  const rules = await import(new URL(ENGINE_MODULES.rules, import.meta.resolve('../backend/application/index.mjs')).href);
  recordPublished?.(rules.PUBLISHED_CANONICAL);
  const entries = await Promise.all(Object.entries(ENGINE_MODULES).filter(([name]) => name !== 'rules')
    .map(async ([name, relative]) => [name, await import(new URL(relative, import.meta.resolve('../backend/application/index.mjs')).href)]));
  return { rules, ...Object.fromEntries(entries) };
}

test('a suggestion cached under one rules snapshot is recomputed under another', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mml-suggestion-cache-'));
  try {
    let recomputed = 0;
    const counting = engines => ({ ...engines, arrangement: { ...engines.arrangement, suggestRoleCandidates: (...args) => { recomputed += 1; return engines.arrangement.suggestRoleCandidates(...args); } } });

    const first = createStudioApplication({ dataDirectory: directory, durability: 'persistent', loadEngines: async ctx => counting(await realEngines(ctx)) });
    const project = (await first.createProject(OWNER, { title: 'Cache' })).project;
    await first.uploadAsset(OWNER, project.project_id, { kind: 'canonical_project', filename: 'b.json', mediaType: 'application/json', bytes: canonicalProjectBytes() });
    await first.analyzeSources(OWNER, project.project_id);
    const one = (await first.suggestArrangement(OWNER, project.project_id)).suggestion;
    const again = (await first.suggestArrangement(OWNER, project.project_id)).suggestion;
    assert.equal(recomputed, 1, 'the same release reuses the cached suggestion');
    assert.equal(again.bindings.laneDecompositionDigest, one.bindings.laneDecompositionDigest);

    // A later process over the same volume, under a different rules release.
    const otherSnapshot = 'f'.repeat(40);
    const second = createStudioApplication({
      dataDirectory: directory,
      durability: 'persistent',
      loadEngines: async ctx => {
        const engines = counting(await realEngines(ctx));
        return { ...engines, emitterContract: { ...engines.emitterContract, canonicalIdentity: () => ({ ...engines.emitterContract.canonicalIdentity(), rules_snapshot_sha: otherSnapshot }) } };
      },
    });
    const two = (await second.suggestArrangement(OWNER, project.project_id)).suggestion;
    assert.equal(two.bindings.canonicalRulesSnapshotSha, otherSnapshot);
    assert.equal(recomputed, 2, 'a different rules snapshot must not be answered from the old cache');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
