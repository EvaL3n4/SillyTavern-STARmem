/**
 * Bootstrap — event wiring, state backend, chat-switch hygiene, working-buffer growth.
 *
 * Non-JSDOM: operates on plain objects; the event-source is a mock with
 * real pub/sub semantics.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    bootstrap, buildStateBackend,
    onChatChanged, onMessageSent, onMessageReceived, onMessageDeleted,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/bootstrap.js';
import {
    _setContextForTests as _setSettingsCtx,
    _resetContextForTests as _resetSettingsCtx,
} from '../../../src/integration/settings.js';
import { SETTINGS_KEY, SETTINGS_DEFAULTS } from '../../../src/integration/constants.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetTimersForTests } from '../../../src/consolidation/triggers.js';
import { _resetScorerForTests } from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';

/** Simple event-source stub that matches ST's API (on / removeListener / emit). */
function makeEventSource() {
    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();
    return {
        on: (evt, h) => {
            if (!handlers.has(evt)) handlers.set(evt, new Set());
            handlers.get(evt).add(h);
        },
        removeListener: (evt, h) => { handlers.get(evt)?.delete(h); },
        emit: async (evt, ...args) => {
            const hs = handlers.get(evt) || new Set();
            for (const h of [...hs]) await h(...args);
        },
        _handlers: handlers,
    };
}

function makeContext({ chatId = 'chat-A', chat = [], chatMetadata = {} } = {}) {
    return {
        chatId, chat, chatMetadata,
        extensionSettings: {},
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        eventSource: makeEventSource(),
        event_types: {
            CHAT_CHANGED: 'chat_id_changed',
            MESSAGE_SENT: 'message_sent',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_DELETED: 'message_deleted',
        },
    };
}

/** @type {ReturnType<typeof makeContext>} */
let ctx;

beforeEach(() => {
    ctx = makeContext();
    _setContextForTests(ctx);
    _setSettingsCtx({
        extensionSettings: ctx.extensionSettings,
        saveSettingsDebounced: ctx.saveSettingsDebounced,
    });
    _resetLocksForTests();
    _resetTimersForTests();
    _resetScorerForTests();
});

afterEach(() => {
    _resetContextForTests();
    _resetSettingsCtx();
    _resetBackendForTests();
    _resetLocksForTests();
    _resetTimersForTests();
    _resetScorerForTests();
});

describe('buildStateBackend', () => {
    test('read returns undefined when chatMetadata has no STARmem slot', () => {
        const be = buildStateBackend();
        expect(be.read('any')).toBeUndefined();
    });

    test('write creates the STARmem slot and persists', () => {
        const be = buildStateBackend();
        be.write('chat-A', { ...createEmptyState() });
        expect(ctx.chatMetadata['STARmem']['chat-A']).toBeDefined();
        expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
    });

    test('read round-trips what write stored', () => {
        const be = buildStateBackend();
        const s = { ...createEmptyState(), entries: { x: { id: 'x' } } };
        be.write('chat-A', s);
        const back = be.read('chat-A');
        expect(back).toEqual(s);
    });
});

describe('bootstrap', () => {
    test('subscribes to four events on APP_READY', () => {
        bootstrap();
        expect(ctx.eventSource._handlers.get('chat_id_changed')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_sent')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_received')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_deleted')?.size).toBe(1);
    });

    test('double-call idempotently replaces subscriptions (no leak)', () => {
        bootstrap();
        bootstrap();
        expect(ctx.eventSource._handlers.get('chat_id_changed')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_received')?.size).toBe(1);
    });

    test('returns an unsubscribe function that removes handlers', () => {
        const off = bootstrap();
        off();
        expect(ctx.eventSource._handlers.get('chat_id_changed')?.size).toBe(0);
    });

    test('persists default settings on first call', () => {
        bootstrap();
        expect(ctx.extensionSettings[SETTINGS_KEY]).toEqual(SETTINGS_DEFAULTS);
    });

    test('installs state backend routing through chatMetadata', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = {
            'chat-A': { ...createEmptyState(), entries: { foo: { id: 'foo' } } },
        };
        const s = await loadState('chat-A');
        expect(s.entries.foo).toBeDefined();
    });

    test('does not throw when eventSource is missing', () => {
        _setContextForTests({ ...ctx, eventSource: null });
        expect(() => bootstrap()).not.toThrow();
    });

    test('does not throw when event_types is missing', () => {
        _setContextForTests({ ...ctx, event_types: null });
        expect(() => bootstrap()).not.toThrow();
    });
});

