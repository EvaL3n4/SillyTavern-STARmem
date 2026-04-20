/**
 * Tier 1 — Jaccard fuzzy over recent query token sets. Catches near-
 * duplicate queries ("where does alice live" ≈ "alice's location") without
 * re-running BM25. <5ms: O(cacheSize × avgTokens).
 *
 * @module retrieval/tier1-fuzzy
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { RETRIEVAL } from '../core/constants.js';
import { tokenize } from './bm25.js';

const { FUZZY_JACCARD_THRESHOLD } = RETRIEVAL;

/**
 * Jaccard similarity over token sets. Duplicates are ignored (set semantics).
 * Both empty → 0 (not NaN).
 *
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number} in [0, 1]
 */
export function jaccard(aTokens, bTokens) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Canonical cache key for a query: sorted unique tokens joined by single
 * spaces. Round-trips via `key.split(' ')` back to the token set.
 *
 * @param {string} query
 * @returns {string}
 */
export function tokenSetKey(query) {
    const toks = Array.from(new Set(tokenize(query))).sort();
    return toks.join(' ');
}

/**
 * @typedef {{
 *   hit: boolean,
 *   entries: import('../core/schema.js').Entry[],
 *   state: import('../core/schema.js').State,
 * }} Tier1Result
 */

/**
 * Look up the query's token set against cached recent queries. Returns the
 * highest-Jaccard match's entries if Jaccard ≥ threshold, otherwise miss.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @returns {Tier1Result}
 */
export function tier1(state, query) {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0) {
        return { hit: false, entries: [], state };
    }

    /** @type {string[] | null} */
    let bestIds = null;
    let bestJ = 0;
    for (const [cachedKey, ids] of Object.entries(state.tierCaches.fuzzy)) {
        if (cachedKey.length === 0) continue;
        const cachedTokens = cachedKey.split(' ');
        const j = jaccard(qTokens, cachedTokens);
        if (j > bestJ) {
            bestJ = j;
            bestIds = ids;
        }
    }

    if (bestJ < FUZZY_JACCARD_THRESHOLD || !bestIds) {
        return { hit: false, entries: [], state };
    }

    const entries = [];
    for (const id of bestIds) {
        const e = state.entries[id];
        if (e) entries.push(e);
    }
    return { hit: true, entries, state };
}

/**
 * Record a resolved query's entries under its token-set key. Empty-token
 * queries are a no-op (returns a new state object for API consistency).
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {import('../core/schema.js').State}
 */
export function recordTier1(state, query, entries) {
    const key = tokenSetKey(query);
    if (key.length === 0) {
        return { ...state };
    }
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            fuzzy: {
                ...state.tierCaches.fuzzy,
                [key]: entries.map(e => e.id),
            },
        },
    };
}
