/**
 * Floor — pure fallback. Returns top-K entries by
 * recency × (1 + importance/100) × maturity_boost when all tiers above
 * yielded empty results. No BM25 factor; this is "the last thing we can
 * still say something sensible about."
 *
 * @module retrieval/floor
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { recencyAt, maturityBoost } from '../lifecycle/index.js';

/**
 * @param {import('../core/schema.js').State} state
 * @param {{ now: Date, k?: number }} ctx
 * @returns {{entry: import('../core/schema.js').Entry, bm25: number, score: number}[]}
 */
export function floor(state, ctx) {
    const { now, k = 5 } = ctx;
    const scored = [];
    for (const entry of Object.values(state.entries)) {
        if (entry.scope === 'working') continue;
        const { importance, maturity, createdAt } = entry.lifecycle;
        const score = recencyAt(now, createdAt)
            * (1 + importance / 100)
            * maturityBoost(maturity);
        scored.push({ entry, bm25: 0, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}
