// G10 C2B Phase A — C2B_PRE_INTEGRATION_PERFORMANCE_REQUIREMENT / F4.
//
// collectUnresolvedStreamIssues() used to scan role-null events x all spans and
// test every pair, which is O(n^2) and made a MusicXML ingest carrying thousands
// of role=null events unusable inside a synchronous readiness evaluation.
//
// The production scan is now a sorted/windowed sweep. These regressions hold it
// to two separate obligations:
//
//   1. semantics - deep equality with a reference implementation of the exact
//      old brute-force behaviour, over adversarial and dense fixtures;
//   2. shape - a bounded-candidate assertion on the scan's own operation count,
//      which the restored all-pairs scan cannot satisfy. That is deterministic,
//      unlike a tight wall-clock bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { f, F, ROLES } from '../backend/mml/index.mjs';
import {
  createSource,
  createCanonicalNoteEvent,
  createCanonicalRestEvent,
  createCanonicalProject,
} from '../backend/canonical/index.mjs';
import {
  SAFE_GRID,
  UNRESOLVED_STREAM_REASON,
  compareEvents,
  analyzeProjectMicroTiming,
  analyzeUnresolvedStreamIssues,
} from '../backend/canonical/micro-timing.mjs';

const JUST_BELOW = new F(1, 17);
const EXACT_GRID = new F(1, 16);
const ABOVE_GRID = new F(1, 8);
const ASSIGNED_ROLES = new Set(ROLES);
const SPAN_KINDS = new Set(['note', 'rest']);

// ---------------------------------------------------------------------------
// Reference oracle: the pre-C2B brute-force semantics, transcribed unchanged.
// ---------------------------------------------------------------------------

function referenceSpanEvents(project) {
  const events = Array.isArray(project?.events) ? project.events : [];
  return events.filter(event => event && SPAN_KINDS.has(event.kind) && event.id && event.start != null && event.end != null);
}

function referenceIsAssignedRole(event) {
  return ASSIGNED_ROLES.has(event.role);
}

function referencePossiblePositiveSubGridSeparation(left, right) {
  const gap = f(right.start).sub(left.end);
  return gap.cmp(0) > 0 && gap.cmp(SAFE_GRID) < 0;
}

function referencePairKey(leftId, rightId, start, end) {
  return JSON.stringify([leftId, rightId, start, end]);
}

