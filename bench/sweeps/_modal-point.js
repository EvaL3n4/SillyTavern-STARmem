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

// Route all harness log output to stderr so stdout is reserved for the
// single-line JSON payload that Modal's run_sweep will json.loads().
// Without this, STARmem's internal loggers ([STARmem:triggers] ...) leak
// into stdout and corrupt the payload for run_sweep's parser.
const _origLog = console.log;
console.log = (...args) => console.error(...args);

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
    // Use the original console.log (straight to stdout) for the payload.
    _origLog(JSON.stringify(output));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
