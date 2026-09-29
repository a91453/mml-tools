// Host globals a bare JavaScriptCore context lacks.
//
// Status: IMPLEMENTATION NOTES. A native host (JSContext on iOS, the same C API
// elsewhere) evaluates only ECMAScript: TextEncoder, TextDecoder and
// structuredClone are Web APIs, not language built-ins, so they are absent
// there. The shared engines need them — dist/core.js constructs a TextEncoder
// when it is evaluated, studio/backend/source/sha256.mjs digests UTF-8 bytes,
// and every Application Service refusal clones its details — so without them
// the core would not evaluate, or would refuse with the wrong error.
//
// Text: UTF-8 only, following the WHATWG Encoding Standard: an encoder that replaces
// lone surrogates with U+FFFD, and a decoder with the standard's error handling
// (maximal-subpart replacement, or a TypeError when `fatal`) and BOM stripping
// unless `ignoreBOM`. Streaming decode is not implemented and is refused rather
// than approximated. Nothing here is installed where the host already provides
// the real API, so Node and browsers keep their own.
//
// This file must stay the first import of the native entry: modules evaluate in
// import order, and dist/core.js needs the encoder while it evaluates.

const REPLACEMENT = 0xfffd;

// Every label the Encoding Standard maps to UTF-8.
const UTF8_LABELS = new Set(['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8']);
const labelIsUtf8 = label => UTF8_LABELS.has(String(label).trim().toLowerCase());

function toBytes(input) {
  if (input === undefined) return new Uint8Array(0);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('TextDecoder.decode expects an ArrayBuffer or an ArrayBuffer view');
}

class Utf8TextEncoder {
  get encoding() { return 'utf-8'; }

  encode(input = '') {
    const text = String(input);
    const out = [];
    for (const character of text) {
      let point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) point = REPLACEMENT;
      if (point < 0x80) out.push(point);
      else if (point < 0x800) out.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      else if (point < 0x10000) out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      else out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    }
    return Uint8Array.from(out);
  }
}

class Utf8TextDecoder {
  #fatal;
  #ignoreBOM;

  constructor(label = 'utf-8', options = {}) {
    if (!labelIsUtf8(label)) throw new RangeError(`This host's TextDecoder supports UTF-8 only, not ${label}`);
    this.#fatal = Boolean(options?.fatal);
    this.#ignoreBOM = Boolean(options?.ignoreBOM);
  }

