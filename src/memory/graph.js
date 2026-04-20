/**
 * Graph store. Pure edge operations over `state.graph.edges` plus a
 * per-call adjacency builder for Tier 3's beam search. Edges are
 * directional; dedup key is (from, to, type).
 *
 * Persisted shape lives in state.graph.edges per spec §3.2. Adjacency is
 * NOT persisted — rebuilt at Tier 3 entry, same pattern as the BM25 index.
 *
 * @module memory/graph
 * @see docs/specs/2026-04-20-starmem-v2-design.md §4
 */

/**
 * Add or update an edge. Dedupes on (from, to, type): if an edge with
 * identical keys exists, its weight is replaced by the new edge's weight.
 * Reverse-direction and different-type edges stay distinct.
 *
 * @param {import('../core/schema.js').State} state
 * @param {import('../core/schema.js').Edge} edge
 * @returns {import('../core/schema.js').State}
 */
export function addEdge(state, edge) {
    const existing = state.graph.edges;
    const nextEdges = [];
    let replaced = false;
    for (const e of existing) {
        if (e.from === edge.from && e.to === edge.to && e.type === edge.type) {
            nextEdges.push({ ...edge });
            replaced = true;
        } else {
            nextEdges.push(e);
        }
    }
    if (!replaced) nextEdges.push({ ...edge });
    return {
        ...state,
        graph: { ...state.graph, edges: nextEdges },
    };
}

/**
 * Remove an edge matching (from, to, type). No-op on miss; still returns a
 * new state object for API consistency.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} from
 * @param {string} to
 * @param {import('../core/schema.js').EdgeType} type
 * @returns {import('../core/schema.js').State}
 */
export function removeEdge(state, from, to, type) {
    return {
        ...state,
        graph: {
            ...state.graph,
            edges: state.graph.edges.filter(
                e => !(e.from === from && e.to === to && e.type === type),
            ),
        },
    };
}

/**
 * Convenience reader. Returns a fresh array so callers can mutate freely.
 *
 * @param {import('../core/schema.js').State} state
 * @returns {import('../core/schema.js').Edge[]}
 */
export function listEdges(state) {
    return [...state.graph.edges];
}

/**
 * Build a per-call adjacency index. O(|edges|). Called once at the top of
 * Tier 3; NOT persisted.
 *
 * @param {import('../core/schema.js').State} state
 * @returns {Map<string, import('../core/schema.js').Edge[]>}
 */
export function buildAdjacency(state) {
    /** @type {Map<string, import('../core/schema.js').Edge[]>} */
    const adj = new Map();
    for (const e of state.graph.edges) {
        const bucket = adj.get(e.from);
        if (bucket) {
            bucket.push(e);
        } else {
            adj.set(e.from, [e]);
        }
    }
    return adj;
}

/**
 * Look up neighbors of an entry id in a prebuilt adjacency. Returns the
 * stored array unchanged (Tier 3 treats it as read-only).
 *
 * @param {Map<string, import('../core/schema.js').Edge[]>} adjacency
 * @param {string} entryId
 * @returns {import('../core/schema.js').Edge[]}
 */
export function neighborsOf(adjacency, entryId) {
    return adjacency.get(entryId) ?? [];
}
