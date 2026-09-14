import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSource,
  createCanonicalNoteEvent,
  createArbitrationDecision,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import { analyzeCrossSourceHarmony } from '../backend/arbitration/harmony.mjs';

function sources() {
  return [
    createSource({ id: 'official', label: 'Official score', kind: 'official-musicxml', authority: 'primary-symbolic' }),
    createSource({ id: 'thirdparty', label: 'Third-party score', kind: 'third-party-musicxml', authority: 'supporting' }),
  ];
}

function note(id, sourceId, role, pitch, start = '0', end = '1') {
  return createCanonicalNoteEvent({ id, pitch, start, end, role, sourceIds: [sourceId] });
}

test('same-pitch notes from separate sources require arbitration instead of blind stacking', () => {
  const [official, thirdparty] = sources();
  const events = [
    note('official:n1', 'official', 'Chord1', 60),
    note('thirdparty:n1', 'thirdparty', 'Chord4', 60),
  ];
  const project = createCanonicalProject({ id: 'same-pitch', title: 'Same pitch', sources: [official, thirdparty], events });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.status, 'PENDING');
  assert.equal(report.conflictCount, 1);
  assert.equal(report.conflicts[0].kind, 'cross-source-same-pitch');
  assert.equal(report.conflicts[0].core3Threat, true);
  assert.match(report.notice, /provenance, not compatibility/i);
});

test('low-mid cross-source m2 against enrichment is a Core3 threat but never auto-deleted', () => {
  const [official, thirdparty] = sources();
  const events = [
    note('official:n1', 'official', 'Chord1', 60),
    note('thirdparty:n1', 'thirdparty', 'Chord3', 61),
  ];
  const project = createCanonicalProject({ id: 'm2', title: 'm2', sources: [official, thirdparty], events });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.status, 'PENDING');
  assert.equal(report.core3ThreatCount, 1);
  assert.equal(report.conflicts[0].intervalName, 'm2');
  assert.equal(report.conflicts[0].registerRisk, 'low-mid');
  assert.match(report.conflicts[0].notice, /not an automatic deletion/i);
});

test('accepted evidence-backed conflict decision resolves the harmony gate without rewriting events', () => {
  const [official, thirdparty] = sources();
  const left = note('official:n1', 'official', 'Chord1', 60);
  const right = note('thirdparty:n1', 'thirdparty', 'Chord3', 61);
  const decision = createArbitrationDecision({
    id: 'decision-1',
    eventIds: [left.id, right.id],
    action: 'reassign-octave:thirdparty:n1:+12',
    status: 'accepted',
    reason: 'Third-party color tone is retained one octave higher so Core3 remains clear.',
    evidence: ['official-score:core-harmony', 'thirdparty-score:color-tone', 'mobile-ab:upper-register-clearer'],
  });
  const project = createCanonicalProject({
    id: 'resolved', title: 'Resolved', sources: [official, thirdparty], events: [left, right], decisions: [decision],
  });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.status, 'PASS');
  assert.equal(report.unresolvedCount, 0);
  assert.equal(report.conflicts[0].decision.id, 'decision-1');
  assert.equal(project.events[1].pitch, 61, 'arbitration record must not silently mutate source truth');
});

test('compatible cross-source harmony is allowed without manufacturing a conflict', () => {
  const [official, thirdparty] = sources();
  const project = createCanonicalProject({
    id: 'compatible', title: 'Compatible', sources: [official, thirdparty],
    events: [
      note('official:n1', 'official', 'Chord1', 60),
      note('thirdparty:n1', 'thirdparty', 'Chord3', 64),
    ],
  });
  const report = analyzeCrossSourceHarmony(project);
  assert.equal(report.status, 'PASS');
  assert.equal(report.conflictCount, 0);
});

test('notes supported by the same source do not become cross-source conflicts', () => {
  const [official] = sources();
  const project = createCanonicalProject({
    id: 'same-source', title: 'Same source', sources: [official],
    events: [
      note('official:n1', 'official', 'Chord1', 60),
      note('official:n2', 'official', 'Chord2', 61),
    ],
  });
  const report = analyzeCrossSourceHarmony(project);
  assert.equal(report.status, 'PASS');
  assert.equal(report.conflictCount, 0);
});

