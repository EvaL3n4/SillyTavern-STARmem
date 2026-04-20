/**
 * Tier 3 — MAGMA-lite intent-routed graph expansion. Beam search 1–2 hops
 * from Tier 2's seeds through `state.graph.edges`, scoring neighbors with
 * exp(λ₁ · edge_type_match + λ₂ · BM25). Final merge with seeds, rescored
 * under the multiplicative scorer.
 *
 * @module retrieval/tier3-graph
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5.1
 */

import { RETRIEVAL, EDGE_TYPE_WEIGHTS } from '../core/constants.js';
import { buildIndex, query as bm25Query } from './bm25.js';
import { getScorer } from './scorer.js';
import { buildAdjacency, neighborsOf } from '../memory/graph.js';

const {
    TIER3_LAMBDA_1,
    TIER3_LAMBDA_2,
    TIER3_MAX_HOPS,
    TIER3_BEAM_WIDTH,
} = RETRIEVAL;

/**
 * @typedef {import('../core/schema.js').State} State
 * @typedef {import('../core/schema.js').Entry} Entry
 * @typedef {import('./tier2-bm25.js').ScoredEntry} ScoredEntry
 * @typedef {'factual' | 'relational' | 'temporal'} Intent
 */

/**
 * @param {State} state
 * @param {Entry[]} seeds
 * @param {string} queryStr
 * @param {Intent} intent
 * @param {{ now: Date, k?: number }} ctx
 * @returns {ScoredEntry[]}
 */
export function tier3(state, seeds, queryStr, intent, ctx) {
    const { now, k = 5 } = ctx;
    if (!Array.isArray(seeds) || seeds.length === 0) return [];

    const adjacency = buildAdjacency(state);

    /** @type {Entry[]} */
    const nonWorking = [];
    for (const e of Object.values(state.entries)) {
        if (e.scope !== 'working') nonWorking.push(e);
    }
    if (nonWorking.length === 0) return [];
    const index = buildIndex(nonWorking);

    const rawAll = bm25Query(index, queryStr, Math.max(nonWorking.length, 1));
    /** @type {Map<string, number>} */
    const bm25Map = new Map();
    for (const r of rawAll) bm25Map.set(r.entry.id, r.bm25);
    const bm25Of = (/** @type {string} */ id) => bm25Map.get(id) ?? 0;

    /** @type {Map<string, { entry: Entry, hop: number }>} */
    const discovered = new Map();
    for (const s of seeds) {
        discovered.set(s.id, { entry: s, hop: 0 });
    }

    let frontier = seeds.map(s => ({ entry: s, hop: 0 }));

    for (let hop = 1; hop <= TIER3_MAX_HOPS; hop++) {
        /** @type {{ entry: Entry, beamScore: number, hop: number }[]} */
        const candidates = [];
        for (const item of frontier) {
            for (const edge of neighborsOf(adjacency, item.entry.id)) {
                if (discovered.has(edge.to)) continue;
                const neighbor = state.entries[edge.to];
                if (!neighbor) continue;
                if (neighbor.scope === 'working') continue;
                const weightTable = EDGE_TYPE_WEIGHTS[edge.type];
                const edgeWeight = weightTable ? weightTable[intent] ?? 0 : 0;
                const bm25 = bm25Of(neighbor.id);
                const beamScore = Math.exp(TIER3_LAMBDA_1 * edgeWeight + TIER3_LAMBDA_2 * bm25);
                candidates.push({ entry: neighbor, beamScore, hop });
            }
        }
        if (candidates.length === 0) break;
        candidates.sort((a, b) => b.beamScore - a.beamScore);
        const topOfHop = candidates.slice(0, TIER3_BEAM_WIDTH);
        for (const t of topOfHop) {
            if (!discovered.has(t.entry.id)) {
                discovered.set(t.entry.id, { entry: t.entry, hop: t.hop });
            }
        }
        frontier = topOfHop.map(t => ({ entry: t.entry, hop: t.hop }));
        if (frontier.length === 0) break;
    }

    const scorer = getScorer();
    /** @type {ScoredEntry[]} */
    const final = [];
    for (const { entry } of discovered.values()) {
        const bm25 = bm25Of(entry.id);
        const score = scorer(entry, queryStr, { now, bm25, intent });
        final.push({ entry, bm25, score });
    }
    final.sort((a, b) => b.score - a.score);
    return final.filter(r => r.score > 0).slice(0, k);
}
