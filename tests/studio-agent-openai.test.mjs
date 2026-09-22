import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIResponsesDecider } from '../server/studio-agent-openai.mjs';

const apiKey = 'sk-test-012345678901234567890123456789';
const context = { actor: 'agent:codex-dispatch', project_id: 'prj_test', run_id: 'run_test', tools: [], rules: {}, targets: {} };
const action = { tool: null, arguments_json: '{}', reason: '需要人工證據' };

function completed(body = action) {
  return new Response(JSON.stringify({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('OpenAI Responses decider is stateless, schema-bound and returns one action', async () => {
  let request;
  const decide = createOpenAIResponsesDecider({
    apiKey,
    model: 'gpt-test-model',
    maxOutputTokens: 321,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return completed();
    },
  });
  assert.deepEqual(await decide(context), action);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.authorization, 'Bearer ' + apiKey);
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'gpt-test-model');
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 321);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.match(body.input, /Return exactly one JSON action/);
  assert.equal(Object.hasOwn(body, 'tools'), false, 'provider-native tools must not be enabled');
});

test('OpenAI Responses decider enforces the input budget before any paid request', async () => {
  let called = false;
  const decide = createOpenAIResponsesDecider({
    apiKey,
    model: 'gpt-test-model',
    maxInputBytes: 4096,
    fetchImpl: async () => { called = true; return completed(); },
  });
  await assert.rejects(
    decide({ ...context, previous: 'x'.repeat(10000) }),
    /input budget/,
  );
  assert.equal(called, false);
});

test('OpenAI Responses decider fails closed without retry on provider or structured-output errors', async () => {
  let calls = 0;
  for (const response of [
    new Response('quota', { status: 429 }),
    new Response(JSON.stringify({ status: 'incomplete', output: [] }), { status: 200 }),
    new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), { status: 200 }),
    new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{not-json' }] }] }), { status: 200 }),
  ]) {
    const decide = createOpenAIResponsesDecider({
      apiKey,
      model: 'gpt-test-model',
      fetchImpl: async () => { calls++; return response; },
    });
    await assert.rejects(decide(context));
  }
  assert.equal(calls, 4, 'one provider call per decision; no automatic retry');
});

test('OpenAI Responses decider validates hard configuration bounds', () => {
  assert.throws(() => createOpenAIResponsesDecider({ apiKey: 'short', model: 'gpt-test-model' }), /OPENAI_API_KEY/);
  assert.throws(() => createOpenAIResponsesDecider({ apiKey, model: 'bad model' }), /MML_AGENT_MODEL/);
  assert.throws(() => createOpenAIResponsesDecider({ apiKey, model: 'gpt-test-model', maxOutputTokens: 2000 }), /hard bound/);
  assert.throws(() => createOpenAIResponsesDecider({ apiKey, model: 'gpt-test-model', maxInputBytes: 400000 }), /hard bound/);
});
