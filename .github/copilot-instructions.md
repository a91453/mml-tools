# GitHub Copilot repository instructions

This repository prohibits delegated AI-agent chaining.

When GitHub Copilot is used directly in this repository:

- never invoke or delegate to Railway Agent;
- never invoke another GitHub Copilot agent/session as a secondary worker;
- never hand work to ChatGPT, Codex, Claude Code, or another external AI agent;
- do not use `railway agent`, Railway Dashboard Agent, or any MCP/connector tool named `railway_agent` / `mcp__Railway__railway_agent`;
- use deterministic Railway API/CLI operations, repository scripts, and GitHub Actions instead;
- if an operation requires Dashboard-only interaction or interactive 2FA, stop and give the owner the exact manual steps rather than delegating to another AI.

Read `docs/RAILWAY_AGENT_POLICY.md` before Railway infrastructure work.

Do not weaken or remove these restrictions unless the repository owner explicitly requests a dedicated policy change.

This is an operations policy, not a Mabinogi Mobile MML Canonical rule source.
