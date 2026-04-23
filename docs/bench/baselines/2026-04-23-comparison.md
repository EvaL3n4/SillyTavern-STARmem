# Baseline comparison — 2026-04-23

**Corpus:** 10 conversations, 1986 QA items
**Retrievers:** ladder (default), bm25only, recency, random

## Overall metrics

| retriever | recallAt1 | recallAt3 | recallAt5 | recallAt10 | precisionAt1 | precisionAt3 | precisionAt5 | precisionAt10 | mrr | p50 (ms) | p95 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ladder | 0.5317 | 0.8692 | 0.9363 | 1.0000 | 0.6789 | 0.3981 | 0.2783 | 0.1954 | 0.8057 | 3.65 | 5.15 |
| bm25only | 0.3124 | 0.6374 | 0.7912 | 1.0000 | 0.5434 | 0.3880 | 0.2904 | 0.1844 | 0.6898 | 5.90 | 6.99 |
| recency | 0.0000 | 0.3718 | 0.5692 | 1.0000 | 0.0000 | 0.1436 | 0.1354 | 0.1138 | 0.2703 | 0.08 | 0.28 |
| random | 0.0755 | 0.2217 | 0.4717 | 1.0000 | 0.0755 | 0.0755 | 0.1000 | 0.1057 | 0.2690 | 0.04 | 0.26 |

## Per-category breakdown

### Category: 2 (321 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.9647 | 0.8659 | 3.75 |
| bm25only | 0.8170 | 0.7589 | 5.79 |
| recency | 0.6154 | 0.2874 | 0.08 |
| random | 0.7059 | 0.3102 | 0.04 |

### Category: 3 (96 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.8241 | 0.6841 | 3.91 |
| bm25only | 0.6952 | 0.5961 | 6.01 |
| recency | 0.0000 | 0.1263 | 0.08 |
| random | 0.6250 | 0.2326 | 0.04 |

### Category: 1 (282 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.8602 | 0.6878 | 3.78 |
| bm25only | 0.7000 | 0.5781 | 5.73 |
| recency | 0.6875 | 0.2947 | 0.08 |
| random | 0.4464 | 0.2624 | 0.04 |

### Category: 4 (841 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.9516 | 0.8274 | 3.83 |
| bm25only | 0.8125 | 0.6994 | 5.99 |
| recency | 0.4167 | 0.2441 | 0.08 |
| random | 0.3684 | 0.2343 | 0.04 |

### Category: 5 (446 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.9436 | 0.8027 | 3.95 |
| bm25only | 0.7882 | 0.6866 | 5.98 |
| recency | 0.4000 | 0.2186 | 0.08 |
| random | 0.4333 | 0.3422 | 0.04 |

## Interpretation

**Proceed:** ladder > bm25only > recency > random. The ladder is adding value over all baselines. Scorer chain and graph expansion are earning their keep.

## Structural notes



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
    "TIER2_TAU_GAP": 10,
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
  "gitSha": "f02b1a5f0d883b4df6f5ae05a5d45f2ba3097a0c"
}
```
