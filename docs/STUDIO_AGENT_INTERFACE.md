# Studio Agent Interface v1 — implementation notes

Status: IMPLEMENTATION NOTES (not a Canonical rule source)
Implements: Published Canonical `2026-09-13-v1`, rules snapshot
`0a172900a01fdf39c2e9e84cf176961320b779ea`

This interface implements and exposes existing Published Canonical-aware Studio
capabilities. It does not define or modify Canonical rules. Where it states a
behaviour the published rule sources do not state, that behaviour is an
**implementer decision** and is chosen to be strictly narrower than the rule,
never wider.

## 0. Deployment topology: two planes, one Canonical

This interface adds an **Agent Control Plane**. It does not replace, migrate or
redefine the Permanent Studio Web/PWA deployment, which was separately built and
verified on 2026-09-14 and is untouched by this work.

```
                        Published Canonical
                   docs/CANONICAL_MANIFEST.md
                    + pinned rules snapshot
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
   Presentation / Web plane            Agent Control Plane
   mml-tools-studio-permanent          mml-tools-allen
   └─ studio-web-permanent             └─ mml-tools
      pinned release artifact             Application Service
      trust bundle + SHA256               HTTP /api/v1/*
      fail-closed verification            MCP /mcp
      durable verified cache              OAuth
      /studio-cache                       /data
              │                                   │
              └──── future integration ───────────┤
                         (follow-up)              ▼
                                        existing Studio backend
                                         studio/backend/**
```

| | Permanent Studio Web plane | Agent Control Plane |
| --- | --- | --- |
| Railway project | `mml-tools-studio-permanent` | `mml-tools-allen` |
| Service | `studio-web-permanent` | `mml-tools` |
| Serves | the Studio PWA | OAuth, `/mcp`, `/api/v1/*` |
| Release model | pinned artifact + trust bundle, SHA256-verified, atomically published | container image built from the repository |
| Volume | `/studio-cache` | `/data` |
| Volume holds | verified runtime-release bytes | project, asset, artifact and job records |
| Changed by this PR | **nothing** | the Application Service and its two adapters |

**Studio Web does not use the Application Service.** It reaches the same
`studio/backend/**` engines directly, in the browser, through its own Web
Worker. Migrating it onto this service is possible later and is follow-up work
(§18); this document never claims it has happened.

Both planes obey the same Published Canonical, and neither deployment defines
it. `ops/permanent/` is deployment evidence and operations material — useful
context, and **not** a Canonical authority.

### Storage responsibility

These two are never interchangeable and this PR moves nothing between them:

- **`/studio-cache`** — the Permanent Studio Web verified runtime-release cache.
  Release bytes, owned by `studio-web-permanent`. Never user song data. Nothing
  in the Agent Control Plane reads, writes, or knows about it.
- **`/data`** — the Agent backend's working storage. Project records, uploaded
  source assets, derived artifacts and job state, owned by `mml-tools`. Never
  the Studio Web release cache.

The private `studio-release-artifacts` bucket belongs to the release mechanism
and is **not** the Agent backend's upload store. No new bucket, volume,
database, queue or object store is introduced anywhere in this work.

## 1. What was missing

The Canonical-aware engines — source intake, score intake, voice decomposition,
role candidates, decision application, arbitration, version drift, readiness,
micro-gap enforcement, Technical Timing Repair, the Final MML emitter — all
existed, and were reachable from exactly one place: the browser workspace model,
behind a Web Worker. That is fine for the Web plane, which runs in a browser.

It left the Agent backend with nothing. `server/mcp.mjs` ran three read-only
tools on the legacy `dist/core.js` engine and never imported `studio/backend/**`
at all, so there was no server-side orchestration boundary: a second server
caller would have meant a second workflow, and a third would have meant a third.

That is the shape this stage removes, for server and agent callers.

```
ChatGPT · Claude · Codex · future models · local agents
                        │
            MCP adapter · HTTP adapter        server/{mcp,mcp-studio,api}.mjs
                        │
              Application Service             studio/backend/application/
                        │
              existing Studio backend         studio/backend/{source,score,mml,
                        │                      canonical,arrangement,arbitration,
                Published Canonical            compare,audio,final}
```

The arrows only point downward. The Application Service consumes the backend; it
re-implements no parser, no arrangement algorithm, no readiness gate, no repair
and no Final policy. The backend does not know the Application Service exists,
and neither layer knows which transport — or which model — is calling.

The Permanent Studio Web/PWA is not in this picture, deliberately: it reaches
the same backend engines directly in the browser, and this stage neither changes
nor routes it (§0).

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
- Storage reuses the `/data` volume the Agent backend service already has. The
  Permanent Studio Web plane's `/studio-cache` volume and its
  `studio-release-artifacts` bucket are untouched and are not used as agent
  storage.
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

