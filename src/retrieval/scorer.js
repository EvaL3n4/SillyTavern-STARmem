/**
 * Pluggable retrieval scorer. Default implements spec §5.2's multiplicative
 * formula; alternates can be registered via setScorer for A/B benchmarking
 * (spec §9.2).
 *
 * Signature deviates deliberately from spec §9.2: (entry, query, context)
 * with context = { now, bm25, intent? }. See phase-3 plan Task 3 for rationale
 * (spec signature had redundant lifecycle + missing clock).
 *
 * @module retrieval/scorer
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5.2, §9.2
 */

import { recencyAt, maturityBoost } from '../lifecycle/index.js';

/**
 * @typedef {object} ScorerContext
 * @property {Date} now                                  - Reference clock for recency.
 * @property {number} bm25                               - Pre-computed BM25 score (Phase 4 supplies).
 * @property {'factual'|'relational'|'temporal'} [intent] - Reserved for intent-aware scorers (Phase 5+).
 */

/**
 * @typedef {(
 *   entry: import('../core/schema.js').Entry,
 *   query: string,
 *   context: ScorerContext
 * ) => number} Scorer
 */

/**
 * The spec §5.2 multiplicative scorer. Factor order is decorative—
 * multiplication commutes—but matches the spec for readability.
 *
 * The context parameter is deliberately an object (not positional args)
 * so later factors (intent, query length, classifier confidence) can be
 * added without breaking registered scorers. Unknown keys are ignored.
 *
 * @type {Scorer}
 */
export const defaultScorer = (entry, _query, context) => {
    const { now, bm25 } = context;
    if (bm25 === 0) return 0;                       // fast path
    const { importance, maturity, createdAt } = entry.lifecycle;
    return bm25
        * (1 + importance / 100)
        * recencyAt(now, createdAt)
        * maturityBoost(maturity);
};

/** @type {Scorer} */
let current = defaultScorer;

/**
 * Register a new scorer. Phase 8's settings UI calls this when the user
 * switches scorer in A/B mode.
 *
 * @param {Scorer} fn
 */
export function setScorer(fn) {
    if (typeof fn !== 'function') {
        throw new Error(`setScorer: fn must be a function, got ${typeof fn}`);
    }
    current = fn;
}

/** @returns {Scorer} */
export function getScorer() {
    return current;
}

/** Test-only escape hatch. */
export function _resetScorerForTests() {
    current = defaultScorer;
}
