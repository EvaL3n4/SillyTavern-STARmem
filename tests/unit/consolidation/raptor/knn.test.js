import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    buildKnnGraph, kForDepth, nodeDegree,
} from '../../../../src/consolidation/raptor/knn.js';
import {
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests, makeSyntheticClient,
} from '../../../../src/consolidation/raptor/embeddings.js';
import { chunkEntries } from '../../../../src/consolidation/raptor/chunking.js';
import { createEntry } from '../../../../src/memory/entry.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

beforeEach(() => {
    _setEmbeddingClientForTests(makeSyntheticClient());
});
afterEach(() => _resetEmbeddingClientForTests());

/** @param {string} content @returns {import('../../../../src/core/schema.js').Entry} */
function ep(content) {
    return createEntry({
        scope: 'episodic', content, subject: 'alice', tags: [], relations: [],
        provenance: { sourceMessages: [], extractor: 'test' }, now: FIXED_NOW,
    });
}

describe('kForDepth', () => {
    test('depth 0 → K_BASE (15)', () => {
        expect(kForDepth(0)).toBe(15);
    });
    test('depth 1 → 20', () => {
        expect(kForDepth(1)).toBe(20);
    });
    test('depth 2 → 25', () => {
        expect(kForDepth(2)).toBe(25);
    });
    test('rejects negative depth', () => {
        expect(() => kForDepth(-1)).toThrow(/non-negative/);
    });
    test('rejects non-integer depth', () => {
        expect(() => kForDepth(1.5)).toThrow(/integer/);
    });
});

describe('buildKnnGraph', () => {
    test('fewer than 2 leaves → empty adjacency', async () => {
        const leaves = chunkEntries([ep('only one fact')]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        expect(g.nodes).toHaveLength(1);
        expect(g.totalWeight).toBe(0);
        expect(g.adjacency.get(leaves[0].id)?.size).toBe(0);
    });

    test('3 leaves → symmetric adjacency (a↔b, b↔c, a↔c)', async () => {
        const leaves = chunkEntries([
            ep('alice traveled to marseille'),
            ep('alice likes croissants'),
            ep('the sky is blue today'),
        ]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        expect(g.nodes).toHaveLength(3);

        // Symmetry check
        for (const a of g.nodes) {
            for (const [b, w] of g.adjacency.get(a) ?? new Map()) {
                expect(g.adjacency.get(b)?.get(a)).toBeCloseTo(w, 6);
            }
        }
        // Total weight is positive (at least some pairs have non-zero similarity)
        expect(g.totalWeight).toBeGreaterThan(0);
    });

    test('drops self-edges', async () => {
        const leaves = chunkEntries([
            ep('alice traveled to marseille'),
            ep('alice likes croissants'),
        ]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        for (const id of g.nodes) {
            expect(g.adjacency.get(id)?.has(id)).toBe(false);
        }
    });

    test('drops edges with similarity ≤ 0', async () => {
        // Synthetic client can produce negative cosine values; confirm none survive.
        const leaves = chunkEntries([
            ep('alice'), ep('bob'), ep('carol'),
            ep('apple'), ep('banana'), ep('cherry'),
        ]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        for (const [, row] of g.adjacency) {
            for (const w of row.values()) {
                expect(w).toBeGreaterThan(0);
            }
        }
    });

    test('respects AbortSignal pre-flight', async () => {
        const leaves = chunkEntries([ep('a'), ep('b'), ep('c')]);
        const controller = new AbortController();
        controller.abort();
        await expect(buildKnnGraph(leaves, 0, 'c', controller.signal))
            .rejects.toThrow(/aborted/);
    });

    test('purges collection after success', async () => {
        const leaves = chunkEntries([ep('a'), ep('b'), ep('c')]);
        await buildKnnGraph(leaves, 0, 'c-purge-success');
        // After purge, the collection is empty; a fresh query returns nothing.
        const { queryKNN } = await import('../../../../src/consolidation/raptor/embeddings.js');
        const hits = await queryKNN('c-purge-success', 'a', 5);
        expect(hits).toEqual([]);
    });

    test('throws on bad arguments', async () => {
        await expect(buildKnnGraph(/** @type {any} */ ('not-array'), 0, 'c'))
            .rejects.toThrow(/array/);
        await expect(buildKnnGraph([], 0, ''))
            .rejects.toThrow(/collectionId/);
    });
});

describe('nodeDegree', () => {
    test('returns 0 for unknown node', () => {
        /** @type {import('../../../../src/consolidation/raptor/knn.js').KnnGraph} */
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        expect(nodeDegree(g, 'unknown')).toBe(0);
    });

    test('sums edge weights for a node', async () => {
        const leaves = chunkEntries([ep('a'), ep('b'), ep('c')]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        for (const id of g.nodes) {
            let expected = 0;
            for (const w of g.adjacency.get(id)?.values() ?? []) expected += w;
            expect(nodeDegree(g, id)).toBeCloseTo(expected, 6);
        }
    });
});
