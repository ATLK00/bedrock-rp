// Pure-JS SHA-256 + HMAC-SHA256 for the Minecraft Script API environment,
// which has no crypto/hash module. Verified (in Node) against RFC 4231
// vectors before being wired into main.js. Deliberately dependency-free
// and free of any Node-specific API.
//
// Exports: sha256Hex(str), hmacSha256Hex(key, str)

/* eslint-disable no-bitwise */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}
function shr(x, n) {
  return x >>> n;
}

function asBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function bytesToWords(bytes) {
  const words = new Array((bytes.length + 3) >> 2).fill(0);
  for (let i = 0; i < bytes.length; i++) {
    words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  }
  return words;
}

function sha256State(msgBytes) {
  const len = msgBytes.length;
  const bitLen = len * 8;
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  const padded = new Array(paddedLen).fill(0);
  for (let i = 0; i < len; i++) padded[i] = msgBytes[i];
  padded[len] = 0x80;
  // 64-bit big-endian bit length. High 32 bits (always 0 below 512 MB of
  // input) occupy paddedLen-8..-5; the low 32 bits go big-endian in -4..-1.
  padded[paddedLen - 8] = 0;
  padded[paddedLen - 7] = 0;
  padded[paddedLen - 6] = 0;
  padded[paddedLen - 5] = 0;
  padded[paddedLen - 4] = (bitLen >>> 24) & 0xff;
  padded[paddedLen - 3] = (bitLen >>> 16) & 0xff;
  padded[paddedLen - 2] = (bitLen >>> 8) & 0xff;
  padded[paddedLen - 1] = bitLen & 0xff;

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Array(64).fill(0);
  for (let o = 0; o < paddedLen; o += 64) {
    const chunk = padded.slice(o, o + 64);
    const m = bytesToWords(chunk);
    for (let t = 0; t < 16; t++) w[t] = m[t];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ shr(w[t - 15], 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ shr(w[t - 2], 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7];
}

function digestHex(hash) {
  let out = "";
  for (let i = 0; i < hash.length; i++) {
    out += (hash[i] >>> 24).toString(16).padStart(2, "0");
    out += ((hash[i] >> 16) & 0xff).toString(16).padStart(2, "0");
    out += ((hash[i] >> 8) & 0xff).toString(16).padStart(2, "0");
    out += (hash[i] & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

export function sha256Hex(str) {
  return digestHex(sha256State(asBytes(str)));
}

function xorBytes(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] ^ b[i]) & 0xff;
  return out;
}

function padKey(keyBytes) {
  // HMAC spec: a key longer than the block size is hashed first, then the
  // digest (32 bytes) is zero-padded to the 64-byte block size.
  if (keyBytes.length > 64) {
    const words = sha256State(keyBytes);
    const bytes = new Array(64).fill(0);
    for (let i = 0; i < words.length; i++) {
      bytes[i * 4] = (words[i] >>> 24) & 0xff;
      bytes[i * 4 + 1] = (words[i] >> 16) & 0xff;
      bytes[i * 4 + 2] = (words[i] >> 8) & 0xff;
      bytes[i * 4 + 3] = words[i] & 0xff;
    }
    return bytes;
  }
  const padded = new Array(64).fill(0);
  for (let i = 0; i < keyBytes.length; i++) padded[i] = keyBytes[i];
  return padded;
}

export function hmacSha256Hex(key, str) {
  const msgBytes = asBytes(str);
  const keyBytes = padKey(asBytes(key));
  const ipad = xorBytes(keyBytes, new Array(64).fill(0x36));
  const opad = xorBytes(keyBytes, new Array(64).fill(0x5c));
  // HMAC = H(opad || H(ipad || message)) — hash byte arrays directly.
  const innerWords = sha256State(ipad.concat(msgBytes));
  const innerBytes = [];
  for (let i = 0; i < innerWords.length; i++) {
    innerBytes.push((innerWords[i] >>> 24) & 0xff, (innerWords[i] >> 16) & 0xff, (innerWords[i] >> 8) & 0xff, innerWords[i] & 0xff);
  }
  return digestHex(sha256State(opad.concat(innerBytes)));
}