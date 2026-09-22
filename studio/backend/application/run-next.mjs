// IMPLEMENTATION ONLY. A read-only projection of existing run/proposal state.
// No new orchestrator, evaluator, model call, acceptance or recovery effect.
import { ERROR_CODES, LIMITS, fail, isRunId } from './contracts.mjs';

export const RUN_NEXT_SCHEMA = 'mabinogi-mobile-mml-studio/run-next@1';
export const RUN_NEXT_INPUT_KEYS = Object.freeze(['expected_run_revision']);

function checkedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail(ERROR_CODES.INVALID_REQUEST, 'run-next input must be a plain object');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (!RUN_NEXT_INPUT_KEYS.includes(key)) {
      fail(ERROR_CODES.INVALID_REQUEST, 'Unknown run-next field', { field: String(key) });
    }
  }
  const revision = Object.hasOwn(input, 'expected_run_revision') ? input.expected_run_revision : undefined;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1 || revision > LIMITS.maxRunRevision)) {
    fail(ERROR_CODES.INVALID_REQUEST, 'expected_run_revision must be a valid run revision');
  }
  return revision;
}

export function createRunNextService({ runs, proposals, serialize }) {
  return Object.freeze({
    async next(owner, projectId, runId, input = {}) {
      const expected = checkedInput(input);
      if (!isRunId(runId)) fail(ERROR_CODES.INVALID_REQUEST, 'run-next requires an explicit run_id');
      // Same per-project lock as existing writes, so all three readers observe
      // one committed state. These readers never take the lock or save/cache.
      return serialize(String(projectId), async () => {
        const status = await runs.get(owner, projectId, runId);
        const { run, canonical, staleness = [] } = status;
        if (expected !== undefined && expected !== run.revision) {
          fail(ERROR_CODES.RUN_CONFLICT, 'The run changed; read this run again.', {
            run_id: runId, expected_run_revision: expected, current_run_revision: run.revision,
          });
        }
        const targets = await proposals.targets(owner, projectId, runId);
        const listed = await proposals.list(owner, projectId, { run_id: runId });
        const loaded = canonical.status === 'CANONICAL_LOADED';
        const unchanged = loaded && staleness.length === 0;
        const interrupted = Boolean(run.pending_step || run.needs_reconciliation);
        const closed = ['completed', 'failed'].includes(run.state) || Boolean(run.report_artifact_id);
        const canPropose = unchanged && !closed && !interrupted
          && targets.accepts_proposals === true && targets.targets.length > 0;
        const open = listed.proposals.filter(proposal => ['submitted', 'accepted'].includes(proposal.state));
        // Navigation hints only. Do not duplicate nextStep or gate evaluation.
        const kind = !loaded ? 'restore_published_canonical'
          : !unchanged ? 'inspect_changed_bindings'
          : interrupted ? 'inspect_interrupted_step'
          : closed ? 'read_terminal_record'
          : open.length ? 'read_proposal_review'
          : canPropose && targets.targets.some(target => target.admissible_kinds.some(value => value !== 'evidence_needed')) ? 'prepare_proposal'
          : run.review_requests.length ? 'supply_missing_evidence' : 'resume_existing_run';
        const address = { project_id: projectId, run_id: runId };
        const operations = [
          { tool: 'studio_run_next', read_only: true, arguments: address },
          { tool: 'studio_run_status', read_only: true, arguments: address },
          { tool: 'studio_project_get', read_only: true, arguments: { project_id: projectId } },
          { tool: 'studio_proposal_targets', read_only: true, arguments: address },
          { tool: 'studio_proposal_status', read_only: true, arguments: address },
        ];
        for (const id of new Set([run.final_artifact_id, run.report_artifact_id].filter(Boolean))) {
          operations.push({ tool: 'studio_artifact_get', read_only: true, arguments: { artifact_id: id } });
        }
        if (canPropose) operations.push({
          tool: 'studio_proposal_submit', read_only: false,
          arguments: { ...address, expected_run_revision: run.revision },
          requires: ['one current request_key', 'a cited proposal allowed by that target', 'idempotency_key for this exact payload'],
          applies_candidate: false, accepts_proposal: false,
        });
        if (unchanged && !interrupted && !closed && open.length) operations.push({
          tool: 'studio_proposal_resolve', read_only: false,
          requires: ['fresh studio_proposal_status', 'explicit authorized reviewer resolution', 'expected_proposal_revision'],
          notice: 'No acceptance is generated here. proposed_by is not accepted_by. Existing proposal policy still decides whether the resolution is allowed.',
        });
        if (loaded && (!closed || interrupted)) operations.push({
          tool: 'studio_run_resume', read_only: false,
          arguments: { ...address, expected_run_revision: run.revision },
          recovery_only: closed,
          requires: ['idempotency_key for this exact payload', 'explicit accepted input or inspected recovery state when required by the existing run'],
          notice: 'Conditional operation, not automatic acceptance. Existing resume revalidates all bindings. This read supplies no reconcile=true, confirmation, reviewer identity or PASS. An audit-closed run accepts recovery only, never new work.',
        });
        // Detach nested values too. Mutating an in-process response must not
        // alter a stored record or the answer to the next read.
        return structuredClone({
          schema: RUN_NEXT_SCHEMA, read_only: true, advanced: false, ...address,
          run_revision: run.revision, baseline_id: run.baseline_id ?? null,
          candidate_id: run.candidate_id ?? null, canonical, run_canonical: run.canonical,
          progress: {
            state: run.state, halt: run.halt, steps: run.steps,
            pending_step: run.pending_step, needs_reconciliation: run.needs_reconciliation,
            candidate_lineage: run.candidate_lineage,
            final_artifact_id: run.final_artifact_id, report_artifact_id: run.report_artifact_id,
            machine_delivery: run.machine_delivery ?? null,
          },
          next_action: { kind, stopped_at_step: run.pending_step?.step ?? run.halt?.step ?? null },
          allowed_operations: operations,
          operation_notice: 'Conditional navigation hints, not an authorization grant. Existing owner, revision, evidence and explicit acceptance checks still apply at every write.',
          accepts_proposals: canPropose, proposal_targets: targets.targets, proposals: listed.proposals,
          proposal_notice: 'Stored summaries only. Read studio_proposal_status for a fresh Agent Review verdict before any explicit resolution.',
          review_requests: run.review_requests,
          missing_evidence: targets.targets.map(target => ({
            request_key: target.request_key, code: target.code, gate: target.gate,
            required: target.required_evidence, existing: target.existing_evidence,
            report_reference: target.report_reference,
          })),
          reviewer_operations: [...new Set(run.review_requests.flatMap(request => request.available_operations ?? []))],
          blockers: {
            canonical: loaded ? [] : [ERROR_CODES.CANONICAL_NOT_LOADED],
            run: run.blockers, readiness: run.readiness_blockers, changed_bindings: staleness,
          },
          staleness, staleness_notice: status.staleness_notice, warnings: run.warnings,
          gate_snapshot: {
            source: 'stored_run', recomputed: false, current_binding_verified: false,
            run_revision: run.revision, candidate_id: run.candidate_id, gates: run.gates,
            notice: 'Historical snapshot only, never a new PASS. An empty cheap staleness check does not revalidate the song. Use the existing backend review/final path.',
          },
          delivery_state: run.machine_delivery ?? {
            lifecycle: 'CANDIDATE', ready: false, unresolved_evidence_ledger: [],
            notice: 'Legacy run predates machine-delivery state; resume to recompute. No PASS is inferred.',
          },
          never_agent_settlable: targets.never_agent_settlable,
          authority_notice: run.authority_notice, separation_notice: run.separation_notice,
          execution_notice: run.execution_notice, connector_exposure: 'UNVERIFIED_BY_SERVER',
        });
      });
    },
  });
}
