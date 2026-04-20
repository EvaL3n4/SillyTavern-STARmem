import {
    defaultScorer,
    setScorer,
    getScorer,
    _resetScorerForTests,
} from '../../../src/retrieval/scorer.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {(overrides?: Partial<import('../../../src/core/schema.js').Entry>) => import('../../../src/core/schema.js').Entry} */
function entry(overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content: 'test', subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, ...overrides };
}

describe('defaultScorer', () => {
    const now = new Date('2026-04-20T12:00:00Z');

    test('baseline: importance=50, draft, fresh, bm25=1.0', () => {
        const e = entry();
        // (1 + 50/100) × exp(0) × 0.85 = 1.5 × 1 × 0.85 = 1.275
        expect(defaultScorer(e, 'q', { now, bm25: 1.0 })).toBeCloseTo(1.275, 4);
    });

    test('bm25 of zero produces zero score (multiplicative dominance)', () => {
        expect(defaultScorer(entry(), 'q', { now, bm25: 0 })).toBe(0);
    });

    test('higher importance raises score', () => {
        const low = entry({ lifecycle: { ...entry().lifecycle, importance: 10 } });
        const high = entry({ lifecycle: { ...entry().lifecycle, importance: 90 } });
        expect(defaultScorer(high, 'q', { now, bm25: 1.0 }))
            .toBeGreaterThan(defaultScorer(low, 'q', { now, bm25: 1.0 }));
    });

    test('older entry scores lower than newer (recency dominates when other factors equal)', () => {
        const fresh = entry();
        const old = entry({
            lifecycle: { ...entry().lifecycle, createdAt: '2025-04-20T12:00:00Z' }, // 1 year ago
        });
        expect(defaultScorer(fresh, 'q', { now, bm25: 1.0 }))
            .toBeGreaterThan(defaultScorer(old, 'q', { now, bm25: 1.0 }));
    });

    test('core maturity boosts score vs draft at same importance', () => {
        const draftE = entry({ lifecycle: { ...entry().lifecycle, maturity: 'draft' } });
        const coreE = entry({ lifecycle: { ...entry().lifecycle, maturity: 'core' } });
        const draftScore = defaultScorer(draftE, 'q', { now, bm25: 1.0 });
        const coreScore = defaultScorer(coreE, 'q', { now, bm25: 1.0 });
        // core boost (1.2) / draft boost (0.85) = 1.4118x
        expect(coreScore / draftScore).toBeCloseTo(1.2 / 0.85, 4);
    });

    test('golden value: importance=100, core, fresh, bm25=0.5', () => {
        const e = entry({
            lifecycle: { ...entry().lifecycle, importance: 100, maturity: 'core' },
        });
        // 0.5 × (1 + 100/100) × 1.0 × 1.2 = 0.5 × 2 × 1 × 1.2 = 1.2
        expect(defaultScorer(e, 'q', { now, bm25: 0.5 })).toBeCloseTo(1.2, 6);
    });

    test('ignores unknown context fields (forward compat)', () => {
        const e = entry();
        const withExtras = defaultScorer(e, 'q', /** @type {any} */ ({ now, bm25: 1.0, intent: 'factual', futureFactor: 42 }));
        const plain = defaultScorer(e, 'q', { now, bm25: 1.0 });
        expect(withExtras).toBe(plain);
    });
});

describe('scorer injection', () => {
    afterEach(() => _resetScorerForTests());

    test('getScorer returns defaultScorer initially', () => {
        expect(getScorer()).toBe(defaultScorer);
    });

    test('setScorer replaces the active scorer', () => {
        const constant = () => 42;
        setScorer(constant);
        expect(getScorer()).toBe(constant);
        expect(getScorer()(entry(), 'q', { now: new Date(), bm25: 1 })).toBe(42);
    });

    test('_resetScorerForTests restores the default', () => {
        setScorer(() => 0);
        _resetScorerForTests();
        expect(getScorer()).toBe(defaultScorer);
    });

    test('setScorer rejects non-functions', () => {
        expect(() => setScorer(/** @type {any} */ (null))).toThrow(/function/);
        expect(() => setScorer(/** @type {any} */ (42))).toThrow(/function/);
    });
});