  get encoding() { return 'utf-8'; }
  get fatal() { return this.#fatal; }
  get ignoreBOM() { return this.#ignoreBOM; }

  decode(input, options = {}) {
    if (options?.stream) throw new TypeError("This host's TextDecoder does not implement streaming decode");
    const bytes = toBytes(input);
    const points = [];
    const error = () => {
      if (this.#fatal) throw new TypeError('The encoded data was not valid UTF-8');
      points.push(REPLACEMENT);
    };
    let needed = 0;
    let seen = 0;
    let point = 0;
    let lower = 0x80;
    let upper = 0xbf;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (needed === 0) {
        if (byte <= 0x7f) points.push(byte);
        else if (byte >= 0xc2 && byte <= 0xdf) { needed = 1; point = byte & 0x1f; }
        else if (byte >= 0xe0 && byte <= 0xef) {
          if (byte === 0xe0) lower = 0xa0;
          if (byte === 0xed) upper = 0x9f;
          needed = 2;
          point = byte & 0x0f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          if (byte === 0xf0) lower = 0x90;
          if (byte === 0xf4) upper = 0x8f;
          needed = 3;
          point = byte & 0x07;
        } else error();
        continue;
      }
      if (byte < lower || byte > upper) {
        // The byte ends the broken sequence and is read again on its own.
        needed = 0; seen = 0; point = 0; lower = 0x80; upper = 0xbf;
        error();
        index--;
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      point = (point << 6) | (byte & 0x3f);
      seen++;
      if (seen === needed) {
        points.push(point);
        needed = 0; seen = 0; point = 0;
      }
    }
    if (needed !== 0) error();
    if (!this.#ignoreBOM && points[0] === 0xfeff) points.shift();
    let text = '';
    for (let start = 0; start < points.length; start += 4096) text += String.fromCodePoint(...points.slice(start, start + 4096));
    return text;
  }
}

// structuredClone, for data values.
//
// The Application Service clones every refusal's details with it
// (application/contracts.mjs, StudioApplicationError), and the Canonical
// engines clone IR with it, so without it a structured refusal would surface
// as a ReferenceError instead of its code. This follows the HTML structured
// clone algorithm for the values the engines pass: primitives including
// BigInt, ordinary objects (own enumerable string keys, prototype dropped, as
// the algorithm specifies), arrays (length and own enumerable keys, so holes
// stay holes), Date, RegExp, Map, Set, ArrayBuffer, typed arrays, DataView,
// primitive wrappers and Error objects, with shared and cyclic references
// preserved. A function or symbol anywhere in the value throws DataCloneError,
// as the platform does. Transfer lists are refused rather than ignored.
class DataCloneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataCloneError';
  }
}

const ERROR_TYPES = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']);
const TYPED_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];

function cloneStructured(value, memory) {
  const type = typeof value;
  if (value === null || type === 'undefined' || type === 'boolean' || type === 'number' || type === 'string' || type === 'bigint') return value;
  if (type === 'symbol') throw new DataCloneError('A symbol could not be cloned');
  if (type === 'function') throw new DataCloneError(`${value.name || 'A function'} could not be cloned`);
  if (memory.has(value)) return memory.get(value);
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  const remember = copy => { memory.set(value, copy); return copy; };
  switch (tag) {
    case 'Boolean': return remember(Object(Boolean.prototype.valueOf.call(value)));
    case 'Number': return remember(Object(Number.prototype.valueOf.call(value)));
    case 'String': return remember(Object(String.prototype.valueOf.call(value)));
    case 'BigInt': return remember(Object(BigInt.prototype.valueOf.call(value)));
    case 'Date': return remember(new Date(Date.prototype.getTime.call(value)));
    case 'RegExp': return remember(new RegExp(value.source, value.flags));
    case 'ArrayBuffer': return remember(value.slice(0));
    case 'DataView': {
      const buffer = cloneStructured(value.buffer, memory);
      return remember(new DataView(buffer, value.byteOffset, value.byteLength));
    }
    case 'Map': {
      const copy = remember(new Map());
      for (const [key, item] of value) copy.set(cloneStructured(key, memory), cloneStructured(item, memory));
      return copy;
    }
    case 'Set': {
      const copy = remember(new Set());
      for (const item of value) copy.add(cloneStructured(item, memory));
      return copy;
    }
    case 'Error': {
      // Constructed with its message, so `message` keeps the non-enumerable
      // own property a platform error has; nothing else is copied but the stack.
      const name = ERROR_TYPES.has(value.name) ? value.name : 'Error';
      const hasMessage = Object.getOwnPropertyDescriptor(value, 'message') !== undefined;
      const copy = remember(hasMessage ? new globalThis[name](String(value.message)) : new globalThis[name]());
      if (typeof value.stack === 'string') Object.defineProperty(copy, 'stack', { value: value.stack, writable: true, configurable: true, enumerable: false });
      return copy;
    }
    default: break;
  }
  const typed = TYPED_ARRAYS.find(Type => value instanceof Type);
  if (typed) {
    const buffer = cloneStructured(value.buffer, memory);
    return remember(new typed(buffer, value.byteOffset, value.length));
  }
  if (Array.isArray(value)) {
    const copy = remember(new Array(value.length));
    for (const key of Object.keys(value)) copy[key] = cloneStructured(value[key], memory);
    return copy;
  }
  if (tag === 'Promise' || tag === 'WeakMap' || tag === 'WeakSet' || tag === 'WeakRef') throw new DataCloneError(`${tag} could not be cloned`);
  const copy = remember({});
  for (const key of Object.keys(value)) copy[key] = cloneStructured(value[key], memory);
  return copy;
}

function hostStructuredClone(value, options = undefined) {
  if (options?.transfer?.length) throw new DataCloneError("This host's structuredClone does not support transfer lists");
  return cloneStructured(value, new Map());
}

// The names this evaluation actually installed, reported in the native
// identity so a host that already had a global is distinguishable from one
// running these implementations.
const installed = [];
const install = (name, implementation) => {
  if (typeof globalThis[name] === 'function') return;
  globalThis[name] = implementation;
  installed.push(name);
};
install('TextEncoder', Utf8TextEncoder);
install('TextDecoder', Utf8TextDecoder);
install('structuredClone', hostStructuredClone);

export const INSTALLED_HOST_SHIMS = Object.freeze(installed);
export { DataCloneError, Utf8TextDecoder, Utf8TextEncoder, hostStructuredClone };
