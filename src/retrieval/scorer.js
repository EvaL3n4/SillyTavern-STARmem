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

/** @type {Map<string, Scorer>} */
const scorers = new Map([['default', defaultScorer]]);

/** @type {string} */
let currentId = 'default';

/**
 * Register a scorer under a string id. Traces record the id, so pick a stable
 * symbolic name. Re-registering the literal `defaultScorer` under 'default' is
 * a no-op; any other collision throws.
 *
 * @param {string} id
 * @param {Scorer} fn
 */
export function registerScorer(id, fn) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`registerScorer: id must be a non-empty string, got ${typeof id}`);
    }
    if (typeof fn !== 'function') {
        throw new Error(`registerScorer: fn must be a function, got ${typeof fn}`);
    }
    if (id === 'default' && fn === defaultScorer) return;
    if (scorers.has(id)) {
        throw new Error(`registerScorer: id '${id}' is already registered`);
    }
    scorers.set(id, fn);
}

/**
 * Activate a registered scorer by id. Phase 8's settings UI calls this when
 * the user switches scorer in A/B mode.
 *
 * @param {string} id
 */
export function setScorer(id) {
    if (!scorers.has(id)) {
        throw new Error(`setScorer: id '${id}' is not registered`);
    }
    currentId = id;
}

/** @returns {Scorer} */
export function getScorer() {
    return /** @type {Scorer} */ (scorers.get(currentId));
}

/** @returns {string} */
export function getScorerId() {
    return currentId;
}

/** Test-only escape hatch. Clears the registry back to the default-only state. */
export function _resetScorerForTests() {
    scorers.clear();
    scorers.set('default', defaultScorer);
    currentId = 'default';
}
