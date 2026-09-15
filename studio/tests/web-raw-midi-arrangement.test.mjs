import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeMidi, newWorkspace, analyzeWorkspace, recordReview, REVIEW_NAMES } from '../web/model.mjs';
import { RAW_MIDI_PIPELINE, deriveArrangement, midiSourceId } from '../web/midi-source.mjs';
import { sha256Hex } from '../backend/source/index.mjs';
import { splitProjectSourceVoices, suggestRoleCandidates, CORE3_ROLE_NAMES, ENRICHMENT_ROLE_NAMES, SIX_ROLES } from '../backend/arrangement/index.mjs';
import { mergeCanonicalProjects } from '../backend/canonical/merge.mjs';
import { analyzeProjectMicroTiming } from '../backend/canonical/micro-timing.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// G11-B and G11-C reached through the Studio Web integration.
//
// The stage suites prove what each stage does. What this file proves is that
// the Web caller reaches them without changing anything: it supplies no role
// overrides, no role evidence and no duplications, it does not merge the
// candidate into the source project, and every protection merged in PR #19
// still holds when the provenance underneath is a raw MIDI file.

const asset = (name, bytes) => intakeMidi({ name, bytes });
// Expectations about provenance are derived from the bytes, never typed in.
// Hand-written ids were what let a random UUID reach Canonical identity
// unnoticed, because every test supplied its own.
const sourceIdOf = bytes => midiSourceId(sha256Hex(bytes));
const arrangementFor = (name, bytes) => {
  const record = asset(name, bytes);
  return { record, arrangement: deriveArrangement(record.project, { sourceSha256: record.source.sha256 }) };
};

const settings = { meterText: '0 4/4', recording: 'synthetic', offset: '0', end: '2', audioRequired: 'no', preview: 'none' };
const workspaceWith = record => ({ ...newWorkspace(), title: 'fixture', settings, assets: { candidate: record } });

// ─── the Web caller adds nothing ────────────────────────────────────────────

test('the Web integration calls G11-C with the project and no caller options', () => {
  const { record, arrangement } = arrangementFor('six.mid', fixtures.sixSourceVoices());
  // If any override, evidence entry, duplication or section were injected on
  // the way through, this would differ.
  assert.equal(JSON.stringify(arrangement.candidate), JSON.stringify(suggestRoleCandidates(record.project)));
  assert.equal(arrangement.pipeline, RAW_MIDI_PIPELINE);
  assert.equal(arrangement.stage, 'G11-C');
});

test('deriving the arrangement leaves the Source-Faithful project untouched', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const before = JSON.stringify(record.project);
  deriveArrangement(record.project, { sourceSha256: record.source.sha256 });
  assert.equal(JSON.stringify(record.project), before);
  // Roles are a candidate, never source truth: the source events still have none.
  for (const event of record.project.events) assert.equal(event.role, null);
});

// ─── G11-B ──────────────────────────────────────────────────────────────────

test('G11-B loses and duplicates nothing on the way through the Web path', () => {
  for (const [name, bytes] of [
    ['format0', fixtures.format0()],
    ['format1', fixtures.format1()],
    ['overlap', fixtures.overlappingSamePitch()],
    ['six', fixtures.sixSourceVoices()],
    ['rational', fixtures.rationalTiming()],
  ]) {
    const { record, arrangement } = arrangementFor(`${name}.mid`, bytes);
    const split = arrangement.voiceSplit;
    const sourceIds = record.project.events.map(event => event.id).sort();

    assert.deepEqual(split.missingEventIds, [], `${name}: no event may be lost`);
    assert.deepEqual(split.duplicatedEventIds, [], `${name}: no event may be duplicated`);
    assert.equal(split.inputEventCount, sourceIds.length);
    assert.equal(split.outputEventCount, sourceIds.length);
    assert.equal(split.complete, true);

    // Not just counts: the identities themselves.
    const laneIds = split.groups.flatMap(group => group.lanes.flatMap(lane => lane.eventIds)).sort();
    assert.deepEqual(laneIds, sourceIds, `${name}: lane membership must be exactly the source event set`);
  }
});

