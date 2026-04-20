import { describe, test, expect, afterEach } from '@jest/globals';
import {
    hashText, syntheticEmbedding, cosineSimilarity, makeSyntheticClient,
    createCollection, insertChunks, queryKNN, purgeCollection,
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests,
} from '../../../../src/consolidation/raptor/embeddings.js';

afterEach(() => _resetEmbeddingClientForTests());

describe('hashText', () => {
    test('deterministic for same input', () => {
        expect(hashText('alice')).toBe(hashText('alice'));
    });
    test('different inputs → different hashes (sanity)', () => {
        expect(hashText('alice')).not.toBe(hashText('bob'));
    });
    test('empty string produces a defined number', () => {
        expect(typeof hashText('')).toBe('number');
    });
});

describe('syntheticEmbedding', () => {
    test('deterministic for same text', () => {
        expect(syntheticEmbedding('alice')).toEqual(syntheticEmbedding('alice'));
    });
    test('returns an array of the configured dimension', () => {
        const v = syntheticEmbedding('alice');
        expect(Array.isArray(v)).toBe(true);
        expect(v).toHaveLength(16);
    });
    test('returns an L2-normalized vector', () => {
        const v = syntheticEmbedding('alice traveled to marseille');
        let norm = 0;
        for (const x of v) norm += x * x;
        expect(Math.sqrt(norm)).toBeCloseTo(1.0, 6);
    });
    test('different texts yield different vectors', () => {
        const a = syntheticEmbedding('alice');
        const b = syntheticEmbedding('bob');
        expect(a).not.toEqual(b);
    });
});

describe('cosineSimilarity', () => {
    test('identical vectors → 1', () => {
        const v = syntheticEmbedding('alice');
        expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
    });
    test('different vectors → < 1', () => {
        const a = syntheticEmbedding('alice');
        const b = syntheticEmbedding('completely different content here');
        expect(cosineSimilarity(a, b)).toBeLessThan(1);
    });
    test('throws on dimension mismatch', () => {
        expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension/);
    });
    test('clamps to [-1, 1]', () => {
        // Tiny numerical drift shouldn't escape the range even with identical inputs
        const v = syntheticEmbedding('test');
        const s = cosineSimilarity(v, v);
        expect(s).toBeLessThanOrEqual(1);
        expect(s).toBeGreaterThanOrEqual(-1);
    });
});

describe('public surface (argument guards)', () => {
    test('insertChunks rejects empty collectionId', async () => {
        await expect(insertChunks('', [])).rejects.toThrow(/collectionId/);
    });
    test('queryKNN rejects empty collectionId', async () => {
        await expect(queryKNN('', 'x', 3)).rejects.toThrow(/collectionId/);
    });
    test('queryKNN rejects non-positive k', async () => {
        await expect(queryKNN('c', 'x', 0)).rejects.toThrow(/k/);
    });
});

describe('default client under jest (no ST fetch)', () => {
    // The default client calls `fetch`. jest's environment has no /api/ server,
    // so fetch rejects. We verify the guard surfaces clearly.
    test('insertChunks surfaces a network error (no ST server in jest)', async () => {
        await expect(insertChunks('c', [{ hash: 1, text: 'x', index: 'leaf1' }]))
            .rejects.toThrow();
    });
});

describe('synthetic client round trip', () => {
    test('insert + query returns inserted items ranked by similarity', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        await createCollection('c1');
        await insertChunks('c1', [
            { hash: hashText('alice traveled to marseille'), text: 'alice traveled to marseille', index: 'leaf_a' },
            { hash: hashText('bob went to paris'), text: 'bob went to paris', index: 'leaf_b' },
            { hash: hashText('alice likes croissants'), text: 'alice likes croissants', index: 'leaf_c' },
        ]);
        const hits = await queryKNN('c1', 'alice traveled to marseille', 3);
        expect(hits).toHaveLength(3);
        // Self-hit should be first with similarity ≈ 1
        expect(hits[0].leafId).toBe('leaf_a');
        expect(hits[0].similarity).toBeCloseTo(1, 6);
        // All similarities are in [-1, 1]
        for (const h of hits) {
            expect(h.similarity).toBeLessThanOrEqual(1);
            expect(h.similarity).toBeGreaterThanOrEqual(-1);
        }
    });

    test('queryKNN with k=2 returns only 2 hits even when more exist', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        await createCollection('c');
        await insertChunks('c', [
            { hash: 1, text: 'a', index: 'l1' },
            { hash: 2, text: 'b', index: 'l2' },
            { hash: 3, text: 'c', index: 'l3' },
            { hash: 4, text: 'd', index: 'l4' },
        ]);
        const hits = await queryKNN('c', 'a', 2);
        expect(hits).toHaveLength(2);
    });

    test('purgeCollection drops the collection', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        await createCollection('c');
        await insertChunks('c', [{ hash: 1, text: 'a', index: 'l1' }]);
        await purgeCollection('c');
        const hits = await queryKNN('c', 'a', 5);
        expect(hits).toEqual([]);
    });

    test('querying an unknown collection returns empty list', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        const hits = await queryKNN('nonexistent', 'x', 5);
        expect(hits).toEqual([]);
    });
});
