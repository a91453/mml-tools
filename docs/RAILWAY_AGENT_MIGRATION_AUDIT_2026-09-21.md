# Railway Agent migration audit — 2026-09-21

Status: Railway Agent migration complete; migration-only resource retirement is staged and awaiting Railway dashboard 2FA. This document is not a Canonical rule source.

## Scope

Repository: `a91453/mml-tools`

Working branch: `chore/railway-agent-migration-20260921`

Implementation PRs: #51 merged; #52 merged. First authenticated production audit run `35674909732` passed control-plane, config-drift, health and provenance checks on 2026-09-22.

This audit separates three concerns that were previously easy to conflate:

1. **Railway runtime hosting** — public HTTPS services, volumes, domains and the release bucket.
2. **Railway Agent** — Railway's token-billed AI agent used for infrastructure inspection, diagnosis and mutation.
3. **Repository automation / coding agents** — GitHub Actions and Claude/Codex-style coding sessions that can operate from versioned scripts and PRs.

The migration target is Railway **Agent work**, not necessarily Railway **runtime hosting**.

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

The owner explicitly authorized deletion of the migration-only resources after rollback verification.

### `charismatic-reverence`

- Project: `181279f2-d244-4ced-9a74-2474b923ab58`
- Only service: `mml-tools` / `a32be357-1f65-4675-821c-656fd14726a1`
- Service removal is staged in production patch `4f137573-68a3-4486-b019-86e610ba814b`.
- Railway requires interactive 2FA to Apply this destructive patch; API/MCP commit attempts were rejected by that gate.
- Railway's available API/MCP surface cannot delete the now-unneeded project/environment itself. After the service-removal patch is applied, the empty project must be deleted from Railway project settings.

### `studio-durable-isolated`

- Service: `2343a428-d442-4c3d-99cc-a3c2d690578d`
- Dedicated cache volume: `a75fd368-2dcc-4e4f-8637-f242d3c2738d`
- Both removals are staged together in production patch `cf388d20-0041-4a3d-ac93-96677652ed98`.
- Railway requires interactive 2FA to Apply this destructive patch; API/MCP commit attempts were rejected by that gate.
- The staged patch contains exactly two resource changes: the isolated service and its dedicated volume.
- `studio-web-permanent`, production volume `fba8d8a3-0c88-4f9b-b2a4-54a772217388`, durable bucket `e3ff79a7-f493-4436-894d-b166dfb97ab9`, and historical rollback deployments remain unchanged.

This PR remains a cleanup record until the dashboard 2FA applies are completed and a post-delete readback confirms the protected resources are intact.

## Observed live Railway inventory

### Keep under the current architecture

| Project / service | Observed role | Why Railway is still serving a runtime purpose |
| --- | --- | --- |
| `mml-tools-allen / mml-tools` | Agent Control Plane / MCP + Studio service | Public HTTPS domain, OAuth/MCP transport, persistent `/data` volume, one production replica, GitHub-main source deployment with check suites enabled |
| `mml-tools-studio-permanent / studio-web-permanent` | Permanent Studio Web runtime | Public HTTPS domain, verified durable bootstrap, persistent `/studio-cache` volume, private release-bucket recovery path |
| `mml-tools-studio-permanent / studio-release-artifacts` | Durable release object bucket | Production permanent bootstrap recovery source under the current design |

Keeping these runtime resources does **not** require routine Railway Agent usage.

### Candidates to retire

| Resource | Observation | Recommendation |
| --- | --- | --- |
| `mml-tools-studio-permanent / studio-durable-isolated` | Separate isolated migration-validation service, one `/studio-cache` volume; ops documentation records the production migration as passed | Preserve evidence first, then remove/disable the isolated service and its dedicated cache if no rollback procedure still requires it |
| `charismatic-reverence / mml-tools` | Created 2026-09-21, no domain, no variables, no volume, no start command, latest deployments failed while following `main` | Treat as likely temporary/accidental; confirm no intended consumer, then delete the project |

No resource was deleted. During the implementation checkpoint below, only the production service watchPatterns were changed, through the deterministic Railway service API and without a redeploy.

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

One external setup item remains before the new Actions can query/mutate Railway themselves: add a GitHub Actions secret named `RAILWAY_PROJECT_TOKEN` containing a **Railway project token scoped only to `mml-tools-allen / production`**. Do not use an account token. The explicitly dispatched audit/apply/diagnostics workflows fail closed when it is absent.

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
  -> emergency/manual fallback only
```

The key design choice is to **keep Railway as a runtime platform while removing Railway Agent as the normal control plane**.

## Agent-usage savings estimate

Railway documents Railway Agent as token-billed at the underlying Anthropic model rates. There is no fixed per-operation price, so exact savings depend on prompt/context size and which model Railway routes each request to.

For this repository, essentially all recurring Railway-Agent activities identified above are replaceable. A reasonable target is:

- **80–95% reduction in Railway Agent spend**;
- routine monthly Railway Agent usage should approach **$0–$5**, with usage reserved for genuine emergency investigation;
- if the current monthly Railway Agent line item is approximately **$30**, the corresponding rough saving is **$24–$29/month**.

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
5. After merge/token setup, use the collected evidence for Claude Code / normal PR failure analysis; no Railway Agent is required for the normal path.
6. After an observation period, set Railway Agent hard limit low and keep it as emergency fallback.
7. Separately confirm and retire `studio-durable-isolated` and `charismatic-reverence` if they are no longer needed.

