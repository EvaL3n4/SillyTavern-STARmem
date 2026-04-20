import { describe, test, expect } from '@jest/globals';
import {
    singletonPartition, compactPartition, modularity,
} from '../../../../src/consolidation/raptor/leiden.js';

/**
 * Build a graph fixture from a compact edge list: [['a','b',0.5], ...].
 * Edges are symmetric (both directions set). Nodes are inferred.
 *
 * @param {[string, string, number][]} edges
 */
function buildGraph(edges) {
    /** @type {Set<string>} */
    const nodeSet = new Set();
    /** @type {Map<string, Map<string, number>>} */
    const adj = new Map();
    let totalWeight = 0;
    for (const [a, b, w] of edges) {
        nodeSet.add(a); nodeSet.add(b);
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.has(b)) adj.set(b, new Map());
        adj.get(a)?.set(b, w);
        adj.get(b)?.set(a, w);
        totalWeight += w;
    }
    // Ensure nodes with no edges still exist as empty rows.
    for (const n of nodeSet) {
        if (!adj.has(n)) adj.set(n, new Map());
    }
    return { nodes: [...nodeSet], adjacency: adj, totalWeight };
}

/** @param {Record<string, number>} pairs */
function partitionFrom(pairs) {
    const membership = new Map(Object.entries(pairs));
    const communityCount = new Set(Object.values(pairs)).size;
    return { membership, communityCount };
}

describe('singletonPartition', () => {
    test('each node in its own community', () => {
        const g = buildGraph([['a', 'b', 0.5], ['b', 'c', 0.5]]);
        const p = singletonPartition(g);
        expect(p.communityCount).toBe(3);
        expect(new Set(p.membership.values()).size).toBe(3);
    });
});

describe('compactPartition', () => {
    test('renumbers to contiguous [0, K)', () => {
        const p = partitionFrom({ a: 5, b: 5, c: 42, d: 100 });
        const c = compactPartition(p);
        expect(c.communityCount).toBe(3);
        const ids = new Set(c.membership.values());
        expect(ids).toEqual(new Set([0, 1, 2]));
        expect(c.membership.get('a')).toBe(c.membership.get('b'));
        expect(c.membership.get('c')).not.toBe(c.membership.get('a'));
    });
});

describe('modularity — empty / trivial', () => {
    test('empty graph → 0', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        expect(modularity(g, { membership: new Map(), communityCount: 0 }, 1.0)).toBe(0);
    });

    test('single-edge graph, both nodes same community', () => {
        // Graph: a—b with weight 1. 2m = 2. k_a = k_b = 1.
        // Σ_in = 2 (the edge counted twice). Σ_tot = 2.
        // Q = 2/2 - γ × (2/2)² = 1 - γ. For γ=1.0 → 0. For γ=0.5 → 0.5.
        const g = buildGraph([['a', 'b', 1]]);
        expect(modularity(g, partitionFrom({ a: 0, b: 0 }), 1.0)).toBeCloseTo(0, 6);
        expect(modularity(g, partitionFrom({ a: 0, b: 0 }), 0.5)).toBeCloseTo(0.5, 6);
    });

    test('single-edge graph, nodes in separate communities', () => {
        // Σ_in = 0. Σ_tot_a = 1, Σ_tot_b = 1. 2m = 2.
        // Q = - γ × [(1/2)² + (1/2)²] = -γ/2.
        const g = buildGraph([['a', 'b', 1]]);
        expect(modularity(g, partitionFrom({ a: 0, b: 1 }), 1.0)).toBeCloseTo(-0.5, 6);
    });
});

