/**
 * STARmem v2 — SillyTavern memory extension entry point.
 *
 * ST loads this file directly (no build step). Responsibilities:
 *
 *   1. Register globalThis.STARmemInterceptor — ST's manifest.json points
 *      `generate_interceptor` at this global, and calls it on every generation.
 *   2. On APP_READY:
 *        a. bootstrap()            — event subscriptions, state backend, scorer
 *        b. mountIndicator()       — subtle consolidation dot anchored in #send_form
 *        c. renderSettingsPanel()  — extensions-drawer settings UI (host =
 *                                    #extensions_settings2, our loading_order=100
 *                                    lands us in the right-hand column)
 *        d. the panel's "Open Memory Viewer" button → openViewer(chatId)
 *
 * Every other concern lives under src/integration/.
 *
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 * @see src/integration/interceptor.js
 * @see src/integration/bootstrap.js
 */

import { log } from './src/core/logger.js';
import { starmemInterceptor } from './src/integration/interceptor.js';
import { bootstrap } from './src/integration/bootstrap.js';
import { renderSettingsPanel } from './src/integration/settingsPanel.js';
import { mountIndicator } from './src/integration/indicator.js';
import { openViewer } from './src/integration/viewer/mount.js';

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
            try {
                bootstrap();
            } catch (err) {
                log.error('bootstrap failed:', err);
            }

            // Mount the consolidation indicator. Resolves the current chat id
            // lazily on each tick so chat switches are picked up automatically.
            try {
                mountIndicator(() => {
                    try { return st.getContext()?.chatId ?? null; }
                    catch { return null; }
                });
            } catch (err) {
                log.error('mountIndicator failed:', err);
            }

            // Mount the settings panel into ST's extensions drawer. ST renders
            // the drawer before APP_READY fires, so `#extensions_settings2`
            // (right column, loading_order > 0) exists at this point.
            // Our panel's "Open Memory Viewer" button delegates via onOpenViewer.
            try {
                const host = document.getElementById('extensions_settings2')
                    || document.getElementById('extensions_settings');
                if (!host) {
                    log.warn('#extensions_settings[2] not found — settings panel not mounted');
                } else {
                    const container = document.createElement('div');
                    container.id = 'starmem-settings-container';
                    host.appendChild(container);
                    renderSettingsPanel(container, {
                        onOpenViewer: () => {
                            const chatId = (() => {
                                try { return st.getContext()?.chatId ?? null; }
                                catch { return null; }
                            })();
                            if (!chatId) {
                                log.warn('openViewer: no active chat');
                                return;
                            }
                            openViewer(chatId).catch(err =>
                                log.error('openViewer failed:', err));
                        },
                    }).catch(err => log.error('renderSettingsPanel failed:', err));
                }
            } catch (err) {
                log.error('settings-panel mount failed:', err);
            }
        });
    }
} catch (err) {
    log.error('failed to subscribe to APP_READY:', err);
}

log.info('v2 loaded');
