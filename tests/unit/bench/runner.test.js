/**
 * Unit tests for bench/runner.js — the benchmark harness orchestrator.
 *
 * These tests exercise the runner's surface API without seeding real
 * conversations: empty corpus, envSnapshot shape, overrides round-trip.
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 3 Step 1
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { runHarness } from '../../../bench/runner.js';
import {
    RETRIEVAL,
    resetConstantOverrides,
} from '../../../src/core/constants.js';
import { _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { _resetLLMClientForTests } from '../../../src/consolidation/llmClient.js';

function cleanup() {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
    resetConstantOverrides();
}

beforeEach(() => {
    cleanup();
});

afterEach(() => {
    cleanup();
});

describe('runHarness', () => {
    test('empty corpus returns runs: [], metrics, envSnapshot', async () => {
        const result = await runHarness({ corpus: [] });
        expect(result).toHaveProperty('runs');
        expect(result).toHaveProperty('metrics');
        expect(result).toHaveProperty('envSnapshot');
        expect(result.runs).toEqual([]);
        expect(result.metrics.n).toBe(0);
    });

    test('envSnapshot.gitSha is a valid hex string (7–40 chars)', async () => {
        const result = await runHarness({ corpus: [] });
        expect(result.envSnapshot.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
    });

    test('envSnapshot.nodeVersion equals process.version', async () => {
        const result = await runHarness({ corpus: [] });
        expect(result.envSnapshot.nodeVersion).toBe(process.version);
    });

    test('envSnapshot.scorerId is a non-empty string', async () => {
        const result = await runHarness({ corpus: [] });
        expect(typeof result.envSnapshot.scorerId).toBe('string');
        expect(result.envSnapshot.scorerId.length).toBeGreaterThan(0);
    });

    test('overrides surface in envSnapshot.constants and round-trip', async () => {
        const before = RETRIEVAL.TIER2_TAU_CONFIDENCE;
        const result = await runHarness({
            corpus: [],
            overrides: { TIER2_TAU_CONFIDENCE: 7.5 },
        });
        expect(result.envSnapshot.constants.TIER2_TAU_CONFIDENCE).toBe(7.5);
        // After runHarness returns, overrides are restored in finally
        expect(RETRIEVAL.TIER2_TAU_CONFIDENCE).toBe(before);
    });

    test('surfaces consolidationStats on each run record', async () => {
        const corpus = [
            {
                id: 'synth-a',
                turns: [
                    { speaker: 'Alice', text: 'Alice likes coffee. She drinks it every morning.', sessionId: 1, turnIndex: 0 },
                    { speaker: 'Bob',   text: 'Bob works at Acme. He is an engineer there.', sessionId: 1, turnIndex: 1 },
                    { speaker: 'Alice', text: 'Charlie moved to Seattle. The rain is constant.', sessionId: 1, turnIndex: 2 },
                    { speaker: 'Bob',   text: 'Diana loves hiking. She climbs mountains every weekend.', sessionId: 1, turnIndex: 3 },
                    { speaker: 'Alice', text: 'Emma adopted a dog. The dog is very playful.', sessionId: 1, turnIndex: 4 },
                    { speaker: 'Bob',   text: 'Frank plays guitar. He practices in the garage.', sessionId: 1, turnIndex: 5 },
                ],
                qa: [
                    {
                        question: 'What does Alice like to drink?',
                        answer: 'Coffee',
                        evidenceTurns: [0],
                        category: 'factual',
                    },
                ],
            },
        ];
        const result = await runHarness({ corpus });
        expect(result.runs.length).toBeGreaterThan(0);
        expect(typeof result.runs[0].consolidationStats.added).toBe('number');
        expect(typeof result.runs[0].consolidationStats.updated).toBe('number');
        expect(typeof result.runs[0].consolidationStats.drained).toBe('number');
        expect(typeof result.runs[0].consolidationStats.batches).toBe('number');
        expect(Array.isArray(result.runs[0].consolidationStats.factLengths)).toBe(true);
    });
});