describe('modularity — golden values', () => {
    test('two-triangle graph, optimal partition', () => {
        // Graph: triangle {a,b,c} fully connected at w=1, triangle {d,e,f}
        // fully connected at w=1, plus a single bridge a—d at w=0.1.
        // Intuition: {a,b,c} | {d,e,f} should score near the modularity max.
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        // Hand calc:
        //   totalWeight = 3 + 3 + 0.1 = 6.1 → 2m = 12.2
        //   Community {a,b,c}:
        //     Σ_in = 2*(1+1+1) = 6 (three internal edges, each doubled)
        //     k_a = 1+1+0.1 = 2.1, k_b = 1+1 = 2, k_c = 1+1 = 2 → Σ_tot = 6.1
        //   Community {d,e,f}:
        //     Σ_in = 6
        //     k_d = 1+1+0.1 = 2.1, k_e = 1+1 = 2, k_f = 1+1 = 2 → Σ_tot = 6.1
        //   Q = 2 × [6/12.2 - γ × (6.1/12.2)²]
        //     = 2 × [0.491803... - γ × 0.25]
        //     at γ=1.0:  2 × (0.491803 - 0.25) = 0.483606
        const q = modularity(g, partitionFrom({
            a: 0, b: 0, c: 0, d: 1, e: 1, f: 1,
        }), 1.0);
        expect(q).toBeCloseTo(0.483606, 4);
    });

    test('two-triangle graph, all-in-one-community is worse than optimal', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const all = partitionFrom({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
        const split = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        expect(modularity(g, split, 1.0)).toBeGreaterThan(modularity(g, all, 1.0));
    });

    test('two-triangle graph, singletons are worse than optimal', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const singletons = partitionFrom({ a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 });
        const split = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        expect(modularity(g, split, 1.0)).toBeGreaterThan(modularity(g, singletons, 1.0));
    });

    test('higher gamma penalizes large communities more', () => {
        // On a disconnected graph, γ doesn't matter much; on a connected graph
        // with a "mergable" cut, higher γ pushes toward more, smaller clusters.
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.5],  // medium bridge
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const split = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const merged = partitionFrom({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
        // At low γ the merged partition competes with split; at high γ split dominates.
        const diffLow = modularity(g, split, 0.3) - modularity(g, merged, 0.3);
        const diffHigh = modularity(g, split, 1.2) - modularity(g, merged, 1.2);
        expect(diffHigh).toBeGreaterThan(diffLow);
    });
});

import { buildCommunityStats, localMove, shuffled } from '../../../../src/consolidation/raptor/leiden.js';

describe('shuffled', () => {
    test('deterministic for same seed', () => {
        const a = shuffled(['a', 'b', 'c', 'd', 'e'], 42);
        const b = shuffled(['a', 'b', 'c', 'd', 'e'], 42);
        expect(a).toEqual(b);
    });
    test('different seeds yield different orders (probabilistic)', () => {
        const a = shuffled(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1);
        const b = shuffled(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 2);
        expect(a).not.toEqual(b);
    });
    test('preserves set of elements', () => {
        const a = shuffled(['a', 'b', 'c'], 7);
        expect(new Set(a)).toEqual(new Set(['a', 'b', 'c']));
    });
});

describe('buildCommunityStats', () => {
    test('empty graph → empty stats', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const s = buildCommunityStats(g, { membership: new Map(), communityCount: 0 });
        expect(s.size).toBe(0);
    });

    test('two-triangle graph stats', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const s = buildCommunityStats(g, part);
        // Community 0: {a, b, c}, 3 internal edges × 2 = 6 internal; degrees 2.1, 2, 2 → 6.1 tot
        expect(s.get(0)?.in).toBeCloseTo(6, 6);
        expect(s.get(0)?.tot).toBeCloseTo(6.1, 6);
        expect(s.get(1)?.in).toBeCloseTo(6, 6);
        expect(s.get(1)?.tot).toBeCloseTo(6.1, 6);
    });
});

describe('localMove', () => {
    test('converges to the obvious two-cluster partition on two-triangle graph', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = singletonPartition(g);
        const moves = localMove(g, part, 1.0, 42);
        expect(moves).toBeGreaterThan(0);

        // Post-move: a, b, c share a community; d, e, f share a different community.
        const ca = part.membership.get('a');
        expect(part.membership.get('b')).toBe(ca);
        expect(part.membership.get('c')).toBe(ca);
        const cd = part.membership.get('d');
        expect(part.membership.get('e')).toBe(cd);
        expect(part.membership.get('f')).toBe(cd);
        expect(ca).not.toBe(cd);
    });

    test('localMove on an already-optimal partition does nothing', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const moves = localMove(g, part, 1.0, 7);
        expect(moves).toBe(0);
    });

    test('modularity is non-decreasing after localMove', () => {
        const edges = [
            ['a', 'b', 0.8], ['b', 'c', 0.9], ['a', 'c', 0.7],
            ['c', 'd', 0.3],
            ['d', 'e', 0.85], ['e', 'f', 0.75], ['d', 'f', 0.9],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = singletonPartition(g);
        const qBefore = modularity(g, part, 1.0);
        localMove(g, part, 1.0, 3);
        const qAfter = modularity(g, part, 1.0);
        expect(qAfter).toBeGreaterThanOrEqual(qBefore - 1e-9);
    });

    test('empty graph → 0 moves', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const p = { membership: new Map(), communityCount: 0 };
        expect(localMove(g, p, 1.0)).toBe(0);
    });
});

import { refine } from '../../../../src/consolidation/raptor/leiden.js';

