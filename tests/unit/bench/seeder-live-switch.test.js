/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

describe('seeder live/rule-based switch', () => {
    const origEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...origEnv };
        jest.resetModules();
    });

    test('unset STARMEM_BENCH_LIVE_EXTRACTOR installs rule-based extractor', async () => {
        delete process.env.STARMEM_BENCH_LIVE_EXTRACTOR;

        const mod = await import('../../../bench/harness/seeder.js');
        expect(typeof mod._resolveExtractor).toBe('function');

        const ext = mod._resolveExtractor();
        expect(ext.source).toBe('rule-based');
    });

    test('set STARMEM_BENCH_LIVE_EXTRACTOR + full env installs live extractor', async () => {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        process.env.STARMEM_BENCH_LLM_URL = 'http://litellm:8686/v1';
        process.env.STARMEM_BENCH_LLM_API_KEY='***';
        process.env.STARMEM_BENCH_LLM_MODEL = 'gemma4-26b-a4b';

        const mod = await import('../../../bench/harness/seeder.js');
        const ext = mod._resolveExtractor();
        expect(ext.source).toBe('live');
        expect(typeof ext.fn).toBe('function');
    });

    test('live mode with missing config throws with actionable message', async () => {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        delete process.env.STARMEM_BENCH_LLM_URL;

        const mod = await import('../../../bench/harness/seeder.js');
        expect(() => mod._resolveExtractor()).toThrow(/STARMEM_BENCH_LLM_URL/);
    });

    test('--no-cache flag disables cache even in live mode', async () => {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        process.env.STARMEM_BENCH_LLM_URL = 'http://x';
        process.env.STARMEM_BENCH_LLM_API_KEY='***';
        process.env.STARMEM_BENCH_LLM_MODEL = 'm';
        process.env.STARMEM_BENCH_NO_CACHE = '1';

        const mod = await import('../../../bench/harness/seeder.js');
        const ext = mod._resolveExtractor();
        expect(ext.source).toBe('live');
        expect(ext.cached).toBe(false);
    });
});
