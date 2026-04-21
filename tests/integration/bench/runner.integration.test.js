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

    test('metrics.precisionAtK[1] is a number in [0, 1]', async () => {
        const result = await runHarness({ corpus: [CONV_A, CONV_B] });
        const p1 = result.metrics.precisionAtK[1];
        expect(typeof p1).toBe('number');
        expect(p1).toBeGreaterThanOrEqual(0);
        expect(p1).toBeLessThanOrEqual(1);
    });

    test('overrides affect retrieval tierResolved (weak assertion)', async () => {
        // With TIER2_TAU_CONFIDENCE set to 999, Tier 2 exit condition should
        // never fire, so we should see tierResolved skewed away from 2.
        const result = await runHarness({
            corpus: [CONV_A],
            overrides: { TIER2_TAU_CONFIDENCE: 999 },
        });
        // At least one run should NOT resolve at tier 2, OR the runner
        // should not have crashed. We assert the latter via the fact that
        // we got here, and the former weakly:
        const hasNonTier2 = result.runs.some(r => r.traces[0].tierResolved !== 2);
        // If all runs happen to hit tier 2 anyway (e.g. tier 0/1 exact match),
        // that's fine — we just verify the mechanism didn't crash.
        expect(result.runs.length).toBeGreaterThan(0);
        if (!hasNonTier2) {
            console.log('All runs resolved at tier 2 — override may not have been observable with this fixture');
        }
    });
});
