import { describe, test, expect, afterEach } from '@jest/globals';
import {
    extractFacts, parseLLMJson, validateExtractionShape, renderExtractionPrompt,
} from '../../../src/consolidation/extractFacts.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');
const CTX = {
    profileId: 'gemma-4-31b',
    extractorLabel: 'gemma-4-31b@consolidation-v1',
    sourceMessageIndices: [0, 1, 2],
    now: FIXED_NOW,
};

afterEach(() => _resetLLMClientForTests());

describe('parseLLMJson', () => {
    test('parses a plain JSON object', () => {
        expect(parseLLMJson('{"a":1}')).toEqual({ a: 1 });
    });
    test('strips ```json fences', () => {
        expect(parseLLMJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });
    test('strips plain ``` fences', () => {
        expect(parseLLMJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    });
    test('throws on non-JSON', () => {
        expect(() => parseLLMJson('not json')).toThrow();
    });
});

describe('validateExtractionShape', () => {
    test('accepts empty entries list', () => {
        expect(validateExtractionShape({ entries: [] })).toEqual([]);
    });
    test('rejects non-object root', () => {
        expect(() => validateExtractionShape([])).toThrow(/JSON object/);
    });
    test('rejects missing entries field', () => {
        expect(() => validateExtractionShape({})).toThrow(/entries must be an array/);
    });
    test('accepts minimal entry (content + subject only)', () => {
        const out = validateExtractionShape({ entries: [{ content: 'x', subject: 'alice' }] });
        expect(out).toEqual([{ content: 'x', subject: 'alice', tags: [], relations: [] }]);
    });
    test('accepts null subject', () => {
        const out = validateExtractionShape({ entries: [{ content: 'x', subject: null }] });
        expect(out[0].subject).toBeNull();
    });
    test('rejects empty content', () => {
        expect(() => validateExtractionShape({ entries: [{ content: '', subject: 'a' }] })).toThrow(/content/);
    });
    test('rejects invalid edge type', () => {
        expect(() => validateExtractionShape({
            entries: [{
                content: 'x', subject: 'a',
                relations: [{ type: 'bogus', target: 't' }],
            }],
        })).toThrow(/relations\[0\]\.type invalid/);
    });
    test('silently drops contradicts relations (reserved per spec §4)', () => {
        const out = validateExtractionShape({
            entries: [{
                content: 'x', subject: 'a',
                relations: [
                    { type: 'mentions', target: 'ep_1' },
                    { type: 'contradicts', target: 'ep_2' },
                ],
            }],
        });
        expect(out[0].relations).toEqual([{ type: 'mentions', target: 'ep_1' }]);
    });
});

describe('renderExtractionPrompt', () => {
    test('prepends system prompt and formats transcript', () => {
        const msgs = renderExtractionPrompt([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ]);
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe('system');
        expect(msgs[1].role).toBe('user');
        expect(msgs[1].content).toContain('[user] hello');
        expect(msgs[1].content).toContain('[assistant] hi there');
    });
});

describe('extractFacts (end-to-end with mocked LLM)', () => {
    test('produces Entry objects with correct shape', async () => {
        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                { content: 'alice traveled to marseille', subject: 'alice', tags: ['travel'] },
            ],
        }));
        const out = await extractFacts(
            [{ role: 'user', content: 'i went to marseille' }],
            CTX,
        );
        expect(out).toHaveLength(1);
        expect(out[0].scope).toBe('episodic');
        expect(out[0].content).toBe('alice traveled to marseille');
        expect(out[0].subject).toBe('alice');
        expect(out[0].tags).toEqual(['travel']);
        expect(out[0].relations).toEqual([]);
        expect(out[0].provenance.sourceMessages).toEqual([0, 1, 2]);
        expect(out[0].provenance.extractor).toBe('gemma-4-31b@consolidation-v1');
        expect(out[0].lifecycle.importance).toBe(50);
        expect(out[0].lifecycle.maturity).toBe('draft');
    });

    test('propagates LLM errors', async () => {
        _setLLMClientForTests(async () => { throw new Error('upstream 500'); });
        await expect(extractFacts([{ role: 'user', content: 'x' }], CTX))
            .rejects.toThrow(/upstream 500/);
    });

    test('throws on non-JSON response', async () => {
        _setLLMClientForTests(async () => 'sure, here are the facts: ...');
        await expect(extractFacts([{ role: 'user', content: 'x' }], CTX))
            .rejects.toThrow(/JSON/i);
    });

    test('throws on shape-mismatch response', async () => {
        _setLLMClientForTests(async () => JSON.stringify({ wrong: 'shape' }));
        await expect(extractFacts([{ role: 'user', content: 'x' }], CTX))
            .rejects.toThrow(/entries must be an array/);
    });

    test('handles empty-entries response (nothing durable)', async () => {
        _setLLMClientForTests(async () => '{"entries":[]}');
        const out = await extractFacts([{ role: 'user', content: 'lol' }], CTX);
        expect(out).toEqual([]);
    });

    test('rejects bad context (missing profileId)', async () => {
        await expect(extractFacts(
            [{ role: 'user', content: 'x' }],
            /** @type {any} */ ({ extractorLabel: 'x', sourceMessageIndices: [] }),
        )).rejects.toThrow(/profileId/);
    });

    test('rejects empty batch', async () => {
        await expect(extractFacts([], CTX)).rejects.toThrow(/batch/);
    });
});
