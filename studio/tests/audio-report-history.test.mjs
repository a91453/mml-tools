import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_REVISION_SCHEMA, audioReportHash, readAudioHistory,
  appendAudioReport, activeAudioEntries, exportAudioHistory, unpackAudioSubmission,
} from '../backend/application/audio-report-history.mjs';
const candidate = 'g11d:rev:' + 'c'.repeat(64);
const raw = (confidence = .45, audio = 'a'.repeat(64)) => ({
  schema: 'mabinogi-mobile-mml-studio/audio-alignment@1', audio: { sha256: audio },
  symbolic: { project_id: 'candidate' }, alignment: { metrics: { confidence } },
  evidence_policy: { changes_symbolic_truth: false },
});
const append = (history, report, revision = null) => appendAudioReport(history, {
  report, revision, authenticatedOwner: 'owner:test', warnings: ['TEST_WARNING'], at: '2026-09-22T12:00:00.000Z',
});
const revision = hash => ({ expected_previous_report_sha256: hash, reason: 'Recomputed from source; not a PASS.', submitted_by: 'agent:test' });

test('stable hashes do not depend on JSON object key order', () => {
  assert.equal(audioReportHash({ b: [2, 1], a: 1 }), audioReportHash({ a: 1, b: [2, 1] }));
  assert.notEqual(audioReportHash({ b: [2, 1] }), audioReportHash({ b: [1, 2] }));
  assert.throws(() => audioReportHash({ x: NaN }), /finite JSON/);
});
test('legacy array export is read-only and does not invent authorship', () => {
  const source = [raw()]; const before = JSON.stringify(source);
  const history = readAudioHistory(source, candidate);
  assert.equal(history.entries[0].authenticated_owner, null);
  assert.equal(history.entries[0].attached_at, null);
  assert.equal(exportAudioHistory(history).entries[0].active, true);
  assert.equal(JSON.stringify(source), before);
});
test('explicit revision keeps old report and warnings, selects new head', () => {
  const first = append(readAudioHistory(null, candidate), raw());
  const before = JSON.stringify(first.history);
  const next = append(first.history, raw(.50), revision(first.entry.report_sha256));
  assert.equal(next.history.entries.length, 2);
  assert.deepEqual(next.history.entries[0], first.entry);
  assert.deepEqual(next.history.entries[0].warnings, ['TEST_WARNING']);
  assert.equal(activeAudioEntries(next.history)[0].report.alignment.metrics.confidence, .50);
  assert.deepEqual(exportAudioHistory(next.history).entries.map(e => e.active), [false, true]);
  assert.equal(JSON.stringify(first.history), before);
});
test('duplicate raw reports cannot silently replace evidence', () => {
  const first = append(readAudioHistory(null, candidate), raw());
  assert.throws(() => append(first.history, raw(.8)), /explicit revision/);
  assert.throws(() => append(first.history, raw()), /explicit revision/);
});
test('stale, absent, no-op and cross-recording replacements are refused', () => {
  const first = append(readAudioHistory(null, candidate), raw());
  assert.throws(() => append(first.history, raw(.8), revision('f'.repeat(64))), /stale/);
  assert.throws(() => append(first.history, raw(), revision(first.entry.report_sha256)), /no-op/);
  assert.throws(() => append(first.history, raw(.8, 'b'.repeat(64)), revision(first.entry.report_sha256)), /no report/);
  assert.throws(() => append(readAudioHistory(null, candidate), raw(), revision('f'.repeat(64))), /no report/);
});
test('exact active retry does not append; old retry cannot revert a later head', () => {
  const first = append(readAudioHistory(null, candidate), raw());
  const second = append(first.history, raw(.6), revision(first.entry.report_sha256));
  const retry = append(second.history, raw(.6), revision(first.entry.report_sha256));
  assert.equal(retry.replayed, true); assert.deepEqual(retry.history, second.history);
  assert.throws(() => append(second.history, raw(.6), { ...revision(first.entry.report_sha256), submitted_by: 'other' }), /stale/);
  const third = append(second.history, raw(.7), revision(second.entry.report_sha256));
  assert.throws(() => append(third.history, raw(.6), revision(first.entry.report_sha256)), /stale/);
  assert.throws(() => append(third.history, raw(), revision(third.entry.report_sha256)), /historical/);
});
test('independent recording heads and legacy migration preserve every input', () => {
  const reports = [raw(), raw(.4, 'b'.repeat(64))];
  const history = readAudioHistory(reports, candidate);
  const next = append(history, raw(.6), revision(history.entries[0].report_sha256));
  assert.equal(activeAudioEntries(next.history).length, 2);
  assert.deepEqual(next.history.entries.slice(0, 2).map(e => e.report), reports);
  assert.deepEqual(readAudioHistory(next.history, candidate), next.history);
});
test('corrupt history and cross-candidate use fail closed', () => {
  const first = append(readAudioHistory(null, candidate), raw());
  const corrupt = structuredClone(first.history); corrupt.entries[0].report.alignment.metrics.confidence = 1;
  assert.throws(() => readAudioHistory(corrupt, candidate), /corrupt/);
  assert.throws(() => readAudioHistory(first.history, 'other'), /cross-candidate/);
  const second = append(first.history, raw(.6), revision(first.entry.report_sha256));
  second.history.entries[1].supersedes_report_sha256 = 'f'.repeat(64);
  assert.throws(() => readAudioHistory(second.history, candidate), /chain/);
});
test('versioned submission has a closed shape, actor and reason are mandatory', () => {
  const envelope = { schema: AUDIO_REVISION_SCHEMA, report: raw(.6), ...revision('f'.repeat(64)) };
  assert.equal(unpackAudioSubmission(envelope).revision.submitted_by, 'agent:test');
  assert.equal(unpackAudioSubmission(raw()).revision, null);
  for (const extra of [{ accepted: true }, { pass: true }, { confirmations: {} }]) {
    assert.throws(() => unpackAudioSubmission({ ...envelope, ...extra }), /unknown/);
  }
  assert.throws(() => unpackAudioSubmission({ ...envelope, reason: ' ' }), /reason/);
  assert.throws(() => unpackAudioSubmission({ ...envelope, submitted_by: '' }), /submitter/);
  assert.throws(() => unpackAudioSubmission({ ...envelope, report: envelope }), /one Worker/);
});
