# Railway Agent prohibition policy

Status: repository operations policy. This is **not** a Mabinogi Mobile MML Canonical rule source.

## Mandatory rule

Railway Agent is disabled for work on this repository.

This rule applies to every human-operated or automated coding assistant, including:

- ChatGPT and ChatGPT connectors/tools;
- OpenAI Codex / Codex CLI / Codex cloud tasks;
- Claude Code / Claude Desktop Code / Claude Agent SDK;
- GitHub or other coding agents, subagents, routines, MCP clients, and future automation.

They MUST NOT invoke, delegate to, resume, or fall back to Railway's AI Agent for any task.

Prohibited surfaces include, but are not limited to:

- Railway Dashboard Agent chat;
- Railway CLI command `railway agent`;
- Railway MCP / connector tool `railway_agent` (including normalized names such as `mcp__Railway__railway_agent`);
- wrappers, scripts, subagents, routines, or API calls whose purpose is to cause Railway Agent to perform inspection, diagnosis, mutation, deployment, cleanup, recovery, or code changes.

A task being difficult, urgent, destructive, or unsupported by a deterministic API does **not** create an exception.

## Allowed Railway operations

Use deterministic mechanisms instead:

1. repository scripts and GitHub Actions;
2. direct Railway API/MCP tools that perform a specific non-Agent operation;
3. Railway CLI commands other than `railway agent`;
4. direct HTTP health/provenance probes;
5. explicit Railway Dashboard actions performed by the owner when an API operation is unavailable or interactive 2FA is required.

If the requested operation cannot be completed without Railway Agent, STOP that part of the operation and hand it to the owner with the exact Dashboard steps. Do not ask Railway Agent how to do it.

## Billing enforcement boundary

Repository instructions can constrain agents that load this repository, but they cannot technically prevent an external ChatGPT connector, browser session, or other client from invoking Railway Agent if that client ignores repository instructions.

Therefore the account/workspace billing backstop should be:

```text
Railway Agent hard usage limit = $0
```

That hard limit is the cross-client enforcement boundary. It blocks Agent spend without shutting down normal Railway production compute.

## Agent-specific enforcement

### Codex

Root `AGENTS.md` carries this prohibition because Codex loads repository `AGENTS.md` instructions before work. Repo-local `.codex/rules/railway-agent.rules` additionally marks direct `railway agent` and `npx railway agent` shell dispatch as `forbidden` when the project Codex configuration layer is trusted.

### Claude Code

Root `CLAUDE.md` carries the same prohibition. `.claude/settings.json` also denies the Railway Agent MCP tool and the direct `railway agent` shell command. Deny rules are intentional and must not be weakened to make a task easier.

### ChatGPT

ChatGPT sessions working on this repository must follow this policy when it is available in context. Because repository files alone are not a guaranteed tool-level sandbox for every ChatGPT connector surface, the Railway Agent hard limit remains required for a true billing guard.

## Change control

Do not remove, weaken, bypass, rename around, or add an alternate Railway-Agent dispatch path unless the repository owner explicitly requests a dedicated policy change.

An ordinary request to inspect, deploy, diagnose, fix, or clean up Railway infrastructure is **not** permission to change this policy.

