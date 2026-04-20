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
        expect(typeof retrieval.getScorerId).toBe('function');
        expect(typeof retrieval.registerScorer).toBe('function');
        expect(typeof retrieval._resetScorerForTests).toBe('function');
        expect(typeof retrieval.prependWorking).toBe('function');
        // Phase 4 additions
        expect(typeof retrieval.tier0).toBe('function');
        expect(typeof retrieval.recordTier0).toBe('function');
        expect(typeof retrieval.invalidateTier0Cache).toBe('function');
        expect(typeof retrieval.normalizeQuery).toBe('function');
        expect(typeof retrieval.hashQuery).toBe('function');
        expect(typeof retrieval.tier1).toBe('function');
        expect(typeof retrieval.recordTier1).toBe('function');
        expect(typeof retrieval.jaccard).toBe('function');
        expect(typeof retrieval.tokenSetKey).toBe('function');
        expect(typeof retrieval.tier2).toBe('function');
        expect(typeof retrieval.floor).toBe('function');
        expect(typeof retrieval.logTrace).toBe('function');
        expect(typeof retrieval.buildTrace).toBe('function');
        expect(typeof retrieval.retrieve).toBe('function');
        expect(typeof retrieval.tier3).toBe('function');
    });

    test('re-exports are reference-equal to the source modules', async () => {
        const bm25 = await import('../../../src/retrieval/bm25.js');
        const classifier = await import('../../../src/retrieval/classifier.js');
        const scorer = await import('../../../src/retrieval/scorer.js');
        const wb = await import('../../../src/retrieval/workingBuffer.js');
        const ladder = await import('../../../src/retrieval/ladder.js');
        expect(retrieval.buildIndex).toBe(bm25.buildIndex);
        expect(retrieval.classify).toBe(classifier.classify);
        expect(retrieval.defaultScorer).toBe(scorer.defaultScorer);
        expect(retrieval.prependWorking).toBe(wb.prependWorking);
        expect(retrieval.retrieve).toBe(ladder.retrieve);
    });
});
