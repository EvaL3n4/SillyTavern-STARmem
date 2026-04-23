import { test, expect } from '@jest/globals';
import { computeMetrics } from '../../../bench/metrics/retrieval.js';

test('coverage = n_scored / n', () => {
    const runs = [
        { retrieved: [{ id: 'a', content: '', sourceMessages: [0] }], qa: { evidenceTurns: [0] } },
        { retrieved: [{ id: 'b', content: '', sourceMessages: [1] }], qa: { evidenceTurns: [5] } }, // no intersect → skipped
        { retrieved: [{ id: 'c', content: '', sourceMessages: [2] }], qa: { evidenceTurns: [2] } },
    ];
    const m = computeMetrics(runs);
    expect(m.n).toBe(3);
    expect(m.n_scored).toBe(2);
    expect(m.n_skipped).toBe(1);
    expect(m.coverage).toBeCloseTo(2 / 3, 6);
});

test('coverage is NaN on empty input', () => {
    const m = computeMetrics([]);
    expect(Number.isNaN(m.coverage)).toBe(true);
});

test('coverage is 1.0 when every run scores', () => {
    const runs = [
        { retrieved: [{ id: 'a', content: '', sourceMessages: [0] }], qa: { evidenceTurns: [0] } },
        { retrieved: [{ id: 'b', content: '', sourceMessages: [1] }], qa: { evidenceTurns: [1] } },
    ];
    const m = computeMetrics(runs);
    expect(m.coverage).toBe(1.0);
});
