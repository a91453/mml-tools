// Listen links: `<studio-web-origin>/#listen=<payload>` (also `?listen=`).
//
// payload = base64url (no padding) of deflate-raw of the UTF-8 JSON below.
// Shared contract with the MCP sending side; the golden vectors live in
// studio/tests/fixtures/listen-link-vectors.json.
//
//   { "schema": "mml-studio/listen-link@1",
//     "mml": "MML@…;",                         required, full six-role text
//     "title": "…",                             optional, ≤120 characters
//     "meter_text": "0 2/4\n2 4/4",             optional, "<beat> <n>/<d>" per line
//     "start": { "bar": 23 } | { "beat": "88" }, optional, beat in quarter beats
//     "markers": [ { "beat", "end_beat"?, "role"?, "kind", "label"? } ],  ≤500
//     "compare_mml": "MML@…;",                 optional previous version
//     "source": { "project_id"?, "artifact_id"? } }  optional, display only
//
// Everything in a link is untrusted text. This module only validates and
// normalises it: nothing here executes, fetches or renders anything, and the
// page escapes every string it shows. A link is data for a listening session,
// never evidence, a review or an acceptance.
//
// Pure apart from the default codec, which uses the platform's
// CompressionStream / DecompressionStream ('deflate-raw'). Node tests pass a
// zlib codec instead; both produce and read the same format.

export const LISTEN_LINK_SCHEMA = 'mml-studio/listen-link@1';
export const LISTEN_LIMITS = Object.freeze({
  jsonBytes: 262144,
  mmlChars: 40000,
  titleChars: 120,
  markers: 500,
  labelChars: 200,
  meterChars: 4000,
  meterLines: 256,
  idChars: 200,
  // A 256 KiB document that does not compress at all still fits.
  payloadChars: 400000,
  maxBar: 10000,
});
export const MARKER_KINDS = Object.freeze(['provisional-release', 'lead-unverified', 'pending', 'changed', 'note']);
export const LISTEN_ROLES = Object.freeze(['Melody', 'Chord1', 'Chord2', 'Chord3', 'Chord4', 'Chord5']);

export class ListenLinkError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ListenLinkError';
    this.code = code;
  }
}
const invalid = (field, why) => new ListenLinkError('LISTEN_LINK_INVALID', `${field} ${why}`);

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// Control characters never belong in a label, a title or an identifier.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A quarter-beat position: a non-negative integer or fraction, bounded so that
// exact arithmetic on it stays small.
const RATIONAL = /^(0|[1-9]\d{0,8})(?:\/([1-9]\d{0,8}))?$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const METER_LINE = /^(0|[1-9]\d{0,8})(?:\/([1-9]\d{0,8})|\.(\d{1,9}))?[ \t]+([1-9]\d{0,2})\/([1-9]\d{0,2})$/;

function rational(value, field) {
  if (typeof value !== 'string') throw invalid(field, 'must be a rational beat string');
  const match = RATIONAL.exec(value);
  if (!match) throw invalid(field, 'must be a non-negative integer or fraction such as "88" or "177/2"');
  return { n: BigInt(match[1]), d: BigInt(match[2] ?? '1') };
}
const cmpRational = (a, b) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };

function text(value, field, max) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  if (value.length > max) throw invalid(field, `exceeds ${max} characters`);
  if (CONTROL.test(value)) throw invalid(field, 'contains control characters');
  return value;
}

// Shape only. The MML parser decides what the string means; this refuses
// anything that cannot be a six-role MML@…; string at all.
function mmlText(value, field) {
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  const trimmed = value.trim();
  if (!trimmed.length) throw invalid(field, 'is empty');
  if (trimmed.length > LISTEN_LIMITS.mmlChars) throw invalid(field, `exceeds ${LISTEN_LIMITS.mmlChars} characters`);
  if (!/^[\x20-\x7e]+$/.test(trimmed)) throw invalid(field, 'may contain printable ASCII only');
  if (!/^MML@/i.test(trimmed) || !trimmed.endsWith(';')) throw invalid(field, 'must run from MML@ to ;');
  const roles = trimmed.slice(4, -1).split(',');
  if (roles.length !== 6) throw invalid(field, `must have six roles, found ${roles.length}`);
  return trimmed;
}

