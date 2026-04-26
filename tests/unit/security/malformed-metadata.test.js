/**
 * Regressions for findings #3, #5, #13, #15, #16: corrupted or imported
 * chat metadata, and drift between createEntry and isValidEntry, must not
 * crash retrieval or produce malformed entries.
 */
import { describe, test, expect } from '@jest/globals';

describe('malformed metadata defense', () => {
    test('finding #3: Tier 3 does not crash when graph.edges is missing', async () => {
        const { retrieve } = await import('../../../src/retrieval/index.js');
        const { createEmptyState } = await import('../../../src/core/schema.js');
        const state = createEmptyState();
        // Simulate corrupted import: graph present but edges missing.
        state.graph = /** @type {any} */ ({ edges: undefined });
        expect(() => retrieve(state, 'any query', { now: new Date() })).not.toThrow();
    });

    test('finding #3: loadState rejects state with non-array graph.edges', async () => {
        const { loadState, setBackend, _resetBackendForTests } =
            await import('../../../src/core/state.js');
        const { createEmptyState } = await import('../../../src/core/schema.js');
        const malformed = { ...createEmptyState(), graph: { edges: 'not-an-array' } };
        setBackend({
            read: () => malformed,
            write: () => {},
        });
        // Malformed state → loadState returns a fresh empty state.
        const loaded = await loadState('c1');
        expect(Array.isArray(loaded.graph.edges)).toBe(true);
        expect(loaded.graph.edges).toHaveLength(0);
        _resetBackendForTests();
    });

    test('finding #5: floor() skips entries with malformed lifecycle', async () => {
        const { floor } = await import('../../../src/retrieval/floor.js');
        const state = /** @type {any} */ ({
            entries: {
                'ok': {
                    id: 'ok', scope: 'episodic', content: 'x', subject: null,
                    tags: [], relations: [],
                    lifecycle: {
                        importance: 50, maturity: 'draft',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        accessCount: 0, updateCount: 0,
                    },
                    provenance: { sourceMessages: [], extractor: 't' },
                },
                'bad': { id: 'bad', scope: 'episodic', content: 'y' /* lifecycle missing */ },
            },
        });
        expect(() => floor(state, { now: new Date(), k: 5 })).not.toThrow();
        const results = floor(state, { now: new Date(), k: 5 });
        expect(results.map(r => r.entry.id)).toEqual(['ok']);
    });

    test('finding #13: consolidate clears stale consolidating flag on happy-path skip', async () => {
        const { consolidate } = await import('../../../src/consolidation/consolidate.js');
        const { setBackend, _resetBackendForTests } =
            await import('../../../src/core/state.js');
        const { createEmptyState } = await import('../../../src/core/schema.js');

        let stored = /** @type {any} */ ({ ...createEmptyState() });
        stored.runtime.consolidating = true; // simulate stuck flag
        setBackend({
            read: () => structuredClone(stored),
            write: (_id, v) => { stored = v; },
        });

        const result = await consolidate('c1', {
            profileId: 'p1', extractorLabel: 'test@v1',
            messageOf: (e) => ({ role: 'assistant', content: e.content }),
            now: new Date(),
        });
        expect(result).toEqual({ skipped: true });
        // The skipped branch must clear the flag on disk so the next trigger proceeds.
        expect(stored.runtime.consolidating).toBe(false);
        _resetBackendForTests();
    });

    test('finding #15: default backend hard-fails when bootstrap has not run', async () => {
        const { loadState, _resetBackendForTests } = await import('../../../src/core/state.js');
        _resetBackendForTests();
        // No globalThis.SillyTavern → default backend's read should throw a clear error.
        delete (/** @type {any} */ (globalThis)).SillyTavern;
        await expect(loadState('c1')).rejects.toThrow(/bootstrap|setBackend/i);
    });

    test('finding #16: createEntry rejects non-string tags', async () => {
        const { createEntry } = await import('../../../src/memory/entry.js');
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null,
            // @ts-expect-error — deliberately non-string element to exercise the guard.
            tags: ['ok', 42],
            relations: [],
            provenance: { sourceMessages: [0], extractor: 't' },
            now: new Date(),
        })).toThrow(/tags.*string/i);
    });

    test('finding #16: createEntry rejects relations missing type/target', async () => {
        const { createEntry } = await import('../../../src/memory/entry.js');
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [],
            // @ts-expect-error — deliberately invalid edge type.
            relations: [{ type: 'bogus_type', target: 'ep_1' }],
            provenance: { sourceMessages: [0], extractor: 't' },
            now: new Date(),
        })).toThrow(/relation/i);
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [],
            relations: [{ type: 'mentions', target: '' }],
            provenance: { sourceMessages: [0], extractor: 't' },
            now: new Date(),
        })).toThrow(/relation|target/i);
    });

    test('finding #16: createEntry rejects non-integer sourceMessages', async () => {
        const { createEntry } = await import('../../../src/memory/entry.js');
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [],
            relations: [],
            // @ts-expect-error — deliberately mixed-type sourceMessages.
            provenance: { sourceMessages: [0, '1', 2.5], extractor: 't' },
            now: new Date(),
        })).toThrow(/sourceMessages/i);
    });
});
