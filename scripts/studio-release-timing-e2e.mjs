// Real-song release-timing E2E through the one Studio run. Implementation
// notes, not Canonical policy.
//
// Rebuilds the real candidate from service read exports — the four
// `studio_baseline_events` pages and the applied arrangement_decision proposal —
// in an ISOLATED throwaway store, then drives the existing Studio run (the same
// orchestrator every MCP/HTTP caller uses) as far as the real evidence allows:
//
//   intake → suggest → apply_decisions → final_reduction → mobile_adaptation
//   → review → (finalize only if every required non-game gate passes)
//
// and reports, from what the run and the Studio backend computed:
//
//   * the release-timing analysis (Layer A source releases, Layer B arithmetic)
//     for every note release, with representation options and evidence needs;
//   * which evidence the project actually holds, graded by the same
//     admissibility function the adaptation stage uses (asset kinds/digests from
//     the production project listing, supplied with --assets);
//   * every readiness gate and the song state the run reached.
//
// `--counterfactual` additionally evaluates, in the same isolated store, what the
// machinery WOULD do if a direct review of the original recording were supplied
// (by anyone: who submits a decision is provenance, not authority). Its evidence
// is a placeholder asset and a hypothetical finding, and its emission uses a
// hypothetical Tempo Map (the export carries none). It is labelled
// COUNTERFACTUAL_NOT_A_RESULT and is never a song result, never evidence and
// never a gate result.
//
// `--project` takes a read-only studio_project_get export (assets and audio
// evidence) of the production project; the isolated store holds none of those
// bytes, so the evidence the production project really holds is graded from it
// with the same functions the service uses, and reported separately from the
// isolated run's own review.
//
// No network, no service write, no source bytes. The receipt carries counts,
// identities and digests only — no pitch sequence, no durations list, no MML text.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { createStore } from '../studio/backend/application/store.mjs';
import { createCanonicalMeterEvent, createCanonicalProject, createCanonicalTempoEvent } from '../studio/backend/canonical/index.mjs';
import { EVIDENCE_BASIS, buildEvidenceRegistry, gradeReleaseEvidence, releaseEvidenceRequirement } from '../studio/backend/canonical/release-timing.mjs';
import { emitFinalMml } from '../studio/backend/final/mml-emitter.mjs';
import { evaluateLeadPromotion } from '../studio/backend/arbitration/lead-demotion.mjs';
import { gradedLeadEvidenceOf, leadReviewAuthorityOf, validateLeadReviewAttestation } from '../studio/backend/application/lead-review-authority.mjs';
import { loadBaselineEvents } from './studio-microtiming-audit.mjs';

const HELP = `Real-song release-timing E2E through the Studio run (isolated, no network)
  node scripts/studio-release-timing-e2e.mjs --work-dir NEW_DIR --events p1.json[,p2.json...]
       --decisions proposal.json [--project production-project.json | --assets production-assets.json]
       [--lead-queue lead-review-queue.json] [--ticks-per-quarter N]
       [--counterfactual] [--out receipt.json]
`;
const OWNER = 'local:release-timing-e2e';
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const sorted = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The exported events carry no per-event MIDI metadata. The tick resolution is a
// file-global MIDI division; when the caller states it (from a committed receipt),
// it is attached so the analysis can report offsets in source ticks. It changes
// no timing value.
function canonicalProjectFromExport(events, { ticksPerQuarter = null } = {}) {
  const sources = [...new Set(events.flatMap(event => event.source_ids))].sort().map(id => ({
    id, label: 'exported source identity', kind: 'third-party-midi', authority: 'supporting',
    sha256: /^midi:sha256:([0-9a-f]{64})$/.exec(id)?.[1] ?? null, metadata: {},
  }));
  return {
    schema: 'mabinogi-mobile-mml-studio/canonical-project@2',
    id: sources.length === 1 ? `${sources[0].id}-project` : 'exported-baseline-project',
    title: 'release-timing E2E reconstruction',
    sources,
    events: events.map(event => ({
      kind: event.kind, id: event.event_id, pitch: event.pitch, start: event.start, end: event.end,
      sourceIds: event.source_ids, sourceEventIds: event.source_event_ids, role: event.role, voice: event.voice,
      tags: ['source-faithful'], metadata: Number.isInteger(ticksPerQuarter) ? { ticksPerQuarter } : {},
    })),
    tempoEvents: [], meterEvents: [], decisions: [], metadata: {},
  };
}

