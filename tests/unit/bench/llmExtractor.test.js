/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { makeLLMExtractor } from '../../../bench/harness/llmExtractor.js';

describe('makeLLMExtractor', () => {
    beforeEach(() => {
        global.fetch = /** @type {any} */ (jest.fn());
    });
    afterEach(() => {
        delete global.fetch;
    });

    test('throws when STARMEM_BENCH_LLM_URL is missing', () => {
        expect(() => makeLLMExtractor({
            url: '', apiKey: 'k', model: 'm',
        })).toThrow(/url/i);
    });

    test('throws when STARMEM_BENCH_LLM_MODEL is missing', () => {
        expect(() => makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: '',
        })).toThrow(/model/i);
    });

    test('sends OpenAI-compatible chat completion request', async () => {
        /** @type {any} */ (global.fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"entries":[]}' } }],
            }),
        });

        const ext = makeLLMExtractor({
            url: 'http://litellm:8686/v1',
            apiKey: 'sk-test',
            model: 'gemma4-26b-a4b',
        });

        const result = await ext('profile-id', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user' },
        ], 2048);

        expect(result).toBe('{"entries":[]}');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://litellm:8686/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer sk-test',
                    'Content-Type': 'application/json',
                }),
                body: expect.stringContaining('"temperature":0'),
            }),
        );

        const body = JSON.parse(/** @type {any} */ (global.fetch).mock.calls[0][1].body);
        expect(body.model).toBe('gemma4-26b-a4b');
        expect(body.max_tokens).toBe(2048);
        expect(body.temperature).toBe(0);
        expect(body.messages).toHaveLength(2);
    });

    test('throws on non-200 response with status+body in message', async () => {
        /** @type {any} */ (global.fetch).mockResolvedValue({
            ok: false,
            status: 503,
            text: async () => 'upstream down',
        });

        const ext = makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: 'm',
        });

        await expect(ext('p', [{ role: 'user', content: 'x' }], 100))
            .rejects.toThrow(/503/);
    });

    test('throws when response has no string content', async () => {
        /** @type {any} */ (global.fetch).mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: {} }] }),
        });

        const ext = makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: 'm',
        });

        await expect(ext('p', [{ role: 'user', content: 'x' }], 100))
            .rejects.toThrow(/content/i);
    });

    test('temperature is non-overridable (always 0)', async () => {
        /** @type {any} */ (global.fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        });

        const ext = makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: 'm',
        });

        await ext('p', [{ role: 'user', content: 'x' }], 100);

        const body = JSON.parse(/** @type {any} */ (global.fetch).mock.calls[0][1].body);
        expect(body.temperature).toBe(0);
    });
});
