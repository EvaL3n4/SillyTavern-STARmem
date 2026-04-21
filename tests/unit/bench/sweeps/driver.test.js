/**
 * Unit tests for bench/sweeps/_driver.js
 *
 * Uses dependency-injected fake runHarness to avoid heavy backend calls.
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 4 Step 1
 */

import { describe, test, expect } from '@jest/globals';
import { sweep } from '../../../../bench/sweeps/_driver.js';

/**
 * Build a fake harness that returns canned metrics + latencies.
 */
function makeFakeHarness(opts = {}) {
    const { recallShape } = opts;
    let callIndex = 0;
    /** @type {Array<{args: [object], result: object}>} */
    const calls = [];

    async function run({ overrides }) {
        const recallAt5 = recallShape
            ? recallShape[callIndex % recallShape.length]
            : 0.3;
        callIndex++;
        const result = {
            runs: [
                { latencyMs: 10 },
                { latencyMs: 20 },
                { latencyMs: 30 },
            ],
            metrics: {
                n: 3,
                precisionAtK: { 1: 0.5, 3: 0.5, 5: 0.5, 10: 0.5 },
                recallAtK: { 1: 0.1, 3: 0.2, 5: recallAt5, 10: 0.4 },
                mrr: 0.5,
            },
            envSnapshot: {
                constants: { ...overrides },
                scorerId: 'default',
                nodeVersion: process.version,
                gitSha: 'abc1234',
            },
        };
        calls.push({ args: [{ overrides }], result });
        return result;
    }

    return { run, calls };
}

describe('sweep driver', () => {
    test('calls harness once per cartesian-product point', async () => {
        const fakeHarness = makeFakeHarness();
        await sweep({
            name: 'test',
            knobs: [
                { name: 'A', values: [1, 2, 3] },
                { name: 'B', values: [10, 20] },
            ],
            corpus: [],
            primaryMetric: 'recallAt5',
            _runHarness: fakeHarness.run,
        });
        expect(fakeHarness.calls.length).toBe(6);
    });

    test('each call overrides object contains both knob keys', async () => {
        const fakeHarness = makeFakeHarness();
        await sweep({
            name: 'test',
            knobs: [
                { name: 'A', values: [1] },
                { name: 'B', values: [10] },
            ],
            corpus: [],
            primaryMetric: 'recallAt5',
            _runHarness: fakeHarness.run,
        });
        const firstCall = fakeHarness.calls[0];
        expect(firstCall.args[0].overrides).toEqual(expect.objectContaining({ A: 1, B: 10 }));
    });

    test('result.points length equals cartesian product and each has required keys', async () => {
        const fakeHarness = makeFakeHarness();
        const result = await sweep({
            name: 'test',
            knobs: [
                { name: 'A', values: [1, 2, 3] },
                { name: 'B', values: [10, 20] },
            ],
            corpus: [],
            primaryMetric: 'recallAt5',
            _runHarness: fakeHarness.run,
        });
        expect(result.points.length).toBe(6);
        for (const point of result.points) {
            expect(point).toHaveProperty('overrides');
            expect(point).toHaveProperty('metrics');
            expect(point).toHaveProperty('latencyMs');
            expect(point.latencyMs).toHaveProperty('p50');
            expect(point.latencyMs).toHaveProperty('p95');
        }
    });

    test('elbow detection on hand-crafted recall curve', async () => {
        // Primary knob A has 6 values; B is secondary with 1 value.
        // recallAt5 shape along A: [0.1, 0.3, 0.5, 0.52, 0.53, 0.53]
        // The elbow should be at index 2 (value A=3) because after that
        // Δmetric drops below ELBOW_RATIO (0.1) × maxΔ (0.2).
        const fakeHarness = makeFakeHarness({
            recallShape: [0.1, 0.3, 0.5, 0.52, 0.53, 0.53],
        });
        const result = await sweep({
            name: 'test',
            knobs: [
                { name: 'A', values: [1, 2, 3, 4, 5, 6] },
                { name: 'B', values: [10] },
            ],
            corpus: [],
            primaryMetric: 'recallAt5',
            _runHarness: fakeHarness.run,
        });
        expect(result.elbow.overrides).toEqual(expect.objectContaining({ A: 3, B: 10 }));
        expect(result.elbow.rationale).toContain('elbow');
    });

    test('result.raw is valid JSONL with required keys per line', async () => {
        const fakeHarness = makeFakeHarness();
        const result = await sweep({
            name: 'test',
            knobs: [
                { name: 'A', values: [1, 2] },
                { name: 'B', values: [10] },
            ],
            corpus: [],
            primaryMetric: 'recallAt5',
            _runHarness: fakeHarness.run,
        });
        const lines = result.raw.trim().split('\n');
        expect(lines.length).toBe(2);
        for (const line of lines) {
            const parsed = JSON.parse(line);
            expect(parsed).toHaveProperty('overrides');
            expect(parsed).toHaveProperty('metrics');
            expect(parsed).toHaveProperty('latencyMs');
        }
    });
});