function referenceUnresolvedStreamIssues(project, instrumentation = null) {
  const spans = referenceSpanEvents(project);
  const unassigned = spans.filter(event => !referenceIsAssignedRole(event));
  const issues = [];
  const seen = new Set();
  let candidateInspections = 0;
  for (const event of unassigned) {
    for (const other of spans) {
      if (!other || other.id === event.id) continue;
      candidateInspections += 1;
      const ordered = compareEvents(event, other) <= 0 ? [event, other] : [other, event];
      if (!referencePossiblePositiveSubGridSeparation(ordered[0], ordered[1])) continue;
      const start = f(ordered[0].end);
      const end = f(ordered[1].start);
      const key = referencePairKey(ordered[0].id, ordered[1].id, start.toString(), end.toString());
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        reason: UNRESOLVED_STREAM_REASON,
        eventIds: [ordered[0].id, ordered[1].id],
        start: start.toString(),
        end: end.toString(),
        length: end.sub(start).toString(),
      });
    }
  }
  issues.sort((left, right) => {
    const leftKey = referencePairKey(left.eventIds[0], left.eventIds[1], left.start, left.end);
    const rightKey = referencePairKey(right.eventIds[0], right.eventIds[1], right.start, right.end);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  if (instrumentation) {
    instrumentation.spanCount = spans.length;
    instrumentation.candidateInspections = candidateInspections;
    instrumentation.issueCount = issues.length;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE = createSource({
  id: 'src',
  label: 'F4 fixture source',
  kind: 'official-musicxml',
  authority: 'primary-symbolic',
});

let pitchCursor = 0;
function span({ id, start, end, role = null, kind = 'note' }) {
  const common = {
    id,
    start: String(start),
    end: String(end),
    role,
    sourceIds: ['src'],
    sourceEventIds: [`${id}/src`],
  };
  if (kind === 'rest') return createCanonicalRestEvent(common);
  pitchCursor = (pitchCursor + 7) % 60;
  return createCanonicalNoteEvent({ ...common, pitch: 48 + pitchCursor });
}

function fixture(events) {
  return createCanonicalProject({
    id: 'g10-c2b-f4',
    title: 'G10 C2B F4 fixture',
    sources: [SOURCE],
    events,
  });
}

// Deterministic, seedable ordering shuffle. Input order must never change the
// analyzer's answer, so every fixture is also checked in a permuted order.
function permute(events, seed) {
  const copy = [...events];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function denseNullStream(count, { role = null, gap = JUST_BELOW, kindAt = () => 'note' } = {}) {
  const events = [];
  let cursor = f(0);
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    const end = start.add(new F(1, 2));
    events.push(span({
      id: `dense:${index}`,
      start: start.toString(),
      end: end.toString(),
      role: typeof role === 'function' ? role(index) : role,
      kind: kindAt(index),
    }));
    cursor = end.add(gap);
  }
  return events;
}

const below = value => f(value).add(JUST_BELOW).toString();

const ADVERSARIAL_FIXTURES = [
  ['empty project', []],
  ['lone role-null event', [span({ id: 'lone', start: 0, end: 1 })]],
  ['lone assigned event', [span({ id: 'lone', start: 0, end: 1, role: 'Melody' })]],
  ['role-null pair just below the safe grid', [
    span({ id: 'a', start: 0, end: 1 }),
    span({ id: 'b', start: below(1), end: 2 }),
  ]],
  ['role-null pair exactly at the safe grid', [
    span({ id: 'a', start: 0, end: 1 }),
    span({ id: 'b', start: f(1).add(EXACT_GRID).toString(), end: 2 }),
  ]],
  ['role-null pair above the safe grid', [
    span({ id: 'a', start: 0, end: 1 }),
    span({ id: 'b', start: f(1).add(ABOVE_GRID).toString(), end: 2 }),
  ]],
  ['role-null pair at zero separation', [
    span({ id: 'a', start: 0, end: 1 }),
    span({ id: 'b', start: 1, end: 2 }),
  ]],
  ['assigned and role-null mixed across one sub-grid separation', [
    span({ id: 'assigned', start: 0, end: 1, role: 'Melody' }),
    span({ id: 'null', start: below(1), end: 2 }),
  ]],
  ['role-null earlier, assigned later', [
    span({ id: 'null', start: 0, end: 1 }),
    span({ id: 'assigned', start: below(1), end: 2, role: 'Chord1' }),
  ]],
  ['fully assigned project has no unresolved relationship', [
    span({ id: 'a', start: 0, end: 1, role: 'Melody' }),
    span({ id: 'b', start: below(1), end: 2, role: 'Melody' }),
    span({ id: 'c', start: 0, end: 2, role: 'Chord1' }),
  ]],
  ['overlapping role-null spans', [
    span({ id: 'a', start: 0, end: 3 }),
    span({ id: 'b', start: 1, end: 2 }),
    span({ id: 'c', start: below(3), end: 4 }),
  ]],
  ['nested role-null spans', [
    span({ id: 'outer', start: 0, end: 4 }),
    span({ id: 'inner', start: 1, end: 2 }),
    span({ id: 'after-inner', start: below(2), end: 3 }),
    span({ id: 'after-outer', start: below(4), end: 5 }),
  ]],
  ['equal boundaries on both sides of one sub-grid separation', [
    span({ id: 'left-1', start: 0, end: 1 }),
    span({ id: 'left-2', start: 0, end: 1 }),
    span({ id: 'right-1', start: below(1), end: 2 }),
    span({ id: 'right-2', start: below(1), end: 2 }),
  ]],
  ['same start, different end', [
    span({ id: 'short', start: 0, end: 1 }),
    span({ id: 'long', start: 0, end: 2 }),
    span({ id: 'after-short', start: below(1), end: '3/2' }),
    span({ id: 'after-long', start: below(2), end: 3 }),
  ]],
  ['delimiter-colliding event ids', [
    span({ id: 'a', start: 0, end: 1 }),
    span({ id: 'a->b', start: 0, end: 1 }),
    span({ id: 'b->c', start: below(1), end: 2 }),
    span({ id: 'c', start: below(1), end: 2 }),
    span({ id: 'd@1..2', start: below(2), end: 3 }),
    span({ id: 'e..f', start: below(3), end: 4 }),
  ]],
  ['delimiter-colliding ids mixed with assigned roles', [
    span({ id: 'x@0..1', start: 0, end: 1, role: 'Melody' }),
    span({ id: 'y->z', start: below(1), end: 2 }),
    span({ id: 'y->z->w', start: below(1), end: 2, role: 'Chord2' }),
  ]],
  ['notes and rests mixed', [
    span({ id: 'note-a', start: 0, end: 1, kind: 'note' }),
    span({ id: 'rest-a', start: below(1), end: 2, kind: 'rest' }),
    span({ id: 'note-b', start: below(2), end: 3, kind: 'note', role: 'Melody' }),
    span({ id: 'rest-b', start: below(3), end: 4, kind: 'rest' }),
  ]],
  ['chain of role-null events each separated below the grid', denseNullStream(12)],
  ['chain of assigned events each separated below the grid', denseNullStream(12, { role: 'Melody' })],
  ['alternating assigned and role-null chain', denseNullStream(16, { role: index => (index % 2 ? 'Melody' : null) })],
  ['role-null chain of alternating notes and rests', denseNullStream(16, { kindAt: index => (index % 2 ? 'rest' : 'note') })],
  ['role-null chain separated exactly at the grid', denseNullStream(12, { gap: EXACT_GRID })],
  ['role-null chain separated above the grid', denseNullStream(12, { gap: ABOVE_GRID })],
  ['dense many-to-many sub-grid boundary cluster', [
    ...Array.from({ length: 8 }, (unused, index) => span({ id: `left:${index}`, start: 0, end: 1 })),
    ...Array.from({ length: 8 }, (unused, index) => span({ id: `right:${index}`, start: below(1), end: 2 })),
  ]],
  ['dense cluster with half the events assigned', [
    ...Array.from({ length: 8 }, (unused, index) => span({
      id: `left:${index}`, start: 0, end: 1, role: index % 2 ? 'Chord1' : null,
    })),
    ...Array.from({ length: 8 }, (unused, index) => span({
      id: `right:${index}`, start: below(1), end: 2, role: index % 2 ? 'Chord1' : null,
    })),
  ]],
  ['multi-digit rational ordering 9 -> 10', [
    span({ id: 'nine', start: 8, end: 9 }),
    span({ id: 'ten', start: below(9), end: 10 }),
    span({ id: 'eleven', start: below(10), end: 11 }),
  ]],
  ['staggered ends feeding one later start', [
    span({ id: 'end-a', start: 0, end: '15/16' }),
    span({ id: 'end-b', start: 0, end: '31/32' }),
    span({ id: 'end-c', start: 0, end: '63/64' }),
    span({ id: 'later', start: 1, end: 2 }),
  ]],
  ['one end feeding staggered later starts', [
    span({ id: 'earlier', start: 0, end: 1 }),
    span({ id: 'start-a', start: '17/16', end: 2 }),
    span({ id: 'start-b', start: '33/32', end: 2 }),
    span({ id: 'start-c', start: '65/64', end: 2 }),
  ]],
];

// ---------------------------------------------------------------------------
// 1. Semantic equivalence with the brute-force oracle
// ---------------------------------------------------------------------------

for (const [name, events] of ADVERSARIAL_FIXTURES) {
  test(`F4 equivalence: ${name}`, () => {
    const project = fixture(events);
    const expected = referenceUnresolvedStreamIssues(project);
    assert.deepEqual(analyzeUnresolvedStreamIssues(project).map(item => ({ ...item })), expected);
    assert.deepEqual(
      analyzeProjectMicroTiming(project).unresolvedStreamIssues.map(item => ({ ...item })),
      expected,
      'the full analyzer report must carry exactly the reference issue set',
    );
  });

  test(`F4 equivalence under reordered input: ${name}`, () => {
    const baseline = referenceUnresolvedStreamIssues(fixture(events));
    for (const seed of [1, 7, 4242]) {
      const permuted = fixture(permute(events, seed));
      assert.deepEqual(
        referenceUnresolvedStreamIssues(permuted),
        baseline,
        'reference oracle must itself be order-independent',
      );
      assert.deepEqual(
        analyzeUnresolvedStreamIssues(permuted).map(item => ({ ...item })),
        baseline,
        `optimized scan changed answer for seed ${seed}`,
      );
    }
  });
}

test('F4 equivalence: dense MusicXML-like role-null stream', () => {
  for (const size of [50, 200, 501]) {
    const project = fixture(denseNullStream(size));
    assert.deepEqual(
      analyzeUnresolvedStreamIssues(project).map(item => ({ ...item })),
      referenceUnresolvedStreamIssues(project),
      `dense role-null stream of ${size} events diverged from the reference`,
    );
  }
});

test('F4 equivalence: dense mixed stream with overlaps, rests and delimiter ids', () => {
  const events = [];
  let cursor = f(0);
  for (let index = 0; index < 240; index += 1) {
    const start = cursor;
    const end = start.add(new F(1, 2));
    events.push(span({
      id: `mix->${index}@${index}..${index + 1}`,
      start: start.toString(),
      end: end.toString(),
      role: index % 3 === 0 ? 'Melody' : index % 3 === 1 ? null : 'Chord3',
      kind: index % 5 === 0 ? 'rest' : 'note',
    }));
    if (index % 4 === 0) {
      events.push(span({
        id: `overlap->${index}`,
        start: start.toString(),
        end: end.add(new F(1, 4)).toString(),
        role: index % 8 === 0 ? null : 'Chord1',
      }));
    }
    cursor = end.add(index % 7 === 0 ? EXACT_GRID : JUST_BELOW);
  }
  const project = fixture(events);
  assert.deepEqual(
    analyzeUnresolvedStreamIssues(project).map(item => ({ ...item })),
    referenceUnresolvedStreamIssues(project),
  );
});

test('F4 preserves exact rational comparison at the 1/64 boundary', () => {
  const project = fixture([
    span({ id: 'exact-left', start: 0, end: 1 }),
    span({ id: 'exact-right', start: f(1).add(EXACT_GRID).toString(), end: 2 }),
    span({ id: 'below-left', start: 4, end: 5 }),
    span({ id: 'below-right', start: below(5), end: 6 }),
  ]);
  const issues = analyzeUnresolvedStreamIssues(project);
  assert.deepEqual(issues.map(item => item.eventIds), [['below-left', 'below-right']]);
  assert.equal(issues[0].length, JUST_BELOW.toString());
});

test('F4 keeps the structural dedupe identity and never collapses delimiter collisions', () => {
  const project = fixture([
    span({ id: 'a', start: 0, end: 1 }),
    span({ id: 'a->b', start: 0, end: 1 }),
    span({ id: 'b->c', start: below(1), end: 2 }),
    span({ id: 'c', start: below(1), end: 2 }),
  ]);
  const issues = analyzeUnresolvedStreamIssues(project);
  assert.deepEqual(issues.map(item => item.eventIds), [
    ['a', 'b->c'],
    ['a', 'c'],
    ['a->b', 'b->c'],
    ['a->b', 'c'],
  ]);
  assert.equal(new Set(issues.map(item => JSON.stringify(item.eventIds))).size, 4);
});

test('F4 output ordering is deterministic and independent of input order', () => {
  const events = denseNullStream(40);
  const baseline = analyzeUnresolvedStreamIssues(fixture(events)).map(item => JSON.stringify(item.eventIds));
  for (const seed of [3, 11, 99, 5150]) {
    assert.deepEqual(
      analyzeUnresolvedStreamIssues(fixture(permute(events, seed))).map(item => JSON.stringify(item.eventIds)),
      baseline,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Scan-shape regression: bounded candidate inspections
// ---------------------------------------------------------------------------

function measure(size) {
  const project = fixture(denseNullStream(size));
  const instrumentation = {};
  const started = process.hrtime.bigint();
  analyzeUnresolvedStreamIssues(project, { instrumentation });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return { ...instrumentation, seconds };
}

test('F4 the unresolved-stream scan inspects a bounded candidate set, not all pairs', () => {
  for (const size of [500, 1000, 2000, 4000]) {
    const measured = measure(size);
    assert.equal(measured.spanCount, size);
    assert.equal(measured.issueCount, size - 1);
    // Output-sensitive bound. The restored all-pairs scan inspects
    // unassigned x (n - 1) ~= n^2 candidates and blows straight through this.
    assert.ok(
      measured.candidateInspections <= 4 * (measured.spanCount + measured.issueCount),
      `unresolved-stream scan inspected ${measured.candidateInspections} candidates for ${size} spans; `
      + `expected at most ${4 * (measured.spanCount + measured.issueCount)}`,
    );
  }
});

test('F4 the all-pairs scan this replaced does violate that bound', () => {
  // Pins what the regression above is actually protecting: the reference oracle
  // is the pre-C2B production behaviour, and it cannot satisfy the bound.
  const project = fixture(denseNullStream(500));
  const instrumentation = {};
  referenceUnresolvedStreamIssues(project, instrumentation);
  assert.equal(instrumentation.spanCount, 500);
  assert.ok(
    instrumentation.candidateInspections > 4 * (instrumentation.spanCount + instrumentation.issueCount),
    'the reference oracle is supposed to be the quadratic implementation',
  );
});

test('F4 candidate inspections grow with the reported relationships, not with n squared', () => {
  const small = measure(500);
  const large = measure(4000);
  const sizeRatio = large.spanCount / small.spanCount;
  const inspectionRatio = large.candidateInspections / Math.max(1, small.candidateInspections);
  assert.ok(
    inspectionRatio <= sizeRatio * 1.5,
    `inspections grew ${inspectionRatio.toFixed(2)}x for an ${sizeRatio}x larger stream`,
  );
});

test('F4 a large role-null MusicXML-like stream stays inside a synchronous readiness budget', () => {
  // Deliberately coarse. The operation-count regressions above are the real
  // guard; this only records that 4000 role-null events no longer take the
  // tens of seconds the all-pairs scan needed.
  const measured = measure(4000);
  assert.ok(measured.seconds < 5, `4000-event unresolved-stream scan took ${measured.seconds.toFixed(3)}s`);
});
