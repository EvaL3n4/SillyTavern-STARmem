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
});
