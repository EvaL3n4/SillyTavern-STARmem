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

/**
 * Per-community aggregates maintained during local moving. Indexed by community id.
 *
 * @typedef {Map<number, { in: number, tot: number }>} CommunityStats
 */

/**
 * Build fresh community stats from a graph + partition. O(|V| + |E|).
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @returns {CommunityStats}
 */
export function buildCommunityStats(graph, partition) {
    /** @type {CommunityStats} */
    const stats = new Map();
    const get = (/** @type {number} */ c) => {
        let s = stats.get(c);
        if (!s) { s = { in: 0, tot: 0 }; stats.set(c, s); }
        return s;
    };
    for (const node of graph.nodes) {
        const c = partition.membership.get(node);
        if (c === undefined) continue;
        let deg = 0;
        for (const w of graph.adjacency.get(node)?.values() ?? []) deg += w;
        get(c).tot += deg;
    }
    for (const [a, row] of graph.adjacency) {
        for (const [b, w] of row) {
            if (a >= b) continue;
            const ca = partition.membership.get(a);
            const cb = partition.membership.get(b);
            if (ca !== undefined && cb !== undefined && ca === cb) {
                get(ca).in += 2 * w;
            }
        }
    }
    return stats;
}

/**
 * Sum of edge weights from `node` to any node in community `c`.
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @param {string} node
 * @param {number} c
 * @returns {number}
 */
function weightToCommunity(graph, partition, node, c) {
    let w = 0;
    for (const [n, ew] of graph.adjacency.get(node) ?? new Map()) {
        if (partition.membership.get(n) === c) w += ew;
    }
    return w;
}

/**
 * Degree of a single node.
 *
 * @param {KnnGraph} graph
 * @param {string} node
 * @returns {number}
 */
function degreeOf(graph, node) {
    let d = 0;
    for (const w of graph.adjacency.get(node)?.values() ?? []) d += w;
    return d;
}

/**
 * Deterministic Fisher-Yates shuffle driven by a seeded xorshift32 PRNG.
 * We don't need cryptographic randomness, but we DO need the order to vary
 * between iterations (pure iteration order would loop infinitely on some
 * ties). Tests use a fixed seed for determinism.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} seed
 * @returns {T[]}
 */
export function shuffled(arr, seed) {
    const out = arr.slice();
    let s = seed || 0xdeadbeef;
    for (let i = out.length - 1; i > 0; i--) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        const j = s % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Run the local-moving pass. Mutates `partition.membership` in place and
 * returns the number of moves performed in the final full pass (0 when
 * converged). The partition's `communityCount` is NOT adjusted for emptied
 * communities — call compactPartition after if you need contiguous ids.
 *
 * Loop: pick a random-ordered node, find the best neighbor community, move
 * if modularity improves. Repeat until a full pass yields 0 moves.
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @param {number} gamma
 * @param {number} [seed=1]  - PRNG seed for node-order randomization (deterministic tests)
 * @returns {number}          - Total moves across all passes
 */
export function localMove(graph, partition, gamma, seed = 1) {
    const stats = buildCommunityStats(graph, partition);
    const twoM = 2 * graph.totalWeight;
    if (twoM === 0) return 0;

    let totalMoves = 0;
    let currentSeed = seed;
    let passMoves = -1;
    // Safety cap — a well-behaved graph converges in O(log n) passes, but
    // pathological weights can oscillate. Cap at 64.
    let passLimit = 64;
    while (passMoves !== 0 && passLimit-- > 0) {
        passMoves = 0;
        currentSeed = (currentSeed * 1664525 + 1013904223) >>> 0;
        const order = shuffled(graph.nodes, currentSeed);

        for (const node of order) {
            const currentC = partition.membership.get(node);
            if (currentC === undefined) continue;
            const deg = degreeOf(graph, node);

            // Enumerate candidate communities: the node's own + every neighbor's.
            /** @type {Set<number>} */
            const candidates = new Set([currentC]);
            for (const n of graph.adjacency.get(node)?.keys() ?? []) {
                const c = partition.membership.get(n);
                if (c !== undefined) candidates.add(c);
            }

            // Compute the "leave current" delta ONCE.
            const wToSelf = weightToCommunity(graph, partition, node, currentC);
            const totSelf = (stats.get(currentC)?.tot ?? 0) - deg;
            // Leaving cost: -[wToSelf/m - γ × deg × totSelf / (2m²)] × 2
            // (factor 2 because the node contributed 2 × wToSelf to Σ_in and
            //  deg to Σ_tot; we reverse both terms)
            const leaveTerm = (wToSelf / graph.totalWeight)
                - gamma * deg * totSelf / (twoM * graph.totalWeight);

            let bestC = currentC;
            let bestGain = 0;

            for (const c of candidates) {
                if (c === currentC) continue;
                const wToC = weightToCommunity(graph, partition, node, c);
                const totC = stats.get(c)?.tot ?? 0;
                const joinTerm = (wToC / graph.totalWeight)
                    - gamma * deg * totC / (twoM * graph.totalWeight);
                const gain = joinTerm - leaveTerm;
                if (gain > bestGain) {
                    bestGain = gain;
                    bestC = c;
                }
            }

            // Leiden's local-moving phase accepts only positive gains; 0-gain
            // moves would cause oscillation on symmetric graphs.
            if (bestC !== currentC && bestGain > 1e-10) {
                // Apply the move: update stats incrementally.
                const oldStats = stats.get(currentC);
                const newStats = stats.get(bestC) ?? { in: 0, tot: 0 };
                if (oldStats) {
                    oldStats.tot -= deg;
                    oldStats.in -= 2 * wToSelf;
                    if (oldStats.tot <= 0 && oldStats.in <= 0) stats.delete(currentC);
                }
                newStats.tot += deg;
                newStats.in += 2 * weightToCommunity(graph, partition, node, bestC);
                stats.set(bestC, newStats);
                partition.membership.set(node, bestC);
                passMoves++;
                totalMoves++;
            }
        }
    }
    return totalMoves;
}

