/**
 * STARmem — SillyTavern memory extension (v2)
 *
 * Entry point. Registers the generate_interceptor and wires up
 * initialization on APP_READY. Most logic lives under src/.
 *
 * See docs/specs/2026-04-20-starmem-v2-design.md for the full design.
 */

// TODO(impl): import { eventSource, event_types } from '../../../../script.js';
// TODO(impl): import { extension_settings } from '../../../extensions.js';
// TODO(impl): wire init → initSTARmem() on APP_READY

/**
 * Generate interceptor — registered via manifest.json#generate_interceptor.
 * Called by SillyTavern before each generation with the full chat history.
 *
 * @param {Array} chat - Full conversation history array.
 * @param {number} contextSize - Available context size.
 * @param {Function} abort - Call to abort generation.
 * @param {string} type - Generation type.
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-unused-vars
globalThis.STARmemInterceptor = async function STARmemInterceptor(chat, contextSize, abort, type) {
    // Implementation pending — see plan.
};

console.log('[STARmem] v2 loaded (scaffold only)');
