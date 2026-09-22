import test from 'node:test';
import assert from 'node:assert/strict';
import { compareContinuationSurface, CONTINUATION_REQUIRED_TOOLS } from '../server/continuation-surface.mjs';

const fixture = schema => CONTINUATION_REQUIRED_TOOLS.map(name => ({ name, inputSchema: structuredClone(schema) }));
const status = (left, right) => compareContinuationSurface(fixture(left), fixture(right)).status;

for (const keyword of ['const', 'enum']) {
  test(`literal title and description values in ${keyword} are validation data`, () => {
    const value = { title: 'allowed', description: 'source decision', $comment: 'literal' };
    const schema = { type: 'object', properties: { payload: { [keyword]: keyword === 'enum' ? [value] : value } } };
    for (const field of ['title', 'description', '$comment']) {
      const changed = structuredClone(schema);
      const target = changed.properties.payload[keyword];
      (keyword === 'enum' ? target[0] : target)[field] = 'different accepted value';
      assert.equal(status(schema, changed), 'CLIENT_SCHEMA_MISMATCH');
    }
  });
}

test('dependentRequired input names must not be stripped as annotations', () => {
  const a = { type: 'object', dependentRequired: { title: ['run_id'] } };
  const b = { type: 'object', dependentRequired: { title: ['candidate_id'] } };
  assert.equal(status(a, b), 'CLIENT_SCHEMA_MISMATCH');
});

test('annotations at real schema locations do not change discovery', () => {
  const schema = { type: 'object', properties: { title: { type: 'string', description: 'old' } },
    dependentSchemas: { description: { properties: { payload: { type: 'string', title: 'old' } } } },
    allOf: [{ required: ['run_id', 'title'], description: 'old' }] };
  const changed = structuredClone(schema);
  changed.title = 'new display title';
  changed.properties.title.description = 'translated';
  changed.dependentSchemas.description.properties.payload.title = 'translated';
  changed.allOf[0].description = 'translated';
  changed.allOf[0].required.reverse();
  assert.equal(status(schema, changed), 'DISCOVERY_MATCH');
});

test('a property named description remains part of the input contract', () => {
  const schema = { type: 'object', properties: { description: { type: 'string' } } };
  const changed = structuredClone(schema);
  delete changed.properties.description;
  assert.equal(status(schema, changed), 'CLIENT_SCHEMA_MISMATCH');
});

test('unknown vocabulary is compared conservatively, not stripped recursively', () => {
  const a = { type: 'object', 'x-binding': { title: 'run_id' } };
  const b = { type: 'object', 'x-binding': { title: 'candidate_id' } };
  assert.equal(status(a, b), 'CLIENT_SCHEMA_MISMATCH');
});