function analysisSummary(analysis) {
  const byRole = {}; const shapes = {}; const recommended = {}; const statuses = {};
  for (const target of analysis.targets) {
    bump(byRole, target.role); bump(shapes, target.analysis.followingShape);
    bump(recommended, target.recommended ?? 'none'); bump(statuses, target.status);
  }
  const offsetsTicks = {};
  for (const target of analysis.targets) bump(offsetsTicks, String(target.analysis.offsetBeforeNextGridTicks));
  const secondsSamples = [...new Set(analysis.targets.map(target => target.analysis.offsetBeforeNextGridSeconds))].slice(0, 5);
  const windowsByRole = {};
  for (const window of analysis.windows) (windowsByRole[window.role] ??= []).push({ window_id: window.windowId, start: window.start, end: window.end, count: window.count });
  return {
    release_count: analysis.releaseCount,
    position_classes: analysis.positionClassCounts,
    target_count: analysis.targetCount,
    decision_required: analysis.decisionRequiredCount,
    no_valid_representation: analysis.noValidRepresentationCount,
    source_supported_not_representable: analysis.sourceSupportedNotRepresentableCount,
    unsupported_boundaries: analysis.unsupportedBoundaryCount,
    not_visible_to_interval_analyzer: analysis.notVisibleToIntervalAnalyzerCount,
    targets_by_role: sorted(byRole),
    following_shapes: sorted(shapes),
    recommended: sorted(recommended),
    statuses: sorted(statuses),
    offset_before_next_grid_ticks: sorted(offsetsTicks),
    offset_seconds_samples: secondsSamples,
    same_pitch_repeated_attack_targets: analysis.targets.filter(target => target.analysis.nextIsSamePitchRepeatedAttack).length,
    no_valid_representation_cases: analysis.targets.filter(target => target.status === 'NO_VALID_REPRESENTATION')
      .map(target => ({ event_id: target.eventId, role: target.role, shape: target.analysis.followingShape, option_reasons: target.options.map(option => ({ representation: option.representation, reasons: option.reasons })) })),
    encoding_observations: analysis.encodingObservations,
    windows_by_role: sorted(Object.fromEntries(Object.entries(windowsByRole).map(([role, list]) => [role, { count: list.length, windows: list }]))),
  };
}

