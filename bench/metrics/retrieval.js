import { tokenize } from '../../src/retrieval/bm25.js';

/** @type {number} */
export const DEFAULT_GOLD_THRESHOLD = 0.5;

/** @type {number[]} */
export const STANDARD_K = [1, 3, 5, 10];

/**
 * @typedef {object} RetrievedEntry
 * @property {string} id
 * @property {string} content
 * @property {number} score
 */

/**
 * @typedef {object} GoldTurn
 * @property {number} turnIndex
 * @property {string} text
 */

/**
 * @typedef {object} MatchGoldResult
 * @property {Set<string>} matchedIds
 * @property {Record<number, string[]>} perGold
 */

/**
 * @typedef {object} Run
 * @property {RetrievedEntry[]} retrieved
 * @property {GoldTurn[]} goldTurns
 */

/**
 * @typedef {object} MetricsResult
 * @property {number} n
 * @property {Record<number, number>} precisionAtK
 * @property {Record<number, number>} recallAtK
 * @property {number} mrr
 */

/**
 * Compute Jaccard similarity between two token arrays.
 * Both empty → 1; otherwise intersection / union (0 if union is 0).
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
    if (a.length === 0 && b.length === 0) return 1;
    const setA = new Set(a);
    const setB = new Set(b);
    let inter = 0;
    for (const x of setA) {
        if (setB.has(x)) inter++;
    }
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Match retrieved entries against gold turns using Jaccard over tokenized text.
 *
 * @param {RetrievedEntry[]} retrieved
 * @param {GoldTurn[]} goldTurns
 * @param {{ threshold?: number }} [opts]
 * @returns {MatchGoldResult}
 */
export function matchGold(retrieved, goldTurns, opts = {}) {
    const threshold = opts.threshold ?? DEFAULT_GOLD_THRESHOLD;

    /** @type {Set<string>} */
    const matchedIds = new Set();
    /** @type {Record<number, string[]>} */
    const perGold = {};

    /** @type {Array<{ turnIndex: number, tokens: string[] }>} */
    const goldTokens = goldTurns.map(g => ({
        turnIndex: g.turnIndex,
        tokens: tokenize(g.text),
    }));

    for (const entry of retrieved) {
        const entryTokens = tokenize(entry.content);
        for (const gold of goldTokens) {
            if (jaccard(entryTokens, gold.tokens) >= threshold) {
                matchedIds.add(entry.id);
                if (!perGold[gold.turnIndex]) {
                    perGold[gold.turnIndex] = [];
                }
                perGold[gold.turnIndex].push(entry.id);
            }
        }
    }

    return { matchedIds, perGold };
}

/**
 * Precision at k: hits in top-k divided by min(k, result count). No padding.
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(matchedIds, rankedIds, k) {
    if (rankedIds.length === 0) return 0;
    const top = rankedIds.slice(0, k);
    let hits = 0;
    for (const id of top) {
        if (matchedIds.has(id)) hits++;
    }
    return hits / top.length;
}

/**
 * Recall at k: fraction of matched ids that appear in top-k.
 *
 * `matchedIds` is typically computed from `matchGold` over the FULL retrieval
 * (not top-k), so recall@k measures "what fraction of retrievable gold
 * appears in top-k," not "what fraction of gold turns have any match
 * anywhere."
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @param {number} k
 * @returns {number}
 */
export function recallAtK(matchedIds, rankedIds, k) {
    if (matchedIds.size === 0) return 1.0;
    const top = new Set(rankedIds.slice(0, k));
    let hits = 0;
    for (const id of matchedIds) {
        if (top.has(id)) hits++;
    }
    return hits / matchedIds.size;
}

/**
 * Mean Reciprocal Rank: 1/(position of first hit). 0 if no hit.
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @returns {number}
 */
export function mrr(matchedIds, rankedIds) {
    for (let i = 0; i < rankedIds.length; i++) {
        if (matchedIds.has(rankedIds[i])) {
            return 1 / (i + 1);
        }
    }
    return 0;
}

/**
 * Aggregate precision@k, recall@k, and MRR over a batch of runs.
 *
 * @param {Run[]} runs
 * @param {{ kValues?: number[] }} [opts]
 * @returns {MetricsResult}
 */
export function computeMetrics(runs, opts = {}) {
    const kValues = opts.kValues ?? STANDARD_K;
    const n = runs.length || 1;

    /** @type {Record<number, number>} */
    const precisionSums = {};
    /** @type {Record<number, number>} */
    const recallSums = {};
    let mrrSum = 0;

    for (const k of kValues) {
        precisionSums[k] = 0;
        recallSums[k] = 0;
    }

    for (const run of runs) {
        const { matchedIds } = matchGold(run.retrieved, run.goldTurns);
        const rankedIds = run.retrieved.map(r => r.id);
        for (const k of kValues) {
            precisionSums[k] += precisionAtK(matchedIds, rankedIds, k);
            recallSums[k] += recallAtK(matchedIds, rankedIds, k);
        }
        mrrSum += mrr(matchedIds, rankedIds);
    }

    /** @type {Record<number, number>} */
    const precisionResult = {};
    /** @type {Record<number, number>} */
    const recallResult = {};

    for (const k of kValues) {
        precisionResult[k] = precisionSums[k] / n;
        recallResult[k] = recallSums[k] / n;
    }

    return {
        n: runs.length,
        precisionAtK: precisionResult,
        recallAtK: recallResult,
        mrr: mrrSum / n,
    };
}
