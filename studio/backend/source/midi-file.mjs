// Lossless Standard MIDI File decoder.
//
// This module answers exactly one question: *what bytes are in the file*. It
// decodes an SMF into a complete, ordered record of every chunk and every
// event, and it does not interpret any of them. No note-on is matched to a
// note-off here, no tick is converted to a beat, no channel is called
// percussion, and nothing is dropped for being unrecognized.
//
// That separation is deliberate. `SOURCE_POLICY.md` §3 forbids deletion before
// arbitration is possible, and `ACCEPTANCE_CRITERIA.md` Gate 2 requires an
// event-level baseline rather than a prose inventory. A reader that threw on
// the first meta type it did not know, or that silently skipped a malformed
// running-status byte, would destroy the evidence the later gates have to diff
// against. So an unknown meta type, an unexpected SysEx continuation, and a
// truncated track are all recorded as *data* — with their raw bytes — and the
// caller decides what that means.
//
// The legacy `readMidi` in dist/core.js is not this. It is a strict readback
// verifier for MIDI this project itself wrote (Type 1, exactly 7 tracks, PPQ,
// throws on anything else) and it is correct for that job. It cannot ingest a
// third-party file, which is why this decoder exists alongside it rather than
// replacing it.

export const MIDI_ADAPTER = 'studio/backend/source/midi-file.mjs';

// Meta types named here are decoded into structured fields. Anything else is
// still captured byte-for-byte; this list only decides how much structure the
// record carries, never whether the event survives.
export const META_TYPES = Object.freeze({
  0x00: 'sequenceNumber',
  0x01: 'text',
  0x02: 'copyright',
  0x03: 'trackName',
  0x04: 'instrumentName',
  0x05: 'lyric',
  0x06: 'marker',
  0x07: 'cuePoint',
  0x08: 'programName',
  0x09: 'deviceName',
  0x20: 'channelPrefix',
  0x21: 'midiPort',
  0x2f: 'endOfTrack',
  0x51: 'setTempo',
  0x54: 'smpteOffset',
  0x58: 'timeSignature',
  0x59: 'keySignature',
  0x7f: 'sequencerSpecific',
});

const TEXT_META = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);

const CHANNEL_MESSAGES = Object.freeze({
  0x8: { name: 'noteOff', dataBytes: 2 },
  0x9: { name: 'noteOn', dataBytes: 2 },
  0xa: { name: 'polyAftertouch', dataBytes: 2 },
  0xb: { name: 'controlChange', dataBytes: 2 },
  0xc: { name: 'programChange', dataBytes: 1 },
  0xd: { name: 'channelAftertouch', dataBytes: 1 },
  0xe: { name: 'pitchBend', dataBytes: 2 },
});

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

// Latin-1 rather than UTF-8: the SMF spec does not define an encoding for text
// meta events, and decoding as UTF-8 would corrupt bytes that are not valid
// UTF-8 sequences. The raw bytes are kept alongside so nothing is lost either
// way, and a caller that knows the file's real encoding can re-decode them.
const latin1 = bytes => Array.from(bytes, b => String.fromCharCode(b)).join('');

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  get remaining() { return this.bytes.length - this.pos; }

  take(n) {
    if (n < 0) throw Error('negative read length');
    if (this.pos + n > this.bytes.length) throw Error(`truncated MIDI data: needed ${n} byte(s) at offset ${this.pos}, ${this.remaining} remain`);
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  byte() { return this.take(1)[0]; }

  uint(n) { return Array.from(this.take(n)).reduce((a, b) => a * 256 + b, 0); }

  ascii(n) { return latin1(this.take(n)); }

  // Variable-length quantity. The SMF spec caps these at four bytes; a fifth
  // continuation byte means the stream is not a valid VLQ, which is an error
  // about framing rather than about one event, so it throws.
  varint() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = value * 128 + (b & 0x7f);
      if (b < 0x80) return value;
    }
    throw Error(`invalid variable-length quantity at offset ${this.pos - 4}`);
  }
}