// Grade the citation shapes the project's real evidence could support, with the
// same function the adaptation stage uses. A probe, not a decision: nothing is
// applied, no finding here is anyone's statement, and every shape is graded for
// two submitters to show that who submits it does not change the grade.
const PROBE_SUBMITTERS = Object.freeze([{ reviewer: 'probe:human', reviewer_kind: 'human' }, { reviewer: 'probe:agent', reviewer_kind: 'agent' }]);
function evidenceProbe(assets, sources, audioEvidence) {
  const registry = buildEvidenceRegistry({ assets, sources });
  const byKind = kind => assets.filter(asset => asset.kind === kind).map(asset => asset.asset_id);
  const probe = (label, evidence) => {
    const [first, ...rest] = PROBE_SUBMITTERS.map(attestation => gradeReleaseEvidence({ representation: 'EXTEND_TO_NEXT_GRID', attestation, evidence }, registry));
    const strip = graded => JSON.stringify({ admissible: graded.admissible, reasons: graded.reasons, items: graded.items });
    return {
      probe: label, admissible: first.admissible, reasons: first.reasons,
      same_grade_for_every_submitter: rest.every(graded => strip(graded) === strip(first)),
      items: first.items.map(item => ({ class: item.class, ref: item.ref, basis: item.basis, kind: item.resolved?.kind ?? null, independent: item.resolved?.independent ?? null, reasons: item.reasons })),
    };
  };
  const cite = (evidenceClass, ref, basis) => ({ class: evidenceClass, ref, basis, locator: 'whole song', finding: 'probe' });
  const probes = [];
  for (const ref of byKind('official_midi')) probes.push(probe(`official_midi ${ref} read directly as primary-symbolic`, [cite('primary-symbolic', ref, EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW)]));
  for (const ref of byKind('third_party_midi')) probes.push(probe(`third_party_midi ${ref} as the only evidence`, [cite('third-party', ref, EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW)]));
  for (const ref of sources.map(source => source.id)) probes.push(probe(`uniform one-tick encoding pattern of ${ref}`, [cite('source-encoding-pattern', ref, EVIDENCE_BASIS.ENCODING_PATTERN)]));
  for (const ref of byKind('original_audio')) {
    probes.push(probe(`original_audio ${ref} through the alignment report on record (a locator)`, [cite('primary-audio', ref, EVIDENCE_BASIS.ALIGNMENT_LOCATOR)]));
    probes.push(probe(`original_audio ${ref} through an envelope/onset metric`, [cite('primary-audio', ref, EVIDENCE_BASIS.MACHINE_METRIC)]));
    probes.push(probe(`original_audio ${ref} by a direct review of the recording (shape only; no such review is on record)`, [cite('primary-audio', ref, EVIDENCE_BASIS.DIRECT_SOURCE_REVIEW)]));
  }
  return {
    registry: registry.entries.map(({ ref, origin, kind, sha256, bytesHeld, primary, independent }) => ({ ref, origin, kind, sha256, bytes_held: bytesHeld, primary, independent })),
    requirement: releaseEvidenceRequirement(registry),
    audio_evidence_on_record: (audioEvidence ?? []).map(entry => ({ report_sha256: entry.report_sha256, audio_sha256: entry.audio_sha256, active: entry.active, confidence: entry.confidence, warnings: entry.warnings, submitted_by: entry.submitted_by ?? null, basis: EVIDENCE_BASIS.ALIGNMENT_LOCATOR, admissible_as_release_evidence: false, why: 'SOURCE_POLICY §6: an alignment report locates windows in the recording; it states nothing about sustain or articulation there.' })),
    probes,
  };
}

