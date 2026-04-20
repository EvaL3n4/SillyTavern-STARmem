import { tier3 } from '../../../src/retrieval/tier3-graph.js';
import {
    _resetScorerForTests,
    registerScorer,
    setScorer,
} from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, content, overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, id, ...overrides };
}

function seed(entries, edges = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    s.graph.edges = edges;
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('tier3', () => {
    afterEach(() => _resetScorerForTests());

    test('empty seeds → empty result', () => {
        const s = seed([ep('a', 'Alice')]);
        expect(tier3(s, [], 'alice', 'factual', { now })).toEqual([]);
    });

    test('no edges → returns only seeds reranked', () => {
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Bob Paris'),
        ]);
        const result = tier3(s, [s.entries['a']], 'alice marseille', 'factual', { now });
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].entry.id).toBe('a');
    });

    test('expands 1 hop to neighbor via mentions edge', () => {
        const s = seed(
            [
                ep('a', 'Alice Marseille'),
                ep('b', 'Alice Paris'),
            ],
            [{ from: 'a', to: 'b', type: 'mentions', weight: 0.5 }],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const ids = result.map(r => r.entry.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
    });

    test('respects 2-hop max', () => {
        const s = seed(
            [
                ep('a', 'Alice went to the store'),
                ep('b', 'Bob met Alice'),
                ep('c', 'Carol saw Alice'),
                ep('d', 'Dan knows Alice'),
            ],
            [
                { from: 'a', to: 'b', type: 'mentions', weight: 0.9 },
                { from: 'b', to: 'c', type: 'mentions', weight: 0.9 },
                { from: 'c', to: 'd', type: 'mentions', weight: 0.9 },
            ],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const ids = result.map(r => r.entry.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
        expect(ids).toContain('c');
        expect(ids).not.toContain('d');
    });

    test('intent routing: temporal query prefers temporal_next edges', () => {
        const s = seed(
            [
                ep('a', 'event one'),
                ep('b', 'unrelated topic'),
                ep('c', 'event two'),
            ],
            [
                { from: 'a', to: 'b', type: 'mentions', weight: 0.5 },
                { from: 'a', to: 'c', type: 'temporal_next', weight: 0.5 },
            ],
        );
        const factual = tier3(s, [s.entries['a']], 'event', 'factual', { now });
        const temporal = tier3(s, [s.entries['a']], 'event', 'temporal', { now });
        const fIdx = (arr, id) => arr.findIndex(r => r.entry.id === id);
        const factualBvsC = fIdx(factual, 'b') - fIdx(factual, 'c');
        const temporalBvsC = fIdx(temporal, 'b') - fIdx(temporal, 'c');
        expect(temporalBvsC).toBeGreaterThanOrEqual(factualBvsC);
    });

    test('beam width caps expansion per hop', () => {
        const neighbors = Array.from({ length: 10 }, (_, i) => ep(`n${i}`, `Alice neighbor${i}`));
        const edges = neighbors.map(n => ({
            from: 'a', to: n.id, type: /** @type {'mentions'} */ ('mentions'), weight: 0.5,
        }));
        const s = seed([ep('a', 'Alice'), ...neighbors], edges);
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const nonSeed = result.filter(r => r.entry.id !== 'a');
        expect(nonSeed.length).toBeLessThanOrEqual(5);
    });

    test('excludes working-scope entries from expansion', () => {
        const w = ep('w1', 'Alice', { scope: 'working' });
        const s = seed(
            [ep('a', 'Alice'), w],
            [{ from: 'a', to: 'w1', type: 'mentions', weight: 0.5 }],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        expect(result.every(r => r.entry.id !== 'w1')).toBe(true);
    });

    test('deduplicates: reaching same node via multiple paths counted once', () => {
        const s = seed(
            [ep('a', 'Alice and friends'), ep('b', 'Bob knows Alice'), ep('c', 'Carol met Alice')],
            [
                { from: 'a', to: 'c', type: 'mentions', weight: 0.5 },
                { from: 'a', to: 'b', type: 'mentions', weight: 0.5 },
                { from: 'b', to: 'c', type: 'mentions', weight: 0.5 },
            ],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const cCount = result.filter(r => r.entry.id === 'c').length;
        expect(cCount).toBe(1);
    });

    test('respects k output cap', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ep(`e${i}`, `Alice ${i}`));
        const edges = entries.slice(1).map(e => ({
            from: 'e0', to: e.id, type: /** @type {'mentions'} */ ('mentions'), weight: 0.5,
        }));
        const s = seed(entries, edges);
        const result = tier3(s, [s.entries['e0']], 'alice', 'factual', { now, k: 3 });
        expect(result).toHaveLength(3);
    });

    test('filters zero-scored candidates', () => {
        registerScorer('zeroEverything', () => 0);
        setScorer('zeroEverything');
        const s = seed([ep('a', 'Alice'), ep('b', 'Bob')], [
            { from: 'a', to: 'b', type: 'mentions', weight: 0.5 },
        ]);
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        expect(result).toEqual([]);
    });

    test('returns ScoredEntry shape { entry, bm25, score }', () => {
        const s = seed([ep('a', 'Alice Marseille')]);
        const [r] = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        expect(r).toHaveProperty('entry');
        expect(r).toHaveProperty('bm25');
        expect(r).toHaveProperty('score');
        expect(typeof r.bm25).toBe('number');
        expect(typeof r.score).toBe('number');
    });
});
