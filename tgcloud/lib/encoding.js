// tgcloud/lib/encoding.js — UTF-8 and base64 without Node built-ins.
//
// GitHub's contents API takes base64, Google's JWT needs base64url of DER
// bytes. `btoa`/`Buffer` are not guaranteed in the isolate, so both directions
// are implemented here on plain Uint8Array.

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const hasTextEncoder = typeof TextEncoder === 'function' && typeof TextDecoder === 'function';

/** String → Uint8Array (UTF-8). */
export function utf8Encode(input) {
  const str = String(input ?? '');
  if (hasTextEncoder) return new TextEncoder().encode(str);
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.codePointAt(i);
    if (code > 0xffff) i++;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

/** Uint8Array (UTF-8) → string. */
export function utf8Decode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (hasTextEncoder) return new TextDecoder('utf-8', { fatal: false }).decode(arr);
  let out = '';
  for (let i = 0; i < arr.length; ) {
    const b = arr[i++];
    let code;
    if (b < 0x80) code = b;
    else if (b < 0xe0) code = ((b & 0x1f) << 6) | (arr[i++] & 0x3f);
    else if (b < 0xf0) code = ((b & 0x0f) << 12) | ((arr[i++] & 0x3f) << 6) | (arr[i++] & 0x3f);
    else code = ((b & 0x07) << 18) | ((arr[i++] & 0x3f) << 12) | ((arr[i++] & 0x3f) << 6) | (arr[i++] & 0x3f);
    out += String.fromCodePoint(code);
  }
  return out;
}

/** Bytes → base64 (with or without padding). */
export function bytesToBase64(bytes, { urlSafe = false, pad = true } = {}) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let out = '';
  for (let i = 0; i < arr.length; i += 3) {
    const b0 = arr[i];
    const b1 = arr[i + 1];
    const b2 = arr[i + 2];
    const has1 = i + 1 < arr.length;
    const has2 = i + 2 < arr.length;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 0x03) << 4) | (has1 ? b1 >> 4 : 0)];
    out += has1 ? B64_CHARS[((b1 & 0x0f) << 2) | (has2 ? b2 >> 6 : 0)] : '=';
    out += has2 ? B64_CHARS[b2 & 0x3f] : '=';
  }
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_');
  return pad ? out : out.replace(/=+$/, '');
}

/** Base64 (standard or url-safe) → bytes. Throws on invalid input. */
export function base64ToBytes(input) {
  const clean = String(input ?? '')
    .replace(/^data:[^,]*,/, '') // tolerate data: URLs
    .replace(/[\s]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  if (!clean) return new Uint8Array(0);
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B64_CHARS.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base64 input');
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** String → base64 (UTF-8 aware, so Persian text survives). */
export function utf8ToBase64(str, opts) {
  return bytesToBase64(utf8Encode(str), opts);
}

/** base64 → string (UTF-8 aware). */
export function base64ToUtf8(b64) {
  return utf8Decode(base64ToBytes(b64));
}

/** Base64 of a PEM body (headers/footers/whitespace removed) → DER bytes. */
export function pemToDer(pem) {
  const body = String(pem ?? '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\s/g, '');
  return base64ToBytes(body);
}
