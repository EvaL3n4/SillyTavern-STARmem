import { logTrace, buildTrace } from '../../../src/retrieval/trace.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { TRACE_BUFFER_CAP } from '../../../src/core/constants.js';

describe('buildTrace', () => {
    test('assembles a well-formed trace', () => {
        const t = buildTrace({
            timestamp: '2026-04-20T12:00:00.000Z',
            query: 'alice',
            classifier: 'factual',
            tierResolved: 2,
            perTier: { '2': [{ id: 'a1', bm25: 0.8, score: 1.2 }] },
            finalRanking: ['a1'],
            scorerId: 'default',
        });
        expect(t).toEqual({
            timestamp: '2026-04-20T12:00:00.000Z',
            query: 'alice',
            classifier: 'factual',
            tierResolved: 2,
            perTier: { '2': [{ id: 'a1', bm25: 0.8, score: 1.2 }] },
            finalRanking: ['a1'],
            scorerId: 'default',
        });
    });
});

describe('logTrace', () => {
    function trace(ix = 0) {
        return buildTrace({
            timestamp: `2026-04-20T12:00:${String(ix).padStart(2, '0')}.000Z`,
            query: `q${ix}`,
            classifier: 'factual',
            tierResolved: 'floor',
            perTier: {},
            finalRanking: [],
            scorerId: 'default',
        });
    }

    test('appends to empty ring', () => {
        const s = createEmptyState();
        const next = logTrace(s, trace(1));
        expect(next.runtime.traces).toHaveLength(1);
        expect(next.runtime.traces[0].query).toBe('q1');
    });

    test('is pure (returns new state)', () => {
        const s = createEmptyState();
        const before = structuredClone(s);
        logTrace(s, trace(1));
        expect(s).toEqual(before);
    });

    test('evicts oldest when at cap', () => {
        let s = createEmptyState();
        for (let i = 0; i < TRACE_BUFFER_CAP + 5; i++) {
            s = logTrace(s, trace(i));
        }
        expect(s.runtime.traces).toHaveLength(TRACE_BUFFER_CAP);
        expect(s.runtime.traces[0].query).toBe('q5');
        expect(s.runtime.traces[TRACE_BUFFER_CAP - 1].query).toBe(`q${TRACE_BUFFER_CAP + 4}`);
    });

    test('preserves FIFO order', () => {
        let s = createEmptyState();
        for (let i = 0; i < 3; i++) s = logTrace(s, trace(i));
        expect(s.runtime.traces.map(t => t.query)).toEqual(['q0', 'q1', 'q2']);
    });
});
