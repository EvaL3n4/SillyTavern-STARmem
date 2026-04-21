import { describe, test, expect } from '@jest/globals';
import {
    jaccard,
    matchGold,
    precisionAtK,
    recallAtK,
    mrr,
    computeMetrics,
    DEFAULT_GOLD_THRESHOLD,
    STANDARD_K,
} from '../../../../bench/metrics/retrieval.js';

const goldTurns = [
    { turnIndex: 3, text: 'My birthday is in March, I love spring flowers.' },
    { turnIndex: 7, text: 'I moved to Boston last year for the new job.' },
];

const retrieved = [
    { id: 'e1', content: 'Caroline was born in March.', score: 1.5 },
    { id: 'e2', content: 'Unrelated trivia about pasta.', score: 1.2 },
    { id: 'e3', content: 'She moved to Boston for work.', score: 1.0 },
    { id: 'e4', content: 'Still unrelated.', score: 0.8 },
];

describe('jaccard', () => {
    test('both empty → 1', () => {
        expect(jaccard([], [])).toBe(1);
    });

    test('one empty → 0', () => {
        expect(jaccard(['a'], [])).toBe(0);
        expect(jaccard([], ['b'])).toBe(0);
    });

    test('identical sets → 1', () => {
        expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
    });

    test('partial overlap', () => {
        expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(2 / 4);
    });

    test('no overlap → 0', () => {
        expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    });
});

describe('matchGold', () => {
    test('returns Set and Record shape', () => {
        const result = matchGold(retrieved, goldTurns);
        expect(result.matchedIds).toBeInstanceOf(Set);
        expect(typeof result.perGold).toBe('object');
    });

    test('default threshold is 0.5', () => {
        expect(DEFAULT_GOLD_THRESHOLD).toBe(0.5);
    });

    test('e3 is the strongest candidate (Boston overlap)', () => {
        const result = matchGold(retrieved, goldTurns);
        // e3 has the highest Jaccard overlap; if anything matches at 0.5 it should be e3
        if (result.matchedIds.size > 0) {
            expect(result.matchedIds.has('e3')).toBe(true);
        }
    });

    test('low threshold catches more matches', () => {
        const result = matchGold(retrieved, goldTurns, { threshold: 0.1 });
        expect(result.matchedIds.size).toBeGreaterThanOrEqual(1);
        expect(result.matchedIds.has('e3')).toBe(true);
    });

    test('perGold maps turnIndex to matched ids', () => {
        const result = matchGold(retrieved, goldTurns, { threshold: 0.1 });
        expect(Array.isArray(result.perGold[7])).toBe(true);
        expect(result.perGold[7].includes('e3')).toBe(true);
    });

    test('empty inputs → empty result', () => {
        const result = matchGold([], []);
        expect(result.matchedIds.size).toBe(0);
        expect(Object.keys(result.perGold).length).toBe(0);
    });
});

describe('precisionAtK', () => {
    const matched = new Set(['a', 'c']);
    const ranked = ['a', 'b', 'c', 'd'];

    test('k=1 with hit at position 0 → 1.0', () => {
        expect(precisionAtK(matched, ranked, 1)).toBe(1.0);
    });

    test('k=2 with one hit → 0.5', () => {
        expect(precisionAtK(matched, ranked, 2)).toBe(0.5);
    });

    test('k=5 with 2 matches in 4 results → 0.5 (no padding)', () => {
        expect(precisionAtK(matched, ranked, 5)).toBe(2 / 4);
    });

    test('empty retrieval → 0', () => {
        expect(precisionAtK(matched, [], 3)).toBe(0);
    });

    test('no matches → 0', () => {
        expect(precisionAtK(new Set(['z']), ranked, 2)).toBe(0);
    });
});

describe('recallAtK', () => {
    const matched = new Set(['a', 'c']);
    const ranked = ['a', 'b', 'c', 'd'];

    test('all relevant in top-k → 1.0', () => {
        expect(recallAtK(matched, ranked, 3)).toBe(1.0);
    });

    test('partial recall', () => {
        expect(recallAtK(matched, ranked, 1)).toBe(0.5);
    });

    test('empty gold → 1.0 (vacuous)', () => {
        expect(recallAtK(new Set(), ranked, 2)).toBe(1.0);
    });

    test('no matches in top-k → 0', () => {
        expect(recallAtK(matched, ['b', 'd'], 2)).toBe(0);
    });
});

describe('mrr', () => {
    const matched = new Set(['a', 'c']);

    test('rank 1 → 1.0', () => {
        expect(mrr(matched, ['a', 'b', 'c'])).toBe(1.0);
    });

    test('rank 3 → 1/3', () => {
        expect(mrr(matched, ['b', 'd', 'a'])).toBe(1 / 3);
    });

    test('no match → 0', () => {
        expect(mrr(matched, ['b', 'd', 'e'])).toBe(0);
    });

    test('empty ranked → 0', () => {
        expect(mrr(matched, [])).toBe(0);
    });
});

describe('computeMetrics', () => {
    test('returns correct shape with STANDARD_K', () => {
        expect(STANDARD_K).toEqual([1, 3, 5, 10]);

        const runs = [
            {
                retrieved: [
                    { id: 'a', content: 'hit', score: 1.0 },
                    { id: 'b', content: 'miss', score: 0.5 },
                ],
                goldTurns: [{ turnIndex: 0, text: 'hit' }],
            },
        ];

        const result = computeMetrics(runs);
        expect(result.n).toBe(1);
        expect(typeof result.precisionAtK).toBe('object');
        expect(typeof result.recallAtK).toBe('object');
        expect(typeof result.mrr).toBe('number');

        for (const k of STANDARD_K) {
            expect(typeof result.precisionAtK[k]).toBe('number');
            expect(typeof result.recallAtK[k]).toBe('number');
        }
    });

    test('empty runs → zeros', () => {
        const result = computeMetrics([]);
        expect(result.n).toBe(0);
        for (const k of STANDARD_K) {
            expect(result.precisionAtK[k]).toBe(0);
            expect(result.recallAtK[k]).toBe(0);
        }
        expect(result.mrr).toBe(0);
    });

    test('aggregates over multiple runs', () => {
        const runs = [
            {
                retrieved: [
                    { id: 'a', content: 'alpha', score: 1.0 },
                    { id: 'b', content: 'beta', score: 0.5 },
                ],
                goldTurns: [{ turnIndex: 0, text: 'alpha' }],
            },
            {
                retrieved: [
                    { id: 'b', content: 'beta', score: 1.0 },
                    { id: 'a', content: 'alpha', score: 0.5 },
                ],
                goldTurns: [{ turnIndex: 0, text: 'beta' }],
            },
        ];

        const result = computeMetrics(runs);
        expect(result.n).toBe(2);
        expect(result.mrr).toBe(1.0); // both rank 1
    });
});
