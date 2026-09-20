// Pure-function tests for the offline Jev routing evaluation harness.
// No network call is made here, and none may be added: the harness is only
// allowed to reach TypeSafe under an explicit --live flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUESTIONS, ROUTES, buildCase, casesFromDataDir, buildPayload, summarize, estimateCostUsd, assertUsableAnswers, main }
  from '../scripts/jev-routing-eval.mjs';

const run = (overrides = {}) => ({
  run_id: 'run-1', revision: 3, state: 'awaiting_review',
  pending_step: { step: 'apply_decisions' }, candidate_id: 'cand-1', final_artifact_id: null,
  blockers: [{ code: 'AWAITING_ACCEPTED_DECISIONS' }],
  readiness_blockers: ['AWAITING_REVIEW_EVIDENCE'],
  warnings: [{ code: 'LOW_CONFIDENCE_ROLE' }],
  steps: [{ step: 'intake' }, { step: 'suggest' }],
  gates: { technical_ok: true, source_ok: false },
  review_requests: [{ code: 'ARRANGEMENT_DECISIONS_REQUIRED', lane_count: 11 }],
  ...overrides,
});

test('question set keeps each primitive matched to what its answer means', () => {
  assert.equal(QUESTIONS.route.type, 'choice');
  // A no-match outcome must exist: the model cannot pick a path that was omitted.
  assert.ok(Object.hasOwn(QUESTIONS.route.criteria, 'human_review'));
  assert.equal(Object.keys(QUESTIONS.route.criteria).length, 4);
  // Degree belongs to a score; a noul near 0.5 would mean "equally likely", not "half".
  assert.equal(QUESTIONS.evidence_gap.type, 'score');
  assert.ok(QUESTIONS.evidence_gap.criteria.length >= 2);
  assert.equal(QUESTIONS.human_judgment_required.type, 'noul');
  // Question keys are not sent to the model, so every instruction must stand alone.
  for (const question of Object.values(QUESTIONS)) {
    assert.ok(question.instructions.length > 80, 'instructions must carry their full meaning');
  }
});

test('buildCase summarizes a halted run without carrying the whole record', () => {
  const record = run();
  const built = buildCase(record, record.review_requests[0], { source: 'r.json' });
  assert.equal(built.id, 'run-1:3:0:ARRANGEMENT_DECISIONS_REQUIRED');
  assert.equal(built.state.run.pending_step, 'apply_decisions');
  assert.equal(built.state.run.has_candidate, true);
  assert.equal(built.state.run.has_final_artifact, false);
  assert.deepEqual(built.state.blockers, ['AWAITING_ACCEPTED_DECISIONS']);
  assert.deepEqual(built.state.readiness_blockers, ['AWAITING_REVIEW_EVIDENCE']);
  assert.deepEqual(built.state.warnings, ['LOW_CONFIDENCE_ROLE']);
  assert.equal(built.state.counts.steps, 2);
  assert.equal(built.state.review_request.code, 'ARRANGEMENT_DECISIONS_REQUIRED');
  // Identifiers that carry no judgment signal stay out of the billed state.
  assert.equal(built.state.run.candidate_id, undefined);
  assert.ok(!('artifact_ids' in built.state));
});

test('buildCase tolerates a sparse run record', () => {
  const built = buildCase({ run_id: 'r', revision: 0 }, null);
  assert.equal(built.id, 'r:0:0:request');
  assert.deepEqual(built.state.blockers, []);
  assert.equal(built.state.counts.review_requests, 0);
  assert.equal(built.state.review_request, null);
});

test('casesFromDataDir reads receipts, skips the irrelevant and dedupes per revision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-'));
  const receipts = join(directory, 'receipts');
  mkdirSync(receipts);
  const write = (name, body) => writeFileSync(join(receipts, name), JSON.stringify(body));
  // A run is re-read many times; the same revision and code is one case.
  write('1.json', { result: { run: run() } });
  write('2.json', { result: { run: run() } });
  // No review request: not a case.
  write('3.json', { result: { run: run({ review_requests: [] }) } });
  // Not a run status result at all.
  write('4.json', { result: { artifact: { type: 'final_mml' } } });
  // A later revision of the same run is a distinct case.
  write('5.json', { result: { run: run({ revision: 4 }) } });
  // Unparseable receipts are skipped rather than failing the sweep.
  writeFileSync(join(receipts, '6.json'), '{ not json');

  const cases = casesFromDataDir(directory);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map(entry => entry.id).sort(), [
    'run-1:3:0:ARRANGEMENT_DECISIONS_REQUIRED',
    'run-1:4:0:ARRANGEMENT_DECISIONS_REQUIRED',
  ]);
});