1. **The deployed image's Canonical status depends on the build context's Git
   history, and cannot be confirmed from here.** See §20 for the audit, what it
   established, and the exact post-deploy check.
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
- **Studio Web migration onto the Application Service.** The Permanent Studio
  Web/PWA does not use this service today (§0). If it ever should, that is its
  own change, with its own review against the verified release mechanism — it is
  not started, implied or prepared for here.
- A preverified Canonical source for the Agent backend bootstrap, if its builder
  cannot supply Git history (§20). Authority would not change; only the Agent
  backend's loading implementation would.

## 19. Authority

This document is implementation notes. It defines no rule, publishes no Canonical
snapshot and closes no `PENDING` item. The Application Service, its transports,
its schemas and its tests are **implementers and verifiers**; they cannot define
or amend Canonical rules in reverse, and a passing test does not increase their
authority.

Published Canonical, loaded from `docs/CANONICAL_MANIFEST.md` on published
`main`, remains the only rule authority.

## 20. Agent backend image: Canonical bootstrap audit

**Scope: the Agent Control Plane only** — Railway project `mml-tools-allen`,
service `mml-tools`, built from `railway/Dockerfile`. This section describes the
Agent backend's v1 Canonical *loading implementation*. It is **not** the
Permanent Studio Web release architecture, and nothing in it applies to
`studio-web-permanent`, its pinned artifact, its trust bundle or `/studio-cache`.

Three related but distinct things, kept apart throughout:

| | What it is |
| --- | --- |
| Published Canonical **authority** | `docs/CANONICAL_MANIFEST.md` on published `main` plus the pinned rules snapshot. The sole authority for both planes. |
| Permanent Studio Web **release delivery** | Pinned verified artifact, trust bundle and durable cache. Untouched by this PR. |
| Agent backend **Canonical loading** | The repository bootstrap reading Git history inside the Agent backend image. What this section audits. |

Status: audit performed at `df0fe13`, without production credentials and
without any paid change. No Docker daemon was available, so the image
filesystem was materialised exactly as the `.dockerignore` allowlist and
`COPY . ./` produce it, dependencies were installed with the Dockerfile's own
`npm install --omit=dev --ignore-scripts`, and the real capability path was
executed inside it.

> **Superseded in part.** The risk this audit identified and could not confirm
> — a build context arriving without the published Git history — is what the
> merged deployment then hit. §20.1 below records the production failure and the
> fix. Everything in this section about *what the bootstrap requires* still
> holds; what changed is where that history comes from, and that a build which
> cannot load it no longer becomes a deployment.

### What the bootstrap actually requires

Reading the Manifest is not a file read. `loadPublishedCanonical` runs Git, and
needs all of:

1. a Git repository whose top level **is** the image root (`/app`);
2. `refs/remotes/origin/main`, resolved to one commit — the only discovery
   source, never a worktree or PR Manifest;
3. the blob `<published main>:docs/CANONICAL_MANIFEST.md`;
4. the rules snapshot commit `0a172900a01fdf39c2e9e84cf176961320b779ea` as a
   real object, plus every tree and blob the authority map names;
5. `git log -1 -- docs/CANONICAL_MANIFEST.md` over published main, for
   `manifest_commit`;
6. `git merge-base --is-ancestor <snapshot> <manifest commit>`.

`docs/` is deliberately **not** in the image's working tree. Every document is
read from Git objects, so the worktree copy would prove nothing.

### Result

With a build context carrying this repository's Git history, the simulated
image returns exactly the expected answer:

```
status=CANONICAL_LOADED
canonical_version=2026-09-13-v1
rules_snapshot_sha=0a172900a01fdf39c2e9e84cf176961320b779ea
manifest_commit=5e7666b850a37f1c85ee2dd8cd0f4fac037a9e14
published_main_head=e81a45b21f990872928bfcdf26c4a4fe1b40b7fd
repository_head=df0fe13dc7c07c66ed40389ac2d167d9b9714d87
```

Five separate identities, none standing in for another. The image layout,
allowlist, `git` install, `safe.directory` binding and dependency install are
therefore correct.

### The risk that remains

The load is a property of the **build context**, not of the Dockerfile. Three
contexts were simulated; each fails closed, reports `CANONICAL_NOT_LOADED`, and
takes no fallback:

| Context | `origin/main` | Snapshot commit | Result |
| --- | --- | --- | --- |
| No `.git` | — | — | `CANONICAL_NOT_LOADED` |
| `.git`, no remote-tracking ref | missing | present | `CANONICAL_NOT_LOADED` |
| Depth-1 clone of `main` | present | **missing** | `CANONICAL_NOT_LOADED` |

The third is the one to watch: a shallow clone is the common CI default, it
*does* create `refs/remotes/origin/main`, and it still fails because the
snapshot commit was truncated away. Shallowness alone is not the test — the
authoring sandbox for this change is itself a shallow clone that loads fine,
because its 168 retained commits happen to include the snapshot.

