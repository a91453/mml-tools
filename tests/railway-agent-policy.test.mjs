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
  for (const path of ['AGENTS.md', 'CLAUDE.md', 'docs/RAILWAY_AGENT_POLICY.md']) {
    const content = read(path);
    assert.match(content, /Railway Agent/i, `${path} must name the prohibited service`);
    assert.match(content, /never|prohibit|disabled|MUST NOT/i, `${path} must state a prohibition`);
    assert.match(content, /deterministic/i, `${path} must point agents to deterministic operations`);
  }

  const agents = read('AGENTS.md');
  assert.match(agents, /Codex/i);
  assert.match(agents, /ChatGPT/i);
  assert.match(agents, /Claude Code/i);
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
    { label: 'Railway CLI agent command', regex: /(^|[^A-Za-z0-9_])railway\s+agent([^A-Za-z0-9_]|$)/i },
    { label: 'Railway MCP agent tool', regex: /mcp__railway__railway_agent/i },
    { label: 'Railway connector agent tool', regex: /(^|[^A-Za-z0-9_])railway_agent([^A-Za-z0-9_]|$)/i },
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
