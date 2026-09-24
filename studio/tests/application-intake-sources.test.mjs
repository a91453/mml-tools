// Intake over several sources: the same file under two kinds, and the reasons
// a merged baseline is incomplete.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStudioApplication } from '../backend/application/index.mjs';
import { buildMidi, buildTrack } from './fixtures/midi-fixtures.mjs';

const OWNER = 'owner:intake-sources';
const encoder = new TextEncoder();
const musicxml = ({ grace = false, pitch = 'C' } = {}) => `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${grace ? '<note><grace/><pitch><step>D</step><octave>4</octave></pitch><type>eighth</type></note>' : ''}<note><pitch><step>${pitch}</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;

test('the same file selected under two source kinds is refused by name, not as an internal error', async () => {
  const app = createStudioApplication({});
  const projectId = (await app.createProject(OWNER, { title: 'twice' })).project.project_id;
  const bytes = buildMidi({ tracks: [buildTrack([[0, 0x90, 60, 100], [360, 0x80, 60, 0]])] });
  const official = (await app.uploadAsset(OWNER, projectId, { kind: 'official_midi', filename: 'a.mid', mediaType: 'audio/midi', bytes })).asset;
  const thirdParty = (await app.uploadAsset(OWNER, projectId, { kind: 'third_party_midi', filename: 'b.mid', mediaType: 'audio/midi', bytes })).asset;
  await assert.rejects(app.analyzeSources(OWNER, projectId), error => {
    assert.equal(error.code, 'UNSUPPORTED_SOURCE');
    assert.deepEqual(error.details.asset_ids.sort(), [official.asset_id, thirdParty.asset_id].sort());
    assert.deepEqual(error.details.kinds.sort(), ['official_midi', 'third_party_midi']);
    return true;
  });
  // Either one alone is an ordinary source.
  const { baseline } = await app.analyzeSources(OWNER, projectId, { assetIds: [official.asset_id] });
  assert.equal(baseline.note_event_count, 1);
});

test('a merged baseline reports the reasons its inputs gave', async () => {
  const app = createStudioApplication({});
  const projectId = (await app.createProject(OWNER, { title: 'merged' })).project.project_id;
  const graced = (await app.uploadAsset(OWNER, projectId, { kind: 'official_musicxml', filename: 'a.xml', mediaType: 'application/xml', bytes: encoder.encode(musicxml({ grace: true })) })).asset;
  await app.uploadAsset(OWNER, projectId, { kind: 'third_party_musicxml', filename: 'b.xml', mediaType: 'application/xml', bytes: encoder.encode(musicxml({ pitch: 'E' })) });
  const single = (await app.analyzeSources(OWNER, projectId, { assetIds: [graced.asset_id] })).baseline;
  assert.deepEqual(single.unsupported, { GRACE_NOTE: 1 });
  const merged = (await app.analyzeSources(OWNER, projectId)).baseline;
  assert.equal(merged.source_complete, false);
  assert.deepEqual(merged.unsupported, { GRACE_NOTE: 1 }, 'the incomplete input says why');
});
