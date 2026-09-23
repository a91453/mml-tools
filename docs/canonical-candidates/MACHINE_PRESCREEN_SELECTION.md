# DRAFT — UNPUBLISHED CANONICAL CANDIDATE — Machine-prescreen selection

Candidate id: `CANDIDATE-2026-09-23-MACHINE-PRESCREEN-SELECTION`
Status: **DRAFT, UNPUBLISHED CANONICAL CANDIDATE. Requires the project owner's
explicit publication approval.** Not a Canonical rule source, not indexed by
`docs/CANONICAL_MANIFEST.md`, not active in any release, and not wired into any
run, decision, review or Final path.
Based on: Published Canonical `2026-09-23-v3`, rules snapshot
`ff1a9df054f5ca1ae42571067fc95feb274755ef`,
`machine_delivery_schema: mabinogi-mobile-mml-studio/machine-delivery@2`.
Change-control route: `MASTER_RULES.md §12` (explicit rationale, evidence
class, regression impact; executable-contract changes only after the prose rule
is accepted). Publication would follow the v2/v3 route recorded in
`docs/CANONICAL_MACHINE_DELIVERY_CANDIDATE.md`: prose, implementation, then a
Manifest commit, each with the owner's authorization.

This file proposes a rule. It publishes nothing. Until a reviewed release adds
it to the Manifest's rule sources, **Published v3 behaviour is unchanged**: an
audio-prescreen verdict (`docs/AUDIO_PRESCREEN.md`) is machine evidence only,
selects nothing, accepts nothing and sets no gate.

## 1. The question Published v3 does not decide

The owner's principle for this project is 「譬如要做決策明顯的時候 不明顯再給人工」:
when a choice between alternatives is obvious, the machine decides; when it is
not, the owner listens. And: 「機器能判定的缺陷照擋；需要人判斷給我mml試聽」.

Studio can now measure, bar by bar, whether one of 2–4 alternatives is
obviously better than the others by every applicable machine metric (low/mid
roughness not inherited from the source, role masking, decay smear, clipping,
and similarity to the original recording when one is aligned), and whether the
winner stays at least as close to the source as every other alternative. It
reports `OBVIOUS` or `NEEDS_HUMAN` with reasons.

What Published v3 says:

| Source | Text | What it settles |
| --- | --- | --- |
| `ACCEPTANCE_CRITERIA` "Machine delivery" | what a machine can determine blocks; what needs a person's judgment is delivered for listening first and stays unresolved | The dividing line. It does not name a machine *choice* between alternatives as either. |
| `ACCEPTANCE_CRITERIA` Gate 6, Gate 7, Gate 10 | human listening and loaded-player readback are `POST_DELIVERY`; original-audio evidence is `NON_BLOCKING_PENDING`; only the user or a controlled client sets `IN_GAME_ACCEPTED` | A machine metric is none of these and cannot stand in for them. |
| `MASTER_RULES §2` | source traceability → … → Mobile audibility / role clarity → minimal adaptation → Full6 → theory/statistical cleanup last | Source outranks sound; a metric is never a reason to erase source material. |
| `MASTER_RULES §9`, `§11` | `applied=true`, website playback and parser success are not acceptance; no lower layer impersonates a higher one | A rendered-audio metric cannot be listening. |
| `SOURCE_POLICY §6` | machine metrics are locators, not evidence of musical meaning | A prescreen number is not evidence about the music. |

So under v3 a machine metric can never be an acceptance, and there is no rule
under which Studio may apply an obvious prescreen outcome without asking. This
candidate proposes one, narrowly: a provisional, reversible selection that is
delivered first and flagged, exactly as v3 delivers a provisionally held
release or an unverified Lead.

## 2. Proposed rule text (candidate)

