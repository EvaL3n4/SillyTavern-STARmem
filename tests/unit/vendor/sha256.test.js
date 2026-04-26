/**
 * Verify our vendored SHA-256 matches the reference implementation at
 * Node's node:crypto and against NIST FIPS 180-4 published vectors.
 */
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../../src/vendor/sha256.js';

describe('sha256Hex', () => {
    test('empty string matches published vector', () => {
        expect(sha256Hex('')).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        );
    });

    test('"abc" matches FIPS 180-4 published vector', () => {
        expect(sha256Hex('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });

    test('matches node:crypto on 256 random-ish inputs', () => {
        for (let i = 0; i < 256; i++) {
            const s = `input-${i}-${i * 13}-${String.fromCharCode(i)}`;
            const ours = sha256Hex(s);
            const theirs = createHash('sha256').update(s).digest('hex');
            expect(ours).toBe(theirs);
        }
    });

    test('handles Unicode correctly (UTF-8 encoding)', () => {
        const emoji = '🌸';
        const ours = sha256Hex(emoji);
        const theirs = createHash('sha256').update(emoji, 'utf8').digest('hex');
        expect(ours).toBe(theirs);
    });

    test('returns 64 lowercase hex chars regardless of input', () => {
        for (const s of ['', 'a', 'hello world', '0', '\n', '\x00\x01\x02']) {
            const result = sha256Hex(s);
            expect(result).toMatch(/^[0-9a-f]{64}$/);
        }
    });
});