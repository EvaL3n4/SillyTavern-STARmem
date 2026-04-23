/**
 * Retrieval metrics: precision@k, recall@k, MRR.
 *
 * As of sub-phase 9.4.6, gold matching uses turn-index intersection
 * (matchGoldByEvidence) rather than text Jaccard (matchGold — deprecated).
 * The legacy matcher is preserved for provenance but is not wired into
 * computeMetrics.
 *
 * Unscorable queries (empty matchedIds — either the QA has no evidence
 * or no retrieved entry intersects it) return NaN. computeMetrics
 * aggregates via nanmean and surfaces n_scored / n_skipped separately
 * so the caller can see the honest denominator.
 *
 * @module bench/metrics/retrieval
 * @see docs/plans/phase-9-4-6-honest-metrics.md
 */

import { tokenize } from '../../src/retrieval/bm25.js';

/** @type {number} @deprecated Used only by legacy matchGold. */
export const DEFAULT_GOLD_THRESHOLD = 0.5;

/** @type {number[]} */
export const STANDARD_K = [1, 3, 5, 10];

/**
 * @typedef {object} RetrievedEntry
 * @property {string} id
 * @property {string} content
 * @property {number[]} [sourceMessages]  - post-9.4.6; carried by runner.js
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
 * @typedef {object} QAWithEvidence
 * @property {number[]} evidenceTurns
 */

/**
 * @typedef {object} Run
 * @property {RetrievedEntry[]} retrieved
 * @property {QAWithEvidence} qa
 */

/**
 * @typedef {object} MetricsResult
 * @property {number} n              - Total run count.
 * @property {number} n_scored       - Runs that produced numeric metrics.
 * @property {number} n_skipped      - Runs that produced NaN (empty matchedIds).
 * @property {Record<number, number>} precisionAtK  - NaN if n_scored === 0.
 * @property {Record<number, number>} recallAtK     - NaN if n_scored === 0.
 * @property {number} mrr            - NaN if n_scored === 0.
 * @property {number} coverage       - n_scored / n. NaN if n === 0.
 */

/**
 * Jaccard similarity over token arrays. Preserved for the deprecated
 * matchGold path; do not use in new code.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 * @deprecated 9.4.6 — evidence-turn intersection replaces text-Jaccard matching.
 */
