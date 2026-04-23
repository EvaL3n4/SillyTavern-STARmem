#!/usr/bin/env node
/**
 * Single sweep-point runner for Modal dispatch.
 *
 * Reads overrides from STARMEM_OVERRIDES (JSON string), loads the LoCoMo
 * corpus from the warm cache, runs runHarness, and prints a JSON payload
 * to stdout.
 *
 * @module bench/sweeps/_modal-point
 */

import { runHarness } from '../runner.js';
import { getAdapter } from '../corpora/index.js';
import { performance } from 'node:perf_hooks';

// Route all harness log output to stderr so stdout is reserved for the
// single-line JSON payload that Modal's run_sweep will json.loads().
// Without this, STARmem's internal loggers ([STARmem:triggers] ...) leak
// into stdout and corrupt the payload for run_sweep's parser.
const _origLog = console.log;
console.log = (...args) => console.error(...args);

/**
 * Aggregate per-run consolidation stats across a harness result.
 *
 * Dedups by conversationId — runHarness emits one run per QA item,
 * many sharing a conversation, and each conversation's consolidationStats
 * should only be counted once (the seeder produced the same consolidation
 * trace regardless of which QA we're scoring on that conversation).
 *
 * Matches bench/sweeps/consolidation.js:137-158 precisely so the Modal
 * path and local path produce identical aggStats.
 *
 * @param {Array<{conversationId: string, consolidationStats?: object}>} runs
 * @returns {object | null} null when runs lack consolidationStats
 *   (tau/bm25 paths don't surface it); object with totals + derived
 *   rates when present (consolidation sweep path).
 */
function aggregateConsolidationStats(runs) {
    if (!runs || runs.length === 0) return null;
    // Sample first run's shape to decide whether to aggregate at all.
    if (!runs[0]?.consolidationStats) return null;

    const seen = new Set();
    const totals = { added: 0, updated: 0, drained: 0, batches: 0 };
    for (const run of runs) {
        if (seen.has(run.conversationId)) continue;
        seen.add(run.conversationId);
        const cs = run.consolidationStats || {};
        totals.added   += cs.added   || 0;
        totals.updated += cs.updated || 0;
        totals.drained += cs.drained || 0;
        totals.batches += cs.batches || 0;
    }
    const updateRate   = totals.updated / Math.max(1, totals.added + totals.updated);
    const dedupHitRate = totals.updated / Math.max(1, totals.drained);
    return { ...totals, updateRate, dedupHitRate };
}

async function main() {
    const overrides = JSON.parse(process.env.STARMEM_OVERRIDES || '{}');
    const corpusName = process.env.STARMEM_BENCH_CORPUS ?? 'locomo';
    const adapter = getAdapter(corpusName);
    const corpus = await adapter.loadConversations({ offline: true });

    const t0 = performance.now();
    const result = await runHarness({ corpus, overrides });
    const wallMs = performance.now() - t0;

    const latencies = result.runs.map(r => r.latencyMs);
    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const latencyMs = {
        p50: n > 0 ? sorted[Math.floor((n - 1) * 0.5)] : 0,
        p95: n > 0 ? sorted[Math.floor((n - 1) * 0.95)] : 0,
    };

    const output = {
        overrides,
        metrics: result.metrics,
        latencyMs,
        runCount: result.runs.length,
        wallMs: Math.round(wallMs),
        // 9.4.9 — aggStats is null for tau/bm25 paths (runs lack
        // consolidationStats); populated for consolidation sweep.
        // render_consolidation_report_stub tolerates both shapes.
        aggStats: aggregateConsolidationStats(result.runs),
    };
    // Use the original console.log (straight to stdout) for the payload.
    _origLog(JSON.stringify(output));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
