/**
 * Node-native OpenAI-compatible LLM client for live-extraction benches.
 *
 * Matches the LLMClient signature from src/consolidation/llmClient.js so it
 * can be dropped into _setLLMClientForTests without any wrapping. Temperature
 * is hard-locked at 0 for reproducibility; sweeps depend on deterministic
 * extractions. Any non-0 temperature would invalidate the whole comparison.
 *
 * Config is injected (not read from process.env here) so tests can exercise
 * the factory without touching env. The seeder wires env → factory.
 *
 * @module bench/harness/llmExtractor
 * @see docs/plans/phase-9-5-live-extraction.md Task 1
 */

/**
 * @typedef {object} LLMExtractorConfig
 * @property {string} url       - OpenAI-compatible base URL (appends /chat/completions).
 * @property {string} apiKey    - Bearer token.
 * @property {string} model     - Model identifier passed as body.model.
 * @property {number} [maxRetries] - Retry attempts on 5xx/network errors. Default 2.
 *                                    Retries sleep max(200ms, Retry-After * 1000)
 *                                    with ×2 backoff. Non-retryable: 4xx.
 */

/**
 * Build an LLM extractor matching the LLMClient signature.
 *
 * Retry policy (opt-out via maxRetries=0):
 *   - 5xx HTTP: retry up to maxRetries times with exponential backoff
 *     (base 200ms, ×2 each attempt, capped at 5s). Absorbs transient
 *     upstream hiccups like the single 503 caught on the 2026-04-23
 *     K=16 smoke (1/1038 batches). At 500-item scale a 0.1% failure
 *     rate would surface ~50 cold-cache misses downstream.
 *   - Network errors (fetch throws, e.g. ECONNRESET, DNS): same retry.
 *   - 4xx HTTP (401, 403, 429, etc.): fail fast — these indicate
 *     auth/quota/routing, not transient failure.
 *   - Final failure message includes attempt count for triage.
 *
 * @param {LLMExtractorConfig} config
 * @returns {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>}
 */
export function makeLLMExtractor(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('makeLLMExtractor: config required');
    }
    const { url, apiKey, model, maxRetries = 2 } = config;
    if (typeof url !== 'string' || url.length === 0) {
        throw new Error('makeLLMExtractor: url required (STARMEM_BENCH_LLM_URL)');
    }
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
        throw new Error('makeLLMExtractor: apiKey required (STARMEM_BENCH_LLM_API_KEY)');
    }
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error('makeLLMExtractor: model required (STARMEM_BENCH_LLM_MODEL)');
    }

    const endpoint = url.replace(/\/$/, '') + '/chat/completions';

    return async function llmExtractor(_profileId, messages, maxTokens) {
        const body = JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0,
        });

        /** @type {Error | null} */
        let lastError = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body,
                });

                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    const err = /** @type {any} */ (new Error(
                        `llmExtractor: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
                    ));
                    // 4xx → fail fast. 5xx → retry-eligible.
                    if (res.status >= 400 && res.status < 500) {
                        err.retryable = false;
                        throw err;
                    }
                    lastError = err;
                    // Fall through to retry logic below.
                } else {
                    const data = await res.json();
                    const content = data?.choices?.[0]?.message?.content;
                    if (typeof content !== 'string') {
                        // Malformed response — not a transient fault.
                        const err = /** @type {any} */ (new Error(
                            'llmExtractor: response missing string content',
                        ));
                        err.retryable = false;
                        throw err;
                    }
                    return content;
                }
            } catch (err) {
                const e = /** @type {any} */ (err);
                // Non-retryable (4xx, malformed response): propagate immediately.
                if (e?.retryable === false) {
                    throw e;
                }
                // Retryable (fetch network error, 5xx caught above): record and loop.
                lastError = /** @type {Error} */ (err);
            }

            if (attempt < maxRetries) {
                const delayMs = Math.min(5000, 200 * Math.pow(2, attempt));
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
        // Exhausted retries.
        const finalMsg = lastError?.message ?? 'unknown failure';
        throw new Error(`llmExtractor: failed after ${maxRetries + 1} attempts — ${finalMsg}`);
    };
}
