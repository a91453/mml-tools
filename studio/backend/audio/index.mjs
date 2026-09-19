import { createSource, createCanonicalProject } from '../canonical/index.mjs';

export const AUDIO_ALIGNMENT_SCHEMA = 'mabinogi-mobile-mml-studio/audio-alignment@1';

const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`${label} must be a finite number`);
  return value;
};

function validateControlPoints(points) {
  if (!Array.isArray(points) || points.length < 2) throw Error('audio alignment requires at least two control points');
  let priorBeat = -Infinity;
  let priorSeconds = -Infinity;
  return points.map((point, index) => {
    if (!point || typeof point !== 'object') throw Error(`control point ${index} is invalid`);
    const beat = finite(point.beat, `control point ${index}.beat`);
    const seconds = finite(point.seconds, `control point ${index}.seconds`);
    if (beat < 0 || seconds < 0) throw Error('audio alignment beat/seconds must be non-negative');
    if (beat < priorBeat) throw Error('audio alignment beats must be monotonic');
    if (seconds < priorSeconds) throw Error('audio alignment seconds must be monotonic');
    priorBeat = beat;
    priorSeconds = seconds;
    return structuredClone(point);
  });
}

export function validateAudioAlignmentReport(report, project) {
  if (!report || typeof report !== 'object') throw Error('audio alignment report must be an object');
  if (report.schema !== AUDIO_ALIGNMENT_SCHEMA) throw Error(`unsupported audio alignment schema: ${report.schema}`);
  if (!report.audio || !/^[a-f0-9]{64}$/i.test(report.audio.sha256 ?? '')) throw Error('audio alignment report requires a SHA-256 audio identity');
  if (!report.symbolic || report.symbolic.project_id !== project?.id) throw Error('audio alignment symbolic project_id does not match the Canonical project');
  if (report.evidence_policy?.changes_symbolic_truth !== false) throw Error('audio alignment evidence policy must explicitly forbid symbolic mutation');

  const points = validateControlPoints(report.alignment?.control_points);
  const metrics = report.alignment?.metrics;
  if (!metrics || typeof metrics !== 'object') throw Error('audio alignment metrics are missing');
  const confidence = finite(metrics.confidence, 'alignment confidence');
  const scoreCoverage = finite(metrics.score_frame_coverage, 'score frame coverage');
  const audioCoverage = finite(metrics.audio_frame_coverage, 'audio frame coverage');
  if (confidence < 0 || confidence > 1 || scoreCoverage < 0 || scoreCoverage > 1 || audioCoverage < 0 || audioCoverage > 1) throw Error('alignment confidence/coverage must be from 0 to 1');

  const warnings = [];
  if (confidence < 0.55) warnings.push('LOW_ALIGNMENT_CONFIDENCE');
  if (scoreCoverage < 0.90) warnings.push('LOW_SCORE_FRAME_COVERAGE');
  if (audioCoverage < 0.60) warnings.push('LOW_AUDIO_FRAME_COVERAGE');
  // DTW can cover every frame while collapsing distinct beats onto the same
  // recording instant. Confidence/coverage alone then hide a degenerate time
  // map. Preserve it as diagnostic evidence, but keep the existing audio gate
  // pending; no tempo threshold or symbolic correction is inferred here.
  if (points.some((point, index) => index > 0
    && point.beat > points[index - 1].beat && point.seconds === points[index - 1].seconds)) {
    warnings.push('COLLAPSED_ALIGNMENT_INTERVAL');
  }

  return Object.freeze({
    valid: true,
    warnings: Object.freeze(warnings),
    controlPoints: Object.freeze(points),
    metrics: Object.freeze(structuredClone(metrics)),
  });
}

export function attachAudioAlignmentEvidence(project, report, options = {}) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.sources) || !Array.isArray(project.events)) throw Error('Canonical project is required');
  const validation = validateAudioAlignmentReport(report, project);
  const sha256 = report.audio.sha256.toLowerCase();
  const sourceId = options.sourceId ?? `original-audio:${sha256.slice(0, 16)}`;
  if (project.sources.some(source => source.id === sourceId)) throw Error(`audio source id already exists: ${sourceId}`);

  const audioSource = createSource({
    id: sourceId,
    label: options.label ?? report.audio.filename ?? 'Original audio',
    kind: 'original-audio',
    authority: 'primary-audio',
    sha256,
    metadata: {
      format: 'audio',
      alignmentSchema: report.schema,
      symbolicProjectId: report.symbolic.project_id,
      metrics: structuredClone(report.alignment.metrics),
      tempoDrift: structuredClone(report.alignment.tempo_drift ?? {}),
      evidencePolicy: structuredClone(report.evidence_policy),
      warnings: [...validation.warnings],
    },
  });

  const existingEvidence = Array.isArray(project.metadata?.audioAlignmentEvidence)
    ? project.metadata.audioAlignmentEvidence
    : [];

  return createCanonicalProject({
    id: project.id,
    title: project.title,
    sources: [...project.sources, audioSource],
    events: [...project.events],
    tempoEvents: [...(project.tempoEvents ?? [])],
    meterEvents: [...(project.meterEvents ?? [])],
    decisions: [...(project.decisions ?? [])],
    metadata: {
      ...(project.metadata ?? {}),
      audioAlignmentEvidence: [
        ...existingEvidence,
        {
          sourceId,
          schema: report.schema,
          controlPoints: validation.controlPoints,
          metrics: validation.metrics,
          tempoDrift: structuredClone(report.alignment.tempo_drift ?? {}),
          evidencePolicy: structuredClone(report.evidence_policy),
          warnings: [...validation.warnings],
        },
      ],
    },
  });
}
