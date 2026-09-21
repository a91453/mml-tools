# Railway Agent migration audit — 2026-09-21

Status: operational audit / migration plan. This document is not a Canonical rule source and changes no production service.

## Scope

Repository: `a91453/mml-tools`

Working branch: `chore/railway-agent-migration-20260921`

Pull request: #51 (ready for CI/review; not merged)

This audit separates three concerns that were previously easy to conflate:

1. **Railway runtime hosting** — public HTTPS services, volumes, domains and the release bucket.
2. **Railway Agent** — Railway's token-billed AI agent used for infrastructure inspection, diagnosis and mutation.
3. **Repository automation / coding agents** — GitHub Actions and Claude/Codex-style coding sessions that can operate from versioned scripts and PRs.

The migration target is Railway **Agent work**, not necessarily Railway **runtime hosting**.

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

No resource was deleted or reconfigured during this audit.

## Implementation checkpoint on this branch

Completed without Railway Agent:

- added `scripts/railway-production-audit.mjs`, a read-only Railway GraphQL + public HTTPS provenance verifier;
- added `.github/workflows/railway-production-audit.yml`, which can run manually and automatically after production-deployable `main` path changes;
- added `scripts/railway-production-config-apply.mjs` and a manual `production` environment workflow that can apply only an explicit allowlist of repository-desired ServiceInstance settings;
- the write workflow cannot mutate variables/secrets, domains, volumes, source repo/branch, regions/replica scaling, or trigger a deployment;
- added regression tests for token/error redaction, read-only GraphQL behavior, exact-SHA deployment binding, watch-pattern drift, effective-default normalization and the config-apply allowlist;
- directly repaired the live production watch-pattern drift through the deterministic Railway service API: `/server/studio-agent-driver.mjs` and `/server/studio-agent-codex.mjs` are now present; no Railway Agent and no redeploy were used;
- readback confirmed the existing successful deployment remained `5edd2414dbe73c892857fe375084af099fc0e05e`;
- corrected the repository's stale volume observation from 500 MB to the current Railway control-plane readback of 5000 MB. No volume resize was performed.

One external setup item remains before the new Actions can query/mutate Railway themselves: add a GitHub Actions secret named `RAILWAY_PROJECT_TOKEN` containing a **Railway project token scoped only to `mml-tools-allen / production`**. Do not use an account token. Automatic push audits deliberately warn-and-skip until the token exists; an explicitly dispatched audit/apply fails closed when it is absent.

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
  -> Railway native source deployment (or a small explicit deploy Action)
  -> GitHub Action waits/polls deterministic deployment status
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

1. Add read-only Railway inventory/config/deployment/probe scripts.
2. Add an Actions drift/probe workflow with no write permission to Railway.
3. Add protected manual deployment/config-apply workflow only for desired-state changes.
4. Add deterministic log collection for failed deployments.
5. Move failure analysis to Claude Code / normal PRs.
6. After an observation period, set Railway Agent hard limit low and keep it as emergency fallback.
7. Separately confirm and retire `studio-durable-isolated` and `charismatic-reverence` if they are no longer needed.

