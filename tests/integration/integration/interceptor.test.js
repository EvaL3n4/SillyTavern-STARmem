/**
 * Interceptor — pre-generate retrieval + chat[-4] injection.
 *
 * Non-JSDOM: mocks SillyTavern.getContext() and operates on plain arrays.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    starmemInterceptor, extractLastUserQuery, formatMemoryMessage,
    buildInjectionMessage, computeInjectionPosition,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/interceptor.js';
import { INJECTION_KEY } from '../../../src/integration/constants.js';
import { INJECTION_DEPTH } from '../../../src/core/constants.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {Map<string, unknown>} */
let store;

function makeChat(userText) {
    return [
        { name: 'char', is_user: false, is_system: false, send_date: 'd1', mes: 'Hi there' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd2', mes: 'Hello' },
        { name: 'char', is_user: false, is_system: false, send_date: 'd3', mes: 'How are you?' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd4', mes: 'Good' },
        { name: 'char', is_user: false, is_system: false, send_date: 'd5', mes: 'Glad' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd6', mes: userText },
    ];
}

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _setContextForTests({ chatId: 'chat-A' });
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetContextForTests();
});

describe('interceptor — pure helpers', () => {
    test('extractLastUserQuery returns the last is_user=true mes', () => {
        const chat = makeChat('latest question');
        expect(extractLastUserQuery(chat)).toBe('latest question');
    });

    test('extractLastUserQuery returns null when no user messages', () => {
        const chat = [{ name: 'char', is_user: false, is_system: false, send_date: '', mes: 'hi' }];
        expect(extractLastUserQuery(chat)).toBeNull();
    });

    test('extractLastUserQuery returns null for empty or non-array', () => {
        expect(extractLastUserQuery([])).toBeNull();
        expect(extractLastUserQuery(/** @type {any} */ (null))).toBeNull();
    });

    test('extractLastUserQuery skips whitespace-only user messages', () => {
        const chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'real query' },
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: '   ' },
        ];
        expect(extractLastUserQuery(chat)).toBe('real query');
    });

    test('formatMemoryMessage renders bullet list with scope labels', () => {
        const text = formatMemoryMessage([
            { id: '1', content: 'Alice likes coffee', scope: 'persona' },
            { id: '2', content: 'Alice went to Paris', scope: 'episodic' },
        ]);
        expect(text).toContain('[STARmem] Retrieved memories:');
        expect(text).toContain('- [persona] Alice likes coffee');
        expect(text).toContain('- [episodic] Alice went to Paris');
    });

    test('formatMemoryMessage returns empty string for zero entries', () => {
        expect(formatMemoryMessage([])).toBe('');
    });

    test('buildInjectionMessage marks the system message with INJECTION_KEY', () => {
        const m = buildInjectionMessage('hello');
        expect(m.is_user).toBe(false);
        expect(m.is_system).toBe(true);
        expect(m.mes).toBe('hello');
        expect(m.extra?.[INJECTION_KEY]).toBe(true);
    });

    test('computeInjectionPosition clamps at 0 for short chats', () => {
        expect(computeInjectionPosition(0, 4)).toBe(0);
        expect(computeInjectionPosition(3, 4)).toBe(0);
        expect(computeInjectionPosition(4, 4)).toBe(0);
    });

    test('computeInjectionPosition returns length - depth for long chats', () => {
        expect(computeInjectionPosition(10, 4)).toBe(6);
        expect(computeInjectionPosition(100, 4)).toBe(96);
    });
});

describe('interceptor — flow', () => {
    test('no chatId → no-op, chat unchanged', async () => {
        _setContextForTests({ chatId: null });
        const chat = makeChat('anything');
        const before = chat.length;
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(before);
    });

    test('no user query → no-op, chat unchanged', async () => {
        const chat = [{ name: 'c', is_user: false, is_system: false, send_date: '', mes: 'hi' }];
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(1);
    });

    test('empty retrieval result → no injection', async () => {
        store.set('chat-A', createEmptyState());  // no entries
        const chat = makeChat('anything');
        const before = chat.length;
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(before);
    });

    test('injects at chat.length - INJECTION_DEPTH when entries returned', async () => {
        const now = new Date('2026-04-20T10:00:00Z');
        const entry = createEntry({
            scope: 'episodic', content: 'alice traveled to paris', subject: 'alice',
            tags: ['paris', 'travel'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [entry.id]: entry },
        });

        const chat = makeChat('tell me about paris');
        const expectedPos = chat.length - INJECTION_DEPTH;  // = 2
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        expect(chat.length).toBe(7);
        expect(chat[expectedPos].is_system).toBe(true);
        expect(chat[expectedPos].extra?.[INJECTION_KEY]).toBe(true);
        expect(chat[expectedPos].mes).toContain('[STARmem] Retrieved memories:');
    });

    test('short chat → injected at position 0', async () => {
        const now = new Date();
        const entry = createEntry({
            scope: 'episodic', content: 'alice likes coffee', subject: 'alice',
            tags: ['coffee'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [entry.id]: entry },
        });

        const chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'what does alice like' },
        ];
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        expect(chat.length).toBe(2);
        expect(chat[0].is_system).toBe(true);
    });

    test('applyAccessEvent fires for returned entries (exactly once via ladder)', async () => {
        const now = new Date('2026-04-20T10:00:00Z');
        const entry = createEntry({
            scope: 'episodic', content: 'alice likes coffee', subject: 'alice',
            tags: ['coffee'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        const initialAccessCount = entry.lifecycle.accessCount;
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [entry.id]: entry },
        });

        const chat = makeChat('what does alice like');
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        const after = await loadState('chat-A');
        const stored = after.entries[entry.id];
        // Entry was returned → access count bumped exactly once (by ladder).
        expect(stored.lifecycle.accessCount).toBe(initialAccessCount + 1);
    });

    test('access event does NOT fire for non-returned candidates', async () => {
        const now = new Date('2026-04-20T10:00:00Z');
        const matched = createEntry({
            scope: 'episodic', content: 'alice likes coffee', subject: 'alice',
            tags: ['coffee'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        const irrelevant = createEntry({
            scope: 'episodic', content: 'bob plays chess', subject: 'bob',
            tags: ['chess'], relations: [],
            provenance: { sourceMessages: [1], extractor: 't@v1' },
            now,
        });
        const irrelevantAccessBefore = irrelevant.lifecycle.accessCount;
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [matched.id]: matched, [irrelevant.id]: irrelevant },
        });

        const chat = makeChat('what does alice like');
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        const after = await loadState('chat-A');
        // Irrelevant entry wasn't returned → access count unchanged.
        expect(after.entries[irrelevant.id].lifecycle.accessCount).toBe(irrelevantAccessBefore);
    });

    test('thrown errors are swallowed — chat is never corrupted', async () => {
        // Force an error by feeding a bogus backend that throws on read.
        setBackend({
            read: () => { throw new Error('BOOM'); },
            write: () => {},
        });
        const chat = makeChat('anything');
        const before = JSON.stringify(chat);
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        // Chat must be untouched.
        expect(JSON.stringify(chat)).toBe(before);
    });
});
