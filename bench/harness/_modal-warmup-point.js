/**
 * Warmup point for the LongMemEval-S extraction cache.
 *
 * Design (Phase 12 Task 6, Design A — parallel cache prewarming):
 *
 * The serial `seedConversation` path is O(turns) per item because
 * `maybeConsolidate` fires a sequential extractFacts call every BATCH_SIZE
 * turns (spec §6.3). For LongMemEval-S's 400–800-turn items that means
 * ~80–160 sequential LLM hops per item — blowing Modal's 1800s per-cell
 * budget.
 *
 * This warmup bypasses the state pipeline entirely. It reproduces the
 * exact (model, messages, maxTokens) triples that `consolidate()` would
 * produce given the item's filtered turn stream, and memoizes their LLM
 * responses into the same on-disk cache `wrapWithCache` writes to. When
 * baselines later run, `seedConversation`'s real `consolidate()` path
 * hits a warm cache on every call and returns in microseconds.
 *
 * Correctness contract — how this stays in sync with production:
 *
 *   1. `renderExtractionPrompt` + `EXTRACT_MAX_TOKENS` are imported from
 *      the real `src/consolidation/extractFacts.js`. If anyone edits the
 *      system prompt, the transcript format, or the token budget, the
 *      warmup follows automatically. Worst-case drift means stale cache
 *      entries miss cleanly — slow, not wrong.
 *
 *   2. The empty-turn filter matches `bench/harness/seeder.js:223`
 *      byte-for-byte: `!turn.text || turn.text.trim().length === 0`.
 *
 *   3. `BATCH_SIZE` is read from `CONSOLIDATION` at call time (not
 *      destructured at module top), so `setConstantOverrides` sweeps
 *      from Phase 9.4.9 are observed and the warmup targets the same
 *      keys the sweep will look up.
 *
 *   4. Each batch is rendered as `{role: 'user', content: turn.text}[]`,
 *      matching the `messageOf` callback `seeder.js:233` passes into
 *      `consolidate`.
 *
 * Parallelism via `concurrencyLimit(K)` at `STARMEM_WARMUP_CONCURRENCY`
 * (default 16). Nano-GPT tolerates unbounded concurrent calls, so K is
 * bounded only by per-item RAM and per-container socket ceiling.
 *
 * Env (enforced):
 *   STARMEM_BENCH_CORPUS=longmemeval-s
 *   STARMEM_WARMUP_ITEM_IDX=<int>  (0-indexed into the post-flatten corpus)
 *   STARMEM_BENCH_LIVE_EXTRACTOR=1
 *   STARMEM_BENCH_LLM_URL / STARMEM_BENCH_LLM_API_KEY / STARMEM_BENCH_LLM_MODEL
 *
 * Optional:
 *   STARMEM_WARMUP_CONCURRENCY=<int>  (default 16)
 *
 * @module bench/harness/_modal-warmup-point
 * @see docs/plans/phase-12-multi-corpus.md Task 6
 * @see docs/plans/phase-12-task-6-extraction-cost-decision.md
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from '../corpora/index.js';
import { EXTRACT_MAX_TOKENS } from '../../src/consolidation/extractFacts.js';
import { enumerateWarmupBatches } from './warmup/enumerate.js';
import { CONSOLIDATION, setConstantOverrides } from '../../src/core/constants.js';
import { wrapWithCache } from './extractionCache.js';
import { makeLLMExtractor } from './llmExtractor.js';
import { concurrencyLimit } from './concurrencyLimit.js';
import { applyBatchSizeOverride } from './warmup/applyBatchSizeOverride.js';

const corpusName = process.env.STARMEM_BENCH_CORPUS;
const itemIdx = Number(process.env.STARMEM_WARMUP_ITEM_IDX);
const K = Number(process.env.STARMEM_WARMUP_CONCURRENCY ?? '16');

if (corpusName !== 'longmemeval-s') {
    console.error(`warmup-point requires STARMEM_BENCH_CORPUS=longmemeval-s, got '${corpusName}'`);
    process.exit(2);
}
if (!Number.isInteger(itemIdx) || itemIdx < 0) {
    console.error(`warmup-point requires STARMEM_WARMUP_ITEM_IDX as non-negative integer, got '${process.env.STARMEM_WARMUP_ITEM_IDX}'`);
    process.exit(2);
}
if (process.env.STARMEM_BENCH_LIVE_EXTRACTOR !== '1') {
    console.error(`warmup requires STARMEM_BENCH_LIVE_EXTRACTOR=1 to populate the extraction cache; rule-based fallback would no-op`);
    process.exit(2);
}
if (!Number.isInteger(K) || K < 1) {
    console.error(`STARMEM_WARMUP_CONCURRENCY must be a positive integer, got '${process.env.STARMEM_WARMUP_CONCURRENCY}'`);
    process.exit(2);
}

// Route all harness log output to stderr so stdout is reserved for the
// JSON payload that run_longmemeval_warmup_point will json.loads().
const _origLog = console.log;
console.log = (...args) => console.error(...args);

const DEFAULT_CACHE_DIR = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'extractions',
);

const t0 = Date.now();

const adapter = getAdapter(corpusName);
console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} loading adapter...`);
const items = await adapter.loadConversations({ offline: true });
console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} adapter loaded (${items.length} items total)`);

if (itemIdx >= items.length) {
    console.error(`STARMEM_WARMUP_ITEM_IDX ${itemIdx} out of range (corpus has ${items.length} items)`);
    process.exit(3);
}

const item = items[itemIdx];

// Exact predicate match with bench/harness/seeder.js:223–225. If this
// drifts, cache keys drift and the warmup is wasted — so don't let it.
const nonEmpty = item.turns.filter(t => t.text && t.text.trim().length > 0);

// BATCH_SIZE override — when STARMEM_BATCH_SIZE is set, apply via
// setConstantOverrides BEFORE reading CONSOLIDATION.BATCH_SIZE below.
// This is the cache-key-alignment hook for Phase 12 Task 6.5: the
// vllm_warmup pre-warming pass enumerated batches at BS=15, and the
// existing live read path keys cache lookups on the (model, messages,
// maxTokens) triple — so this re-extraction warmup MUST run at BS=15
// too. Without this hook, `misses` jumps from 0 to ~100% (caught
// 2026-04-25 on the first regression-check attempt).
//
// Validation lives in the pure helper so the failure modes (invalid
// envvar shape, off-by-one zero, fractional) are unit-tested without
// dragging in this entry script's top-level await.
applyBatchSizeOverride(process.env.STARMEM_BATCH_SIZE, setConstantOverrides);

// BATCH_SIZE read at call time (not destructured at module top) so a
// runtime setConstantOverrides() sweep is observed. See phase-9-4-9
// swept-constants pattern + tests/unit/core/swept-constants-overridable.
const { BATCH_SIZE } = CONSOLIDATION;

const model = process.env.STARMEM_BENCH_LLM_MODEL;

const batches = enumerateWarmupBatches([item], {
    model,
    extractMaxTokens: EXTRACT_MAX_TOKENS,
    batchSize: BATCH_SIZE,
});

console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} item loaded: turns=${item.turns.length} nonEmpty=${nonEmpty.length} batches=${batches.length} (BATCH_SIZE=${BATCH_SIZE})`);
console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} starting parallel extraction (K=${K})...`);

const llmUrl = process.env.STARMEM_BENCH_LLM_URL;
const inner = makeLLMExtractor({
    url: llmUrl,
    apiKey: process.env.STARMEM_BENCH_LLM_API_KEY,
    model,
});
const stats = { hits: 0, misses: 0 };
const cachedExtractor = wrapWithCache(inner, { dir: DEFAULT_CACHE_DIR, model, stats });

// Provenance: prove to the operator (and to post-mortem logs) exactly
// which model+URL the subprocess resolved from the injected env. Strip
// any embedded credentials from the URL display — host+path only.
let urlHost = '';
try {
    const u = new URL(llmUrl ?? '');
    urlHost = `${u.host}${u.pathname}`;
} catch {
    urlHost = '<unparseable>';
}
console.error(`[warmup item=${itemIdx}] model=${model} url=${urlHost}`);

const limit = concurrencyLimit(K);
const tExtractStart = Date.now();

/** @type {Array<{batchIdx: number, error: string, name?: string, code?: string}>} */
const failures = [];
/** @type {null | {name: string, message: string, code?: string, cause?: unknown, stack?: string}} */
let firstErrorDump = null;
await Promise.all(batches.map((batch, bIdx) => limit(async () => {
    try {
        await cachedExtractor('warmup', batch.messages, batch.maxTokens);
    } catch (err) {
        const e = /** @type {any} */ (err);
        // Log every failure to stderr the moment it lands, so Modal's
        // live function-log stream shows them instead of burying the
        // info in the per-item JSON payload. Keeps one-line tail noise
        // manageable while making all-batch-failure smokes diagnosable
        // without extra round trips.
        console.error(
            `[warmup item=${itemIdx} batch=${bIdx}] FAILED: ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}` +
            (e?.code ? ` (code=${e.code})` : ''),
        );
        // Dump the first failure in full — stack + cause. Gives us
        // network-level detail (fetch DNS/TLS/reset) without flooding
        // the log when the whole batch is failing identically.
        if (firstErrorDump === null) {
            firstErrorDump = {
                name: e?.name ?? 'Error',
                message: e?.message ?? String(err),
                code: e?.code,
                cause: e?.cause ? String(e.cause) : undefined,
                stack: e?.stack,
            };
            console.error(`[warmup item=${itemIdx} batch=${bIdx}] first-error detail:\n${e?.stack ?? '(no stack)'}`);
            if (e?.cause) {
                console.error(`[warmup item=${itemIdx} batch=${bIdx}] first-error cause: ${String(e.cause)}`);
            }
        }
        failures.push({
            batchIdx: bIdx,
            error: e?.message ?? String(err),
            name: e?.name,
            code: e?.code,
        });
    }
})));

const tExtractMs = Date.now() - tExtractStart;
const wallMs = Date.now() - t0;

console.error(
    `[warmup item=${itemIdx}] ${new Date().toISOString()} done in ${tExtractMs}ms ` +
    `— hits=${stats.hits} misses=${stats.misses} failures=${failures.length}/${batches.length}` +
    (failures.length === batches.length && batches.length > 0
        ? ` ALL-FAILED (firstError: ${firstErrorDump?.name}: ${firstErrorDump?.message?.slice(0, 200)})`
        : ''),
);

// Emit the JSON payload on stdout for json.loads() in the Python orchestrator.
_origLog(JSON.stringify({
    itemIdx,
    itemTurns: item.turns.length,
    nonEmptyTurns: nonEmpty.length,
    batchCount: batches.length,
    batchSize: BATCH_SIZE,
    concurrency: K,
    modelResolved: model,
    urlHost,
    hits: stats.hits,
    misses: stats.misses,
    failureCount: failures.length,
    allFailed: failures.length === batches.length && batches.length > 0,
    firstError: firstErrorDump,
    failures: failures.slice(0, 5),  // sample; full list would flood the summary
    extractMs: tExtractMs,
    wallMs,
}));