export function jaccard(a, b) {
    if (a.length === 0 && b.length === 0) return 1;
    const setA = new Set(a);
    const setB = new Set(b);
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter++;
    const union = setA.size + setB.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Legacy text-Jaccard gold matcher. Vacuously matches nothing on
 * LLM-synthesized facts vs raw gold turn text — the primary cause of
 * Phase 9's "flat sweep" artifact. Kept for historical audit only.
 *
 * @param {RetrievedEntry[]} retrieved
 * @param {GoldTurn[]} goldTurns
 * @param {{ threshold?: number }} [opts]
 * @returns {MatchGoldResult}
 * @deprecated 9.4.6 — use matchGoldByEvidence.
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
 * Evidence-turn gold matcher. A retrieved entry matches iff its
 * provenance.sourceMessages (carried as entry.sourceMessages by
 * bench/runner.js) intersects the QA's evidenceTurns. Zero heuristics,
 * zero threshold, zero tokenization.
 *
 * @param {RetrievedEntry[]} retrieved
 * @param {number[]} evidenceTurns
 * @returns {MatchGoldResult}
 */
export function matchGoldByEvidence(retrieved, evidenceTurns) {
    /** @type {Set<string>} */
    const matchedIds = new Set();
    /** @type {Record<number, string[]>} */
    const perGold = {};

    if (!Array.isArray(evidenceTurns) || evidenceTurns.length === 0) {
        return { matchedIds, perGold };
    }

    const evidenceSet = new Set(evidenceTurns);

    for (const entry of retrieved) {
        const srcs = entry.sourceMessages;
        if (!Array.isArray(srcs) || srcs.length === 0) continue;

        for (const src of srcs) {
            if (evidenceSet.has(src)) {
                matchedIds.add(entry.id);
                if (!perGold[src]) perGold[src] = [];
                if (!perGold[src].includes(entry.id)) perGold[src].push(entry.id);
            }
        }
    }

    return { matchedIds, perGold };
}

/**
 * Precision@k. Returns NaN when matchedIds is empty (unscorable QA —
 * no gold exists for this query or no retrieval intersected it).
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(matchedIds, rankedIds, k) {
    if (matchedIds.size === 0) return NaN;
    if (rankedIds.length === 0) return 0;
    const top = rankedIds.slice(0, k);
    let hits = 0;
    for (const id of top) {
        if (matchedIds.has(id)) hits++;
    }
    return hits / top.length;
}

/**
 * Recall@k. Returns NaN when matchedIds is empty (unscorable). The old
 * "return 1.0 on empty matchedIds" default was the vacuous-truth
 * antipattern that shadowed every Phase 9 sweep; deleted in 9.4.6.
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @param {number} k
 * @returns {number}
 */
export function recallAtK(matchedIds, rankedIds, k) {
    if (matchedIds.size === 0) return NaN;
    const top = new Set(rankedIds.slice(0, k));
    let hits = 0;
    for (const id of matchedIds) {
        if (top.has(id)) hits++;
    }
    return hits / matchedIds.size;
}

/**
 * Mean Reciprocal Rank. Returns NaN when matchedIds is empty (unscorable).
 *
 * @param {Set<string>} matchedIds
 * @param {string[]} rankedIds
 * @returns {number}
 */
export function mrr(matchedIds, rankedIds) {
    if (matchedIds.size === 0) return NaN;
    for (let i = 0; i < rankedIds.length; i++) {
        if (matchedIds.has(rankedIds[i])) {
            return 1 / (i + 1);
        }
    }
    return 0;
}

/**
 * Aggregate precision@k, recall@k, and MRR over a batch of runs.
 * Uses nanmean: sum of non-NaN contributions divided by count of
 * non-NaN contributions. Reports n_scored / n_skipped alongside
 * values for honesty — the caller sees the real denominator.
 *
 * Phase 12: excludes abstention runs from scoring. When any run carries
 * `taskType`, emits a `byTaskType` slice with per-type metrics. When any
 * run carries `abstention`, emits `abstentionCount`. LoCoMo-shaped runs
 * (no taskType, no abstention) produce exactly the Phase 11 schema.
 *
 * @param {Run[]} runs
 * @param {{ kValues?: number[], _suppressByTaskType?: boolean }} [opts]
 * @returns {MetricsResult & { byTaskType?: Record<string, { mrr: number, coverage: number, n_scored: number, n_skipped: number }>, abstentionCount?: number }}
 */
export function computeMetrics(runs, opts = {}) {
    const kValues = opts.kValues ?? STANDARD_K;

    // Phase 12: exclude abstention runs from scoring per Decision 10
    const scorableRuns = runs.filter(r => r.qa?.abstention !== true);

    /** @type {Record<number, number>} */
    const precisionSums = {};
    /** @type {Record<number, number>} */
    const recallSums = {};
    /** @type {Record<number, number>} */
    const precisionCounts = {};
    /** @type {Record<number, number>} */
    const recallCounts = {};
    let mrrSum = 0;
    let mrrCount = 0;

    for (const k of kValues) {
        precisionSums[k] = 0;
        recallSums[k] = 0;
        precisionCounts[k] = 0;
        recallCounts[k] = 0;
    }

    let n_scored = 0;
    let n_skipped = 0;

    for (const run of scorableRuns) {
        const evidenceTurns = run.qa?.evidenceTurns ?? [];
        const { matchedIds } = matchGoldByEvidence(run.retrieved, evidenceTurns);
        const rankedIds = run.retrieved.map(r => r.id);

        if (matchedIds.size === 0) {
            n_skipped++;
            continue;
        }
        n_scored++;

        for (const k of kValues) {
            const p = precisionAtK(matchedIds, rankedIds, k);
            if (!Number.isNaN(p)) {
                precisionSums[k] += p;
                precisionCounts[k]++;
            }
            const r = recallAtK(matchedIds, rankedIds, k);
            if (!Number.isNaN(r)) {
                recallSums[k] += r;
                recallCounts[k]++;
            }
        }
        const m = mrr(matchedIds, rankedIds);
        if (!Number.isNaN(m)) {
            mrrSum += m;
            mrrCount++;
        }
    }

    /** @type {Record<number, number>} */
    const precisionResult = {};
    /** @type {Record<number, number>} */
    const recallResult = {};
    for (const k of kValues) {
        precisionResult[k] = precisionCounts[k] > 0
            ? precisionSums[k] / precisionCounts[k]
            : NaN;
        recallResult[k] = recallCounts[k] > 0
            ? recallSums[k] / recallCounts[k]
            : NaN;
    }

    const result = {
        n: scorableRuns.length,
        n_scored,
        n_skipped,
        coverage: scorableRuns.length > 0 ? n_scored / scorableRuns.length : NaN,
        precisionAtK: precisionResult,
        recallAtK: recallResult,
        mrr: mrrCount > 0 ? mrrSum / mrrCount : NaN,
    };

    // Phase 12: per-task-type slice (only when at least one run has taskType)
    const hasTaskType = scorableRuns.some(r => typeof r.qa?.taskType === 'string');
    if (hasTaskType && !opts._suppressByTaskType) {
        const byType = new Map();
        for (const run of scorableRuns) {
            const tt = run.qa?.taskType || '__untyped__';
            if (!byType.has(tt)) byType.set(tt, []);
            byType.get(tt).push(run);
        }
        /** @type {Record<string, { mrr: number, coverage: number, n_scored: number, n_skipped: number }>} */
        const byTaskType = {};
        for (const [tt, bucket] of byType) {
            if (tt === '__untyped__') continue;
            const sliceMetrics = computeMetrics(bucket, { ...opts, _suppressByTaskType: true });
            byTaskType[tt] = {
                mrr: sliceMetrics.mrr,
                coverage: sliceMetrics.coverage,
                n_scored: sliceMetrics.n_scored,
                n_skipped: sliceMetrics.n_skipped,
            };
        }
        Object.assign(result, { byTaskType });
    }

    // Phase 12: abstention count (only when at least one abstention run exists)
    const abstentionRuns = runs.filter(r => r.qa?.abstention === true);
    if (abstentionRuns.length > 0) {
        Object.assign(result, { abstentionCount: abstentionRuns.length });
    }

    return result;
}