test('G11-B lanes are a pure function of the source event set, not of array order', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const canonical = JSON.stringify(deriveArrangement(record.project, { sourceSha256: record.source.sha256 }).voiceSplit);

  // A deterministic shuffle: browser enumeration order, a Worker's transfer or
  // a storage round trip must not be able to change a lane decision.
  const rotations = [1, 3, 7, record.project.events.length - 1];
  for (const offset of rotations) {
    const events = record.project.events.map((_, index, array) => array[(index + offset) % array.length]);
    const shuffled = { ...record.project, events };
    assert.equal(JSON.stringify(deriveArrangement(shuffled, { sourceSha256: record.source.sha256 }).voiceSplit), canonical,
      `rotation by ${offset} must not change the decomposition`);
  }
  const reversed = { ...record.project, events: [...record.project.events].reverse() };
  assert.equal(JSON.stringify(deriveArrangement(reversed, { sourceSha256: record.source.sha256 }).voiceSplit), canonical);
});

test('polyphony is decomposed and a same-pitch restrike stays two lanes', () => {
  const overlap = arrangementFor('overlap.mid', fixtures.overlappingSamePitch()).arrangement;
  assert.equal(overlap.voiceSplit.maxPolyphony, 2);
  assert.equal(overlap.voiceSplit.laneCount, 2, 'the second strike is a second lane, never a merge');
  assert.equal(overlap.voiceSplit.groups[0].lanes.reduce((total, lane) => total + lane.noteCount, 0), 2);
});

test('six concurrent source voices are all preserved and each stays explainable', () => {
  const { record, arrangement } = arrangementFor('six.mid', fixtures.sixSourceVoices());
  assert.equal(arrangement.voiceSplit.sourceVoiceCount, 6);
  assert.equal(arrangement.voiceSplit.laneCount, 6, 'no source voice is dropped before role reduction');

  const candidate = arrangement.candidate;
  assert.equal(candidate.lanes.length, 6);
  assert.equal(candidate.coverage.complete, true);
  assert.equal(candidate.coverage.sourceEventCount, record.project.events.length);
  assert.deepEqual([...candidate.coverage.missingEventIds], []);
  assert.deepEqual([...candidate.coverage.unknownEventIds], []);
  assert.deepEqual([...candidate.coverage.mutatedEventIds], []);

  // Every source event lands in exactly one explainable bucket.
  const accounted = candidate.coverage.assignedEventCount + candidate.coverage.pendingEventCount
    + candidate.coverage.unassignedEventCount + candidate.coverage.unsupportedEventCount;
  assert.equal(accounted, candidate.coverage.sourceEventCount);
  assert.ok(candidate.coverage.pendingEventCount > 0, 'unresolved material stays visible as pending, not deleted');
});

test('each lane keeps the provenance of the events it carries', () => {
  const { record, arrangement } = arrangementFor('format1.mid', fixtures.format1());
  for (const lane of arrangement.candidate.lanes) {
    assert.deepEqual([...lane.sourceIds], [sourceIdOf(fixtures.format1())]);
    assert.ok(lane.sourceEventIds.length > 0);
    for (const eventId of lane.eventIds) {
      const event = record.project.events.find(item => item.id === eventId);
      assert.ok(event, 'a lane may only name events that exist in the source project');
      assert.equal(event.voice, lane.sourceVoice);
    }
  }
});

// ─── G11-C is a candidate, never an accepted arrangement ────────────────────

test('the candidate declares what it is and certifies nothing', () => {
  const { arrangement } = arrangementFor('six.mid', fixtures.sixSourceVoices());
  assert.equal(arrangement.stageKind, 'ARRANGEMENT_CANDIDATE');
  assert.equal(arrangement.accepted, false);
  assert.deepEqual(arrangement.certifiesGates, []);
  assert.equal(arrangement.candidate.stageKind, 'ARRANGEMENT_CANDIDATE');
  assert.match(arrangement.candidate.notice, /certifies no ACCEPTANCE_CRITERIA\.md gate/);
});

