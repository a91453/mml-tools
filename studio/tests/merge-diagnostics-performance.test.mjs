// G11-C merge diagnostics: whole-song scale.
//
// suggestRoleCandidates always builds the read-only merge diagnostics, and the
// service runs it on the control plane's only thread. The per-event analysis
// used to copy and exact-rationally re-sort every target of a role once per
// source event and filter every target again for collisions, so a 5,000-note,
// 16-voice song took minutes and a 10,000-note one about six. The bound below is
// generous for CI; the implementation needs well under a second.
//
// The bound is on this process's CPU time, not wall time: `node --test` runs
// test files concurrently, and a loaded runner can stretch wall time several
// fold without the work itself changing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestRoleCandidates } from '../backend/arrangement/role-candidates.mjs';
import { analyzeLegacyMergeLane } from '../backend/arrangement/merge-diagnostics.mjs';
import { createCanonicalNoteEvent } from '../backend/canonical/index.mjs';

const BOUND_CPU_MS = 10000;

function measure(work) {
  const cpu = process.cpuUsage();
  const wall = performance.now();
  const result = work();
  const used = process.cpuUsage(cpu);
  return { result, cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - wall };
}

// Deterministic: the same song on every run.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}

// Sixteen role-less monophonic voices, 313 notes each (5,008 notes).
function sixteenVoiceSong() {
  const random = lcg(20260924);
  const events = [];
  for (let voice = 0; voice < 16; voice += 1) {
    let beat = 0;
    for (let index = 0; index < 313; index += 1) {
      const length = 1 + Math.floor(random() * 4);
      events.push(createCanonicalNoteEvent({
        id: `v${String(voice).padStart(2, '0')}n${String(index).padStart(4, '0')}`,
        pitch: 36 + voice * 3 + Math.floor(random() * 12),
        start: `${beat}/4`,
        end: `${beat + length}/4`,
        sourceIds: ['fixture:scale'],
        sourceEventIds: [`fixture:scale#v${voice}n${index}`],
        role: null,
        voice: `voice-${voice}`,
        volume: null,
        metadata: {},
      }));
      beat += length;
    }
  }
  return { id: 'fixture:scale', title: 'Scale fixture', events };
}

test('a 5,000-note, 16-voice suggestion with its merge diagnostics stays within the CPU bound', t => {
  const project = sixteenVoiceSong();
  assert.equal(project.events.length, 5008);
  const { result: suggestion, cpuMs, wallMs } = measure(() => suggestRoleCandidates(project));
  t.diagnostic(`suggestRoleCandidates: ${Math.round(cpuMs)} ms CPU, ${Math.round(wallMs)} ms wall`);

  // The fixture really drives the diagnostics: competing role-less lanes are
  // each measured against the whole projected song.
  const measured = suggestion.mergeDiagnostics.pendingRoleGroups
    .flatMap(group => group.laneReports)
    .reduce((sum, report) => sum + report.candidateEventCount, 0)
    + suggestion.mergeDiagnostics.overflowLanes.reduce((sum, lane) => sum + lane.candidateEventCount, 0);
  assert.ok(measured >= 3000, `merge diagnostics measured only ${measured} source events`);
  assert.equal(suggestion.coverage.complete, true);
  assert.ok(cpuMs < BOUND_CPU_MS,
    `suggestRoleCandidates used ${Math.round(cpuMs)} ms CPU (${Math.round(wallMs)} ms wall) for 5,008 notes (bound ${BOUND_CPU_MS} ms CPU)`);
});

test('one lane of 2,500 notes measured against a 5,000-note candidate stays within the CPU bound', t => {
  const random = lcg(7);
  const roles = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
  const note = (id, role, beat, length) => ({
    kind: 'note',
    id,
    role,
    pitch: 40 + Math.floor(random() * 40),
    start: `${beat}/3`,
    end: `${beat + length}/3`,
    sourceIds: ['fixture:scale'],
    sourceEventIds: [`raw:${id}`],
  });
  const candidateEvents = [];
  roles.forEach((role, voice) => {
    let beat = voice;
    for (let index = 0; index < 834; index += 1) {
      const length = 1 + Math.floor(random() * 6);
      candidateEvents.push(note(`${role}-${index}`, role, beat, length));
      beat += length + (random() < 0.3 ? 1 : 0);
    }
  });
  const sourceEvents = [];
  let beat = 0;
  for (let index = 0; index < 2500; index += 1) {
    const length = 1 + Math.floor(random() * 3);
    sourceEvents.push(note(`overflow-${index}`, null, beat, length));
    beat += length;
  }

  const { result: report, cpuMs, wallMs } = measure(() => analyzeLegacyMergeLane({ sourceEvents, candidateEvents }));
  t.diagnostic(`analyzeLegacyMergeLane: ${Math.round(cpuMs)} ms CPU, ${Math.round(wallMs)} ms wall`);
  assert.equal(report.candidateEventCount, 2500);
  assert.equal(report.targets.length, 6);
  assert.ok(report.targets.every(entry => entry.targetEventCount === 834));
  assert.ok(cpuMs < BOUND_CPU_MS,
    `analyzeLegacyMergeLane used ${Math.round(cpuMs)} ms CPU (${Math.round(wallMs)} ms wall) (bound ${BOUND_CPU_MS} ms CPU)`);
});
