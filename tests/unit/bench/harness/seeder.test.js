import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { seedConversation } from '../../../../bench/harness/seeder.js';
import { loadState, _resetBackendForTests } from '../../../../src/core/state.js';
import { _resetLocksForTests } from '../../../../src/core/lock.js';
import { _resetLLMClientForTests, callLLM } from '../../../../src/consolidation/llmClient.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

/** @type {import('../../../../bench/loaders/locomo.js').CorpusConversation} */
const CONV = {
    id: 'test-1',
    turns: [
        { speaker: 'Alice', text: 'I moved to Paris last summer. It is a beautiful city.', sessionId: 1, turnIndex: 0 },
        { speaker: 'Bob',   text: 'Paris is lovely in spring. The gardens bloom early.', sessionId: 1, turnIndex: 1 },
        { speaker: 'Alice', text: 'Charlie visited Rome during winter. The Colosseum was amazing.', sessionId: 1, turnIndex: 2 },
        { speaker: 'Bob',   text: 'Rome has ancient history. Diana loves the architecture.', sessionId: 1, turnIndex: 3 },
        { speaker: 'Alice', text: 'Emma traveled to London. The Thames flows through the city.', sessionId: 1, turnIndex: 4 },
        { speaker: 'Bob',   text: 'London is foggy in autumn. Frank prefers sunny weather.', sessionId: 1, turnIndex: 5 },
        { speaker: 'Alice', text: 'Grace moved to Berlin. The Brandenburg Gate is iconic.', sessionId: 1, turnIndex: 6 },
        { speaker: 'Bob',   text: 'Berlin has great museums. Henry studied art there.', sessionId: 1, turnIndex: 7 },
        { speaker: 'Alice', text: 'Irene visited Madrid. The Prado museum has masterpieces.', sessionId: 1, turnIndex: 8 },
        { speaker: 'Bob',   text: 'Madrid is vibrant at night. Jack enjoys the tapas.', sessionId: 1, turnIndex: 9 },
        { speaker: 'Alice', text: 'Kate moved to Lisbon. The trams are charming.', sessionId: 1, turnIndex: 10 },
        { speaker: 'Bob',   text: 'Lisbon has beautiful coastlines. Liam surfs every morning.', sessionId: 1, turnIndex: 11 },
        { speaker: 'Alice', text: 'Maria visited Vienna. The opera house is stunning.', sessionId: 1, turnIndex: 12 },
        { speaker: 'Bob',   text: 'Vienna has classical music. Noah plays the piano.', sessionId: 1, turnIndex: 13 },
        { speaker: 'Alice', text: 'Olivia moved to Prague. The castle overlooks the city.', sessionId: 1, turnIndex: 14 },
    ],
    qa: [],
};

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

