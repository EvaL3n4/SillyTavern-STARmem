# Baseline comparison — 2026-04-21

**Corpus:** 2 conversations, 4 QA items
**Retrievers:** ladder (default), bm25only, recency, random

## Overall metrics

| retriever | recallAt1 | recallAt3 | recallAt5 | recallAt10 | precisionAt1 | precisionAt3 | precisionAt5 | precisionAt10 | mrr | p50 (ms) | p95 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ladder | 0.5000 | 0.7500 | 1.0000 | 1.0000 | 0.5000 | 0.2500 | 0.2000 | 0.1667 | 0.6875 | 0.64 | 1.28 |
| bm25only | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.7083 | 0.6875 | 0.6875 | 1.0000 | 0.10 | 0.61 |
| recency | 0.5000 | 0.7500 | 1.0000 | 1.0000 | 0.5000 | 0.2500 | 0.2000 | 0.1667 | 0.6875 | 0.03 | 10.79 |
| random | 0.2500 | 0.5000 | 0.7500 | 1.0000 | 0.2500 | 0.1667 | 0.1500 | 0.1667 | 0.4792 | 0.08 | 0.27 |

## Per-category breakdown

### Category: factual (4 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 1.0000 | 0.6875 | 0.05 |
| bm25only | 1.0000 | 1.0000 | 0.07 |
| recency | 1.0000 | 0.6875 | 0.02 |
| random | 0.7500 | 0.4792 | 0.03 |

## Interpretation

**Mixed signal:** ladder outperforms random, but the ordering among bm25only/recency is unexpected. Review corpus size and extraction quality before drawing conclusions.

## Structural notes

> Rule-based extractor + tiny corpus: expect flat metrics across all four retrievers. The ladder-vs-random invariant is the only structural signal here. Real LoCoMo numbers will come from the controller's follow-up run.

## envSnapshot

```json
{
  "constants": {
    "FUZZY_JACCARD_THRESHOLD": 0.6,
    "TIER3_LAMBDA_1": 1,
    "TIER3_LAMBDA_2": 0.3,
    "TIER3_MAX_HOPS": 2,
    "BM25_K1": 1.2,
    "BM25_B": 0.75,
    "BM25_DELTA": 1,
    "SUBJECT_BOOST": 2,
    "TAG_BOOST": 2,
    "TIER2_TAU_CONFIDENCE": 2,
    "TIER2_TAU_GAP": 0.5,
    "TIER3_SEEDS_K": 3,
    "TIER3_BEAM_WIDTH": 5,
    "EDGE_CAP_PER_ENTRY": 20,
    "EXPLICIT_RELATION_WEIGHT": 1,
    "COOCCURRENCE_WEIGHT": 0.5,
    "WORKING_BUFFER_THRESHOLD": 10,
    "IDLE_TRIGGER_SECONDS": 60,
    "BATCH_SIZE": 5,
    "PERSONA_REBUILD_SUGGESTION_THRESHOLD": 100,
    "DEDUP_JACCARD_THRESHOLD": 0.7
  },
  "scorerId": "default",
  "nodeVersion": "v25.9.0",
  "gitSha": "50e51970f3defe8981809da0fa679752e99a3b59"
}
```
