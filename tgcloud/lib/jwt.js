// tgcloud/lib/jwt.js — RS256 JWT signing for Google service accounts.
//
// The isolate is not Node: no `crypto` module, no `jsonwebtoken`. WebCrypto is
// used when the runtime exposes it; otherwise the signature is computed here in
// plain JavaScript (BigInt modular exponentiation + a local SHA-256), which is
// exactly what RSASSA-PKCS1-v1_5 with SHA-256 is. Both paths are verified
// against Node's crypto in the project tests.

import { utf8Encode, utf8Decode, bytesToBase64, base64ToBytes, pemToDer } from './encoding.js';

// ── SHA-256 (fallback implementation) ───────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string or Uint8Array → 32 bytes. */
export function sha256(input) {
  const bytes = input instanceof Uint8Array ? input : utf8Encode(String(input ?? ''));
  const bitLen = bytes.length * 8;
  const withPadding = bytes.length + 1 + ((bytes.length + 1) % 64 > 56 ? 128 - ((bytes.length + 1) % 64) : 64 - ((bytes.length + 1) % 64));
  const buffer = new Uint8Array(withPadding + 0);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  // 64-bit length, big-endian; the high word is only needed for >512MB inputs.
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(buffer.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256 as hex — handy for ids and cache keys. */
export function sha256Hex(input) {
  return Array.from(sha256(input))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Minimal DER reader (enough for PKCS#8 / PKCS#1 RSA keys) ────────────────

function readTlv(bytes, offset) {
  const tag = bytes[offset];
  let index = offset + 1;
  let length = bytes[index++];
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[index++];
  }
  return { tag, start: index, length, end: index + length };
}

const TAG_INTEGER = 0x02;
const TAG_SEQUENCE = 0x30;
const TAG_OCTET_STRING = 0x04;

function toBigInt(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

/**
 * Pull `{ n, d }` (modulus, private exponent) out of a PEM key, accepting both
 * PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1 ("BEGIN RSA PRIVATE KEY").
 */
export function parseRsaPrivateKey(pem) {
  const der = pemToDer(pem);
  const top = readTlv(der, 0);
  if (top.tag !== TAG_SEQUENCE) throw new Error('کلید خصوصی نامعتبر است (DER)');

  const outer = [];
  for (let offset = top.start; offset < top.end; ) {
    const tlv = readTlv(der, offset);
    outer.push(tlv);
    offset = tlv.end;
  }

  // PKCS#8: SEQUENCE { INTEGER version, SEQUENCE algorithm, OCTET STRING key }
  const isPkcs8 =
    outer.length >= 3 && outer[0].tag === TAG_INTEGER && outer[1].tag === TAG_SEQUENCE && outer[2].tag === TAG_OCTET_STRING;
  const seq = isPkcs8 ? readTlv(der, outer[2].start) : top;
  if (seq.tag !== TAG_SEQUENCE) throw new Error('محتوای کلید خصوصی نامعتبر است');

  // RSAPrivateKey: version, n, e, d, p, q, dp, dq, qinv
  const items = [];
  for (let offset = seq.start; offset < seq.end; ) {
    const tlv = readTlv(der, offset);
    items.push(tlv);
    offset = tlv.end;
  }
  if (items.length < 4) throw new Error('ساختار کلید RSA ناقص است');

  const part = (i) => der.slice(items[i].start, items[i].end);
  const n = toBigInt(part(1));
  const e = toBigInt(part(2));
  const d = toBigInt(part(3));
  if (!n || !d || !e) throw new Error('کلید RSA قابل خواندن نیست');
  return { n, e, d };
}

// ── RSASSA-PKCS1-v1_5 (SHA-256) in plain JS ─────────────────────────────────

// DigestInfo prefix for SHA-256 (RFC 8017 §9.2).
const SHA256_DIGEST_INFO = new Uint8Array([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
  0x00, 0x04, 0x20,
]);

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function bigIntToBytes(value, length) {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** RSASSA-PKCS1-v1_5 signature of `message` with a parsed RSA key. */
export function rsaSignSha256(message, { n, d }) {
  const digest = sha256(message);
  const keyLength = Math.ceil(countBits(n) / 8);
  const tLen = SHA256_DIGEST_INFO.length + digest.length;
  if (keyLength < tLen + 11) throw new Error('کلید RSA برای امضای SHA-256 کوتاه است');

  const em = new Uint8Array(keyLength);
  em[0] = 0x00;
  em[1] = 0x01;
  const psLength = keyLength - tLen - 3;
  em.fill(0xff, 2, 2 + psLength);
  em[2 + psLength] = 0x00;
  em.set(SHA256_DIGEST_INFO, 3 + psLength);
  em.set(digest, 3 + psLength + SHA256_DIGEST_INFO.length);

  const m = toBigInt(em);
  const s = modPow(m, d, n);
  return bigIntToBytes(s, keyLength);
}

function countBits(value) {
  let v = value;
  let bits = 0;
  while (v > 0n) {
    v >>= 1n;
    bits++;
  }
  return bits;
}

// ── JWT ─────────────────────────────────────────────────────────────────────

function base64UrlOfJson(object) {
  return bytesToBase64(utf8Encode(JSON.stringify(object)), { urlSafe: true, pad: false });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sign a JWT with the RS256 algorithm.
 * Uses WebCrypto when the isolate provides it, else the local implementation.
 */
export async function signJwt(payload, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64UrlOfJson(header)}.${base64UrlOfJson(payload)}`;
  const data = utf8Encode(signingInput);

  const subtle = globalThis?.crypto?.subtle;
  let signature;
  if (subtle && typeof subtle.importKey === 'function') {
    try {
      const key = await subtle.importKey(
        'pkcs8',
        pemToDer(privateKeyPem),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, data);
      signature = new Uint8Array(sig);
    } catch (err) {
      // Some runtimes expose crypto.subtle but refuse RSASSA keys — fall through.
      signature = rsaSignSha256(data, parseRsaPrivateKey(privateKeyPem));
    }
  } else {
    signature = rsaSignSha256(data, parseRsaPrivateKey(privateKeyPem));
  }

  return `${signingInput}.${bytesToBase64(signature, { urlSafe: true, pad: false })}`;
}

/**
 * Google service-account assertion for the OAuth2 token endpoint.
 * https://developers.google.com/identity/protocols/oauth2/service-account
 */
export async function createServiceAccountAssertion(account, scopes, { lifetimeSeconds = 3600 } = {}) {
  if (!account?.client_email || !account?.private_key) {
    throw new Error('کلید سرویس‌اکانت گوگل ناقص است (client_email / private_key)');
  }
  const iat = nowSeconds();
  return signJwt(
    {
      iss: account.client_email,
      scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes || ''),
      aud: account.token_uri || 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + lifetimeSeconds,
    },
    account.private_key
  );
}

/** Decode a JWT without verifying it — used for local debugging only. */
export function decodeJwt(token) {
  const [header, payload] = String(token || '').split('.');
  const decode = (part) => JSON.parse(utf8Decode(base64ToBytes(part)));
  return { header: decode(header), payload: decode(payload) };
}
