import { describe, test, expect, afterEach } from '@jest/globals';
import {
    callLLM, _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

afterEach(() => _resetLLMClientForTests());

describe('callLLM (argument guards)', () => {
    test('rejects empty profileId', async () => {
        await expect(callLLM('', [{ role: 'user', content: 'hi' }], 100)).rejects.toThrow(/profileId/);
    });
    test('rejects empty messages', async () => {
        await expect(callLLM('p', [], 100)).rejects.toThrow(/messages/);
    });
    test('rejects non-positive maxTokens', async () => {
        await expect(callLLM('p', [{ role: 'user', content: 'x' }], 0)).rejects.toThrow(/maxTokens/);
    });
});

describe('callLLM (default client, no ST)', () => {
    test('throws when SillyTavern is unavailable', async () => {
        // Default globalThis.SillyTavern is undefined in jest env — this hits the guard.
        await expect(
            callLLM('p', [{ role: 'user', content: 'x' }], 100),
        ).rejects.toThrow(/SillyTavern\.getContext is unavailable/);
    });
});

describe('callLLM (injected test client)', () => {
    test('forwards (profileId, messages, maxTokens) to the injected fn', async () => {
        /** @type {any[]} */
        const calls = [];
        _setLLMClientForTests(async (pid, msgs, mt) => {
            calls.push({ pid, msgs, mt });
            return 'hello';
        });
        const out = await callLLM('profile-1', [{ role: 'user', content: 'ping' }], 42);
        expect(out).toBe('hello');
        expect(calls).toHaveLength(1);
        expect(calls[0].pid).toBe('profile-1');
        expect(calls[0].mt).toBe(42);
        expect(calls[0].msgs).toEqual([{ role: 'user', content: 'ping' }]);
    });

    test('propagates errors from the injected client', async () => {
        _setLLMClientForTests(async () => { throw new Error('LLM down'); });
        await expect(callLLM('p', [{ role: 'user', content: 'x' }], 10)).rejects.toThrow(/LLM down/);
    });

    test('_resetLLMClientForTests restores default behavior', async () => {
        _setLLMClientForTests(async () => 'ok');
        expect(await callLLM('p', [{ role: 'user', content: 'x' }], 10)).toBe('ok');
        _resetLLMClientForTests();
        await expect(
            callLLM('p', [{ role: 'user', content: 'x' }], 10),
        ).rejects.toThrow(/SillyTavern\.getContext is unavailable/);
    });
});