test('casesFromDataDir refuses a directory that is not an agent workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-empty-'));
  assert.throws(() => casesFromDataDir(directory), /No receipts directory/);
});

test('buildPayload asks every question over one state in a single request', () => {
  const record = run();
  const payload = buildPayload(buildCase(record, record.review_requests[0]), 'jev-latest');
  assert.equal(payload.model, 'jev-latest');
  assert.deepEqual(Object.keys(payload.questions), ['route', 'evidence_gap', 'human_judgment_required']);
  assert.equal(payload.state.review_request.code, 'ARRANGEMENT_DECISIONS_REQUIRED');
});

test('summarize reports raw distributions and applies no threshold', () => {
  const answered = (id, choice, confidence, label) => ({
    id, label: label ?? null,
    answers: { route: { type: 'choice', choice, confidence, probabilities: {} } },
    usage: { input_tokens: 1000, output_tokens: 0 },
  });
  const summary = summarize([
    answered('a', 'deep_review', 0.91, 'deep_review'),
    answered('b', 'human_review', 0.72, 'deep_review'),
    answered('c', 'needs_source', 0.44, 'needs_source'),
    { id: 'd', label: null, answers: null },
  ]);
  assert.equal(summary.cases, 4);
  assert.equal(summary.answered, 3);
  assert.equal(summary.routes.deep_review, 1);
  assert.equal(summary.routes.continue_automatically, 0);
  assert.deepEqual(summary.confidence_bands, { high: 1, medium: 1, low: 1 });
  assert.equal(summary.input_tokens, 3000);
  assert.ok(Math.abs(summary.estimated_cost_usd - estimateCostUsd(3000)) < 1e-12);
  // Separation is the point of the harness: agreement per label, not an overall score.
  assert.equal(summary.separation.deep_review.count, 2);
  assert.equal(summary.separation.deep_review.agreement, 0.5);
  assert.equal(summary.separation.needs_source.agreement, 1);
  assert.match(summary.notice, /No threshold is applied/);
});

test('summarize omits the separation report when nothing is labeled', () => {
  const summary = summarize([{ id: 'a', label: null, answers: { route: { choice: 'deep_review', confidence: 0.9 } } }]);
  assert.equal(summary.separation, null);
});

test('cost estimate follows the published input price', () => {
  assert.ok(Math.abs(estimateCostUsd(1e6) - 0.042) < 1e-12);
  assert.equal(estimateCostUsd(0), 0);
});

test('the summary tallies exactly the routes the question offers', () => {
  // Editing one without the other would silently drop cases from the report.
  assert.deepEqual([...ROUTES], Object.keys(QUESTIONS.route.criteria));
});

test('one run raising the same code twice yields two cases, not a duplicate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-dup-'));
  mkdirSync(join(directory, 'receipts'));
  const record = run({ review_requests: [
    { code: 'EVIDENCE_NEEDED', lane: 'bass' },
    { code: 'EVIDENCE_NEEDED', lane: 'melody' },
  ] });
  writeFileSync(join(directory, 'receipts', '1.json'), JSON.stringify({ result: { run: record } }));
  // Re-reading the same run must still collapse to the same two cases.
  writeFileSync(join(directory, 'receipts', '2.json'), JSON.stringify({ result: { run: record } }));

  const cases = casesFromDataDir(directory);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map(entry => entry.state.review_request.lane), ['bass', 'melody']);
});

test('summarize counts failed cases so a partial live run is visible', () => {
  const summary = summarize([
    { id: 'a', answers: { route: { choice: 'deep_review', confidence: 0.9 } }, usage: { input_tokens: 10 } },
    { id: 'b', answers: null, error: { message: 'HTTP 429' } },
  ]);
  assert.equal(summary.cases, 2);
  assert.equal(summary.answered, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.input_tokens, 10);
});

test('main names a malformed case instead of failing with a type error', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-cases-'));
  const file = join(directory, 'cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'no-state' }]));
  await assert.rejects(main(['--cases', file]), /Case no-state has no state object/);
});

test('main refuses a limit that is not a positive integer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-limit-'));
  const file = join(directory, 'cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} } }]));
  await assert.rejects(main(['--cases', file, '--limit', 'abc']), /--limit must be a positive integer/);
  await assert.rejects(main(['--cases', file, '--limit', '0']), /--limit must be a positive integer/);
});

test('main refuses to go live without a key in the environment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-key-'));
  const file = join(directory, 'cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} } }]));
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try { await assert.rejects(main(['--cases', file, '--live']), /TYPESAFE_API_KEY/); }
  finally { if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved; }
});

