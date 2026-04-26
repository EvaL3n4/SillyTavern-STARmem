/**
 * Tier 0 — exact query cache. Hash of normalized (trim+lowercase) query →
 * entry id list. Hit returns in <1ms (single Map lookup + deref). Invalidated
 * on long-term writes from Phase 6's consolidate(); NOT invalidated on
 * working-buffer appends (the prepend runs downstream of this cache).
 *
 * @module retrieval/tier0-exact
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { RETRIEVAL } from '../core/constants.js';

/**
 * @typedef {{
 *   hit: boolean,
 *   entries: import('../core/schema.js').Entry[],
 *   state: import('../core/schema.js').State,
 * }} Tier0Result
 */

/**
 * Normalize a query for cache keying. Trim + lowercase. Internal whitespace
 * is preserved so Tier 1's token-set construction sees the same shape.
 *
 * @param {string} q
 * @returns {string}
 */
export function normalizeQuery(q) {
    if (typeof q !== 'string') {
        throw new Error(`normalizeQuery: q must be a string, got ${typeof q}`);
    }
    return q.trim().toLowerCase();
}

/**
 * FNV-1a 32-bit hash of a string. 8-char lowercase hex. Collision-safe
 * enough for a per-chat cache; not cryptographic.
 *
 * @param {string} s
 * @returns {string}
 */
export function hashQuery(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** @param {string} q */
function keyFor(q) {
    return hashQuery(normalizeQuery(q));
}

/**
 * Look up a query in the exact cache.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @returns {Tier0Result}
 */
export function tier0(state, query) {
    const key = keyFor(query);
    const ids = state.tierCaches.exact[key];
    if (!ids || ids.length === 0) {
        return { hit: false, entries: [], state };
    }
    const entries = [];
    for (const id of ids) {
        const e = state.entries[id];
        if (e) entries.push(e);
    }
    return { hit: true, entries, state };
}

/**
 * Record a resolved query's id list in the exact cache. Bounded at
 * `RETRIEVAL.TIER_CACHE_MAX_ENTRIES` — oldest insertion-order entries are
 * evicted first when the cap is exceeded. Pure — returns a new state.
 *
 * Reading RETRIEVAL.TIER_CACHE_MAX_ENTRIES at call time (NOT destructuring
 * at module top) so sweep overrides are observed. See
 * tests/unit/core/swept-constants-overridable.test.js.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {import('../core/schema.js').State}
 */
export function recordTier0(state, query, entries) {
    const key = keyFor(query);
    const ids = entries.map(e => e.id);
    // Delete-then-reinsert so the updated key moves to the end (LRU).
    // Object insertion-order is preserved per ECMA-262 §6.1.7.
    const { [key]: _discard, ...without } = state.tierCaches.exact;
    const next = { ...without, [key]: ids };
    const cap = RETRIEVAL.TIER_CACHE_MAX_ENTRIES;
    const keys = Object.keys(next);
    if (keys.length > cap) {
        // Evict the oldest (keys.length - cap) entries.
        const evicted = keys.slice(0, keys.length - cap);
        for (const k of evicted) delete next[k];
    }
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            exact: next,
        },
    };
}

/**
 * Drop the entire exact cache. Phase 6's consolidate() calls this inside
 * the write lock after any long-term mutation (new episodic entry, edge
 * write, importance bump). Pure—returns a new state.
 *
 * @param {import('../core/schema.js').State} state
 * @returns {import('../core/schema.js').State}
 */
export function invalidateTier0Cache(state) {
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            exact: {},
        },
    };
}
