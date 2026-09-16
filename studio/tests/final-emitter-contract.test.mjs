// Final emitter contract regressions.
//
// These pin the one property that keeps the emitter from becoming a second rule
// source: every published value it uses is read from the executable contract or
// derived from the authoritative parser, never transcribed. A test that compared
// a constant to itself would prove nothing, so each assertion below observes the
// parser's actual behaviour instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrack } from '../backend/mml/parser.mjs';
import { EFFECTIVE_RULESET } from '../backend/rules/index.mjs';
import {
  EMIT_STATUS,
  DIAGNOSTIC_SEVERITY,
  EMIT_DIAGNOSTICS,
  parserFacts,
  normalizeEmitOptions,
  canonicalIdentity,
  diagnostic,
} from '../backend/final/emitter-contract.mjs';

test('the emitter reports only states the published vocabulary allows', () => {
  // ACCEPTANCE_CRITERIA.md "Final state vocabulary".
  for (const value of Object.values(EMIT_STATUS)) {
    assert.ok(['PASS', 'FAIL', 'PENDING', 'UNSUPPORTED', 'N/A'].includes(value));
  }
});

test('the default volume is read out of the parser, not declared', () => {
  const facts = parserFacts();
  const track = parseTrack('t120o4c4', 'Melody', { mode: 'final' });
  assert.equal(facts.defaultVolume, track.events[0].volume);
});

test('the default length is derived from a real parse, exactly', () => {
  const facts = parserFacts();
  // A bare `c` takes the default length; a `c<n>` with that n must be identical.
  const bare = parseTrack('t120o4c', 'Melody', { mode: 'final' });
  const explicit = parseTrack(`t120o4c${facts.defaultLength}`, 'Melody', { mode: 'final' });
  assert.equal(bare.total, explicit.total);
});

test('the pitch spelling table is the parser inverse, for every entry', () => {
  // The forward mapping is the parser's. Deriving the inverse is what stops a
  // second pitch table from drifting away from it (PENDING P6 keeps the octave
  // mapping an implementation mapping, so a transcribed copy would be worse).
  const { spellingsByPitch } = parserFacts();
  assert.ok(spellingsByPitch.size > 0);
  for (const [pitch, spellings] of spellingsByPitch) {
    for (const { octave, text } of spellings) {
      const track = parseTrack(`t120o${octave}${text}4`, 'Melody', { mode: 'final' });
      assert.equal(track.errors.length, 0, `${octave}${text} must parse cleanly`);
      assert.equal(track.events[0].pitch, pitch, `o${octave}${text} must be pitch ${pitch}`);
    }
  }
});

test('the octave-boundary enharmonics really do reach a neighbouring octave', () => {
  // This is the whole value of the alternate spelling: it reaches the pitch
  // without moving the octave state.
  const { spellingsByPitch } = parserFacts();
  const middleC = parseTrack('t120o4c4', 'Melody', { mode: 'final' }).events[0].pitch;
  const options = spellingsByPitch.get(middleC);
  assert.ok(options.some(option => option.text === 'c' && option.octave === 4));
  assert.ok(options.some(option => option.text === 'b+' && option.octave === 3),
    'b+ one octave down must be the same pitch');
});

test('emit options normalize deterministically and reject nonsense', () => {
  const normalized = normalizeEmitOptions({});
  assert.equal(normalized.cautionLengthOptIn, false, 'caution lengths are opt-in');
  assert.ok(normalized.budget > 0);
  assert.throws(() => normalizeEmitOptions({ budget: 0 }), /budget/);
  assert.throws(() => normalizeEmitOptions({ maxTieSegments: -1 }), /maxTieSegments/);
  assert.throws(() => normalizeEmitOptions(null), /object/);
  assert.equal(normalizeEmitOptions({ cautionLengthOptIn: 'yes' }).cautionLengthOptIn, false,
    'only an explicit true opts in');
});

test('every result carries the published release identity', () => {
  const identity = canonicalIdentity();
  assert.equal(identity, EFFECTIVE_RULESET.canonical);
  assert.equal(identity.canonical_status, 'PUBLISHED');
  assert.ok(/^[0-9a-f]{40}$/.test(identity.rules_snapshot_sha));
});

test('diagnostics are frozen and carry a code plus a severity', () => {
  const item = diagnostic(EMIT_DIAGNOSTICS.DURATION_SEARCH_POLICY_LIMIT, DIAGNOSTIC_SEVERITY.ERROR, 'x', { role: 'Melody' });
  assert.equal(Object.isFrozen(item), true);
  assert.equal(item.code, 'DURATION_SEARCH_POLICY_LIMIT');
  assert.equal(item.severity, 'error');
  assert.equal(item.role, 'Melody');
});

test('no diagnostic code claims a duration is unrepresentable', () => {
  // The bounded search has no completeness proof, so the vocabulary it can
  // report must not contain a verdict it cannot justify. The one remaining
  // "NOT_REPRESENTABLE" code is about a G10-preserved sub-grid interval, which
  // *is* provable: no admitted Final token is shorter than the safe grid.
  const durationCodes = Object.keys(EMIT_DIAGNOSTICS).filter(name => name.startsWith('DURATION_'));
  assert.ok(durationCodes.length >= 3);
  for (const name of durationCodes) {
    assert.equal(/NOT_REPRESENTABLE|IMPOSSIBLE/.test(name), false, `${name} overclaims`);
  }
});
