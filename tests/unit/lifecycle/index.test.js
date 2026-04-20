import * as lifecycle from '../../../src/lifecycle/index.js';

describe('lifecycle barrel exports', () => {
    test('exposes all public functions', () => {
        expect(typeof lifecycle.recencyAt).toBe('function');
        expect(typeof lifecycle.MS_PER_DAY).toBe('number');
        expect(typeof lifecycle.applyAccessEvent).toBe('function');
        expect(typeof lifecycle.applyUpdateEvent).toBe('function');
        expect(typeof lifecycle.applyDailyDecay).toBe('function');
        expect(typeof lifecycle.maturityFor).toBe('function');
        expect(typeof lifecycle.maturityBoost).toBe('function');
    });

    test('re-exports are reference-equal to the source modules', async () => {
        const recency = await import('../../../src/lifecycle/recency.js');
        const importance = await import('../../../src/lifecycle/importance.js');
        const maturity = await import('../../../src/lifecycle/maturity.js');
        expect(lifecycle.recencyAt).toBe(recency.recencyAt);
        expect(lifecycle.applyAccessEvent).toBe(importance.applyAccessEvent);
        expect(lifecycle.maturityFor).toBe(maturity.maturityFor);
    });
});
