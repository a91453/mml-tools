# AGENTS.md

## Railway Agent is prohibited

For this repository, **never invoke Railway Agent and never delegate work to GitHub Copilot**.

This applies to Codex, ChatGPT, Claude Code, subagents, MCP clients, routines, and any other automated agent operating on the repository.

Do not use or delegate to:

- GitHub Copilot / Copilot CLI / Copilot cloud agent as a secondary agent;
- `railway agent`;
- Railway Dashboard Agent;
- Railway MCP / connector `railway_agent` tools, including `mcp__Railway__railway_agent`;
- wrappers or fallback flows that cause Railway Agent to act.

Use deterministic Railway API/CLI operations, repository scripts, and GitHub Actions instead. If an operation requires Dashboard-only interaction or 2FA, stop that operation and give the owner the exact manual steps. **Never fall back to Railway Agent.**

Before any Railway infrastructure work, read `docs/RAILWAY_AGENT_POLICY.md`.

Do not weaken or remove this guard unless the repository owner explicitly requests a dedicated policy change. A normal Railway task does not override this rule.

This file is an operations instruction for coding agents; it is not a Mabinogi Mobile MML Canonical rule source.
