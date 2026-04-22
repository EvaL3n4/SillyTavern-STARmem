import { describe, test, expect } from '@jest/globals';
import {
    jaccard,
    matchGold,
    matchGoldByEvidence,
    precisionAtK,
    recallAtK,
    mrr,
    computeMetrics,
    STANDARD_K,
} from '../../../../bench/metrics/retrieval.js';

/*
 * Sub-phase 9.4.6 test suite.
 *
 * Pre-9.4.6 asserted recallAtK(Set(), ranked, k) === 1.0 — the vacuous
 * antipattern that made every Phase 9 sweep report recall=1.0 everywhere.
 * That assertion is deleted. The new contract: empty matchedIds → NaN.
 *
 * matchGold + jaccard are preserved as @deprecated for historical
 * provenance; tested here to lock behavior for any audit of Phase 9
 * artifacts.
 */

describe('jaccard (deprecated)', () => {
    test('both empty → 1', () => {
        expect(jaccard([], [])).toBe(1);
    });

    test('identical tokens → 1', () => {
        expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    });

    test('disjoint → 0', () => {
        expect(jaccard(['a'], ['b'])).toBe(0);
    });

    test('partial overlap', () => {
        expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(2 / 4);
    });
});

describe('matchGold (deprecated)', () => {
    test('matches when Jaccard ≥ threshold', () => {
        const retrieved = [
            { id: 'a', content: 'apple banana cherry', score: 1 },
        ];
        const goldTurns = [
            { turnIndex: 0, text: 'apple banana cherry date' },
        ];
        const result = matchGold(retrieved, goldTurns, { threshold: 0.5 });
        expect(result.matchedIds.has('a')).toBe(true);
    });

    test('no match below threshold', () => {
        const retrieved = [
            { id: 'a', content: 'completely different tokens here', score: 1 },
        ];
        const goldTurns = [
            { turnIndex: 0, text: 'apple banana cherry' },
        ];
        const result = matchGold(retrieved, goldTurns, { threshold: 0.5 });
        expect(result.matchedIds.size).toBe(0);
    });

    test('empty inputs → empty matchedIds', () => {
        const result = matchGold([], []);
        expect(result.matchedIds.size).toBe(0);
        expect(result.perGold).toEqual({});
    });
});

describe('matchGoldByEvidence (9.4.6)', () => {
    test('matches when entry.sourceMessages intersects qa.evidenceTurns', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 4], score: 1 },
            { id: 'b', content: 'y', sourceMessages: [10], score: 0.5 },
        ];
        const result = matchGoldByEvidence(retrieved, [3, 7]);
        expect(result.matchedIds).toEqual(new Set(['a']));
    });

    test('non-intersection → empty matchedIds', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 4], score: 1 },
        ];
        const result = matchGoldByEvidence(retrieved, [10, 20]);
        expect(result.matchedIds.size).toBe(0);
    });

    test('empty evidenceTurns → empty matchedIds', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 4], score: 1 },
        ];
        const result = matchGoldByEvidence(retrieved, []);
        expect(result.matchedIds.size).toBe(0);
    });

    test('missing sourceMessages on entry → that entry does not match', () => {
        const retrieved = [
            { id: 'a', content: 'x', score: 1 },
            { id: 'b', content: 'y', sourceMessages: [3], score: 0.5 },
        ];
        const result = matchGoldByEvidence(retrieved, [3]);
        expect(result.matchedIds).toEqual(new Set(['b']));
    });

    test('populates perGold map per intersecting turn', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3, 5], score: 1 },
            { id: 'b', content: 'y', sourceMessages: [5, 7], score: 0.5 },
        ];
        const result = matchGoldByEvidence(retrieved, [3, 5, 9]);
        expect(result.perGold[3]).toEqual(['a']);
        expect(result.perGold[5].sort()).toEqual(['a', 'b']);
        expect(result.perGold[9]).toBeUndefined();
    });

    test('non-array evidenceTurns → empty matchedIds (defensive)', () => {
        const retrieved = [
            { id: 'a', content: 'x', sourceMessages: [3], score: 1 },
        ];
        const result = matchGoldByEvidence(retrieved, /** @type {any} */ (null));
        expect(result.matchedIds.size).toBe(0);
    });
});

describe('precisionAtK', () => {
    test('hits in top-k', () => {
        const matched = new Set(['a', 'c']);
        const ranked = ['a', 'b', 'c', 'd'];
        expect(precisionAtK(matched, ranked, 3)).toBeCloseTo(2 / 3);
    });

    test('full precision at k=1', () => {
        const matched = new Set(['a']);
        const ranked = ['a', 'b', 'c'];
        expect(precisionAtK(matched, ranked, 1)).toBe(1.0);
    });

    test('no hits', () => {
        expect(precisionAtK(new Set(['x']), ['a', 'b'], 2)).toBe(0);
    });

    test('empty matchedIds → NaN (unscorable, was 0.0 pre-9.4.6)', () => {
        expect(Number.isNaN(precisionAtK(new Set(), ['a', 'b'], 2))).toBe(true);
    });

    test('empty rankedIds → 0 (retrieval returned nothing, not unscorable)', () => {
        expect(precisionAtK(new Set(['a']), [], 3)).toBe(0);
    });
});