Whether the Agent backend's build context satisfies this **has not been
confirmed**, and cannot be from here: it would take either a Docker daemon or
the owner's service password in production. Neither was used, and neither was
guessed.

*(It did not. The build log of the merged deployment reported the first row of
that table — no `.git` at all. §20.1 records it, and the build no longer depends
on the context satisfying any of these.)*

### Post-deploy verification

Two checks, in order. Neither needs the service password.

**1. The build log.** Every build runs `railway/canonical-probe.sh` and prints:

```
[canonical-bootstrap] git-metadata: present | MISSING
[canonical-bootstrap] clone depth: complete | SHALLOW
[canonical-bootstrap] refs/remotes/origin/main: present | MISSING
[canonical-bootstrap] rules snapshot 0a172900…: present | MISSING
[canonical-bootstrap] status=CANONICAL_LOADED | CANONICAL_NOT_LOADED
[canonical-bootstrap] checkout_identity=git-checkout | materialized-published-main
[canonical-bootstrap] gate: PASS
```

The probe is a gate: anything other than `gate: PASS` fails the build. See §20.1
for the production failure that made it one. A running container that somehow had
no loadable Canonical would still serve `/healthz` and the three legacy technical
tools — that remains correct fail-closed runtime behaviour; what changed is that
such an image no longer gets built.

**2. The public root endpoint.**

```
curl -s https://<public-origin>/ | jq .canonical
```

Expect `status: "CANONICAL_LOADED"` and the identities, distinct, with
`checkout_identity` saying how `repository_head` was established (§20.1).
`canonical_notice` states the remedy when it is not loaded. `/healthz` is
deliberately **not** coupled to this: a Canonical problem must never fail
the Agent backend's healthcheck and roll back a deployment that is otherwise
serving.

### If it reports `CANONICAL_NOT_LOADED`

The probe line names which precondition failed.

- `git-metadata: MISSING` — the build context shipped no `.git`.
- `refs/remotes/origin/main: MISSING` — the checkout has no remote-tracking ref
  for the published branch.
- `rules snapshot …: MISSING` — history was truncated before the snapshot
  commit.

At the time of this audit all three were deployment-side, not code: the Agent
backend image needed a source checkout carrying this repository's history and
published ref. Nothing in the service may paper over it — forging
`refs/remotes/origin/main` from `HEAD` at build time would let any branch build
declare itself published Canonical, which is exactly the substitution the
bootstrap contract forbids, so it is **not** done, and still is not.

*(As of §20.1 the image obtains that history itself, from the published GitHub
repository, at build time. The prohibition above is unchanged and is precisely
what shapes how: the published SHA is captured from the published repository and
everything is read from that commit, never from `HEAD` or the build context.)*

If the Agent backend's builder cannot be made to supply that history, the
identified follow-up is the approach the clean public export already uses:
resolve the Canonical package in an environment that *can* load it and vendor it
into the image as `canonical/published.json` with
`distribution_mode: vendored-static`, alongside a static loader. That changes
the Agent backend's provenance model, so it is a decision for the project owner
rather than something to adopt silently here. It is a change to the Agent
backend's loading implementation only, and would not touch the Permanent Studio
release mechanism.

*(The builder could not be made to supply it. The vendored follow-up was **not**
taken — see §20.1.)*

## 20.1 The production failure, and the build-time materialization

**Scope: the Agent Control Plane only.** Nothing here touches
`studio-web-permanent`, its pinned artifact, its trust bundle or `/studio-cache`.
The Studio Web release identity is unchanged by this work: `buildId`, `cacheId`
and every hashed asset are byte-identical, because the build-time module is
excluded from the browser bundle and Git provenance was already outside
`buildId`.

### What happened

The merged deployment succeeded operationally — `/healthz` PASS, container start
PASS, Railway deployment status SUCCESS — and its own build log said:

```
[canonical-bootstrap] git-metadata: MISSING
[canonical-bootstrap] refs/remotes/origin/main: MISSING
[canonical-bootstrap] rules snapshot 0a172900a01fdf39c2e9e84cf176961320b779ea: MISSING
status=CANONICAL_NOT_LOADED
```

Railway's GitHub source snapshot delivers the repository's *files* and no `.git`,
so `COPY . ./` could not carry an object store however the allowlist was
written. That is the first defect. The second is that the probe exited 0 and the
image shipped: a green deployment whose every Canonical-aware operation refuses
is indistinguishable, to `/healthz`, to the deployment status and to the restart
policy, from a healthy one.

### What was not done

- The rules snapshot was **not** unpinned, and current `main` is never
  substituted for it.
- The working tree's Canonical documents were **not** copied into the image and
  called Published Canonical. `docs/` is still absent from the image.