function decodeMeta(type, data, record) {
  const name = META_TYPES[type] ?? null;
  record.metaType = type;
  record.metaName = name;

  if (TEXT_META.has(type)) {
    record.text = latin1(data);
    return;
  }
  switch (type) {
    case 0x00:
      if (data.length === 2) record.sequenceNumber = data[0] * 256 + data[1];
      break;
    case 0x20:
      if (data.length === 1) record.channelPrefix = data[0];
      break;
    case 0x21:
      if (data.length === 1) record.port = data[0];
      break;
    case 0x51:
      if (data.length === 3) record.microsecondsPerQuarter = data[0] * 65536 + data[1] * 256 + data[2];
      break;
    case 0x54:
      if (data.length === 5) {
        record.smpte = { hour: data[0], minute: data[1], second: data[2], frame: data[3], subframe: data[4] };
      }
      break;
    case 0x58:
      if (data.length === 4) {
        record.timeSignature = {
          numerator: data[0],
          // Stored as a negative power of two: 2 means 2^2 = 4, a quarter.
          denominator: 2 ** data[1],
          clocksPerClick: data[2],
          thirtySecondsPerQuarter: data[3],
        };
      }
      break;
    case 0x59:
      if (data.length === 2) {
        // First byte is signed: negative counts flats, positive counts sharps.
        record.keySignature = { sharps: (data[0] << 24) >> 24, minor: data[1] === 1 };
      }
      break;
    default:
      break;
  }
}

// Reads one MTrk body. Structural damage is recorded rather than thrown: a
// track that stops decoding halfway still yields every event decoded before
// the damage, which is the evidence a later reviewer needs to judge the file.
function readTrack(bytes, trackIndex, anomalies) {
  const cursor = new Cursor(bytes);
  const events = [];
  let tick = 0;
  let runningStatus = null;
  let sawEndOfTrack = false;

  const note = (code, detail) => anomalies.push({ code, trackIndex, eventIndex: events.length, ...detail });

  while (cursor.remaining > 0) {
    const eventOffset = cursor.pos;
    let delta;
    try {
      delta = cursor.varint();
    } catch (error) {
      note('TRACK_TRUNCATED', { offset: eventOffset, message: error.message });
      break;
    }
    tick += delta;

    const record = {
      trackIndex,
      eventIndex: events.length,
      tick,
      delta,
      offset: eventOffset,
    };

    try {
      let status = cursor.byte();

      if (status < 0x80) {
        // Running status: the byte just read is the first data byte and the
        // previous channel status still applies. A data byte with no running
        // status to inherit is unrecoverable for this track's framing.
        if (runningStatus === null) {
          note('RUNNING_STATUS_WITHOUT_STATUS', { offset: eventOffset, byte: status });
          break;
        }
        cursor.pos -= 1;
        status = runningStatus;
        record.runningStatus = true;
      } else if (status < 0xf0) {
        runningStatus = status;
      } else {
        // System messages cancel running status.
        runningStatus = null;
      }

      if (status === 0xff) {
        const type = cursor.byte();
        const length = cursor.varint();
        const data = cursor.take(length);
        record.kind = 'meta';
        record.raw = hex(data);
        decodeMeta(type, data, record);
        if (type === 0x2f) {
          sawEndOfTrack = true;
          events.push(record);
          if (cursor.remaining > 0) note('DATA_AFTER_END_OF_TRACK', { offset: cursor.pos, bytes: cursor.remaining });
          break;
        }
        if (META_TYPES[type] === undefined) note('UNKNOWN_META_TYPE', { offset: eventOffset, metaType: type, length });
      } else if (status === 0xf0 || status === 0xf7) {
        const length = cursor.varint();
        const data = cursor.take(length);
        record.kind = 'sysex';
        record.sysexType = status === 0xf0 ? 'normal' : 'escape';
        record.raw = hex(data);
      } else if (status >= 0x80 && status < 0xf0) {
        const high = status >> 4;
        const spec = CHANNEL_MESSAGES[high];
        record.kind = 'channel';
        record.messageType = spec.name;
        record.channel = status & 0x0f;
        const data = cursor.take(spec.dataBytes);
        record.raw = hex(data);
        if (spec.dataBytes === 2) {
          record.data1 = data[0];
          record.data2 = data[1];
        } else {
          record.data1 = data[0];
          record.data2 = null;
        }
        if (data.some(b => b > 0x7f)) note('DATA_BYTE_WITH_HIGH_BIT', { offset: eventOffset, messageType: spec.name });
        if (spec.name === 'noteOn' || spec.name === 'noteOff') {
          record.noteNumber = record.data1;
          record.velocity = record.data2;
        } else if (spec.name === 'programChange') {
          record.program = record.data1;
        } else if (spec.name === 'controlChange') {
          record.controller = record.data1;
          record.value = record.data2;
        } else if (spec.name === 'pitchBend') {
          record.bend = record.data1 + record.data2 * 128 - 8192;
        }
      } else {
        // 0xF1-0xF6, 0xF8-0xFE are real-time / system-common messages that do
        // not belong in a file. Their length is not defined here, so decoding
        // cannot safely continue past one.
        record.kind = 'unknown';
        record.status = status;
        events.push(record);
        note('UNEXPECTED_SYSTEM_MESSAGE', { offset: eventOffset, status });
        break;
      }
      events.push(record);
    } catch (error) {
      note('TRACK_TRUNCATED', { offset: eventOffset, message: error.message });
      break;
    }
  }

  if (!sawEndOfTrack) anomalies.push({ code: 'MISSING_END_OF_TRACK', trackIndex });
  return { events, endTick: tick, sawEndOfTrack, bytesConsumed: cursor.pos, bytesDeclared: bytes.length };
}

