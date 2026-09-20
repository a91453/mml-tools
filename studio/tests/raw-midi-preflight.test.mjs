import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMIDI, midiFragmentToProject } from '../backend/source/index.mjs';
import { splitProjectSourceVoices, suggestRoleCandidates } from '../backend/arrangement/index.mjs';
import { evaluateLeadDemotion } from '../backend/arbitration/lead-demotion.mjs';
import { newWorkspace, invalidate } from '../web/model.mjs';
import * as fixtures from './fixtures/midi-fixtures.mjs';

// Pre-integration reachability check for the two P2 findings PR #20 left open.
//
// Neither was fixed there because no caller could reach it. This task adds new
// Web/Worker callers, so the question has to be re-asked before the integration
// lands, and the answer has to be held by a regression rather than by a claim
// in a report.
//
//   P2-A  evaluateLeadDemotion did not independently verify that a supplied
//         sourceIdentity matches the target event's own provenance. Closed by
//         the G11-D residual hardening: the gate now binds the identity itself
//         (see the last test below); the reachability proofs are kept as they
//         were, because they still hold.
//   P2-B  createCanonicalProject previously left its collection arrays mutable.
//         PR #46 freezes fresh copies of all five arrays. Deeply frozen input
//         and Worker-copy regressions below remain as stronger boundary checks.
//
// Both constructor/gate fixes and the independent Raw MIDI boundaries are
// retained; nested metadata is not claimed deeply immutable by the constructor.

const ingest = (bytes, options = {}) => midiFragmentToProject(ingestMIDI(bytes, { sourceId: 'preflight', label: 'preflight.mid', ...options }));

// ─── P2-B: Canonical arrays are never mutated after construction ────────────

// If any stage wrote into a Canonical array, this throws in strict mode (ES
// modules are strict), so a green run is a positive proof of non-mutation
// rather than an absence of evidence.
function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

test('P2-B: the whole Raw MIDI pipeline runs against a deeply frozen Canonical project', () => {
  const project = ingest(fixtures.sixSourceVoices());
  // PR #46 protects collection containers at construction. The deeper
  // integration check below must still prove no stage mutates nested data.
  assert.equal(Object.isFrozen(project), true);
  assert.equal(Object.isFrozen(project.events), true, 'P2-B collection mutation is closed at construction');

  const frozen = deepFreeze(structuredClone({ ...project }));
  const decompositions = splitProjectSourceVoices(frozen);
  const candidate = suggestRoleCandidates(frozen);

  assert.equal(decompositions.length, 6);
  assert.equal(candidate.stageKind, 'ARRANGEMENT_CANDIDATE');
  assert.equal(candidate.coverage.sourceEventCount, project.events.length);
});

test('P2-B: G11-B and G11-C leave the caller\'s Canonical arrays byte-identical', () => {
  const project = ingest(fixtures.format1());
  const before = JSON.stringify({ events: project.events, sources: project.sources, tempoEvents: project.tempoEvents, meterEvents: project.meterEvents, decisions: project.decisions });
  const eventsRef = project.events;

  splitProjectSourceVoices(project);
  suggestRoleCandidates(project);

  assert.equal(project.events, eventsRef, 'the array identity must survive');
  assert.equal(JSON.stringify({ events: project.events, sources: project.sources, tempoEvents: project.tempoEvents, meterEvents: project.meterEvents, decisions: project.decisions }), before);
});

test('P2-B: a Worker round trip hands back an independent copy, so page state cannot reach Canonical arrays', () => {
  const project = ingest(fixtures.format0());
  // structuredClone is the Worker boundary's copy semantics. Mutating the copy
  // must not be able to reach the original.
  const transported = structuredClone(project);
  transported.events.push({ kind: 'note', id: 'injected' });
  assert.equal(project.events.length, 3);
  assert.equal(transported.events.length, 4);
});

// ─── P2-A: no Raw MIDI path can supply a Lead-demotion sourceIdentity ───────

