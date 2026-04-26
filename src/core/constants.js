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

/**
 * Retrieval ladder constants. Spec §5, §5.1, §5.2.
 *
 * NOT frozen — Phase 9's benchmarking harness mutates swept keys in place via
 * {@link setConstantOverrides}. Non-swept keys should still be treated as
 * read-only; mutation outside the benchmarking harness is a bug.
 */
export const RETRIEVAL = {
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
    /** Max entries retained per tier cache (exact and fuzzy). Oldest evicted on write. Spec §5 hardening — finding #4 (Codex 2026-04-24). Sweepable. */
    TIER_CACHE_MAX_ENTRIES: 200,
    /** Tier 2 exit: minimum top score required to shortcut the ladder. Spec §5; 9.4.8 sweep: inert on LoCoMo (identical MRR across 0.5–5.0). */
    TIER2_TAU_CONFIDENCE: 2.0,
    /** Tier 2 exit: minimum (top − #2) score gap required to shortcut. Spec §5; 9.4.8 amended 0.5 → 10 (+0.0625 MRR). Effectively disables Tier 2 gating in favor of always-Tier-3; Phase 11 demolition candidate. */
    TIER2_TAU_GAP: 10,
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
};

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

/**
 * Consolidation trigger thresholds. Spec §6.2, §6.3, §6.4.
 *
 * NOT frozen — Phase 9's benchmarking harness mutates DEDUP_JACCARD_THRESHOLD
 * via {@link setConstantOverrides}. Other keys are de-facto read-only.
 */
export const CONSOLIDATION = {
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
};

/** Persona rebuild (Enhanced RAPTOR) parameters. Spec §6.4 / wiki/raptor.md. */
export const PERSONA_REBUILD = Object.freeze({
    /** k-NN base neighbor count at the bottom layer. Spec §6.4. */
    K_BASE: 15,
    /** k-NN increment per layer ascending. Spec §6.4. */
    K_STEP: 5,
    /** Leiden resolution parameter base at bottom layer. Spec §6.4. */
    GAMMA_BASE: 1.0,
    /** Leiden resolution decrement per layer. Spec §6.4. */
    GAMMA_STEP: 0.2,
    /** Maximum tree depth. Stop recursing beyond this. */
    MAX_DEPTH: 3,
    /** Minimum nodes required to attempt clustering (need >= 2 x this to form 2 clusters). */
    MIN_CLUSTER_SIZE: 2,
    /** Leiden convergence tolerance - stop when modularity gain is below this across an outer iteration. */
    LEIDEN_TOLERANCE: 1e-6,
    /** Leiden maximum outer iterations, safety cap. */
    LEIDEN_MAX_OUTER_ITERATIONS: 32,
    /** LLM max tokens per cluster summary. Persona summaries are compact. */
    SUMMARY_MAX_TOKENS: 512,
    /** Embedding dimension for the synthetic test client. Production dimension is provider-dependent. */
    SYNTHETIC_EMBEDDING_DIM: 16,
});

/** Trace ring buffer cap. Spec §9.1; resolution of §12.4 "make configurable"—default 128, settings hook deferred to Phase 8. */
export const TRACE_BUFFER_CAP = 128;

/**
 * Chat-depth position for memory injection, counted from the end of the chat
 * array. ST convention: 4 (matches slash-commands.js default for in-chat
 * injections). If chat.length < INJECTION_DEPTH, fallback is to append.
 *
 * @see src/integration/interceptor.js
 */
export const INJECTION_DEPTH = 4;


/**
 * Phase 9 benchmarking: per-sweep override mechanism.
 *
 * The sweeps under `bench/sweeps/` need to probe retrieval/consolidation
 * behaviour at non-default values of the twelve swept knobs (τ_confidence,
 * τ_gap, λ₁, λ₂, beam width, max hops, edge cap, co-occurrence weight,
 * explicit relation weight, subject boost, tag boost, dedup Jaccard).
 *
 * `setConstantOverrides({ TIER2_TAU_CONFIDENCE: 5 })` mutates RETRIEVAL or
 * CONSOLIDATION in place. Callers that read `RETRIEVAL.TIER2_TAU_CONFIDENCE`
 * at call time (not destructured at module top) observe the override on
 * the next call. Destructuring swept keys at module top would bypass the
 * override — the `tests/unit/core/swept-constants-overridable.test.js`
 * guard fails if anyone reintroduces that pattern.
 *
 * This is a controller-owned mechanism: production code must never call
 * setConstantOverrides or resetConstantOverrides. It exists only for
 * `bench/runner.js` and its tests.
 */

