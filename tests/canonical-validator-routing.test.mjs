// Canonical validator routing — cross-entry parity.
//
// Every entry point that advertises a current Canonical / Strict Mobile
// technical verdict must return the *same* verdict as the authoritative
// validator the Manifest-pinned rules snapshot designates
// (`studio/backend/mml/parser.mjs#validateMML`).
//
// This matters because the legacy `dist/core.js` engine and the published rules
// disagree in both directions, so "some validator said PASS" is not a Canonical
// answer:
//
//     MML@t256o4c1,,,,,;                 legacy PASS   Canonical FAIL
//     a 4/4 bar built from l64/64th notes legacy FAIL   Canonical PASS
//
// Both cases are exercised below through the direct parser, the Application
// Service, the HTTP adapter and the MCP adapter. A regression that re-routes
// any of them back to the legacy engine flips one of these assertions.
//
// The legacy engine is still reachable, under its own names, and is asserted
// here to label itself as a diagnostic rather than as a Canonical verdict.

import test from 'node:test';
import assert from 'node:assert/strict';

import { STUDIO_MML_PROFILE, validateMML as canonicalValidateMML } from '../studio/backend/mml/parser.mjs';
import { PROFILE as LEGACY_PROFILE, VERSION as LEGACY_VERSION, validateMML as legacyValidateMML } from '../dist/core.js';
import { PUBLISHED_CANONICAL } from '../studio/backend/rules/index.mjs';
import { API_PREFIX, createApiRouter } from '../server/api.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { createStudioApplication } from '../studio/backend/application/index.mjs';
import { ERROR_CODES } from '../studio/backend/application/contracts.mjs';

const ORIGIN = 'https://mml.example';
const METER = '0 4/4';

// The audit's two reproductions, verified against both engines below so the
// fixtures cannot silently stop being divergent.
const TEMPO_OVER_RANGE = 'MML@t256o4c1,,,,,;';
const SIXTY_FOURTH_BAR = `MML@t120o4${'c64'.repeat(64)},,,,,;`;

const CASES = Object.freeze([
  { name: 'tempo above the official range', mml: TEMPO_OVER_RANGE, canonicalOk: false, legacyOk: true, code: 'TEMPO_OUT_OF_RANGE' },
  { name: 'a 4/4 bar of 64th notes', mml: SIXTY_FOURTH_BAR, canonicalOk: true, legacyOk: false, code: null },
  { name: 'a plain whole note', mml: 'MML@t120o4c1,,,,,;', canonicalOk: true, legacyOk: true, code: null },
]);

