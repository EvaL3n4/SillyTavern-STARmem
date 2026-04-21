/**
 * STARmemInterceptor body — invoked by SillyTavern before each generation.
 *
 * Contract (from ST's extensions.js#runGenerationInterceptors):
 *   globalThis.STARmemInterceptor(chat, contextSize, abort, type)
 *   - chat: array (coreChat copy; mutate in place, don't reassign)
 *   - contextSize: number (max prompt tokens — informational for us)
 *   - abort: (immediately: boolean) => void
 *   - type: string (generation type, e.g. "normal", "continue", "impersonate")
 *
 * Flow:
 *   1. Resolve chatId from SillyTavern.getContext(). Bail on missing.
 *   2. Extract last user query from chat. Bail if none (impersonation, etc.).
 *   3. loadState(chatId), then retrieve(state, query, { now }) — the ladder
 *      fires `applyAccessEvent` for returned entries AND logs the trace as
 *      part of its own state-transition contract. We just persist the
 *      returned state under the write lock.
 *   4. Format returned entries into an is_system message.
 *   5. Splice at Math.max(0, chat.length - INJECTION_DEPTH).
 *
 * Errors:
 *   All thrown errors are caught, logged, and swallowed. A broken memory system
 *   must not break generation.
 *
 * @module integration/interceptor
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { INJECTION_DEPTH } from '../core/constants.js';
import { INJECTION_KEY, INJECTION_ROLE } from './constants.js';
import { retrieve } from '../retrieval/index.js';
import { loadState, persistState } from '../core/state.js';
import { createLogger } from '../core/logger.js';
import { withWriteLock } from '../core/lock.js';

const log = createLogger({ debug: false }).scope('integration:interceptor');

/**
 * @typedef {object} ChatMessage
 * @property {string} name
 * @property {boolean} is_user
 * @property {boolean} is_system
 * @property {string} send_date
 * @property {string} mes
 * @property {Record<string, any>} [extra]
 */

/** @type {any} */
let testContext = null;

/** Test-only: inject a fake getContext() result. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context. */
export function _resetContextForTests() { testContext = null; }

/** @returns {{ chatId: string | null }} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return { chatId: null };
    const ctx = st.getContext();
    return {
        chatId: typeof ctx?.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null,
    };
}

/**
 * Extract the last user message's text from a chat array.
 *
 * @param {ChatMessage[]} chat
 * @returns {string | null}
 */
export function extractLastUserQuery(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && m.is_user === true && typeof m.mes === 'string' && m.mes.trim().length > 0) {
            return m.mes;
        }
    }
    return null;
}

/**
 * Compose the text body of an injected memory message. Keeps the format
 * simple + LLM-neutral; Phase 9 can A/B test fancier formats later.
 *
 * @param {{ id: string, content: string, scope: string }[]} entries
 * @returns {string}
 */
export function formatMemoryMessage(entries) {
    if (entries.length === 0) return '';
    const lines = entries.map(e => `- [${e.scope}] ${e.content}`);
    return ['[STARmem] Retrieved memories:', ...lines].join('\n');
}

/**
 * Build the synthetic chat message we splice into the array.
 *
 * @param {string} text
 * @returns {ChatMessage}
 */
export function buildInjectionMessage(text) {
    return {
        name: 'System',
        is_user: false,
        is_system: true,
        send_date: new Date().toISOString(),
        mes: text,
        extra: { [INJECTION_KEY]: true, role: INJECTION_ROLE },
    };
}

/**
 * Compute the splice position: `chat.length - INJECTION_DEPTH`, clamped to
 * [0, chat.length]. If chat is shorter than depth, prepend.
 *
 * @param {number} chatLength
 * @param {number} depth
 * @returns {number}
 */
export function computeInjectionPosition(chatLength, depth) {
    if (chatLength <= 0) return 0;
    return Math.max(0, chatLength - depth);
}

/**
 * Main entry point — invoked by SillyTavern. Always mutates `chat` in place;
 * never reassigns.
 *
 * @param {ChatMessage[]} chat
 * @param {number} _contextSize
 * @param {(immediately: boolean) => void} _abort
 * @param {string} _type
 * @returns {Promise<void>}
 */
export async function starmemInterceptor(chat, _contextSize, _abort, _type) {
    try {
        const { chatId } = resolveContext();
        if (!chatId) {
            log.debug('no chatId — skipping retrieval');
            return;
        }

        const query = extractLastUserQuery(chat);
        if (!query) {
            log.debug('no user query in chat — skipping retrieval');
            return;
        }

        // Load state + run ladder. retrieve() is pure: returns the new state
        // with access events applied and the retrieval trace logged. We
        // persist the new state under the write lock so concurrent
        // consolidation/retrieval don't interleave.
        const state = await loadState(chatId);
        const result = retrieve(state, query, { now: new Date() });
        const entries = Array.isArray(result?.entries) ? result.entries : [];

        if (entries.length === 0) {
            // Even zero-entry retrievals log a trace — persist it so the
            // Traces tab reflects the call.
            if (result?.state) {
                await withWriteLock(chatId, async () => {
                    await persistState(chatId, result.state);
                });
            }
            log.debug('retrieval returned zero entries');
            return;
        }

        // Persist the state returned by retrieve() (access events + trace).
        await withWriteLock(chatId, async () => {
            await persistState(chatId, result.state);
        });

        // Splice into chat.
        const body = formatMemoryMessage(entries);
        if (!body) return;
        const originalLen = chat.length;
        const pos = computeInjectionPosition(originalLen, INJECTION_DEPTH);
        chat.splice(pos, 0, buildInjectionMessage(body));
        log.debug(`injected ${entries.length} entries at pos=${pos} (chat.length was ${originalLen})`);
    } catch (err) {
        log.warn('interceptor error (swallowed to protect generation):', err);
    }
}
