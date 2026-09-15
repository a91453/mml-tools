# Studio Web — Raw MIDI local integration

Implementation record for the Studio Web Raw MIDI path. This is implementation
documentation, not a Canonical rule source. It defines no rule, changes no gate,
and cannot override `docs/MASTER_RULES.md`, `docs/SOURCE_POLICY.md`,
`docs/MOBILE_SYNTAX.md` or `docs/ACCEPTANCE_CRITERIA.md`. Where it describes
behaviour, the code and its regressions are what actually hold that behaviour.

Published Canonical this work was carried out under:

| Field | Value |
| --- | --- |
| `canonical_version` | `2026-09-13-v1` |
| `canonical_status` | `PUBLISHED` |
| `manifest_version` | `2026-09-13-v1-manifest1` |
| `rules_snapshot_sha` | `0a172900a01fdf39c2e9e84cf176961320b779ea` |
| Manifest addition commit | `5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14` |

## What was added

Studio Web could ingest text only. It can now ingest a Standard MIDI File, and
the integration is a transport layer: it adds no parser, no source
classification, no Canonical construction, no voice splitting, no role logic and
no readiness rule of its own.

```
File (.mid/.midi)
  -> file.arrayBuffer()                      studio/web/app.mjs
  -> postMessage (structured clone)          studio/web/worker.mjs
  -> ingestMIDI                              studio/backend/source/midi.mjs
  -> midiFragmentToProject                   studio/backend/source/midi.mjs
  -> splitProjectSourceVoices                studio/backend/arrangement/voice-split.mjs
  -> suggestRoleCandidates                   studio/backend/arrangement/role-candidates.mjs
  -> report.rawMidi -> Studio Web section    studio/web/model.mjs, studio/web/app.mjs
```

New modules: `studio/web/midi-source.mjs` (intake, persistence encoding,
derivation binding) and `studio/web/source-requests.mjs` (request identity).
`studio/web/model.mjs` gains `intakeMidi` and a `rawMidi` report section;
`studio/web/worker.mjs` gains one action; `studio/web/app.mjs` gains the picker
routing, the replacement transaction and the presentation.

## Decisions worth knowing

**Bytes are the authority.** The digest is taken over exactly the array handed
to the decoder. Persistence is base64 over latin-1 code units, which is lossless
for every byte value; a UTF-8 round trip would replace invalid sequences and
silently change the source.

**The buffer is cloned, not transferred.** `postMessage` without a transfer list
copies, so the page keeps its own buffer and persistence never races the decode
for ownership.

**Nothing derived is persisted.** G11-B and G11-C are re-derived from the stored
project on every analysis, so a candidate cannot outlive the bytes it was read
from and a workspace does not carry a multiple of its own source in derived
material. A restored or imported record that still carries an arrangement is
reported against its binding and discarded, never displayed as current.

**Stored fields are claims.** Every analysis re-reads the persisted bytes through
the real adapter and requires the stored Canonical project, completeness and
unsupported evidence to be what those bytes decode to. A portable backup is
re-ingested from its bytes outright.

**Request identity is a token, not a filename.** Two files can share a name and
carry different bytes, and the same file can be re-selected after a failure.

## Reachability of the two P2 findings PR #20 left open

Both were re-checked before implementation, because this task adds new callers.
Both remain unreachable and remain open. `studio/tests/raw-midi-preflight.test.mjs`
holds the containment.

**P2-A — `evaluateLeadDemotion` does not verify supplied `sourceIdentity`.**
Unreachable, unchanged by this work. The only production caller is
`studio/web/model.mjs#analyzeWorkspace`, which looks the event up inside the
*current* baseline and only evaluates evidence recorded at the current revision.
The only writer is the `#lead-form` handler in `studio/web/app.mjs`, which
derives the identity from that same baseline event. The Raw MIDI path adds no
caller: G11-A assigns no role, so a MIDI-backed event enters the gate as `N/A`
even when a deliberately mismatched identity is supplied; G11-C names the gate
and stays PENDING rather than resolving a demotion itself; and replacing any
source invalidates the workspace, which clears the recorded evidence a stale
identity would have to survive in. G11-C is deliberately not wired to the
Lead-demotion form, which is what would make it reachable.

**P2-B — `createCanonicalProject` does not deeply freeze its arrays.**
Unreachable, unchanged by this work. The whole A→B→C pipeline runs against a
deeply frozen project, so a write into a Canonical array would throw rather than
succeed quietly, and the caller's arrays come back byte-identical with their
original identity. The Worker boundary copies, so page state cannot reach them.

## Known limitations

* A portable backup of a large MIDI project can exceed the existing 16 MiB
  restore ceiling. The error names the actual size and the limit; raising the
  ceiling was left out of scope.
* Intake refuses a file over 4 MiB, and refuses a file whose Canonical event
  count would exceed 30000 — the same ceiling `readCanonical` already applies.
  Both are implementation guards, not Canonical rules: they fail visibly, name
  the real number, and leave the current source untouched.
* An event ledger past the inline display bound is summarised on screen and
  carried in full in the downloadable analysis report.

## Scope

This path ends at a preserved source project, its G11-B decomposition and a
G11-C candidate, plus the existing readiness information. It performs no G11-D,
no G12, no Final MML generation, no Mobile adaptation, no instrument or octave
assignment, no drum-face mapping, and asserts no in-game result.
