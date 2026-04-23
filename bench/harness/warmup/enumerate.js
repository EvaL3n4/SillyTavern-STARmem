/**
 * Pure-function batch enumerator for warmup workflows.
 *
 * Reproduces the exact (model, messages, maxTokens) triples that STARmem's
 * consolidate() pipeline produces given a list of corpus items. Consumers
 * route the batches to either live extraction (Modal warmup) or batch-mode
 * submission (Fireworks Batch Inference) — the enumerator is substrate-
 * agnostic.
 *
 * Invariants preserved from bench/harness/_modal-warmup-point.js:
 *   1. Empty-turn filter matches seeder.js: !turn.text || turn.text.trim().length === 0
 *   2. BATCH_SIZE reads from CONSOLIDATION.BATCH_SIZE at call time (not destructured)
 *   3. messages shape matches renderExtractionPrompt({role: 'user', content: turn.text})
 *   4. customId equals extractionCache._cacheKey(model, messages, maxTokens)
 *
 * @module bench/harness/warmup/enumerate
 * @see docs/plans/phase-12-task-6-fireworks-batch.md Task 1
 */

import { renderExtractionPrompt } from '../../../src/consolidation/extractFacts.js';
import { _cacheKey } from '../extractionCache.js';

/**
 * @typedef {object} WarmupBatch
 * @property {string} customId
 * @property {string} model
 * @property {Array<{role: string, content: string}>} messages
 * @property {number} maxTokens
 * @property {string} itemId          - For diagnostics only; not part of the cache key.
 * @property {number} batchIdxInItem  - Index within the item's batch stream.
 */

/**
 * @typedef {object} EnumerateOptions
 * @property {string} model              - Canonical model string; hashed into customId.
 * @property {number} extractMaxTokens   - Max output tokens; hashed into customId.
 * @property {number} batchSize          - Turns per batch; e.g. CONSOLIDATION.BATCH_SIZE.
 */

/**
 * @param {Array<{id: string, turns: Array<{text: string}>}>} items
 * @param {EnumerateOptions} opts
 * @returns {WarmupBatch[]}
 */
export function enumerateWarmupBatches(items, opts) {
    if (!Array.isArray(items)) {
        throw new Error('enumerateWarmupBatches: items must be an array');
    }
    if (!opts || typeof opts !== 'object') {
        throw new Error('enumerateWarmupBatches: opts required');
    }
    const { model, extractMaxTokens, batchSize } = opts;
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error('enumerateWarmupBatches: opts.model must be a non-empty string');
    }
    if (!Number.isInteger(extractMaxTokens) || extractMaxTokens <= 0) {
        throw new Error('enumerateWarmupBatches: opts.extractMaxTokens must be a positive integer');
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error('enumerateWarmupBatches: opts.batchSize must be a positive integer');
    }

    /** @type {WarmupBatch[]} */
    const out = [];

    for (const item of items) {
        const nonEmpty = item.turns.filter(t => t.text && t.text.trim().length > 0);
        for (let i = 0; i < nonEmpty.length; i += batchSize) {
            const slice = nonEmpty.slice(i, i + batchSize);
            const messages = renderExtractionPrompt(
                slice.map(t => ({ role: 'user', content: t.text })),
            );
            const customId = _cacheKey(model, messages, extractMaxTokens);
            out.push({
                customId,
                model,
                messages,
                maxTokens: extractMaxTokens,
                itemId: item.id,
                batchIdxInItem: Math.floor(i / batchSize),
            });
        }
    }
    return out;
}