- The Manifest was **not** hard-coded, and the vendored-static package above was
  **not** adopted: both replace publication discovery with a build-time constant,
  which is what §20's follow-up would have cost and why it needed an owner
  decision.
- The probe was **not** merely silenced.
- No `refs/remotes/origin/main` is manufactured from `HEAD`, from the build
  source commit, or from any branch the build happens to sit on.

### What was done

`studio/backend/bootstrap/materialize.mjs`, run once at image build by
`scripts/materialize-canonical.mjs`, makes the image's object store carry the
published history. In order:

1. `git ls-remote https://github.com/a91453/mml-tools refs/heads/main` — the
   published main identity is **captured first** and held for the rest of the
   build.
2. the published history is fetched, and the captured commit must be present in
   what arrived. `refs/remotes/origin/main` is set to the **captured** commit,
   never to the branch tip: a `main` that advances mid-build changes nothing, and
   one rewritten past the capture fails closed instead of being followed.
3. the Manifest is read from that same immutable commit, so the pinned
   `rules_snapshot_sha` cannot come from one `main` while the rules come from
   another.
4. the exact snapshot commit the Manifest names must resolve as a real object.
5. the **real loader** runs. Its answer, not the fetch's exit code, is the
   build's claim.

Every failure is terminal, and there is no mode in which an unreachable
published source becomes "use what is here". Availability selects nothing: the
step always contacts the published source it was given.

`railway/canonical-probe.sh` is now a gate. It fails the build unless the
capability path reports `CANONICAL_LOADED`, and reports an engine-import failure
as the separate defect it is rather than folding it into the Canonical signal.

### Provenance

The runtime loader is unchanged and still offline — local Git objects only, no
import of the build-time module — which is why the Canonical view stays pinned at
image build and why `/docs/CANONICAL_MANIFEST.md` must stay in the watch
patterns.

Its one addition is honesty about the checkout. A materialized image has no
checkout identity of its own, so HEAD is set to the captured published main head
and `repository_head` equals `published_main_head` *by construction*.
`checkout_identity` names that, because an equal pair that looks independently
verified would be a quieter lie than one that says how it came to be equal:

| Value | Meaning |
| --- | --- |
| `git-checkout` | HEAD came from a real checkout of this repository. |
| `materialized-published-main` | the source tree arrived without Git metadata; HEAD is the captured published main head. |

`build_source_head` carries the deploying platform's own record of the commit
that produced the source tree (`RAILWAY_GIT_COMMIT_SHA`), or `null` when it
supplied none. It is provenance and nothing else: it selects no Manifest, no
snapshot and no rule document. A bootstrap record that disagrees with the Git
identities a load already resolved fails closed rather than being ignored.

### Verification

`tests/railway-canonical-image.test.mjs` builds the image filesystem exactly as
the allowlist and `COPY . ./` produce it — with `.git` withheld, which is what
Railway does — and runs the Dockerfile's two steps against it, proving
`CANONICAL_LOADED` with the exact published identities, and proving the gate
refuses the merged deployment's own image.
`studio/tests/bootstrap-materialize.test.mjs` covers capture-before-read
ordering against a `main` that moves mid-build, snapshot exactness against a
`main` carrying substituted rule bytes, every unprovable step failing closed, and
`ENGINE_UNAVAILABLE` staying distinct from `CANONICAL_NOT_LOADED`. The published
source in both is a real Git repository reached over `file://`, so ordinary CI
never depends on a live GitHub fetch.

No paid service, database, queue, object store, domain or LLM dependency is
added.

### The Agent backend's Canonical view is pinned at image build

`.git` is copied into the image at build time and nothing fetches at runtime, so
`refs/remotes/origin/main` inside a running container resolves to whatever
`main` was when the image was built. A running Agent backend therefore reports
the `published_main_head` of its build, not of `main` right now.

That is safe — it is a pinned, reproducible view, and the snapshot it loads is
immutable — but it has one operational consequence: **publishing a new Canonical
release does not reach the Agent backend until the image is rebuilt.** The
deployment watch patterns must therefore include `docs/CANONICAL_MANIFEST.md`,
so a Canonical publication triggers a rebuild rather than leaving the backend
silently serving an obsolete Manifest view.

The Canonical rule sources are deliberately **not** watched. They are read from
the immutable rules snapshot the Manifest pins, never from `main`, so editing
one cannot change what this service loads and watching it would force rebuilds
that change nothing. Only a Manifest that selects a different snapshot can move
the Agent backend's Canonical view, which is exactly the file that is watched.
See `railway/README.md` for the exact set.

An operator can check for drift without credentials by comparing the
`canonical.published_main_head` reported by the Agent backend's public root
endpoint against the current `main`.

Until then the behaviour is honest and safe: the legacy technical tools keep
working, and every Canonical-aware operation refuses.