function meterText(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  if (value.length > LISTEN_LIMITS.meterChars) throw invalid(field, `exceeds ${LISTEN_LIMITS.meterChars} characters`);
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  if (lines.length > LISTEN_LIMITS.meterLines) throw invalid(field, `exceeds ${LISTEN_LIMITS.meterLines} lines`);
  let previous = null;
  lines.forEach((line, index) => {
    const match = METER_LINE.exec(line);
    if (!match) throw invalid(`${field} line ${index + 1}`, 'must be "<beat> <numerator>/<denominator>"');
    const numerator = Number(match[4]), denominator = Number(match[5]);
    if (numerator > 255 || denominator > 128 || (denominator & (denominator - 1)) !== 0) throw invalid(`${field} line ${index + 1}`, 'needs numerator 1–255 and a power-of-two denominator 1–128');
    const beat = match[3] !== undefined
      ? { n: BigInt(match[1] + match[3]), d: 10n ** BigInt(match[3].length) }
      : { n: BigInt(match[1]), d: BigInt(match[2] ?? '1') };
    if (index === 0 && beat.n !== 0n) throw invalid(field, 'must start at beat 0');
    if (previous && cmpRational(beat, previous) <= 0) throw invalid(`${field} line ${index + 1}`, 'must come after the previous line');
    previous = beat;
  });
  return lines.join('\n');
}

function start(value, field) {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw invalid(field, 'must be an object');
  const hasBar = own(value, 'bar'), hasBeat = own(value, 'beat');
  if (hasBar === hasBeat) throw invalid(field, 'needs exactly one of bar or beat');
  if (hasBar) {
    if (!Number.isInteger(value.bar) || value.bar < 1 || value.bar > LISTEN_LIMITS.maxBar) throw invalid(`${field}.bar`, `must be an integer 1–${LISTEN_LIMITS.maxBar}`);
    return { bar: value.bar };
  }
  rational(value.beat, `${field}.beat`);
  return { beat: value.beat };
}

function marker(value, field) {
  if (!plainObject(value)) throw invalid(field, 'must be an object');
  const begin = rational(value.beat, `${field}.beat`);
  const out = { beat: value.beat };
  if (value.end_beat !== undefined) {
    const end = rational(value.end_beat, `${field}.end_beat`);
    if (cmpRational(end, begin) < 0) throw invalid(`${field}.end_beat`, 'must not come before beat');
    out.end_beat = value.end_beat;
  }
  if (value.role !== undefined) {
    if (!LISTEN_ROLES.includes(value.role)) throw invalid(`${field}.role`, `must be one of ${LISTEN_ROLES.join(', ')}`);
    out.role = value.role;
  }
  if (!MARKER_KINDS.includes(value.kind)) throw invalid(`${field}.kind`, `must be one of ${MARKER_KINDS.join(', ')}`);
  out.kind = value.kind;
  const label = text(value.label, `${field}.label`, LISTEN_LIMITS.labelChars);
  if (label !== undefined) out.label = label;
  return out;
}

function source(value, field) {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw invalid(field, 'must be an object');
  const out = {};
  for (const key of ['project_id', 'artifact_id']) {
    if (value[key] === undefined) continue;
    const id = text(value[key], `${field}.${key}`, LISTEN_LIMITS.idChars);
    if (!id.length || !IDENTIFIER.test(id)) throw invalid(`${field}.${key}`, 'may contain letters, digits and . _ : - only');
    out[key] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Validate a decoded link document and return a normalised copy in the
 * contract's key order. Unknown keys are dropped, never carried. Throws a
 * ListenLinkError naming the first field that is wrong.
 */
export function validateListenLink(value) {
  if (!plainObject(value)) throw invalid('link', 'must be a JSON object');
  if (value.schema !== LISTEN_LINK_SCHEMA) throw new ListenLinkError('LISTEN_LINK_UNKNOWN_SCHEMA', typeof value.schema === 'string' ? value.schema.slice(0, 80) : 'missing');
  const out = { schema: LISTEN_LINK_SCHEMA, mml: mmlText(value.mml, 'mml') };
  const title = text(value.title, 'title', LISTEN_LIMITS.titleChars);
  if (title !== undefined && title.trim()) out.title = title.trim();
  const meter = meterText(value.meter_text, 'meter_text');
  if (meter !== undefined) out.meter_text = meter;
  const begin = start(value.start, 'start');
  if (begin !== undefined) out.start = begin;
  if (value.markers !== undefined) {
    if (!Array.isArray(value.markers)) throw invalid('markers', 'must be an array');
    if (value.markers.length > LISTEN_LIMITS.markers) throw invalid('markers', `exceeds ${LISTEN_LIMITS.markers} entries`);
    if (value.markers.length) out.markers = value.markers.map((item, index) => marker(item, `markers[${index}]`));
  }
  if (value.compare_mml !== undefined) out.compare_mml = mmlText(value.compare_mml, 'compare_mml');
  const provenance = source(value.source, 'source');
  if (provenance !== undefined) out.source = provenance;
  return out;
}

// ─── base64url (RFC 4648 §5, no padding) ────────────────────────────────────
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));
export function base64UrlEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 63];
  }
  return out;
}
export function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new ListenLinkError('LISTEN_LINK_CORRUPT', 'payload is not base64url without padding');
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = LOOKUP.get(value[i]), b = LOOKUP.get(value[i + 1]);
    const c = i + 2 < value.length ? LOOKUP.get(value[i + 2]) : undefined;
    const d = i + 3 < value.length ? LOOKUP.get(value[i + 3]) : undefined;
    out[o++] = (a << 2) | (b >> 4);
    if (c !== undefined) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d !== undefined) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