test('a Raw MIDI candidate never becomes a VALIDATED workspace on its own', () => {
  let workspace = workspaceWith(asset('six.mid', fixtures.sixSourceVoices()));
  const first = analyzeWorkspace(workspace);
  assert.equal(first.state, 'CANDIDATE');
  const entry = first.rawMidi[0];
  assert.ok(entry.arrangement, 'the candidate is produced');
  assert.equal(entry.arrangement.candidate.core3.status, 'PENDING');

  // Even with every human review recorded, the suggested roles are not an
  // accepted arrangement and the workspace stays a candidate.
  for (const name of REVIEW_NAMES) workspace = recordReview(workspace, name, 'reviewed', 'synthetic');
  const reviewed = analyzeWorkspace(workspace);
  assert.notEqual(reviewed.state, 'IN_GAME_ACCEPTED');
  assert.ok(reviewed.blockers.length > 0);
  // The source events still carry no role after a full review pass.
  for (const event of workspace.assets.candidate.project.events) assert.equal(event.role, null);
});

test('the analysis re-derives the candidate and refuses a stored one', () => {
  const record = asset('format1.mid', fixtures.format1());
  const workspace = workspaceWith(record);
  const fresh = analyzeWorkspace(workspace).rawMidi[0];
  assert.equal(fresh.arrangementSource, 'RECOMPUTED_FROM_SOURCE_PROJECT');
  assert.equal(fresh.persistedArrangement, null, 'nothing is persisted, so there is nothing to trust');

  // A legacy or hand-written record that does carry one is reported stale and
  // discarded, never shown as current.
  const stale = structuredClone(record);
  stale.arrangement = { ...deriveArrangement(record.project, { sourceSha256: record.source.sha256 }), pipeline: 'studio-web/raw-midi@0' };
  const staleReport = analyzeWorkspace(workspaceWith(stale));
  assert.equal(staleReport.rawMidi[0].persistedArrangement.current, false);
  assert.ok(staleReport.rawMidi[0].persistedArrangement.reasons.includes('ARRANGEMENT_PIPELINE_VERSION_CHANGED'));
  assert.equal(staleReport.gates.rawMidiSource.status, 'PENDING');
  assert.match(staleReport.gates.rawMidiSource.reason, /STALE_STORED_ARRANGEMENT_DISCARDED/);
  // And what is shown is the re-derived reading, which is current.
  assert.equal(JSON.stringify(staleReport.rawMidi[0].arrangement.candidate), JSON.stringify(fresh.arrangement.candidate));
});

test('an arrangement bound to other bytes or other events is reported stale', () => {
  const record = asset('format1.mid', fixtures.format1());
  const arrangement = deriveArrangement(record.project, { sourceSha256: record.source.sha256 });
  for (const [mutate, reason] of [
    [copy => { copy.arrangement.derivation.sourceSha256 = '0'.repeat(64); }, 'ARRANGEMENT_SOURCE_BYTES_CHANGED'],
    [copy => { copy.arrangement.derivation.eventCount = 1; }, 'ARRANGEMENT_EVENT_COUNT_CHANGED'],
    [copy => { copy.arrangement.derivation.eventIdDigest = '1'.repeat(64); }, 'ARRANGEMENT_EVENT_IDENTITY_CHANGED'],
    [copy => { copy.arrangement.derivation.projectId = 'other'; }, 'ARRANGEMENT_PROJECT_CHANGED'],
  ]) {
    const copy = structuredClone({ ...record, arrangement });
    mutate(copy);
    const entry = analyzeWorkspace(workspaceWith(copy)).rawMidi[0];
    assert.equal(entry.persistedArrangement.current, false);
    assert.ok(entry.persistedArrangement.reasons.includes(reason), `${reason} must be reported`);
  }
});

// ─── PR #19 protections, with MIDI provenance underneath ────────────────────

const LEAD_VOICE = 'track:1/channel:0';
const leadEvidence = sourceIds => [{ sourceVoice: LEAD_VOICE, role: 'Melody', citation: 'synthetic score citation, bars 1-6', ...(sourceIds ? { sourceIds } : {}) }];