// Every pair of note events is reviewed, so a song-length project decides
// whether the phone workflow is usable at all: the local Worker analysis is
// bounded by a timeout, and losing it discards the imported sources. Six
// overlapping roles at song length also keep the same-source and interval
// rejection paths on the hot path rather than short-circuiting immediately.
test('a song-length six-role project is reviewed pair-by-pair without losing conflicts or stalling the local Worker', () => {
  const ROLES = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];
  const [official, thirdparty] = sources();
  const events = [];
  for (let bar = 0; bar < 1000; bar++) {
    for (let role = 0; role < ROLES.length; role++) {
      // Sustained, heavily overlapping roles, and same-source neighbours at the
      // reviewed distances (0/1/11/13) that must never become cross-source conflicts.
      events.push(note(`official:${bar}:${role}`, 'official', ROLES[role], 48 + role * 11, String(bar), String(bar + 3)));
    }
  }
  const planted = [
    ['Chord1', 'Chord4', 60, 60, 'cross-source-same-pitch', 'P1'],
    ['Melody', 'Chord3', 72, 73, 'cross-source-dissonance', 'm2'],
    ['Chord2', 'Chord5', 55, 66, 'cross-source-dissonance', 'M7'],
    ['Chord2', 'Chord3', 50, 63, 'cross-source-dissonance', 'm9'],
  ];
  planted.forEach(([leftRole, rightRole, leftPitch, rightPitch], index) => {
    // Past the sustained material, so the expected conflict set is exactly the
    // planted pairs and not incidental neighbours of the background roles.
    const at = 2000 + index * 10;
    events.push(note(`official:planted:${index}`, 'official', leftRole, leftPitch, String(at), String(at + 2)));
    events.push(note(`thirdparty:planted:${index}`, 'thirdparty', rightRole, rightPitch, String(at), String(at + 2)));
  });
  const project = createCanonicalProject({
    id: 'song-length', title: 'Song length', sources: [official, thirdparty], events,
  });

  const started = process.hrtime.bigint();
  const report = analyzeCrossSourceHarmony(project);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(project.events.length, 6008);
  assert.equal(report.conflictCount, planted.length, 'only genuine cross-source pairs are reported');
  assert.deepEqual(
    report.conflicts.map(conflict => [conflict.kind, conflict.intervalName]),
    planted.map(([, , , , kind, intervalName]) => [kind, intervalName]),
  );
  assert.deepEqual(
    report.conflicts.map(conflict => [conflict.leftEventId, conflict.rightEventId]),
    planted.map((_, index) => [`official:planted:${index}`, `thirdparty:planted:${index}`]),
  );
  assert.equal(report.unresolvedCount, planted.length);
  assert.ok(elapsedMs < 5000, `cross-source review of a song-length project took ${elapsedMs.toFixed(0)}ms`);
});

const SIX_ROLES = ['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5'];

function unorderedRolePairs() {
  const pairs = [];
  for (let i = 0; i < SIX_ROLES.length; i++) {
    for (let j = i + 1; j < SIX_ROLES.length; j++) pairs.push([SIX_ROLES[i], SIX_ROLES[j]]);
  }
  return pairs;
}

const pairKey = (left, right) => [left, right].sort().join('|');

// G5 — Gate 5 asks whether Chord3-Chord5 enrichment damages Core3, so the reported
// core3Threat flag has to actually discriminate. Forcing it to a constant previously
// left the suite green. Representative pairs only: the per-pair matrix is the
// helper's own behaviour, not a Canonical contract.
test('core3Threat discriminates Core3-versus-enrichment from same-tier conflicts', () => {
  const conflictFor = (leftRole, rightRole) => {
    const [official, thirdparty] = sources();
    const project = createCanonicalProject({
      id: `threat-${leftRole}-${rightRole}`, title: 'Threat', sources: [official, thirdparty],
      events: [note('official:n1', 'official', leftRole, 60), note('thirdparty:n1', 'thirdparty', rightRole, 60)],
    });
    const report = analyzeCrossSourceHarmony(project);
    assert.equal(report.conflictCount, 1, `${leftRole}/${rightRole} must still be reviewed`);
    return report;
  };

  const crossTier = conflictFor('Melody', 'Chord3');
  assert.equal(crossTier.conflicts[0].core3Threat, true);
  assert.equal(crossTier.core3ThreatCount, 1);

  for (const [leftRole, rightRole] of [['Melody', 'Chord1'], ['Chord3', 'Chord4']]) {
    const sameTier = conflictFor(leftRole, rightRole);
    assert.equal(sameTier.conflicts[0].core3Threat, false, `${leftRole}/${rightRole} is not a Core3-versus-enrichment threat`);
    assert.equal(sameTier.core3ThreatCount, 0);
    // Not a Core3 threat is still a reviewable conflict: MASTER_RULES §6 keeps
    // same-pitch overlap a review signal rather than a deletion target.
    assert.equal(sameTier.status, 'PENDING');
    assert.equal(sameTier.unresolvedCount, 1);
  }
});