// The questions a release arbitration has to answer, from the analysis and the
// graded evidence. Nothing here decides musical meaning from the size of the
// offset or from the uniformity of the encoding.
function arbitration(analysis, evidence, { project, gates }) {
  const shapes = {}; for (const target of analysis.targets) bump(shapes, target.analysis.followingShape);
  const offsets = {}; for (const target of analysis.targets) bump(offsets, String(target.analysis.offsetBeforeNextGridTicks));
  const anyDirectReview = evidence.probes.some(item => item.admissible && !/shape only/.test(item.probe));
  const audioAvailable = evidence.requirement?.anyOf.find(item => item.class === 'primary-audio')?.availableRefs ?? [];
  const symbolicAvailable = evidence.requirement?.anyOf.find(item => item.class === 'primary-symbolic')?.availableRefs ?? [];
  const activeAlignment = evidence.audio_evidence_on_record.find(entry => entry.active) ?? null;
  const shaOf = ref => evidence.registry.find(entry => entry.ref === ref)?.sha256 ?? null;
  const recordings = new Set(audioAvailable.map(shaOf).filter(Boolean)).size;
  const relabelledSymbolic = evidence.requirement?.anyOf.find(item => item.class === 'primary-symbolic')?.notIndependentRefs ?? [];
  const openGates = ['source', 'originalAudio'].filter(name => gates?.[name] && gates[name].status !== 'PASS' && gates[name].status !== 'N/A');
  return {
    claim_under_review: 'SOURCE_EVENT_SUSTAINS_TO_GRID_POINT (EXTEND_TO_NEXT_GRID) or SOURCE_EVENT_RELEASES_BY_PREVIOUS_GRID_POINT (TRUNCATE_TO_PREVIOUS_GRID)',
    targets: analysis.targetCount,
    offset_before_next_grid_ticks: sorted(offsets),
    subsets: {
      following_shape: sorted(shapes),
      same_pitch_repeated_attack: analysis.targets.filter(target => target.analysis.nextIsSamePitchRepeatedAttack).length,
      effect_of_extend: {
        'sub-grid-gap-to-next-onset': 'closes a one-tick gap before the next attack of the same role; the attack stays an attack',
        'rest-of-at-least-safe-grid': 'shortens the following rest by one tick; the rest stays',
        'role-end': 'lengthens the last note of the role by one tick',
      },
      evidence_need_differs_by_subset: false,
      why: 'Every subset asks the same source question (is the note held to the grid point or released before it); only the Final effect differs, and none moves an onset, merges an attack or removes a rest.',
    },
    questions: {
      source_supported_intentional_articulation: 'UNDETERMINED — no primary source finding about these releases is on record.',
      source_encoding_artifact_or_technical_micro_gap: 'UNDETERMINED — the uniform one-tick pattern is an observation about the third-party file, not evidence; it is not read as meaningless for being uniform or for being one tick.',
      extend_justified: anyDirectReview ? 'YES for the releases an admissible decision names' : 'NOT YET — EXTEND is the minimal valid option for every target arithmetically, but no admissible finding supports the claim it makes.',
      subset_differs: 'NO — see subsets.why.',
      original_audio_available: audioAvailable.length ? `YES — independent original_audio ${audioAvailable.join(', ')} (${recordings} distinct recording${recordings === 1 ? '' : 's'} by SHA-256)` : 'NO',
      original_audio_evidence_on_record_sufficient: activeAlignment
        ? `NO — the only audio evidence on record is the alignment report ${activeAlignment.report_sha256.slice(0, 12)}… (confidence ${activeAlignment.confidence}, warnings ${activeAlignment.warnings.join('+')}), a locator; no direct review of the recording at these releases is recorded.`
        : 'NO — no audio evidence is on record.',
      current_audio_evidence_can_support_claim: `NO — metrics and alignment locate; they do not state sustain or articulation (SOURCE_POLICY §6).${activeAlignment?.warnings?.length ? ` The active alignment carries ${activeAlignment.warnings.join('+')}, so the recording-time locators of the release windows are themselves unreliable.` : ''}${openGates.length ? ` In the isolated run, readiness gates still open: ${openGates.join(', ')}.` : ''}`,
      independent_symbolic_source_exists: symbolicAvailable.length ? `YES — ${symbolicAvailable.join(', ')}` : relabelledSymbolic.length ? `NO — ${relabelledSymbolic.join(', ')} labelled official ${relabelledSymbolic.length === 1 ? 'is' : 'are'} byte-identical to a supporting file (a relabelled copy).` : 'NO — no official score or MIDI asset is held.',
      accepted_prior_evidence_exists: project ? (project.artifacts?.length ? 'SEE project.artifacts' : 'NO — no accepted previous version and no delivered Final exist in the project.') : 'UNKNOWN — no project export supplied.',
      evidence_still_insufficient: !anyDirectReview,
    },
    blocker: anyDirectReview ? null : {
      code: 'MICRO_TIMING_RELEASE_EVIDENCE_REQUIRED',
      any_of: (evidence.requirement?.anyOf ?? []).map(item => ({ code: item.code, available_refs: item.availableRefs, not_independent_refs: item.notIndependentRefs })),
      submitter: 'anyone — a person or a conversational AI able to review the recording or read a score; the submitter is recorded as provenance and does not change the grade',
      not_a_blocker: 'who the submitter is',
    },
  };
}

