/**
 * Unit tests for bench/harness/trace.js.
 *
 * Pins the no-op contract: traceRetrieve must return the original
 * function when Weave is not initialized, and must preserve call-site
 * behavior exactly. This guards against regressions where a future
 * edit accidentally makes the wrapper always-active and breaks tests /
 * local bench runs that don't have W&B credentials.
 *
 * Integration with a live Weave backend is NOT tested here — that
 * requires network + credentials and is verified by `npm run bench`
 * against a real W&B project.
 */

import { jest } from '@jest/globals';
import { traceRetrieve, initWeave } from '../../../../bench/harness/trace.js';

describe('bench/harness/trace.js', () => {
    describe('traceRetrieve without initWeave', () => {
        it('returns the original function unchanged', () => {
            const original = (state, query, opts) => ({ q: query, k: opts.k });
            const wrapped = traceRetrieve(original);
            expect(wrapped).toBe(original);
        });

        it('preserves call semantics for wrapped retriever', () => {
            const fn = jest.fn((state, query) => ({ result: `answer-${query}` }));
            const wrapped = traceRetrieve(fn);
            const out = wrapped({ chatId: 'c1' }, 'hello', { k: 5 });
            expect(out).toEqual({ result: 'answer-hello' });
            expect(fn).toHaveBeenCalledWith({ chatId: 'c1' }, 'hello', { k: 5 });
        });

        it('handles retrievers without a .name property', () => {
            const anon = (s, q) => ({ q });
            expect(() => traceRetrieve(anon, {})).not.toThrow();
        });
    });

    describe('initWeave opt-out', () => {
        const origEnv = { ...process.env };

        afterEach(() => {
            process.env = { ...origEnv };
        });

        it('returns false when WEAVE_DISABLED=1', async () => {
            process.env.WEAVE_DISABLED = '1';
            const ready = await initWeave('STARmem-test');
            expect(ready).toBe(false);
        });

        it('returns false when WANDB_DISABLED=1', async () => {
            process.env.WANDB_DISABLED = '1';
            const ready = await initWeave('STARmem-test');
            expect(ready).toBe(false);
        });

        it('is idempotent on repeated calls after opt-out', async () => {
            process.env.WEAVE_DISABLED = '1';
            const r1 = await initWeave('STARmem-test');
            const r2 = await initWeave('STARmem-test');
            expect(r1).toBe(false);
            expect(r2).toBe(false);
        });
    });
});
