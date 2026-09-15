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
//   P2-A  evaluateLeadDemotion does not independently verify that a supplied
//         sourceIdentity matches the target event's own provenance.
//   P2-B  createCanonicalProject freezes the project object but not the arrays
//         it contains, so a later caller could mutate Canonical material after
//         construction.
//
// Both stay unreachable through the Raw MIDI path, for the reasons each test
// below states and proves.

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
  // The mutability itself is real and is what keeps the finding open; the
  // integration's obligation is not to depend on it.
  assert.equal(Object.isFrozen(project), true);
  assert.equal(Object.isFrozen(project.events), false, 'P2-B still describes the current constructor');

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
