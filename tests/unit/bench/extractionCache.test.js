/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wrapWithCache, _cacheKey } from '../../../bench/harness/extractionCache.js';

describe('extractionCache', () => {
    let dir;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'starmem-cache-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('_cacheKey is stable across runs for identical inputs', () => {
        const k1 = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        const k2 = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        expect(k1).toBe(k2);
        expect(k1).toMatch(/^[a-f0-9]{64}$/);
    });

    test('_cacheKey differs for different model/messages/maxTokens', () => {
        const base = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        expect(_cacheKey('n', [{ role: 'u', content: 'hi' }], 100)).not.toBe(base);
        expect(_cacheKey('m', [{ role: 'u', content: 'hello' }], 100)).not.toBe(base);
        expect(_cacheKey('m', [{ role: 'u', content: 'hi' }], 200)).not.toBe(base);
    });

    test('cache miss → calls inner, writes result to disk', async () => {
        const inner = jest.fn(async () => '{"entries":[{"content":"x","subject":"X","tags":[],"relations":[]}]}');
        const wrapped = wrapWithCache(inner, { dir, model: 'm' });

        const result = await wrapped('p', [{ role: 'u', content: 'hi' }], 100);

        expect(inner).toHaveBeenCalledTimes(1);
        expect(result).toMatch(/entries/);

        const key = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        const file = path.join(dir, `${key}.json`);
        const stored = JSON.parse(await readFile(file, 'utf8'));
        expect(stored.response).toBe(result);
        expect(stored.model).toBe('m');
        expect(stored.maxTokens).toBe(100);
    });

    test('cache hit → skips inner, returns stored', async () => {
        const inner = jest.fn(async () => 'first');
        const wrapped = wrapWithCache(inner, { dir, model: 'm' });

        await wrapped('p', [{ role: 'u', content: 'hi' }], 100);
        expect(inner).toHaveBeenCalledTimes(1);

        const innerB = jest.fn(async () => 'second');
        const wrappedB = wrapWithCache(innerB, { dir, model: 'm' });

        const result = await wrappedB('p', [{ role: 'u', content: 'hi' }], 100);
        expect(innerB).toHaveBeenCalledTimes(0);
        expect(result).toBe('first');
    });

    test('disabled=true bypasses cache entirely', async () => {
        const inner = jest.fn(async () => 'live');
        const wrapped = wrapWithCache(inner, { dir, model: 'm', disabled: true });

        await wrapped('p', [{ role: 'u', content: 'hi' }], 100);
        await wrapped('p', [{ role: 'u', content: 'hi' }], 100);

        expect(inner).toHaveBeenCalledTimes(2);
    });

    test('corrupt cache file falls through to inner and overwrites', async () => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
        const key = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        await writeFile(path.join(dir, `${key}.json`), 'not json{{{');

        const inner = jest.fn(async () => 'recovered');
        const wrapped = wrapWithCache(inner, { dir, model: 'm' });
        const result = await wrapped('p', [{ role: 'u', content: 'hi' }], 100);

        expect(inner).toHaveBeenCalledTimes(1);
        expect(result).toBe('recovered');

        const stored = JSON.parse(await readFile(path.join(dir, `${key}.json`), 'utf8'));
        expect(stored.response).toBe('recovered');
    });
});
