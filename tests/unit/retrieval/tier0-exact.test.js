import {
    tier0,
    recordTier0,
    invalidateTier0Cache,
    normalizeQuery,
    hashQuery,
} from '../../../src/retrieval/tier0-exact.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function seedState(entries = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

function ep(id, content) {
    const e = createEntry({
        scope: 'episodic', content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id };
}

describe('normalizeQuery', () => {
    test('trims and lowercases', () => {
        expect(normalizeQuery('  Hello WORLD  ')).toBe('hello world');
    });

    test('preserves internal whitespace (Tier 1 tokenizes)', () => {
        expect(normalizeQuery('Alice  and   Bob')).toBe('alice  and   bob');
    });

    test('rejects non-strings', () => {
        expect(() => normalizeQuery(/** @type {any} */ (null))).toThrow(/string/);
    });
});

describe('hashQuery', () => {
    test('is deterministic', () => {
        expect(hashQuery('hello')).toBe(hashQuery('hello'));
    });

    test('differs for different inputs', () => {
        expect(hashQuery('hello')).not.toBe(hashQuery('world'));
    });

    test('produces 8-char lowercase hex', () => {
        expect(hashQuery('hello')).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('tier0', () => {
    const a = ep('a1', 'alice in marseille');
    const b = ep('b2', 'bob in paris');

    test('miss on empty cache returns hit=false', () => {
        const s = seedState([a, b]);
        const r = tier0(s, 'alice');
        expect(r.hit).toBe(false);
        expect(r.entries).toEqual([]);
        expect(r.state).toBe(s);
    });

    test('hit after recordTier0 returns cached entries', () => {
        let s = seedState([a, b]);
        s = recordTier0(s, 'Alice', [a]);
        const r = tier0(s, 'alice');
        expect(r.hit).toBe(true);
        expect(r.entries).toHaveLength(1);
        expect(r.entries[0].id).toBe('a1');
    });

    test('hit is case- and trim-insensitive', () => {
        let s = seedState([a]);
        s = recordTier0(s, '  ALICE  ', [a]);
        expect(tier0(s, 'alice').hit).toBe(true);
        expect(tier0(s, 'Alice').hit).toBe(true);
        expect(tier0(s, 'ALICE ').hit).toBe(true);
    });

    test('cached ids whose entries are missing are silently skipped', () => {
        let s = seedState([a, b]);
        s = recordTier0(s, 'pair', [a, b]);
        delete s.entries['b2'];
        const r = tier0(s, 'pair');
        expect(r.hit).toBe(true);
        expect(r.entries.map(e => e.id)).toEqual(['a1']);
    });

    test('cache hit preserves entry order from recordTier0', () => {
        let s = seedState([a, b]);
        s = recordTier0(s, 'both', [b, a]);
        expect(tier0(s, 'both').entries.map(e => e.id)).toEqual(['b2', 'a1']);
    });
});

describe('recordTier0', () => {
    test('is pure (returns new state, does not mutate input)', () => {
        const s = seedState([ep('a1', 'alice')]);
        const before = structuredClone(s);
        const after = recordTier0(s, 'alice', [s.entries['a1']]);
        expect(s).toEqual(before);
        expect(after).not.toBe(s);
        expect(after.tierCaches.exact).not.toBe(s.tierCaches.exact);
    });
});

describe('invalidateTier0Cache', () => {
    test('clears all exact cache entries, returns new state', () => {
        let s = seedState([ep('a1', 'alice')]);
        s = recordTier0(s, 'q1', [s.entries['a1']]);
        s = recordTier0(s, 'q2', [s.entries['a1']]);
        const cleared = invalidateTier0Cache(s);
        expect(Object.keys(cleared.tierCaches.exact)).toHaveLength(0);
        expect(cleared).not.toBe(s);
        expect(cleared.entries).toEqual(s.entries);
        expect(cleared.tierCaches.fuzzy).toEqual(s.tierCaches.fuzzy);
    });

    test('no-op (new object) on already-empty cache', () => {
        const s = seedState([]);
        const cleared = invalidateTier0Cache(s);
        expect(cleared.tierCaches.exact).toEqual({});
    });
});
