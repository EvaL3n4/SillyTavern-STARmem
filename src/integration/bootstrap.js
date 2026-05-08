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
import { registerStarmemMacro } from './macro.js';
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

/** Reserved keys that would collide with Object.prototype if used as map keys. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Guard against prototype pollution from tampered or imported chat metadata.
 * @param {string} id
 */
function assertSafeChatId(id) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('[STARmem] invalid chatId (must be non-empty string)');
    }
    if (RESERVED_KEYS.has(id)) {
        throw new Error(`[STARmem] reserved key '${id}' not allowed as chatId`);
    }
}

/**
 * Build the canonical state backend that reads + writes chatMetadata via ST.
 *
 * @returns {{ read: (id: string) => unknown, write: (id: string, v: unknown) => void }}
 */
export function buildStateBackend() {
    return {
        read: (id) => {
            assertSafeChatId(id);
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') return undefined;
            const slot = cm['STARmem'];
            if (!slot || typeof slot !== 'object') return undefined;
            return slot[id];
        },
        write: (id, value) => {
            assertSafeChatId(id);
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') {
                throw new Error('[STARmem] chatMetadata not available — cannot persist');
            }
            if (!cm['STARmem'] || typeof cm['STARmem'] !== 'object') {
                // Object.create(null) — even if assertSafeChatId is ever
                // bypassed, prototype keys can't collide with inherited props.
                cm['STARmem'] = Object.create(null);
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
 * Skips replays of the character's first message: ST emits MESSAGE_RECEIVED
 * with `type === 'first_message'` every time a 1-message chat is loaded
 * (chat switch, swipe-back-to-greeting, character switch, ST restart — see
 * script.js#getChatResult and group-chats.js). Capturing it as memory is
 * wrong (it's character-card lore, not generated content) and would re-add
 * the same entry on every load.
 *
 * @param {number} messageId - ST's chat index for the newly-received message
 * @param {string} [type] - generation type; 'first_message' indicates a replay
 */
export async function onMessageReceived(messageId, type) {
    if (!lastChatId) return;
    if (type === 'first_message') {
        log.debug('skipping first_message replay (character greeting, not generated content)');
        return;
    }
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

        // Strip inline CoT/reasoning blocks (e.g. <think>…</think>, custom
        // user-defined prefix/suffix templates) so we don't capture the
        // model's chain-of-thought as memory. ST exposes a parser bound to
        // power_user.reasoning, which honours custom templates regardless
        // of whether auto_parse is enabled or which extension wins the
        // MESSAGE_RECEIVED listener race.
        let content = received.mes;
        const parseReasoning = typeof ctx.parseReasoningFromString === 'function'
            ? ctx.parseReasoningFromString
            : null;
        if (parseReasoning) {
            try {
                const parsed = parseReasoning(received.mes, { strict: false });
                // A non-null parsed result means the parser ran. If it
                // extracted reasoning OR rewrote content, trust its content
                // (even when empty — empty after strip means "only CoT,
                // nothing worth memorising").
                if (parsed && typeof parsed.content === 'string'
                    && (parsed.reasoning || parsed.content !== received.mes)) {
                    content = parsed.content;
                }
            } catch (err) {
                log.debug(`reasoning strip failed (using raw mes): ${err?.message || err}`);
            }
        }
        if (typeof content !== 'string' || content.trim().length === 0) return;

        const now = new Date();
        const entry = createEntry({
            scope: 'working',
            content,
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
 * Event handler: MESSAGE_SWIPED. The user swiped a message to a different
 * variant (existing or freshly-generated). Drop every working-buffer entry
 * whose provenance references this messageId — the prior generation's
 * content is no longer what the user sees, and consolidating it would
 * pollute long-term memory with rejected drafts.
 *
 * Mirrors onMessageDeleted's scrub-and-trim pattern, with two differences:
 *
 *   1. Only `scope: 'working'` entries are eligible for eviction. Already-
 *      consolidated entries (episodic, persona) that happen to reference
 *      this messageId in their provenance stay put — once a fact has
 *      graduated to long-term memory, the user controls deletion via the
 *      forthcoming memory-management UI, not via swipe side effects.
 *   2. The idle timer is reset: swiping is user activity, not idleness.
 *
 * New content (when the swipe triggers fresh generation) lands via the
 * subsequent MESSAGE_RECEIVED with type='swipe'. Swiping back to an
 * existing variant emits no MESSAGE_RECEIVED — that case intentionally
 * leaves the working buffer without a per-mesId entry; Tier 2 BM25 over
 * chat history still surfaces the content.
 *
 * @param {number} messageId
 */
export async function onMessageSwiped(messageId) {
    if (!lastChatId) return;
    if (!Number.isInteger(messageId)) return;
    try {
        // Reset idle timer: swiping is engagement, not idleness.
        try { resetIdleTimer(lastChatId, buildConsolidateOpts()); }
        catch (err) { log.warn(`resetIdleTimer on swipe failed: ${err?.message || err}`); }

        await withWriteLock(lastChatId, async () => {
            const state = await loadState(lastChatId);
            const buffer = state.workingBuffer || [];
            if (buffer.length === 0) return;

            /** @type {string[]} */
            const survivors = [];
            const dropped = new Set();
            for (const id of buffer) {
                const e = state.entries[id];
                if (e && e.scope === 'working'
                    && Array.isArray(e.provenance?.sourceMessages)
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
            log.info(`onMessageSwiped: dropped ${dropped.size} working entries for mesId=${messageId}`);
        });
    } catch (err) {
        log.warn(`onMessageSwiped error (swallowed): ${err?.message || err}`);
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

    // Register the {{starmem-memories}} macro. Idempotent — safe to call on
    // every bootstrap. Fire-and-forget; the macro lookup is dynamic-imported
    // and we don't want to block bootstrap on it.
    registerStarmemMacro().catch(err =>
        log.warn(`registerStarmemMacro failed: ${err?.message || err}`));

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
        [event_types.MESSAGE_SWIPED, onMessageSwiped],
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
