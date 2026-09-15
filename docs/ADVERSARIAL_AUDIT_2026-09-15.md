# Pre-Studio-Web Adversarial Audit — 2026-09-15

Status: AUDIT RECORD — NOT A CANONICAL AUTHORITY

Per `docs/CANONICAL_MANIFEST.md`, audit documentation is not a Canonical rule
source and must never be loaded as a replacement for the four rule documents.
This file records what was tested, what was found, and what was fixed. It
creates no rule.

## Canonical bootstrap identity used for every judgment in this audit

Loaded first, from published `main`, before any MML / Lead / Core3 /
source-policy / readiness judgment.

| Field | Value |
| --- | --- |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| `manifest_commit` | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |
| `published_main_head` | `cce88be578be6a7b1bbf54dc1d315be5193fa8e7` |
| audit branch start | `914b604bd6ead77a9c67509b62c7ae935f6270d7` (fast-forwarded to published main) |

All four `CANONICAL_RULE_SOURCE` documents were loaded from the snapshot commit
and their `Version:` / `Status:` headers verified. The repository checkout is
shallow; the snapshot commit was confirmed present rather than substituted with
`HEAD`. No Canonical document was edited by this audit.

## Severity summary

| # | Severity | Area | Defect | State |
| --- | --- | --- | --- | --- |
| 1 | P1 | G11-A MIDI intake | A blank MIDI track name destroyed a complete ingest | Fixed + regression |
| 2 | P1 | Canonical IR merge | Caller metadata could overwrite the merge's own `sourceComplete` verdict | Fixed + regression |
| 3 | P1 | G10 C2A/C2B micro-timing | Evidence from an unrelated primary source bound a sub-grid interval | Fixed + regression |
| 3b | P1 | G10 C2A/C2B micro-timing | Union-level containment still let one side of a cross-source gap vouch for the other | Fixed + regression |

No P0 was found. Nothing below P1 was fixed, to keep this change reviewable.

## 1 — P1: a blank MIDI track name destroyed a complete ingest

`studio/backend/source/midi.mjs`

`ingestMIDI` derived the project title from the first track name it found, and
`midiFragmentToProject` passed it to `createCanonicalProject`, whose `nonEmpty`
check rejects a whitespace-only string. A whitespace-only track name is legal
SMF — the specification gives text meta events no encoding and no content rules
— so a fully parsed, `complete: true` file with one blank name threw and lost
every event.

This contradicts the adapter's own documented contract: a value the schema
cannot represent is recorded as evidence in `unsupported`, never allowed to
destroy the ingest. It is reachable from any user-supplied file, which is what
Studio Web Raw MIDI intake will hand it.

Fix: only a track name with actual content can become a title; the raw name is
still preserved verbatim in `fragment.tracks[].name` as evidence.

Regression: `studio/tests/midi-intake.test.mjs` — "a blank track name cannot
destroy an otherwise complete ingest".

## 2 — P1: caller metadata could launder a merge's completeness verdict

`studio/backend/canonical/merge.mjs`

`mergeCanonicalProjects` computed `sourceComplete`, `incompleteInputs`, `merge`
and `componentProjects`, then spread `options.metadata` *after* them. A caller
passing `{ sourceComplete: true }` overwrote the merge's own finding.

`backend/final/readiness.mjs` reads `project.metadata.sourceComplete` directly
as the Gate 2 source verdict, so a merge of inputs the intake had marked
incomplete could be presented as source-complete and pass that gate —
`ACCEPTANCE_CRITERIA.md` Gate 2 and `MASTER_RULES.md` §3 make that verdict the
merge's to state, not its caller's.

Fix: caller metadata is spread first as annotation; the four values the merge
determines are written after it and are not overridable. Metadata the merge does
not compute is still the caller's to supply.

Regression: `studio/tests/canonical-merge.test.mjs` — "caller metadata cannot
overwrite the merge findings it did not compute".

## 3 — P1: cross-source evidence leakage in the micro-timing gate

`studio/backend/canonical/micro-timing.mjs`

`hasAdmissibleSourceBinding` checked only that a decision's cited
`evidenceSourceIds` resolved to project sources and that at least one was a
genuine primary record. It never checked that the cited source had anything to
do with the interval being classified.

A sub-grid interval whose events came only from a *supporting* third-party
source was therefore classified `SOURCE_SUPPORTED_MICROTIMING` — and the whole
project reached `candidateReady` — on the strength of a citation to an unrelated
official source that carried none of its events.

`SOURCE_POLICY.md` §5 states that a source reference proves provenance, not
compatibility, and §2 requires the exact source IDs *and the event involved* to
be recorded together. The existing C2B-6 regression already proves a *spoofed*
primary record cannot bind an interval; a real primary record that carries none
of the interval's events is the same unproven claim wearing a real badge.

