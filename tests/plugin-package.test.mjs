// The mml-tools plugin (plugins/mml-tools/) is one folder that both Claude and
// ChatGPT/Codex install: each reads its own manifest and MCP file, and both
// read the same skill. These checks keep the two halves describing the same
// plugin, the same production MCP endpoint and the same skill bytes.
//
// Formats: Claude plugin manifest and marketplace (code.claude.com/docs/en/
// plugins-reference, plugin-marketplaces); Agent Plugins 1.0.0 for plugin.json
// and mcp.json (agent-plugins.org/schemas/1.0.0/*.schema.json, both
// additionalProperties: false); Agent Skills for SKILL.md frontmatter
// (agentskills.io/specification). `claude plugin validate` is the
// authoritative Claude check; these tests only pin what the repo controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
const json = path => JSON.parse(read(path).toString('utf8'));
const PLUGIN = 'plugins/mml-tools';
const target = json('railway/deployment-target.json');
const MCP_URL = `${target.publicOrigin}/mcp`;

test('both marketplaces list the one plugin at the same folder', () => {
  const claude = json('.claude-plugin/marketplace.json');
  assert.equal(typeof claude.name, 'string');
  assert.equal(typeof claude.owner?.name, 'string');
  assert.deepEqual(claude.plugins.map(p => [p.name, p.source]), [['mml-tools', `./${PLUGIN}`]]);

  const openai = json('.agents/plugins/marketplace.json');
  assert.deepEqual(openai.plugins.map(p => [p.name, p.source]), [['mml-tools', { source: 'local', path: `./${PLUGIN}` }]]);
  // OpenAI's docs ask every entry to state these.
  for (const entry of openai.plugins) {
    assert.ok(entry.policy?.installation && entry.policy?.authentication && entry.category, entry.name);
  }
});

test('the Claude and Agent Plugins manifests describe the same plugin', () => {
  const claude = json(`${PLUGIN}/.claude-plugin/plugin.json`);
  const portable = json(`${PLUGIN}/plugin.json`);
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
    assert.deepEqual(claude[key], portable[key], key);
  }
  // Agent Plugins 1.0.0 plugin.schema.json: $schema and name required, a
  // closed key set, and a lowercase dotted/dashed name.
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  assert.deepEqual(Object.keys(portable).filter(key => !allowed.includes(key)), []);
  assert.deepEqual(Object.keys(portable.author).filter(key => !['name', 'email', 'url'].includes(key)), []);
  assert.match(portable.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.ok(portable.name.length <= 64);
  // Claude: name is the one required key, kebab-case.
  assert.match(claude.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('both MCP files point at the production MCP endpoint, each in its own client\'s type', () => {
  const claude = json(`${PLUGIN}/.mcp.json`);
  const portable = json(`${PLUGIN}/mcp.json`);
  assert.deepEqual(Object.keys(claude.mcpServers), Object.keys(portable.mcpServers));
  for (const [name, server] of Object.entries(claude.mcpServers)) {
    assert.deepEqual(server, { type: 'http', url: MCP_URL }, name);
    assert.deepEqual(portable.mcpServers[name], { type: 'streamable-http', url: MCP_URL }, name);
  }
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(portable).sort(), ['$schema', 'mcpServers']);
});

test('the plugin carries the repository skill byte for byte, in Agent Skills form', () => {
  const name = 'mabinogi-mobile-mml';
  const source = read(`skills/${name}/SKILL.md`);
  assert.deepEqual(read(`${PLUGIN}/skills/${name}/SKILL.md`), source, 'update both copies together');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source.toString('utf8'))?.[1];
  assert.ok(frontmatter, 'SKILL.md opens with YAML frontmatter');
  const field = key => new RegExp(`^${key}: (.+)$`, 'm').exec(frontmatter)?.[1];
  assert.equal(field('name'), name, 'name matches its folder');
  assert.match(field('name'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(field('name').length <= 64);
  assert.ok(field('description')?.length >= 1 && field('description').length <= 1024);
});
