// A one-preset, one-instrument, one-sample SoundFont 2 file built in memory:
// a synthetic sine wave, no third-party sound data. Used by the SF2 reader's
// unit tests and by the player's browser smoke test.

const chunk = (id, body) => {
  const pad = body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, pad]);
};
const list = (type, ...chunks) => chunk('LIST', Buffer.concat([Buffer.from(type, 'ascii'), ...chunks]));
const name20 = text => { const buffer = Buffer.alloc(20); buffer.write(text, 0, 'ascii'); return buffer; };
const u16 = (...values) => { const buffer = Buffer.alloc(values.length * 2); values.forEach((value, i) => buffer.writeUInt16LE(value, i * 2)); return buffer; };
const gen = (oper, amount) => { const buffer = Buffer.alloc(4); buffer.writeUInt16LE(oper, 0); buffer.writeInt16LE(amount, 2); return buffer; };
const range = (oper, lo, hi) => { const buffer = Buffer.alloc(4); buffer.writeUInt16LE(oper, 0); buffer[2] = lo; buffer[3] = hi; return buffer; };

/** A one-preset, one-instrument, one-sample synthetic bank. */
export function syntheticBank() {
  const samples = Buffer.alloc((100 + 46) * 2);
  for (let i = 0; i < 100; i++) samples.writeInt16LE(Math.round(Math.sin(i / 100 * Math.PI * 2) * 16000), i * 2);
  const phdr = Buffer.concat([
    name20('Synthetic Lead'), u16(5, 0, 0), Buffer.alloc(12),
    name20('EOP'), u16(0, 0, 1), Buffer.alloc(12),
  ]);
  const pbag = u16(0, 0, 2, 0);
  const pgen = Buffer.concat([gen(48, 20), gen(41, 0), gen(0, 0)]);
  const inst = Buffer.concat([name20('Synthetic Inst'), u16(0), name20('EOI'), u16(2)]);
  const ibag = u16(0, 0, 1, 0, 7, 0);
  const igen = Buffer.concat([
    gen(34, -1200), // global zone: attack of 0.5 s
    range(43, 48, 84), gen(58, 60), gen(54, 1), gen(51, 1), gen(17, 250), gen(53, 0), // local zone
    gen(0, 0),
  ]);
  const shdrEntry = Buffer.alloc(46);
  name20('Synthetic Sine').copy(shdrEntry, 0);
  shdrEntry.writeUInt32LE(0, 20); shdrEntry.writeUInt32LE(100, 24); shdrEntry.writeUInt32LE(10, 28); shdrEntry.writeUInt32LE(90, 32);
  shdrEntry.writeUInt32LE(22050, 36); shdrEntry[40] = 69; shdrEntry.writeInt8(-5, 41); shdrEntry.writeUInt16LE(1, 44);
  const shdr = Buffer.concat([shdrEntry, Buffer.alloc(46)]);
  const body = Buffer.concat([
    Buffer.from('sfbk', 'ascii'),
    list('INFO', chunk('ifil', u16(2, 1))),
    list('sdta', chunk('smpl', samples)),
    list('pdta', chunk('phdr', phdr), chunk('pbag', pbag), chunk('pmod', Buffer.alloc(10)), chunk('pgen', pgen),
      chunk('inst', inst), chunk('ibag', ibag), chunk('imod', Buffer.alloc(10)), chunk('igen', igen), chunk('shdr', shdr)),
  ]);
  const riff = chunk('RIFF', body);
  return riff.buffer.slice(riff.byteOffset, riff.byteOffset + riff.byteLength);
}
