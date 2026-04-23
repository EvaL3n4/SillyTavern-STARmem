/**
 * Warmup point for LongMemEval-S extraction cache.
 *
 * Reads one item by index, runs seedConversation with the live extractor
 * enabled, and emits seed stats. Meant to be fanned out via
 * run_longmemeval_warmup_point.map(range(500)) so Modal parallelizes
 * the first-pass live-LLM cost across 32 free-tier containers.
 *
 * Mirrors bench/baselines/_modal-point.js's stderr-redirect pattern so
 * stdout stays pure JSON for the Python-side json.loads().
 *
 * Env (enforced):
 *   STARMEM_BENCH_CORPUS=longmemeval-s
 *   STARMEM_WARMUP_ITEM_IDX=<int>  (0-indexed into the post-flatten corpus)
 *   STARMEM_BENCH_LIVE_EXTRACTOR=1  (without this, seedConversation's
 *     _resolveExtractor() falls back to rule-based and the cache stays cold)
 *   STARMEM_BENCH_LLM_URL, STARMEM_BENCH_API_KEY, STARMEM_BENCH_LLM_MODEL
 *     (supplied by the env_secret Modal Secret, same as run_baseline_point)
 *
 * @module bench/harness/_modal-warmup-point
 * @see docs/plans/phase-12-multi-corpus.md Task 6 Pre-step
 */
import { getAdapter } from '../corpora/index.js';
import { seedConversation } from './seeder.js';

const corpusName = process.env.STARMEM_BENCH_CORPUS;
const itemIdx = Number(process.env.STARMEM_WARMUP_ITEM_IDX);

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

// Route all harness log output to stderr so stdout is reserved for the
// JSON payload that run_longmemeval_warmup_point will json.loads().
const _origLog = console.log;
console.log = (...args) => console.error(...args);

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
// Print item shape upfront so Modal's live log shows whether this item
// is abnormally large vs the plan's ~20-turn estimate. Item 0 timed
// out at 600s on first smoke (2026-04-23); visibility here makes the
// next tier of triage fast.
console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} item loaded: turns=${item.turns.length} qa=${item.qa?.length ?? 0}`);
console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} starting seedConversation (live extraction)...`);

const tSeedStart = Date.now();
const seedResult = await seedConversation(item, {
    chatIdPrefix: `warmup-lme-${itemIdx}`,
    keepBackend: false,  // discard state; we only care about cache side-effects
});
const tSeedMs = Date.now() - tSeedStart;

console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} seedConversation done in ${tSeedMs}ms — facts=${seedResult.factCount} turns=${seedResult.turnsProcessed} batches=${seedResult.consolidationStats.batches}`);

const wallMs = Date.now() - t0;

_origLog(JSON.stringify({
    itemIdx,
    itemTurns: item.turns.length,
    factCount: seedResult.factCount,
    turnsProcessed: seedResult.turnsProcessed,
    consolidationStats: seedResult.consolidationStats,
    seedMs: tSeedMs,
    wallMs,
}));
