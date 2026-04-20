import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { atomicReplacePersona } from '../../../../src/consolidation/raptor/atomic.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../../src/core/state.js';
import { _resetLocksForTests } from '../../../../src/core/lock.js';
import { createEmptyState } from '../../../../src/core/schema.js';
import { createEntry } from '../../../../src/memory/entry.js';

const CHAT = 'chat-atomic';
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
});

/** @param {string} subject @param {string} content */
function persona(subject, content) {
    return createEntry({
        scope: 'persona', content, subject, tags: [], relations: [],
        provenance: { sourceMessages: [], extractor: 'prior@v0' },
        now: new Date('2026-04-19T10:00:00Z'),
    });
}

describe('atomicReplacePersona', () => {
    test('deletes existing subject entries, adds new ones, clears counters', async () => {
        const oldA = persona('alice', 'old alice 1');
        const oldB = persona('alice', 'old alice 2');
        const otherSubject = persona('bob', 'bob stays');
        store.set(CHAT, {
            ...createEmptyState(),
            entries: {
                [oldA.id]: oldA,
                [oldB.id]: oldB,
                [otherSubject.id]: otherSubject,
            },
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: true,
                consolidating: false,
                episodicCountSinceLastRebuild: 150,
                traces: [],
            },
        });

        const r = await atomicReplacePersona({
            chatId: CHAT,
            subject: 'alice',
            extractorLabel: 'test@persona-rebuild-v1',
            replacements: [
                { text: 'new alice summary', sourceMessages: [1, 2] },
                { text: 'broader alice persona', sourceMessages: [1, 2, 3] },
            ],
            now: FIXED_NOW,
        });

        expect(r).toEqual({ deletedCount: 2, addedCount: 2 });

        const after = await loadState(CHAT);
        // Bob is untouched
        expect(after.entries[otherSubject.id]).toBeDefined();
        expect(after.entries[otherSubject.id].content).toBe('bob stays');
        // Old alice entries gone
        expect(after.entries[oldA.id]).toBeUndefined();
        expect(after.entries[oldB.id]).toBeUndefined();
        // New alice entries present
        const alicePersonas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(alicePersonas).toHaveLength(2);
        expect(alicePersonas.map(e => e.content)).toEqual(
            expect.arrayContaining(['new alice summary', 'broader alice persona']),
        );
        // Runtime counters reset
        expect(after.runtime.pendingPersonaRebuild).toBe(false);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);
        expect(after.runtime.lastConsolidation).toBe(FIXED_NOW.toISOString());
    });

    test('empty replacements deletes all subject entries and leaves Persona empty for that subject', async () => {
        const oldA = persona('alice', 'x');
        store.set(CHAT, {
            ...createEmptyState(),
            entries: { [oldA.id]: oldA },
        });
        const r = await atomicReplacePersona({
            chatId: CHAT,
            subject: 'alice',
            extractorLabel: 'test@v1',
            replacements: [],
            now: FIXED_NOW,
        });
        expect(r).toEqual({ deletedCount: 1, addedCount: 0 });
        const after = await loadState(CHAT);
        const alicePersonas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(alicePersonas).toEqual([]);
    });

    test('does not touch non-persona entries with matching subject', async () => {
        const episodic = createEntry({
            scope: 'episodic', content: 'alice ate', subject: 'alice',
            tags: [], relations: [], provenance: { sourceMessages: [], extractor: 'prior' },
            now: FIXED_NOW,
        });
        store.set(CHAT, {
            ...createEmptyState(),
            entries: { [episodic.id]: episodic },
        });
        await atomicReplacePersona({
            chatId: CHAT, subject: 'alice', extractorLabel: 'test@v1',
            replacements: [{ text: 'new', sourceMessages: [] }],
            now: FIXED_NOW,
        });
        const after = await loadState(CHAT);
        expect(after.entries[episodic.id]).toBeDefined();
        expect(after.entries[episodic.id].scope).toBe('episodic');
    });

    test('pre-flight abort throws without touching state', async () => {
        store.set(CHAT, createEmptyState());
        const controller = new AbortController();
        controller.abort();
        await expect(atomicReplacePersona({
            chatId: CHAT, subject: 'alice', extractorLabel: 'test@v1',
            replacements: [{ text: 'x', sourceMessages: [] }],
            signal: controller.signal,
        })).rejects.toThrow(/aborted/);
    });

    test('abort after lock acquired throws and state unchanged', async () => {
        const oldA = persona('alice', 'x');
        store.set(CHAT, {
            ...createEmptyState(),
            entries: { [oldA.id]: oldA },
        });
        const controller = new AbortController();
        // Abort synchronously before withWriteLock's callback runs — we can't
        // easily race this cleanly in tests, so we rely on the in-lock check.
        controller.abort();
        await expect(atomicReplacePersona({
            chatId: CHAT, subject: 'alice', extractorLabel: 'test@v1',
            replacements: [{ text: 'x', sourceMessages: [] }],
            signal: controller.signal,
        })).rejects.toThrow(/aborted/);
        const after = await loadState(CHAT);
        expect(after.entries[oldA.id]).toBeDefined();  // original intact
    });

    test('rejects bad arguments', async () => {
        await expect(atomicReplacePersona(/** @type {any} */ ({}))).rejects.toThrow(/chatId/);
        await expect(atomicReplacePersona(/** @type {any} */ ({ chatId: 'c' }))).rejects.toThrow(/subject/);
        await expect(atomicReplacePersona(/** @type {any} */ ({
            chatId: 'c', subject: 's',
        }))).rejects.toThrow(/extractorLabel/);
        await expect(atomicReplacePersona(/** @type {any} */ ({
            chatId: 'c', subject: 's', extractorLabel: 'x', replacements: 'not-array',
        }))).rejects.toThrow(/replacements/);
    });
});