test('a cited trusted symbolic Lead over MIDI material is source-supported', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const candidate = suggestRoleCandidates(record.project, { sourceRoleEvidence: leadEvidence([sourceIdOf(fixtures.sixSourceVoices())]) });
  assert.equal(candidate.roles.Melody.status, 'ASSIGNED');
  assert.equal(candidate.roles.Melody.evidenceTier, 1);
  assert.equal(candidate.roles.Melody.evidenceTierName, 'DECLARED_SOURCE_ROLE');
  const lane = candidate.lanes.find(item => item.sourceVoice === LEAD_VOICE);
  assert.equal(lane.roleSupport.Melody.tier, 1);
});

test('a caller override cannot demote that Lead, and no substitute is invented', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const evidence = leadEvidence([sourceIdOf(fixtures.sixSourceVoices())]);
  const leadLane = suggestRoleCandidates(record.project, { sourceRoleEvidence: evidence }).lanes.find(item => item.sourceVoice === LEAD_VOICE);

  const demoted = suggestRoleCandidates(record.project, { sourceRoleEvidence: evidence, roleOverrides: { [leadLane.id]: 'Chord3' } });
  assert.equal(demoted.roles.Melody.status, 'PENDING');
  assert.deepEqual([...demoted.roles.Melody.reasons], ['DECLARED_LEAD_DEMOTION_UNRESOLVED']);
  assert.deepEqual([...demoted.roles.Melody.laneIds], [], 'no other lane is promoted into the vacated role');
  assert.equal(demoted.roles.Chord3.laneIds.includes(leadLane.id), false, 'the Lead is not moved into enrichment');

  const pending = demoted.pending.find(item => item.laneId === leadLane.id);
  assert.deepEqual([...pending.blockers], ['LEAD_DEMOTION_NOT_EVALUATED']);
  assert.equal(pending.gate, 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion');
  assert.equal(demoted.core3.status, 'PENDING');
  assert.ok(demoted.core3.missingFunctions.includes('lead-continuity'));
  // The events themselves are still there, attributed and unmoved.
  for (const eventId of leadLane.eventIds) assert.ok(demoted.coverage.inputEventIds.includes(eventId));
});

test('pinning another lane to Melody does not resolve the demotion it was meant to hide', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const evidence = leadEvidence([sourceIdOf(fixtures.sixSourceVoices())]);
  const base = suggestRoleCandidates(record.project, { sourceRoleEvidence: evidence });
  const leadLane = base.lanes.find(item => item.sourceVoice === LEAD_VOICE);
  const substitute = base.lanes.find(item => item.sourceVoice !== LEAD_VOICE);

  const bypass = suggestRoleCandidates(record.project, {
    sourceRoleEvidence: evidence,
    roleOverrides: { [leadLane.id]: 'Chord3', [substitute.id]: 'Melody' },
  });
  // The substitute is recorded as what it is -- a caller override -- and the
  // unresolved demotion is recorded beside it rather than being cleared by it.
  assert.ok(bypass.roles.Melody.reasons.includes('CALLER_ROLE_OVERRIDE'));
  assert.ok(bypass.roles.Melody.reasons.includes('DECLARED_LEAD_DEMOTION_UNRESOLVED'));
  assert.equal(bypass.roles.Chord3.laneIds.includes(leadLane.id), false);
  assert.ok(bypass.pending.some(item => item.laneId === leadLane.id && item.blockers.includes('LEAD_DEMOTION_NOT_EVALUATED')));
  assert.equal(bypass.core3.status, 'PENDING');
  assert.ok(bypass.core3.unprovenFunctions.includes('lead-continuity'));
});

