import * as retrieval from '../../../src/retrieval/index.js';

describe('retrieval barrel exports', () => {
    test('exposes all public functions', () => {
        expect(typeof retrieval.buildIndex).toBe('function');
        expect(typeof retrieval.query).toBe('function');
        expect(typeof retrieval.tokenize).toBe('function');
        expect(typeof retrieval.classify).toBe('function');
        expect(typeof retrieval.defaultScorer).toBe('function');
        expect(typeof retrieval.setScorer).toBe('function');
        expect(typeof retrieval.getScorer).toBe('function');
        expect(typeof retrieval._resetScorerForTests).toBe('function');
        expect(typeof retrieval.prependWorking).toBe('function');
    });

    test('re-exports are reference-equal to the source modules', async () => {
        const bm25 = await import('../../../src/retrieval/bm25.js');
        const classifier = await import('../../../src/retrieval/classifier.js');
        const scorer = await import('../../../src/retrieval/scorer.js');
        const wb = await import('../../../src/retrieval/workingBuffer.js');
        expect(retrieval.buildIndex).toBe(bm25.buildIndex);
        expect(retrieval.classify).toBe(classifier.classify);
        expect(retrieval.defaultScorer).toBe(scorer.defaultScorer);
        expect(retrieval.prependWorking).toBe(wb.prependWorking);
    });
});
