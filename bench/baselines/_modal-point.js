/**
 * Modal entry point: run one baseline retriever over full corpus.
 *
 * Invoked by bench/modal/sweep_app.py::run_baseline_point via subprocess.
 * Reads STARMEM_RETRIEVER_ID env var ∈ BASELINE_IDS.
 * Prints JSON: { retrieverId, metrics, latencyMs, runCount, wallMs, envSnapshot }.
 *
 * Mirrors bench/sweeps/_modal-point.js but parameterizes on retriever,
 * not overrides.
 *
 * @module bench/baselines/_modal-point
 * @see docs/plans/phase-11-infrastructure-hardening.md Task 3
 */
import { performance } from 'node:perf_hooks';
import { runHarness } from '../runner.js';
import { getAdapter } from '../corpora/index.js';
import { bm25only } from './bm25only.js';
import { recency } from './recency.js';
import { random } from './random.js';
import { BASELINE_IDS } from './index.js';

// Route all harness log output to stderr so stdout is reserved for the
// JSON payload that Modal's run_baseline_point will json.loads().
const _origLog = console.log;
console.log = (...args) => console.error(...args);

const RETRIEVERS = {
    ladder: undefined,   // runHarness uses the real ladder when retriever is undefined
    bm25only,
    recency,
    random,
};

async function main() {
    const retrieverId = process.env.STARMEM_RETRIEVER_ID;
    if (!retrieverId || !BASELINE_IDS.includes(retrieverId)) {
        console.error(`Unknown STARMEM_RETRIEVER_ID: ${retrieverId}. Expected one of ${BASELINE_IDS.join(', ')}`);
        process.exit(2);
    }
    const retriever = RETRIEVERS[retrieverId];

    const corpusName = process.env.STARMEM_BENCH_CORPUS ?? 'locomo';
    const adapter = getAdapter(corpusName);
    let corpus = await adapter.loadConversations({ offline: true });

    // Stratified subset filter. When run_baselines passes
    // STARMEM_SAMPLE_INDICES_JSON, keep only those items. Must run
    // after adapter load because indices are into the post-flatten
    // corpus (Phase 12 Decision 8: LongMemEval-S is flattened to one
    // single-session item per question_id, preserving the 500-item
    // count). Invalid indices throw early rather than silently dropping.
    const sampleIndicesJson = process.env.STARMEM_SAMPLE_INDICES_JSON;
    if (sampleIndicesJson) {
        let indices;
        try {
            indices = JSON.parse(sampleIndicesJson);
        } catch (err) {
            console.error(`STARMEM_SAMPLE_INDICES_JSON is not valid JSON: ${err.message}`);
            process.exit(2);
        }
        if (!Array.isArray(indices) || !indices.every(i => Number.isInteger(i) && i >= 0)) {
            console.error(`STARMEM_SAMPLE_INDICES_JSON must be an array of non-negative integers`);
            process.exit(2);
        }
        const outOfRange = indices.find(i => i >= corpus.length);
        if (outOfRange !== undefined) {
            console.error(`STARMEM_SAMPLE_INDICES_JSON contains idx=${outOfRange} but corpus has only ${corpus.length} items`);
            process.exit(3);
        }
        corpus = indices.map(i => corpus[i]);
        console.error(`[${retrieverId}] filtered corpus to ${corpus.length} stratified items (of original ${indices.length} requested)`);
    }

    const wallT0 = performance.now();
    const { runs, metrics, envSnapshot } = await runHarness({
        corpus,
        retriever,
        chatIdPrefix: `bench-${retrieverId}`,
    });
    const wallMs = performance.now() - wallT0;

    const latencyMs = runs.length > 0
        ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length
        : 0;

    _origLog(JSON.stringify({
        retrieverId,
        metrics,
        latencyMs,
        runCount: runs.length,
        wallMs: Math.round(wallMs),
        envSnapshot,
    }));
}

main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
});
