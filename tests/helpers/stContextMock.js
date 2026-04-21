/**
 * Minimal SillyTavern context mock for Phase 8 JSDOM/integration tests.
 *
 * Surface deliberately narrow — only the fields STARmem Phase 8 code reads:
 *
 *   - extensionSettings       (settings.js, settingsPanel.js)
 *   - saveSettingsDebounced   (settings.js, settingsPanel.js)
 *   - chatMetadata            (state.js already has its own backend hook;
 *                              included here for tests that exercise
 *                              SillyTavern.getContext() directly)
 *   - saveMetadataDebounced   (tests that want to assert persistence calls)
 *   - chatId                  (interceptor.js, bootstrap.js)
 *   - eventSource             (bootstrap.js — see spy below)
 *   - event_types             (constant map used by bootstrap.js)
 *
 * Anything else (characters, chat, groups, callPopup, slash commands) is
 * intentionally absent. If a later phase needs one, add it here rather
 * than inline in a test.
 *
 * @module tests/helpers/stContextMock
 */

import { jest } from '@jest/globals';

/**
 * The subset of ST event_types Phase 8 wires. Names match ST's script.js.
 * Kept as a frozen object so tests can reference `ET.APP_READY` safely.
 */
export const ET = Object.freeze({
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_DELETED: 'message_deleted',
});

/**
 * @typedef {object} EventSourceSpy
 * @property {jest.Mock} on
 * @property {jest.Mock} off
 * @property {jest.Mock} emit
 * @property {Map<string, Set<Function>>} _handlers
 */

/**
 * Build a minimal eventSource spy with real pub/sub semantics.
 * `emit(name, ...args)` synchronously invokes every handler registered
 * via `on(name, fn)`; handlers registered then unregistered via `off`
 * are not invoked. Exposes `_handlers` so tests can inspect subscription
 * state directly (e.g. "bootstrap subscribed to APP_READY exactly once").
 *
 * @returns {EventSourceSpy}
 */
export function makeEventSource() {
    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();

    const on = jest.fn(/** @param {string} name @param {Function} fn */ (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(fn);
    });

    const off = jest.fn(/** @param {string} name @param {Function} fn */ (name, fn) => {
        handlers.get(name)?.delete(fn);
    });

    const emit = jest.fn(/** @param {string} name @param {any[]} args */ async (name, ...args) => {
        const set = handlers.get(name);
        if (!set) return;
        // Clone so a handler that calls off() mid-emit doesn't mutate iteration.
        for (const fn of [...set]) {
            await fn(...args);
        }
    });

    return { on, off, emit, _handlers: handlers };
}

/**
 * @typedef {object} StContextMockOptions
 * @property {Record<string, any>} [extensionSettings]
 * @property {Record<string, any>} [chatMetadata]
 * @property {string|null} [chatId]
 * @property {EventSourceSpy} [eventSource]
 */

/**
 * @typedef {object} StContextMock
 * @property {Record<string, any>} extensionSettings
 * @property {() => void} saveSettingsDebounced
 * @property {Record<string, any>} chatMetadata
 * @property {() => void} saveMetadataDebounced
 * @property {string|null} chatId
 * @property {EventSourceSpy} eventSource
 * @property {typeof ET} event_types
 */

/**
 * Build a fresh `SillyTavern.getContext()`-shaped object. Every field is a
 * jest.Mock or a Plain Old Object owned by the test — no shared state
 * across invocations.
 *
 * @param {StContextMockOptions} [overrides]
 * @returns {StContextMock}
 */
export function makeStContext(overrides = {}) {
    return {
        extensionSettings: overrides.extensionSettings ?? {},
        saveSettingsDebounced: jest.fn(),
        chatMetadata: overrides.chatMetadata ?? {},
        saveMetadataDebounced: jest.fn(),
        chatId: overrides.chatId === undefined ? 'test-chat' : overrides.chatId,
        eventSource: overrides.eventSource ?? makeEventSource(),
        event_types: ET,
    };
}

/**
 * Install the mock as `globalThis.SillyTavern = { getContext: () => ctx }`
 * and return a teardown callable that restores whatever was there before.
 *
 * Use this when the code under test reads `SillyTavern.getContext()`
 * directly (e.g. interceptor.js). Tests that use an injected `_setContextForTests`
 * helper (settings.js) don't need this — inject directly.
 *
 * @param {StContextMock} ctx
 * @returns {() => void} teardown
 */
export function installGlobalSillyTavern(ctx) {
    const g = /** @type {any} */ (globalThis);
    const prior = g.SillyTavern;
    g.SillyTavern = { getContext: () => ctx };
    return () => {
        if (prior === undefined) delete g.SillyTavern;
        else g.SillyTavern = prior;
    };
}