test('a citation covering some events of a lane is not whole-lane authority', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const lane = suggestRoleCandidates(record.project).lanes.find(item => item.sourceVoice === LEAD_VOICE);
  assert.ok(lane.eventIds.length >= 2);

  const partial = suggestRoleCandidates(record.project, {
    sourceRoleEvidence: [{ eventIds: [lane.eventIds[0]], role: 'Melody', citation: 'covers one event only', sourceIds: [sourceIdOf(fixtures.sixSourceVoices())] }],
  });
  const partialLane = partial.lanes.find(item => item.sourceVoice === LEAD_VOICE);
  assert.notEqual(partialLane.roleSupport.Melody.tier, 1, 'partial coverage cannot declare the whole lane');
  assert.equal(partial.roles.Melody.status, 'EMPTY');
  assert.deepEqual([...partial.roles.Melody.reasons], ['NO_LEAD_EVIDENCE']);
});

test('a sourceVoice label shared by two MIDI sources grants no authority', () => {
  // Two genuinely different files, each with a track:1/channel:0. The label is
  // not provenance, so a voice-only citation over it is withheld from both.
  // They must differ in bytes: identical bytes are one source, not two, now
  // that identity is content-derived.
  const first = asset('first.mid', fixtures.format1());
  const second = asset('second.mid', fixtures.format1Variant());
  assert.notEqual(first.source.id, second.source.id, 'the fixture must supply two distinct sources');
  const merged = mergeCanonicalProjects([first.project, second.project], { id: 'merged', title: 'merged' });
  assert.deepEqual(merged.sources.map(item => item.id), [first.source.id, second.source.id]);

  const ambiguous = suggestRoleCandidates(merged, { sourceRoleEvidence: leadEvidence(null) });
  assert.equal(ambiguous.roles.Melody.status, 'EMPTY');
  assert.deepEqual([...ambiguous.roles.Melody.reasons], ['NO_LEAD_EVIDENCE']);
  for (const lane of ambiguous.lanes) assert.notEqual(lane.roleSupport.Melody.tier, 1);

  // Naming the source that made the claim resolves it, and only for that source.
  const scoped = suggestRoleCandidates(merged, { sourceRoleEvidence: leadEvidence([first.source.id]) });
  const declared = scoped.lanes.filter(lane => lane.roleSupport.Melody.tier === 1);
  assert.equal(declared.length, 1);
  assert.deepEqual([...declared[0].sourceIds], [first.source.id]);
});

test('selectors are conjunctive: a citation naming a source it does not own declares nothing', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const wrongSource = suggestRoleCandidates(record.project, { sourceRoleEvidence: leadEvidence(['a-source-not-in-this-project']) });
  assert.equal(wrongSource.roles.Melody.status, 'EMPTY');
  assert.deepEqual([...wrongSource.roles.Melody.reasons], ['NO_LEAD_EVIDENCE']);

  const lane = suggestRoleCandidates(record.project).lanes.find(item => item.sourceVoice === LEAD_VOICE);
  const wrongLane = suggestRoleCandidates(record.project, {
    sourceRoleEvidence: [{ sourceVoice: LEAD_VOICE, laneId: lane.id, role: 'Melody', citation: 'score', sourceIds: [sourceIdOf(fixtures.sixSourceVoices())] }],
  });
  assert.equal(wrongLane.roles.Melody.evidenceTier, 1, 'every selector agreeing does declare');
  const contradictory = suggestRoleCandidates(record.project, {
    sourceRoleEvidence: [{ sourceVoice: 'track:5/channel:4', laneId: lane.id, role: 'Melody', citation: 'score', sourceIds: [sourceIdOf(fixtures.sixSourceVoices())] }],
  });
  assert.equal(contradictory.roles.Melody.status, 'EMPTY', 'selectors that disagree declare nothing');
});

// ─── Core3 and Full6 ────────────────────────────────────────────────────────

test('Core3 is one three-role unit with no ranking among its roles', () => {
  const { arrangement } = arrangementFor('six.mid', fixtures.sixSourceVoices());
  const core3 = arrangement.candidate.core3;
  assert.deepEqual([...core3.architecture.roles], [...CORE3_ROLE_NAMES]);
  assert.equal(core3.architecture.allThreeRequiredForComplete, true);
  assert.equal(core3.architecture.priorityAmongRoles, 'NONE');
  assert.equal(core3.canonicallyCompleteGate, 'CORE3');
  for (const role of CORE3_ROLE_NAMES) assert.equal(arrangement.candidate.roles[role].group, 'core3');
  for (const role of ENRICHMENT_ROLE_NAMES) assert.equal(arrangement.candidate.roles[role].group, 'full6');
  assert.deepEqual([...CORE3_ROLE_NAMES, ...ENRICHMENT_ROLE_NAMES], [...SIX_ROLES]);
});

