/**
 * Recency-only baseline retriever.
 *
 * Sorts all entries by lifecycle.updatedAt descending (ISO 8601 string
 * compare), returns top-K. No BM25, no scorer chain. Measures how much
 * the ladder's full-text + graph expansion earns over "just return the
 * most recently touched entries."
 *
 * @module bench/baselines/recency
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { buildTrace, logTrace } from '../../src/retrieval/trace.js';

/**
 * @param {import('../../src/core/schema.js').State} state
 * @param {string} queryStr
 * @param {{ now?: Date, k?: number }} [opts]
 * @returns {import('../../src/retrieval/ladder.js').RetrieveResult}
 */
export function recency(state, queryStr, opts = {}) {
    const { now = new Date(), k = 5 } = opts;
    const entries = Object.values(state.entries);

    if (entries.length === 0) {
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier: 'factual',
            tierResolved: 'recency',
            perTier: { recency: [] },
            finalRanking: [],
            scorerId: 'recency',
        });
        const nextState = logTrace(state, trace);
        return { entries: [], tierResolved: 'recency', trace, state: nextState };
    }

    const sorted = [...entries].sort((a, b) => {
        const ua = a.lifecycle?.updatedAt;
        const ub = b.lifecycle?.updatedAt;
        if (!ua || ua === '') return 1;
        if (!ub || ub === '') return -1;
        return ub.localeCompare(ua);
    });

    const ranked = sorted.slice(0, k);

    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier: 'factual',
        tierResolved: 'recency',
        perTier: { recency: ranked.map(e => ({ id: e.id })) },
        finalRanking: ranked.map(e => e.id),
        scorerId: 'recency',
    });
    const nextState = logTrace(state, trace);

    return {
        entries: ranked,
        tierResolved: 'recency',
        trace,
        state: nextState,
    };
}
