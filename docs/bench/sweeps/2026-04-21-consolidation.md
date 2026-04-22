# Consolidation sweep — 2026-04-21

**Corpus:** 2 conversations, 4 QA items
**Primary metric:** mrr
**Swept knob:** DEDUP_JACCARD_THRESHOLD

## Per-threshold aggregate table

| DEDUP_JACCARD_THRESHOLD | added | updated | drained | updateRate | dedupHitRate | recallAt5 | mrr | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 0 | 0 | 0 | 0.0000 | 0.0000 | 1.0000 | 0.6875 | 0.09 | 0.29 |
| 0.6 | 0 | 0 | 0 | 0.0000 | 0.0000 | 1.0000 | 0.6875 | 0.04 | 0.05 |
| 0.7 | 0 | 0 | 0 | 0.0000 | 0.0000 | 1.0000 | 0.6875 | 0.05 | 0.08 |
| 0.8 | 0 | 0 | 0 | 0.0000 | 0.0000 | 1.0000 | 0.6875 | 0.03 | 0.04 |
| 0.9 | 0 | 0 | 0 | 0.0000 | 0.0000 | 1.0000 | 0.6875 | 0.02 | 0.03 |

## Recommended threshold

**Band rule (Phase 6 retro):** updateRate < 0.1 = too strict, > 0.5 = too lax.
Target: updateRate ∈ [0.2, 0.4].

**Recommendation:** No threshold stands out under rule-based extraction.

> Rule-based seeder doesn't exercise realistic dedup pressure. Thresholds are under-stressed; revisit with live LLM consolidation in sub-phase 9.5.

## EXTRACT_MAX_TOKENS inspection (read-only)

factLengths distribution across all points (should be threshold-invariant
since extraction happens before dedup):

| min | p50 | p95 | max |
|---|---|---|---|
| 0 | 0 | 0 | 0 |

Rule-based mock produces facts averaging 0 chars; at ~4 chars/token
this implies median ~0 tokens. Real-LLM extraction (sub-phase 9.5)
may differ. EXTRACT_MAX_TOKENS is defined in extractFacts.js (value redacted
in display output); if p95 < 0.5×cap, room to reduce; if p95 ≈ cap, consider raising.

## envSnapshot

```json
{
  "n": 4,
  "precisionAtK": {
    "1": 0.5,
    "3": 0.25,
    "5": 0.2,
    "10": 0.16666666666666666
  },
  "recallAtK": {
    "1": 0.5,
    "3": 0.75,
    "5": 1,
    "10": 1
  },
  "mrr": 0.6875
}
```
