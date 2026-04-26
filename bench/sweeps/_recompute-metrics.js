#!/usr/bin/env node
/**
 * Recompute metrics from a runs[] array. Reads {runs: [...]} as JSON
 * from stdin, calls computeMetrics + aggregateConsolidationStats, and
 * prints {metrics, aggStats} as JSON to stdout.
 *
 * Used by run_sweep's per-cell aggregator (Phase 13 Task 3) to recompute
 * metrics ONCE on concatenated runs[] across chunks for a cell, instead
 * of merging per-chunk metric values.
 *
 * @module bench/sweeps/_recompute-metrics
 */

import { computeMetrics } from '../metrics/index.js';

const _origLog = console.log;
console.log = (...args) => console.error(...args);

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

export async function runFromStdin(stdin) {
    let buf = '';
    for await (const chunk of stdin) buf += chunk;
    const { runs } = JSON.parse(buf);
    if (!Array.isArray(runs)) {
        throw new Error(`_recompute-metrics: expected {runs: [...]}, got: ${typeof runs}`);
    }
    const metrics = computeMetrics(runs);
    const aggStats = aggregateConsolidationStats(runs);
    _origLog(JSON.stringify({ metrics, aggStats }));
}