// The single production caller is studio/web/model.mjs#analyzeWorkspace, which
// builds `event` by looking the recorded eventId up inside the *current*
// baseline project and only evaluates evidence recorded at the current
// revision. The only writer is the #lead-form handler in studio/web/app.mjs,
// which derives sourceIdentity from that same baseline event.
test('P2-A: a Raw MIDI baseline carries no Melody role, so the gate is never entered', () => {
  const project = ingest(fixtures.format1());
  assert.ok(project.events.length > 0);
  for (const event of project.events) {
    assert.equal(event.role, null, 'G11-A assigns no role; roles are a G11-C candidate, never source truth');
    const gate = evaluateLeadDemotion({
      event,
      destinationRole: 'Chord1',
      // A deliberately mismatched identity: it names a source this event does
      // not belong to. The gate must still not certify anything.
      sourceIdentity: { sourceId: 'some-other-source', sourceEventId: 'track:9/event:9' },
      sectionRole: 'instrumental',
      scoreEvidence: { availability: 'available', classification: 'accompaniment', citation: 'fabricated' },
      audioEvidence: { availability: 'available', classification: 'background', citation: 'fabricated' },
      continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
      core3: { checked: true, status: 'PASS' },
      positiveReason: 'fabricated',
    });
    assert.equal(gate.status, 'N/A');
    assert.equal(gate.reason, 'Event is not currently assigned to Melody/Lead.');
  }
});

test('P2-A closed: a Raw MIDI Melody event judged with another event\'s identity is PENDING at the gate itself', () => {
  const project = ingest(fixtures.format1());
  const notes = project.events.filter(event => event.kind === 'note');
  assert.ok(notes.length >= 2);
  const [target, other] = notes;
  const asLead = { ...target, role: 'Melody' };
  const evidence = sourceIdentity => evaluateLeadDemotion({
    event: asLead,
    destinationRole: 'Chord1',
    sourceIdentity,
    sectionRole: 'instrumental',
    scoreEvidence: { availability: 'available', classification: 'accompaniment', citation: 'fixture' },
    audioEvidence: { availability: 'available', classification: 'background', citation: 'fixture' },
    continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] },
    core3: { checked: true, status: 'PASS' },
    positiveReason: 'fixture',
  });
  // Every note of one MIDI file shares the one source id, so the source id
  // alone can never tell two events apart; the source event id does.
  assert.equal(target.sourceIds[0], other.sourceIds[0]);
  assert.equal(evidence({ sourceId: target.sourceIds[0], sourceEventId: target.sourceEventIds[0] }).status, 'PASS');
  const foreign = evidence({ sourceId: other.sourceIds[0], sourceEventId: other.sourceEventIds[0] });
  assert.equal(foreign.status, 'PENDING');
  assert.equal(foreign.eventId, target.id, 'the refusal is reported under the target event id');
  assert.ok(foreign.blockers.includes('LEAD_EVIDENCE_EVENT_IDENTITY_MISMATCH'));
});

test('P2-A: replacing a source clears the recorded Lead evidence it was bound to', () => {
  const workspace = { ...newWorkspace(), revision: 4 };
  workspace.leadEvidence = [{ eventId: 'baseline:note:0:0', revision: 4, destinationRole: 'Chord1', sourceIdentity: { sourceId: 'baseline', sourceEventId: 'track:0/event:0' } }];
  workspace.reviews = { lead: { revision: 4, note: 'n', evidence: 'e' } };

  const next = invalidate(workspace);

  assert.equal(next.revision, 5);
  assert.deepEqual(next.leadEvidence, [], 'a stale sourceIdentity cannot outlive the source it described');
  assert.deepEqual(next.reviews, {});
  assert.equal(next.acceptance, null);
});

test('P2-A: G11-C never resolves a Lead demotion itself; it defers to the gate by name', () => {
  const candidate = suggestRoleCandidates(ingest(fixtures.sixSourceVoices()));
  for (const item of candidate.pending) {
    if (!item.blockers.includes('LEAD_DEMOTION_NOT_EVALUATED')) continue;
    assert.equal(item.gate, 'studio/backend/arbitration/lead-demotion.mjs#evaluateLeadDemotion');
  }
  // And it certifies nothing on its own.
  assert.equal(candidate.stageKind, 'ARRANGEMENT_CANDIDATE');
});