describe('recallAtK', () => {
    test('all matched in top-k', () => {
        const matched = new Set(['a', 'b']);
        const ranked = ['a', 'b', 'c'];
        expect(recallAtK(matched, ranked, 3)).toBe(1.0);
    });

    test('partial recall', () => {
        const matched = new Set(['a', 'b']);
        const ranked = ['a', 'c', 'd'];
        expect(recallAtK(matched, ranked, 3)).toBe(0.5);
    });

    test('empty matchedIds → NaN (unscorable, was 1.0 VACUOUSLY pre-9.4.6)', () => {
        // This is the bug: pre-9.4.6 recallAtK returned 1.0 here. Every
        // Phase 9 sweep report's "recall=1.0 everywhere" came from this
        // exact path firing on every query.
        expect(Number.isNaN(recallAtK(new Set(), ['a', 'b'], 2))).toBe(true);
    });

    test('no hits in top-k', () => {
        expect(recallAtK(new Set(['a']), ['b', 'c'], 2)).toBe(0);
    });
});

describe('mrr', () => {
    test('first hit at rank 1', () => {
        expect(mrr(new Set(['a']), ['a', 'b', 'c'])).toBe(1.0);
    });

    test('first hit at rank 3', () => {
        expect(mrr(new Set(['c']), ['a', 'b', 'c'])).toBeCloseTo(1 / 3);
    });

    test('no hit', () => {
        expect(mrr(new Set(['x']), ['a', 'b', 'c'])).toBe(0);
    });

    test('empty rankedIds → 0 (retrieval returned nothing, not unscorable)', () => {
        // Consistent with precisionAtK: matched is present but retrieval
        // was empty. 0 MRR, not NaN.
        expect(mrr(new Set(['a']), [])).toBe(0);
    });

    test('empty matchedIds → NaN (unscorable)', () => {
        expect(Number.isNaN(mrr(new Set(), ['a', 'b']))).toBe(true);
    });
});

describe('computeMetrics with NaN aggregation', () => {
    test('basic run with evidence match', () => {
        const runs = [{
            retrieved: [
                { id: 'a', content: 'x', sourceMessages: [3], score: 1 },
                { id: 'b', content: 'y', sourceMessages: [99], score: 0.5 },
            ],
            qa: { evidenceTurns: [3] },
        }];
        const result = computeMetrics(runs);
        expect(result.n).toBe(1);
        expect(result.n_scored).toBe(1);
        expect(result.n_skipped).toBe(0);
        expect(result.recallAtK[5]).toBe(1.0);
        expect(result.mrr).toBe(1.0);
    });

    test('unscorable runs contribute NaN and are excluded from mean', () => {
        const runs = [
            {
                // Scorable: matched 'a' at rank 1
                retrieved: [{ id: 'a', content: 'x', sourceMessages: [3], score: 1 }],
                qa: { evidenceTurns: [3] },
            },
            {
                // Unscorable: no evidence intersects
                retrieved: [{ id: 'b', content: 'y', sourceMessages: [99], score: 0.5 }],
                qa: { evidenceTurns: [3] },
            },
        ];
        const result = computeMetrics(runs);
        expect(result.n).toBe(2);
        expect(result.n_scored).toBe(1);
        expect(result.n_skipped).toBe(1);
        // Averaged over the 1 scored run
        expect(result.mrr).toBe(1.0);
        expect(result.recallAtK[5]).toBe(1.0);
    });

    test('all unscorable → NaN metrics, n_skipped=n', () => {
        const runs = [{
            retrieved: [{ id: 'a', content: 'x', sourceMessages: [99], score: 1 }],
            qa: { evidenceTurns: [3] },
        }];
        const result = computeMetrics(runs);
        expect(result.n).toBe(1);
        expect(result.n_scored).toBe(0);
        expect(result.n_skipped).toBe(1);
        expect(Number.isNaN(result.mrr)).toBe(true);
        for (const k of STANDARD_K) {
            expect(Number.isNaN(result.precisionAtK[k])).toBe(true);
            expect(Number.isNaN(result.recallAtK[k])).toBe(true);
        }
    });

    test('empty runs → n=0, n_scored=0, NaN metrics', () => {
        const result = computeMetrics([]);
        expect(result.n).toBe(0);
        expect(result.n_scored).toBe(0);
        expect(result.n_skipped).toBe(0);
        expect(Number.isNaN(result.mrr)).toBe(true);
        for (const k of STANDARD_K) {
            expect(Number.isNaN(result.precisionAtK[k])).toBe(true);
            expect(Number.isNaN(result.recallAtK[k])).toBe(true);
        }
    });

    test('aggregates over multiple scorable runs with nanmean', () => {
        const runs = [
            {
                retrieved: [
                    { id: 'a', content: 'x', sourceMessages: [3], score: 1 },
                    { id: 'c', content: 'z', sourceMessages: [99], score: 0.5 },
                ],
                qa: { evidenceTurns: [3] },
            },
            {
                retrieved: [
                    { id: 'b', content: 'y', sourceMessages: [99], score: 1 },
                    { id: 'd', content: 'w', sourceMessages: [7], score: 0.5 },
                ],
                qa: { evidenceTurns: [7] },
            },
        ];
        const result = computeMetrics(runs);
        expect(result.n_scored).toBe(2);
        expect(result.n_skipped).toBe(0);
        // Run 1: d at rank 1 → mrr=1; Run 2: d at rank 2 → mrr=0.5
        expect(result.mrr).toBeCloseTo(0.75);
    });

    test('qa without evidenceTurns field → run counts as unscorable, not a crash', () => {
        const runs = /** @type {any} */ ([{
            retrieved: [{ id: 'a', content: 'x', sourceMessages: [3], score: 1 }],
            qa: {},
        }]);
        const result = computeMetrics(runs);
        expect(result.n_scored).toBe(0);
        expect(result.n_skipped).toBe(1);
    });
});
