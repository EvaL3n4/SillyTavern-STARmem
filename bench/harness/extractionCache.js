/**
 * On-disk cache for live-LLM extractions. Keys each call by
 * sha256((model, messages, maxTokens)) — temperature is always 0, so it
 * doesn't need to be in the key.
 *
 * Cache semantics:
 *   - Miss: call inner, write `{model, maxTokens, response, at}` as JSON.
 *   - Hit: read file, return `.response`.
 *   - Corrupt file (JSON parse fails): fall through to inner, overwrite.
 *   - disabled=true: no reads, no writes, always call inner.
 *
 * Writes are best-effort: if the write fails, log once and continue
 * (the benchmark is still correct, just uncached). Reads that succeed
 * but return malformed content are treated as corrupt.
 *
 * @module bench/harness/extractionCache
 * @see docs/plans/phase-9-5-live-extraction.md Task 2
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Deterministic cache key.
 *
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} maxTokens
 * @returns {string} hex sha256
 */
export function _cacheKey(model, messages, maxTokens) {
    const h = createHash('sha256');
    h.update(model);
    h.update('\x00');
    h.update(JSON.stringify(messages));
    h.update('\x00');
    h.update(String(maxTokens));
    return h.digest('hex');
}

/**
 * Wrap an inner LLM client with on-disk memoization.
 *
 * @param {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>} inner
 * @param {object} opts
 * @param {string} opts.dir            - Cache directory (created on demand).
 * @param {string} opts.model          - Model identifier for the cache key.
 * @param {boolean} [opts.disabled]    - If true, bypass entirely.
 * @returns {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>}
 */
export function wrapWithCache(inner, opts) {
    const { dir, model, disabled = false } = opts;

    if (disabled) {
        return inner;
    }

    return async function cachedExtractor(profileId, messages, maxTokens) {
        const key = _cacheKey(model, messages, maxTokens);
        const file = path.join(dir, `${key}.json`);

        try {
            const raw = await readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed?.response === 'string') {
                return parsed.response;
            }
        } catch {
            // miss or corrupt — fall through
        }

        const response = await inner(profileId, messages, maxTokens);

        try {
            await mkdir(dir, { recursive: true });
            await writeFile(
                file,
                JSON.stringify({
                    model,
                    maxTokens,
                    response,
                    at: new Date().toISOString(),
                }, null, 2),
                'utf8',
            );
        } catch (err) {
            // Best-effort write; surface once but don't fail the bench.
            // eslint-disable-next-line no-console
            console.warn(`extractionCache: write failed for ${key}: ${err.message}`);
        }

        return response;
    };
}
