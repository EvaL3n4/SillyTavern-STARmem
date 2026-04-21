/**
 * STARmem v2 — SillyTavern memory extension entry point.
 *
 * ST loads this file directly (no build step). Responsibilities:
 *
 *   1. Register globalThis.STARmemInterceptor — ST's manifest.json points
 *      `generate_interceptor` at this global, and calls it on every generation.
 *   2. Subscribe bootstrap() to APP_READY — settings, indicator, viewer,
 *      and the idle timer all initialize inside bootstrap() once ST is ready.
 *
 * That's it. Every other concern lives under src/integration/.
 *
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 * @see src/integration/interceptor.js
 * @see src/integration/bootstrap.js
 */

import { log } from './src/core/logger.js';
import { starmemInterceptor } from './src/integration/interceptor.js';
import { bootstrap } from './src/integration/bootstrap.js';

/**
 * generate_interceptor body — registered via manifest.json.
 * Thin shim: delegates to the real interceptor and swallows all errors
 * so a broken memory system cannot break the user's chat. See
 * interceptor.js for the contract.
 *
 * @param {Array<any>} chat
 * @param {number} contextSize
 * @param {(immediately: boolean) => void} abort
 * @param {string} type
 */
globalThis.STARmemInterceptor = async function STARmemInterceptor(chat, contextSize, abort, type) {
    try {
        await starmemInterceptor(chat, contextSize, abort, type);
    } catch (err) {
        log.error('interceptor threw; swallowing to protect generation', err);
    }
};

/**
 * APP_READY subscription — fires once, after ST has mounted its UI and
 * getContext() is fully populated. bootstrap() handles idempotency: a
 * second APP_READY fire (can happen on extension reload) is a no-op.
 *
 * Top-level await: ST loads extension JS as `<script type="module">`,
 * so TLA is supported. We use it over an IIFE to make module-eval
 * ordering explicit — if SillyTavern isn't ready at eval time we log
 * and return rather than silently swallowing.
 */
try {
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st?.getContext) {
        log.warn('SillyTavern.getContext unavailable at module eval; bootstrap deferred');
    } else {
        const { eventSource, event_types } = st.getContext();
        eventSource.on(event_types.APP_READY, () => {
            bootstrap().catch(err => log.error('bootstrap failed:', err));
        });
    }
} catch (err) {
    log.error('failed to subscribe to APP_READY:', err);
}

log.info('v2 loaded');
