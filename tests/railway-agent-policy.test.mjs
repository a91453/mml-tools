import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function walk(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [path];
  return readdirSync(absolute).flatMap((entry) => walk(join(path, entry)));
}

test('cross-agent Railway Agent policy entry points are present', () => {
  for (const path of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'docs/RAILWAY_AGENT_POLICY.md']) {
    const content = read(path);
    assert.match(content, /Railway Agent/i, `${path} must name the prohibited service`);
    assert.match(content, /never|prohibit|disabled|MUST NOT/i, `${path} must state a prohibition`);
    assert.match(content, /deterministic/i, `${path} must point agents to deterministic operations`);
  }

  const agents = read('AGENTS.md');
  assert.match(agents, /Codex/i);
  assert.match(agents, /ChatGPT/i);
  assert.match(agents, /Claude Code/i);
  assert.match(agents, /GitHub Copilot/i);
});

test('delegated GitHub Copilot CLI is denied for Codex and Claude', () => {
  const rules = read('.codex/rules/railway-agent.rules');
  assert.match(rules, /pattern\s*=\s*\["gh",\s*"copilot"\]/);
  assert.match(rules, /pattern\s*=\s*\["copilot"\]/);

  const settings = JSON.parse(read('.claude/settings.json'));
  const deny = settings?.permissions?.deny ?? [];
  for (const rule of ['Bash(gh copilot)', 'Bash(gh copilot *)', 'Bash(copilot)', 'Bash(copilot *)']) {
    assert.ok(deny.includes(rule), `missing Claude Copilot deny rule: ${rule}`);
  }
});

test('Codex forbids Railway Agent CLI dispatch', () => {
  const rules = read('.codex/rules/railway-agent.rules');
  assert.match(rules, /pattern\s*=\s*\["railway",\s*"agent"\]/);
  assert.match(rules, /pattern\s*=\s*\["npx",\s*"railway",\s*"agent"\]/);
  assert.equal((rules.match(/decision\s*=\s*"forbidden"/g) ?? []).length, 2);
});

test('Claude Code denies Railway Agent MCP and CLI surfaces', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  const deny = settings?.permissions?.deny;
  assert.ok(Array.isArray(deny), '.claude/settings.json permissions.deny must be an array');

  for (const rule of [
    'mcp__Railway__railway_agent',
    'mcp__railway__railway_agent',
    'Bash(railway agent)',
    'Bash(railway agent *)',
    'Bash(npx railway agent)',
    'Bash(npx railway agent *)',
  ]) {
    assert.ok(deny.includes(rule), `missing Claude deny rule: ${rule}`);
  }
});

test('repository automation does not dispatch Railway Agent', () => {
  const candidateFiles = [
    ...walk('.github/workflows'),
    ...walk('scripts'),
    ...walk('server'),
    ...walk('railway'),
    ...walk('studio'),
    'package.json',
  ].filter((path) => {
    if (!existsSync(join(root, path))) return false;
    if (path === 'package.json') return true;
    return ['.yml', '.yaml', '.mjs', '.js', '.cjs', '.ts', '.sh'].includes(extname(path));
  });

  const forbidden = [
    { label: 'Railway CLI agent command', regex: /^\s*(?:run:\s*)?(?:npx\s+)?railway\s+agent(?:\s|$)/im },
    { label: 'Railway MCP agent tool', regex: /mcp__railway__railway_agent/i },
    { label: 'Railway connector agent tool', regex: /(^|[^A-Za-z0-9_])railway_agent([^A-Za-z0-9_]|$)/i },
    { label: 'GitHub Copilot CLI command', regex: /^\s*(?:run:\s*)?(?:gh\s+copilot|copilot)(?:\s|$)/im },
  ];

  const violations = [];
  for (const path of candidateFiles) {
    const content = read(path);
    for (const { label, regex } of forbidden) {
      if (regex.test(content)) violations.push(`${path}: ${label}`);
    }
  }

  assert.deepEqual(violations, [], `Railway Agent dispatch surfaces are forbidden:\n${violations.join('\n')}`);
});
