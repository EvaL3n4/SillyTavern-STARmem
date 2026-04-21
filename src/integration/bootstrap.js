/**
 * Phase 8 bootstrap — APP_READY subscriptions, chat-switch hygiene, working-buffer growth.
 *
 * Called exactly once from index.js on the APP_READY event. Idempotent (safe
 * to call multiple times in dev); unsubscribes prior event handlers before
 * re-subscribing.
 *
 * Working-buffer growth (Decision 8/B in Phase 8 retro):
 *   On MESSAGE_RECEIVED, we create one `scope: 'working'` entry per assistant
 *   reply, store it in `state.entries`, and push its id onto `state.workingBuffer`.
 *   This matches Phase 6's model (workingBuffer = string[] of entry ids).
 *   User messages are NOT captured as separate working entries — assistant
 *   replies carry the semantically relevant content for extraction. Phase 9
 *   benchmarking may revisit this granularity.
 *
 * @module integration/bootstrap
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { setBackend, loadState, persistState } from '../core/state.js';
import { withWriteLock } from '../core/lock.js';
import { createEntry } from '../memory/entry.js';
import {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer,
} from '../consolidation/index.js';
import { setScorer } from '../retrieval/index.js';
import { getSettings } from './settings.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:bootstrap');

/** @type {(() => void)[]} */
let unsubscribers = [];

/** @type {string | null} */
let lastChatId = null;

/** @type {any} */
let testContext = null;

/** Test-only: inject fake context. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context + module state. */
export function _resetContextForTests() {
    testContext = null;
    unsubscribers = [];
    lastChatId = null;
}

/** @returns {any} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') {
        throw new Error('[STARmem] SillyTavern.getContext() unavailable at bootstrap');
    }
    return st.getContext();
}

/**
 * Build consolidation options from persisted settings + the canonical
 * `messageOf` mapper. Shared by all handlers that may trigger consolidation.
 *
 * @returns {import('../consolidation/consolidate.js').ConsolidateOptions}
 */
function buildConsolidateOpts() {
    const settings = getSettings();
    return {
        profileId: settings.profileId,
        extractorLabel: settings.extractionModelLabel || 'unknown@consolidation-v1',
        messageOf: (e) => ({ role: 'assistant', content: e.content }),
        now: new Date(),
    };
}

/**
 * Build the canonical state backend that reads + writes chatMetadata via ST.
 *
 * @returns {{ read: (id: string) => unknown, write: (id: string, v: unknown) => void }}
 */
export function buildStateBackend() {
    return {
        read: (id) => {
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') return undefined;
            const slot = cm['STARmem'];
            if (!slot || typeof slot !== 'object') return undefined;
            return slot[id];
        },
        write: (id, value) => {
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') {
                throw new Error('[STARmem] chatMetadata not available — cannot persist');
            }
            if (!cm['STARmem'] || typeof cm['STARmem'] !== 'object') {
                cm['STARmem'] = {};
            }
            cm['STARmem'][id] = value;
            if (typeof ctx.saveMetadataDebounced === 'function') {
                ctx.saveMetadataDebounced();
            }
        },
    };
}

/**
 * Event handler: CHAT_CHANGED. Idle-cancel the old chat, opportunistic drain,
 * update lastChatId.
 *
 * @param {string} newChatId
 */
export async function onChatChanged(newChatId) {
    if (lastChatId && lastChatId !== newChatId) {
        try {
            cancelIdleTimer(lastChatId);
            // Opportunistic drain before switching — non-blocking. Swallows
            // below-threshold skips silently via maybeConsolidate's guard.
            maybeConsolidate(lastChatId, 'buffer', buildConsolidateOpts())
                .catch(err => log.warn(`drain on chat-switch failed: ${err?.message || err}`));
        } catch (err) {
            log.warn(`chat-switch cleanup error (swallowed): ${err?.message || err}`);
        }
    }
    lastChatId = typeof newChatId === 'string' ? newChatId : null;
}

/**
 * Event handler: MESSAGE_SENT. Bumps idle timer so the 60s window restarts
 * on user activity. Idle timer's action (once elapsed) is 'idle'
 * maybeConsolidate — see triggers.js.
 *
 * @param {number} _messageId
 */
export function onMessageSent(_messageId) {
    if (!lastChatId) return;
    try {
        resetIdleTimer(lastChatId, buildConsolidateOpts());
    } catch (err) {
        log.warn(`resetIdleTimer error (swallowed): ${err?.message || err}`);
    }
}

/**
 * Event handler: MESSAGE_RECEIVED. Create a `scope: 'working'` entry for the
 * assistant's reply, append its id to workingBuffer, then maybeConsolidate.
 *
 * @param {number} messageId - ST's chat index for the newly-received message
 */