describe('refine', () => {
    test('empty graph → empty refined partition', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const p = { membership: new Map(), communityCount: 0 };
        const { refined, parentOf } = refine(g, p, 1.0);
        expect(refined.communityCount).toBe(0);
        expect(parentOf.size).toBe(0);
    });

    test('well-connected community stays intact through refinement', () => {
        // Triangle {a,b,c} fully connected at w=1. Starting from a single
        // parent community {a,b,c}, refinement should keep all three together.
        const edges = [['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1]];
        const g = buildGraph(/** @type {any} */ (edges));
        const parent = partitionFrom({ a: 0, b: 0, c: 0 });
        const { refined } = refine(g, parent, 1.0);
        const ra = refined.membership.get('a');
        expect(refined.membership.get('b')).toBe(ra);
        expect(refined.membership.get('c')).toBe(ra);
        expect(refined.communityCount).toBe(1);
    });

    test('weakly-bridged community is preserved if well-connectedness threshold allows', () => {
        // Two triangles bridged by ONE weak edge a—d at w=0.1, all placed in one
        // parent community. Refinement may or may not split them depending on γ;
        // at γ=1.0 and weak bridge, the threshold typically keeps them together
        // or splits them — the test verifies the refinement output is VALID
        // (each refined community contains only nodes from one parent) and that
        // modularity does NOT decrease under the refined partition.
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const parent = partitionFrom({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
        const { refined, parentOf } = refine(g, parent, 1.0);

        // Hierarchical invariant: every refined community maps to EXACTLY one parent.
        for (const [a] of refined.membership) {
            const sub = refined.membership.get(a);
            expect(sub !== undefined).toBe(true);
            const par = parent.membership.get(a);
            expect(parentOf.get(/** @type {number} */ (sub))).toBe(par);
        }

        // Modularity should not decrease (refinement is a non-decreasing operation).
        const qBefore = modularity(g, parent, 1.0);
        const qAfter = modularity(g, refined, 1.0);
        expect(qAfter).toBeGreaterThanOrEqual(qBefore - 1e-9);
    });

    test('parentOf map is well-formed: each refined id maps to exactly one parent', () => {
        const edges = [['a', 'b', 1], ['b', 'c', 1], ['d', 'e', 1]];
        const g = buildGraph(/** @type {any} */ (edges));
        const parent = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1 });
        const { refined, parentOf } = refine(g, parent, 1.0);
        // Every refined id that appears in membership must be in parentOf.
        const refinedIds = new Set(refined.membership.values());
        for (const rid of refinedIds) {
            expect(parentOf.has(rid)).toBe(true);
        }
    });
});

import { aggregate, liftPartition, unliftPartition } from '../../../../src/consolidation/raptor/leiden.js';

describe('aggregate', () => {
    test('empty graph aggregates to empty graph', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const p = { membership: new Map(), communityCount: 0 };
        const agg = aggregate(g, p);
        expect(agg.nodes).toEqual([]);
        expect(agg.totalWeight).toBe(0);
    });

    test('two triangles + bridge → aggregated 2-node graph', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const agg = aggregate(g, part);
        expect(agg.nodes.length).toBe(2);
        // Aggregated totalWeight equals original totalWeight
        expect(agg.totalWeight).toBeCloseTo(g.totalWeight, 6);
        // The bridge edge a—d (w=0.1) becomes an edge between agg_0 and agg_1
        const rowA = agg.adjacency.get('agg_0');
        expect(rowA?.get('agg_1')).toBeCloseTo(0.1, 6);
        // Self-loops carry the intra-triangle weight (3 edges × 2 = 6 each)
        expect(rowA?.get('agg_0')).toBeCloseTo(6, 6);
    });
});

describe('liftPartition + unliftPartition round-trip', () => {
    test('lift then unlift recovers the original parent mapping', () => {
        const edges = [['a', 'b', 1], ['c', 'd', 1]];
        const g = buildGraph(/** @type {any} */ (edges));
        const refined = partitionFrom({ a: 0, b: 0, c: 1, d: 1 });
        // Pretend parent says {a,b} and {c,d} are both in parent community 0
        const parentOf = new Map([[0, 0], [1, 0]]);
        const agg = aggregate(g, refined);
        const lifted = liftPartition(agg, parentOf);
        // After lifting, both aggregated nodes map to parent 0
        expect(lifted.membership.get('agg_0')).toBe(lifted.membership.get('agg_1'));
        // And unlifting back onto the original graph places all 4 nodes in 1 parent
        const unlifted = unliftPartition(g, refined, lifted);
        expect(new Set(unlifted.membership.values()).size).toBe(1);
    });
});
