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

/**
 * @typedef {import('./loaders/locomo.js').CorpusConversation} CorpusConversation
 * @typedef {import('./metrics/retrieval.js').MetricsResult} MetricsResult
 * @typedef {import('../src/retrieval/trace.js').Trace} Trace
 */

/**
 * @typedef {object} HarnessRun
 * @property {string} conversationId
 * @property {import('./loaders/locomo.js').QAItem} qa
 * @property {Array<{id: string, content: string, score: number, tier: number|string}>} retrieved
 * @property {Array<{turnIndex: number, text: string}>} goldTurns
 * @property {Trace[]} traces
 * @property {number} latencyMs
 * @property {{added: number, updated: number, drained: number, batches: number, factLengths: number[]}} consolidationStats
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
 * @returns {Promise<HarnessResult>}
 */
export async function runHarness({
    corpus,
    scorerId,
    overrides,
    chatIdPrefix,
    onProgress,
}) {
    const restore = overrides ? setConstantOverrides(overrides) : () => {};

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
                const result = retrieve(seededState, qa.question, { k: 10 });
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
                        score,
                        tier: result.tierResolved,
                    })),
                    goldTurns,
                    traces: [result.trace],
                    latencyMs,
                    consolidationStats,
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
            gitSha: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
        };

        return { runs, metrics, envSnapshot };
    } finally {
        restore();
        _resetBackendForTests();
        _resetLocksForTests();
    }
}