// The Lead evidence state, and whether the old submitter rule was what held it.
// `queue` is the committed public Lead review queue (classifications and
// citation kinds of the stored production reviews, no citation text). The
// probes grade representative citation shapes with the service's own
// preparation (gradedLeadEvidenceOf) and the shared grader, against the
// production evidence registry, for two submitters; every other Lead
// requirement is filled in so the probe isolates what the evidence proves.
function leadSection({ review, assets, sources, queue }) {
  const gate = review.readiness.gates.leadPromotion;
  const reports = review.lead_promotion ?? [];
  const byStatus = {}; const blockerCounts = {};
  for (const report of reports) { bump(byStatus, report.status); for (const blocker of report.blockers ?? []) bump(blockerCounts, blocker); }
  const registry = buildEvidenceRegistry({ assets, sources });
  const byKind = kind => assets.filter(asset => asset.kind === kind).map(asset => asset.asset_id);
  const event = { id: 'probe', role: 'Chord1', sourceIds: ['probe-source'], sourceEventIds: ['probe-source#e'] };
  const complete = { sourceIdentity: { sourceId: 'probe-source', sourceEventId: 'probe-source#e' }, sectionRole: 'vocal-active', continuity: { checked: true, createsLeadGap: false, replacementEventIds: [] }, core3: { checked: true, status: 'PASS' }, positiveReason: 'probe' };
  const probe = (label, leadEvidence, audioBasis) => {
    const outcomes = ['human', 'agent'].map(kind => {
      const attested = validateLeadReviewAttestation({ reviewer: `probe:${kind}`, reviewer_kind: kind, audio_basis: audioBasis }, leadEvidence);
      if (!attested.ok) return { error: attested.error };
      const prepared = gradedLeadEvidenceOf(leadEvidence, attested.attestation, registry);
      const graded = evaluateLeadPromotion({ ...complete, ...prepared.leadEvidence, event });
      return { status: graded.status, blockers: graded.blockers, warnings: graded.warnings, sources: prepared.sources };
    });
    return { probe: label, status: outcomes[0].status ?? null, same_grade_for_every_submitter: JSON.stringify(outcomes[0]) === JSON.stringify(outcomes[1]), blockers: outcomes[0].blockers ?? null, sources: outcomes[0].sources ?? null };
  };
  const audio = (ref, classification = 'foreground') => ({ availability: 'available', classification, citation: 'probe', ref });
  const probes = [];
  for (const ref of byKind('original_audio')) {
    probes.push(probe(`original_audio ${ref} classified from CQT/F0/pitch-class metrics (what the stored reviews rest on)`, { scoreEvidence: { availability: 'unavailable' }, audioEvidence: audio(ref) }, 'machine-metric'));
    probes.push(probe(`original_audio ${ref} by a direct review of the recording (shape only; no such review is on record)`, { scoreEvidence: { availability: 'unavailable' }, audioEvidence: audio(ref) }, 'direct-source-review'));
  }
  for (const ref of byKind('third_party_midi')) probes.push(probe(`third_party_midi ${ref} top line as score-role evidence`, { scoreEvidence: { availability: 'available', classification: 'lead', citation: 'probe', ref }, audioEvidence: { availability: 'unavailable' } }, 'not-used'));
  for (const ref of byKind('official_midi')) probes.push(probe(`official_midi ${ref} as score-role evidence`, { scoreEvidence: { availability: 'available', classification: 'lead', citation: 'probe', ref }, audioEvidence: { availability: 'unavailable' } }, 'not-used'));
  probes.push(probe('a score citation with no project reference (the shape of every stored review)', { scoreEvidence: { availability: 'available', classification: 'lead', citation: 'free text' }, audioEvidence: { availability: 'unavailable' } }, 'not-used'));

  const items = queue?.items ?? [];
  const stored = items.filter(item => item.storedReview);
  const count = (list, key) => sorted(list.reduce((map, item) => { bump(map, String(key(item))); return map; }, {}));
  // The public queue records each stored review's authority; a full export
  // carries the attestation itself.
  const unattested = 'UNATTESTED_LEGACY_NOT_REVIEWER_EVIDENCE';
  const attested = stored.filter(item => (item.storedReview.attestation !== undefined
    ? leadReviewAuthorityOf({ attestation: item.storedReview.attestation })
    : item.storedReview.authority) !== unattested).length;
  return {
    gate: { status: gate.status, blockers: (gate.blockers ?? []).slice(0, 8) },
    promotion_reports: { total: reports.length, by_status: sorted(byStatus), blocker_counts: sorted(blockerCounts) },
    stored_production_reviews: queue ? {
      source: 'the --lead-queue export supplied to this run',
      reviews_sha256: queue.exports?.reviews_sha256 ?? null,
      melody_events: items.length,
      without_any_review: items.length - stored.length,
      stored: stored.length,
      attested,
      by_classification: count(items, item => item.classification),
      audio_citation_kinds: count(stored, item => item.storedReview.audioCitationKind),
      score_citation_available: count(stored, item => item.storedReview.scoreCitationAvailable),
      carrying_a_project_reference: 0,
      note: 'The stored reviews predate the `ref` field, so none names a project source; the queue omits citation text.',
    } : null,
    evidence_probes: probes,
    determination: {
      category: 'B_GENUINELY_MISSING_SOURCE_EVIDENCE',
      blocked_only_by_the_submitter_rule: 0,
      why: [
        `${items.length - stored.length} Melody events have no Lead review at all.`,
        `${stored.length} stored reviews state no submitter and no method (unattested); under the old rule and the new one they are not graded.`,
        'Resubmitted with any attestation, they would still prove nothing: their audio classifications come from CQT salience, predominant pitch-class or F0 (metrics: locators, SOURCE_POLICY §6), and a score citation can only name the third-party MIDI (supporting, §1C) or its relabelled "official" copy (not independent); see evidence_probes.',
        'The Lead events are the highest sounding pitch of a third-party piano MIDI; "highest note ⇒ Lead" is a forbidden shortcut (MASTER_RULES §4).',
        'Caveat, stated rather than used: decision-time Lead citations (applyDecisions.leadEvidence) are still graded as free text on main, not resolved against the project sources, so that path would accept the same weak evidence from any submitter. It is a pre-existing, actor-neutral gap (actor-gate-audit.json, found_not_changed); using it would not make the evidence any stronger, and nothing here uses it.',
      ],
      would_resolve: 'Per Melody section: positive Lead evidence from a primary source — a direct review of the original recording stating which line is foreground (citing the original_audio asset by reference), or an official score — plus a resolved section role, checked continuity and Core3, filed through reviewLeadEvidence, where the citation is resolved against the project sources, from any submitter.',
    },
  };
}

