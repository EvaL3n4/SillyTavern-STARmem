import {
    SCOPES,
    EDGE_TYPES,
    QUERY_INTENTS,
    MATURITY_TIERS,
    LIFECYCLE,
    RETRIEVAL,
    CONSOLIDATION,
    TRACE_BUFFER_CAP,
} from '../../../src/core/constants.js';

describe('constants', () => {
    test('SCOPES has the three spec §4 scopes', () => {
        expect(SCOPES).toEqual(['working', 'episodic', 'persona']);
    });

    test('EDGE_TYPES has four produced types; contradicts is reserved', () => {
        expect(EDGE_TYPES.PRODUCED).toEqual([
            'mentions', 'supports', 'same_topic', 'temporal_next',
        ]);
        expect(EDGE_TYPES.RESERVED).toEqual(['contradicts']);
    });

    test('QUERY_INTENTS is the 3-type classifier set', () => {
        expect(QUERY_INTENTS).toEqual(['factual', 'relational', 'temporal']);
    });

    test('MATURITY_TIERS matches spec §7', () => {
        expect(MATURITY_TIERS).toEqual(['draft', 'validated', 'core']);
    });

    test('LIFECYCLE constants match spec §7 verbatim', () => {
        expect(LIFECYCLE.ACCESS_BONUS).toBe(3);
        expect(LIFECYCLE.UPDATE_BONUS).toBe(5);
        expect(LIFECYCLE.DAILY_DECAY).toBe(0.995);
        expect(LIFECYCLE.RECENCY_TAU_DAYS).toBe(30);
        expect(LIFECYCLE.MATURITY_BOOST).toEqual({
            draft: 0.85,
            validated: 1.0,
            core: 1.2,
        });
        expect(LIFECYCLE.PROMOTION.draftToValidated).toBe(65);
        expect(LIFECYCLE.DEMOTION.validatedToDraft).toBe(35);
        expect(LIFECYCLE.PROMOTION.validatedToCore).toBe(85);
        expect(LIFECYCLE.DEMOTION.coreToValidated).toBe(60);
    });

    test('RETRIEVAL thresholds match spec §5', () => {
        expect(RETRIEVAL.FUZZY_JACCARD_THRESHOLD).toBe(0.6);
        expect(RETRIEVAL.TIER3_LAMBDA_1).toBe(1.0);
        expect(RETRIEVAL.TIER3_LAMBDA_2).toBe(0.3);
        expect(RETRIEVAL.TIER3_MAX_HOPS).toBe(2);
    });

    test('CONSOLIDATION defaults match spec §6', () => {
        expect(CONSOLIDATION.WORKING_BUFFER_THRESHOLD).toBe(10);
        expect(CONSOLIDATION.IDLE_TRIGGER_SECONDS).toBe(60);
        expect(CONSOLIDATION.BATCH_SIZE).toBe(5);
        expect(CONSOLIDATION.PERSONA_REBUILD_SUGGESTION_THRESHOLD).toBe(100);
    });

    test('TRACE_BUFFER_CAP matches spec §9.1', () => {
        expect(TRACE_BUFFER_CAP).toBe(100);
    });
});
