/**
 * Tier 2 — BM25 over all non-working entries, rescored under the active
 * scorer. Returns { hit, scored }. The ladder decides what to do on miss
 * (pass scored as Tier 3 seeds when Phase 5 lands, or fall through to Floor).
 *
 * @module retrieval/tier2-bm25
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { RETRIEVAL } from '../core/constants.js';
import { buildIndex, query as bm25Query } from './bm25.js';
import { getScorer } from './scorer.js';
import { recencyAt } from '../lifecycle/recency.js';
import { maturityBoost } from '../lifecycle/maturity.js';

/**
 * @typedef {{
 *   entry: import('../core/schema.js').Entry,
 *   bm25: number,
 *   score: number,
 *   factors?: {
 *     bm25: number,
 *     importance: number,
 *     importanceFactor: number,
 *     recencyFactor: number,
 *     maturityFactor: number,
 *   },
 * }} ScoredEntry
 */

/**
 * @typedef {{ hit: boolean, scored: ScoredEntry[] }} Tier2Result
 */

/**
 * @param {import('../core/schema.js').State} state
 * @param {string} queryStr
 * @param {{ now: Date, intent: 'factual'|'relational'|'temporal', k?: number, diagnostic?: boolean }} ctx
 * @returns {Tier2Result}
 */
export function tier2(state, queryStr, ctx) {
    const { now, intent, k = 10, diagnostic = false } = ctx;

    /** @type {import('../core/schema.js').Entry[]} */
    const entries = [];
    for (const e of Object.values(state.entries)) {
        if (e.scope !== 'working') entries.push(e);
    }
    if (entries.length === 0) {
        return { hit: false, scored: [] };
    }

    const index = buildIndex(entries);
    const raw = bm25Query(index, queryStr, k);
    if (raw.length === 0) {
        return { hit: false, scored: [] };
    }

    const scorer = getScorer();
    const scored = raw
        .map(r => {
            const importance = r.entry.lifecycle.importance;
            const importanceFactor = 1 + importance / 100;
            const recencyFactor = recencyAt(now, r.entry.lifecycle.createdAt);
            const maturityFactor = maturityBoost(r.entry.lifecycle.maturity);
            const score = r.bm25 * importanceFactor * recencyFactor * maturityFactor;
            /** @type {ScoredEntry} */
            const out = {
                entry: r.entry,
                bm25: r.bm25,
                score,
            };
            if (diagnostic) {
                out.factors = {
                    bm25: r.bm25,
                    importance,
                    importanceFactor,
                    recencyFactor,
                    maturityFactor,
                };
            }
            return out;
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
        return { hit: false, scored: [] };
    }

    const top = scored[0].score;
    const second = scored[1]?.score ?? 0;
    const gap = top - second;
    const hit = top >= RETRIEVAL.TIER2_TAU_CONFIDENCE && gap >= RETRIEVAL.TIER2_TAU_GAP;

    return { hit, scored };
}
