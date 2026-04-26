import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { consolidate } from '../../../src/consolidation/consolidate.js';
import { loadState, setBackend, _resetBackendForTests }
    from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const CHAT = 'chat-1';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'gemma-4-31b',
    extractorLabel: 'gemma-4-31b@v1',
    messageOf: (/** @type {import('../../../src/core/schema.js').Entry} */ e) =>
        ({ role: /** @type {const} */ ('user'), content: e.content }),
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({
        read: (id) => store.get(id),
        write: (id, v) => { store.set(id, v); },
    });
    _resetLocksForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
});

/** @param {Partial<import('../../../src/core/schema.js').State>} [over] */
async function seed(over) {
    const s = { ...createEmptyState(), ...(over ?? {}) };
    store.set(CHAT, s);
    return s;
}

/** Helper: build a Working entry and register it in state.entries + workingBuffer. */
function workingEntry(content) {
    return createEntry({
        scope: 'working', content, subject: null, tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 'test-interceptor' },
        now: FIXED_NOW,
    });
}

describe('consolidate', () => {
    test('no-op on empty buffer', async () => {
        await seed();
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });
        const result = await consolidate(CHAT, OPTS);
        expect(result).toEqual({ added: 0, updated: 0, drained: 0, parseFailures: 0, entriesSkipped: 0 });
    });

    test('drains up to BATCH_SIZE (5) and adds extracted facts', async () => {
        const w = Array.from({ length: 7 }, (_, i) => workingEntry(`turn ${i}`));
        const state = await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        expect(state.workingBuffer).toHaveLength(7);

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                { content: 'alice traveled to marseille', subject: 'alice', tags: ['travel'] },
                { content: 'alice met bob there', subject: 'alice' },
            ],
        }));

        const r = await consolidate(CHAT, OPTS);
        expect(r).toEqual({ added: 2, updated: 0, drained: 5, parseFailures: 0, entriesSkipped: 0 });

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(2);  // 7 - 5 = 2
        const episodicCount = Object.values(after.entries).filter(e => e.scope === 'episodic').length;
        expect(episodicCount).toBe(2);
        expect(after.runtime.consolidating).toBe(false);
        expect(after.runtime.lastConsolidation).toBe(FIXED_NOW.toISOString());
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(2);
    });

    test('dedup path: same subject + similar content bumps existing importance', async () => {
        // Pre-seed an Episodic entry
        const existing = createEntry({
            scope: 'episodic', content: 'alice traveled to marseille',
            subject: 'alice', tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'prior' },
            now: new Date('2026-04-19T10:00:00Z'),
        });
        const w = [workingEntry('user talks about alice trip')];
        await seed({
            entries: { [existing.id]: existing, [w[0].id]: w[0] },
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                // Near-duplicate content of existing (Jaccard ≥ 0.7)
                { content: 'alice traveled to marseille train', subject: 'alice' },
            ],
        }));

        const r = await consolidate(CHAT, OPTS);
        expect(r).toEqual({ added: 0, updated: 1, drained: 1, parseFailures: 0, entriesSkipped: 0 });

        const after = await loadState(CHAT);
        // Existing entry's importance should have bumped from 50 → 55 (applyUpdateEvent adds UPDATE_BONUS=5)
        expect(after.entries[existing.id].lifecycle.importance).toBe(55);
        expect(after.entries[existing.id].lifecycle.updateCount).toBe(1);
        // No new episodic entry
        const episodicCount = Object.values(after.entries).filter(e => e.scope === 'episodic').length;
 expect(episodicCount).toBe(1);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);  // updates don't count
    });

    test('LLM failure leaves working buffer intact and flag cleared', async () => {
        const w = [workingEntry('a'), workingEntry('b')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => { throw new Error('LLM down'); });

        await expect(consolidate(CHAT, OPTS)).rejects.toThrow(/LLM down/);

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(2);  // unchanged
        expect(after.runtime.consolidating).toBe(false);  // not stuck
        expect(after.runtime.lastConsolidation).toBeNull();  // never succeeded
    });

    test('parse failure soft-fails and drains the batch', async () => {
        // Phase 12 Task 7 behavior change: parse failures (truncation,
        // malformed JSON) are content-level — drain the batch, persist,
        // return parseFailures=1 so the bench harness reports rate.
        // Aborting would leave the buffer over-threshold and re-fire on
        // every turn against the same cached bad response (infinite
        // loop on cache replay).
        const w = Array.from({ length: 7 }, (_, i) => workingEntry(`p${i}`));
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => 'not valid json at all');

        const result = await consolidate(CHAT, OPTS);
        expect(result).toEqual({ added: 0, updated: 0, drained: 5, parseFailures: 1, entriesSkipped: 0 });

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(2);  // 7 - BATCH_SIZE(5) = 2
        // No new episodic entries from the parse-failed batch — only
        // the seven Working entries we started with should remain.
        const episodicCount = Object.values(after.entries)
            .filter(e => e.scope === 'episodic').length;
        expect(episodicCount).toBe(0);
        // Lock released, consolidating flag cleared, state persisted.
        expect(after.runtime.consolidating).toBe(false);
    });

    test('LLM transport failure still aborts and leaves state intact', async () => {
        // Distinguishes from parse-failure behavior above: a transport
        // / network / 4xx-5xx error is potentially transient, so we
        // preserve the buffer for natural retry on the next trigger.
        const w = [workingEntry('a')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => { throw new Error('connection reset'); });

        await expect(consolidate(CHAT, OPTS)).rejects.toThrow('connection reset');

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(1);
        expect(after.runtime.consolidating).toBe(false);
    });

    test('invalidates Tier 0 cache after a successful run', async () => {
        const w = [workingEntry('x')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            tierCaches: { exact: { 'abcd1234': ['some-id'] }, fuzzy: {} },
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'alice did a thing', subject: 'alice' }],
        }));

        await consolidate(CHAT, OPTS);

        const after = await loadState(CHAT);
        expect(after.tierCaches.exact).toEqual({});
    });

    test('builds edges for newly-added entries (mentions co-occurrence)', async () => {
        // Pre-seed an Episodic entry with a distinct capitalized entity "Marseille"
        const existing = createEntry({
            scope: 'episodic', content: 'Alice visited Marseille last week',
            subject: 'Alice', tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'prior' },
            now: new Date('2026-04-19T10:00:00Z'),
        });
        const w = [workingEntry('x')];
        await seed({
            entries: { [existing.id]: existing, [w[0].id]: w[0] },
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'Alice ate croissants in Marseille', subject: 'Alice' }],
        }));

        const r = await consolidate(CHAT, OPTS);
        expect(/** @type {any} */(r).added).toBe(1);

        const after = await loadState(CHAT);
        expect(after.graph.edges.length).toBeGreaterThan(0);
        // At least one mentions edge from the new entry back to `existing`
        const newEntryId = Object.keys(after.entries).find(id => id !== existing.id && id !== w[0].id);
        expect(newEntryId).toBeDefined();
        const hasMentions = after.graph.edges.some(
            e => e.from === newEntryId && e.to === existing.id && e.type === 'mentions',
        );
        expect(hasMentions).toBe(true);
    });

    test('flips pendingPersonaRebuild when episodicCountSinceLastRebuild crosses threshold', async () => {
        const w = [workingEntry('x')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: false,
                consolidating: false,
                episodicCountSinceLastRebuild: 99,
                traces: [],
            },
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'a new fact', subject: 'alice' }],
        }));

        await consolidate(CHAT, OPTS);

        const after = await loadState(CHAT);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(100);
        expect(after.runtime.pendingPersonaRebuild).toBe(true);
    });

    test('concurrent calls serialize via write lock (no duplicated drain)', async () => {
        const w = Array.from({ length: 7 }, (_, i) => workingEntry(`t${i}`));
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        /** @type {number} */
        let calls = 0;
        _setLLMClientForTests(async () => {
            calls++;
            // Return a single fact per call so we can count drains
            return JSON.stringify({ entries: [{ content: `fact ${calls}`, subject: 'alice' }] });
        });

        const [r1, r2] = await Promise.all([
            consolidate(CHAT, OPTS),
            consolidate(CHAT, OPTS),
        ]);

        // Two runs: first drains 5, second drains 2
        const drained = [r1, r2].map(r => /** @type {any} */ (r).drained).sort();
        expect(drained).toEqual([2, 5]);
        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(0);
    });

    test('propagates through bad options', async () => {
        await expect(consolidate('', OPTS)).rejects.toThrow(/chatId/);
        await expect(consolidate(CHAT, /** @type {any} */ ({}))).rejects.toThrow(/profileId/);
    });
});
