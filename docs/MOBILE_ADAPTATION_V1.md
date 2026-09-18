# Mobile Adaptation v1

Status: IMPLEMENTATION NOTES. This implements the Published Canonical selected
by `CANONICAL_MANIFEST.md`; it does not change its snapshot or publish new rules.

Studio can now **plan → apply → re-review** register and volume adaptations on
a source-traceable candidate with assigned roles. It creates a derived candidate
and retains the Source-Faithful Baseline and previous candidate. Gate 8 and Gate 9
still require fresh candidate-bound evidence-backed review. No operation grants
in-game acceptance.

## Implemented scope

| Operation | Behavior |
| --- | --- |
| Register | Finds the smallest whole-octave shift fitting **all notes of a role** inside a supplied inclusive pitch range. Preserves melodic intervals, pitch classes, roles and attacks. Does not fold individual notes. |
| Volume offset | Adds the same integer offset to the role's decided volumes, preserving their differences. Refuses overflow/underflow rather than clipping. |
| Undecided volume | Uses an explicitly supplied, cited `defaultVolume` only for null volumes, then applies the offset. Never treats MIDI velocity as a Mobile volume. |
| New collision detection | Rechecks sustained same-pitch overlap across all sources (including the same source), and existing cross-source m2/M7/m9 analysis. Newly introduced risks block the entire application. Existing risks remain visible review signals. |
| Evidence / history | Stores input/profile/Canonical identities, event-level before/after changes, reason and evidence references, baseline and parent diffs. Inputs and source provenance remain intact. |
| Revalidation | Application Service immediately reruns the existing candidate review pipeline. Web reruns its analysis. Final emission and exact readback remain separate requirements. |

The repository does not contain a verified general-purpose Mobile instrument
audibility database. Profile ranges and volumes are song/target-specific inputs
with evidence references, **not inferred instrument facts**. Citations record
what the caller relied on; the software does not authenticate their contents or
certify audible quality from numbers. There are no recommended musical values
embedded in the UI.

## Profile contract

```json
{
  "schema": "mml-studio/mobile-adaptation-profile@1",
  "id": "my-song-target-v1",
  "reason": "Use the register and levels supported by the cited target test.",
  "evidence": ["project evidence: target client test, section A"],
  "roles": {
    "Melody": { "pitchRange": [48, 84], "volumeDelta": 1 },
    "Chord1": { "defaultVolume": 8 }
  }
}
```

These numbers illustrate syntax only; they are not instrument recommendations.
Roles may be Melody or Chord1–Chord5. Omitted roles/fields are unchanged. Empty
roles remain empty. Ranges must be inside the Published Canonical pitch range
0–107; resulting volumes must be 0–15. Unknown keys, fractional values, absent
evidence and malformed profiles are rejected. A null volume with a requested
offset but no default is unresolved, not assumed to be the parser default.

An out-of-range role that cannot fit through a uniform octave shift returns
`REGISTER_REQUIRES_PHRASE_REVIEW`. V1 does not invent phrase segmentation, erase
notes or compress the melody to satisfy a range. An unassigned role or unmatched
source event also blocks. GM percussion notes must not enter the pitched path.
Collision reporting refuses inputs with more than 50,000 temporally overlapping
note pairs (`COLLISION_SCAN_LIMIT`) rather than allocating an unbounded report.
This is an implementation budget, not a game limit or a musical verdict.

## Agent / HTTP workflow

1. Build the Source-Faithful Baseline and use existing arrangement operations to
   obtain a candidate with assigned roles.
2. Call `studio_mobile_adaptation_plan` with `project_id`, `candidate_id`, and
   `profile`. Read `adaptation.plan`: changes, blockers, warnings, collisions and
   content-bound `id`. A plan PASS means the requested transformation is
   executable, not that Gate 8 passed.
3. Call `studio_mobile_adaptation_apply` with the same inputs plus
   `expected_plan_id` and `accepted_by`. The engine recomputes the plan; stale
   candidate, baseline, Canonical or profile inputs cannot reuse the old preview.
4. Read `adaptation.candidate_id` and the returned `review`. Review new diffs and
   re-supply any necessary Core3/Lead, Mobile, regression and audio evidence for
   this candidate, then use the existing Final operation.

HTTP exposes the same workflow:

```text
POST /api/v1/projects/:id/mobile-adaptation/plan
POST /api/v1/projects/:id/mobile-adaptation/apply
```

The Application Service methods are `planMobileAdaptation` and
`applyMobileAdaptation`; their argument names are camelCase. Read-only preview
cannot be converted into apply by supplying an extra `apply` flag. Owner and
project scoping, request limits and Canonical loading follow the existing service.