describe('onChatChanged', () => {
    test('updates lastChatId and does not throw on subsequent MESSAGE_SENT', async () => {
        bootstrap();  // seeds lastChatId = 'chat-A'
        await onChatChanged('chat-B');
        // Subsequent MESSAGE_SENT should attempt to reset timer on chat-B.
        expect(() => onMessageSent(0)).not.toThrow();
    });

    test('handles null/undefined newChatId defensively', async () => {
        bootstrap();
        await onChatChanged(/** @type {any} */ (null));
        // lastChatId is now null; MESSAGE_SENT should no-op cleanly.
        expect(() => onMessageSent(0)).not.toThrow();
    });
});

describe('onMessageReceived', () => {
    test('appends a working-scoped entry for the assistant reply', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'user msg' },
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'assistant msg' },
        ];
        await onMessageReceived(1);
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(1);
        const [id] = state.workingBuffer;
        const entry = state.entries[id];
        expect(entry).toBeDefined();
        expect(entry.scope).toBe('working');
        expect(entry.content).toBe('assistant msg');
        expect(entry.provenance.sourceMessages).toEqual([1]);
    });

    test('skips if target message is from user', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'a' },
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'b' },
        ];
        await onMessageReceived(1);
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(0);
    });

    test('skips if message content is empty or whitespace', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: '   ' },
        ];
        await onMessageReceived(0);
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(0);
    });

    test('falls back to last message when messageId is out of range', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'reply' },
        ];
        await onMessageReceived(99);  // out of range → fall back to last
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(1);
    });

    test('no-op when no lastChatId', async () => {
        // No bootstrap() — lastChatId is null.
        ctx.chat = [{ name: 'c', is_user: false, is_system: false, send_date: '', mes: 'x' }];
        await onMessageReceived(0);
        // Nothing thrown, nothing persisted.
        expect(ctx.chatMetadata['STARmem']).toBeUndefined();
    });
});

describe('onMessageDeleted', () => {
    test('removes entry from state.entries and scrubs workingBuffer', async () => {
        bootstrap();
        // Seed state with two working entries whose provenance ties them to
        // different ST message indices.
        const state = createEmptyState();
        /** @type {any} */
        const e1 = {
            id: 'w1', scope: 'working', content: 'one', subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [4], extractor: 'x' },
            lifecycle: {
                importance: 50, maturity: 'draft',
                createdAt: '2026-04-21T10:00:00Z', updatedAt: '2026-04-21T10:00:00Z',
                accessCount: 0, updateCount: 0,
            },
        };
        /** @type {any} */
        const e2 = {
            ...e1,
            id: 'w2', content: 'two',
            provenance: { sourceMessages: [6], extractor: 'x' },
        };
        state.entries = { w1: e1, w2: e2 };
        state.workingBuffer = ['w1', 'w2'];
        ctx.chatMetadata['STARmem'] = { 'chat-A': state };

        await onMessageDeleted(6);

        const after = await loadState('chat-A');
        expect(after.workingBuffer).toEqual(['w1']);
        expect(after.entries.w1).toBeDefined();
        expect(after.entries.w2).toBeUndefined();
    });

    test('no-op when messageId does not match any buffer entry', async () => {
        bootstrap();
        const state = createEmptyState();
        /** @type {any} */
        const e1 = {
            id: 'w1', scope: 'working', content: 'one', subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [4], extractor: 'x' },
            lifecycle: {
                importance: 50, maturity: 'draft',
                createdAt: '2026-04-21T10:00:00Z', updatedAt: '2026-04-21T10:00:00Z',
                accessCount: 0, updateCount: 0,
            },
        };
        state.entries = { w1: e1 };
        state.workingBuffer = ['w1'];
        ctx.chatMetadata['STARmem'] = { 'chat-A': state };

        await onMessageDeleted(999);

        const after = await loadState('chat-A');
        expect(after.workingBuffer).toEqual(['w1']);
        expect(after.entries.w1).toBeDefined();
    });

    test('no-op when no lastChatId', async () => {
        // No bootstrap.
        await onMessageDeleted(6);
        expect(ctx.chatMetadata['STARmem']).toBeUndefined();
    });

    test('ignores non-integer messageId', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        await onMessageDeleted(/** @type {any} */ ('not a number'));
        // No throw, state intact (empty).
        const after = await loadState('chat-A');
        expect(after.workingBuffer).toEqual([]);
    });
});
