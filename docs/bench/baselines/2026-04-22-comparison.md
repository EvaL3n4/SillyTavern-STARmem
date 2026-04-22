# Baseline comparison — 2026-04-22

**Corpus:** 10 conversations, 1986 QA items
**Retrievers:** ladder (default), bm25only, recency, random

## Overall metrics

| retriever | recallAt1 | recallAt3 | recallAt5 | recallAt10 | precisionAt1 | precisionAt3 | precisionAt5 | precisionAt10 | mrr | p50 (ms) | p95 (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ladder | 0.0007 | 0.0035 | 0.0056 | 0.6074 | 0.0007 | 0.0012 | 0.0011 | 0.0877 | 0.1118 | 1.89 | 5.08 |
| bm25only | 0.3128 | 0.6402 | 0.7932 | 1.0000 | 0.5445 | 0.3902 | 0.2914 | 0.1847 | 0.6909 | 5.84 | 6.96 |
| recency | 0.0000 | 0.3718 | 0.5692 | 1.0000 | 0.0000 | 0.1436 | 0.1354 | 0.1138 | 0.2703 | 0.08 | 0.29 |
| random | 0.1032 | 0.3175 | 0.5040 | 1.0000 | 0.1032 | 0.1085 | 0.1063 | 0.1063 | 0.3028 | 0.04 | 0.24 |

## Per-category breakdown

### Category: 2 (321 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.0041 | 0.1122 | 1.95 |
| bm25only | 0.8209 | 0.7592 | 5.89 |
| recency | 0.6154 | 0.2874 | 0.08 |
| random | 0.5000 | 0.3156 | 0.04 |

### Category: 3 (96 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.0222 | 0.1088 | 2.17 |
| bm25only | 0.6820 | 0.5974 | 5.91 |
| recency | 0.0000 | 0.1263 | 0.08 |
| random | 0.3333 | 0.3155 | 0.04 |

### Category: 1 (282 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.0053 | 0.1044 | 2.12 |
| bm25only | 0.7058 | 0.5788 | 5.74 |
| recency | 0.6875 | 0.2947 | 0.08 |
| random | 0.5851 | 0.3071 | 0.04 |

### Category: 4 (841 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.0065 | 0.1136 | 2.08 |
| bm25only | 0.8154 | 0.7002 | 6.16 |
| recency | 0.4167 | 0.2441 | 0.08 |
| random | 0.4634 | 0.2980 | 0.04 |

### Category: 5 (446 items)

| retriever | recallAt5 | mrr | p50 |
|---|---|---|---|
| ladder | 0.0031 | 0.1126 | 2.01 |
| bm25only | 0.7870 | 0.6891 | 5.83 |
| recency | 0.4000 | 0.2186 | 0.08 |
| random | 0.4375 | 0.2848 | 0.04 |

## Interpretation

**Mixed signal:** ladder outperforms random, but the ordering among bm25only/recency is unexpected. Review corpus size and extraction quality before drawing conclusions.

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
  "gitSha": "0b5e823940ad6d0aba50a21e6c1b4c09664f3f63"
}
```