export async function releaseTimingE2E({ workDir, eventPaths, decisionsPath, assets = [], project: productionProject = null, leadQueue = null, ticksPerQuarter = null, counterfactual = false }) {
  if (existsSync(workDir)) throw Error(`${workDir} already exists; use a new isolated directory.`);
  mkdirSync(workDir, { recursive: true });
  const events = loadBaselineEvents(eventPaths);
  const proposalFile = readJson(decisionsPath);
  const proposal = proposalFile.proposal ?? proposalFile;
  const app = createStudioApplication({ dataDirectory: join(workDir, 'store'), durability: 'persistent' });
  const { project } = await app.createProject(OWNER, { title: 'isolated real-song release-timing E2E' });
  const projectId = project.project_id;
  const exported = canonicalProjectFromExport(events, { ticksPerQuarter });
  const upload = (await app.uploadAsset(OWNER, projectId, { kind: 'canonical_project', filename: 'baseline.json', bytes: Buffer.from(JSON.stringify(exported)), mediaType: 'application/json' })).asset;

  // One run, the existing orchestrator. Decisions are the applied production set.
  const started = await app.startRun(OWNER, projectId, { asset_ids: [upload.asset_id], decisions: proposal.action.decisions, accepted_by: proposal.resolution?.accepted_by ?? null });
  const run = started.run;
  const candidateId = run.candidate_id;
  const plan = (await app.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation: { decisions: [] } })).adaptation.plan;
  const review = (await app.reviewCandidate(OWNER, projectId, { candidateId })).review;
  const finalize = await app.finalize(OWNER, projectId, { candidateId });
  const gates = Object.fromEntries(Object.entries(review.readiness.gates).map(([name, gate]) => [name, { status: gate.status, blockers: Array.isArray(gate.blockers) ? gate.blockers.slice(0, 12) : [] }]));
  const micro = review.readiness.gates.microTiming;

  const receipt = {
    schema: 'mml-studio/release-timing-e2e@1',
    notice: 'Isolated local E2E from service read exports through the existing Studio run. Not a native backup, not reviewer evidence, not a gate verdict beyond what the run and readiness computed, never IN_GAME_ACCEPTED.',
    exports: {
      baseline_event_count: events.length,
      baseline_events_sha256: sha(JSON.stringify([...events].sort((a, b) => (a.event_id < b.event_id ? -1 : 1)))),
      decision_count: proposal.action.decisions.length,
      decisions_sha256: sha(JSON.stringify(proposal.action.decisions)),
      decisions_accepted_by: proposal.resolution?.accepted_by ?? null,
      ticks_per_quarter: ticksPerQuarter,
      tempo_map_exported: false,
    },
    run: {
      state: run.state,
      halt_reason: run.halt?.reason ?? null,
      steps: run.steps.map(step => ({ step: step.step, status: step.status })),
      candidate_id: candidateId,
      mobile_adaptation_receipt: (() => {
        const receiptEntry = [...run.steps].reverse().find(step => step.step === 'mobile_adaptation');
        return receiptEntry ? { status: receiptEntry.status, reason: receiptEntry.detail?.reason ?? null, profile_required_for: receiptEntry.detail?.profile_required_for ?? null, profile_not_required_for: receiptEntry.detail?.profile_not_required_for ?? null, release_decision_required: receiptEntry.detail?.release_timing?.decision_required ?? null } : null;
      })(),
      review_requests: (run.review_requests ?? []).map(request => ({ code: request.code, gate: request.gate, blockers: (request.blockers ?? []).slice(0, 8).map(item => (typeof item === 'string' ? item : item.code)), available_operations: request.available_operations })),
    },
    readiness: {
      song_state: review.readiness.songState,
      candidate_ready: review.readiness.candidateReady,
      pre_game_blocking: review.readiness.preGameBlocking,
      gates,
    },
    micro_timing: {
      status: micro.status,
      blockers: micro.blockers,
      // Computed by the isolated store's own review, which holds only the
      // reconstructed baseline and none of the production assets: its
      // requirement is about that store. The production project's is under
      // evidence.requirement.
      release_evidence_requirement_isolated_store: micro.releaseEvidenceRequirement ?? null,
      interval_candidates: micro.candidateCount,
      unknown: micro.unknownCount,
      unknown_intervals_value_sha256: sha(JSON.stringify(micro.unknownIntervals)),
      release_timing: micro.releaseTiming,
    },
    release_analysis: analysisSummary(plan.releaseTiming),
    mobile_profile: plan.profileRequirement,
    evidence: evidenceProbe(assets, exported.sources, productionProject?.audio_evidence ?? []),
    finalize: { operation: finalize.operation, artifact_id: finalize.artifact_id, mml_delivered: finalize.mml !== null, song_state: finalize.song_state, blockers: finalize.blockers },
  };

  receipt.arbitration = arbitration(plan.releaseTiming, receipt.evidence, { project: productionProject, gates: review.readiness.gates });
  receipt.lead = leadSection({ review, assets, sources: exported.sources, queue: leadQueue });
  if (counterfactual) receipt.counterfactual = await counterfactualEvaluation({ app, projectId, runId: run.run_id, candidateId, plan, workDir });
  return receipt;
}

