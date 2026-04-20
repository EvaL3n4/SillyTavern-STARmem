import {
    tier1,
    recordTier1,
    jaccard,
    tokenSetKey,
} from '../../../src/retrieval/tier1-fuzzy.js';
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

describe('jaccard', () => {
    test('identical sets → 1.0', () => {
        expect(jaccard(['a', 'b'], ['a', 'b'])).toBeCloseTo(1.0, 6);
    });

    test('disjoint sets → 0.0', () => {
        expect(jaccard(['a'], ['b'])).toBe(0);
    });

    test('half overlap → 1/3', () => {
        expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6);
    });

    test('empty sets → 0.0 (not NaN)', () => {
        expect(jaccard([], [])).toBe(0);
        expect(jaccard(['a'], [])).toBe(0);
    });

    test('duplicates in input treated as set members', () => {
        expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBeCloseTo(1.0, 6);
    });
});

describe('tokenSetKey', () => {
    test('deduplicates and sorts tokens', () => {
        expect(tokenSetKey('Alice and Bob and Alice')).toBe('alice and bob');
    });

    test('drops <2-char tokens (tokenizer contract)', () => {
        expect(tokenSetKey('a bc d ef')).toBe('bc ef');
    });

    test('empty/whitespace query → empty string', () => {
        expect(tokenSetKey('')).toBe('');
        expect(tokenSetKey('   ')).toBe('');
    });
});

describe('tier1', () => {
    const a = ep('a1', 'Alice lives in Marseille');
    const b = ep('b2', 'Bob works in Paris');

    test('miss when cache empty', () => {
        const s = seedState([a, b]);
        const r = tier1(s, 'Alice in Marseille');
        expect(r.hit).toBe(false);
    });

    test('hit on identical token set (Jaccard 1.0)', () => {
        let s = seedState([a]);
        s = recordTier1(s, 'alice marseille', [a]);
        const r = tier1(s, 'Alice Marseille');
        expect(r.hit).toBe(true);
    });

    test('hit at threshold boundary (Jaccard 0.6)', () => {
        // Cached: {alice, marseille, location} (3 tokens)
        // Query: {alice, marseille, location, in, of} (5 tokens — 'in' and 'of' survive, "the" has 3 chars so also survives; avoid)
        // Jaccard = 3/5 = 0.6 — exactly at threshold, >=0.6 should hit
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice marseille location', [a]);
        const r = tier1(s, 'location of alice in marseille');
        expect(r.hit).toBe(true);
        expect(r.entries[0].id).toBe('a1');
    });

    test('miss on token set below threshold', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice marseille', [a]);
        const r = tier1(s, 'bob paris');
        expect(r.hit).toBe(false);
    });

    test('picks the highest-Jaccard cache entry', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice paris', [b]);
        s = recordTier1(s, 'alice marseille', [a]);
        const r = tier1(s, 'alice marseille');
        expect(r.hit).toBe(true);
        expect(r.entries[0].id).toBe('a1');
    });

    test('empty-tokens query → miss', () => {
        let s = seedState([a]);
        s = recordTier1(s, '', [a]);
        const r = tier1(s, '');
        expect(r.hit).toBe(false);
    });

    test('missing entry ids in cache are silently skipped', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice bob', [a, b]);
        delete s.entries['b2'];
        const r = tier1(s, 'alice bob');
        expect(r.hit).toBe(true);
        expect(r.entries.map(e => e.id)).toEqual(['a1']);
    });
});

describe('recordTier1', () => {
    test('is pure', () => {
        const s = seedState([ep('a1', 'x')]);
        const before = structuredClone(s);
        const after = recordTier1(s, 'alice marseille', [s.entries['a1']]);
        expect(s).toEqual(before);
        expect(after.tierCaches.fuzzy).not.toBe(s.tierCaches.fuzzy);
    });

    test('empty-token query is not recorded (returns new state for consistency)', () => {
        const s = seedState([]);
        const after = recordTier1(s, '', []);
        expect(Object.keys(after.tierCaches.fuzzy)).toHaveLength(0);
    });
});
