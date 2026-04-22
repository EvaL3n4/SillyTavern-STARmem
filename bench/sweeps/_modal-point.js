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
import { loadLocomo } from '../loaders/index.js';
import { performance } from 'node:perf_hooks';

async function main() {
    const overrides = JSON.parse(process.env.STARMEM_OVERRIDES || '{}');
    const corpus = await loadLocomo({ offline: true });

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
    };
    console.log(JSON.stringify(output));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