export async function onMessageReceived(messageId) {
    if (!lastChatId) return;
    try {
        const ctx = resolveContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : null;
        if (!chat || chat.length === 0) return;

        // Prefer the message at messageId if valid; fall back to last element.
        const idx = Number.isInteger(messageId) && messageId >= 0 && messageId < chat.length
            ? messageId
            : chat.length - 1;
        const received = chat[idx];
        if (!received || received.is_user || received.is_system) return;
        if (typeof received.mes !== 'string' || received.mes.trim().length === 0) return;

        const now = new Date();
        const entry = createEntry({
            scope: 'working',
            content: received.mes,
            subject: null,
            tags: [],
            relations: [],
            provenance: { sourceMessages: [idx], extractor: 'interceptor@working-v1' },
            now,
        });

        await withWriteLock(lastChatId, async () => {
            const state = await loadState(lastChatId);
            const next = {
                ...state,
                entries: { ...state.entries, [entry.id]: entry },
                workingBuffer: [...state.workingBuffer, entry.id],
            };
            await persistState(lastChatId, next);
        });

        // Fire-and-forget consolidation; the reason='buffer' guard in
        // maybeConsolidate handles below-threshold quietly.
        maybeConsolidate(lastChatId, 'buffer', buildConsolidateOpts())
            .catch(err => log.warn(`maybeConsolidate on MESSAGE_RECEIVED failed: ${err?.message || err}`));
    } catch (err) {
        log.warn(`onMessageReceived error (swallowed): ${err?.message || err}`);
    }
}

/**
 * Event handler: MESSAGE_DELETED. If any working-buffer entry's provenance
 * references the deleted message, remove that entry from state.entries and
 * scrub its id from workingBuffer. Keeps the buffer in sync with what the
 * user actually sees.
 *
 * @param {number} messageId
 */
export async function onMessageDeleted(messageId) {
    if (!lastChatId) return;
    if (!Number.isInteger(messageId)) return;
    try {
        await withWriteLock(lastChatId, async () => {
            const state = await loadState(lastChatId);
            const buffer = state.workingBuffer || [];
            if (buffer.length === 0) return;

            /** @type {string[]} */
            const survivors = [];
            const dropped = new Set();
            for (const id of buffer) {
                const e = state.entries[id];
                if (e && Array.isArray(e.provenance?.sourceMessages)
                    && e.provenance.sourceMessages.includes(messageId)) {
                    dropped.add(id);
                } else {
                    survivors.push(id);
                }
            }
            if (dropped.size === 0) return;

            const nextEntries = { ...state.entries };
            for (const id of dropped) delete nextEntries[id];

            await persistState(lastChatId, {
                ...state,
                entries: nextEntries,
                workingBuffer: survivors,
            });
        });
    } catch (err) {
        log.warn(`onMessageDeleted error (swallowed): ${err?.message || err}`);
    }
}

/**
 * Wire event handlers. Called from index.js on APP_READY. Returns an
 * unsubscribe function for testing; production callers don't need to use it.
 *
 * @returns {() => void} unsubscribe
 */
export function bootstrap() {
    // Tear down any prior subscription.
    for (const u of unsubscribers) { try { u(); } catch { /* ignore */ } }
    unsubscribers = [];

    const ctx = resolveContext();

    // State backend — routes loadState/persistState through chatMetadata.
    setBackend(buildStateBackend());

    // Scorer from persisted settings (getSettings re-persists defaults on first call).
    const settings = getSettings();
    try { setScorer(settings.scorerId); } catch (err) {
        log.warn(`setScorer failed: ${err?.message || err}`);
    }

    // Seed lastChatId from current context.
    lastChatId = typeof ctx.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null;

    // Subscribe to events. ST uses snake_case `event_types`, not camelCase.
    const { eventSource, event_types } = ctx;
    if (!eventSource || typeof eventSource.on !== 'function') {
        log.warn('no eventSource in context — events will not fire');
        return () => {};
    }
    if (!event_types) {
        log.warn('no event_types in context — events will not fire');
        return () => {};
    }

    const subs = [
        [event_types.CHAT_CHANGED, onChatChanged],
        [event_types.MESSAGE_SENT, onMessageSent],
        [event_types.MESSAGE_RECEIVED, onMessageReceived],
        [event_types.MESSAGE_DELETED, onMessageDeleted],
    ];
    for (const [evt, handler] of subs) {
        if (!evt) continue;          // defensive: missing event name → skip
        eventSource.on(evt, handler);
        unsubscribers.push(() => {
            if (typeof eventSource.removeListener === 'function') {
                eventSource.removeListener(evt, handler);
            } else if (typeof eventSource.off === 'function') {
                eventSource.off(evt, handler);
            }
        });
    }

    log.info(`bootstrap complete (${unsubscribers.length} subscriptions)`);
    return () => {
        for (const u of unsubscribers) { try { u(); } catch { /* ignore */ } }
        unsubscribers = [];
    };
}
