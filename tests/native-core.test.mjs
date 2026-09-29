// The native core (scripts/build-native-core.mjs, studio/native/): the shared
// engines as one script a native host evaluates offline.
//
// Every test here evaluates the built bundle in a bare JavaScript context: no
// Node API, no Web API, no network object, and microtasks drained after each
// evaluation, as a JavaScriptCore host does. What passes here is what the App's
// JavaScriptCore bridge runs; the Swift tests (apps/ios/MMLKit) repeat the
// conformance cases on a real JavaScriptCore.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadPublishedCanonical } from '../studio/backend/bootstrap/index.mjs';
import { SUPPORTED_CANONICAL_VERSIONS } from '../studio/backend/rules/supported-releases.mjs';
import { STUDIO_MML_PROFILE } from '../studio/backend/mml/parser.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { DataCloneError, Utf8TextDecoder, Utf8TextEncoder, hostStructuredClone } from '../studio/native/host-globals.mjs';
import { NATIVE_SERVICE_VERSION } from '../studio/native/core-facade.mjs';
import { NATIVE_CONFORMANCE_CASES } from '../studio/native/conformance-cases.mjs';
import { canonicalRuntimePackage } from '../scripts/canonical-runtime-package.mjs';
import { buildNativeCore, buildNativeCoreBundle } from '../scripts/build-native-core.mjs';

const canonical = loadPublishedCanonical({ supportedCanonicalVersion: SUPPORTED_CANONICAL_VERSIONS });
const built = await buildNativeCore({ write: false });

function bareHost(bundle = built.bundle) {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  vm.runInContext(bundle, context);
  const call = (operation, request) => {
    const json = request === undefined ? '' : JSON.stringify(request);
    const ticket = vm.runInContext(`MMLNativeCore.submit(${JSON.stringify(operation)}, ${JSON.stringify(json)})`, context);
    return JSON.parse(vm.runInContext(`MMLNativeCore.collect(${ticket})`, context));
  };
  return { context, call };
}

test('the bundle evaluates in a bare JavaScript context and reports the Published Canonical it carries', () => {
  const before = vm.runInContext('JSON.stringify([typeof TextEncoder, typeof TextDecoder, typeof structuredClone, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof process, typeof require])', vm.createContext({}));
  assert.deepEqual(JSON.parse(before), Array(8).fill('undefined'), 'precondition: the test host has none of the platform globals');
  const { call } = bareHost();
  const identity = call('identity');
  assert.equal(identity.ok, true);
  const { result } = identity;
  assert.equal(result.api_version, 1);
  assert.equal(result.canonical.status, 'CANONICAL_LOADED');
  for (const field of ['canonical_version', 'canonical_status', 'manifest_version', 'rules_snapshot_sha', 'machine_delivery_schema']) {
    assert.equal(result.canonical[field], canonical.metadata[field] ?? null, field);
  }
  // Git provenance is audit metadata of the build, never runtime content.
  for (const field of ['manifest_commit', 'published_main_head', 'repository_head', 'pr_head']) assert.equal(result.canonical[field], null, field);
  assert.equal(result.runtime_package_digest, canonicalRuntimePackage(canonical).digest, 'the same runtime package Studio Web ships');
  assert.equal(result.service.canonical_validation, 'AVAILABLE');
  assert.equal(result.service.profile, STUDIO_MML_PROFILE);
  assert.deepEqual(result.documents.map(document => [document.path, document.blob_sha]), canonical.documents.map(document => [document.path, document.blob_sha]));
  assert.deepEqual([...result.host_shims], ['TextEncoder', 'TextDecoder', 'structuredClone']);
  assert.deepEqual(built.manifest.release, { canonical: canonical.metadata, runtime_package_digest: result.runtime_package_digest });
});

test('every conformance case answers exactly as the Node server path answers it', () => {
  const { call } = bareHost();
  assert.equal(built.conformance.cases.length, NATIVE_CONFORMANCE_CASES.length);
  for (const { name, operation, request, expected } of built.conformance.cases) {
    assert.deepEqual(call(operation, request), expected, name);
  }
  // The cases must exercise all three kinds of answer, or agreement proves little.
  const kinds = new Set(built.conformance.cases.map(({ expected }) => (expected.ok ? `technical_ok:${expected.result.technical_ok}` : `refused:${expected.error.code}`)));
  for (const kind of ['technical_ok:true', 'technical_ok:false', 'refused:INVALID_REQUEST']) assert.ok(kinds.has(kind), kind);
});

