import {
    ALL_EDGE_TYPES,
    isScope,
    isMaturity,
    isEdgeType,
    createEmptyState,
} from '../../../src/core/schema.js';

describe('schema', () => {
    test('ALL_EDGE_TYPES includes produced and reserved', () => {
        expect(ALL_EDGE_TYPES).toEqual([
            'mentions', 'supports', 'same_topic', 'temporal_next', 'contradicts',
        ]);
    });

    test('isScope narrows valid scopes only', () => {
        expect(isScope('working')).toBe(true);
        expect(isScope('episodic')).toBe(true);
        expect(isScope('persona')).toBe(true);
        expect(isScope('graph')).toBe(false);
        expect(isScope('')).toBe(false);
        expect(isScope(undefined)).toBe(false);
    });

    test('isMaturity narrows valid tiers only', () => {
        expect(isMaturity('draft')).toBe(true);
        expect(isMaturity('core')).toBe(true);
        expect(isMaturity('graduated')).toBe(false);
    });

    test('isEdgeType accepts produced + reserved', () => {
        expect(isEdgeType('mentions')).toBe(true);
        expect(isEdgeType('contradicts')).toBe(true);
        expect(isEdgeType('unrelated')).toBe(false);
    });

    test('createEmptyState returns a fresh zero-valued State', () => {
        const s = createEmptyState();
        expect(s.entries).toEqual({});
        expect(s.workingBuffer).toEqual([]);
        expect(s.graph).toEqual({ edges: [] });
        expect(s.tierCaches).toEqual({ exact: {}, fuzzy: {} });
        expect(s.runtime.lastConsolidation).toBe(null);
        expect(s.runtime.pendingPersonaRebuild).toBe(false);
        expect(s.runtime.traces).toEqual([]);
    });

    test('createEmptyState returns a fresh object each call (no shared refs)', () => {
        const a = createEmptyState();
        const b = createEmptyState();
        a.entries.foo = /** @type {any} */ ({});
        a.workingBuffer.push('x');
        a.graph.edges.push(/** @type {any} */ ({}));
        expect(b.entries).toEqual({});
        expect(b.workingBuffer).toEqual([]);
        expect(b.graph.edges).toEqual([]);
    });
});
