# CLAUDE.md

## Mandatory Railway Agent prohibition

Railway Agent is disabled for this repository.

Claude Code, Claude Desktop Code, Claude Agent SDK, subagents, routines, and MCP-connected Claude sessions MUST NOT invoke or delegate to Railway Agent through any surface, including:

- `railway agent`;
- Railway Dashboard Agent;
- `railway_agent` / `mcp__Railway__railway_agent`;
- any wrapper or fallback that causes Railway Agent to inspect, diagnose, mutate, deploy, clean up, recover, or edit code.

Use deterministic Railway API/CLI operations, repository scripts, and GitHub Actions. When an operation is unsupported or requires interactive 2FA, stop and give the owner exact Railway Dashboard steps instead of calling Railway Agent.

Read `docs/RAILWAY_AGENT_POLICY.md` before Railway infrastructure work.

Project `.claude/settings.json` contains tool-level deny rules. Do not remove, bypass, or weaken them unless the repository owner explicitly requests a dedicated policy change.

This is an operations policy, not a Mabinogi Mobile MML Canonical rule source.
