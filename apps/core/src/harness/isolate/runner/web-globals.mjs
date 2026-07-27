/**
 * Web globals a bare V8 isolate lacks but ordinary bundles assume: text codecs,
 * base64, URL/URLSearchParams and crypto. Exported as source because it has to
 * be evaluated inside the isolate; runner.mjs installs it before the tool module
 * evaluates. Web Streams are deliberately absent — a bundle that needs them is
 * classified onto the sandbox tier instead of getting a half-built one here.
 */

// $0 parses/mutates a URL on the host so the isolate inherits Node's WHATWG
// parser rather than a hand-rolled one; $1 is host entropy for crypto.
export const WEB_GLOBALS_SOURCE = `
const __asBytes = (input) => {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("decode expects an ArrayBuffer or a view over one");
};

globalThis.TextEncoder = class TextEncoder {
  get encoding() { return "utf-8"; }
  encode(input) {
    const source = input === undefined ? "" : String(input);
    const bytes = [];
    for (let index = 0; index < source.length; index += 1) {
      let point = source.charCodeAt(index);
      if (point >= 0xd800 && point <= 0xdbff) {
        const low = source.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
          index += 1;
        } else {
          point = 0xfffd;
        }
      } else if (point >= 0xdc00 && point <= 0xdfff) {
        point = 0xfffd;
      }
      if (point < 0x80) {
        bytes.push(point);
      } else if (point < 0x800) {
        bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      } else if (point < 0x10000) {
        bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      } else {
        bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  }
  encodeInto(source, destination) {
    const encoded = this.encode(source);
    const written = Math.min(encoded.length, destination.length);
    destination.set(encoded.subarray(0, written));
    return { read: source.length, written: written };
  }
};

// Only utf-8: it is what every bundle in this position asks for, and a label
// registry is not worth carrying into an isolate.
globalThis.TextDecoder = class TextDecoder {
  constructor(label, options) {
    const encoding = String(label === undefined ? "utf-8" : label).toLowerCase();
    if (encoding !== "utf-8" && encoding !== "utf8" && encoding !== "unicode-1-1-utf-8") {
      throw new RangeError("custom tool isolates only decode utf-8");
    }
    this.encoding = "utf-8";
    this.fatal = Boolean(options && options.fatal);
    this.ignoreBOM = Boolean(options && options.ignoreBOM);
    this.__pending = new Uint8Array(0);
    this.__sawFirstChunk = false;
  }
  decode(input, options) {
    const stream = Boolean(options && options.stream);
    let bytes = __asBytes(input);
    if (this.__pending.length > 0) {
      const merged = new Uint8Array(this.__pending.length + bytes.length);
      merged.set(this.__pending);
      merged.set(bytes, this.__pending.length);
      bytes = merged;
      this.__pending = new Uint8Array(0);
    }
    let out = "";
    let index = 0;
    while (index < bytes.length) {
      const lead = bytes[index];
      if (lead < 0x80) {
        out += String.fromCharCode(lead);
        index += 1;
        continue;
      }
      let needed;
      let point;
      if (lead >= 0xc2 && lead <= 0xdf) {
        needed = 1;
        point = lead & 0x1f;
      } else if (lead >= 0xe0 && lead <= 0xef) {
        needed = 2;
        point = lead & 0x0f;
      } else if (lead >= 0xf0 && lead <= 0xf4) {
        needed = 3;
        point = lead & 0x07;
      } else {
        out += this.__bad();
        index += 1;
        continue;
      }
      // A sequence split across chunk boundaries is held back rather than
      // replaced, which is the whole point of { stream: true }.
      if (index + needed >= bytes.length) {
        if (stream) {
          this.__pending = bytes.slice(index);
          break;
        }
        out += this.__bad();
        index += 1;
        continue;
      }
      let valid = true;
      for (let offset = 1; offset <= needed; offset += 1) {
        const byte = bytes[index + offset];
        if ((byte & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        point = (point << 6) | (byte & 0x3f);
      }
      if (!valid) {
        out += this.__bad();
        index += 1;
        continue;
      }
      index += needed + 1;
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
        out += this.__bad();
      } else if (point > 0xffff) {
        const rest = point - 0x10000;
        out += String.fromCharCode(0xd800 + (rest >> 10), 0xdc00 + (rest & 0x3ff));
      } else {
        out += String.fromCharCode(point);
      }
    }
    if (!this.__sawFirstChunk) {
      this.__sawFirstChunk = true;
      if (!this.ignoreBOM && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
    }
    if (!stream) {
      this.__pending = new Uint8Array(0);
      this.__sawFirstChunk = false;
    }
    return out;
  }
  __bad() {
    if (this.fatal) throw new TypeError("The encoded data was not valid utf-8");
    return "\\uFFFD";
  }
};

const __BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

globalThis.btoa = (input) => {
  const source = String(input);
  let out = "";
  for (let index = 0; index < source.length; index += 3) {
    const a = source.charCodeAt(index);
    const b = source.charCodeAt(index + 1);
    const c = source.charCodeAt(index + 2);
    if (a > 0xff || b > 0xff || c > 0xff) throw new TypeError("btoa expects latin1 input");
    const group = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    out += __BASE64[(group >> 18) & 0x3f] + __BASE64[(group >> 12) & 0x3f];
    out += Number.isNaN(b) ? "=" : __BASE64[(group >> 6) & 0x3f];
    out += Number.isNaN(c) ? "=" : __BASE64[group & 0x3f];
  }
  return out;
};

globalThis.atob = (input) => {
  const source = String(input).replace(/[ \\t\\n\\f\\r]/g, "").replace(/=+$/, "");
  if (source.length % 4 === 1) throw new TypeError("atob received invalid base64");
  let out = "";
  let bits = 0;
  let held = 0;
  for (const character of source) {
    const value = __BASE64.indexOf(character);
    if (value < 0) throw new TypeError("atob received invalid base64");
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((held >> bits) & 0xff);
    }
  }
  return out;
};

const __FORM_SAFE = /[A-Za-z0-9*\\-._]/;
const __formEncode = (value) => {
  let out = "";
  for (const byte of new globalThis.TextEncoder().encode(String(value))) {
    const character = String.fromCharCode(byte);
    if (__FORM_SAFE.test(character)) out += character;
    else if (byte === 0x20) out += "+";
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
};

const __formDecode = (value) => {
  const bytes = [];
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "+") {
      bytes.push(0x20);
    } else if (character === "%" && source.length - index >= 3) {
      const hex = source.slice(index + 1, index + 3);
      const parsed = Number.parseInt(hex, 16);
      if (hex.length === 2 && Number.isFinite(parsed)) {
        bytes.push(parsed);
        index += 2;
      } else {
        bytes.push(character.charCodeAt(0));
      }
    } else {
      for (const byte of new globalThis.TextEncoder().encode(character)) bytes.push(byte);
    }
  }
  return new globalThis.TextDecoder().decode(new Uint8Array(bytes));
};

globalThis.URLSearchParams = class URLSearchParams {
  constructor(init) {
    this.__pairs = [];
    this.__onChange = null;
    if (init instanceof globalThis.URLSearchParams) {
      this.__pairs = init.__pairs.map((pair) => [pair[0], pair[1]]);
    } else if (Array.isArray(init)) {
      for (const pair of init) this.__pairs.push([String(pair[0]), String(pair[1])]);
    } else if (init && typeof init === "object") {
      for (const key of Object.keys(init)) this.__pairs.push([key, String(init[key])]);
    } else if (init !== undefined && init !== null && String(init) !== "") {
      for (const part of String(init).replace(/^\\?/, "").split("&")) {
        if (!part) continue;
        const split = part.indexOf("=");
        const key = split < 0 ? part : part.slice(0, split);
        const value = split < 0 ? "" : part.slice(split + 1);
        this.__pairs.push([__formDecode(key), __formDecode(value)]);
      }
    }
  }
  get size() { return this.__pairs.length; }
  append(name, value) { this.__pairs.push([String(name), String(value)]); this.__changed(); }
  delete(name) {
    const key = String(name);
    this.__pairs = this.__pairs.filter((pair) => pair[0] !== key);
    this.__changed();
  }
  entries() { return this.__pairs.map((pair) => [pair[0], pair[1]])[Symbol.iterator](); }
  forEach(callback, thisArg) {
    for (const pair of this.__pairs.slice()) callback.call(thisArg, pair[1], pair[0], this);
  }
  get(name) {
    const found = this.__pairs.find((pair) => pair[0] === String(name));
    return found ? found[1] : null;
  }
  getAll(name) { return this.__pairs.filter((pair) => pair[0] === String(name)).map((pair) => pair[1]); }
  has(name) { return this.__pairs.some((pair) => pair[0] === String(name)); }
  keys() { return this.__pairs.map((pair) => pair[0])[Symbol.iterator](); }
  set(name, value) {
    const key = String(name);
    const at = this.__pairs.findIndex((pair) => pair[0] === key);
    if (at < 0) {
      this.__pairs.push([key, String(value)]);
    } else {
      this.__pairs[at] = [key, String(value)];
      this.__pairs = this.__pairs.filter((pair, index) => index === at || pair[0] !== key);
    }
    this.__changed();
  }
  sort() { this.__pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)); this.__changed(); }
  toString() { return this.__pairs.map((pair) => __formEncode(pair[0]) + "=" + __formEncode(pair[1])).join("&"); }
  values() { return this.__pairs.map((pair) => pair[1])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  __changed() { if (this.__onChange) this.__onChange(this.toString()); }
};

const __URL_PARTS = ["href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash", "origin"];

globalThis.URL = class URL {
  constructor(input, base) {
    this.__apply($0(String(input), base === undefined || base === null ? null : String(base), null, null));
  }
  static canParse(input, base) {
    return $0(String(input), base === undefined || base === null ? null : String(base), null, null) !== null;
  }
  get searchParams() {
    if (!this.__searchParams) {
      this.__searchParams = new globalThis.URLSearchParams(this.__parts.search);
      this.__searchParams.__onChange = (value) => this.__set("search", value);
    }
    return this.__searchParams;
  }
  toJSON() { return this.__parts.href; }
  toString() { return this.__parts.href; }
  __apply(parts) {
    if (parts === null) throw new TypeError("Invalid URL");
    this.__parts = parts;
    this.__searchParams = null;
  }
  // Every mutation round-trips through the host parser, so a setter behaves the
  // way Node's does instead of the way a string splice would.
  __set(key, value) {
    this.__apply($0(this.__parts.href, null, key, String(value)));
  }
};

for (const part of __URL_PARTS) {
  Object.defineProperty(globalThis.URL.prototype, part, {
    configurable: true,
    enumerable: true,
    get() { return this.__parts[part]; },
    set(value) { if (part !== "origin") this.__set(part, value); },
  });
}

globalThis.crypto = {
  getRandomValues: (view) => {
    if (!ArrayBuffer.isView(view)) throw new TypeError("getRandomValues expects a typed array");
    const bytes = $1(view.byteLength);
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
    return view;
  },
  randomUUID: () => {
    const bytes = new Uint8Array($1(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  },
};

globalThis.navigator = { userAgent: "Broods-Isolate" };
`;
