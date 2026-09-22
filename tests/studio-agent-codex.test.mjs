import test from 'node:test';
import assert from 'node:assert/strict';
import { codexChildEnvironment } from '../server/studio-agent-codex.mjs';

test('local Codex child receives neither MML configuration nor OpenAI API credential', () => {
  const env = codexChildEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    MML_AGENT_MODEL: 'local-model',
    MML_OWNER_PASSWORD: 'secret-owner',
    OPENAI_API_KEY: 'sk-test-secret',
    OTHER_SAFE_VALUE: 'ok',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/tmp/home');
  assert.equal(env.OTHER_SAFE_VALUE, 'ok');
  assert.equal(Object.hasOwn(env, 'MML_AGENT_MODEL'), false);
  assert.equal(Object.hasOwn(env, 'MML_OWNER_PASSWORD'), false);
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
});
