/**
 * Retrieval trace logger. Pure ring-buffer append into state.runtime.traces.
 * Cap = TRACE_BUFFER_CAP (128). Each retrieval writes exactly one trace;
 * exportable as JSONL from the Memory Viewer Traces tab (Phase 8).
 *
 * @module retrieval/trace
 * @see docs/specs/2026-04-20-starmem-v2-design.md §9.1
 */

import { TRACE_BUFFER_CAP } from '../core/constants.js';

/**
 * @typedef {{
 *   timestamp: string,
 *   query: string,
 *   classifier: 'factual' | 'relational' | 'temporal',
 *   tierResolved: 0 | 1 | 2 | 3 | 'floor' | 'bm25only' | 'recency' | 'random',
 *   perTier: Record<string, unknown>,
 *   finalRanking: string[],
 *   scorerId: string,
 * }} Trace
 */

/**
 * Identity-style helper for type-safe trace construction. Zero runtime cost;
 * its job is to give callers a stable call site for future shape evolution.
 *
 * @param {Trace} t
 * @returns {Trace}
 */
export function buildTrace(t) {
    return t;
}

/**
 * Append a trace to state.runtime.traces, evicting the oldest when at cap.
 * Pure—returns a new state.
 *
 * @param {import('../core/schema.js').State} state
 * @param {Trace} trace
 * @returns {import('../core/schema.js').State}
 */
export function logTrace(state, trace) {
    const next = [...state.runtime.traces, trace];
    while (next.length > TRACE_BUFFER_CAP) {
        next.shift();
    }
    return {
        ...state,
        runtime: {
            ...state.runtime,
            traces: next,
        },
    };
}
