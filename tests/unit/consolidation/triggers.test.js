import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer, _resetTimersForTests,
} from '../../../src/consolidation/triggers.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const CHAT = 'chat-1';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');
const OPTS = {
    profileId: 'p', extractorLabel: 'x@v1',
    messageOf: (e) => ({ role: 'user', content: e.content }),
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _resetTimersForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetTimersForTests();
    _resetLLMClientForTests();
});

function we(content) {
    return createEntry({
        scope: 'working', content, subject: null, tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 'test' }, now: FIXED_NOW,
    });
}

describe('maybeConsolidate gates', () => {
    test("'buffer' reason: skips when buffer < 10", async () => {
        const w = Array.from({ length: 5 }, (_, i) => we(`t${i}`));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });

        const r = await maybeConsolidate(CHAT, 'buffer', OPTS);
        expect(r).toEqual({ skipped: true, why: 'below-threshold' });
    });

    test("'buffer' reason: fires at threshold", async () => {
        const w = Array.from({ length: 10 }, (_, i) => we(`t${i}`));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        _setLLMClientForTests(async () =>
            JSON.stringify({ entries: [{ content: 'f', subject: 'alice' }] }),
        );
        const r = /** @type {any} */ (await maybeConsolidate(CHAT, 'buffer', OPTS));
        expect(r.drained).toBe(5);
    });

    test("'idle' reason: fires on non-empty buffer regardless of size", async () => {
        const w = [we('one')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        _setLLMClientForTests(async () =>
            JSON.stringify({ entries: [{ content: 'f', subject: 'alice' }] }),
        );
        const r = /** @type {any} */ (await maybeConsolidate(CHAT, 'idle', OPTS));
        expect(r.drained).toBe(1);
    });

    test('skips on empty buffer regardless of reason', async () => {
        store.set(CHAT, createEmptyState());
        const r1 = await maybeConsolidate(CHAT, 'buffer', OPTS);
        expect(r1).toEqual({ skipped: true, why: 'empty-buffer' });
        const r2 = await maybeConsolidate(CHAT, 'idle', OPTS);
        expect(r2).toEqual({ skipped: true, why: 'empty-buffer' });
    });

    test('skips when runtime.consolidating === true', async () => {
        const w = Array.from({ length: 10 }, (_, i) => we(`t${i}`));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            runtime: {
                lastConsolidation: null, pendingPersonaRebuild: false,
                consolidating: true, episodicCountSinceLastRebuild: 0, traces: [],
            },
        });
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });
        const r = await maybeConsolidate(CHAT, 'buffer', OPTS);
        expect(r).toEqual({ skipped: true, why: 'already-running' });
    });

    test('throws on bad inputs', async () => {
        await expect(maybeConsolidate('', 'buffer', OPTS)).rejects.toThrow(/chatId/);
        await expect(maybeConsolidate(CHAT, /** @type {any} */ ('bogus'), OPTS))
            .rejects.toThrow(/reason/);
    });
});

describe('idle timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('fires maybeConsolidate(idle) after 60s of inactivity', async () => {
        const w = [we('hello')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++;
            return JSON.stringify({ entries: [{ content: 'f', subject: 'alice' }] });
        });

        resetIdleTimer(CHAT, OPTS);
        // Advance to 59s — should not have fired
        jest.advanceTimersByTime(59_000);
        expect(llmCalls).toBe(0);

        // Cross the 60s boundary
        jest.advanceTimersByTime(2_000);
        // Drain microtasks / pending async
        await Promise.resolve();
        await Promise.resolve();
        // The LLM call may still be pending here because consolidate awaits loadState → lock → extractFacts.
        // Flush any pending promises.
        await jest.runAllTimersAsync();
        expect(llmCalls).toBeGreaterThanOrEqual(1);
    });

    test('resetIdleTimer debounces — repeated resets delay the firing', async () => {
        const w = [we('hello')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++;
            return '{"entries":[]}';
        });

        resetIdleTimer(CHAT, OPTS);
        jest.advanceTimersByTime(30_000);
        resetIdleTimer(CHAT, OPTS);      // reset at 30s
        jest.advanceTimersByTime(30_000); // total 60s, but reset at 30s → not yet
        await Promise.resolve();
        expect(llmCalls).toBe(0);

        jest.advanceTimersByTime(31_000); // now 61s since last reset
        await jest.runAllTimersAsync();
        expect(llmCalls).toBeGreaterThanOrEqual(1);
    });

    test('cancelIdleTimer prevents firing', async () => {
        const w = [we('hello')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++; return '{"entries":[]}';
        });

        resetIdleTimer(CHAT, OPTS);
        cancelIdleTimer(CHAT);
        jest.advanceTimersByTime(120_000);
        await jest.runAllTimersAsync();
        expect(llmCalls).toBe(0);
    });
});
