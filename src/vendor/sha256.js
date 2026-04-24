/**
 * Pure-JS SHA-256 — vendored to avoid node:crypto in browser-loaded code.
 *
 * Provenance: implementation follows FIPS 180-4 §6.2 (SHA-256 algorithm).
 * No external dependencies. Public-domain style — feel free to adapt.
 *
 * Used by src/memory/entry.js::contentSuffix for deterministic entry ids.
 * Verified bit-identical to node:crypto.createHash('sha256') across
 * published test vectors and 256 random-ish inputs (see the test suite).
 *
 * Byte handling: JS strings are UTF-16; we encode to UTF-8 via TextEncoder
 * to match node:crypto's default behaviour.
 *
 * @module vendor/sha256
 */

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

const ROTR = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * Compute SHA-256 of a string and return a 64-char lowercase hex digest.
 * Identical output to `require('crypto').createHash('sha256').update(s).digest('hex')`.
 *
 * @param {string} input
 * @returns {string} 64-character hex digest
 */
export function sha256Hex(input) {
    if (typeof input !== 'string') {
        throw new TypeError('sha256Hex: input must be a string');
    }
    const bytes = new TextEncoder().encode(input);
    const bitLen = bytes.length * 8;

    // Pad: append 0x80, then zeros, then 64-bit big-endian length
    const padLen = (56 - (bytes.length + 1) % 64 + 64) % 64;
    const padded = new Uint8Array(bytes.length + 1 + padLen + 8);
    padded.set(bytes, 0);
    padded[bytes.length] = 0x80;
    const high = Math.floor(bitLen / 0x100000000);
    const low = bitLen >>> 0;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, high, false);
    dv.setUint32(padded.length - 4, low, false);

    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);

    const W = new Uint32Array(64);
    for (let i = 0; i < padded.length; i += 64) {
        for (let t = 0; t < 16; t++) {
            W[t] = dv.getUint32(i + t * 4, false);
        }
        for (let t = 16; t < 64; t++) {
            const s0 = ROTR(W[t - 15], 7) ^ ROTR(W[t - 15], 18) ^ (W[t - 15] >>> 3);
            const s1 = ROTR(W[t - 2], 17) ^ ROTR(W[t - 2], 19) ^ (W[t - 2] >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
        }

        let [a, b, c, d, e, f, g, h] = H;
        for (let t = 0; t < 64; t++) {
            const S1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
            const S0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
            const mj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + mj) | 0;
            h = g; g = f; f = e;
            e = (d + temp1) | 0;
            d = c; c = b; b = a;
            a = (temp1 + temp2) | 0;
        }
        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
        H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0;
        H[7] = (H[7] + h) | 0;
    }

    let out = '';
    for (let i = 0; i < 8; i++) {
        out += H[i].toString(16).padStart(8, '0');
    }
    return out;
}