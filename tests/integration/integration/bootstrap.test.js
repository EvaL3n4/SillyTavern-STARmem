/**
 * Bootstrap — event wiring, state backend, chat-switch hygiene, working-buffer growth.
 *
 * Non-JSDOM: operates on plain objects; the event-source is a mock with
 * real pub/sub semantics.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    bootstrap, buildStateBackend,
    onChatChanged, onMessageSent, onMessageReceived, onMessageDeleted, onMessageSwiped,
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
            MESSAGE_SWIPED: 'message_swiped',
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
    test('subscribes to five events on APP_READY', () => {
        bootstrap();
        expect(ctx.eventSource._handlers.get('chat_id_changed')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_sent')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_received')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_deleted')?.size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_swiped')?.size).toBe(1);
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

    test("skips type='first_message' replay (character greeting, not generated content)", async () => {
        // ST emits MESSAGE_RECEIVED with type='first_message' every time a
        // 1-message chat is loaded — chat switch, swipe-back-to-greeting,
        // character switch, ST restart. See script.js#getChatResult and
        // group-chats.js. Without this skip, the same entry gets re-added
        // on every load.
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'character greeting' },
        ];
        await onMessageReceived(0, 'first_message');
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(0);
        expect(Object.keys(state.entries)).toHaveLength(0);
    });

    test('captures normal replies even when type is omitted (back-compat)', async () => {
        // Older ST versions or non-standard emit sites may pass undefined as
        // the type arg; we still want to capture those as working memory.
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'hi' },
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'reply' },
        ];
        await onMessageReceived(1);  // no type arg
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(1);
    });

    test("captures normal replies when type is 'normal' or other non-first_message", async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'hi' },
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'reply' },
        ];
        await onMessageReceived(1, 'normal');
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(1);
    });

    describe('reasoning/CoT strip', () => {
        // Mimic ST's parseReasoningFromString: returns { reasoning, content }
        // when prefix/suffix match; passthrough { reasoning: '', content: raw }
        // otherwise. Custom template support is the whole point of this hook.
        function makeParser({ prefix, suffix }) {
            return (str) => {
                if (typeof str !== 'string') return { reasoning: '', content: '' };
                const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`${escape(prefix)}([\\s\\S]*?)${escape(suffix)}`);
                const m = str.match(re);
                if (!m) return { reasoning: '', content: str };
                return {
                    reasoning: m[1].trim(),
                    content: str.replace(re, '').trim(),
                };
            };
        }

        test("strips default <think>…</think> block before storing as working entry", async () => {
            ctx.parseReasoningFromString = makeParser({ prefix: '<think>', suffix: '</think>' });
            bootstrap();
            ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
            ctx.chat = [
                { name: 'c', is_user: false, is_system: false, send_date: '', mes: '<think>plan a reply</think>\n\nHello there.' },
            ];
            await onMessageReceived(0, 'normal');
            const state = await loadState('chat-A');
            expect(state.workingBuffer).toHaveLength(1);
            const [id] = state.workingBuffer;
            expect(state.entries[id].content).toBe('Hello there.');
        });

        test('honours custom user-defined reasoning template (not just <think>)', async () => {
            // User configured a non-default template via SillyTavern's
            // reasoning settings — e.g. [REASONING]…[/REASONING]. STARmem
            // must not hardcode <think>; it has to ask ST.
            ctx.parseReasoningFromString = makeParser({
                prefix: '[REASONING]',
                suffix: '[/REASONING]',
            });
            bootstrap();
            ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
            ctx.chat = [
                {
                    name: 'c', is_user: false, is_system: false, send_date: '',
                    mes: '[REASONING]secret thoughts[/REASONING]\nVisible answer.',
                },
            ];
            await onMessageReceived(0, 'normal');
            const state = await loadState('chat-A');
            const [id] = state.workingBuffer;
            expect(state.entries[id].content).toBe('Visible answer.');
        });

        test('passes raw mes through when no reasoning block matches', async () => {
            ctx.parseReasoningFromString = makeParser({ prefix: '<think>', suffix: '</think>' });
            bootstrap();
            ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
            ctx.chat = [
                { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'plain reply, no CoT' },
            ];
            await onMessageReceived(0, 'normal');
            const state = await loadState('chat-A');
            const [id] = state.workingBuffer;
            expect(state.entries[id].content).toBe('plain reply, no CoT');
        });

        test('skips capture when message is only a reasoning block (empty after strip)', async () => {
            ctx.parseReasoningFromString = makeParser({ prefix: '<think>', suffix: '</think>' });
            bootstrap();
            ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
            ctx.chat = [
                { name: 'c', is_user: false, is_system: false, send_date: '', mes: '<think>only thoughts, no answer yet</think>' },
            ];
            await onMessageReceived(0, 'normal');
            const state = await loadState('chat-A');
            expect(state.workingBuffer).toHaveLength(0);
        });

        test('falls back to raw mes when parser is missing on context (back-compat)', async () => {
            // Older ST builds don't expose parseReasoningFromString on the
            // context. We must not crash and must still capture the reply.
            // Note: ctx has no parseReasoningFromString here.
            bootstrap();
            ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
            ctx.chat = [
                { name: 'c', is_user: false, is_system: false, send_date: '', mes: '<think>raw</think>\nbody' },
            ];
            await onMessageReceived(0, 'normal');
            const state = await loadState('chat-A');
            expect(state.workingBuffer).toHaveLength(1);
            const [id] = state.workingBuffer;
            // No strip happened — that's the back-compat contract.
            expect(state.entries[id].content).toBe('<think>raw</think>\nbody');
        });

        test('falls back to raw mes when parser throws', async () => {
            ctx.parseReasoningFromString = () => { throw new Error('boom'); };
            bootstrap();
            ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
            ctx.chat = [
                { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'reply with no CoT' },
            ];
            await onMessageReceived(0, 'normal');
            const state = await loadState('chat-A');
            expect(state.workingBuffer).toHaveLength(1);
            const [id] = state.workingBuffer;
            expect(state.entries[id].content).toBe('reply with no CoT');
        });
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

describe('onMessageSwiped', () => {
    test('drops working entries whose provenance references the swiped messageId', async () => {
        bootstrap();
        // Seed two working entries: one for the swiped mesId (4), one for an
        // unrelated mesId (6). Only the former should be evicted.
        const state = createEmptyState();
        /** @type {any} */
        const swiped = {
            id: 'w-swiped', scope: 'working', content: 'rejected draft',
            subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [4], extractor: 'x' },
            lifecycle: {
                importance: 50, maturity: 'draft',
                createdAt: '2026-04-30T10:00:00Z', updatedAt: '2026-04-30T10:00:00Z',
                accessCount: 0, updateCount: 0,
            },
        };
        /** @type {any} */
        const unrelated = {
            ...swiped,
            id: 'w-unrelated', content: 'older reply',
            provenance: { sourceMessages: [6], extractor: 'x' },
        };
        state.entries = { 'w-swiped': swiped, 'w-unrelated': unrelated };
        state.workingBuffer = ['w-swiped', 'w-unrelated'];
        ctx.chatMetadata['STARmem'] = { 'chat-A': state };

        await onMessageSwiped(4);

        const after = await loadState('chat-A');
        expect(after.workingBuffer).toEqual(['w-unrelated']);
        expect(after.entries['w-swiped']).toBeUndefined();
        expect(after.entries['w-unrelated']).toBeDefined();
    });

    test('leaves non-working entries untouched (no retroactive episodic surgery)', async () => {
        // Already-consolidated entries that happen to reference the swiped
        // mesId in their provenance must NOT be evicted by a swipe — once a
        // fact has graduated to episodic, the user controls deletion via the
        // (forthcoming) memory-management UI, not via swipe side effects.
        bootstrap();
        const state = createEmptyState();
        /** @type {any} */
        const episodic = {
            id: 'e1', scope: 'episodic', content: 'graduated fact',
            subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [4], extractor: 'consolidation-v1' },
            lifecycle: {
                importance: 70, maturity: 'mature',
                createdAt: '2026-04-30T09:00:00Z', updatedAt: '2026-04-30T09:00:00Z',
                accessCount: 0, updateCount: 0,
            },
        };
        state.entries = { e1: episodic };
        // workingBuffer is empty — episodic entries don't live there.
        state.workingBuffer = [];
        ctx.chatMetadata['STARmem'] = { 'chat-A': state };

        await onMessageSwiped(4);

        const after = await loadState('chat-A');
        expect(after.entries.e1).toBeDefined();
        expect(after.entries.e1.scope).toBe('episodic');
    });

    test('no-op when no working entry matches the swiped messageId', async () => {
        bootstrap();
        const state = createEmptyState();
        /** @type {any} */
        const e1 = {
            id: 'w1', scope: 'working', content: 'one',
            subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [4], extractor: 'x' },
            lifecycle: {
                importance: 50, maturity: 'draft',
                createdAt: '2026-04-30T10:00:00Z', updatedAt: '2026-04-30T10:00:00Z',
                accessCount: 0, updateCount: 0,
            },
        };
        state.entries = { w1: e1 };
        state.workingBuffer = ['w1'];
        ctx.chatMetadata['STARmem'] = { 'chat-A': state };

        await onMessageSwiped(999);

        const after = await loadState('chat-A');
        expect(after.workingBuffer).toEqual(['w1']);
        expect(after.entries.w1).toBeDefined();
    });

    test('no-op when no lastChatId', async () => {
        // No bootstrap() — lastChatId stays null.
        await onMessageSwiped(4);
        expect(ctx.chatMetadata['STARmem']).toBeUndefined();
    });

    test('ignores non-integer messageId', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        await onMessageSwiped(/** @type {any} */ ('not a number'));
        const after = await loadState('chat-A');
        expect(after.workingBuffer).toEqual([]);
    });
});

