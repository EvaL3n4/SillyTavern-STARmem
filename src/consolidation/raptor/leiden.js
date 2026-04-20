/**
 * Leiden community detection (Traag et al. 2019). Operates on KnnGraph
 * instances produced by raptor/knn.js. Public API lands in Task 4.5; this
 * file is built up across Tasks 4.1–4.5.
 *
 * @module consolidation/raptor/leiden
 * @see docs/wiki/raptor.md (Enhanced RAPTOR → Leiden on k-NN)
 * @see https://www.nature.com/articles/s41598-019-41695-z (Traag 2019)
 */

/**
 * @typedef {import('./knn.js').KnnGraph} KnnGraph
 */

/**
 * @typedef {object} Partition
 * @property {Map<string, number>} membership   - nodeId → community id (non-negative integer)
 * @property {number} communityCount             - Number of distinct communities
 */

/**
 * Build a fresh partition where each node is in its own community.
 *
 * @param {KnnGraph} graph
 * @returns {Partition}
 */
export function singletonPartition(graph) {
    /** @type {Map<string, number>} */
    const membership = new Map();
    let cid = 0;
    for (const id of graph.nodes) {
        membership.set(id, cid++);
    }
    return { membership, communityCount: graph.nodes.length };
}

/**
 * Renumber a partition's community ids to be a contiguous [0, K) range.
 * Useful after merges or aggregations that leave gaps.
 *
 * @param {Partition} partition
 * @returns {Partition}
 */
export function compactPartition(partition) {
    /** @type {Map<number, number>} */
    const renumber = new Map();
    let next = 0;
    /** @type {Map<string, number>} */
    const fresh = new Map();
    for (const [nodeId, oldCid] of partition.membership) {
        let newCid = renumber.get(oldCid);
        if (newCid === undefined) {
            newCid = next++;
            renumber.set(oldCid, newCid);
        }
        fresh.set(nodeId, newCid);
    }
    return { membership: fresh, communityCount: next };
}

/**
 * RB-configuration modularity. Higher is better; partition quality metric.
 *
 * Uses the per-community formulation:
 *   Q = Σ_c [ (Σ_in / 2m) - γ × (Σ_tot / 2m)² ]
 *
 * where 2m = 2 × graph.totalWeight (undirected edges stored once per pair,
 * modularity convention doubles them).
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @param {number} gamma         - Resolution parameter (spec §6.4 GAMMA_BASE, GAMMA_STEP)
 * @returns {number}
 */
export function modularity(graph, partition, gamma) {
    const twoM = 2 * graph.totalWeight;
    if (twoM === 0) return 0;

    /** @type {Map<number, { in: number, tot: number }>} */
    const stats = new Map();
    const addTot = (/** @type {number} */ c, /** @type {number} */ w) => {
        const s = stats.get(c) ?? { in: 0, tot: 0 };
        s.tot += w;
        stats.set(c, s);
    };
    const addIn = (/** @type {number} */ c, /** @type {number} */ w) => {
        const s = stats.get(c) ?? { in: 0, tot: 0 };
        s.in += w;
        stats.set(c, s);
    };

    // Σ_tot per community: sum of degrees of nodes in that community.
    for (const node of graph.nodes) {
        const c = partition.membership.get(node);
        if (c === undefined) continue;
        let deg = 0;
        for (const w of graph.adjacency.get(node)?.values() ?? []) deg += w;
        addTot(c, deg);
    }

    // Σ_in per community: sum of edge weights entirely inside that community.
    // Each undirected edge (a,b) with a < b is counted ONCE, but the formula's
    // "internal edges weighted ×2" convention is handled by the 2m denominator
    // matching. So we accumulate each edge once and the math works out.
    //
    // We iterate the adjacency once, guarding against double-counting by only
    // processing (a, b) when a < b lexicographically.
    for (const [a, row] of graph.adjacency) {
        for (const [b, w] of row) {
            if (a >= b) continue;
            const ca = partition.membership.get(a);
            const cb = partition.membership.get(b);
            if (ca !== undefined && cb !== undefined && ca === cb) {
                // Internal edge contributes 2w (both endpoints) to Σ_in.
                addIn(ca, 2 * w);
            }
        }
    }

    let q = 0;
    for (const { in: sIn, tot: sTot } of stats.values()) {
        q += (sIn / twoM) - gamma * Math.pow(sTot / twoM, 2);
    }
    return q;
}