> **R-MPS-1 (scope).** Applies only when Studio must choose, for a contiguous
> bar region, between 2–4 alternatives that are each already a legal,
> source-traceable candidate for that region: every `BLOCKING` machine-delivery
> gate is `PASS` or `N/A` for each alternative on its own. The prescreen chooses
> among deliverable alternatives; it never makes an undeliverable one
> deliverable, and every machine-determined defect still blocks.
>
> **R-MPS-2 (obvious verdict).** A region's verdict is `OBVIOUS` only under the
> prescreen decision rule of the release (report schema
> `mml-studio/audio-prescreen-report@1`): at least one metric separates the
> alternatives decisively; every decisive metric names the same winner; the
> winner is within tolerance of the best on every other metric; every applicable
> metric was measured; and the winner's source-fidelity distance is the smallest
> of the alternatives. Source fidelity outranks smoothness: an alternative that
> departs further from the source is never an obvious winner on sound alone, and
> dissonance the source already has is reported but never counted against an
> alternative.
>
> **R-MPS-3 (provisional selection).** An `OBVIOUS` region whose category is
> published (R-MPS-6) is delivered with the winner, provisionally. The
> selection is recorded in the unresolved evidence ledger as
> `NON_BLOCKING_PENDING` with code `MACHINE_PRESCREEN_SELECTED`, naming the
> region (bars and beats), every alternative (its MML or performance SHA-256),
> the winner, the decisive metrics and margins, the category, the prescreen
> `report_id`, the thresholds id, the sound-bank SHA-256 and the renderer and
> calibration identities. It exists only in the delivered artifact; every
> alternative stays stored unchanged, and the selection is reversible exactly by
> choosing another alternative.
>
> **R-MPS-4 (never an acceptance).** A `MACHINE_PRESCREEN_SELECTED` region is
> never human listening, never Gate 6 player readback, never Gate 7
> original-audio evidence, never `IN_GAME_ACCEPTED`, never `PASS` and never
> `VALIDATED`. A delivery that carries one is `AUTOMATED_VALIDATED` at most. It
> stays in the ledger until the owner's own choice resolves it, and the owner's
> choice always replaces the machine's. The free GM bank the prescreen renders
> with is not the game timbre, and the rule claims nothing about how the game
> sounds.
>
> **R-MPS-5 (everything else goes to the owner).** A `NEEDS_HUMAN` region, an
> `OBVIOUS` region of an unpublished category, and any region whose prescreen
> did not run keep the alternative Studio would have delivered without the
> prescreen. Each is recorded `NON_BLOCKING_PENDING` with code
> `MACHINE_PRESCREEN_NEEDS_LISTENING` and a listening request naming the bars,
> the reasons and the alternatives to compare (the report's `human_review`).
>
> **R-MPS-6 (per-category enablement).** Selection applies only to the
> categories (sets of decisive metrics, e.g. `roughness`, `roughness+smear`)
> that the release names, each under one named thresholds id, sound-bank
> SHA-256, renderer id and calibration id. Any other category, and any change
> of those identities, is `MACHINE_PRESCREEN_NEEDS_LISTENING` until a release
> names it. Recommended publication bar, to be stated per category in the
> release: in shadow mode (§6), at least **30** recorded owner choices for the
> category under the same identities, with at least **95%** agreement between
> the owner's choice and the machine's winner. Categories below the bar are not
> published.
>
> **R-MPS-7 (always listed).** The delivery report lists, for the owner, every
> `MACHINE_PRESCREEN_SELECTED` region (bars, winner, runner-up, decisive metrics
> and margins, report id) and every `MACHINE_PRESCREEN_NEEDS_LISTENING` region
> with its listening request. Nothing is applied silently.
>
> **R-MPS-8 (re-evaluation).** A new candidate revision, a new source, a new
> alignment revision, or a change of bank, renderer, calibration or thresholds
> re-runs the prescreen; an earlier selection does not carry over (as for every
> machine-delivery phase).

## 3. Rationale

- The owner wants obvious choices applied without being asked and every
  non-obvious one handed over for listening. v3 already delivers two kinds of
  unresolved result first and flags them; this is the same pattern applied to a
  choice between alternatives.
- The rule is one-sided by construction. Every condition in R-MPS-2 has to
  hold, and every failure goes to the owner: metrics that disagree, margins that
  are too small, a metric that could not be measured, or a winner that departs
  further from the source.
- It is narrower than listening. It never claims a region sounds right; it
  claims only that one deliverable alternative is measurably better than the
  others in stated, reproducible ways, and it keeps that claim open until the
  owner confirms it.
- Shadow mode (§6) lets the owner see how often the machine agrees with them,
  per category, before any category is published.

## 4. Evidence class

Project-owner decision (`MASTER_RULES §0`, item 1) for the delivery policy.
The prescreen itself is `MACHINE_METRIC` evidence: machine-derived measurements
of a rendering with a generic GM bank. It is **not** source-supported musical
meaning, **not** audio evidence of the original recording (even when it
compares against it), **not** human listening, **not** player readback and
**not** in-game evidence. `SOURCE_POLICY §6` is unchanged.

## 5. Regression impact

- Every gate reports what it reported before; the meanings of `PASS`,
  `VALIDATED`, `AUTOMATED_VALIDATED` and `IN_GAME_ACCEPTED` are unchanged.
- The rule adds two ledger codes, both `NON_BLOCKING_PENDING`, and would be a
  new machine-delivery schema (`@3`). Runs and artifacts recorded under `@1`
  and `@2` keep their projection; a lazy projection never creates a selection.
- Stored candidates, the Source-Faithful Baseline and the baseline diff never
  change. A delivered artifact differs from the alternative Studio would have
  delivered only in the listed regions.
- Where no alternatives exist (the common case today) nothing changes.
- Named historical regressions remain `FIXTURE_PENDING`.
- The local Studio Web keeps its v1 generation gating.

## 6. Shadow mode (implemented, not a rule)

Already present and inert with respect to delivery: a per-project calibration
record in the service data directory (`mml-studio/audio-prescreen-shadow@1`),
written only by explicit calls. `studio_prescreen_shadow_record` with
`entry: prediction` records a prediction (the service recomputes the report; a
caller cannot supply verdicts); `entry: owner_choice` records the owner's actual
choice for one predicted region and requires `accepted_by`. Reading it
(`studio_audio_prescreen` with only `project_id`, or
`GET /api/v1/projects/:id/audio-prescreen/shadow`) returns agreement per metric
and per `OBVIOUS` category (count and rate) and names the categories that meet
the recommended bar of R-MPS-6. Meeting the bar enables nothing.

## 7. Implementation impact (present parts are inert; wiring is described, not done)

Present, and changing no gate or delivery:

- `studio/backend/audio/prescreen/*` — renderer, metrics, source fidelity,
  decision rule, report (`mml-studio/audio-prescreen-report@1`).
- `studio/backend/application/prescreen-service.mjs` — the read-only
  `audioPrescreen`, `prescreenShadowStatus`, and the shadow-record write.
- Every report carries `authority.auto_apply: { active: false, reason:
  CANONICAL_RULE_UNPUBLISHED, proposed_ledger_code: MACHINE_PRESCREEN_SELECTED }`.

Not wired, and to be done only after this prose is accepted, in order:

1. **Loader and opt-in.** A new release (e.g. `2026-09-2x-v4`) listed in
   `rules/supported-releases.mjs`, with `machine_delivery_schema @3`. Until it
   is published nothing below can activate: implementations opt into a release
   explicitly, and the Manifest names the release.
2. **Evaluator.** `final/delivery-evaluator.mjs` classifies a new readiness gate
   `prescreenSelection` by its own status and codes: under `@3`,
   `MACHINE_PRESCREEN_SELECTED` and `MACHINE_PRESCREEN_NEEDS_LISTENING` are
   `NON_BLOCKING_PENDING`; any other status, a report that does not re-verify,
   or an evaluation that did not run is `BLOCKING`. Under `@1`/`@2` the gate is
   unknown and therefore `BLOCKING` (fail closed), so nothing can use it early.
3. **Published categories.** A constant beside `PROVISIONAL_RELEASE_POLICY`
   naming, per release, the enabled categories and the thresholds id, bank
   SHA-256, renderer id and calibration id each is enabled under. Anything
   else is `MACHINE_PRESCREEN_NEEDS_LISTENING`.
4. **Where alternatives come from.** A run step after G12 reduction and Mobile
   adaptation, taken only when a plan offers alternatives for a region (for
   example two register placements of a Chord role). It calls the same
   `audioPrescreen` with candidate ids, never with caller-supplied verdicts, and
   records the report id in the run.
5. **Final.** Under `@3` only, the Final service composes the delivered MML
   per region from the selected alternatives (bar-aligned, sharing the
   baseline), re-grades the composite by round trip, and files the selections
   and listening requests in the artifact and ledger; the stored candidates are
   never modified. Studio Web never opts in.
6. **Owner resolution.** The owner's choice (an explicit, candidate-bound
   decision naming `accepted_by`) resolves a region either way and replaces the
   machine's selection; the shadow record keeps both for agreement figures.
7. **Tests.** Evaluator classification under `@2`/`@3`; unknown-gate refusal
   before publication; a selection never setting any gate; composite round
   trip; re-evaluation on a new revision; per-category enablement and identity
   changes; a simulated publication PR and merge, as for v2 and v3.

## 8. Rollback / fail-closed behaviour

- Unpublished (now): the prescreen is evidence only; no region is selected;
  every report says `auto_apply.active: false`.
- After publication, rollback = remove the release from the supported list or
  publish a release that names no categories; every region then becomes
  `MACHINE_PRESCREEN_NEEDS_LISTENING`, and artifacts keep the record of what was
  selected.

## 9. What this does not do

- It does not publish, and it does not change any published rule or gate.
- It does not let a machine metric stand in for listening, readback, Gate 7,
  in-game acceptance or any source evidence.
- It does not decide between alternatives that are not each deliverable, and it
  never trades source fidelity for sound.
