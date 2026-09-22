// Storage contract only. This module never grades audio or any Canonical gate.
import { createHash } from 'node:crypto';

export const AUDIO_HISTORY_SCHEMA = 'mml-studio/audio-report-history@1';
export const AUDIO_REVISION_SCHEMA = 'mml-studio/audio-report-revision@1';
export const MAX_AUDIO_REPORT_HISTORY = 128;
const SHA = /^[a-f0-9]{64}$/;
const clone = value => structuredClone(value);
const reject = message => { throw new Error(`Audio history: ${message}`); };
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) reject(`invalid ${name}`);
  return value;
};
const stable = value => {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined || (typeof value === 'number' && !Number.isFinite(value))) reject('not finite JSON');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};
export const audioReportHash = report => createHash('sha256').update(stable(report), 'utf8').digest('hex');
const audioHash = report => {
  const sha = String(report?.audio?.sha256 ?? '').toLowerCase();
  if (!SHA.test(sha)) reject('missing audio identity');
  return sha;
};

// An explicit, versioned submission in the existing HTTP/MCP `report` object.
// Raw Worker reports retain their existing first-attachment semantics.
export function unpackAudioSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('report must be an object');
  if (input.schema !== AUDIO_REVISION_SCHEMA) return { report: input, revision: null };
  const keys = ['schema', 'report', 'expected_previous_report_sha256', 'reason', 'submitted_by'];
  if (Object.keys(input).some(key => !keys.includes(key))) reject('unknown revision field');
  if (!SHA.test(input.expected_previous_report_sha256 ?? '')) reject('invalid expected previous report hash');
  if (!input.report || typeof input.report !== 'object' || Array.isArray(input.report)
      || input.report.schema === AUDIO_REVISION_SCHEMA) reject('revision must carry one Worker report');
  return {
    report: input.report,
    revision: {
      expected_previous_report_sha256: input.expected_previous_report_sha256,
      reason: text(input.reason, 'revision reason', 500),
      submitted_by: text(input.submitted_by, 'declared submitter', 120),
    },
  };
}

// Legacy arrays are interpreted without rewriting their reports or inventing an
// actor/time. The next successful append persists this lossless interpretation.
export function readAudioHistory(stored, candidateId, legacyEvidence = []) {
  let history;
  if (stored == null || Array.isArray(stored)) {
    history = {
      schema: AUDIO_HISTORY_SCHEMA, candidate_id: candidateId,
      entries: (stored ?? []).map((report, index) => {
        const audio = audioHash(report);
        const evidence = legacyEvidence.find(item => item.candidate_id === candidateId && item.audio_sha256 === audio);
        return {
          sequence: index + 1, report_sha256: audioReportHash(report), audio_sha256: audio,
          supersedes_report_sha256: null, reason: null, submitted_by: null,
          authenticated_owner: null, attached_at: evidence?.attached_at ?? null,
          warnings: [...(evidence?.warnings ?? [])], legacy: true, report: clone(report),
        };
      }),
    };
  } else {
    if (stored.schema !== AUDIO_HISTORY_SCHEMA || stored.candidate_id !== candidateId || !Array.isArray(stored.entries)) reject('invalid or cross-candidate history');
    history = clone(stored);
  }
  if (history.entries.length > MAX_AUDIO_REPORT_HISTORY) reject('history limit exceeded');
  const active = new Map();
  const seen = new Set();
  for (const [index, entry] of history.entries.entries()) {
    if (entry.sequence !== index + 1 || !SHA.test(entry.report_sha256 ?? '')
        || entry.report_sha256 !== audioReportHash(entry.report)
        || entry.audio_sha256 !== audioHash(entry.report)) reject('corrupt report identity');
    if (seen.has(entry.report_sha256)) reject('duplicate report identity');
    const previous = active.get(entry.audio_sha256)?.report_sha256 ?? null;
    if (entry.supersedes_report_sha256 !== previous) reject('broken supersession chain');
    if (previous !== null) {
      text(entry.reason, 'stored revision reason', 500);
      text(entry.submitted_by, 'stored declared submitter', 120);
      text(entry.authenticated_owner, 'stored authenticated owner', 500);
    }
    if (!Array.isArray(entry.warnings) || entry.warnings.some(w => typeof w !== 'string')) reject('invalid stored warnings');
    seen.add(entry.report_sha256);
    active.set(entry.audio_sha256, entry);
  }
  return history;
}

export function activeAudioEntries(history) {
  const active = new Map();
  for (const entry of history.entries) active.set(entry.audio_sha256, entry);
  return [...active.values()];
}

export function appendAudioReport(history, { report, revision = null, authenticatedOwner, warnings, at }) {
  const sha = audioReportHash(report);
  const audio = audioHash(report);
  const previous = activeAudioEntries(history).find(entry => entry.audio_sha256 === audio);
  // Replay only the exact explicit revision, while that revision is still the
  // active head. An old retry cannot roll back a newer report (no ABA).
  if (revision && previous?.report_sha256 === sha
      && previous.supersedes_report_sha256 === revision.expected_previous_report_sha256
      && previous.reason === revision.reason && previous.submitted_by === revision.submitted_by
      && previous.authenticated_owner === authenticatedOwner) {
    return { history: clone(history), entry: clone(previous), replayed: true };
  }
  if (previous) {
    if (!revision) reject('recording already attached; explicit revision is required');
    if (revision.expected_previous_report_sha256 !== previous.report_sha256) reject('stale previous report hash');
    if (previous.report_sha256 === sha) reject('no-op revision');
  } else if (revision) reject('no report exists to supersede');
  if (history.entries.some(entry => entry.report_sha256 === sha)) reject('historical report cannot be replayed as a new revision');
  if (history.entries.length >= MAX_AUDIO_REPORT_HISTORY) reject('history limit exceeded');
  if (revision) {
    text(revision.reason, 'revision reason', 500);
    text(revision.submitted_by, 'declared submitter', 120);
  }
  text(authenticatedOwner, 'authenticated owner', 500);
  const entry = {
    sequence: history.entries.length + 1, report_sha256: sha, audio_sha256: audio,
    supersedes_report_sha256: previous?.report_sha256 ?? null,
    reason: revision?.reason ?? null, submitted_by: revision?.submitted_by ?? null,
    authenticated_owner: authenticatedOwner, attached_at: at,
    warnings: [...warnings], legacy: false, report: clone(report),
  };
  const next = { ...clone(history), entries: [...clone(history.entries), entry] };
  // Validate the complete proposed chain before any persistence.
  readAudioHistory(next, history.candidate_id);
  return { history: next, entry: clone(entry), replayed: false };
}

export function exportAudioHistory(history) {
  const heads = new Set(activeAudioEntries(history).map(entry => entry.report_sha256));
  return {
    schema: history.schema, candidate_id: history.candidate_id,
    entries: history.entries.map(entry => ({ ...clone(entry), active: heads.has(entry.report_sha256) })),
    notice: 'Raw reports and historical warnings are retained. Active means selected evidence, not accepted music or a gate PASS.',
  };
}
