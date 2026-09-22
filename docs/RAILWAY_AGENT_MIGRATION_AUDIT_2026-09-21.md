# Railway Agent migration audit — 2026-09-21

Status: Railway Agent migration and migration-only resource retirement complete. This document is not a Canonical rule source.

## Scope

Repository: `a91453/mml-tools`

Implementation branch: `chore/railway-agent-migration-20260921`

Final cleanup branch: `chore/retire-railway-migration-resources` / PR #53

Implementation PRs: #51 merged; #52 merged. First authenticated production audit run `35674909732` passed control-plane, config-drift, health and provenance checks on 2026-09-22.

This audit separates three concerns that were previously easy to conflate:

1. **Railway runtime hosting** — public HTTPS services, volumes, domains and the release bucket.
2. **Railway Agent** — Railway's token-billed AI agent used for infrastructure inspection, diagnosis and mutation.
3. **Repository automation / coding agents** — GitHub Actions and Claude/Codex-style coding sessions that can operate from versioned scripts and PRs.

The migration target is Railway **Agent work**, not necessarily Railway **runtime hosting**.

## Cross-agent prohibition

Repository policy is now stricter than the original migration target: Railway runtime hosting remains, but Railway Agent itself is prohibited for repository work.

The prohibition applies to ChatGPT, Codex, Claude Code, subagents, routines and other automation. Enforcement lives in `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `docs/RAILWAY_AGENT_POLICY.md`, and the CI regression `tests/railway-agent-policy.test.mjs`.

Deterministic Railway API/CLI operations, repository scripts and GitHub Actions remain allowed. If a deterministic operation is unavailable or requires interactive 2FA, the owner performs the exact Dashboard action manually; agents must not fall back to Railway Agent.

Because an external client can exist outside repository instruction loading, the Railway workspace Agent hard usage limit of `$0` is the final cross-client billing guard.


## Retirement verification checkpoint — 2026-09-22

Before deleting any migration-only Railway resource, the durable Studio rollback path was re-verified against `ops/permanent/README.md`, `ops/permanent/MIGRATION_RESULT.md`, and the live Railway inventory.

- Production rollback targets `studio-web-permanent` service `311e2f06-bad4-415c-b020-d52e1a6bf064`, historical deployment `f9a9bd99-4809-4a3b-8612-07b96c196d4a`, and production volume `fba8d8a3-0c88-4f9b-b2a4-54a772217388`.
- The historical cache used for rollback is retained on the production `/studio-cache` volume; rollback does not reference the isolated service or isolated volume.
- `studio-release-artifacts` bucket `e3ff79a7-f493-4436-894d-b166dfb97ab9` is the durable recovery source and is explicitly independent of both production and isolated volumes.
- The operations runbook states that no isolated/temporary service URL is a permanent runtime source.
- Therefore `studio-durable-isolated` service `2343a428-d442-4c3d-99cc-a3c2d690578d` and its dedicated volume `a75fd368-2dcc-4e4f-8637-f242d3c2738d` are not required for production rollback or durable recovery.
- `charismatic-reverence` project `181279f2-d244-4ced-9a74-2474b923ab58` has no domains, variables, or volumes, shows zero CPU/RAM usage over the last 24 hours, and its only service continues to fail deployments from `main`; no repository reference identifies it as an intended runtime.

This checkpoint authorizes only the migration-resource retirement described above. It does **not** authorize deletion of `studio-web-permanent`, its production volume, the durable release bucket, Git history/assets, or historical rollback evidence.

## Resource-retirement execution status — 2026-09-22

The owner explicitly authorized deletion of the migration-only resources after rollback verification. Railway dashboard 2FA was used where the API/MCP destructive gate required interactive approval.

### Completed cleanup

- `charismatic-reverence` service was removed, then the empty project was deleted from Railway Project Settings. A direct lookup by project id `181279f2-d244-4ced-9a74-2474b923ab58` now returns `Project not found`. A workspace project-list response may remain eventually consistent briefly after deletion, but the project is no longer addressable.
- `studio-durable-isolated` service `2343a428-d442-4c3d-99cc-a3c2d690578d` was deleted.
- Its dedicated cache volume `a75fd368-2dcc-4e4f-8637-f242d3c2738d` was deleted.
- `mml-tools-allen` preview environments `preview-base` and `mml-tools-pr-53` were deleted. Live project inventory now contains only the `production` environment.
- The PR-environment enable/disable toggle is dashboard-only and is not readable through the connected Railway API; current live inventory verifies that no preview environment remains.

### Protected production resources verified after cleanup

- `mml-tools-allen / production / mml-tools` remains on successful deployment `446fec19-4cb9-4381-aff5-f4c76671599f`.
- Production `/data` volume `e90e0f81-854e-467c-9ab0-5be246118708` remains mounted at 5000 MB.
- Production domain `mml-tools-production.up.railway.app` remains attached.
- `studio-web-permanent` service `311e2f06-bad4-415c-b020-d52e1a6bf064` remains on successful deployment `9ddaad2c-fc64-4822-a011-3924e3aae629`.
- Permanent Studio production volume `fba8d8a3-0c88-4f9b-b2a4-54a772217388` remains mounted at `/studio-cache`.
- Durable release bucket `e3ff79a7-f493-4436-894d-b166dfb97ab9` remains present.
- Permanent Studio domain `studio-web-permanent-production.up.railway.app` remains attached.
- No destructive cleanup touched the historical rollback evidence or production rollback path.

The migration-resource retirement is therefore complete.

## Observed live Railway inventory

### Keep under the current architecture

| Project / service | Observed role | Why Railway is still serving a runtime purpose |
| --- | --- | --- |
| `mml-tools-allen / mml-tools` | Agent Control Plane / MCP + Studio service | Public HTTPS domain, OAuth/MCP transport, persistent `/data` volume, one production replica, GitHub-main source deployment with check suites enabled |
| `mml-tools-studio-permanent / studio-web-permanent` | Permanent Studio Web runtime | Public HTTPS domain, verified durable bootstrap, persistent `/studio-cache` volume, private release-bucket recovery path |
| `mml-tools-studio-permanent / studio-release-artifacts` | Durable release object bucket | Production permanent bootstrap recovery source under the current design |

Keeping these runtime resources does **not** require routine Railway Agent usage.

### Retired migration-only resources

| Resource | Final status |
| --- | --- |
| `mml-tools-studio-permanent / studio-durable-isolated` | Deleted after rollback verification; dedicated isolated cache volume deleted with it |
| `charismatic-reverence` | Deleted after its only service was removed |
| `mml-tools-allen / preview-base` | Deleted; production preserved |
| `mml-tools-allen / mml-tools-pr-53` | Deleted; production preserved |

During the original implementation checkpoint, only production watchPatterns were changed through the deterministic Railway service API and no redeploy was triggered. The later cleanup removed only the explicitly authorized migration/preview resources listed above.

## Implementation checkpoint on this branch

Completed without Railway Agent:

- added `scripts/railway-production-audit.mjs`, a read-only Railway GraphQL + public HTTPS provenance verifier;
- added `.github/workflows/railway-production-audit.yml` as an explicit post-deploy/manual audit; it is intentionally **not** a `main push` check because production Railway has Wait for CI enabled and a check that waits for Railway would create a deployment cycle;
- added `scripts/railway-production-config-apply.mjs` and a manual `production` environment workflow that can apply only an explicit allowlist of repository-desired ServiceInstance settings;
- the write workflow cannot mutate variables/secrets, domains, volumes, source repo/branch, regions/replica scaling, or trigger a deployment;
- added regression tests for token/error redaction, read-only GraphQL behavior, exact-SHA deployment binding, watch-pattern drift, effective-default normalization and the config-apply allowlist;
- added sanitized, bounded FAILED/CRASHED deployment diagnostics for build/runtime logs, with no HTTP request logs or variable reads; the audit attaches them only when the matched deployment actually failed;
- directly repaired the live production watch-pattern drift through the deterministic Railway service API: `/server/studio-agent-driver.mjs` and `/server/studio-agent-codex.mjs` are now present; no Railway Agent and no redeploy were used;
- readback confirmed the existing successful deployment remained `5edd2414dbe73c892857fe375084af099fc0e05e`;
- corrected the repository's stale volume observation from 500 MB to the current Railway control-plane readback of 5000 MB. No volume resize was performed.

GitHub Actions secret `RAILWAY_PROJECT_TOKEN` is configured with the production-scoped Railway project token. Authenticated production audit run `35674909732` passed control-plane, public provenance/health probe, and config-drift verification with drift count 0.

The apply workflow references the GitHub Environment `production`. Configure required reviewers on that Environment if approval-gated production writes are desired. The script-side confirmation and mutation allowlist remain enforced independently of Environment protection.

## Railway Agent work that should move completely

| Current class of work | Replacement | Railway Agent needed afterward? |
| --- | --- | --- |
| List projects/services/environments/deployments | Deterministic Railway API/CLI script, invoked locally or by GitHub Actions | No |
| Read service config, domains, logs and metrics | Read-only script + uploaded/redacted Actions evidence; Claude Code interprets failures when needed | No |
| Check deployment source SHA/status after merge | GitHub Actions post-deploy verification | No |
| Run public `/healthz` / `/health` / production provenance probes | GitHub Actions | No |
| Compare live watch patterns/config against repository desired state | GitHub Actions drift check | No |
| Apply approved watch-pattern/start/healthcheck config changes | Versioned deployment script + protected `workflow_dispatch` / environment approval | No |
| Diagnose failed deploys | Capture Railway build/runtime logs deterministically; Claude Code analyzes them and opens a normal PR for code fixes | No |
| Build/test container before production deploy | Already covered by `.github/workflows/studio-service-ci.yml` | No |
| Build/test symbolic, browser and audio paths | Already covered by `.github/workflows/studio-ci.yml` and OSS CI | No |
| Build/package/publish durable Studio release | Already implemented in `.github/workflows/studio-durable-release.yml` | No |
| Repository code changes and PR preparation | Claude Code / coding agent in a real Git checkout, with normal branch/checkpoint/PR flow | No |

## What should not become an unattended Action

The following should remain explicitly approved operations even after Railway Agent is removed from the normal path:

- first-time or rotated secret values;
- destructive project/service/volume/bucket deletion;
- production rollback to a historical snapshot;
- domain/OAuth cutover;
- any migration that changes persistence semantics.

They can still use scripts or Claude Code, but should require an explicit operator action and, where appropriate, a protected GitHub Environment approval.

## Existing GitHub Actions coverage

The repository already has the expensive verification work in GitHub Actions:

- `Studio CI`: symbolic, audio-worker and Studio Web/browser jobs;
- `Studio service CI`: browser/service integration plus a build of the real Railway Docker image and container smoke test;
- `OSS Export CI`: three export regression jobs;
- durable bootstrap/release workflows.

The latest reviewed PR inspected during this audit had **8 CI jobs** across the three main PR workflows. Therefore the proposed Railway-Agent migration should add only lightweight operations/drift/probe jobs rather than duplicate the existing browser/container suites.

## Recommended target flow

```text
Claude Code
  -> branch / code / tests / checkpoint commits
  -> PR
  -> existing GitHub Actions CI
  -> merge to main
  -> existing GitHub Actions CI
  -> Railway Wait-for-CI releases the native source deployment
  -> explicit post-deploy audit (or a future deployment-complete webhook trigger)
  -> health + provenance + config-drift probes
  -> evidence artifact / PR or commit status

