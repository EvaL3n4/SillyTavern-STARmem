/**
 * STARmemInterceptor body — invoked by SillyTavern before each generation.
 *
 * Contract (from ST's extensions.js#runGenerationInterceptors):
 *   globalThis.STARmemInterceptor(chat, contextSize, abort, type)
 *   - chat: array (coreChat copy; we read it but no longer mutate it)
 *   - contextSize: number (max prompt tokens — informational for us)
 *   - abort: (immediately: boolean) => void
 *   - type: string (generation type, e.g. "normal", "continue", "impersonate")
 *
 * Flow:
 *   1. Resolve chatId from SillyTavern.getContext(). Bail on missing.
 *   2. Extract last user query from chat. Bail if none (impersonation, etc.).
 *   3. loadState(chatId) under withWriteLock, retrieve(state, query, { now }) —
 *      the ladder fires `applyAccessEvent` for returned entries AND logs the
 *      trace as part of its own state-transition contract. We persist the
 *      returned state inside the same lock.
 *   4. Format returned entries into a memory body string.
 *   5. Register the body via ST's setExtensionPrompt at IN_CHAT depth=4
 *      with SYSTEM role. ST owns final placement, prompt budgeting, and
 *      cleanup; we just maintain the registered value.
 *
 * The IN_CHAT/depth=4 position lands the memory block close enough to the
 * latest exchange that providers cache it across turns (cache-friendly), while
 * staying recent enough for the model to weigh it. Depth 4 matches ST's
 * default for in-chat injections (slash-commands.js).
 *
 * Errors:
 *   All thrown errors are caught, logged, and swallowed. A broken memory system
 *   must not break generation. On error we also clear our prior injection so
 *   stale memories can't leak into the next turn.
 *
 * @module integration/interceptor
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import {
    INJECTION_PROMPT_KEY,
    INJECTION_DEPTH,
    INJECTION_POSITION_IN_CHAT,
    INJECTION_ROLE_SYSTEM,
} from './constants.js';
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

/**
 * Resolve the SillyTavern context. Returns a thin wrapper around the bits we
 * need so test seams stay narrow.
 *
 * @returns {{ chatId: string | null, setExtensionPrompt: ((key: string, value: string, position: number, depth: number, scan: boolean, role: number) => void) | null }}
 */
function resolveContext() {
    if (testContext !== null) {
        return {
            chatId: typeof testContext.chatId === 'string' && testContext.chatId.length > 0 ? testContext.chatId : null,
            setExtensionPrompt: typeof testContext.setExtensionPrompt === 'function' ? testContext.setExtensionPrompt : null,
        };
    }
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return { chatId: null, setExtensionPrompt: null };
    const ctx = st.getContext();
    return {
        chatId: typeof ctx?.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null,
        setExtensionPrompt: typeof ctx?.setExtensionPrompt === 'function' ? ctx.setExtensionPrompt : null,
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
 * Compose the body of an injected memory block. Keeps the format simple and
 * LLM-neutral; Phase 9 can A/B test fancier formats later.
 *
 * @param {{ id: string, content: string, scope: string }[]} entries
 * @returns {string}
 */
export function formatMemoryMessage(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const lines = entries.map(e => `- [${e.scope}] ${e.content}`);
    return ['[STARmem] Retrieved memories:', ...lines].join('\n');
}

/**
 * Register a memory body with ST's prompt manager. Empty body clears the slot
 * so a previous turn's memories don't bleed into the current one when
 * retrieval returns nothing.
 *
 * @param {(key: string, value: string, position: number, depth: number, scan: boolean, role: number) => void} setExtensionPrompt
 * @param {string} body
 */
export function injectMemoryPrompt(setExtensionPrompt, body) {
    setExtensionPrompt(
        INJECTION_PROMPT_KEY,
        typeof body === 'string' ? body : '',
        INJECTION_POSITION_IN_CHAT,
        INJECTION_DEPTH,
        /* scan */ false,
        INJECTION_ROLE_SYSTEM,
    );
}

/**
 * Main entry point — invoked by SillyTavern. Reads `chat` for the user query
 * but never mutates it; injection happens via setExtensionPrompt.
 *
 * @param {ChatMessage[]} chat
 * @param {number} _contextSize
 * @param {(immediately: boolean) => void} _abort
 * @param {string} [type] - generation type ('normal', 'swipe', 'continue',
 *     'regenerate', 'impersonate', 'quiet'). Threaded into the retrieval
 *     trace so the Memory Viewer can label same-query reruns honestly.
 * @returns {Promise<void>}
 */
export async function starmemInterceptor(chat, _contextSize, _abort, type) {
    const { chatId, setExtensionPrompt } = resolveContext();
    try {
        if (!setExtensionPrompt) {
            log.debug('no setExtensionPrompt in context — skipping injection');
            return;
        }
        if (!chatId) {
            log.debug('no chatId — clearing injection and skipping retrieval');
            injectMemoryPrompt(setExtensionPrompt, '');
            return;
        }

        const query = extractLastUserQuery(chat);
        if (!query) {
            log.debug('no user query in chat — clearing injection and skipping retrieval');
            injectMemoryPrompt(setExtensionPrompt, '');
            return;
        }

        // Atomically load → retrieve → persist under the write lock so
        // concurrent consolidation/persona-rebuild commits don't get
        // overwritten by our stale snapshot (finding #12). retrieve() is
        // pure; we keep trace persistence for the zero-entry case because
        // the ladder logs a trace even when no entries survive.
        const cause = typeof type === 'string' && type.length > 0 ? type : 'normal';
        const entries = await withWriteLock(chatId, async () => {
            const state = await loadState(chatId);
            const result = retrieve(state, query, { now: new Date(), cause });
            if (result?.state) {
                await persistState(chatId, result.state);
            }
            return Array.isArray(result?.entries) ? result.entries : [];
        });

        const body = formatMemoryMessage(entries);
        injectMemoryPrompt(setExtensionPrompt, body);
        if (entries.length === 0) {
            log.debug('retrieval returned zero entries — cleared injection slot');
        } else {
            log.debug(`injected ${entries.length} entries via setExtensionPrompt (depth=${INJECTION_DEPTH})`);
        }
    } catch (err) {
        log.warn('interceptor error (swallowed to protect generation):', err);
        // Clear any prior injection so stale memories don't leak into this turn.
        if (setExtensionPrompt) {
            try { injectMemoryPrompt(setExtensionPrompt, ''); } catch { /* ignore */ }
        }
    }
}