describe('seedConversation', () => {
    test('returns correct chatId with default prefix', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        expect(r.chatId).toBe('bench-test-1');
    });

    test('returns custom chatId with custom prefix', async () => {
        const r = await seedConversation(CONV, { chatIdPrefix: 'custom', now: FIXED_NOW });
        expect(r.chatId).toBe('custom-test-1');
    });

    test('turnsProcessed equals conversation length', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        expect(r.turnsProcessed).toBe(15);
    });

    test('factCount is greater than zero', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        expect(r.factCount).toBeGreaterThan(0);
    });

    test('after run, state contains episodic entries', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW, keepBackend: true });
        const state = await loadState(r.chatId);
        const episodic = Object.values(state.entries).filter(e => e.scope === 'episodic');
        expect(episodic.length).toBeGreaterThan(0);
        cleanup();
    });

    test('working buffer is below threshold after consolidation drained', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        const state = await loadState(r.chatId);
        expect(state.workingBuffer.length).toBeLessThan(10);
    });

    test('stateHash is deterministic across two runs with same input', async () => {
        const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
        try {
            const r1 = await seedConversation(CONV, { now: FIXED_NOW });
            cleanup();
            const r2 = await seedConversation(CONV, { now: FIXED_NOW });
            expect(r1.stateHash).toBe(r2.stateHash);
        } finally {
            spy.mockRestore();
        }
    });

    test('different conv.id produces different chatId and independent states', async () => {
        const conv2 = { ...CONV, id: 'test-2' };
        const r1 = await seedConversation(CONV, { now: FIXED_NOW });
        const r2 = await seedConversation(conv2, { now: FIXED_NOW });
        expect(r1.chatId).toBe('bench-test-1');
        expect(r2.chatId).toBe('bench-test-2');
        expect(r1.stateHash).not.toBe(r2.stateHash);
    });

    test('keepBackend=true leaves backend installed', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW, keepBackend: true });
        const state = await loadState(r.chatId);
        expect(Object.keys(state.entries).length).toBeGreaterThan(0);
        cleanup();
    });

    test('keepBackend=false (default) resets backend', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        // After seedConversation with keepBackend=false, the backend is reset.
        // loadState should return empty state because the default backend
        // (SillyTavern) has nothing for this chatId.
        const state = await loadState(r.chatId);
        expect(Object.keys(state.entries)).toHaveLength(0);
        expect(state.workingBuffer).toHaveLength(0);
    });

    test('handles empty turns gracefully (no crash, zero facts)', async () => {
        const emptyConv = {
            id: 'empty',
            turns: [
                { speaker: 'Alice', text: '', sessionId: 1, turnIndex: 0 },
                { speaker: 'Bob', text: '   ', sessionId: 1, turnIndex: 1 },
            ],
            qa: [],
        };
        const r = await seedConversation(emptyConv, { now: FIXED_NOW });
        expect(r.turnsProcessed).toBe(2);
        expect(r.factCount).toBe(0);
    });

    test('skips turns with no capitalized words', async () => {
        const noCapConv = {
            id: 'nocap',
            turns: [
                { speaker: 'Alice', text: 'hello world. this is a test.', sessionId: 1, turnIndex: 0 },
                { speaker: 'Bob', text: 'another lowercase sentence here.', sessionId: 1, turnIndex: 1 },
            ],
            qa: [],
        };
        const r = await seedConversation(noCapConv, { now: FIXED_NOW });
        expect(r.factCount).toBe(0);
    });

    test('skips turns with stop-word-only capitalized words', async () => {
        const stopConv = {
            id: 'stop',
            turns: [
                { speaker: 'Alice', text: 'The The. It Is. A An.', sessionId: 1, turnIndex: 0 },
            ],
            qa: [],
        };
        const r = await seedConversation(stopConv, { now: FIXED_NOW });
        expect(r.factCount).toBe(0);
    });

    test('mock LLM is installed during run and restored after keepBackend=false', async () => {
        // Install a sentinel mock that returns empty entries.
        _resetLLMClientForTests();
        let sentinelCalled = false;
        const { _setLLMClientForTests } = await import('../../../../src/consolidation/llmClient.js');
        _setLLMClientForTests(async () => {
            sentinelCalled = true;
            return JSON.stringify({ entries: [] });
        });

        // seedConversation should replace the sentinel with its own rule-based mock.
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        // If the sentinel was still active, factCount would be 0.
        expect(r.factCount).toBeGreaterThan(0);
        expect(sentinelCalled).toBe(false);

        // After keepBackend=false, the default LLM is restored.
        // Calling callLLM should throw because ST context is unavailable.
        await expect(callLLM('bench', [{ role: 'user', content: 'x' }], 100))
            .rejects.toThrow(/SillyTavern|unavailable/i);
    });

    test('accumulates consolidationStats across turns', async () => {
        const r = await seedConversation(CONV, { now: FIXED_NOW });
        expect(r.consolidationStats).toBeDefined();
        expect(typeof r.consolidationStats.added).toBe('number');
        expect(r.consolidationStats.added).toBeGreaterThanOrEqual(0);
        expect(r.consolidationStats.batches).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(r.consolidationStats.factLengths)).toBe(true);
    });
});
