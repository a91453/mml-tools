// In-game probe kit for open engine questions (docs/PENDING.md P3/P6 and the
// fusion analysis D10). Pure: no DOM, no storage.
//
// Each probe is a fixed test string the user pastes into the game, plus the
// outcomes they can observe. A recorded observation is class E evidence for
// the exact client/region/version/instrument and the exact bytes pasted
// (SOURCE_POLICY §1E): it is bound to the probe string's SHA-256, it never
// changes a Canonical rule by itself, and applying it to the rules goes
// through the published Canonical process.

export const PROBES = Object.freeze([
  Object.freeze({
    id: 'nxx-octave-v1',
    title: 'Nxx 與具名音高的對應',
    pending: 'P3 / P6',
    question: 'Nxx 的數字與具名音高差多少？repo 目前讀作 N60 = o4c；另一種常見讀法是 n48 = o4c（N = MIDI − 12）。',
    mml: 'MML@t90l2o4crn48rn60r,,,,,;',
    listen: '依序會聽到三個音，中間各有休止：① o4c ② n48 ③ n60。請比對 ② 和 ③ 哪一個跟 ① 同音高。',
    outcomes: Object.freeze([
      Object.freeze({ id: 'n48-equals-o4c', label: '② n48 與 ① o4c 同音（N = MIDI − 12）' }),
      Object.freeze({ id: 'n60-equals-o4c', label: '③ n60 與 ① o4c 同音（N = MIDI，repo 現行讀法）' }),
      Object.freeze({ id: 'neither', label: '兩者都與 ① 不同音' }),
      Object.freeze({ id: 'rejected', label: '遊戲拒絕貼上或無法播放' }),
    ]),
  }),
  Object.freeze({
    id: 'tie-length-order-v1',
    title: '延音中切換長度的寫法',
    pending: 'D10（融合分析 §7）',
    question: 'repo 的 emitter 寫成 「c4&l8c」；社群回報實際貼進遊戲的是 「c4l8&c」。兩種寫法遊戲都接受嗎？聽起來是否相同？',
    mml: 'MML@t90o4l4c&l8cr8r2,t90o4l4cl8&cr8r2,,,,;',
    listen: 'Melody 是 「c4&l8c」，Chord1 是 「c4l8&c」，兩軌同時開始，應該都是一個延長到 1.5 拍的 C。請分別單獨播放兩軌比較。',
    outcomes: Object.freeze([
      Object.freeze({ id: 'both-accepted-same', label: '兩種寫法都接受，而且聽起來相同' }),
      Object.freeze({ id: 'only-tie-first', label: '只有 「c4&l8c」（Melody）正常' }),
      Object.freeze({ id: 'only-length-first', label: '只有 「c4l8&c」（Chord1）正常' }),
      Object.freeze({ id: 'both-accepted-different', label: '兩種都接受，但聽起來不同' }),
      Object.freeze({ id: 'rejected', label: '遊戲拒絕貼上' }),
    ]),
  }),
]);

const REQUIRED = ['client', 'version', 'instrument'];
const text = value => (typeof value === 'string' ? value.trim() : '');

// A complete observation or a thrown error naming what is missing. The digest
// of the exact probe string is supplied by the caller (crypto is async).
export function buildObservation(probe, fields, { mmlSha256, observedAt = new Date().toISOString() } = {}) {
  if (!probe || !PROBES.includes(probe)) throw Error('未知的測試項目');
  const outcome = probe.outcomes.find(o => o.id === fields?.outcome);
  if (!outcome) throw Error('請選擇你在遊戲中觀察到的結果');
  const missing = REQUIRED.filter(key => !text(fields[key]));
  if (missing.length) throw Error(`請填寫：${missing.map(key => ({ client: '遊戲 client／地區', version: '版本', instrument: '樂器' })[key]).join('、')}`);
  if (!/^[0-9a-f]{64}$/.test(mmlSha256 ?? '')) throw Error('測試字串的 SHA-256 無效');
  return Object.freeze({
    kind: 'in-game-probe-observation',
    evidenceClass: 'E',
    probeId: probe.id,
    pending: probe.pending,
    mml: probe.mml,
    mmlSha256,
    outcome: outcome.id,
    outcomeLabel: outcome.label,
    client: text(fields.client),
    version: text(fields.version),
    instrument: text(fields.instrument),
    notes: text(fields.notes),
    observedAt,
    canonicalEffect: 'none-until-published',
  });
}

// What the recorded observations say, per probe, without deciding anything:
// agreement across clients is reported, disagreement is reported as such.
export function summarize(observations) {
  return PROBES.map(probe => {
    const own = observations.filter(o => o.probeId === probe.id);
    const outcomes = [...new Set(own.map(o => o.outcome))];
    return { probeId: probe.id, count: own.length, outcomes, consistent: outcomes.length <= 1 };
  });
}
