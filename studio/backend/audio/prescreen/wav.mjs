// RIFF/WAVE PCM decoding for the original-audio similarity metric. Pure.
//
// Status: IMPLEMENTATION NOTES. The service has no decoder for compressed
// audio (MP3, AAC, Ogg, FLAC) in Node, and the prescreen adds no dependency to
// get one. It reads uncompressed WAVE only: integer PCM (8/16/24/32-bit) and
// IEEE float (32/64-bit), including WAVE_FORMAT_EXTENSIBLE with those
// subformats. Anything else is reported as unsupported, and the metric is then
// ORIGINAL_AUDIO_METRIC_UNAVAILABLE rather than approximated.

const text = (view, offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, length));

export const WAV_UNSUPPORTED = 'UNSUPPORTED_AUDIO_ENCODING';

/** Decode a WAVE file to mono float samples, or return { ok: false, reason }. */
export function decodeWav(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength < 44) return { ok: false, reason: WAV_UNSUPPORTED };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (text(view, 0, 4) !== 'RIFF' || text(view, 8, 4) !== 'WAVE') return { ok: false, reason: WAV_UNSUPPORTED };
  let offset = 12;
  let format = null;
  let payload = null;
  while (offset + 8 <= data.byteLength) {
    const id = text(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > data.byteLength && id !== 'data') break;
    if (id === 'fmt ' && size >= 16) {
      let tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (tag === 0xfffe && size >= 40) tag = view.getUint16(body + 24, true);
      format = { tag, channels, sampleRate, bits };
    } else if (id === 'data') {
      payload = { offset: body, size: Math.min(size, data.byteLength - body) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || !payload) return { ok: false, reason: WAV_UNSUPPORTED };
  const { tag, channels, sampleRate, bits } = format;
  const pcm = tag === 1 && [8, 16, 24, 32].includes(bits);
  const float = tag === 3 && [32, 64].includes(bits);
  if ((!pcm && !float) || channels < 1 || channels > 16 || sampleRate < 8000 || sampleRate > 192000) return { ok: false, reason: WAV_UNSUPPORTED };
  const width = bits / 8;
  const frames = Math.floor(payload.size / (width * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = payload.offset + (i * channels + c) * width;
      let v;
      if (float) v = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      else if (bits === 8) v = (view.getUint8(at) - 128) / 128;
      else if (bits === 16) v = view.getInt16(at, true) / 32768;
      else if (bits === 24) v = (((view.getUint8(at + 2) << 24) | (view.getUint8(at + 1) << 16) | (view.getUint8(at) << 8)) >> 8) / 8388608;
      else v = view.getInt32(at, true) / 2147483648;
      sum += v;
    }
    mono[i] = sum / channels;
  }
  return { ok: true, sampleRate, channels, frames, mono };
}

/** A 16-bit PCM mono WAVE file (used by tests to build a recording). */
export function encodeWav16(samples, sampleRate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return bytes;
}
