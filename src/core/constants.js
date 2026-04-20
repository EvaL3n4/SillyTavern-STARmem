/**
 * STARmem core constants—single source of truth for spec-derived values.
 * Any number referenced by the spec more than once lives here.
 *
 * @module core/constants
 * @see docs/specs/2026-04-20-starmem-v2-design.md
 */

/** Memory scopes. Spec §4. */
export const SCOPES = Object.freeze(['working', 'episodic', 'persona']);

/** Edge types. Spec §4. `contradicts` is reserved but not emitted in v2.0. */
export const EDGE_TYPES = Object.freeze({
    PRODUCED: Object.freeze(['mentions', 'supports', 'same_topic', 'temporal_next']),
    RESERVED: Object.freeze(['contradicts']),
});

/** Query classifier intents. Spec §5 (3-type classifier). */
export const QUERY_INTENTS = Object.freeze(['factual', 'relational', 'temporal']);

/** Maturity tiers. Spec §7. */
export const MATURITY_TIERS = Object.freeze(['draft', 'validated', 'core']);

/** Lifecycle math constants. Spec §7, verbatim from ByteRover's AKL. */
export const LIFECYCLE = Object.freeze({
    /** Importance bonus on access. Spec §7. */
    ACCESS_BONUS: 3,
    /** Importance bonus on update. Spec §7. */
    UPDATE_BONUS: 5,
    /** Daily decay multiplier (~0.5% daily). Spec §7. */
    DAILY_DECAY: 0.995,
    /** Recency decay time constant in days (~21-day half-life). Spec §7. */
    RECENCY_TAU_DAYS: 30,
    /** Retrieval score multipliers per maturity tier. Spec §5.2 / §7. */
    MATURITY_BOOST: Object.freeze({
        draft: 0.85,
        validated: 1.0,
        core: 1.2,
    }),
    /** Promotion thresholds (hysteresis). Spec §7. */
    PROMOTION: Object.freeze({
        draftToValidated: 65,
        validatedToCore: 85,
    }),
    /** Demotion thresholds (hysteresis gaps). Spec §7. */
    DEMOTION: Object.freeze({
        validatedToDraft: 35,
        coreToValidated: 60,
    }),
});

/** Retrieval ladder constants. Spec §5, §5.1, §5.2. */
export const RETRIEVAL = Object.freeze({
    /** Tier 1 fuzzy-match Jaccard threshold. Spec §5. */
    FUZZY_JACCARD_THRESHOLD: 0.6,
    /** Tier 3 beam-search weights. Spec §5.1. */
    TIER3_LAMBDA_1: 1.0,
    TIER3_LAMBDA_2: 0.3,
    /** Tier 3 max hops. Spec §5.1. */
    TIER3_MAX_HOPS: 2,
    /** BM25+ term-frequency saturation. Standard default. */
    BM25_K1: 1.2,
    /** BM25+ length normalization. Standard default. */
    BM25_B: 0.75,
    /** BM25+ lower-bound delta (Lv & Zhai 2011). */
    BM25_DELTA: 1.0,
    /** Integer replication factor for subject tokens in the BM25 document. */
    SUBJECT_BOOST: 2,
    /** Integer replication factor for tag tokens in the BM25 document. */
    TAG_BOOST: 2,
    /** Tier 2 exit: minimum top score required to shortcut the ladder. Spec §5; opening value, Phase 9 tunes. */
    TIER2_TAU_CONFIDENCE: 2.0,
    /** Tier 2 exit: minimum (top − #2) score gap required to shortcut. Spec §5; opening value, Phase 9 tunes. */
    TIER2_TAU_GAP: 0.5,
    /** Tier 3 seeds drawn from Tier 2's top-K. Spec §5.1. */
    TIER3_SEEDS_K: 3,
    /** Tier 3 beam width. Not in spec; opening value, Phase 9 tunes. */
    TIER3_BEAM_WIDTH: 5,
    /** Max edges per source entry. Spec §12.2 resolution. */
    EDGE_CAP_PER_ENTRY: 20,
    /** Weight for edges from extractor-asserted @relations. Spec §4 / §6.3. */
    EXPLICIT_RELATION_WEIGHT: 1.0,
    /** Weight for edges from entity co-occurrence (capitalized noun match). Spec §4 / §6.3. */
    COOCCURRENCE_WEIGHT: 0.5,
});

/**
 * Tier 3 edge-type match weights per query intent. Spec §5.1 table.
 * `contradicts` is included for completeness but v2.0 edgeBuilder never emits
 * that type — the row is dormant until drift detection lands.
 */
export const EDGE_TYPE_WEIGHTS = Object.freeze({
    supports:      Object.freeze({ factual: 0.9, relational: 0.5, temporal: 0.3 }),
    mentions:      Object.freeze({ factual: 0.7, relational: 0.9, temporal: 0.3 }),
    same_topic:    Object.freeze({ factual: 0.5, relational: 0.8, temporal: 0.5 }),
    temporal_next: Object.freeze({ factual: 0.3, relational: 0.4, temporal: 0.9 }),
    contradicts:   Object.freeze({ factual: 0.2, relational: 0.3, temporal: 0.2 }),
});

/** Consolidation trigger thresholds. Spec §6.2, §6.3, §6.4. */
export const CONSOLIDATION = Object.freeze({
    /** Working buffer size that triggers consolidation. Spec §6.2. */
    WORKING_BUFFER_THRESHOLD: 10,
    /** User-idle seconds that trigger consolidation. Spec §6.2. */
    IDLE_TRIGGER_SECONDS: 60,
    /** Messages drained from working buffer per consolidation batch. Spec §6.3. */
    BATCH_SIZE: 5,
    /** Episodic entries added before suggesting a Persona rebuild. Spec §6.4. */
    PERSONA_REBUILD_SUGGESTION_THRESHOLD: 100,
    /** Dedup Jaccard threshold for same-subject merge. Spec §6.3; opening value, Phase 9 tunes. */
    DEDUP_JACCARD_THRESHOLD: 0.7,
});

/** Trace ring buffer cap. Spec §9.1; resolution of §12.4 "make configurable"—default 128, settings hook deferred to Phase 8. */
export const TRACE_BUFFER_CAP = 128;
