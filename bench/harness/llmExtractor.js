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
 */

/**
 * Build an LLM extractor matching the LLMClient signature.
 *
 * @param {LLMExtractorConfig} config
 * @returns {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>}
 */
export function makeLLMExtractor(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('makeLLMExtractor: config required');
    }
    const { url, apiKey, model } = config;
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
            throw new Error(
                `llmExtractor: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
            );
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            throw new Error('llmExtractor: response missing string content');
        }
        return content;
    };
}
