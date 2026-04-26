#!/usr/bin/env node
/**
 * Per-chunk sweep-point runner for Modal item-fan-out dispatch.
 *
 * Reads overrides from STARMEM_OVERRIDES (JSON), the corpus name from
 * STARMEM_BENCH_CORPUS, and an item-index list from STARMEM_ITEM_INDICES
 * (JSON array of integers). Loads the corpus, slices by the indices,
 * runs runHarness, and prints a JSON payload to stdout.
 *
 * Identical to _modal-point.js except for:
 *   - reads STARMEM_ITEM_INDICES and slices the corpus
 *   - payload includes itemIndices (echoed) so the aggregator can verify
 *     coverage ("did every dispatched chunk return?")
 *
 * Cell-level aggregation happens in run_sweep (Python side): concat all
 * runs[] across chunks for a cell, recompute metrics once.
 *
 * @module bench/sweeps/_modal-chunk
 */

import { runHarness } from '../runner.js';
import { getAdapter } from '../corpora/index.js';
import { performance } from 'node:perf_hooks';

// Route harness log output to stderr so stdout is reserved for the
// single-line JSON payload that run_sweep will json.loads().
const _origLog = console.log;
console.log = (...args) => console.error(...args);

/**
 * Aggregate per-run consolidation stats. Identical to _modal-point.js;
 * dedups by conversationId. For LongMemEval-S (each item = unique convo)
 * dedup is a no-op; for LoCoMo it would matter, but Phase 13's chunking
 * heuristic (items // 80) means LoCoMo always runs as 1 chunk = identical
 * to the old run_point shape, so this code path stays as a no-op for
 * LongMemEval and never fires for LoCoMo through this entry.
 */
function aggregateConsolidationStats(runs) {
    if (!runs || runs.length === 0) return null;
    if (!runs[0]?.consolidationStats) return null;

    const seen = new Set();
    const totals = { added: 0, updated: 0, drained: 0, batches: 0, parseFailures: 0, entriesSkipped: 0 };
    for (const run of runs) {
        if (seen.has(run.conversationId)) continue;
        seen.add(run.conversationId);
        const cs = run.consolidationStats || {};
        totals.added         += cs.added         || 0;
        totals.updated       += cs.updated       || 0;
        totals.drained       += cs.drained       || 0;
        totals.batches       += cs.batches       || 0;
        totals.parseFailures += cs.parseFailures || 0;
        totals.entriesSkipped += cs.entriesSkipped || 0;
    }
    const updateRate     = totals.updated / Math.max(1, totals.added + totals.updated);
    const dedupHitRate   = totals.updated / Math.max(1, totals.drained);
    const parseFailRate  = totals.parseFailures / Math.max(1, totals.batches);
    const entrySkipRate  = totals.entriesSkipped / Math.max(1, totals.added + totals.updated + totals.entriesSkipped);
    return { ...totals, updateRate, dedupHitRate, parseFailRate, entrySkipRate };
}

async function main() {
    const overrides = JSON.parse(process.env.STARMEM_OVERRIDES || '{}');
    const corpusName = process.env.STARMEM_BENCH_CORPUS ?? 'longmemeval-s';
    const itemIndicesRaw = process.env.STARMEM_ITEM_INDICES;
    if (!itemIndicesRaw) {
        throw new Error('_modal-chunk.js requires STARMEM_ITEM_INDICES env (JSON array of item indices). For full-corpus runs, use _modal-point.js.');
    }
    const itemIndices = JSON.parse(itemIndicesRaw);
    if (!Array.isArray(itemIndices) || itemIndices.length === 0) {
        throw new Error(`STARMEM_ITEM_INDICES must be a non-empty JSON array; got: ${itemIndicesRaw}`);
    }

    console.error(`[diag] _modal-chunk env: corpus=${corpusName} ` +
        `model=${process.env.STARMEM_BENCH_LLM_MODEL ?? '<unset>'} ` +
        `overrides=${JSON.stringify(overrides)} ` +
        `itemIndices=[${itemIndices[0]}..${itemIndices[itemIndices.length - 1]}] (n=${itemIndices.length})`);

    const adapter = getAdapter(corpusName);
    const fullCorpus = await adapter.loadConversations({ offline: true });

    // Slice by indices. Out-of-range indices are surfaced loudly — they
    // indicate either a stale chunk plan or a corpus-size mismatch.
    const corpus = [];
    const missingIndices = [];
    for (const idx of itemIndices) {
        if (idx < 0 || idx >= fullCorpus.length) {
            missingIndices.push(idx);
            continue;
        }
        corpus.push(fullCorpus[idx]);
    }
    if (missingIndices.length > 0) {
        throw new Error(`STARMEM_ITEM_INDICES contains ${missingIndices.length} out-of-range indices (corpus size = ${fullCorpus.length}); first 5: ${missingIndices.slice(0, 5).join(',')}`);
    }

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

    // Phase 13: emit raw runs[] alongside per-chunk metrics. Cell aggregator
    // (run_sweep Python side) concatenates runs[] across chunks and recomputes
    // metrics ONCE per cell. Per-chunk metrics are advisory — useful for
    // streaming progress views and for the "does per-chunk wall-clock
    // correlate with item-index range?" Phase 14 candidate.
    const output = {
        overrides,
        itemIndices,                              // echoed for aggregator coverage check
        runs: result.runs,                        // raw runs for cell-level recompute
        metrics: result.metrics,                  // per-chunk advisory metrics
        latencyMs,
        runCount: result.runs.length,
        wallMs: Math.round(wallMs),
        aggStats: aggregateConsolidationStats(result.runs),
    };
    _origLog(JSON.stringify(output));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
