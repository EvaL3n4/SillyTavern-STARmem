import {
    defaultScorer,
    setScorer,
    getScorer,
    getScorerId,
    registerScorer,
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

describe('scorer registry', () => {
    afterEach(() => _resetScorerForTests());

    test('getScorer returns defaultScorer initially', () => {
        expect(getScorer()).toBe(defaultScorer);
    });

    test('getScorerId returns "default" initially', () => {
        expect(getScorerId()).toBe('default');
    });

    test('registerScorer + setScorer switches the active scorer by id', () => {
        const constant = () => 42;
        registerScorer('constant-42', constant);
        setScorer('constant-42');
        expect(getScorer()).toBe(constant);
        expect(getScorerId()).toBe('constant-42');
    });

    test('setScorer throws on unregistered id', () => {
        expect(() => setScorer('nope')).toThrow(/registered/);
    });

    test('registerScorer rejects non-string id', () => {
        expect(() => registerScorer(/** @type {any} */ (42), () => 0)).toThrow(/id/);
    });

    test('registerScorer rejects non-function fn', () => {
        expect(() => registerScorer('x', /** @type {any} */ (null))).toThrow(/function/);
    });

    test('registerScorer rejects collision with existing non-default id', () => {
        registerScorer('x', () => 1);
        expect(() => registerScorer('x', () => 2)).toThrow(/already/);
    });

    test('registerScorer permits re-registering "default" with defaultScorer (idempotent)', () => {
        expect(() => registerScorer('default', defaultScorer)).not.toThrow();
    });

    test('_resetScorerForTests restores default registry and active id', () => {
        registerScorer('x', () => 1);
        setScorer('x');
        _resetScorerForTests();
        expect(getScorer()).toBe(defaultScorer);
        expect(getScorerId()).toBe('default');
        expect(() => setScorer('x')).toThrow(/registered/);
    });
});