// ─── platform codec ─────────────────────────────────────────────────────────
async function readCapped(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // Stop reading as soon as the cap is passed: a small payload can inflate
    // to far more than any real listen link, and none of it is needed.
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', `decoded JSON exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
export const streamCodec = Object.freeze({
  deflateRaw: async bytes => readCapped(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')), Infinity),
  inflateRaw: async (bytes, maxBytes) => readCapped(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')), maxBytes),
});

/**
 * Encode a link document. It is validated and normalised first, so an encoded
 * link always decodes to the same document.
 */
export async function encodeListenLink(value, codec = streamCodec) {
  const normalized = validateListenLink(value);
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  if (bytes.length > LISTEN_LIMITS.jsonBytes) throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', `JSON is ${bytes.length} bytes, limit ${LISTEN_LIMITS.jsonBytes}`);
  const payload = base64UrlEncode(await codec.deflateRaw(bytes));
  if (payload.length > LISTEN_LIMITS.payloadChars) throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', `payload is ${payload.length} characters`);
  return payload;
}

/**
 * Decode a payload into a validated, normalised link document, or throw a
 * ListenLinkError (LISTEN_LINK_CORRUPT, LISTEN_LINK_TOO_LARGE,
 * LISTEN_LINK_UNKNOWN_SCHEMA or LISTEN_LINK_INVALID).
 */
export async function decodeListenLink(payload, codec = streamCodec) {
  if (typeof payload !== 'string' || !payload.length) throw new ListenLinkError('LISTEN_LINK_CORRUPT', 'payload is empty');
  if (payload.length > LISTEN_LIMITS.payloadChars) throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', `payload exceeds ${LISTEN_LIMITS.payloadChars} characters`);
  const compressed = base64UrlDecode(payload);
  let bytes;
  try { bytes = await codec.inflateRaw(compressed, LISTEN_LIMITS.jsonBytes); }
  catch (error) {
    if (error instanceof ListenLinkError) throw error;
    throw new ListenLinkError('LISTEN_LINK_CORRUPT', 'payload is not deflate-raw data');
  }
  // Checked again whatever the codec did: the cap is part of the contract.
  if (bytes.length > LISTEN_LIMITS.jsonBytes) throw new ListenLinkError('LISTEN_LINK_TOO_LARGE', `decoded JSON exceeds ${LISTEN_LIMITS.jsonBytes} bytes`);
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ListenLinkError('LISTEN_LINK_CORRUPT', 'payload is not UTF-8 JSON'); }
  return validateListenLink(document);
}

// ─── location handling ──────────────────────────────────────────────────────
const paramIn = (text, name) => {
  for (const part of text.split('&')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name) return part.slice(at + 1);
  }
  return null;
};

/** The listen payload carried by a URL, from `#listen=` first, then `?listen=`. */
export function listenPayloadFromUrl(href) {
  const url = new URL(href);
  const fromHash = url.hash.length > 1 ? paramIn(url.hash.slice(1), 'listen') : null;
  if (fromHash !== null) return { payload: fromHash, from: 'hash' };
  const fromQuery = url.searchParams.get('listen');
  if (fromQuery !== null) return { payload: fromQuery, from: 'query' };
  return null;
}

/** The same URL with every listen parameter removed, for history.replaceState. */
export function withoutListenPayload(href) {
  const url = new URL(href);
  if (url.hash.length > 1) {
    const rest = url.hash.slice(1).split('&').filter(part => !part.startsWith('listen='));
    url.hash = rest.length ? rest.join('&') : '';
  }
  url.searchParams.delete('listen');
  const out = url.toString();
  // URL keeps a bare '#' when the fragment becomes empty.
  return out.endsWith('#') ? out.slice(0, -1) : out;
}

/** `<base>#listen=<payload>`, where base is the Studio Web page without its fragment. */
export function listenUrl(base, payload) {
  const url = new URL(base);
  url.hash = '';
  url.searchParams.delete('listen');
  return `${url.toString().replace(/#$/, '')}#listen=${payload}`;
}