function readDivision(raw) {
  // Bit 15 clear: ticks per quarter note. Bit 15 set: SMPTE, where the upper
  // byte is a negative frame rate and the lower byte is ticks per frame. SMPTE
  // division measures absolute time, not musical time, so it is decoded and
  // reported but cannot yield beats.
  if ((raw & 0x8000) === 0) return { type: 'ppq', ticksPerQuarter: raw, raw };
  const framesPerSecond = -((raw >> 8 << 24) >> 24);
  return { type: 'smpte', framesPerSecond, ticksPerFrame: raw & 0xff, raw };
}

export function decodeMidiFile(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : null;
  if (!bytes) throw Error('MIDI input must be a Uint8Array, ArrayBuffer, or TypedArray');
  if (bytes.length < 14) throw Error('MIDI input is too short to contain a header chunk');

  const cursor = new Cursor(bytes);
  const anomalies = [];

  if (cursor.ascii(4) !== 'MThd') throw Error('missing MThd header chunk');
  const headerLength = cursor.uint(4);
  if (headerLength < 6) throw Error(`MThd length must be at least 6; received ${headerLength}`);
  const format = cursor.uint(2);
  const declaredTrackCount = cursor.uint(2);
  const division = readDivision(cursor.uint(2));
  // A header longer than six bytes is legal and forward-compatible: skip the
  // surplus rather than treating the file as malformed, but record that it
  // existed so the extra bytes are not silently invisible.
  if (headerLength > 6) {
    const extra = cursor.take(headerLength - 6);
    anomalies.push({ code: 'EXTENDED_HEADER', bytes: extra.length, raw: hex(extra) });
  }

  if (division.type === 'ppq' && division.ticksPerQuarter === 0) {
    anomalies.push({ code: 'ZERO_TICKS_PER_QUARTER' });
  }

  const tracks = [];
  while (cursor.remaining >= 8) {
    const type = cursor.ascii(4);
    const length = cursor.uint(4);
    if (length > cursor.remaining) {
      anomalies.push({ code: 'CHUNK_LENGTH_EXCEEDS_FILE', chunkType: type, declared: length, available: cursor.remaining });
      const body = cursor.take(cursor.remaining);
      if (type === 'MTrk') tracks.push({ index: tracks.length, ...readTrack(body, tracks.length, anomalies) });
      break;
    }
    const body = cursor.take(length);
    if (type !== 'MTrk') {
      // Unrecognized chunk types are required by the spec to be skipped, but
      // skipping without a record would lose evidence of what was in the file.
      anomalies.push({ code: 'UNKNOWN_CHUNK', chunkType: type, bytes: length });
      continue;
    }
    const trackIndex = tracks.length;
    const track = readTrack(body, trackIndex, anomalies);
    if (track.bytesConsumed !== track.bytesDeclared) {
      anomalies.push({
        code: 'TRACK_BYTES_UNCONSUMED',
        trackIndex,
        consumed: track.bytesConsumed,
        declared: track.bytesDeclared,
      });
    }
    tracks.push({ index: trackIndex, ...track });
  }

  if (cursor.remaining > 0) anomalies.push({ code: 'TRAILING_BYTES', bytes: cursor.remaining });
  if (tracks.length !== declaredTrackCount) {
    anomalies.push({ code: 'TRACK_COUNT_MISMATCH', declared: declaredTrackCount, found: tracks.length });
  }

  return Object.freeze({
    format,
    declaredTrackCount,
    division: Object.freeze(division),
    tracks: Object.freeze(tracks.map(track => Object.freeze({
      index: track.index,
      endTick: track.endTick,
      sawEndOfTrack: track.sawEndOfTrack,
      events: Object.freeze(track.events.map(Object.freeze)),
    }))),
    anomalies: Object.freeze(anomalies.map(Object.freeze)),
    byteLength: bytes.length,
  });
}
