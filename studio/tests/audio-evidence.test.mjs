import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource, createCanonicalNoteEvent, createCanonicalProject } from '../backend/canonical/index.mjs';
import { AUDIO_ALIGNMENT_SCHEMA, validateAudioAlignmentReport, attachAudioAlignmentEvidence } from '../backend/audio/index.mjs';
import { evaluateProjectReadiness } from '../backend/final/readiness.mjs';

function project() {
  const source = createSource({ id: 'official', label: 'Official', kind: 'official-musicxml', authority: 'primary-symbolic' });
  return createCanonicalProject({
    id: 'song-1', title: 'Song 1', sources: [source],
    events: [createCanonicalNoteEvent({ id: 'official:n1', pitch: 60, start: '0', end: '1', sourceIds: ['official'] })],
    metadata: { sourceComplete: true },
  });
}

function report(overrides = {}) {
  const base = {
    schema: AUDIO_ALIGNMENT_SCHEMA,
    audio: { filename: 'original.m4a', sha256: 'a'.repeat(64), input_bytes: 1000, decoded_sample_rate: 22050 },
    symbolic: { project_id: 'song-1', source_ids: ['official'], score_frames_per_beat: 8, end_beat: 4 },
    alignment: {
      control_points: [
        { beat: 0, seconds: 0, expected_bpm: 120, local_bpm_from_alignment: null, tempo_drift_percent: null },
        { beat: 1, seconds: 0.5, expected_bpm: 120, local_bpm_from_alignment: 120, tempo_drift_percent: 0 },
        { beat: 2, seconds: 1.0, expected_bpm: 120, local_bpm_from_alignment: 120, tempo_drift_percent: 0 },
      ],
      metrics: {
        mean_chroma_similarity: 0.85,
        p10_chroma_similarity: 0.60,
        score_frame_coverage: 1,
        audio_frame_coverage: 0.90,
        confidence: 0.85,
      },
      tempo_drift: { sample_count: 2, median_drift_percent: 0, p95_absolute_drift_percent: 0 },
    },
    evidence_policy: {
      changes_symbolic_truth: false,
      valid_for: ['time-alignment', 'tempo-drift'],
      not_valid_by_itself_for: ['exact-note-identity', 'automatic-repitch'],
    },
  };
  return { ...base, ...overrides };
}

test('valid audio alignment report is accepted as evidence without mutating symbolic events', () => {
  const original = project();
  const before = JSON.stringify(original.events);
  const attached = attachAudioAlignmentEvidence(original, report(), { sourceId: 'original-audio' });

  assert.equal(JSON.stringify(attached.events), before);
  assert.equal(attached.sources.length, 2);
  const audio = attached.sources.find(source => source.id === 'original-audio');
  assert.equal(audio.kind, 'original-audio');
  assert.equal(audio.authority, 'primary-audio');
  assert.equal(audio.sha256, 'a'.repeat(64));
  assert.equal(attached.metadata.audioAlignmentEvidence.length, 1);
  assert.equal(attached.metadata.audioAlignmentEvidence[0].sourceId, 'original-audio');
});

test('audio report must target the exact Canonical project', () => {
  const bad = report({ symbolic: { project_id: 'other-project' } });
  assert.throws(() => validateAudioAlignmentReport(bad, project()), /does not match/);
});

test('alignment search method survives evidence attachment without changing source notes', () => {
  const original = project();
  const input = report();
  input.alignment.method = {
    name: 'tempo-normalized-subsequence-dtw@2', analysis_step_seconds: .05,
    steps: [[1, 1], [1, 2], [2, 1]], search_speed_ratio_bounds: [.5, 2],
  };
  const attached = attachAudioAlignmentEvidence(original, input);
  assert.deepEqual(attached.events, original.events);
  assert.deepEqual(attached.sources.at(-1).metadata.alignmentMethod, input.alignment.method);
  assert.deepEqual(attached.metadata.audioAlignmentEvidence[0].alignmentMethod, input.alignment.method);
  input.alignment.method.steps[0][0] = 100;
  assert.equal(attached.metadata.audioAlignmentEvidence[0].alignmentMethod.steps[0][0], 1);
});

test('audio report cannot claim permission to mutate symbolic truth', () => {
  const bad = report({ evidence_policy: { changes_symbolic_truth: true } });
  assert.throws(() => validateAudioAlignmentReport(bad, project()), /forbid symbolic mutation/);
});

test('non-monotonic time mapping fails closed', () => {
  const bad = report();
  bad.alignment.control_points[2].seconds = 0.25;
  assert.throws(() => validateAudioAlignmentReport(bad, project()), /seconds must be monotonic/);
});

test('weak alignment remains explicit evidence with warnings instead of becoming a false PASS', () => {
  const weak = report();
  weak.alignment.metrics.confidence = 0.4;
  weak.alignment.metrics.score_frame_coverage = 0.7;
  weak.alignment.metrics.audio_frame_coverage = 0.5;
  const validation = validateAudioAlignmentReport(weak, project());
  assert.equal(validation.valid, true);
  assert.ok(validation.warnings.includes('LOW_ALIGNMENT_CONFIDENCE'));
  assert.ok(validation.warnings.includes('LOW_SCORE_FRAME_COVERAGE'));
  assert.ok(validation.warnings.includes('LOW_AUDIO_FRAME_COVERAGE'));
});

test('collapsed beat intervals stay diagnostic evidence and cannot pass the original-audio gate', () => {
  const collapsed = report();
  collapsed.alignment.control_points[2].seconds = collapsed.alignment.control_points[1].seconds;
  const original = project();
  const pointsBefore = structuredClone(collapsed.alignment.control_points);
  const validation = validateAudioAlignmentReport(collapsed, original);
  assert.equal(validation.valid, true, 'retain the report for inspection rather than erase it');
  assert.ok(validation.warnings.includes('COLLAPSED_ALIGNMENT_INTERVAL'));
  const attached = attachAudioAlignmentEvidence(original, collapsed);
  assert.deepEqual(attached.events, original.events);
  assert.deepEqual(attached.metadata.audioAlignmentEvidence[0].controlPoints, pointsBefore);
  assert.deepEqual(collapsed.alignment.control_points, pointsBefore);
  const gate = evaluateProjectReadiness({ project: attached }).gates.originalAudio;
  assert.equal(gate.status, 'PENDING');
  assert.ok(gate.blockers.includes('AUDIO_ALIGNMENT_REVIEW_REQUIRED'));
  assert.ok(gate.warnings.includes('COLLAPSED_ALIGNMENT_INTERVAL'));
});

test('positive elapsed time is not rejected by an invented tempo-drift threshold', () => {
  const variable = report();
  variable.alignment.control_points[2].seconds = 8;
  assert.deepEqual(validateAudioAlignmentReport(variable, project()).warnings, []);
});