Only on an exceptional failure:
  -> deterministic logs/config evidence
  -> Claude Code diagnosis
  -> ordinary fix PR

Railway Agent:
  -> PROHIBITED for this repository
  -> no inspection, diagnosis, mutation, deployment, cleanup or recovery fallback
```

The key design choice is to **keep Railway as a runtime platform while removing Railway Agent as the normal control plane**.

## Agent-usage savings estimate

Railway documents Railway Agent as token-billed at the underlying Anthropic model rates. There is no fixed per-operation price, so exact savings depend on prompt/context size and which model Railway routes each request to.

For this repository, essentially all recurring Railway-Agent activities identified above are replaceable. A reasonable target is:

- target **100% elimination of Railway Agent spend** for repository work;
- routine monthly Railway Agent usage attributable to this repository should be **$0**;
- Railway Agent is not retained as an emergency fallback; unsupported operations are handed to the owner for explicit Dashboard execution.

This estimate is intentionally not a billing claim. The Railway Usage page is the source for the measured current-period number.

## GitHub Actions cost impact

The repo is private, so GitHub-hosted runner minutes count against the owner's included Actions allowance. The proposed operations jobs are light compared with the existing browser/container CI.

Design them to:

- run only after relevant merges or via `workflow_dispatch`;
- use path filters;
- avoid re-running browser/container suites;
- use a small Linux runner where possible;
- upload only bounded redacted evidence;
- cancel superseded non-deployment checks.

Even outside included minutes, a few minutes of Linux runner time per deployment is normally far below the token cost of repeated infrastructure-agent conversations.

## Implementation order

1. **DONE on PR #51:** add read-only Railway inventory/config/deployment/probe scripts.
2. **DONE on PR #51:** add an explicit post-deploy Actions drift/probe workflow; deliberately avoid a `main push` trigger because Railway Wait for CI would otherwise wait on a workflow that is itself waiting on Railway.
3. **DONE on PR #51:** add protected manual config-apply workflow only for bounded desired-state changes; it never deploys.
4. **DONE on PR #51:** add deterministic sanitized log collection for FAILED/CRASHED deployments.
5. **DONE:** token setup and authenticated production audit passed; normal failure analysis can use collected evidence with Claude Code / normal PRs and does not require Railway Agent.
6. **POLICY:** Railway Agent is prohibited for ChatGPT, Codex, Claude Code and other agents working on this repository. Keep the Railway Agent hard usage limit at $0 as the cross-client billing backstop.
7. **DONE:** rollback dependency was verified, then `studio-durable-isolated`, its isolated cache volume, `charismatic-reverence`, and the remaining preview environments were retired while production resources were preserved.

