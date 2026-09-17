// Project identity and ownership.
//
// Status: IMPLEMENTATION NOTES. A project is the durable thing an agent names.
// It relates the sources a song was built from, the Source-Faithful Baseline
// derived from them, the derived candidates, the audio evidence attached to
// them, the jobs that produced them and the Final artifacts emitted from them.
//
// Ownership is checked on the way in, once, in `load()`. Every other service in
// this layer reaches a project through it, so there is exactly one place where
// "may this caller see this record" is decided, and a new operation cannot
// forget to ask. A project that belongs to another owner is reported as absent:
// telling a caller that an id exists but is not theirs is an existence oracle
// over someone else's identifiers.

import {
  ERROR_CODES,
  LIMITS,
  isProjectId,
  fail,
  requireString,
} from './contracts.mjs';
import { ID_PREFIX, newId } from './store.mjs';

export const PROJECT_RECORD_SCHEMA = 'mabinogi-mobile-mml-studio/application-project@1';

const now = () => new Date().toISOString();

export function createProjectService({ store }) {
  /**
   * Load a project the caller owns, or refuse.
   *
   * The id is validated for shape before the store is touched, so a malformed
   * or hostile identifier is rejected by pattern rather than by lookup.
   */
  const load = (owner, projectId) => {
    if (!isProjectId(projectId)) fail(ERROR_CODES.PROJECT_NOT_FOUND, 'Unknown project', { project_id: String(projectId).slice(0, 64) });
    const record = store.readProjectRecord(projectId);
    if (!record || record.owner !== owner) fail(ERROR_CODES.PROJECT_NOT_FOUND, 'Unknown project', { project_id: projectId });
    return record;
  };

  const save = record => store.writeProjectRecord({ ...record, updated_at: now() });

  return Object.freeze({
    load,
    save,

    create(owner, { title } = {}) {
      const owned = store.listProjectRecords(owner);
      if (owned.length >= LIMITS.maxProjectsPerOwner) {
        fail(ERROR_CODES.STORAGE_FULL, 'This owner already holds the maximum number of projects.', { max_projects: LIMITS.maxProjectsPerOwner });
      }
      const record = {
        schema: PROJECT_RECORD_SCHEMA,
        project_id: newId(ID_PREFIX.project),
        owner,
        title: title === undefined || title === null || title === '' ? 'Untitled project' : requireString(title, 'title', { max: LIMITS.maxTitleLength }),
        created_at: now(),
        updated_at: now(),
        assets: [],
        jobs: [],
        artifacts: [],
        baseline: null,
        candidates: [],
        audio_evidence: [],
      };
      return store.createProjectRecord(record);
    },

    list(owner) {
      return store.listProjectRecords(owner)
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
        .map(summary);
    },

    get(owner, projectId) {
      return view(load(owner, projectId));
    },

    rename(owner, projectId, title) {
      const record = load(owner, projectId);
      return view(save({ ...record, title: requireString(title, 'title', { max: LIMITS.maxTitleLength }) }));
    },
  });
}

/** The short form: enough to pick a project, not enough to work on one. */
export function summary(record) {
  return Object.freeze({
    project_id: record.project_id,
    title: record.title,
    created_at: record.created_at,
    updated_at: record.updated_at,
    asset_count: record.assets.length,
    candidate_count: record.candidates.length,
    baseline_id: record.baseline?.baseline_id ?? null,
  });
}

/**
 * The full project view.
 *
 * Deliberately contains no bytes and no Canonical project body. An agent gets
 * identities and counts; the payloads are fetched by id through the asset and
 * artifact endpoints, so a project read never drags a recording into a model's
 * context.
 */
export function view(record) {
  return Object.freeze({
    project_id: record.project_id,
    title: record.title,
    created_at: record.created_at,
    updated_at: record.updated_at,
    assets: Object.freeze(record.assets.map(asset => Object.freeze({ ...asset }))),
    baseline: record.baseline ? Object.freeze({ ...record.baseline }) : null,
    candidates: Object.freeze(record.candidates.map(candidate => Object.freeze({ ...candidate }))),
    audio_evidence: Object.freeze(record.audio_evidence.map(evidence => Object.freeze({ ...evidence }))),
    jobs: Object.freeze(record.jobs.map(job => Object.freeze({ ...job, transitions: Object.freeze([...job.transitions]) }))),
    artifacts: Object.freeze(record.artifacts.map(artifact => Object.freeze({ ...artifact }))),
  });
}
