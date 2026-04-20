/**
 * k-NN graph construction for Enhanced RAPTOR. Given a batch of leaves, embed
 * each (via the active embeddings client's temp collection), query the top-k
 * nearest neighbors per leaf, and build a symmetric weighted adjacency map.
 *
 * Symmetrization strategy: k-NN is inherently directed (A's top-k may not
 * include B even if B's top-k includes A). We take the MAX similarity across
 * both directions so the edge reflects the strongest evidence the two nodes
 * are related. This is the standard mutual-kNN alternative-lite — cheaper
 * than intersection, catches one-way strong matches.
 *
 * @module consolidation/raptor/knn
 * @see docs/wiki/raptor.md (Enhanced RAPTOR → Leiden on k-NN)
 */

import { PERSONA_REBUILD } from '../../core/constants.js';
import {
    createCollection, insertChunks, queryKNN, purgeCollection, hashText,
} from './embeddings.js';

const { K_BASE, K_STEP } = PERSONA_REBUILD;

/**
 * @typedef {import('./chunking.js').Leaf} Leaf
 */

/**
 * @typedef {object} KnnGraph
 * @property {string[]} nodes                                     - Ordered node ids.
 * @property {Map<string, Map<string, number>>} adjacency         - nodeId → (neighborId → weight ∈ (0, 1]).
 * @property {number} totalWeight                                 - Sum of all edge weights (used by Leiden modularity).
 */

/**
 * Compute adaptive k for depth d. Spec §6.4: k_base=15, k_step=5, so d=0 → 15,
 * d=1 → 20, d=2 → 25.
 *
 * @param {number} depth
 * @returns {number}
 */
export function kForDepth(depth) {
    if (typeof depth !== 'number' || depth < 0 || !Number.isInteger(depth)) {
        throw new Error('kForDepth: depth must be a non-negative integer');
    }
    return K_BASE + depth * K_STEP;
}

/**
 * Build a k-NN graph for a batch of leaves at the given depth.
 *
 * Algorithm:
 *   1. Create a temp collection, insert all leaves.
 *   2. For each leaf, queryKNN(collection, leaf.text, k+1) — the +1 accounts
 *      for the self-hit, which is filtered out.
 *   3. Symmetrize: for each directed edge (a→b, w), combine with (b→a, w')
 *      by taking max(w, w'). Also drop self-edges and zero-weight edges.
 *   4. Purge the collection.
 *
 * Edges with similarity ≤ 0 are dropped (anti-correlation carries no useful
 * signal for community detection on this corpus).
 *
 * @param {Leaf[]} leaves
 * @param {number} depth
 * @param {string} collectionId      - Caller-supplied temp id (usually `${chatId}:${subject}:persona-rebuild:${depth}`).
 * @param {AbortSignal} [signal]
 * @returns {Promise<KnnGraph>}
 */
export async function buildKnnGraph(leaves, depth, collectionId, signal) {
    if (!Array.isArray(leaves)) {
        throw new Error('buildKnnGraph: leaves must be an array');
    }
    if (typeof collectionId !== 'string' || collectionId.length === 0) {
        throw new Error('buildKnnGraph: collectionId required');
    }
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const err = new Error('buildKnnGraph: aborted');
            err.name = 'AbortError';
            throw err;
        }
    };

    const nodes = leaves.map(l => l.id);
    /** @type {Map<string, Map<string, number>>} */
    const adjacency = new Map();
    for (const id of nodes) adjacency.set(id, new Map());

    if (leaves.length < 2) {
        return { nodes, adjacency, totalWeight: 0 };
    }

    const k = kForDepth(depth);

    try {
        await createCollection(collectionId);
        throwIfAborted();
        await insertChunks(collectionId, leaves.map(l => ({
            hash: hashText(l.text),
            text: l.text,
            index: l.id,
        })));
        throwIfAborted();

        // For each leaf, query its top-(k+1) neighbors; drop the self-hit.
        for (const leaf of leaves) {
            throwIfAborted();
            const hits = await queryKNN(collectionId, leaf.text, k + 1);
            for (const h of hits) {
                if (h.leafId === leaf.id) continue;
                if (h.similarity <= 0) continue;
                const row = adjacency.get(leaf.id);
                if (!row) continue;
                const prev = row.get(h.leafId) ?? 0;
                if (h.similarity > prev) row.set(h.leafId, h.similarity);
            }
        }

        // Symmetrize: for each (a→b, w), ensure (b→a, max(w, w')) exists.
        let totalWeight = 0;
        const seen = new Set();
        for (const [a, row] of adjacency) {
            for (const [b, wAB] of row) {
                const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const wBA = adjacency.get(b)?.get(a) ?? 0;
                const w = Math.max(wAB, wBA);
                adjacency.get(a)?.set(b, w);
                adjacency.get(b)?.set(a, w);
                totalWeight += w;
            }
        }

        return { nodes, adjacency, totalWeight };
    } finally {
        // Always purge, even on error. Failures here are logged but not thrown —
        // purge failures leave a zombie collection but don't corrupt anything.
        try { await purgeCollection(collectionId); } catch { /* swallow */ }
    }
}

/**
 * Degree of a node (sum of edge weights). Used by Leiden modularity.
 *
 * @param {KnnGraph} graph
 * @param {string} nodeId
 * @returns {number}
 */
export function nodeDegree(graph, nodeId) {
    const row = graph.adjacency.get(nodeId);
    if (!row) return 0;
    let d = 0;
    for (const w of row.values()) d += w;
    return d;
}
