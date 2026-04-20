import {
    addEdge,
    removeEdge,
    listEdges,
    buildAdjacency,
    neighborsOf,
} from '../../../src/memory/graph.js';
import { createEmptyState } from '../../../src/core/schema.js';

/** @type {(from: string, to: string, type?: import('../../../src/core/schema.js').EdgeType, weight?: number) => import('../../../src/core/schema.js').Edge} */
function edge(from, to, type = 'mentions', weight = 0.5) {
    return { from, to, type, weight };
}

function seed(edges = []) {
    const s = createEmptyState();
    s.graph.edges = edges;
    return s;
}

describe('addEdge', () => {
    test('adds to empty graph', () => {
        const s = addEdge(createEmptyState(), edge('a', 'b'));
        expect(s.graph.edges).toHaveLength(1);
        expect(s.graph.edges[0]).toEqual(edge('a', 'b'));
    });

    test('is pure (returns new state)', () => {
        const s = createEmptyState();
        const before = structuredClone(s);
        addEdge(s, edge('a', 'b'));
        expect(s).toEqual(before);
    });

    test('dedupes on (from, to, type), updating weight', () => {
        let s = addEdge(createEmptyState(), edge('a', 'b', 'mentions', 0.3));
        s = addEdge(s, edge('a', 'b', 'mentions', 0.9));
        expect(s.graph.edges).toHaveLength(1);
        expect(s.graph.edges[0].weight).toBe(0.9);
    });

    test('keeps different types between same nodes distinct', () => {
        let s = addEdge(createEmptyState(), edge('a', 'b', 'mentions'));
        s = addEdge(s, edge('a', 'b', 'same_topic'));
        expect(s.graph.edges).toHaveLength(2);
    });

    test('keeps reverse-direction edges distinct', () => {
        let s = addEdge(createEmptyState(), edge('a', 'b', 'mentions'));
        s = addEdge(s, edge('b', 'a', 'mentions'));
        expect(s.graph.edges).toHaveLength(2);
    });
});

describe('removeEdge', () => {
    test('removes matching edge', () => {
        const s = seed([edge('a', 'b'), edge('a', 'c')]);
        const next = removeEdge(s, 'a', 'b', 'mentions');
        expect(next.graph.edges).toHaveLength(1);
        expect(next.graph.edges[0].to).toBe('c');
    });

    test('no-op on miss returns new state', () => {
        const s = seed([edge('a', 'b')]);
        const next = removeEdge(s, 'x', 'y', 'mentions');
        expect(next.graph.edges).toHaveLength(1);
        expect(next).not.toBe(s);
    });

    test('is pure', () => {
        const s = seed([edge('a', 'b')]);
        const before = structuredClone(s);
        removeEdge(s, 'a', 'b', 'mentions');
        expect(s).toEqual(before);
    });

    test('only removes exact type match', () => {
        const s = seed([edge('a', 'b', 'mentions'), edge('a', 'b', 'same_topic')]);
        const next = removeEdge(s, 'a', 'b', 'mentions');
        expect(next.graph.edges).toHaveLength(1);
        expect(next.graph.edges[0].type).toBe('same_topic');
    });
});

describe('listEdges', () => {
    test('returns a fresh array', () => {
        const s = seed([edge('a', 'b')]);
        const out = listEdges(s);
        expect(out).toEqual([edge('a', 'b')]);
        expect(out).not.toBe(s.graph.edges);
    });

    test('empty state yields empty array', () => {
        expect(listEdges(createEmptyState())).toEqual([]);
    });
});

describe('buildAdjacency', () => {
    test('empty state yields empty map', () => {
        expect(buildAdjacency(createEmptyState()).size).toBe(0);
    });

    test('groups edges by from-id', () => {
        const s = seed([
            edge('a', 'b'),
            edge('a', 'c'),
            edge('b', 'c'),
        ]);
        const adj = buildAdjacency(s);
        expect(adj.get('a')).toHaveLength(2);
        expect(adj.get('b')).toHaveLength(1);
        expect(adj.get('c')).toBeUndefined();
    });

    test('returned arrays are independent of state.graph.edges', () => {
        const s = seed([edge('a', 'b')]);
        const adj = buildAdjacency(s);
        adj.get('a').push(edge('a', 'x'));
        expect(s.graph.edges).toHaveLength(1);
    });
});

describe('neighborsOf', () => {
    test('returns edges for an id present in the adjacency', () => {
        const adj = new Map([['a', [edge('a', 'b'), edge('a', 'c')]]]);
        expect(neighborsOf(adj, 'a')).toHaveLength(2);
    });

    test('returns empty array for missing id', () => {
        const adj = new Map([['a', [edge('a', 'b')]]]);
        expect(neighborsOf(adj, 'nope')).toEqual([]);
    });
});
