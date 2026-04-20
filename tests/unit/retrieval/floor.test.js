import { floor } from '../../../src/retrieval/floor.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content: id, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, id, ...overrides };
}

function state(entries) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('floor', () => {
    test('empty state → empty array', () => {
        expect(floor(state([]), { now })).toEqual([]);
    });

    test('sorts by recency × importance × maturity_boost descending', () => {
        const fresh = ep('fresh', {
            lifecycle: { importance: 50, maturity: 'draft', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        const old = ep('old', {
            lifecycle: { importance: 50, maturity: 'draft', createdAt: '2025-04-20T12:00:00Z', updatedAt: '2025-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        const result = floor(state([old, fresh]), { now });
        expect(result[0].entry.id).toBe('fresh');
        expect(result[1].entry.id).toBe('old');
    });

    test('core maturity outranks draft at equal importance + age', () => {
        const core = ep('c', {
            lifecycle: { importance: 50, maturity: 'core', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        const draft = ep('d', {
            lifecycle: { importance: 50, maturity: 'draft', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        expect(floor(state([draft, core]), { now })[0].entry.id).toBe('c');
    });

    test('respects k parameter (truncates to top k)', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ep(`e${i}`));
        const result = floor(state(entries), { now, k: 3 });
        expect(result).toHaveLength(3);
    });

    test('defaults k to 5', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ep(`e${i}`));
        expect(floor(state(entries), { now })).toHaveLength(5);
    });

    test('excludes working-scope entries', () => {
        const w = ep('w'); w.scope = 'working';
        const e = ep('e');
        const result = floor(state([w, e]), { now });
        expect(result.every(r => r.entry.id !== 'w')).toBe(true);
    });

    test('ScoredEntry shape has bm25=0 (Floor has no BM25 factor)', () => {
        const result = floor(state([ep('a')]), { now });
        expect(result[0].bm25).toBe(0);
        expect(result[0].score).toBeGreaterThan(0);
    });
});
