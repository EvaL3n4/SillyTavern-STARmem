/**
 * BM25-only baseline retriever.
 *
 * Raw BM25 via buildIndex + query, no scorer chain. Measures how much
 * the ladder's importance × recency × maturity multiplier earns over
 * plain full-text ranking.
 *
 * @module bench/baselines/bm25only
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { buildIndex, query } from '../../src/retrieval/bm25.js';
import { buildTrace, logTrace } from '../../src/retrieval/trace.js';

/**
 * @param {import('../../src/core/schema.js').State} state
 * @param {string} queryStr
 * @param {{ now?: Date, k?: number }} [opts]
 * @returns {import('../../src/retrieval/ladder.js').RetrieveResult}
 */
export function bm25only(state, queryStr, opts = {}) {
    const { now = new Date(), k = 5 } = opts;
    const entries = Object.values(state.entries);

    if (entries.length === 0) {
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier: 'factual',
            tierResolved: 'bm25only',
            perTier: { bm25only: [] },
            finalRanking: [],
            scorerId: 'bm25only',
        });
        const nextState = logTrace(state, trace);
        return { entries: [], tierResolved: 'bm25only', trace, state: nextState };
    }

    const idx = buildIndex(entries);
    const scored = query(idx, queryStr, k);
    const ranked = scored.map(r => r.entry);

    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier: 'factual',
        tierResolved: 'bm25only',
        perTier: { bm25only: ranked.map(e => ({ id: e.id })) },
        finalRanking: ranked.map(e => e.id).slice(0, k),
        scorerId: 'bm25only',
    });
    const nextState = logTrace(state, trace);

    return {
        entries: ranked,
        tierResolved: 'bm25only',
        trace,
        state: nextState,
    };
}
