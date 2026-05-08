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
    INJECTION_MODE_AUTOMATIC,
    INJECTION_MODE_MACRO,
    INJECTION_MODE_OFF,
} from './constants.js';
import { retrieve } from '../retrieval/index.js';
import { loadState, persistState } from '../core/state.js';
import { createLogger } from '../core/logger.js';
import { withWriteLock } from '../core/lock.js';
import { setMemoryBody } from './macro.js';

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
 * The "Retrieved memories:" header signals provenance when STARmem owns
 * placement (automatic mode—injected as a standalone system block). In macro
 * mode the user wraps the body in their own prompt, so the header gets in
 * the way of their phrasing—call with `{ header: false }`.
 *
 * Scope tags (`[episodic]`, `[working]`, `[persona]`) are intentionally
 * omitted: they leak STARmem's internal taxonomy into the prompt without
 * giving the model anything actionable to do with it. The model sees the
 * memories as undifferentiated facts; provenance lives in the Memory Viewer
 * Traces tab for humans.
 *
 * @param {{ id: string, content: string, scope: string }[]} entries
 * @param {{ header?: boolean }} [opts]
 * @returns {string}
 */
export function formatMemoryMessage(entries, opts = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const { header = true } = opts;
    const lines = entries.map(e => `- ${e.content}`);
    return header
        ? ['Retrieved memories:', ...lines].join('\n')
        : lines.join('\n');
}

/**
 * Register a memory body with ST's prompt manager. Empty body clears the slot
 * so a previous turn's memories don't bleed into the current one when
 * retrieval returns nothing.
 *
 * Placement params (position/depth/role) default to the legacy IN_CHAT/4/SYSTEM
 * triple so older callers and existing tests keep their shape. Production
 * callers pass values resolved from settings (automatic mode).
 *
 * @param {(key: string, value: string, position: number, depth: number, scan: boolean, role: number) => void} setExtensionPrompt
 * @param {string} body
 * @param {number} [position] ST extension_prompt_types value
 * @param {number} [depth]    chat depth (0–10) — only meaningful for IN_CHAT
 * @param {number} [role]     ST extension_prompt_roles value
 */
export function injectMemoryPrompt(
    setExtensionPrompt,
    body,
    position = INJECTION_POSITION_IN_CHAT,
    depth = INJECTION_DEPTH,
    role = INJECTION_ROLE_SYSTEM,
) {
    setExtensionPrompt(
        INJECTION_PROMPT_KEY,
        typeof body === 'string' ? body : '',
        position,
        depth,
        /* scan */ false,
        role,
    );
}

/**
 * Resolve the active injection settings. Returns hardcoded legacy defaults if
 * the settings module is unavailable (tests that don't set up an ST context,
 * degraded environments). The defaults match prior behaviour exactly:
 * automatic / IN_CHAT / depth 4 / SYSTEM.
 *
 * Lazy-imported so the static dep graph doesn't pull settings into tests
 * that mock the interceptor's context but not the settings context.
 *
 * @returns {Promise<{ mode: string, position: number, depth: number, role: number }>}
 */
async function resolveInjectionSettings() {
    try {
        const { getSettings } = await import('./settings.js');
        const s = getSettings();
        return {
            mode: s.injectionMode,
            position: s.injectionPosition,
            depth: s.injectionDepth,
            role: s.injectionRole,
        };
    } catch {
        return {
            mode: INJECTION_MODE_AUTOMATIC,
            position: INJECTION_POSITION_IN_CHAT,
            depth: INJECTION_DEPTH,
            role: INJECTION_ROLE_SYSTEM,
        };
    }
}

/**
 * Main entry point — invoked by SillyTavern. Reads `chat` for the user query
 * but never mutates it; injection happens via setExtensionPrompt and/or the
 * {{starmem-memories}} macro depending on the active injection mode.
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
    const cfg = await resolveInjectionSettings();
    try {
        if (!setExtensionPrompt) {
            log.debug('no setExtensionPrompt in context — skipping injection');
            return;
        }

        // Mode 'off': clear both surfaces and skip retrieval entirely.
        if (cfg.mode === INJECTION_MODE_OFF) {
            injectMemoryPrompt(setExtensionPrompt, '', cfg.position, cfg.depth, cfg.role);
            if (chatId) setMemoryBody(chatId, '');
            log.debug('injection mode=off — cleared and skipped retrieval');
            return;
        }

        if (!chatId) {
            log.debug('no chatId — clearing injection and skipping retrieval');
            injectMemoryPrompt(setExtensionPrompt, '', cfg.position, cfg.depth, cfg.role);
            return;
        }

        const query = extractLastUserQuery(chat);
        if (!query) {
            log.debug('no user query in chat — clearing injection and skipping retrieval');
            injectMemoryPrompt(setExtensionPrompt, '', cfg.position, cfg.depth, cfg.role);
            setMemoryBody(chatId, '');
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
        const macroBody = formatMemoryMessage(entries, { header: false });

        // Always cache the headerless body—the macro is meant to be wrapped
        // by the user's own prompt phrasing, so a "Retrieved memories:"
        // preamble gets in the way. Cheap to maintain in any mode, so
        // flipping to macro mid-session never shows a stale value.
        setMemoryBody(chatId, macroBody);

        if (cfg.mode === INJECTION_MODE_MACRO) {
            // Macro owns placement; clear our setExtensionPrompt slot so the
            // two surfaces never stack.
            injectMemoryPrompt(setExtensionPrompt, '', cfg.position, cfg.depth, cfg.role);
            log.debug(`mode=macro — cached ${entries.length} entries for {{starmem-memories}}`);
            return;
        }

        // Automatic mode — register via setExtensionPrompt at configured
        // position/depth/role. Keep the header here: STARmem owns the block,
        // so a "system note" preamble grounds the model.
        injectMemoryPrompt(setExtensionPrompt, body, cfg.position, cfg.depth, cfg.role);
        if (entries.length === 0) {
            log.debug('retrieval returned zero entries — cleared injection slot');
        } else {
            log.debug(`injected ${entries.length} entries (pos=${cfg.position} depth=${cfg.depth} role=${cfg.role})`);
        }
    } catch (err) {
        log.warn('interceptor error (swallowed to protect generation):', err);
        // Clear any prior injection so stale memories don't leak into this turn.
        if (setExtensionPrompt) {
            try { injectMemoryPrompt(setExtensionPrompt, '', cfg.position, cfg.depth, cfg.role); }
            catch { /* ignore */ }
        }
        if (chatId) {
            try { setMemoryBody(chatId, ''); } catch { /* ignore */ }
        }
    }
}