function surfaces() {
  const application = createStudioApplication({ transports: ['http'] });
  const route = createApiRouter({ application, ownerOf: () => 'owner:service' });
  return {
    application,
    async http(path, payload) {
      const response = await route(
        new Request(`${ORIGIN}${API_PREFIX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        { authenticated: true },
      );
      return { status: response.status, body: await response.json() };
    },
    async mcp(name, args) {
      const response = await handleMcp(new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }));
      return (await response.json()).result;
    },
  };
}

test('the two fixtures really do split the legacy engine from Published Canonical', () => {
  // Guards the rest of this file: if a future rules release made these agree,
  // the parity assertions below would pass for the wrong reason.
  for (const { name, mml, canonicalOk, legacyOk } of CASES) {
    assert.equal(canonicalValidateMML(mml, { meterText: METER }).ok, canonicalOk, `${name}: Canonical`);
    assert.equal(legacyValidateMML(mml, { meterText: METER }).ok, legacyOk, `${name}: legacy`);
  }
});

test('the same MML gets the same Canonical verdict through parser, service, HTTP and MCP', async () => {
  const { application, http, mcp } = surfaces();

  for (const { name, mml, canonicalOk, code } of CASES) {
    const input = { mml, meter_text: METER };
    const direct = canonicalValidateMML(mml, { meterText: METER });
    assert.equal(direct.ok, canonicalOk, `${name}: direct parser`);

    const service = await application.validateTechnicalMml(input);
    const overHttp = await http('/technical/validate', input);
    const overMcp = await mcp('mml_validate', input);

    for (const [surface, report] of [['service', service], ['http', overHttp.body], ['mcp', overMcp.structuredContent]]) {
      assert.equal(report.authority, 'PUBLISHED_CANONICAL', `${name}: ${surface} authority`);
      assert.equal(report.technical_ok, canonicalOk, `${name}: ${surface} verdict`);
      assert.equal(report.gates.strict_mobile_technical, canonicalOk ? 'PASS' : 'FAIL', `${name}: ${surface} gate`);
      assert.equal(report.error_count, direct.errors.length, `${name}: ${surface} error count`);
      assert.deepEqual(report.tracks.map(track => track.note_events), direct.song.tracks.map(track => track.events.length), `${name}: ${surface} events`);
      assert.equal(report.total_beats, direct.song.total, `${name}: ${surface} total`);
      if (code) assert.ok(report.errors.some(error => error.code === code), `${name}: ${surface} reports ${code}`);
    }
    assert.equal(overHttp.status, 200, `${name}: HTTP status`);
    assert.equal(overMcp.isError, false, `${name}: MCP is not a transport error`);
  }
});

test('mml_service_info names the profile and release mml_validate answers under', async () => {
  // Service info used to report dist/core.js's legacy profile while
  // mml_validate answered under the Published Canonical one. The two profiles
  // judge SIXTY_FOURTH_BAR oppositely, so a client that read service info was
  // told the wrong rules for every verdict it then received.
  const { mcp } = surfaces();
  const input = { mml: SIXTY_FOURTH_BAR, meter_text: METER };
  const info = (await mcp('mml_service_info', {})).structuredContent;
  const validated = (await mcp('mml_validate', input)).structuredContent;
  const overlaps = (await mcp('mml_overlap_details', input)).structuredContent;

  assert.equal(validated.authority, 'PUBLISHED_CANONICAL');
  assert.equal(validated.technical_ok, true, 'the Canonical profile accepts the bar the legacy profile rejects');
  assert.equal(info.profile, validated.profile, 'service info names the profile mml_validate reports');
  assert.equal(info.profile, overlaps.profile, 'and the one mml_overlap_details reports');
  assert.equal(info.profile, STUDIO_MML_PROFILE);
  assert.notEqual(info.profile, LEGACY_PROFILE);
  assert.equal(info.validation_authority, 'PUBLISHED_CANONICAL');
  assert.equal(info.canonical_validation, 'AVAILABLE');

  // The release is the one the Canonical gate loaded, its identities kept apart.
  assert.deepEqual(info.canonical_release, {
    status: 'CANONICAL_LOADED',
    canonical_version: PUBLISHED_CANONICAL.metadata.canonical_version,
    canonical_status: PUBLISHED_CANONICAL.metadata.canonical_status,
    manifest_version: PUBLISHED_CANONICAL.metadata.manifest_version,
    rules_snapshot_sha: PUBLISHED_CANONICAL.metadata.rules_snapshot_sha,
    manifest_commit: PUBLISHED_CANONICAL.provenance.manifest_commit,
  });

  // The dist/core.js values are still reported, under legacy names only.
  assert.equal(info.legacy_profile, LEGACY_PROFILE);
  assert.equal(info.legacy_core_version, LEGACY_VERSION);
  assert.equal(info.core_version, undefined);
});

test('technical reports carry the dist/core.js identity only under legacy names', async () => {
  const { application, http, mcp } = surfaces();
  const refused = { mml: TEMPO_OVER_RANGE, meter_text: METER };
  const accepted = { mml: SIXTY_FOURTH_BAR, meter_text: METER };

  // A Canonical report's `profile` is the profile that produced its verdict,
  // and the dist/core.js version beside it says it is the legacy library's.
  for (const [surface, report] of [
    ['service', await application.validateTechnicalMml(refused)],
    ['http', (await http('/technical/validate', refused)).body],
    ['mcp', (await mcp('mml_validate', refused)).structuredContent],
    ['http overlaps', (await http('/technical/overlaps', accepted)).body],
    ['mcp overlaps', (await mcp('mml_overlap_details', accepted)).structuredContent],
  ]) {
    assert.equal(report.authority, 'PUBLISHED_CANONICAL', `${surface}: authority`);
    assert.equal(report.profile, STUDIO_MML_PROFILE, `${surface}: profile`);
    assert.equal(report.legacy_core_version, LEGACY_VERSION, `${surface}: legacy library version`);
    assert.equal(report.core_version, undefined, `${surface}: no unlabelled legacy version`);
    assert.equal(report.legacy_profile, undefined, `${surface}: a Canonical report has no legacy profile`);
  }

  // A legacy diagnostic names no Canonical profile, exactly as it states no
  // Canonical technical_ok; its engine's profile has a legacy name.
  for (const [surface, report] of [
    ['service', application.legacyTechnicalDiagnostic(refused)],
    ['service overlaps', application.legacyTechnicalOverlapDetails(refused)],
    ['http', (await http('/technical/legacy/validate', refused)).body],
  ]) {
    assert.equal(report.authority, 'LEGACY_DIAGNOSTIC', `${surface}: authority`);
    assert.equal(report.profile, null, `${surface}: no Canonical profile is stated`);
    assert.equal(report.legacy_profile, LEGACY_PROFILE, `${surface}: legacy profile`);
    assert.equal(report.legacy_core_version, LEGACY_VERSION, `${surface}: legacy library version`);
    assert.equal(report.core_version, undefined, `${surface}: no unlabelled legacy version`);
  }
});

test('overlap detail follows the same Canonical routing on every surface', async () => {
  const { application, http, mcp } = surfaces();
  // A song the Canonical validator rejects has no reviewed interval list, and
  // every surface must say so the same way rather than one of them falling back
  // to the engine that accepts it.
  const refused = { mml: TEMPO_OVER_RANGE, meter_text: METER };
  const service = await application.technicalOverlapDetails(refused);
  const overHttp = await http('/technical/overlaps', refused);
  const overMcp = await mcp('mml_overlap_details', refused);
  for (const [surface, report] of [['service', service], ['http', overHttp.body], ['mcp', overMcp.structuredContent]]) {
    assert.equal(report.authority, 'PUBLISHED_CANONICAL', `${surface} authority`);
    assert.equal(report.technical_ok, false, `${surface} verdict`);
    assert.equal(report.total_items, undefined, `${surface} publishes no interval list for a refused song`);
  }

  const accepted = { mml: SIXTY_FOURTH_BAR, meter_text: METER };
  const okService = await application.technicalOverlapDetails(accepted);
  const okHttp = await http('/technical/overlaps', accepted);
  const okMcp = await mcp('mml_overlap_details', accepted);
  for (const [surface, report] of [['service', okService], ['http', okHttp.body], ['mcp', okMcp.structuredContent]]) {
    assert.equal(report.authority, 'PUBLISHED_CANONICAL', `${surface} authority`);
    assert.equal(report.technical_ok, true, `${surface} verdict`);
    assert.equal(report.pair_count, 15, `${surface} keeps all 15 pairs`);
  }
  assert.equal(okService.total_items, okHttp.body.total_items);
  assert.equal(okService.total_items, okMcp.structuredContent.total_items);
});

test('a legacy PASS is never presented as a Published Canonical PASS', async () => {
  const { application, http } = surfaces();
  const input = { mml: TEMPO_OVER_RANGE, meter_text: METER };

  const diagnostic = application.legacyTechnicalDiagnostic(input);
  const overHttp = await http('/technical/legacy/validate', input);

  for (const [surface, report] of [['service', diagnostic], ['http', overHttp.body]]) {
    // The legacy engine accepts this song. The report must not let that read as
    // a Canonical verdict anywhere a caller might look.
    assert.equal(report.legacy_technical_ok, true, `${surface}: the legacy engine still accepts it`);
    assert.equal(report.authority, 'LEGACY_DIAGNOSTIC', `${surface}: authority`);
    assert.equal(report.technical_ok, null, `${surface}: no Canonical verdict is stated`);
    assert.equal(report.gates.strict_mobile_technical, 'NOT_RUN', `${surface}: the Canonical axis is unanswered`);
    assert.equal(report.gates.legacy_diagnostic, 'PASS', `${surface}: the legacy result is reported under its own name`);
  }
  // ...while the Canonical surface refuses the same song.
  assert.equal((await application.validateTechnicalMml(input)).technical_ok, false);
});

test('Canonical-claiming entry points fail closed when Published Canonical is unavailable', async () => {
  const unloadable = createStudioApplication({ transports: ['http'], loadEngines: async () => { throw Error('no published history'); } });
  const route = createApiRouter({ application: unloadable, ownerOf: () => 'owner:service' });
  const input = { mml: 'MML@t120o4c1,,,,,;', meter_text: METER };

  for (const operation of ['validateTechnicalMml', 'technicalOverlapDetails']) {
    await assert.rejects(() => unloadable[operation](input), error => error.code === ERROR_CODES.CANONICAL_NOT_LOADED, operation);
  }

  for (const path of ['/technical/validate', '/technical/overlaps']) {
    const response = await route(
      new Request(`${ORIGIN}${API_PREFIX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
      { authenticated: true },
    );
    const body = await response.json();
    assert.equal(response.status, 503, path);
    assert.equal(body.error.code, ERROR_CODES.CANONICAL_NOT_LOADED, path);
    // A refusal is not a verdict, and it never carries a legacy result instead.
    assert.equal(body.technical_ok, undefined, path);
    assert.equal(body.legacy_technical_ok, undefined, path);
  }

  // The legacy diagnostic still answers, under its own name.
  const diagnostic = unloadable.legacyTechnicalDiagnostic(input);
  assert.equal(diagnostic.authority, 'LEGACY_DIAGNOSTIC');
  assert.equal(diagnostic.legacy_technical_ok, true);
  assert.equal(diagnostic.technical_ok, null);
});

test('the MCP tools fail closed too rather than answering from the legacy engine', async () => {
  // The MCP transport binds its own technical service and its own Canonical
  // gate, so its fail-closed behaviour is a separate guarantee from the HTTP
  // adapter's and is asserted separately. `load` is injected here the way the
  // Application Service contract test injects it, because the real repository
  // this suite runs in can load Canonical.
  const { createTechnicalService } = await import('../studio/backend/application/technical-service.mjs');
  const { createCanonicalGate } = await import('../studio/backend/application/provenance.mjs');
  const unloadable = createTechnicalService({
    serviceVersion: '0.0.0-test',
    canonical: createCanonicalGate({ load: async () => { throw Error('no published history'); } }),
  });
  const input = { mml: 'MML@t120o4c1,,,,,;', meter_text: METER };

  for (const operation of ['validate', 'overlapDetails']) {
    await assert.rejects(() => unloadable[operation](input), error => error.code === ERROR_CODES.CANONICAL_NOT_LOADED, operation);
  }
  // ...while the same engine the transport would have fallen back to still
  // answers under its own name, and states no Canonical verdict.
  const diagnostic = unloadable.legacyValidate(input);
  assert.equal(diagnostic.authority, 'LEGACY_DIAGNOSTIC');
  assert.equal(diagnostic.technical_ok, null);
  assert.equal(diagnostic.gates.strict_mobile_technical, 'NOT_RUN');
});

test('service info says Canonical is unavailable instead of naming the legacy profile', async () => {
  // mml_service_info is built from describe() on the transport's own technical
  // service, and has to keep answering exactly where validation refuses.
  const { createTechnicalService } = await import('../studio/backend/application/technical-service.mjs');
  const { createCanonicalGate, EngineUnavailableError } = await import('../studio/backend/application/provenance.mjs');
  const input = { mml: 'MML@t120o4c1,,,,,;', meter_text: METER };

  // No published history; and no gate at all, which is the Sites artifact.
  for (const [name, service] of [
    ['unloadable gate', createTechnicalService({ serviceVersion: '0.0.0-test', canonical: createCanonicalGate({ load: async () => { throw Error('no published history'); } }) })],
    ['no gate', createTechnicalService({ serviceVersion: '0.0.0-test' })],
  ]) {
    const info = await service.describe();
    assert.equal(info.canonical_validation, ERROR_CODES.CANONICAL_NOT_LOADED, name);
    assert.equal(info.profile, null, `${name}: no profile answers, and the legacy one is not offered instead`);
    assert.equal(info.validation_authority, 'PUBLISHED_CANONICAL', name);
    assert.equal(info.canonical_release.status, ERROR_CODES.CANONICAL_NOT_LOADED, name);
    assert.equal(info.canonical_release.canonical_version, null, name);
    assert.equal(info.canonical_release.rules_snapshot_sha, null, name);
    assert.equal(info.legacy_profile, LEGACY_PROFILE, name);
    assert.equal(info.legacy_core_version, LEGACY_VERSION, name);
    // The code it names is the refusal the validation operations answer with.
    await assert.rejects(() => service.validate(input), error => error.code === info.canonical_validation, name);
  }

  // The rules loaded and a later engine did not: the release is named, the
  // profile is not, and the code is the engine's rather than the Canonical one.
  const engineless = createTechnicalService({
    serviceVersion: '0.0.0-test',
    canonical: createCanonicalGate({
      load: async ({ recordPublished }) => {
        recordPublished(PUBLISHED_CANONICAL);
        throw new EngineUnavailableError('synthetic engine import failure');
      },
    }),
  });
  const info = await engineless.describe();
  assert.equal(info.canonical_validation, ERROR_CODES.ENGINE_UNAVAILABLE);
  assert.equal(info.profile, null);
  assert.equal(info.canonical_release.status, 'CANONICAL_LOADED');
  assert.equal(info.canonical_release.rules_snapshot_sha, PUBLISHED_CANONICAL.metadata.rules_snapshot_sha);
  assert.equal(info.legacy_profile, LEGACY_PROFILE);
  await assert.rejects(() => engineless.validate(input), error => error.code === ERROR_CODES.ENGINE_UNAVAILABLE);
});

test('a Canonical validator that exports no profile is refused, never labelled with the legacy profile', async () => {
  // The Canonical path used to fill a missing STUDIO_MML_PROFILE with
  // dist/core.js's PROFILE, so a Canonical verdict claimed the legacy rules.
  const { createTechnicalService } = await import('../studio/backend/application/technical-service.mjs');
  const service = createTechnicalService({
    serviceVersion: '0.0.0-test',
    canonical: { engines: async () => ({ mml: { validateMML: canonicalValidateMML } }) },
  });
  const input = { mml: 'MML@t120o4c1,,,,,;', meter_text: METER };
  for (const operation of ['validate', 'overlapDetails']) {
    await assert.rejects(() => service[operation](input), error => {
      assert.equal(error.code, ERROR_CODES.ENGINE_UNAVAILABLE, operation);
      assert.equal(error.details.legacy_fallback_allowed, false, operation);
      return true;
    });
  }
  const info = await service.describe();
  assert.equal(info.canonical_validation, ERROR_CODES.ENGINE_UNAVAILABLE);
  assert.equal(info.profile, null);
});
