/**
 * Modal entry point: run ONE conversation × ONE BATCH_SIZE value.
 *
 * Invoked by bench/modal/sweep_app.py::run_batchsize_point via subprocess.
 * Reads STARMEM_CONV_IDX and STARMEM_BATCH_SIZE env vars.
 * Prints JSON: { convIdx, batchSize, metrics, consolidationStats, latencyMs, wallMs }.
 *
 * Conversation-level splitting (9.5 → Phase 11 redesign): each container
 * does one (conv, BATCH_SIZE) cell so the 600s timeout comfortably covers
 * the 100%-cache-miss extraction load per cell.
 *
 * @module bench/sweeps/_modal-batchsize-point
 * @see docs/plans/phase-11-infrastructure-hardening.md Task 6
 */
import { performance } from 'node:perf_hooks';
import { runHarness } from '../runner.js';
import { getAdapter } from '../corpora/index.js';

async function main() {
    const convIdx = parseInt(process.env.STARMEM_CONV_IDX ?? '', 10);
    const batchSize = parseInt(process.env.STARMEM_BATCH_SIZE ?? '', 10);
    if (!Number.isFinite(convIdx) || !Number.isFinite(batchSize)) {
        console.error(`Bad env: STARMEM_CONV_IDX=${process.env.STARMEM_CONV_IDX} STARMEM_BATCH_SIZE=${process.env.STARMEM_BATCH_SIZE}`);
        process.exit(2);
    }

    // Redirect console.log to stderr to keep stdout clean for JSON (same pattern
    // as bench/sweeps/_modal-point.js and bench/baselines/_modal-point.js).
    const _origLog = console.log;
    console.log = (...args) => console.error(...args);

    const corpusName = process.env.STARMEM_BENCH_CORPUS ?? 'locomo';
    const adapter = getAdapter(corpusName);
    const fullCorpus = await adapter.loadConversations({ offline: true });
    const conv = fullCorpus[convIdx];
    if (!conv) {
        console.error(`convIdx ${convIdx} out of range (corpus size ${fullCorpus.length})`);
        process.exit(2);
    }

    const wallT0 = performance.now();
    const { runs, metrics } = await runHarness({
        corpus: [conv],
        overrides: { BATCH_SIZE: batchSize },
        chatIdPrefix: `bench-bs${batchSize}-c${convIdx}`,
    });
    const wallMs = performance.now() - wallT0;

    const consolidationStats = runs[0]?.consolidationStats ?? null;
    const latencyMs = runs.length > 0
        ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length
        : 0;

    _origLog(JSON.stringify({
        convIdx,
        batchSize,
        metrics,
        consolidationStats,
        latencyMs,
        wallMs,
    }, null, 2));
}

main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
});
