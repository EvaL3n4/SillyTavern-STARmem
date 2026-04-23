import { enumerateWarmupBatches } from '../../../../bench/harness/warmup/enumerate.js';
import { _cacheKey } from '../../../../bench/harness/extractionCache.js';
import { renderExtractionPrompt, EXTRACT_MAX_TOKENS } from '../../../../src/consolidation/extractFacts.js';

describe('enumerateWarmupBatches', () => {
    const MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';

    const mkItem = (id, turnTexts) => ({
        id,
        turns: turnTexts.map((text, idx) => ({
            speaker: idx % 2 === 0 ? 'user' : 'assistant',
            text,
            sessionId: 0,
            turnIndex: idx,
        })),
        qa: [],
    });

    test('produces one batch per BATCH_SIZE window', () => {
        const items = [mkItem('x', Array.from({ length: 12 }, (_, i) => `turn-${i}`))];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batches).toHaveLength(3); // ceil(12/5)
    });

    test('filters empty-trim turns (matches seeder.js)', () => {
        const items = [mkItem('e', ['hello', '', '   ', 'world'])];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batches).toHaveLength(1);
        expect(batches[0].messages.some(m => m.content.includes('hello'))).toBe(true);
        expect(batches[0].messages.some(m => m.content.includes('world'))).toBe(true);
    });

    test('customId matches extractionCache._cacheKey byte-for-byte', () => {
        const items = [mkItem('y', ['foo', 'bar', 'baz'])];
        const [batch] = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        const expected = _cacheKey(MODEL, batch.messages, batch.maxTokens);
        expect(batch.customId).toBe(expected);
    });

    test('messages shape matches renderExtractionPrompt output', () => {
        const items = [mkItem('z', ['alpha', 'beta'])];
        const [batch] = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        const expected = renderExtractionPrompt([
            { role: 'user', content: 'alpha' },
            { role: 'user', content: 'beta' },
        ]);
        expect(batch.messages).toEqual(expected);
    });

    test('maxTokens is EXTRACT_MAX_TOKENS by default', () => {
        const items = [mkItem('m', ['a', 'b'])];
        const [batch] = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batch.maxTokens).toBe(EXTRACT_MAX_TOKENS);
    });

    test('empty items array produces no batches', () => {
        expect(enumerateWarmupBatches([], {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        })).toEqual([]);
    });

    test('multi-item: customIds are unique across items with disjoint content', () => {
        const items = [
            mkItem('a', ['one', 'two', 'three']),
            mkItem('b', ['four', 'five', 'six']),
        ];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        const ids = new Set(batches.map(b => b.customId));
        expect(ids.size).toBe(batches.length);
    });

    test('all batches carry the provided model verbatim', () => {
        const items = [mkItem('m', ['foo', 'bar'])];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batches.every(b => b.model === MODEL)).toBe(true);
    });
});