test('Chord3-Chord5 cannot repair an incomplete Core3', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const laneIds = suggestRoleCandidates(record.project).lanes.map(lane => lane.id);

  // Fill every enrichment role. Core3 is still short of a Lead and a principal
  // harmony, and nothing about the enrichment changes that.
  const enriched = suggestRoleCandidates(record.project, {
    roleOverrides: { [laneIds[1]]: 'Chord3', [laneIds[2]]: 'Chord4', [laneIds[3]]: 'Chord5' },
  });
  assert.deepEqual([...enriched.full6.rolesUsed], ['Chord3', 'Chord4', 'Chord5']);
  for (const role of ENRICHMENT_ROLE_NAMES) assert.equal(enriched.roles[role].status, 'ASSIGNED');

  assert.equal(enriched.core3.status, 'PENDING');
  assert.ok(enriched.core3.missingFunctions.includes('lead-continuity'));
  assert.ok(enriched.core3.missingFunctions.includes('principal-harmony'));
  assert.equal(enriched.core3.functions.leadContinuity.satisfied, false);
  assert.equal(enriched.core3.functions.principalHarmony.satisfied, false);
  // No enrichment lane is counted towards a Core3 function.
  const core3LaneIds = new Set(CORE3_ROLE_NAMES.flatMap(role => enriched.roles[role].laneIds));
  for (const role of ENRICHMENT_ROLE_NAMES) for (const laneId of enriched.roles[role].laneIds) assert.equal(core3LaneIds.has(laneId), false);
  // Full6 is never reported useful while Core3 is unresolved.
  assert.equal(enriched.full6.status, 'PENDING');
  assert.match(enriched.full6.notice, /may not be used to hide an incomplete or unresolved Core3/);
  // And a one- or two-role reading is never reported complete either.
  assert.equal(enriched.reducedRoleDiagnostics.canonicalCompletenessGate, 'CORE3');
});

// ─── unsupported, percussion and overflow stay visible ──────────────────────

test('percussion never reaches the candidate as pitched material and stays counted', () => {
  const record = asset('drums.mid', fixtures.percussion());
  const workspace = workspaceWith(record);
  const entry = analyzeWorkspace(workspace).rawMidi[0];

  assert.equal(entry.midi.percussionEventCount, 3);
  assert.equal(entry.complete, false);
  assert.ok(entry.unsupported.some(item => item.code === 'PERCUSSION_CHANNEL_EVENT'));

  // The candidate only ever sees the pitched events, so the drum note numbers
  // cannot appear as candidate pitches under any role.
  const candidate = entry.arrangement.candidate;
  assert.equal(candidate.coverage.sourceEventCount, 2);
  const pitches = new Set(candidate.ledger.map(item => item.sourcePitch));
  for (const drum of [36, 38, 42]) assert.equal(pitches.has(drum), false);
  // And the source gate reports the material rather than hiding it.
  assert.equal(analyzeWorkspace(workspace).gates.source.status, 'UNSUPPORTED');
});

test('unsupported source material stays attached to the report, not dropped', () => {
  const record = asset('after-eot.mid', fixtures.dataAfterEndOfTrack());
  const entry = analyzeWorkspace(workspaceWith(record)).rawMidi[0];
  assert.equal(entry.complete, false);
  assert.ok(entry.unsupported.some(item => item.code === 'DATA_AFTER_END_OF_TRACK'));
  assert.equal(entry.midi.unsupportedCounts.DATA_AFTER_END_OF_TRACK, 1);
  // The note that did decode is still analysed; the damage does not erase it.
  assert.equal(entry.arrangement.candidate.coverage.sourceEventCount, 1);
});

// ─── micro-timing (PR #20) ──────────────────────────────────────────────────

