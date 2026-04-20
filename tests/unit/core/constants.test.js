import {
    SCOPES,
    EDGE_TYPES,
    QUERY_INTENTS,
    MATURITY_TIERS,
    LIFECYCLE,
    RETRIEVAL,
    EDGE_TYPE_WEIGHTS,
    CONSOLIDATION,
    PERSONA_REBUILD,
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

    test('RETRIEVAL BM25 constants match plan Phase 3', () => {
        expect(RETRIEVAL.BM25_K1).toBe(1.2);
        expect(RETRIEVAL.BM25_B).toBe(0.75);
        expect(RETRIEVAL.BM25_DELTA).toBe(1.0);
        expect(RETRIEVAL.SUBJECT_BOOST).toBe(2);
        expect(RETRIEVAL.TAG_BOOST).toBe(2);
    });

    test('RETRIEVAL Tier 2 exit thresholds', () => {
        expect(RETRIEVAL.TIER2_TAU_CONFIDENCE).toBe(2.0);
        expect(RETRIEVAL.TIER2_TAU_GAP).toBe(0.5);
    });

    test('RETRIEVAL Phase 5 graph/Tier 3 constants', () => {
        expect(RETRIEVAL.TIER3_SEEDS_K).toBe(3);
        expect(RETRIEVAL.TIER3_BEAM_WIDTH).toBe(5);
        expect(RETRIEVAL.EDGE_CAP_PER_ENTRY).toBe(20);
        expect(RETRIEVAL.EXPLICIT_RELATION_WEIGHT).toBe(1.0);
        expect(RETRIEVAL.COOCCURRENCE_WEIGHT).toBe(0.5);
    });

    test('EDGE_TYPE_WEIGHTS matches spec §5.1 table', () => {
        expect(EDGE_TYPE_WEIGHTS.supports).toEqual({ factual: 0.9, relational: 0.5, temporal: 0.3 });
        expect(EDGE_TYPE_WEIGHTS.mentions).toEqual({ factual: 0.7, relational: 0.9, temporal: 0.3 });
        expect(EDGE_TYPE_WEIGHTS.same_topic).toEqual({ factual: 0.5, relational: 0.8, temporal: 0.5 });
        expect(EDGE_TYPE_WEIGHTS.temporal_next).toEqual({ factual: 0.3, relational: 0.4, temporal: 0.9 });
        expect(EDGE_TYPE_WEIGHTS.contradicts).toEqual({ factual: 0.2, relational: 0.3, temporal: 0.2 });
    });

    test('EDGE_TYPE_WEIGHTS covers all produced edge types + contradicts', () => {
        const keys = Object.keys(EDGE_TYPE_WEIGHTS).sort();
        expect(keys).toEqual(['contradicts', 'mentions', 'same_topic', 'supports', 'temporal_next']);
    });

    test('CONSOLIDATION defaults match spec §6', () => {
        expect(CONSOLIDATION.WORKING_BUFFER_THRESHOLD).toBe(10);
        expect(CONSOLIDATION.IDLE_TRIGGER_SECONDS).toBe(60);
        expect(CONSOLIDATION.BATCH_SIZE).toBe(5);
        expect(CONSOLIDATION.PERSONA_REBUILD_SUGGESTION_THRESHOLD).toBe(100);
    });

    test('DEDUP_JACCARD_THRESHOLD is 0.7 (spec §6.3; Phase 9 tunes)', () => {
        expect(CONSOLIDATION.DEDUP_JACCARD_THRESHOLD).toBe(0.7);
    });

    test('TRACE_BUFFER_CAP matches Phase 4 decision (spec §12.4 resolution)', () => {
        expect(TRACE_BUFFER_CAP).toBe(128);
    });

    test('PERSONA_REBUILD matches spec §6.4 verbatim', () => {
        expect(PERSONA_REBUILD.K_BASE).toBe(15);
        expect(PERSONA_REBUILD.K_STEP).toBe(5);
        expect(PERSONA_REBUILD.GAMMA_BASE).toBe(1.0);
        expect(PERSONA_REBUILD.GAMMA_STEP).toBe(0.2);
        expect(PERSONA_REBUILD.MAX_DEPTH).toBe(3);
        expect(PERSONA_REBUILD.MIN_CLUSTER_SIZE).toBe(2);
        expect(PERSONA_REBUILD.LEIDEN_TOLERANCE).toBeCloseTo(1e-6, 10);
        expect(PERSONA_REBUILD.LEIDEN_MAX_OUTER_ITERATIONS).toBe(32);
        expect(PERSONA_REBUILD.SUMMARY_MAX_TOKENS).toBe(512);
        expect(PERSONA_REBUILD.SYNTHETIC_EMBEDDING_DIM).toBe(16);
    });
});
