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
 * Optionally accepts a shared `stats` counter (`{hits, misses}`). The
 * returned closure increments `stats.hits` on a cache hit and
 * `stats.misses` on a miss. Counters are process-local and unsynchronised —
 * safe under Node's single-threaded event loop, where `hits++` compiles
 * to a non-preemptible read-modify-write on a primitive integer. Passing
 * `stats` is strictly opt-in; omitting it keeps the closure a zero-cost
 * pass-through identical to the pre-Phase-12 behavior.
 *
 * Added for the Phase 12 LongMemEval warmup: attribution in warmup
 * reports needed hit/miss accounting without a per-batch fs.stat probe.
 *
 * @param {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>} inner
 * @param {object} opts
 * @param {string} opts.dir            - Cache directory (created on demand).
 * @param {string} opts.model          - Model identifier for the cache key.
 * @param {boolean} [opts.disabled]    - If true, bypass entirely.
 * @param {{hits: number, misses: number}} [opts.stats]
 *     - Optional shared counter. Mutated in place; caller reads when done.
 * @returns {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>}
 */
export function wrapWithCache(inner, opts) {
    const { dir, model, disabled = false, stats } = opts;

    if (disabled) {
        return inner;
    }

    // [diag-task-7-cache-miss] Log first cache miss with full key inputs,
    // then list a sample of files in `dir` so we can compare against the
    // expected key. Localizes drift between warmup-write and sweep-read.
    // Remove once Phase 12 Task 7 is resolved.
    let _diagLogged = false;

    return async function cachedExtractor(profileId, messages, maxTokens) {
        const key = _cacheKey(model, messages, maxTokens);
        const file = path.join(dir, `${key}.json`);

        try {
            const raw = await readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed?.response === 'string') {
                if (stats) stats.hits = (stats.hits ?? 0) + 1;
                return parsed.response;
            }
        } catch {
            // miss or corrupt — fall through
        }

        if (stats) stats.misses = (stats.misses ?? 0) + 1;

        // [diag-task-7-cache-miss] First-miss dump.
        if (!_diagLogged) {
            _diagLogged = true;
            const messagesJson = JSON.stringify(messages);
            const messagesHash = createHash('sha256').update(messagesJson).digest('hex').slice(0, 16);
            // eslint-disable-next-line no-console
            console.error(
                `[diag] cache MISS dir=${dir} ` +
                `model=${JSON.stringify(model)} (len=${model.length}) ` +
                `maxTokens=${maxTokens} ` +
                `messagesLen=${messagesJson.length} messagesHash16=${messagesHash} ` +
                `expectedKey=${key.slice(0, 16)}... ` +
                `expectedFile=${file}`,
            );
            try {
                const { readdir, stat } = await import('node:fs/promises');
                const files = await readdir(dir);
                const sample = files.slice(0, 3);
                // eslint-disable-next-line no-console
                console.error(`[diag] cache dir contains ${files.length} files; sample: ${sample.join(', ')}`);
                if (sample.length > 0) {
                    const sampleFile = path.join(dir, sample[0]);
                    const sampleRaw = await readFile(sampleFile, 'utf8');
                    const sampleParsed = JSON.parse(sampleRaw);
                    // eslint-disable-next-line no-console
                    console.error(
                        `[diag] sample cached entry ${sample[0].slice(0, 16)}: ` +
                        `model=${JSON.stringify(sampleParsed.model)} ` +
                        `maxTokens=${sampleParsed.maxTokens} ` +
                        `at=${sampleParsed.at}`,
                    );
                }
                const fileExists = await stat(file).then(() => true, () => false);
                // eslint-disable-next-line no-console
                console.error(`[diag] expectedFile exists=${fileExists}`);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error(`[diag] cache dir probe failed: ${err.message}`);
            }
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