test('the App and the MCP mml_validate / mml_overlap_details tools give the same report', async () => {
  const { call } = bareHost();
  const request = body => new Request('https://mml.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  const tools = { validate: 'mml_validate', overlapDetails: 'mml_overlap_details' };
  const withoutService = ({ service_version, ...report }) => report;
  const compared = built.conformance.cases.filter(({ expected }) => expected.ok);
  assert.ok(compared.length >= 5);
  for (const { name, operation, request: args } of compared) {
    const reply = await (await handleMcp(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tools[operation], arguments: args } }))).json();
    assert.equal(reply.result.isError, false, name);
    const native = call(operation, args).result;
    assert.equal(native.service_version, NATIVE_SERVICE_VERSION);
    assert.deepEqual(withoutService(native), withoutService(reply.result.structuredContent), name);
  }
});

test('a runtime package that fails verification is refused, never answered', () => {
  const digest = built.manifest.release.runtime_package_digest;
  assert.equal(built.bundle.split(digest).length, 2, 'the digest appears exactly once, as the expected value');
  const tampered = {
    'expected digest': built.bundle.replace(digest, '0'.repeat(64)),
    // A document changed after the build: the digest no longer covers it.
    'package content': built.bundle.replace('Status: PUBLISHED CANONICAL', 'Status: PUBLISHED CANONICAl'),
  };
  for (const [label, bundle] of Object.entries(tampered)) {
    assert.notEqual(bundle, built.bundle, label);
    const { call } = bareHost(bundle);
    const identity = call('identity');
    assert.equal(identity.ok, true, `${label}: identity still answers`);
    assert.equal(identity.result.canonical.status, 'CANONICAL_NOT_LOADED', label);
    assert.equal(identity.result.service.canonical_validation, 'CANONICAL_NOT_LOADED', label);
    assert.deepEqual(identity.result.documents, [], label);
    const validation = call('validate', NATIVE_CONFORMANCE_CASES[0].request);
    assert.equal(validation.ok, false, label);
    assert.equal(validation.error.code, 'CANONICAL_NOT_LOADED', label);
    assert.equal(validation.error.details.legacy_fallback_allowed, false, label);
  }
});

