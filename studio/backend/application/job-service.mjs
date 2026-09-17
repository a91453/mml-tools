// Job lifecycle.
//
// Status: IMPLEMENTATION NOTES. Analysis work that could take longer than one
// HTTP request gets a `job_id` and an explicit lifecycle, so an agent has a
// place to look instead of a request to hold open.
//
// What this build actually does, stated plainly rather than implied: the work
// runs inline, in the request that created the job, and the job is already in a
// terminal state when it is first returned. The lifecycle is recorded, not
// simulated — `queued`, `running` and the terminal state are each written with
// their own timestamp, and a failure records the state it failed from — but
// there is no background queue, no worker pool and no external queue service,
// because adding one would mean adding a paid dependency this work is not
// allowed to introduce.
//
// `capabilities.jobs.background_execution` reports `false` for exactly that
// reason, and `job_cancellation` reports `false` because nothing here can be
// cancelled: by the time a caller holds the id, the work is done. An agent that
// polls `studio_job_status` is not misled — it simply finds a terminal job on
// the first poll.

import { ERROR_CODES, JOB_STATUS, JOB_TYPES, isJobId, fail } from './contracts.mjs';
import { ID_PREFIX, newId } from './store.mjs';

const now = () => new Date().toISOString();

const JOB_TYPE_NAMES = Object.freeze(Object.values(JOB_TYPES));

export function createJobService({ store, projects }) {
  const transition = (job, status) => ({
    ...job,
    status,
    transitions: [...job.transitions, { status, at: now() }],
  });

  const persist = (record, job) => {
    const jobs = record.jobs.some(entry => entry.job_id === job.job_id)
      ? record.jobs.map(entry => (entry.job_id === job.job_id ? job : entry))
      : [...record.jobs, job];
    return projects.save({ ...record, jobs });
  };

  return Object.freeze({
    /**
     * Run one unit of work under a recorded job.
     *
     * The work function receives nothing and returns `{ result, artifactId,
     * reference }`. A thrown `StudioApplicationError` is recorded on the job as
     * a structured failure and then re-thrown, so a caller sees the same error
     * whether or not the operation happened to be wrapped in a job.
     */
    async run(owner, projectId, type, work) {
      if (!JOB_TYPE_NAMES.includes(type)) fail(ERROR_CODES.INVALID_REQUEST, `Unknown job type: ${String(type).slice(0, 64)}`, { accepted: JOB_TYPE_NAMES });
      const record = projects.load(owner, projectId);
      let job = {
        job_id: newId(ID_PREFIX.job),
        project_id: record.project_id,
        type,
        status: JOB_STATUS.QUEUED,
        created_at: now(),
        started_at: null,
        finished_at: null,
        result_artifact_id: null,
        result_reference: null,
        error: null,
        transitions: [{ status: JOB_STATUS.QUEUED, at: now() }],
      };
      persist(record, job);

      job = { ...transition(job, JOB_STATUS.RUNNING), started_at: now() };
      persist(projects.load(owner, projectId), job);

      try {
        const outcome = await work();
        job = {
          ...transition(job, JOB_STATUS.SUCCEEDED),
          finished_at: now(),
          result_artifact_id: outcome?.artifactId ?? null,
          result_reference: outcome?.reference ?? null,
        };
        persist(projects.load(owner, projectId), job);
        return { job: Object.freeze({ ...job, transitions: Object.freeze([...job.transitions]) }), result: outcome?.result ?? null };
      } catch (error) {
        job = {
          ...transition(job, JOB_STATUS.FAILED),
          finished_at: now(),
          error: {
            code: error?.code ?? ERROR_CODES.JOB_FAILED,
            message: error?.message ?? 'Job failed',
            details: error?.details ?? {},
          },
        };
        persist(projects.load(owner, projectId), job);
        throw error;
      }
    },

    /**
     * Look a job up by id alone.
     *
     * Scoped to the owner's own projects, so a job id from another owner — or
     * from another project the caller cannot see — is not found rather than
     * refused, and the job carries its `project_id` so the relation is explicit.
     */
    get(owner, jobId) {
      if (!isJobId(jobId)) fail(ERROR_CODES.JOB_NOT_FOUND, 'Unknown job', { job_id: String(jobId).slice(0, 64) });
      for (const record of store.listProjectRecords(owner)) {
        const job = record.jobs.find(entry => entry.job_id === jobId);
        if (job) return Object.freeze({ ...job, transitions: Object.freeze([...job.transitions]) });
      }
      return fail(ERROR_CODES.JOB_NOT_FOUND, 'Unknown job', { job_id: jobId });
    },

    list(owner, projectId) {
      const record = projects.load(owner, projectId);
      return Object.freeze(record.jobs.map(job => Object.freeze({ ...job, transitions: Object.freeze([...job.transitions]) })));
    },
  });
}
