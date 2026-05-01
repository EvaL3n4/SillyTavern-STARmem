/**
 * Embedding client for persona rebuild. Injectable wrapper over SillyTavern's
 * Vectors extension (`/api/vector/insert`, `/api/vector/query`, `/api/vector/purge`).
 *
 * Design: ST Vectors does not expose raw embedding vectors — only similarity
 * scores from query. That's actually cleaner for our k-NN graph construction:
 * we insert all leaves into a temp collection, query each leaf's text against
 * the collection with topK = k+1 (one self-hit filtered out), and get weighted
 * edges directly from the returned similarity scores.
 *
 * Injection pattern mirrors Phase 6's llmClient. Production client uses
 * fetch; tests inject a synthetic deterministic client.
 *
 * @module consolidation/raptor/embeddings
 * @see public/scripts/extensions/vectors/index.js (ST's reference implementation)
 */

import { PERSONA_REBUILD } from '../../core/constants.js';

const { SYNTHETIC_EMBEDDING_DIM } = PERSONA_REBUILD;

/**
 * @typedef {object} InsertItem
 * @property {number} hash   - Numeric content hash (ST's collection key).
 * @property {string} text   - Text to embed.
 * @property {string} index  - Caller-supplied leaf id; returned on query.
 */

/**
 * @typedef {object} QueryHit
 * @property {string} leafId        - The caller-supplied leaf id (ST's "index" metadata).
 * @property {number} similarity    - Cosine similarity ∈ [0, 1] or provider-dependent score.
 */

/**
 * @typedef {object} EmbeddingClient
 * @property {(collectionId: string) => Promise<void>} createCollection
 * @property {(collectionId: string, items: InsertItem[]) => Promise<void>} insertChunks
 * @property {(collectionId: string, text: string, k: number) => Promise<QueryHit[]>} queryKNN
 * @property {(collectionId: string) => Promise<void>} purgeCollection
 */

/**
 * FNV-1a 32-bit hash. Same algorithm as Phase 4's tier0 cache. Not
 * cryptographic — just a stable numeric key for ST Vectors.
 * @param {string} s
 * @returns {number}
 */
export function hashText(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // Force unsigned 32-bit
    return h >>> 0;
}

/**
 * Build a deterministic synthetic embedding from text. Used by tests and as
 * a fallback when ST Vectors is unavailable (e.g. test harness). Uses a
 * cheap seeded PRNG (xorshift32) keyed on the FNV hash of the text.
 *
 * @param {string} text
 * @param {number} [dim=SYNTHETIC_EMBEDDING_DIM]
 * @returns {number[]}
 */
