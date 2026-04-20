import { buildEdges, extractEntities } from '../../../src/memory/edgeBuilder.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import { RETRIEVAL } from '../../../src/core/constants.js';

const { EDGE_CAP_PER_ENTRY, EXPLICIT_RELATION_WEIGHT, COOCCURRENCE_WEIGHT } = RETRIEVAL;

/**
 * @param {string} id
 * @param {string} content
 * @param {import('../../../src/core/schema.js').Relation[]} relations
 * @param {import('../../../src/core/schema.js').Scope} scope
 */
function ep(id, content, relations = [], scope = /** @type {import('../../../src/core/schema.js').Scope} */ ('episodic')) {
    const e = createEntry({
        scope, content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id, relations };
}

function seedStateWithEdges(edges = []) {
    const s = createEmptyState();
    s.graph.edges = edges;
    return s;
}

describe('extractEntities', () => {
    test('matches capitalized words with ≥3 lowercase chars', () => {
        expect(extractEntities('Alice met Bob in Marseille')).toEqual(
            expect.arrayContaining(['Alice', 'Bob', 'Marseille']),
        );
    });

    test('skips sentence-start "The", "A", "I"', () => {
        const ents = extractEntities('The quick brown fox. A lazy dog. I saw it.');
        expect(ents).not.toContain('The');
        expect(ents).not.toContain('A');
        expect(ents).not.toContain('I');
    });

    test('deduplicates', () => {
        expect(extractEntities('Alice and Alice')).toEqual(['Alice']);
    });

    test('empty / non-string input', () => {
        expect(extractEntities('')).toEqual([]);
        expect(extractEntities(/** @type {any} */ (null))).toEqual([]);
    });

    test('case-sensitive (does not fold "alice" into "Alice")', () => {
        expect(extractEntities('alice met Alice')).toEqual(['Alice']);
    });
});

describe('buildEdges — explicit relations', () => {
    test('emits edges for each @relations entry, weight=EXPLICIT_RELATION_WEIGHT', () => {
        const a = ep('a1', 'plain content', [
            { type: 'supports', target: 'b2' },
            { type: 'same_topic', target: 'c3' },
        ]);
        const { newEdges, evicted } = buildEdges(a, [a], createEmptyState());
        expect(newEdges).toEqual(expect.arrayContaining([
            { from: 'a1', to: 'b2', type: 'supports', weight: EXPLICIT_RELATION_WEIGHT },
            { from: 'a1', to: 'c3', type: 'same_topic', weight: EXPLICIT_RELATION_WEIGHT },
        ]));
        expect(evicted).toEqual([]);
    });

    test('empty relations → no explicit edges', () => {
        const a = ep('a1', 'plain content', []);
        const { newEdges } = buildEdges(a, [a], createEmptyState());
        const explicit = newEdges.filter(e => e.weight === EXPLICIT_RELATION_WEIGHT);
        expect(explicit).toEqual([]);
    });
});

describe('buildEdges — co-occurrence', () => {
    test('emits mentions edge when two entries share an entity', () => {
        const a = ep('a1', 'Alice lives in Marseille');
        const b = ep('b2', 'Alice moved to Paris');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        const coocc = newEdges.filter(e => e.weight === COOCCURRENCE_WEIGHT);
        expect(coocc).toContainEqual({
            from: 'a1', to: 'b2', type: 'mentions', weight: COOCCURRENCE_WEIGHT,
        });
    });

    test('no edge when entities disjoint', () => {
        const a = ep('a1', 'Alice in Marseille');
        const b = ep('b2', 'Bob in Tokyo');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        expect(newEdges.every(e => e.to !== 'b2')).toBe(true);
    });

    test('does not emit self-edge', () => {
        const a = ep('a1', 'Alice and Alice');
        const { newEdges } = buildEdges(a, [a], createEmptyState());
        expect(newEdges.every(e => e.to !== 'a1')).toBe(true);
    });

    test('skips working-scope entries', () => {
        const a = ep('a1', 'Alice in Marseille');
        const w = ep('w1', 'Alice is here', [], 'working');
        const { newEdges } = buildEdges(a, [a, w], createEmptyState());
        expect(newEdges.every(e => e.to !== 'w1')).toBe(true);
    });
});

describe('buildEdges — merge and precedence', () => {
    test('explicit relation wins over co-occurrence for same (from, to, type)', () => {
        const a = ep('a1', 'Alice lives here', [{ type: 'mentions', target: 'b2' }]);
        const b = ep('b2', 'Alice visits');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        const aliceToB = newEdges.filter(e => e.from === 'a1' && e.to === 'b2' && e.type === 'mentions');
        expect(aliceToB).toHaveLength(1);
        expect(aliceToB[0].weight).toBe(EXPLICIT_RELATION_WEIGHT);
    });

    test('keeps different types between same nodes distinct', () => {
        const a = ep('a1', 'Alice meets Bob', [{ type: 'supports', target: 'b2' }]);
        const b = ep('b2', 'Alice was there');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        const types = newEdges.filter(e => e.from === 'a1' && e.to === 'b2').map(e => e.type).sort();
        expect(types).toEqual(['mentions', 'supports']);
    });
});

describe('buildEdges — cap enforcement', () => {
    test('under-cap: no eviction', () => {
        const a = ep('a1', 'Alice');
        const seeded = seedStateWithEdges(
            Array.from({ length: 5 }, (_, i) => ({
                from: 'a1', to: `x${i}`, type: 'mentions', weight: 0.5,
            })),
        );
        const b = ep('b2', 'Alice visits');
        const { newEdges, evicted } = buildEdges(a, [a, b], seeded);
        expect(evicted).toEqual([]);
        expect(newEdges.length).toBe(1);
    });

    test('over-cap: evicts lowest-weight existing edges', () => {
        const a = ep('a1', 'Alice', [{ type: 'supports', target: 'b2' }]);
        const seeded = seedStateWithEdges(
            Array.from({ length: EDGE_CAP_PER_ENTRY }, (_, i) => ({
                from: 'a1', to: `old${i}`, type: 'mentions', weight: 0.1,
            })),
        );
        const b = ep('b2', 'plain');
        const { newEdges, evicted } = buildEdges(a, [a, b], seeded);
        expect(newEdges.length).toBeGreaterThan(0);
        expect(evicted.length).toBeGreaterThan(0);
        const remainingExisting = EDGE_CAP_PER_ENTRY - evicted.length;
        expect(remainingExisting + newEdges.length).toBeLessThanOrEqual(EDGE_CAP_PER_ENTRY);
    });

    test('prefers higher-weight edges when evicting', () => {
        const a = ep('a1', 'Alice', [{ type: 'supports', target: 'new' }]);
        const seeded = seedStateWithEdges([
            { from: 'a1', to: 'hi', type: 'mentions', weight: 0.9 },
            ...Array.from({ length: EDGE_CAP_PER_ENTRY - 1 }, (_, i) => ({
                from: 'a1', to: `lo${i}`, type: 'mentions', weight: 0.1,
            })),
        ]);
        const { evicted } = buildEdges(a, [a], seeded);
        expect(evicted.every(e => e.to !== 'hi')).toBe(true);
    });
});

describe('buildEdges — purity', () => {
    test('does not mutate state, entry, or allEntries', () => {
        const a = ep('a1', 'Alice', [{ type: 'mentions', target: 'b2' }]);
        const b = ep('b2', 'Alice');
        const all = [a, b];
        const state = seedStateWithEdges([{ from: 'a1', to: 'c3', type: 'mentions', weight: 0.5 }]);
        const entryBefore = structuredClone(a);
        const allBefore = structuredClone(all);
        const stateBefore = structuredClone(state);
        buildEdges(a, all, state);
        expect(a).toEqual(entryBefore);
        expect(all).toEqual(allBefore);
        expect(state).toEqual(stateBefore);
    });
});