test('a 2xx without a usable route is a failure, not a silent drop', () => {
  // Credits are already spent by the time these come back; they must be visible.
  assert.throws(() => assertUsableAnswers({}), /without an answers object/);
  assert.throws(() => assertUsableAnswers({ answers: {} }), /without a route choice/);
  assert.throws(() => assertUsableAnswers({ answers: { route: {} } }), /without a route choice/);
  assert.throws(() => assertUsableAnswers({ answers: { route: { choice: 'deep_revew' } } }), /unknown route/);
  const good = { answers: { route: { choice: 'deep_review', confidence: 0.8 } } };
  assert.equal(assertUsableAnswers(good), good);
});

test('assertUsableAnswers keeps the paid-for body in the failure details', () => {
  try {
    assertUsableAnswers({ answers: { route: { choice: 'nope' } } });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.details.answers.route.choice, 'nope');
    assert.deepEqual(error.details.expected, [...ROUTES]);
  }
});

test('main refuses an expected-route label that is not a route', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-label-'));
  const file = join(directory, 'cases.json');
  // A label embedded in --cases must be checked too, not only --labels.
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} }, label: 'deep_revew' }]));
  await assert.rejects(main(['--cases', file]), /is not a route/);

  const labels = join(directory, 'labels.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} } }]));
  writeFileSync(labels, JSON.stringify({ a: 'humanreview' }));
  await assert.rejects(main(['--cases', file, '--labels', labels]), /is not a route/);
});

test('main accepts a label that is a real route', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-label-ok-'));
  const file = join(directory, 'cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} }, label: 'deep_review' }]));
  assert.equal(await main(['--cases', file]), 0);
});

test('summarize reports the two questions that are billed alongside route', () => {
  // Every case pays for all three answers, so all three must appear in the report.
  const summary = summarize([
    { id: 'a', answers: {
      route: { choice: 'deep_review', confidence: 0.9 },
      evidence_gap: { score: 2 }, human_judgment_required: { noul: 0.8 },
    }, usage: { input_tokens: 100 } },
    { id: 'b', answers: {
      route: { choice: 'needs_source', confidence: 0.7 },
      evidence_gap: { score: 3 }, human_judgment_required: { noul: 0.2 },
    }, usage: { input_tokens: 100 } },
  ]);
  assert.equal(summary.mean_evidence_gap, 2.5);
  assert.equal(summary.evidence_gap_answers, 2);
  assert.ok(Math.abs(summary.mean_human_judgment_required - 0.5) < 1e-12);
  assert.equal(summary.human_judgment_answers, 2);
});

test('summarize leaves the extra means null rather than inventing zero', () => {
  const summary = summarize([{ id: 'a', answers: { route: { choice: 'deep_review', confidence: 0.9 } } }]);
  assert.equal(summary.mean_evidence_gap, null);
  assert.equal(summary.evidence_gap_answers, 0);
  assert.equal(summary.mean_human_judgment_required, null);
});

test('summarize counts answers that reported no usage instead of costing nothing', () => {
  const summary = summarize([
    { id: 'a', answers: { route: { choice: 'deep_review', confidence: 0.9 } }, usage: { input_tokens: 500 } },
    { id: 'b', answers: { route: { choice: 'deep_review', confidence: 0.9 } }, usage: null },
    { id: 'c', answers: { route: { choice: 'deep_review', confidence: 0.9 } } },
  ]);
  assert.equal(summary.input_tokens, 500);
  assert.equal(summary.answers_without_usage, 2);
});

test('main proves --out is writable before anything is spent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-out-'));
  const file = join(directory, 'cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} } }]));
  // A directory that does not exist must be refused up front, not after the loop.
  await assert.rejects(
    main(['--cases', file, '--out', join(directory, 'missing', 'out.json')]),
    /Cannot write --out/,
  );
});

test('main refuses a timeout that is not a positive integer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-timeout-'));
  const file = join(directory, 'cases.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', state: { run: {} } }]));
  await assert.rejects(main(['--cases', file, '--timeout', 'soon']), /--timeout must be a positive integer/);
  await assert.rejects(main(['--cases', file, '--timeout', '0']), /--timeout must be a positive integer/);
});

test('the written result marks whether it came from a dry run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-eval-mode-'));
  const cases = join(directory, 'cases.json');
  const out = join(directory, 'out.json');
  writeFileSync(cases, JSON.stringify([{ id: 'a', state: { run: {} } }]));
  assert.equal(await main(['--cases', cases, '--out', out]), 0);
  // Without the marker, a dry run's zero cost reads as a real measured cost.
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).mode, 'dry-run');
});