// G6 — MASTER_RULES §6 names low/mid m2 and M7 compression as a review dimension.
// The boundary itself is an implementation option, so this asserts that the
// classification responds to the configured ceiling rather than fixing 71 as a rule.
test('register risk separates low-mid from upper and follows the configured ceiling', () => {
  const project = (id, leftPitch, rightPitch) => {
    const [official, thirdparty] = sources();
    return createCanonicalProject({
      id, title: id, sources: [official, thirdparty],
      events: [note('official:n1', 'official', 'Chord1', leftPitch), note('thirdparty:n1', 'thirdparty', 'Chord3', rightPitch)],
    });
  };

  // Same-pitch and dissonance conflicts are built on separate paths, so both
  // classify register risk independently.
  assert.equal(analyzeCrossSourceHarmony(project('low', 60, 61)).conflicts[0].registerRisk, 'low-mid');
  assert.equal(analyzeCrossSourceHarmony(project('high', 80, 81)).conflicts[0].registerRisk, 'upper');
  assert.equal(analyzeCrossSourceHarmony(project('low-unison', 60, 60)).conflicts[0].registerRisk, 'low-mid');
  assert.equal(analyzeCrossSourceHarmony(project('high-unison', 80, 80)).conflicts[0].registerRisk, 'upper');
  assert.equal(
    analyzeCrossSourceHarmony(project('high-unison', 80, 80), { lowMidCeiling: 90 }).conflicts[0].registerRisk,
    'low-mid',
    'the configured ceiling applies to same-pitch conflicts too',
  );

  const raised = analyzeCrossSourceHarmony(project('high', 80, 81), { lowMidCeiling: 90 });
  assert.equal(raised.conflicts[0].registerRisk, 'low-mid', 'the ceiling is a configurable review threshold');
  assert.equal(raised.policy.lowMidCeiling, 90, 'the report states the threshold it applied');
  assert.equal(analyzeCrossSourceHarmony(project('low', 60, 61)).policy.lowMidCeiling, 71);
});

// G7 — PENDING P15 asks for evidence that all 15 unordered role pairs are actually
// exercised, and that justified doubling is distinguishable from collision risk.
// Each pair gets its own time window so the expected conflict set is exactly one per
// pair. This asserts coverage and the keep/omit decision contract, and deliberately
// does not assert any per-pair threat classification.
test('all 15 unordered role pairs are exercised for sustained same-pitch overlap', () => {
  const pairs = unorderedRolePairs();
  assert.equal(pairs.length, 15, 'six roles form 15 unordered pairs');

  const [official, thirdparty] = sources();
  const events = [];
  pairs.forEach(([leftRole, rightRole], index) => {
    const start = index * 10;
    events.push(note(`official:pair${index}`, 'official', leftRole, 60, String(start), String(start + 4)));
    events.push(note(`thirdparty:pair${index}`, 'thirdparty', rightRole, 60, String(start + 1), String(start + 4)));
  });
  const project = createCanonicalProject({ id: 'all-pairs', title: 'All pairs', sources: [official, thirdparty], events });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.conflictCount, 15, 'one sustained same-pitch conflict per role pair');
  assert.deepEqual(
    [...new Set(report.conflicts.map(conflict => pairKey(conflict.leftRole, conflict.rightRole)))].sort(),
    pairs.map(([leftRole, rightRole]) => pairKey(leftRole, rightRole)).sort(),
    'every unordered role pair is represented exactly once',
  );
  for (const conflict of report.conflicts) {
    assert.equal(conflict.kind, 'cross-source-same-pitch');
    assert.notEqual(conflict.start, conflict.end, 'the reported window is the sustained overlap');
  }
  assert.equal(report.unresolvedCount, 15, 'unreviewed overlap stays collision-risk, not silently accepted');
  assert.equal(report.status, 'PENDING');
});

test('an evidence-backed decision separates justified doubling from collision risk on every pair', () => {
  const pairs = unorderedRolePairs();
  const [official, thirdparty] = sources();
  const events = [];
  const decisions = [];
  pairs.forEach(([leftRole, rightRole], index) => {
    const start = index * 10;
    const left = note(`official:pair${index}`, 'official', leftRole, 60, String(start), String(start + 4));
    const right = note(`thirdparty:pair${index}`, 'thirdparty', rightRole, 60, String(start + 1), String(start + 4));
    events.push(left, right);
    // Every pair but the last is justified doubling; the last stays unresolved so
    // the gate cannot pass on a blanket approval.
    if (index < pairs.length - 1) {
      decisions.push(createArbitrationDecision({
        id: `decision-${index}`,
        eventIds: [left.id, right.id],
        action: 'keep',
        status: 'accepted',
        reason: `${leftRole}/${rightRole} doubling is source-supported reinforcement.`,
        evidence: ['official-score:doubling', 'thirdparty-score:doubling'],
      }));
    }
  });
  const project = createCanonicalProject({
    id: 'justified', title: 'Justified', sources: [official, thirdparty], events, decisions,
  });
  const report = analyzeCrossSourceHarmony(project);

  assert.equal(report.conflictCount, 15);
  assert.equal(report.conflicts.filter(conflict => conflict.resolved).length, 14, 'justified doubling is resolved by evidence');
  assert.equal(report.unresolvedCount, 1, 'the undecided pair remains collision-risk');
  assert.equal(report.status, 'PENDING', 'one unresolved pair still blocks the gate');
  assert.equal(project.events.length, 30, 'arbitration never adds or deletes source events');
  assert.ok(project.events.every(event => event.pitch === 60), 'arbitration never rewrites source pitch');
});
