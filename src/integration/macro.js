/**
 * STARmem `{{starmem-memories}}` global macro.
 *
 * Registered once at bootstrap. The macro resolves at substitution time
 * (when ST renders the user's preset / chat template) to the most recent
 * retrieval body for the active chat. The interceptor populates a per-chat
 * cache before generation; the macro just reads it.
 *
 * Decoupling rationale:
 *   - The macro is a placement primitive owned by the user via their preset.
 *     Rendering inside the macro handler must not trigger retrieval — that's
 *     the interceptor's job, fired before generation. The handler is
 *     deliberately a pure read of the cached body.
 *   - When the chat has no cached body (cold load, retrieval errored, or
 *     mode='off') the macro returns ''. Empty-string is the right neutral
 *     element for prompt composition: the user's preset still substitutes
 *     cleanly, just with nothing where the macros sit.
 *
 * @module integration/macro
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { MACRO_NAME } from './constants.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:macro');

/** @type {Map<string, string>} chatId → most-recent memory body. */
const bodyByChat = new Map();

/** @type {boolean} */
let registered = false;

/** @type {any} */
let testContext = null;

/** Test-only: inject a fake ST context. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context + cache + registration flag. */
export function _resetContextForTests() {
    testContext = null;
    bodyByChat.clear();
    registered = false;
}

function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return null;
    return st.getContext();
}

/**
 * Update the cached memory body for a chat. Called by the interceptor after
 * each retrieval, regardless of injection mode — the cost of caching when
 * unused is one Map.set() per turn.
 *
 * @param {string} chatId
 * @param {string} body
 */
export function setMemoryBody(chatId, body) {
    if (typeof chatId !== 'string' || chatId.length === 0) return;
    bodyByChat.set(chatId, typeof body === 'string' ? body : '');
}

/**
 * Read the cached body for a chat. Returns '' if nothing's been cached yet.
 *
 * @param {string} chatId
 * @returns {string}
 */
export function getMemoryBody(chatId) {
    if (typeof chatId !== 'string' || chatId.length === 0) return '';
    return bodyByChat.get(chatId) ?? '';
}

/** Test-only: clear all cached bodies. */
export function _clearMemoryBodiesForTests() { bodyByChat.clear(); }

/**
 * The macro handler. Resolves the active chatId at substitution time and
 * returns its cached body. Errors are swallowed and rendered as ''.
 *
 * Exported for tests; production uses it via registration only.
 *
 * @returns {string}
 */
export function memoriesMacroHandler() {
    try {
        const ctx = resolveContext();
        const chatId = typeof ctx?.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null;
        if (!chatId) return '';
        return getMemoryBody(chatId);
    } catch (err) {
        log.warn(`macro handler error (returning empty): ${err?.message || err}`);
        return '';
    }
}

/**
 * Register the macro with ST's macro registry. Idempotent — a second call
 * is a no-op. Tries the new MacroRegistry first (current ST), falls back
 * to the legacy MacrosParser shim, and silently no-ops if neither is
 * importable (degraded env / older ST).
 *
 * Registration is deliberately dynamic-imported: the static dep graph for
 * STARmem must not pull in `../../../macros/...` because Jest-jsdom resolves
 * that path against the test fixtures, not the real ST tree.
 *
 * @returns {Promise<boolean>} true if registration succeeded
 */
export async function registerStarmemMacro() {
    if (registered) return true;
    // New macro engine first.
    try {
        const mod = await import('../../../../../macros/macro-system.js');
        const macros = mod?.macros;
        if (macros?.registry?.registerMacro) {
            const cat = macros?.category?.CHAT ?? 'CHAT';
            macros.registry.registerMacro(MACRO_NAME, {
                category: cat,
                description: 'STARmem retrieved memories for the current turn (deterministic).',
                handler: () => memoriesMacroHandler(),
            });
            registered = true;
            log.info(`registered {{${MACRO_NAME}}} via MacroRegistry`);
            return true;
        }
    } catch (err) {
        log.debug(`MacroRegistry import failed (will try legacy): ${err?.message || err}`);
    }
    // Legacy shim — still works, emits a deprecation warning from ST. We
    // accept the warning rather than gate registration on engine version.
    try {
        const mod = await import('../../../../../macros.js');
        const Parser = mod?.MacrosParser;
        if (typeof Parser?.registerMacro === 'function') {
            Parser.registerMacro(
                MACRO_NAME,
                () => memoriesMacroHandler(),
                'STARmem retrieved memories for the current turn (deterministic).',
            );
            registered = true;
            log.info(`registered {{${MACRO_NAME}}} via legacy MacrosParser`);
            return true;
        }
    } catch (err) {
        // Both engines failed — typical in non-ST environments (Jest, isolated
        // dev shells). Drop to debug; users running inside ST who hit this
        // genuinely have a load problem and should see it in the console
        // anyway via the deprecation warnings ST emits on startup.
        log.debug(`macro registration failed on both engines: ${err?.message || err}`);
    }
    return false;
}
