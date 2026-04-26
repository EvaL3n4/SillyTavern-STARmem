/**
 * Benchmark harness orchestrator.
 *
 * Seeds STARmem from a corpus, replays QA queries through the public
 * retrieve() ladder, captures traces and latencies, and emits aggregated
 * metrics + an envSnapshot for reproducibility.
 *
 * @module bench/runner
 * @see docs/plans/phase-9-benchmarking.md §Task 3 Step 4
 */

import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
    RETRIEVAL,
    CONSOLIDATION,
    setConstantOverrides,
    resetConstantOverrides,
} from '../src/core/constants.js';
import { loadState, _resetBackendForTests } from '../src/core/state.js';
import { _resetLocksForTests } from '../src/core/lock.js';
import { getScorerId } from '../src/retrieval/scorer.js';
import { retrieve } from '../src/retrieval/ladder.js';
import { seedConversation } from './harness/seeder.js';
import { computeMetrics } from './metrics/retrieval.js';
import { traceRetrieve } from './harness/trace.js';

/**
 * Resolve the current commit SHA for envSnapshot reproducibility.
 *
 * Falls back through: STARMEM_BENCH_GIT_SHA env var, `git rev-parse HEAD`,
 * or the literal string 'unknown' if neither is available. Never throws —
 * a missing .git directory should not kill a baseline run (this happened
 * on 2026-04-24 when Modal's add_local_dir was configured to exclude .git
 * and execSync's spawn propagated the git error up through the harness).
 *
 * @returns {string}
 */
function resolveGitSha() {
    const fromEnv = process.env.STARMEM_BENCH_GIT_SHA;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    try {
        return execSync('git rev-parse HEAD', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return 'unknown';
    }
}

/**
 * @typedef {import('./loaders/locomo.js').CorpusConversation} CorpusConversation
 * @typedef {import('./metrics/retrieval.js').MetricsResult} MetricsResult
 * @typedef {import('../src/retrieval/trace.js').Trace} Trace
 */

/**
 * @typedef {object} HarnessRun
 * @property {string} conversationId
 * @property {import('./loaders/locomo.js').QAItem} qa
 * @property {Array<{id: string, content: string, sourceMessages: number[], score: number, tier: number|string}>} retrieved
 * @property {Array<{turnIndex: number, text: string}>} goldTurns
 * @property {Trace[]} traces
 * @property {number} latencyMs
 * @property {{added: number, updated: number, drained: number, batches: number, factLengths: number[]}} consolidationStats
 * @property {string} retrieverId
 */

/**
 * @typedef {object} HarnessResult
 * @property {HarnessRun[]} runs
 * @property {MetricsResult} metrics
 * @property {object} envSnapshot
 */

/**
 * Run the full benchmark harness over a corpus.
 *
 * @param {object} opts
 * @param {CorpusConversation[]} opts.corpus
 * @param {string} [opts.scorerId]
 * @param {Record<string, number>} [opts.overrides]
 * @param {string} [opts.chatIdPrefix]
 * @param {(pct: number) => void} [opts.onProgress]
 * @param {Function} [opts.retriever]
 * @returns {Promise<HarnessResult>}
 */
export async function runHarness({
    corpus,
    scorerId,
    overrides,
    chatIdPrefix,
    onProgress,
    retriever,
}) {
    const restore = overrides ? setConstantOverrides(overrides) : () => {};

    // [diag-task-7-cache-miss] Confirm setConstantOverrides actually
    // mutated CONSOLIDATION.BATCH_SIZE (the cache-key-bearing knob).
    // If this prints 5 instead of 15 when overrides=={BATCH_SIZE:15},
    // the override path is broken; if it prints 15 but cache still
    // misses, the divergence is downstream (prompt rendering, model
    // string, maxTokens). Remove once Phase 12 Task 7 is resolved.
    if (process.env.STARMEM_BENCH_DIAG === '1' || overrides) {
        console.error(`[diag] runHarness post-override: ` +
            `BATCH_SIZE=${CONSOLIDATION.BATCH_SIZE} ` +
            `TIER2_TAU_GAP=${RETRIEVAL.TIER2_TAU_GAP} ` +
            `overrides=${JSON.stringify(overrides ?? {})}`);
    }

    // Wrap the retriever once up-front. When Weave has been initialized
    // by the entry point (e.g. bench/baselines/_modal-point.js calling
    // initWeave('STARmem')), each call becomes a replayable W&B trace.
    // Otherwise the wrap is a no-op — traceRetrieve returns the original
    // function when Weave is not ready, so bench-side semantics never
    // change regardless of whether observability is active.
    const activeRetriever = traceRetrieve(
        retriever ?? retrieve,
        { name: retriever?.name ?? 'ladder' },
    );

    try {
        /** @type {HarnessRun[]} */
        const runs = [];

        for (let i = 0; i < corpus.length; i++) {
            const conv = corpus[i];

            const seedResult = await seedConversation(conv, { chatIdPrefix: chatIdPrefix ?? 'bench', keepBackend: true });
            const seededState = await loadState(seedResult.chatId);
            const consolidationStats = seedResult.consolidationStats;

            for (const qa of conv.qa) {
                const t0 = performance.now();
                // Weave's op() always returns a Promise, regardless of whether
                // the wrapped fn is sync. traceRetrieve passes through the
                // original (sync) fn when Weave is not initialized, but to
                // keep one code path here we await unconditionally. A synchronous
                // value passes through await cleanly (becomes Promise.resolve),
                // so this is safe in both no-op and traced modes.
                const result = await activeRetriever(seededState, qa.question, { k: 10 });
                const latencyMs = performance.now() - t0;

                const goldTurns = qa.evidenceTurns.map(ti => ({
                    turnIndex: ti,
                    text: conv.turns[ti]?.text ?? '',
                }));

                /** @type {number} */
                let score = 0;
                if (result.tierResolved === 2 || result.tierResolved === 3) {
                    const perTier = result.trace?.perTier?.[String(result.tierResolved)];
                    if (Array.isArray(perTier) && perTier.length > 0) {
                        // Use the first entry's score if available, else 0
                        score = perTier[0]?.score ?? 0;
                    }
                }

                runs.push({
                    conversationId: conv.id,
                    qa,
                    retrieved: result.entries.map(e => ({
                        id: e.id,
                        content: e.content ?? '',
                        sourceMessages: e.provenance?.sourceMessages ?? [],
                        score,
                        tier: result.tierResolved,
                    })),
                    goldTurns,
                    traces: [result.trace],
                    latencyMs,
                    consolidationStats,
                    retrieverId: retriever?.name ?? 'ladder',
                });
            }

            if (onProgress) {
                onProgress((i + 1) / corpus.length);
            }
        }

        const metrics = computeMetrics(runs);

        const envSnapshot = {
            constants: { ...RETRIEVAL, ...CONSOLIDATION },
            scorerId: scorerId ?? getScorerId(),
            nodeVersion: process.version,
            gitSha: resolveGitSha(),
        };

        return { runs, metrics, envSnapshot };
    } finally {
        restore();
        _resetBackendForTests();
        _resetLocksForTests();
    }
}