const _INITIAL_RETRIEVAL = { ...RETRIEVAL };
const _INITIAL_CONSOLIDATION = { ...CONSOLIDATION };

/** @type {ReadonlyArray<string>} Swept keys in RETRIEVAL. Used by the guard test. */
export const _SWEPT_RETRIEVAL_KEYS = Object.freeze([
    'TIER2_TAU_CONFIDENCE',
    'TIER2_TAU_GAP',
    'TIER3_LAMBDA_1',
    'TIER3_LAMBDA_2',
    'TIER3_MAX_HOPS',
    'TIER3_SEEDS_K',
    'TIER3_BEAM_WIDTH',
    'EDGE_CAP_PER_ENTRY',
    'COOCCURRENCE_WEIGHT',
    'EXPLICIT_RELATION_WEIGHT',
    'SUBJECT_BOOST',
    'TAG_BOOST',
    'TIER_CACHE_MAX_ENTRIES',
]);

/** @type {ReadonlyArray<string>} Swept keys in CONSOLIDATION. */
export const _SWEPT_CONSOLIDATION_KEYS = Object.freeze([
    'DEDUP_JACCARD_THRESHOLD',
    'BATCH_SIZE',
    // WORKING_BUFFER_THRESHOLD is the consolidate() trigger; it must be
    // swept *together with* BATCH_SIZE because runtime drains
    // min(BATCH_SIZE, buffer.length) per fire — when threshold (10) <
    // BATCH_SIZE (15), runtime always drains 10-turn chunks even though
    // the warmup cached 15-turn chunks, producing 100% cache miss.
    // Phase 12 Task 7 cache-key alignment: see retro phase-12-task-6-5.
    'WORKING_BUFFER_THRESHOLD',
]);

/**
 * Apply a partial override to RETRIEVAL / CONSOLIDATION.
 *
 * @param {Object<string, number>} overrides
 *        Map of swept-key → new value. Keys not in `_SWEPT_*_KEYS` throw.
 * @returns {() => void} Restore function; call to undo just this override set.
 * @throws {Error} if any key is unknown or not swept.
 */
export function setConstantOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') {
        throw new Error('setConstantOverrides: overrides must be an object');
    }
    const restorers = [];
    for (const [key, value] of Object.entries(overrides)) {
        if (_SWEPT_RETRIEVAL_KEYS.includes(key)) {
            const prev = RETRIEVAL[key];
            RETRIEVAL[key] = value;
            restorers.push(() => { RETRIEVAL[key] = prev; });
        } else if (_SWEPT_CONSOLIDATION_KEYS.includes(key)) {
            const prev = CONSOLIDATION[key];
            CONSOLIDATION[key] = value;
            restorers.push(() => { CONSOLIDATION[key] = prev; });
        } else {
            // Undo partial application to avoid half-applied state
            for (const r of restorers) r();
            throw new Error(`setConstantOverrides: unknown or non-swept key '${key}'`);
        }
    }
    return () => { for (const r of restorers) r(); };
}

/**
 * Reset RETRIEVAL and CONSOLIDATION to their module-load values. Used by
 * tests and the sweep driver's try/finally to guarantee a clean slate.
 */
export function resetConstantOverrides() {
    for (const k of _SWEPT_RETRIEVAL_KEYS) RETRIEVAL[k] = _INITIAL_RETRIEVAL[k];
    for (const k of _SWEPT_CONSOLIDATION_KEYS) CONSOLIDATION[k] = _INITIAL_CONSOLIDATION[k];
}
