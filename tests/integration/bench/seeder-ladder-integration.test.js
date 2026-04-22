/**
 * End-to-end regression test for the ladder inversion bug (9.4.7).
 *
 * Bug (pre-9.4.7): bench seeder's per-turn maybeConsolidate('buffer')
 * skipped when workingBuffer was below threshold, leaving residual
 * turns un-drained at end-of-conversation. retrieve() then prepended
 * those residuals at score=Infinity, burying episodic entries.
 *
 * Fix (9.4.7 Task 3): seeder now drains the residual via a loop of
 * maybeConsolidate('idle', ...) after the for-loop.
 *
 * Regression surface: if the fix is ever reverted or weakened, this
 * test catches it at the integration layer — any query against a
 * seeded state should see episodic entries in its result, not a
 * wall of working-scope residuals.
 *
 * @see docs/bench/audits/2026-04-22-ladder-inversion.md
 * @see docs/plans/phase-9-4-7-ladder-diagnosis.md Task 4
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { seedConversation } from '../../../bench/harness/seeder.js';
import { loadState, _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { _resetLLMClientForTests } from '../../../src/consolidation/llmClient.js';
import { retrieve } from '../../../src/retrieval/ladder.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

function cleanup() {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
}

beforeEach(() => {
    cleanup();
});

afterEach(() => {
    cleanup();
});

describe('9.4.7 regression — seeder + ladder integration', () => {
    test('retrieve() against seeded state returns episodic entries, not working residuals', async () => {
        // 13 turns — not a multiple of WORKING_BUFFER_THRESHOLD (10).
        // Pre-9.4.7, this would leave 3-8 residual working entries in
        // state.workingBuffer, which would be prepended to every query
        // result at score=Infinity.
        const conv = {
            id: 'regression-9-4-7',
            turns: Array.from({ length: 13 }, (_, i) => ({
                speaker: i % 2 === 0 ? 'Alice' : 'Bob',
                text: i === 0
                    ? 'Alice lives in Marseille, France.'
                    : `Turn ${i}: generic filler content about topic ${i}.`,
                sessionId: 1,
                turnIndex: i,
            })),
            qa: [],
        };

        const seedResult = await seedConversation(conv, {
            chatIdPrefix: 'regression-9-4-7',
            now: FIXED_NOW,
            keepBackend: true,
        });
        const state = await loadState(seedResult.chatId);

        // Belt-and-braces: seeder invariant
        expect(state.workingBuffer.length).toBe(0);

        // End-to-end: query the seeded state
        const now = new Date('2026-04-20T12:00:00Z');
        const result = retrieve(state, 'where does alice live', { now, k: 5 });

        // At least one result — seeder produced episodic entries
        expect(result.entries.length).toBeGreaterThan(0);

        // No working-scope entries in the top-K (buffer is empty, so
        // prependWorking adds nothing)
        const workingInTopK = result.entries.filter(e => e.scope === 'working');
        expect(workingInTopK).toEqual([]);

        // At least one episodic entry in the top-K
        const episodicInTopK = result.entries.filter(e => e.scope === 'episodic');
        expect(episodicInTopK.length).toBeGreaterThan(0);

        // No Infinity scores leaked through the trace
        // (Working entries would carry score=Infinity via prependWorking;
        // if any made it into the result, this assertion fails.)
        const perTier2 = result.trace?.perTier?.['2'];
        if (Array.isArray(perTier2)) {
            for (const r of perTier2) {
                if (r && typeof r === 'object' && 'score' in r) {
                    expect(Number.isFinite(/** @type {{score:number}} */ (r).score)).toBe(true);
                }
            }
        }

        cleanup();
    });
});
