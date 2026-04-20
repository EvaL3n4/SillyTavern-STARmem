/**
 * LLM client for consolidation. Single surface: callLLM(profileId, messages, maxTokens).
 *
 * Resolves SillyTavern.getContext().ConnectionManagerRequestService at call
 * time — ST swaps the service object during lifecycle events, so caching a
 * reference is fragile (same reasoning as core/state.js:getSTContext).
 *
 * The service returns either ExtractedData (non-streaming, extractData=true)
 * or a stream function; we always call non-streaming with extractData=true,
 * so the return shape is ExtractedData. We read `.content` and nothing else.
 *
 * Test harness: call `_setLLMClientForTests(fakeCallLLM)` to override the
 * production resolver with a mock; `_resetLLMClientForTests()` restores.
 *
 * @module consolidation/llmClient
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.1
 * @see public/scripts/extensions/shared.js:411 (ConnectionManagerRequestService.sendRequest)
 */

/** @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} ChatMessage */
/** @typedef {(profileId: string, messages: ChatMessage[], maxTokens: number) => Promise<string>} LLMClient */

/**
 * Default production client. Resolves ST context lazily, throws a descriptive
 * error if ST is not available.
 *
 * @type {LLMClient}
 */
async function defaultCallLLM(profileId, messages, maxTokens) {
    const g = /** @type {any} */ (globalThis);
    const api = g.SillyTavern;
    if (!api || typeof api.getContext !== 'function') {
        throw new Error('llmClient: SillyTavern.getContext is unavailable');
    }
    const ctx = api.getContext();
    const svc = ctx?.ConnectionManagerRequestService;
    if (!svc || typeof svc.sendRequest !== 'function') {
        throw new Error('llmClient: ConnectionManagerRequestService.sendRequest is unavailable');
    }
    const response = await svc.sendRequest(profileId, messages, maxTokens);
    // extractData=true (default) → ExtractedData shape, which exposes .content
    const content = /** @type {any} */ (response)?.content;
    if (typeof content !== 'string') {
        throw new Error('llmClient: LLM response missing string .content');
    }
    return content;
}

/** @type {LLMClient} */
let client = defaultCallLLM;

/**
 * Call the user's configured LLM via a named connection profile. Returns the
 * raw string content of the response.
 *
 * @param {string} profileId
 * @param {ChatMessage[]} messages
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
export function callLLM(profileId, messages, maxTokens) {
    if (typeof profileId !== 'string' || profileId.length === 0) {
        return Promise.reject(new Error('callLLM: profileId must be a non-empty string'));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        return Promise.reject(new Error('callLLM: messages must be a non-empty array'));
    }
    if (typeof maxTokens !== 'number' || maxTokens <= 0) {
        return Promise.reject(new Error('callLLM: maxTokens must be a positive number'));
    }
    return client(profileId, messages, maxTokens);
}

/**
 * Test-only: swap the client implementation for a mock.
 * @param {LLMClient} fn
 */
export function _setLLMClientForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error('_setLLMClientForTests: fn must be a function');
    }
    client = fn;
}

/** Test-only: restore the default (ST-backed) client. */
export function _resetLLMClientForTests() {
    client = defaultCallLLM;
}
