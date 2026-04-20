/**
 * Phase 6 integration test: 12-turn conversation, mock LLM, verify:
 *   1. First 10 turns don't trigger
 *   2. Turn 10 (buffer reaches threshold) triggers; drains 5
 *   3. After drain, buffer has 5 entries, 2 new Episodic facts exist,
 *      edges built, Tier 0 cache cleared
 *   4. Running again on the same state is a no-op (below threshold after drain)
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { maybeConsolidate } from '../../../src/consolidation/index.js';
import { loadState, persistState, setBackend, _resetBackendForTests }
    from '../../../src/core/state.js';
import { _resetLocksForTests, withWriteLock } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const CHAT = 'chat-pipeline';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
});

/** Push a working-scope entry into state, through the write lock. */
async function pushWorking(content, msgIdx) {
    await withWriteLock(CHAT, async () => {
        const s = await loadState(CHAT);
        const e = createEntry({
            scope: 'working', content, subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [msgIdx], extractor: 'test-interceptor' },
            now: new Date(FIXED_NOW.getTime() + msgIdx * 1000),
        });
        const next = {
            ...s,
            entries: { ...s.entries, [e.id]: e },
            workingBuffer: [...s.workingBuffer, e.id],
        };
        await persistState(CHAT, next);
    });
}

describe('consolidation pipeline end-to-end', () => {
    test('12 turns: triggers at 10, drains 5, leaves 5, adds Episodic facts', async () => {
        store.set(CHAT, createEmptyState());

        // Simulate 12 turns of user activity through the interceptor pattern
        for (let i = 0; i < 12; i++) {
            await pushWorking(`turn ${i} content about Alice and Marseille`, i);

            // After each turn, interceptor would call maybeConsolidate('buffer').
            // Simulate the mock LLM returning 2 facts the first time it fires.
            _setLLMClientForTests(async () => JSON.stringify({
                entries: [
                    { content: 'Alice traveled to Marseille', subject: 'Alice', tags: ['travel'] },
                    { content: 'Alice is a traveler', subject: 'Alice', tags: ['character'] },
                ],
            }));

            const r = await maybeConsolidate(CHAT, 'buffer', {
                profileId: 'test',
                extractorLabel: 'mock@v1',
                messageOf: (e) => ({ role: 'user', content: e.content }),
                now: FIXED_NOW,
            });

            // Turns 0-8: below threshold, skipped
            if (i < 9) {
                expect(r).toEqual({ skipped: true, why: 'below-threshold' });
            }
            // Turn 9 pushes buffer to 10 → fires
            if (i === 9) {
                expect(/** @type {any} */ (r).drained).toBe(5);
                expect(/** @type {any} */ (r).added).toBe(2);
            }
            // Turns 10, 11: buffer is now 5 then 6 — below threshold again
            if (i >= 10) {
                expect(r).toEqual({ skipped: true, why: 'below-threshold' });
            }
        }

        const after = await loadState(CHAT);
        // 12 appended - 5 drained = 7 remaining
        expect(after.workingBuffer).toHaveLength(7);
        const episodic = Object.values(after.entries).filter(e => e.scope === 'episodic');
        expect(episodic).toHaveLength(2);

        // Edges exist (co-occurrence between the two episodic entries on "Alice" / "Marseille")
        expect(after.graph.edges.length).toBeGreaterThan(0);

        // Cache cleared
        expect(after.tierCaches.exact).toEqual({});

        // Runtime updated
        expect(after.runtime.consolidating).toBe(false);
        expect(after.runtime.lastConsolidation).toBe(FIXED_NOW.toISOString());
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(2);
        expect(after.runtime.pendingPersonaRebuild).toBe(false);  // 2 < 100
    });

    test('consecutive maybeConsolidate calls with empty buffer short-circuit', async () => {
        store.set(CHAT, createEmptyState());
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });

        const r1 = await maybeConsolidate(CHAT, 'buffer', {
            profileId: 'test', extractorLabel: 'x@v1',
            messageOf: (e) => ({ role: 'user', content: e.content }),
            now: FIXED_NOW,
        });
        const r2 = await maybeConsolidate(CHAT, 'idle', {
            profileId: 'test', extractorLabel: 'x@v1',
            messageOf: (e) => ({ role: 'user', content: e.content }),
            now: FIXED_NOW,
        });

        expect(r1).toEqual({ skipped: true, why: 'empty-buffer' });
        expect(r2).toEqual({ skipped: true, why: 'empty-buffer' });
    });
});