// Two voices one tick apart at PPQ 360: an interval of 1/360 of a beat, far
// below the 1/16-beat safe grid.
const microTimingMidi = () => fixtures.buildMidi({
  format: 1,
  division: fixtures.PPQ,
  tracks: [
    fixtures.buildTrack([[0, ...fixtures.setTempo(500000)], [0, ...fixtures.timeSig(4, 2)]]),
    fixtures.buildTrack([[0, ...fixtures.trackName('A')], ...fixtures.notesToEntries([[0, 72, 0, 360], [0, 74, 360, 720]])]),
    fixtures.buildTrack([[0, ...fixtures.trackName('B')], ...fixtures.notesToEntries([[1, 60, 1, 361], [1, 62, 361, 721]])]),
  ],
});

test('a sub-grid interval from Raw MIDI stays unresolved, never source-supported', () => {
  const record = asset('micro.mid', microTimingMidi());
  assert.deepEqual(record.project.events.map(event => event.start), ['0', '1/360', '1', '361/360']);

  const report = analyzeProjectMicroTiming(record.project);
  assert.equal(report.sourceSupportedCount, 0);
  assert.equal(report.hasUnknown, true);
  assert.equal(report.unresolvedStreamIssueCount, 1);
  assert.equal(report.unresolvedStreamIssues[0].reason, 'unassigned-role-stream-identity');

  // G11-A assigns no role, so the gate cannot even attribute the interval to a
  // role stream. A G11-C suggestion is not allowed to supply that attribution:
  // it would promote a heuristic into the source binding the gate requires.
  const gate = analyzeWorkspace(workspaceWith(record)).gates.microTiming;
  assert.notEqual(gate.status, 'PASS');
  for (const event of record.project.events) assert.equal(event.role, null);
});

test('a suggested role is never written back into the source the gate reads', () => {
  const record = asset('micro.mid', microTimingMidi());
  const before = JSON.stringify(record.project);
  const entry = analyzeWorkspace(workspaceWith(record)).rawMidi[0];
  // Roles really were suggested -- so the source staying role-free below is a
  // separation, not an empty candidate.
  assert.ok(entry.arrangement.candidate.lanes.some(lane => lane.candidateRole !== null), 'the candidate must actually propose a role');
  assert.equal(JSON.stringify(record.project), before, 'the analysis must not write candidate roles into the source');
  assert.equal(analyzeProjectMicroTiming(record.project).sourceSupportedCount, 0);
});

// ─── determinism end to end ─────────────────────────────────────────────────

test('identical bytes produce an identical candidate, twice', () => {
  const bytes = fixtures.sixSourceVoices();
  const first = arrangementFor('six.mid', bytes);
  const second = arrangementFor('six.mid', bytes);
  assert.equal(first.record.source.sha256, second.record.source.sha256);
  assert.equal(JSON.stringify(first.arrangement), JSON.stringify(second.arrangement));
});

test('a storage and Worker round trip does not change the candidate', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const direct = deriveArrangement(record.project, { sourceSha256: record.source.sha256 });
  for (const transported of [structuredClone(record), JSON.parse(JSON.stringify(record))]) {
    const after = deriveArrangement(transported.project, { sourceSha256: transported.source.sha256 });
    assert.equal(JSON.stringify(after), JSON.stringify(direct));
  }
});

test('splitProjectSourceVoices and the report agree on lane membership', () => {
  const record = asset('six.mid', fixtures.sixSourceVoices());
  const direct = splitProjectSourceVoices(record.project);
  const reported = deriveArrangement(record.project, { sourceSha256: record.source.sha256 }).voiceSplit;
  assert.equal(reported.sourceVoiceCount, direct.length);
  direct.forEach((group, index) => {
    assert.equal(reported.groups[index].sourceVoice, group.sourceVoice);
    assert.equal(reported.groups[index].laneCount, group.lanes.length);
    group.lanes.forEach((lane, laneIndex) => {
      assert.deepEqual(reported.groups[index].lanes[laneIndex].eventIds, lane.notes.map(note => note.eventId));
    });
  });
});
