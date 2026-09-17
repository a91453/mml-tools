# Studio Agent Interface v1 — implementation notes

Status: IMPLEMENTATION NOTES (not a Canonical rule source)
Implements: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`

This interface implements and exposes existing Published Canonical-aware Studio
capabilities. It does not define or modify Canonical rules. Where it states a
behaviour the published rule sources do not state, that behaviour is an
**implementer decision** and is chosen to be strictly narrower than the rule,
never wider.

## 1. What was missing

The Canonical-aware engines — source intake, score intake, voice decomposition,
role candidates, decision application, arbitration, version drift, readiness,
micro-gap enforcement, Technical Timing Repair, the Final MML emitter — all
existed and were all reachable from exactly one place: the browser workspace
model, behind a Web Worker.

The deployed service reached past them entirely. `server/mcp.mjs` ran three
read-only tools on the legacy `dist/core.js` engine and never imported
`studio/backend/**` at all. So there was no orchestration boundary: a second
caller would have meant a second workflow, and a third would have meant a third.

That is the shape this stage removes. There is now one orchestration interface,
and every caller is an adapter over it.

```
ChatGPT · Claude · Codex · future models · local agents
                        │
                   MCP adapter
                        │
Studio Web · CLI · PWA ─┼─ HTTP adapter
                        │
              Application Service          studio/backend/application/
                        │
              existing Studio backend      studio/backend/{source,score,mml,
                        │                   canonical,arrangement,arbitration,
                Published Canonical         compare,audio,final}
```

The arrows only point downward. The Application Service consumes the backend; it
re-implements no parser, no arrangement algorithm, no readiness gate, no repair
and no Final policy. The backend does not know the Application Service exists,
and neither layer knows which transport — or which model — is calling.

## 2. Model-agnostic by construction

There is no `openai.js`, no `anthropic.js`, no provider SDK, no provider
credential, no provider-specific prompt or state model, and no branch anywhere
that asks who is calling. A model is an external MCP client of this interface,
never a dependency of it.

This is a correctness property, not a preference: the answer to "what does this
song need next" must not depend on which model asked. A regression asserts that
no provider name appears anywhere in the tool surface or the server
instructions.

The service calls no LLM API. It cannot: it holds no key and imports no client.

## 3. Application Service contract

`studio/backend/application/` — the only orchestration and business interface.

| Module | Responsibility |
| --- | --- |
| `contracts.mjs` | Identities, asset kinds, job states, gate axes, error codes, bounds. |
| `provenance.mjs` | The Canonical gate and the provenance envelope. |
| `capabilities.mjs` | Factual capability discovery. |
| `store.mjs` | Records and blobs; filesystem or memory. |
| `project-service.mjs` | Project identity and ownership. |
| `asset-service.mjs` | Upload, digest, byte integrity. |
| `job-service.mjs` | Job lifecycle. |
| `intake-service.mjs` | Symbolic sources → Source-Faithful Baseline. |
| `arrangement-service.mjs` | Suggestion, then explicit acceptance. |
| `review-service.mjs` | Candidate review, confirmations, gate axes. |
| `final-service.mjs` | Finalize orchestration and artifacts. |
| `technical-service.mjs` | The legacy Strict Mobile technical check. |

Operations: `capabilities`, `createProject`, `getProject`, `listProjects`,
`uploadAsset`, `listAssets`, `getAsset`, `readAssetBytes`, `analyzeSources`,
`attachAudioAlignment`, `suggestArrangement`, `applyDecisions`,
`recordConfirmations`, `reviewCandidate`, `finalize`, `getJob`, `listJobs`,
`getArtifact`, `validateTechnicalMml`, `technicalOverlapDetails`.

### The Canonical gate

`backend/rules/index.mjs` performs the Published Canonical load at module
evaluation, and every Canonical-aware engine imports it transitively. The
Application Service therefore loads the engines **lazily**, through dynamic
import, for one reason: a static import would make *constructing* the service
throw in any environment without the published Git history, taking down the
whole transport — including the capability endpoint an agent needs in order to
discover that Canonical is unavailable.

So: capability discovery, project records and asset storage work without
Canonical. Every operation that would apply a Canonical-aware rule goes through
`engines()`, which either returns the real backend modules or fails closed with
`CANONICAL_NOT_LOADED`.

There is no fallback. Not a legacy Skill, not an old Master, not a cached rule
set, not a working-tree replacement, not a bundled copy of the documents.

A missing runtime dependency reports `ENGINE_UNAVAILABLE` instead. Reporting it
as a Canonical failure would blame the published rules for an environment
problem and would make a test for `CANONICAL_NOT_LOADED` start passing for the
wrong reason.

**Inherited property, stated rather than hidden:** once `rules/index.mjs` has
thrown during evaluation, that ES module record stays errored for the life of
the realm. A later call re-raises the same failure without re-running Git. A
process that started without the published history does not silently acquire it.

## 4. Canonical provenance

Every significant response carries the envelope, with the five identities as
five separate fields. None is a Canonical version, none substitutes for another,
and there is no merged `version` field a reader could mistake for the release
identity.

```json
{
  "canonical": {
    "status": "CANONICAL_LOADED",
    "canonical_version": "2026-09-13-v1",
    "canonical_status": "PUBLISHED",
    "manifest_version": "2026-09-13-v1-manifest1",
    "rules_snapshot_sha": "0a172900a01fdf39c2e9e84cf176961320b779ea",
    "manifest_commit": "5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14",
    "published_main_head": "…",
    "repository_head": "…",
    "pr_head": null,
    "entry_point": "docs/CANONICAL_MANIFEST.md"
  }
}
```

A failed HTTP call carries it too: an agent told a call failed still has to know
which rules snapshot answered.

## 5. Identity model

| Identity | Form | Why |
| --- | --- | --- |
| `project_id` | `prj_<32 hex>` | Server-generated, random. |
| `asset_id` | `ast_<32 hex>` | Server-generated, random. |
| `job_id` | `job_<32 hex>` | Server-generated, random. |
| `artifact_id` | `art_<sha256>` | Content-addressed over the artifact body. |
| `baseline_id` | `bas:<sha256>` | `baselineIdentityOf(project).contentDigest`. |
| `candidate_id` | `g11d:rev:<sha256>` | The existing G11-D revision id, verbatim. |

The opaque ids are random rather than content-addressed on purpose: possessing a
digest of somebody else's input must not let a caller name their record. The
derived ids are content-addressed because the thing they name *is* its content.

A candidate id is the backend's own revision id, used unchanged. This layer does
not mint a second identity for an object that already has one.

**A filesystem path, a temporary filename, an upload filename and a browser URL
are never identities.** An upload filename is stored as metadata, echoed back for
a human, and never opened, joined, resolved, served from, or used to choose a
parser. Stored filenames are generated from the asset id.

This is also why the Canonical source *label* is derived from the asset kind and
digest rather than from the upload filename. The label reaches
`baselineIdentityOf`, so a filename there would make the baseline identity a
function of what a file happened to be called — and re-uploading identical bytes
under a different name would mint a different baseline and silently invalidate
every decision accepted against the old one.

## 6. Asset lifecycle

```
iPhone / iPad / browser / CLI
            │  multipart/form-data, or a raw body with x-mml-asset-kind
            ▼
   POST /api/v1/projects/:id/assets
            │
            ▼
        asset_id ──────────► every later step, on every transport
```

Kinds: `original_audio`, `official_midi`, `third_party_midi`,
`official_musicxml`, `third_party_musicxml`, `current_mml`, `historical_mml`,
`canonical_project`, `audio_alignment_report`, `final_mml`, `report`.

Each kind maps explicitly onto an existing `canonical/index.mjs` `SOURCE_KINDS`
member and an existing source authority. The underscored spelling here is a wire
format; the hyphenated Canonical names remain the schema. A regression asserts
the mapping, so this never becomes a second Canonical source vocabulary.

Kinds that carry no symbolic content (`original_audio`, reports, outputs) have
`intake: false` and are refused by intake rather than handed to a guessed parser.

The SHA-256 is computed from the bytes received; a caller cannot assert one. It
is re-checked on every read, and a blob that no longer matches the metadata it is
filed under is refused rather than parsed.

An uploaded Canonical IR is rebuilt through the IR constructors, and the four
metadata keys `final/readiness.mjs` reads as gate evidence — `sourceComplete`,
`audioAlignmentEvidence`, `sourceFaithfulBaseline`, `g11d` — are dropped on the
way in. An imported file cannot assert a gate it has not earned, exactly as
`applyAcceptedArrangement` refuses to let a parent candidate inherit one.

## 7. Job lifecycle

`queued → running → succeeded | failed`. Each transition is written with its own
timestamp, and a failure records the state it failed from and the structured
error that caused it.

**What this build actually does:** the work runs inline, in the request that
created the job, and the job is already terminal when it is first returned.
There is no background queue, no worker pool and no external queue service,
because adding one would mean adding a paid dependency this work is not allowed
to introduce.

`capabilities.jobs.background_execution` is `false` and
`capabilities.jobs.job_cancellation` is `false` for exactly that reason. An
agent that polls `studio_job_status` simply finds a terminal job on the first
poll — it is not misled about what is happening.

Jobs wrap intake, audio alignment and finalize. `cancelled` exists in the
lifecycle vocabulary but is never reached in this build.

## 8. Gate separation

Six independent axes, reported as their own field, never collapsed into a
success boolean:

```json
{
  "operation": "succeeded",
  "gates": {
    "technical": "PASS",
    "source": "PASS",
    "audio": "PENDING",
    "player_readback": "PASS",
    "mobile_adaptation": "PENDING",
    "in_game": "PENDING"
  }
}
```

`operation` says whether the orchestration ran. `gates` says what the song
satisfies. They are different questions and are answered in different fields.

A blocked finalize returns `operation: "blocked"` with code
`FINALIZATION_BLOCKED` — HTTP 200, not an error status. The call worked; the song
is not ready. Conflating those would make a reviewer's finding indistinguishable
from a transport fault.

Each axis is transcribed from the module that owns it. `mobile_adaptation` has
no implemented gate in this build and stays `PENDING` rather than borrowing
`technical`, because Gate 8 adaptation is a different question from
serialization.

**`in_game` is `PENDING` by construction.** No emitter, parser, job, transport,
test or model call can set it, and attempting to record it is refused with the
reason. Only the user or a controlled target-client test can record in-game
acceptance, and this build records none.

### Confirmations

A G11-D candidate deliberately carries no gate evidence — `applyAcceptedArrangement`
strips it so no restored or imported parent can hand a fresh revision a result
nobody recomputed. The consequence is that source completeness and audio
evidence are assertions somebody has to make *against the candidate that
actually exists*.

They are recorded explicitly, each with a stated reason:
`source_complete`, `version_drift_reviewed`, `player_readback` (PASS or NOT_RUN
only), `original_audio_required`. The review project is then assembled from the
candidate plus exactly those confirmations, through the backend's own
constructors — the same composition the Studio Web analysis performs.

`source_complete` cannot be confirmed over a baseline whose own adapters
reported unsupported source material: the evidence contradicts the claim, and a
review is not allowed to overrule it.

## 9. Workflow

```
upload assets (HTTP)  →  studio_sources_analyze   →  Source-Faithful Baseline
                      →  studio_arrangement_suggest →  role candidates + PENDING
                      →  (agent/user reviews evidence)
                      →  studio_decisions_apply    →  candidate_id
                      →  studio_audio_alignment    →  audio evidence (optional)
                      →  studio_candidate_review   →  per-module verdicts, gates
                      →  studio_finalize           →  artifact_id + Final MML
                      →  studio_artifact_get
```

A suggestion is not an acceptance. This layer will not convert one into the
other, will not resolve a `PENDING` on a caller's behalf, will not accept a Lead
demotion because one was suggested, and will not invent the evidence a demotion
requires.

The acceptance bindings — baseline digest, source identity digest, lane
decomposition digest, Canonical rules snapshot, reviewed revision — are computed
by the service from the inputs loaded right now, and a caller may not supply
them. An identity a caller can supply is an identity a caller can make
stale-proof, and the bindings exist precisely to catch a decision reviewed
against different inputs.

Intake never removes a note, quantizes source timing, performs Mobile
adaptation, assigns a role or emits Final MML.

## 10. Finalize

`final-service.mjs` calls `emitFinalMml` once. The emitter already owns the
order — readiness, micro-gap classification and enforcement, the optional
Technical Timing Repair, serialization, round-trip readback — and
re-implementing any step here would create a second Final policy.

**Technical Timing Repair stays an explicit opt-in.** `technical_timing_repair`
defaults to `false` and is passed through exactly as supplied. Asking this
service to finalize does not turn it on. There is no `auto` mode, and a value
other than `true`/`false` is refused rather than interpreted, because
introducing one would change what an existing `finalize` call means.

Readiness is evaluated twice from one set of inputs: before emission with no MML
to grade, and again afterwards with the emitted string re-validated under the
authoritative Final parser. The meter map for that re-validation comes from the
candidate's own meter events, never from a caller. Where the emitter passed and
the parser then disagreed, the post-emission readiness wins — two modules
contradicting each other is reported as the unsatisfied gate it is.

The artifact records the MML, the candidate and project identity, the Canonical
provenance, the readiness summary, the repair report, the round-trip report, the
warnings and the remaining pending gates. **Producing one does not make the song
VALIDATED and never implies `IN_GAME_ACCEPTED`.**

## 11. HTTP API

`/api/v1/*` is this repository's own interface, served by this process. It is
not a call to a third-party API.

```
GET    /api/v1/capabilities
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:project_id
GET    /api/v1/projects/:project_id/assets
POST   /api/v1/projects/:project_id/assets
GET    /api/v1/projects/:project_id/assets/:asset_id
GET    /api/v1/projects/:project_id/assets/:asset_id/content
POST   /api/v1/projects/:project_id/intake
POST   /api/v1/projects/:project_id/audio-alignment
POST   /api/v1/projects/:project_id/arrangement/suggest
POST   /api/v1/projects/:project_id/decisions
POST   /api/v1/projects/:project_id/confirmations
POST   /api/v1/projects/:project_id/review
POST   /api/v1/projects/:project_id/finalize
GET    /api/v1/projects/:project_id/jobs
GET    /api/v1/jobs/:job_id
GET    /api/v1/artifacts/:artifact_id
POST   /api/v1/technical/validate
POST   /api/v1/technical/overlaps
```

Everything is behind the existing OAuth check, evaluated before any owner
subject is derived.

## 12. MCP control surface

Ten `studio_*` tools, plus the three original tools unchanged:

`studio_capabilities`, `studio_project_create`, `studio_project_get`,
`studio_sources_analyze`, `studio_arrangement_suggest`, `studio_decisions_apply`,
`studio_audio_alignment`, `studio_candidate_review`, `studio_finalize`,
`studio_job_status`, `studio_artifact_get`.

Deliberately not one tool per backend function. A model reasons about a project,
a suggestion, a decision set, a review and an artifact — `midi-file.mjs`,
`role-candidates.mjs`, `readiness.mjs`, `technical-timing-repair.mjs` and
`mml-emitter.mjs` never cross this boundary, and a regression asserts it.

**MCP carries no bytes.** Every input is an identity, a small structured option
or short text. The 128 KiB body ceiling enforces it, a test proves the refusal,
and the server instructions tell an agent to upload over HTTP and pass the
`asset_id` back.

### Backward compatibility

`mml_service_info`, `mml_validate` and `mml_overlap_details` keep their names,
descriptions, schemas, annotations and exact report shape. A server with no
Application Service attached — the Sites worker — advertises exactly those
three, so its contract is untouched.

Their business logic moved into the Application Service's `technical-service.mjs`,
which the HTTP surface calls too, so there is one implementation. The MCP
transport binds its own instance of it for one reason: the report carries
`service_version`, which describes the service answering the call, not the
orchestration layer, and routing it through a differently-versioned application
would make one tool report two versions. The logic is identical either way.

## 13. Transport parity

The most important regression contract in this stage. For one fixture, walked
through the Application Service directly, over HTTP and over MCP, these must
agree: baseline identity, candidate identity, every gate axis, every blocker,
operation status, emitter status, the Final MML, the artifact contents, the
repair report and the Canonical provenance — and a blocked finalize must block
identically on all three.

Transport metadata, headers and JSON-RPC framing are of course not compared.

An `artifact_id` is deliberately *not* expected to match across transports: it is
content-addressed over a body naming the project it belongs to and when it was
produced. Equal artifact ids across separate projects would mean the identity had
stopped describing the artifact.

## 14. Authentication and ownership

The current model has exactly one principal: whoever holds the service password.
Every grant it issues represents the same person, so `railway/server.mjs` maps
every authenticated request to the constant subject `owner:service`. Deriving it
from a grant or client id would silently orphan a project the moment the owner
reconnected ChatGPT or added a second client.

The Application Service itself takes an arbitrary subject string and isolates
records by it. A future deployment with real multi-user identity changes one line
in the transport and nothing in the service.

Ownership is checked once, in `projects.load()`, which every other operation
reaches a project through — so a new operation cannot forget to ask.

A record belonging to another owner is reported **absent**, not forbidden.
Distinguishing "exists but forbidden" from "does not exist" is an existence
oracle over another owner's identifiers.

## 15. Cost model

**Additional recurring cost introduced: NONE.**

- No LLM API, key, SDK or provider dependency.
- No new database, object storage, queue, cache, vector store, CDN or monitoring
  service.
- No new domain, plan tier or paid serverless provider.
- Storage reuses the volume the existing Railway service already has.
- Jobs run in-process; no queue service is introduced.
- Tests make no network call and no paid API call.

One build-time addition: the deployment image now installs the single runtime
dependency already pinned in `package.json` (`fast-xml-parser@5.10.1`, exact,
with install scripts disabled). This is a build step, not a recurring charge.

## 16. Privacy and security boundary

Uploaded project assets are processed by this service and the existing Studio
backend only. The service reads no conversation history, fetches no unrelated
repository file, sends no song to a third-party LLM API and sends no audio to an
external analysis service.

Bounds and checks: body size limits on JSON, uploads and MCP payloads; a media
type allowlist; a per-project asset ceiling and a store quota; identifier shape
validation before any lookup; upload filenames never reflected into
`Content-Disposition`; `nosniff` and `no-store` on every response; prototype
pollution refused in MCP passthrough payloads; unexpected internal failures
rendered as a generic 500 with no message, path or stack.

## 17. Known limitations

1. **The deployed image's Canonical status is unverified.** The bootstrap reads
   the Manifest from `refs/remotes/origin/main` and the rule documents from the
   pinned snapshot, so the image carries `.git`. Whether Railway's build context
   provides a clone with that remote-tracking ref and full history has not been
   confirmed against the running service — doing so requires submitting the
   owner's service password in production. If it does not, the service still
   starts, still serves `/healthz` and still answers capability discovery,
   reporting `CANONICAL_NOT_LOADED` honestly; only the Canonical-aware
   operations are unavailable. **Verify `GET /api/v1/capabilities` on the
   deployed service before relying on it.**
2. **Jobs are synchronous.** Reported as `background_execution: false`. A very
   large score or a long alignment still occupies one request.
3. **Asset durability is whatever the operator declares.** With
   `MML_STUDIO_DATA_DIR` unset the store is in memory and says `ephemeral`; with
   it set, durability is reported as `persistent` only when the operator also
   sets `MML_STUDIO_DURABILITY=persistent`. Nothing here detects a real mount.
4. **Single owner.** One principal, one subject. Multi-user isolation is
   implemented in the service and unused by the transport.
5. **Audio alignment is attachment, not computation.** The alignment itself is
   produced by the existing Python audio worker, outside this process. This
   interface validates a report and attaches it as evidence; it does not invoke
   the worker.
6. **`mobile_adaptation` has no gate.** It stays `PENDING`.
7. **MusicXML intake needs the runtime dependency.** Without it the engines
   report `ENGINE_UNAVAILABLE` rather than degrading silently.
8. **MCP protocol modernization was not attempted.** The hand-written stateless
   Streamable HTTP implementation is unchanged. Adopting the official SDK is
   deliberately a separate change; doing it here would have made the diff a
   rewrite and put the parity contract at risk.
9. **One meter map per candidate.** Final re-validation derives the meter map
   from the candidate's meter events; a candidate declaring none skips
   re-validation and says so in `readiness_summary.technical_validation`.

## 18. Deferred

- Official MCP SDK adoption and protocol modernization.
- Real background job execution and cancellation.
- Multi-user authentication and per-user isolation at the transport.
- A Studio UI over the new API.
- Server-side invocation of the audio worker.
- Studio Web migration onto the Application Service.

## 19. Authority

This document is implementation notes. It defines no rule, publishes no Canonical
snapshot and closes no `PENDING` item. The Application Service, its transports,
its schemas and its tests are **implementers and verifiers**; they cannot define
or amend Canonical rules in reverse, and a passing test does not increase their
authority.

Published Canonical, loaded from `docs/CANONICAL_MANIFEST.md` on published
`main`, remains the only rule authority.