Application is atomic: any blocker yields no candidate and no partial edits.
A no-op creates no revision. The same application against the same parent has
the same candidate identity. Repeating the same profile on an unchanged adapted
target is a no-op; if that target changed later, `MOBILE_PROFILE_CONTEXT_CHANGED`
requires reconsidering the profile rather than accumulating another offset.

Adaptations use the existing content-addressed candidate revision envelope and
legacy `g11d:rev:` identifier namespace for compatibility, with the distinct
`stage: MOBILE_ADAPTATION_V1` bound into the revision hash. They do not pretend
to be G11-D role decisions. Existing G11-D revision hashes are unchanged. Parent
lineage remains readable by Lead evidence recovery, whose existing identity and
context checks reject stale evidence after pitch/volume changes. A revision
does not inherit source-completeness or audio claims, and accepted harmony
decisions reopen as pending.

## Local Web workflow

The **Mobile 適配 v1** section provides per-role range/volume inputs, evidence and
reason fields, a preview with event differences, an apply action, and rollback.
It runs the same engine inside the Canonical-verified Worker. The original source
assets remain in the workspace. Changing the profile replaces the transformation
from the original candidate instead of stacking relative offsets.

IndexedDB stores profile and preview bindings, not a trusted derived PASS.
Analysis reconstructs the candidate on every reload. A stale stored profile
adds a blocking integrity gate. Applying or removing the adaptation invalidates
reviews, audio, acceptance and prior Final delivery. Backups retain adaptations
as history on import and require a fresh preview/application. Changing source or
project settings clears the adaptation with the other revision-bound state.

Web currently adapts the candidate asset's assigned Canonical roles. Its Raw MIDI
G11-D report is not automatically promoted into that candidate asset: unassigned
MIDI material still needs an accepted candidate before this transformation is
applicable. This is not a one-click MIDI-to-Final pipeline.

## Remaining work

- Measured instrument-specific audibility profiles and audibility judgement.
- Automatic instrument assignment and performer allocation.
- Evidence-backed drum-face conversion; no GM pitch leakage.
- Automatic collision repair / redistribution; v1 detects and blocks new risks.
- Phrase-specific register strategies when one uniform shift cannot fit.
- Adapting the pitch/volume of an event previously promoted into or demoted out
  of Melody: the existing Lead re-review contract requires source musical
  identity. V1 blocks this combination before creating an unreviewable candidate
  (`LEAD_ROLE_ADAPTATION_REVIEW_UNSUPPORTED`). Changes to other events can still
  invalidate Lead context and require the existing fresh Lead re-review.
- MIDI velocity curves calibrated to Mobile volume.
- Complete Final six-role reduction / G12.

These are separate capabilities, not silently covered by v1 PASS. Original
audio, real target-client testing, and the published acceptance gates remain
necessary as applicable.

## Verification

- `studio/tests/mobile-adaptation.test.mjs`: transformations, atomic refusals,
  repeatability, provenance, staleness, derived revisions, fresh Gate 8/9 review,
  Web replay/import/rollback and Final serialization.
- `tests/mobile-adaptation-transport.test.mjs`: actual HTTP/MCP routes, identical
  preview/apply output, authorization and malformed application refusal.
- `studio/browser-tests/mobile-adaptation.mjs`: real preview/apply/reload/rollback
  on the existing iPhone/iPad WebKit and desktop Chromium test profiles.

Browser profiles simulate device viewports; they do not certify physical Safari
or Mabinogi target-client behavior.

### Local verification record (2026-09-18)

- Combined legacy + Studio suite: **1,470 passed, 0 failed, 1 skipped** out of
  1,471 tests, run with `node --test --test-concurrency=1 --test-timeout=60000
  tests/*.test.mjs studio/tests/*.test.mjs`. The skipped test requires root to
  construct a foreign-owned checkout and is not a Mobile test.
- After the final report-key/UI wording adjustment, the 17 Mobile engine,
  Application, Web-model and HTTP/MCP regressions passed again.
- Studio Web build succeeded. iPhone WebKit, iPad WebKit and desktop Chromium
  browser flows passed, including the Mobile preview/apply/reload/rollback flow.
- Windows verification uses Git for Windows `sh` for the existing Linux image
  probe. Test helpers now use junctions where Windows cannot create directory
  symlinks, portable path separators and case-insensitive PATH lookup. The Git
  attributes keep text in LF so fixed-byte evidence and reproducible artifacts
  are not rewritten by Windows checkout settings. No Published Canonical rule
  or pinned evidence payload was modified.

This record covers source-tree verification; it is not a deployment or an
in-game acceptance record.
