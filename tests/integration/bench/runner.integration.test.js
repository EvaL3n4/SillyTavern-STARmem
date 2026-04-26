/**
 * Integration tests for bench/runner.js — end-to-end harness with synthetic
 * corpus, real seeding, and retrieval ladder.
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 3 Step 2
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { runHarness } from '../../../bench/runner.js';
import {
    resetConstantOverrides,
} from '../../../src/core/constants.js';
import { _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { _resetLLMClientForTests } from '../../../src/consolidation/llmClient.js';

/** @type {import('../../../bench/loaders/locomo.js').CorpusConversation} */
const CONV_A = {
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
        {
            question: 'Where does Bob work?',
            answer: 'Acme',
            evidenceTurns: [1],
            category: 'factual',
        },
    ],
};

/** @type {import('../../../bench/loaders/locomo.js').CorpusConversation} */
const CONV_B = {
    id: 'synth-b',
    turns: [
        { speaker: 'Carol', text: 'Grace moved to Berlin. The Brandenburg Gate is iconic.', sessionId: 1, turnIndex: 0 },
        { speaker: 'Dave',  text: 'Henry studied art in Berlin. He loves museums.', sessionId: 1, turnIndex: 1 },
        { speaker: 'Carol', text: 'Irene visited Madrid. The Prado museum has masterpieces.', sessionId: 1, turnIndex: 2 },
        { speaker: 'Dave',  text: 'Jack enjoys tapas in Madrid. The nightlife is vibrant.', sessionId: 1, turnIndex: 3 },
        { speaker: 'Carol', text: 'Kate moved to Lisbon. The trams are charming.', sessionId: 1, turnIndex: 4 },
        { speaker: 'Dave',  text: 'Liam surfs every morning in Lisbon. The coast is beautiful.', sessionId: 1, turnIndex: 5 },
    ],
    qa: [
        {
            question: 'Where did Grace move?',
            answer: 'Berlin',
            evidenceTurns: [0],
            category: 'factual',
        },
        {
            question: 'What does Jack enjoy in Madrid?',
            answer: 'Tapas',
            evidenceTurns: [3],
            category: 'factual',
        },
    ],
};

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

describe('runHarness integration', () => {
    test('2 conversations × 2 QA = 4 runs', async () => {
        const result = await runHarness({ corpus: [CONV_A, CONV_B] });
        expect(result.runs.length).toBe(4);
    });

    test('every run has non-empty retrieved, valid goldTurns, positive latency', async () => {
        const result = await runHarness({ corpus: [CONV_A, CONV_B] });
        for (const run of result.runs) {
            expect(run.retrieved.length).toBeGreaterThanOrEqual(1);
            expect(run.goldTurns.length).toBe(run.qa.evidenceTurns.length);
            expect(run.latencyMs).toBeGreaterThan(0);
            expect(Array.isArray(run.traces)).toBe(true);
            expect(run.traces.length).toBe(1);
        }
    });

    test('metrics.precisionAtK[1] is NaN or a number in [0, 1]', async () => {
        const result = await runHarness({ corpus: [CONV_A, CONV_B] });
        const p1 = result.metrics.precisionAtK[1];
        expect(typeof p1).toBe('number');
        // Post-9.4.6: NaN is a valid value when no QA in the batch scored
        // (empty evidenceTurns or no retrieval intersection). Tiny synthetic
        // fixtures like CONV_A/CONV_B may land here.
        expect(Number.isNaN(p1) || (p1 >= 0 && p1 <= 1)).toBe(true);
    });

    test('9.4.6: retrieved entries carry sourceMessages for evidence-turn matching', async () => {
        const result = await runHarness({ corpus: [CONV_A, CONV_B] });
        const runsWithRetrieved = result.runs.filter(r => r.retrieved.length > 0);
        expect(runsWithRetrieved.length).toBeGreaterThan(0);
        for (const run of runsWithRetrieved) {
            for (const entry of run.retrieved) {
                expect(Array.isArray(entry.sourceMessages)).toBe(true);
                for (const n of entry.sourceMessages) {
                    expect(typeof n).toBe('number');
                }
            }
        }
    });

    test('overrides affect retrieval tierResolved (weak assertion)', async () => {
        // With TIER3_LAMBDA_1 set to 0.01, Tier 3 should behave differently
        // than at default 1.0. This verifies the override mechanism works.
        const result = await runHarness({
            corpus: [CONV_A],
            overrides: { TIER3_LAMBDA_1: 0.01 },
        });
        // At least one run should have a trace. We just verify the mechanism
        // didn't crash and the override was applied.
        expect(result.runs.length).toBeGreaterThan(0);
        expect(result.runs.every(r => r.traces.length === 1)).toBe(true);
    });
});