G11-C already contains role evidence this way (`evidenceScope` in
`backend/arrangement/role-candidates.mjs`, PR #19). The micro-timing gate,
merged earlier under G10 C2A, was not swept by that hotfix.

Fix: the admissible primary source must also be one of the interval's own
involved source IDs. `involvedSourceIds()` already computed exactly that set and
was used only for reporting; it is now threaded into classification.

Regressions: `studio/tests/micro-timing-readiness.test.mjs` — C2B-A1, C2B-A2
(containment must not cost a legitimate keep its PASS) and C2B-A3 (inter-event
gaps).

## 3b — P1: union containment was incomplete for cross-source gaps

`studio/backend/canonical/micro-timing.mjs`

External review of the fix for #3 found it directionally correct but incomplete,
and the follow-up case reproduced against that reviewed HEAD
(`e00573292c0be0b0b9a5f1f6b89198e267c2d711`).

The #3 fix required a cited source to be primary *and* present in the interval's
source IDs — but `involvedSourceIds()` returns the **union** of the provenance of
every event in the interval. A union is adequate for a single-event duration,
where it is just that event's own provenance. It is not adequate for an
inter-event gap, which has two participating events:

```
event A  sourceIds = ['official']   (official-musicxml, primary-symbolic)
event B  sourceIds = ['third']      (third-party-midi,  supporting)
gap      A -> B, length 1/17 (below the 1/16 safe grid)

decision.eventIds           = [A, B]
decision.evidenceSourceIds  = ['official']
interval union sourceIds    = ['official', 'third']
```

`official` is a genuine primary record and is in the union, so the citation
cleared containment and the gap classified as `SOURCE_SUPPORTED_MICROTIMING`.
But it is only *A's* provenance. It establishes nothing about B, which is
supporting-only, and nothing about the cross-source gap as a whole. One side
vouched for the other.

`SOURCE_POLICY.md` §2 requires the exact source IDs **and the event involved** to
be recorded together, and §5 states that a source reference proves provenance,
not compatibility. The interval should have stayed unresolved.

Fix: binding is evaluated per participating event instead of against a union.
`perEventSourceIds()` returns one provenance list per event in `eventIdsFor()`
order, and `hasAdmissibleSourceBinding` now requires *every* participating event
to intersect a cited admissible primary source. Either side unbound fails closed.
An event the project does not carry yields an empty list, which can never
intersect, so an interval naming a missing event also fails closed.

Deliberately unchanged: a cited source need not be used; an event's other sources
need not be primary; a mixed-provenance event is bound as soon as it intersects a
cited primary. Interval identity matching, technical-residue handling and Final
representability semantics are untouched.

Scope: this establishes provenance backing per event and nothing more. It is not
a claim of cross-source harmonic or audio compatibility, arrangement correctness,
Final representability, or target-client acceptance — those remain separate
gates, and this module is not a cross-source arbitration engine.

Regression matrix — `studio/tests/micro-timing-readiness.test.mjs`:

| Case | Shape | Expected | Pre-fix | Post-fix |
| --- | --- | --- | --- | --- |
| C2B-B1 | A official / B third, cite `official` | PENDING | **FAIL** (`PASS`) | PASS |
| C2B-B2 | A third / B official, cite `official` (mirror) | PENDING | **FAIL** (`PASS`) | PASS |
| C2B-B3 | both `official`, cite `official` | PASS | PASS | PASS |
| C2B-B4 | A `official` / B `official-b`, cite both | PASS | PASS | PASS |
| C2B-B5 | A `['official','third']` / B `official`, cite `official` | PASS | PASS | PASS |
| C2B-B6 | both `official`, cite `official-b` only | PENDING | PASS | PASS |
| C2B-B7 | event-duration bound to its own cited primary | PASS | PASS | PASS |
| C2B-B8 | supporting-only duration citing adjacent primary | PENDING | PASS | PASS |

B1 and B2 are the vulnerable cases: both failed pre-fix on the gate status itself
(`'PASS' !== 'PENDING'`), not on an added assertion field. B3–B8 pin the
behaviour that must not regress, and C2B-A1/A2/A3 from the first pass still hold.

## Areas adversarially tested and found sound

Recorded so a later reviewer knows these were exercised, not skipped. A passing
result here is evidence of this audit's coverage only; it is not proof of
correctness.

- **Canonical bootstrap / authority.** Snapshot unavailability fails closed with
  no `HEAD` fallback; `merge-base --is-ancestor` failure propagates; Manifest
  commit, rules snapshot, repository head and PR head stay distinct; a
  self-referencing Manifest provenance is rejected.
- **Lead demotion detection.** Every shape of a Melody demotion — role only,
  role+pitch, role+start, role+end — lands in `removed` or `roleMoved`, both of
  which `leadGate` requires evidence for. No demotion can hide in `modified`,
  which that gate does not cover.
- **`sha256Hex`.** Byte-identical to `node:crypto` across the block-padding
  boundaries (0/1/55/56/63/64/65/119/120/1000 bytes).
- **G11-B voice decomposition.** 400 randomized polyphonic inputs: no throw, no
  lost event, `complete` true throughout, and identical lanes under input
  shuffling.
- **SMF decoder framing.** Running status, meta/SysEx cancelling it, VLQ length
  cap, truncated tracks, data after End of Track, oversized chunk lengths and
  unknown chunks are all recorded as evidence rather than dropped.
- **Web revision binding.** Replacing a source, editing settings and attaching
  audio all call `invalidate()` first, so a review cannot survive the source it
  reviewed; `saveProject` uses a save token so a second tab cannot clobber.
- **Worker boundary.** A dead or timed-out analysis Worker is replaced rather
  than only rejected, and a fresh instance re-verifies the Canonical package
  before answering.
- **Local-processing boundary.** The audio path requires explicit intent, a
  HTTPS endpoint, credentials and an audio file type, and its payload excludes
  source text and source records.
- **Build identity.** `studio/web-build/` is gitignored build output, not
  tracked repository content; the artifact build and Canonical bootstrap both
  still succeed after these fixes.

## Carried forward — not fixed here

- **P2 — `evaluateLeadDemotion` does not verify that `sourceIdentity` matches the
  event's own `sourceIds` / `sourceEventIds`.** No current caller can produce a
  mismatch: `studio/web/model.mjs` builds it from the event itself and clears it
  on `invalidate()`. It is recorded because Studio Web Raw MIDI integration adds
  callers, and the same containment rule as #3 would apply.
- **P2 — `createCanonicalProject` freezes the project object but not its event
  arrays**, so `project.events.push(...)` bypasses post-construction validation.
  No current code path does this, and no contract claims deep immutability.
