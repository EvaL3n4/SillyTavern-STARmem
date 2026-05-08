/** @jest-environment jsdom */
/**
 * STARmem `{{starmem-memories}}` macro — body cache + handler.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    setMemoryBody, getMemoryBody, memoriesMacroHandler,
    _setContextForTests, _resetContextForTests, _clearMemoryBodiesForTests,
} from '../../../src/integration/macro.js';

beforeEach(() => {
    _clearMemoryBodiesForTests();
});

afterEach(() => {
    _resetContextForTests();
});

describe('macro — body cache', () => {
    test('setMemoryBody / getMemoryBody round-trip', () => {
        setMemoryBody('chat-A', 'hello world');
        expect(getMemoryBody('chat-A')).toBe('hello world');
    });

    test('getMemoryBody returns "" for unknown chat', () => {
        expect(getMemoryBody('chat-Z')).toBe('');
    });

    test('per-chat isolation', () => {
        setMemoryBody('chat-A', 'A-body');
        setMemoryBody('chat-B', 'B-body');
        expect(getMemoryBody('chat-A')).toBe('A-body');
        expect(getMemoryBody('chat-B')).toBe('B-body');
    });

    test('non-string body coerced to ""', () => {
        setMemoryBody('chat-A', /** @type {any} */ (null));
        expect(getMemoryBody('chat-A')).toBe('');
    });

    test('empty/invalid chatId is a no-op', () => {
        setMemoryBody('', 'should not store');
        setMemoryBody(/** @type {any} */ (null), 'nope');
        expect(getMemoryBody('')).toBe('');
    });
});

describe('macro — handler', () => {
    test('returns body for active chatId from ST context', () => {
        _setContextForTests({ chatId: 'chat-A' });
        setMemoryBody('chat-A', 'cached body');
        expect(memoriesMacroHandler()).toBe('cached body');
    });

    test('returns "" when no active chatId', () => {
        _setContextForTests({ chatId: null });
        setMemoryBody('chat-A', 'cached body');
        expect(memoriesMacroHandler()).toBe('');
    });

    test('returns "" when nothing cached for active chat', () => {
        _setContextForTests({ chatId: 'chat-empty' });
        expect(memoriesMacroHandler()).toBe('');
    });

    test('swallows context-resolution errors and returns ""', () => {
        _setContextForTests(/** @type {any} */ ({
            get chatId() { throw new Error('boom'); },
        }));
        expect(memoriesMacroHandler()).toBe('');
    });
});