describe('idle timer wiring', () => {
    // These tests prove the handlers call resetIdleTimer — the trigger
    // mechanism itself is exhaustively covered in tests/unit/consolidation/
    // triggers.test.js. Here we only assert that user activity (sending or
    // swiping) actually arms the timer; a leaked or skipped reset is the
    // bug shape these tests catch.

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('onMessageSent arms the idle timer', () => {
        bootstrap();
        // bootstrap() itself does not arm the idle timer.
        expect(jest.getTimerCount()).toBe(0);

        onMessageSent(0);
        // Exactly one outstanding timer: the idle countdown.
        expect(jest.getTimerCount()).toBe(1);
    });

    test('onMessageSwiped arms the idle timer (swipe is engagement, not idleness)', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        expect(jest.getTimerCount()).toBe(0);

        await onMessageSwiped(0);
        expect(jest.getTimerCount()).toBe(1);
    });

    test('onMessageSwiped DEBOUNCES — a swipe within the idle window pushes the deadline back', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };

        // Arm the timer via a normal message.
        onMessageSent(0);
        // Advance most of the way to the idle threshold (60s default).
        jest.advanceTimersByTime(59_000);
        // Swipe — should reset the deadline.
        await onMessageSwiped(0);
        // Advance another 59s — total 118s wall-clock, but only 59s since
        // the swipe. The idle timer must NOT have fired yet.
        jest.advanceTimersByTime(59_000);
        // One outstanding timer survives — the post-swipe one.
        expect(jest.getTimerCount()).toBe(1);
    });

    test('onMessageSwiped no-op (no lastChatId) does not arm a timer', async () => {
        // No bootstrap() — lastChatId stays null.
        await onMessageSwiped(0);
        expect(jest.getTimerCount()).toBe(0);
    });
});