async function counterfactualEvaluation({ app, projectId, runId, candidateId, plan, workDir }) {
  // A placeholder standing in for a recording nobody here has listened to.
  const placeholder = (await app.uploadAsset(OWNER, projectId, { kind: 'original_audio', filename: 'COUNTERFACTUAL-placeholder.m4a', mediaType: 'audio/mp4', bytes: Buffer.from('COUNTERFACTUAL placeholder — not the recording') })).asset;
  const eventIds = plan.releaseTiming.targets.filter(target => target.status === 'REPRESENTATION_DECISION_REQUIRED' && target.recommended).map(target => target.eventId);
  const releaseRepresentation = { decisions: [{
    id: 'COUNTERFACTUAL:direct-review', eventIds, representation: 'EXTEND_TO_NEXT_GRID',
    reason: 'COUNTERFACTUAL: what a direct review of the recording stating legato at these releases would allow. No such review exists.',
    attestation: { reviewer: 'COUNTERFACTUAL', reviewer_kind: 'agent' },
    evidence: [{ class: 'primary-audio', ref: placeholder.asset_id, basis: 'direct-source-review', locator: 'whole song (hypothetical)', finding: 'hypothetical' }],
  }] };
  const cfPlan = (await app.planMobileAdaptation(OWNER, projectId, { candidateId, releaseRepresentation })).adaptation.plan;
  const resumed = await app.resumeRun(OWNER, projectId, runId, { mobile_adaptation: { release_representation: releaseRepresentation, expected_plan_id: cfPlan.id, accepted_by: 'COUNTERFACTUAL' } });
  const adaptedId = resumed.run.candidate_id;
  const review = (await app.reviewCandidate(OWNER, projectId, { candidateId: adaptedId })).review;
  const store = createStore({ directory: join(workDir, 'store'), durability: 'persistent' });
  const candidate = store.getJson(`application:${projectId}:${adaptedId}`).candidate;
  // The export has no Tempo Map; a single hypothetical T150 and the meter the
  // repository notes describe (2/4 then 4/4 from beat 2) are added to a copy for
  // a serialization check only.
  const withTempo = createCanonicalProject({
    ...candidate,
    tempoEvents: [createCanonicalTempoEvent({ id: 'COUNTERFACTUAL:tempo', beat: '0', bpm: 150, sourceIds: [candidate.sources[0].id] })],
    meterEvents: [
      createCanonicalMeterEvent({ id: 'COUNTERFACTUAL:meter-0', beat: '0', numerator: 2, denominator: 4, sourceIds: [candidate.sources[0].id] }),
      createCanonicalMeterEvent({ id: 'COUNTERFACTUAL:meter-2', beat: '2', numerator: 4, denominator: 4, sourceIds: [candidate.sources[0].id] }),
    ],
  });
  const emitted = emitFinalMml(withTempo, {});
  return {
    label: 'COUNTERFACTUAL_NOT_A_RESULT',
    hypothetical_inputs: ['a direct review of the recording that does not exist (submitted here under an agent provenance to exercise that path)', 'a placeholder original_audio asset', 'Tempo T150 and a 2/4→4/4 meter map not present in the export'],
    plan_status: cfPlan.status,
    release_changes: cfPlan.releaseRepresentation.changes.length,
    release_change_effects: sorted(cfPlan.releaseRepresentation.changes.reduce((map, change) => { bump(map, change.effect); return map; }, {})),
    unresolved_targets: cfPlan.releaseRepresentation.unresolvedTargetCount,
    run_state_after: resumed.run.state,
    micro_timing_after: { status: review.readiness.gates.microTiming.status, blockers: review.readiness.gates.microTiming.blockers, records: review.readiness.gates.microTiming.releaseRepresentationRecords?.recordCount ?? null, violations: review.readiness.gates.microTiming.releaseRepresentationRecords?.violations?.length ?? null },
    lead_promotion_after: { status: review.readiness.gates.leadPromotion.status, blockers: review.readiness.gates.leadPromotion.blockers ?? [] },
    core3_completeness_after: { status: review.readiness.gates.core3Completeness.status, blockers: review.readiness.gates.core3Completeness.blockers ?? [] },
    song_state_after: review.readiness.songState,
    serialization_check: {
      status: emitted.status,
      per_role_characters: Object.fromEntries(emitted.roles.map(role => [role.role, role.characters ?? role.mml?.length ?? null])),
      round_trip: emitted.roundTrip?.status ?? null,
      diagnostics: [...new Set(emitted.diagnostics.map(item => item.code))],
      mml_text_recorded: false,
    },
  };
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'work-dir': { type: 'string' }, events: { type: 'string' }, decisions: { type: 'string' }, assets: { type: 'string' }, project: { type: 'string' }, 'lead-queue': { type: 'string' },
    'ticks-per-quarter': { type: 'string' }, counterfactual: { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !values['work-dir'] || !values.events || !values.decisions) { process.stdout.write(HELP); return values.help ? 0 : 1; }
  const projectFile = values.project ? readJson(resolve(values.project)) : null;
  const project = projectFile ? (projectFile.project ?? projectFile) : null;
  const assetsFile = values.assets ? readJson(resolve(values.assets)) : null;
  const assets = project?.assets ?? (assetsFile ? (assetsFile.project?.assets ?? assetsFile.assets ?? assetsFile) : []);
  const receipt = await releaseTimingE2E({
    workDir: resolve(values['work-dir']),
    eventPaths: values.events.split(',').map(path => resolve(path)),
    decisionsPath: resolve(values.decisions),
    assets: assets.map(({ asset_id, kind, sha256, filename }) => ({ asset_id, kind, sha256, filename })),
    project: project ? { audio_evidence: project.audio_evidence ?? [], artifacts: project.artifacts ?? [] } : null,
    leadQueue: values['lead-queue'] ? readJson(resolve(values['lead-queue'])) : null,
    ticksPerQuarter: values['ticks-per-quarter'] ? Number(values['ticks-per-quarter']) : null,
    counterfactual: values.counterfactual === true,
  });
  const text = JSON.stringify(receipt, null, 2) + '\n';
  if (values.out) writeFileSync(resolve(values.out), text, { flag: 'wx' });
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
