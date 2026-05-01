/**
 * Interceptor — pre-generate retrieval + setExtensionPrompt injection.
 *
 * Non-JSDOM: mocks SillyTavern.getContext() and operates on plain arrays.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    starmemInterceptor, extractLastUserQuery, formatMemoryMessage, injectMemoryPrompt,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/interceptor.js';
import {
    INJECTION_PROMPT_KEY, INJECTION_DEPTH, INJECTION_POSITION_IN_CHAT, INJECTION_ROLE_SYSTEM,
} from '../../../src/integration/constants.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {Map<string, unknown>} */
let store;
/** @type {jest.Mock} */
let setExtensionPrompt;

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
    setExtensionPrompt = jest.fn();
    _setContextForTests({ chatId: 'chat-A', setExtensionPrompt });
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

    test('injectMemoryPrompt registers with stable key, IN_CHAT depth, SYSTEM role', () => {
        const fn = jest.fn();
        injectMemoryPrompt(fn, 'hello body');
        expect(fn).toHaveBeenCalledTimes(1);
        const [key, value, position, depth, scan, role] = fn.mock.calls[0];
        expect(key).toBe(INJECTION_PROMPT_KEY);
        expect(value).toBe('hello body');
        expect(position).toBe(INJECTION_POSITION_IN_CHAT);
        expect(depth).toBe(INJECTION_DEPTH);
        expect(scan).toBe(false);
        expect(role).toBe(INJECTION_ROLE_SYSTEM);
    });

    test('injectMemoryPrompt coerces non-string body to empty string', () => {
        const fn = jest.fn();
        injectMemoryPrompt(fn, /** @type {any} */ (null));
        expect(fn.mock.calls[0][1]).toBe('');
    });
});

describe('interceptor — flow', () => {
    test('no chatId → clears injection slot, chat unchanged', async () => {
        _setContextForTests({ chatId: null, setExtensionPrompt });
        const chat = makeChat('anything');
        const before = chat.length;
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(before);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        expect(setExtensionPrompt.mock.calls[0][1]).toBe('');
    });

    test('no user query → clears injection slot, chat unchanged', async () => {
        const chat = [{ name: 'c', is_user: false, is_system: false, send_date: '', mes: 'hi' }];
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(1);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        expect(setExtensionPrompt.mock.calls[0][1]).toBe('');
    });

    test('empty retrieval result → registers empty body (clears slot)', async () => {
        store.set('chat-A', createEmptyState());  // no entries
        const chat = makeChat('anything');
        const before = chat.length;
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(before);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const [key, value, position, depth, scan, role] = setExtensionPrompt.mock.calls[0];
        expect(key).toBe(INJECTION_PROMPT_KEY);
        expect(value).toBe('');
        expect(position).toBe(INJECTION_POSITION_IN_CHAT);
        expect(depth).toBe(INJECTION_DEPTH);
        expect(scan).toBe(false);
        expect(role).toBe(INJECTION_ROLE_SYSTEM);
    });

    test('retrieval hits → registers formatted body, never mutates chat', async () => {
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
        const before = JSON.stringify(chat);
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        // Chat untouched.
        expect(JSON.stringify(chat)).toBe(before);

        // Injection registered with the right shape.
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const [key, value, position, depth, scan, role] = setExtensionPrompt.mock.calls[0];
        expect(key).toBe(INJECTION_PROMPT_KEY);
        expect(value).toContain('[STARmem] Retrieved memories:');
        expect(value).toContain('alice traveled to paris');
        expect(position).toBe(INJECTION_POSITION_IN_CHAT);
        expect(depth).toBe(INJECTION_DEPTH);
        expect(scan).toBe(false);
        expect(role).toBe(INJECTION_ROLE_SYSTEM);
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
        expect(after.entries[irrelevant.id].lifecycle.accessCount).toBe(irrelevantAccessBefore);
    });

    test('thrown errors are swallowed — chat is never corrupted, slot is cleared', async () => {
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
        // The error path should also clear the prior injection so stale
        // memories don't leak into the next turn.
        expect(setExtensionPrompt).toHaveBeenCalled();
        const lastCall = setExtensionPrompt.mock.calls[setExtensionPrompt.mock.calls.length - 1];
        expect(lastCall[1]).toBe('');
    });

    test('missing setExtensionPrompt in context → no crash, no injection', async () => {
        _setContextForTests({ chatId: 'chat-A', setExtensionPrompt: null });
        store.set('chat-A', createEmptyState());
        const chat = makeChat('anything');
        await expect(starmemInterceptor(chat, 4096, () => {}, 'normal')).resolves.toBeUndefined();
    });

    test("threads ST's generation type into the retrieval trace as `cause`", async () => {
        // The Memory Viewer's Traces tab uses trace.cause to render a small
        // "swipe / continue / regen" badge so internal users don't read
        // consecutive identical traces as the working buffer re-growing.
        // The interceptor must forward ST's `type` arg verbatim.
        store.set('chat-A', createEmptyState());
        const chat = makeChat('anything');
        await starmemInterceptor(chat, 4096, () => {}, 'swipe');
        const after = await loadState('chat-A');
        const traces = after.runtime?.traces ?? [];
        expect(traces.length).toBeGreaterThan(0);
        expect(traces[traces.length - 1].cause).toBe('swipe');
    });

    test("missing/empty type defaults to cause='normal'", async () => {
        store.set('chat-A', createEmptyState());
        const chat = makeChat('anything');
        await starmemInterceptor(chat, 4096, () => {});  // no type arg
        const after = await loadState('chat-A');
        const traces = after.runtime?.traces ?? [];
        expect(traces[traces.length - 1].cause).toBe('normal');
    });
});