test('the bundle carries only the shared engines: no Node API, no network, no server layer', () => {
  const paths = built.manifest.modules.map(module => module.path);
  for (const required of ['dist/core.js', 'studio/backend/mml/parser.mjs', 'studio/backend/rules/index.mjs', 'studio/backend/application/technical-service.mjs', 'studio/web/canonical-package.mjs']) {
    assert.ok(paths.includes(required), required);
  }
  for (const path of paths) {
    assert.match(path, /^(dist\/core\.js|studio\/(backend|native|web)\/[a-z0-9/-]+\.mjs|mml-native:build)$/, path);
    assert.doesNotMatch(path, /^(server|railway|node_modules)\/|application\/(store|index|run-service|proposal-service|prescreen-service|asset-service)\.mjs|audio\/prescreen\//, path);
  }
  const replaced = built.manifest.modules.find(module => module.path === 'studio/backend/bootstrap/index.mjs');
  assert.equal(replaced.replaced_by, 'canonical-runtime-package', 'the Git loader is never shipped');
  assert.doesNotMatch(built.bundle, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)\s*\(|child_process|require\(/);
  assert.doesNotMatch(built.bundle, /\bfrom\s+['"]/, 'no import statement is left for a host to resolve');
});

test('the build is reproducible and its manifest describes exactly these bytes', async () => {
  const again = await buildNativeCoreBundle({ canonical });
  assert.equal(again.bundle, built.bundle);
  const { audit: _, ...stable } = built.manifest;
  const { audit: __, ...stableAgain } = again.manifest;
  assert.deepEqual(stableAgain, stable);
  const { createHash } = await import('node:crypto');
  assert.equal(built.manifest.bundle.sha256, createHash('sha256').update(built.bundle).digest('hex'));
  assert.equal(built.conformance.bundle_sha256, built.manifest.bundle.sha256);
  assert.doesNotMatch(built.bundle, new RegExp(built.manifest.audit.repository_head), 'Git history does not reach the bundle');
});

test('the facade answers malformed host calls with a code, not a crash', () => {
  const { context, call } = bareHost();
  assert.equal(call('noSuchOperation').error.code, 'INVALID_REQUEST');
  const ticket = vm.runInContext('MMLNativeCore.submit("validate", "{not json")', context);
  assert.equal(JSON.parse(vm.runInContext(`MMLNativeCore.collect(${ticket})`, context)).error.code, 'INVALID_REQUEST');
  assert.equal(JSON.parse(vm.runInContext('MMLNativeCore.collect(987654)', context)).error.code, 'UNKNOWN_TICKET');
  // Submitted and collected inside one evaluation: the microtask queue has not
  // drained yet, and the facade says so instead of waiting.
  assert.equal(JSON.parse(vm.runInContext('MMLNativeCore.collect(MMLNativeCore.submit("identity", ""))', context)).error.code, 'NOT_SETTLED');
  assert.equal(call('canonicalDocument', { path: 'docs/NOT_A_RULE.md' }).error.code, 'INVALID_REQUEST');
  const document = call('canonicalDocument', { path: 'docs/MOBILE_SYNTAX.md' }).result;
  assert.equal(document.content, canonical.documents.find(entry => entry.path === 'docs/MOBILE_SYNTAX.md').content);
});

test('host TextEncoder / TextDecoder agree with the platform for UTF-8', () => {
  const samples = ['', 'MML@t120o4c,,,,,;', '拍號圖第1行', 'é', '🎵 music', '𝄞', 'lone \uD800 high', 'lone \uDC00 low', '﻿bom'];
  for (const sample of samples) {
    assert.deepEqual(new Utf8TextEncoder().encode(sample), new TextEncoder().encode(sample), JSON.stringify(sample));
  }
  const byteCases = [[], [0xef, 0xbb, 0xbf, 0x41], [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f, 0x8e], [0xe6, 0x8b], [0x80], [0xff, 0x41], [0xe2, 0x82, 0x41]];
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 400; n++) byteCases.push(Array.from({ length: Math.floor(random() * 12) }, () => Math.floor(random() * 256)));
  for (const bytes of byteCases) {
    const input = Uint8Array.from(bytes);
    for (const options of [{}, { ignoreBOM: true }]) {
      assert.equal(new Utf8TextDecoder('utf-8', options).decode(input), new TextDecoder('utf-8', options).decode(input), `${bytes} ${JSON.stringify(options)}`);
    }
    let platform = null;
    try { platform = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { platform = TypeError; }
    let host = null;
    try { host = new Utf8TextDecoder('utf-8', { fatal: true }).decode(input); } catch (error) { host = error instanceof TypeError ? TypeError : error; }
    assert.equal(host, platform, `fatal ${bytes}`);
  }
  assert.throws(() => new Utf8TextDecoder('big5'), RangeError, 'other encodings are refused, not approximated');
  assert.throws(() => new Utf8TextDecoder().decode(new Uint8Array(1), { stream: true }), TypeError);
});

test('host structuredClone agrees with the platform for data values', () => {
  const shared = { note: 'shared' };
  const cyclic = { name: 'cyclic' };
  cyclic.self = cyclic;
  const holey = [1, , 3];
  holey.extra = 'kept';
  const values = [
    null, undefined, true, 0, -0, NaN, 12n, 'text',
    { nested: { list: [1, 'two', { three: 3 }] }, frozen: Object.freeze({ a: 1 }) },
    holey,
    [shared, shared],
    cyclic,
    new Date(0),
    /a+b/gi,
    new Map([[{ k: 1 }, new Set([1, 2])]]),
    new Uint8Array([1, 2, 3]).subarray(1),
    new Float64Array([1.5, -2]),
    new DataView(new ArrayBuffer(4), 1, 2),
    new (class Instance { constructor() { this.field = 1; } })(),
    Object.assign(new RangeError('bad range'), { extra: 1 }),
  ];
  for (const value of values) {
    const host = hostStructuredClone(value);
    const platform = structuredClone(value);
    assert.deepEqual(host, platform);
    if (value && typeof value === 'object') assert.notEqual(host, value, 'a copy, not the same object');
  }
  const sharedCopy = hostStructuredClone([shared, shared]);
  assert.equal(sharedCopy[0], sharedCopy[1], 'shared references stay shared');
  assert.equal(hostStructuredClone(cyclic).self.self.name, 'cyclic');
  assert.equal(Object.isFrozen(hostStructuredClone(Object.freeze({ a: 1 }))), false);
  for (const uncloneable of [() => 1, Symbol('s'), { fn() {} }, Promise.resolve()]) {
    assert.throws(() => hostStructuredClone(uncloneable), DataCloneError);
    assert.throws(() => structuredClone(uncloneable), { name: 'DataCloneError' });
  }
});
