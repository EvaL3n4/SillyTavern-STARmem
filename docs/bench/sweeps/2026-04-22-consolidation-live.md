# Consolidation sweep — 2026-04-22

**Corpus:** 10 conversations, 1986 QA items
**Primary metric:** mrr (retrieval) + updateRate (consolidation-internal band rule)
**Baseline:** `TIER2_TAU_GAP=10` alone (MRR 0.8077, coverage ~64%)
**Rounds:** 1 independent single-axis sweeps

**Amendment criteria (9.4.9 hardened):** ΔMRR ≥ 0.02 AND coverage stays within 5pp of baseline. Either condition failing defers the amendment.

## Round — DEDUP_JACCARD_THRESHOLD

**Swept knob:** `DEDUP_JACCARD_THRESHOLD`

| DEDUP_JACCARD_THRESHOLD | added | updated | drained | updateRate | dedupHitRate | n_scored | recallAt5 | mrr | ΔMRR vs gap=10 | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 2773 | 131 | 5882 | 0.0451 | 0.0223 | 1271 | 0.9392 | 0.8089 | +0.0012 | 4.27 | 6.31 |
| 0.6 | 2834 | 70 | 5882 | 0.0241 | 0.0119 | 1277 | 0.9370 | 0.8062 | -0.0015 | 4.13 | 6.03 |
| 0.7 | 2862 | 42 | 5882 | 0.0145 | 0.0071 | 1277 | 0.9363 | 0.8057 | -0.0020 | 4.11 | 6.07 |
| 0.8 | 2873 | 31 | 5882 | 0.0107 | 0.0053 | 1279 | 0.9357 | 0.8052 | -0.0025 | 4.35 | 6.63 |
| 0.9 | 2884 | 20 | 5882 | 0.0069 | 0.0034 | 1284 | 0.9354 | 0.8043 | -0.0034 | 4.55 | 7.51 |

**Branch C fires** — MRR range 0.0045 < 0.005. Knob inert on this corpus with rule-based extractor. Defer tuning to sub-phase 9.5 (live extraction regenerates cache on demand and should exercise realistic dedup pressure).

## Notes

- Branch C is pre-registered per 9.4.6 consolidation retro finding: rule-based
  seeder may under-stress dedup/consolidation machinery. Rounds with MRR range
  <0.005 across all points defer tuning to 9.5 live extraction.
- BATCH_SIZE round was dropped mid-flight — changing BATCH_SIZE invalidates the
  warm extraction cache (cache key includes batch composition), causing Modal
  function timeouts on live-LLM fallback. Filed as 9.5 candidate where live
  extraction regenerates cache on demand. See plan decision 3 revision.
- Band rule reminder: updateRate < 0.1 = too strict (dedup rarely fires),
  updateRate > 0.5 = too lax (over-merges distinct facts). Target [0.2, 0.4]
  closest to 0.3.