export function syntheticEmbedding(text, dim = SYNTHETIC_EMBEDDING_DIM) {
    let seed = hashText(text) || 0xdeadbeef;
    /** @type {number[]} */
    const v = new Array(dim);
    for (let i = 0; i < dim; i++) {
        // xorshift32
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        // Map uint32 → [-1, 1]
        v[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    // L2 normalize so dot product = cosine similarity.
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
}

/** @param {number[]} a @param {number[]} b @returns {number} */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        throw new Error('cosineSimilarity: dimension mismatch');
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    // Inputs should already be normalized; clamp for numerical safety.
    return Math.max(-1, Math.min(1, dot));
}

/**
 * Default production client. Uses fetch against ST's Vectors API. The source
 * (openai, webllm, extras, etc.) is whatever the user has configured in ST's
 * Vectors extension settings; we don't override it here.
 *
 * Throws if ST globals are unavailable (e.g. under jest).
 *
 * @returns {EmbeddingClient}
 */
function makeDefaultClient() {
    // Dynamic import: resolved lazily on first fetch so jest (which injects a
    // synthetic client via `_setEmbeddingClientForTests`) never tries to load
    // ST's script.js — that path doesn't resolve outside the browser.
    // From this file (src/consolidation/raptor/embeddings.js) it's 7 levels up
    // to reach `public/script.js`.
    /** @type {Promise<{ getRequestHeaders: () => Record<string, string> }> | null} */
    let stHeadersModule = null;
    const getHeaders = async () => {
        if (!stHeadersModule) {
            stHeadersModule = import('../../../../../../../script.js');
        }
        const { getRequestHeaders } = await stHeadersModule;
        return getRequestHeaders();
    };
    return {
        async createCollection(_collectionId) {
            // ST's Vectors API creates collections lazily on first insert.
            // No explicit creation call needed.
        },
        async insertChunks(collectionId, items) {
            const response = await fetch('/api/vector/insert', {
                method: 'POST',
                headers: await getHeaders(),
                body: JSON.stringify({ collectionId, items }),
            });
            if (!response.ok) {
                throw new Error(`embeddings.insertChunks: HTTP ${response.status}`);
            }
        },
        async queryKNN(collectionId, text, k) {
            const response = await fetch('/api/vector/query', {
                method: 'POST',
                headers: await getHeaders(),
                body: JSON.stringify({ collectionId, searchText: text, topK: k }),
            });
            if (!response.ok) {
                throw new Error(`embeddings.queryKNN: HTTP ${response.status}`);
            }
            const body = await response.json();
            /** @type {QueryHit[]} */
            const hits = [];
            const meta = Array.isArray(body?.metadata) ? body.metadata : [];
            for (const m of meta) {
                if (m && typeof m.index === 'string' && typeof m.score === 'number') {
                    hits.push({ leafId: m.index, similarity: m.score });
                }
            }
            return hits;
        },
        async purgeCollection(collectionId) {
            const response = await fetch('/api/vector/purge', {
                method: 'POST',
                headers: await getHeaders(),
                body: JSON.stringify({ collectionId }),
            });
            if (!response.ok) {
                throw new Error(`embeddings.purgeCollection: HTTP ${response.status}`);
            }
        },
    };
}

/** @type {EmbeddingClient} */
let client = makeDefaultClient();

/**
 * Public surface — forwards to the active client.
 *
 * @param {string} collectionId
 * @returns {Promise<void>}
 */
export function createCollection(collectionId) {
    return client.createCollection(collectionId);
}

/** @param {string} collectionId @param {InsertItem[]} items @returns {Promise<void>} */
export function insertChunks(collectionId, items) {
    if (typeof collectionId !== 'string' || collectionId.length === 0) {
        return Promise.reject(new Error('insertChunks: collectionId required'));
    }
    if (!Array.isArray(items)) {
        return Promise.reject(new Error('insertChunks: items must be an array'));
    }
    return client.insertChunks(collectionId, items);
}

/** @param {string} collectionId @param {string} text @param {number} k @returns {Promise<QueryHit[]>} */
export function queryKNN(collectionId, text, k) {
    if (typeof collectionId !== 'string' || collectionId.length === 0) {
        return Promise.reject(new Error('queryKNN: collectionId required'));
    }
    if (typeof text !== 'string') {
        return Promise.reject(new Error('queryKNN: text must be a string'));
    }
    if (typeof k !== 'number' || k <= 0) {
        return Promise.reject(new Error('queryKNN: k must be a positive number'));
    }
    return client.queryKNN(collectionId, text, k);
}

/** @param {string} collectionId @returns {Promise<void>} */
export function purgeCollection(collectionId) {
    return client.purgeCollection(collectionId);
}

/**
 * Build a synthetic in-memory embedding client for tests. Stores leaves in a
 * Map<collectionId, Map<text, InsertItem & {embedding: number[]}>>; queryKNN
 * computes cosine similarity against all stored leaves and returns top-k.
 *
 * @returns {EmbeddingClient}
 */
export function makeSyntheticClient() {
    /** @type {Map<string, Map<string, InsertItem & { embedding: number[] }>>} */
    const store = new Map();
    return {
        async createCollection(collectionId) {
            if (!store.has(collectionId)) store.set(collectionId, new Map());
        },
        async insertChunks(collectionId, items) {
            const bucket = store.get(collectionId) ?? new Map();
            for (const it of items) {
                bucket.set(it.index, { ...it, embedding: syntheticEmbedding(it.text) });
            }
            store.set(collectionId, bucket);
        },
        async queryKNN(collectionId, text, k) {
            const bucket = store.get(collectionId);
            if (!bucket) return [];
            const q = syntheticEmbedding(text);
            /** @type {QueryHit[]} */
            const hits = [];
            for (const it of bucket.values()) {
                hits.push({ leafId: it.index, similarity: cosineSimilarity(q, it.embedding) });
            }
            hits.sort((a, b) => b.similarity - a.similarity);
            return hits.slice(0, k);
        },
        async purgeCollection(collectionId) {
            store.delete(collectionId);
        },
    };
}

/**
 * Test-only: install a specific client (synthetic, mock, or custom).
 * @param {EmbeddingClient} c
 */
export function _setEmbeddingClientForTests(c) {
    if (!c || typeof c.createCollection !== 'function') {
        throw new Error('_setEmbeddingClientForTests: client missing createCollection');
    }
    client = c;
}

/** Test-only: restore the default fetch-backed client. */
export function _resetEmbeddingClientForTests() {
    client = makeDefaultClient();
}
