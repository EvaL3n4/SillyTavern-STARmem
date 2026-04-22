# Consolidation sweep — 2026-04-22

**Corpus:** 10 conversations, 1986 QA items
**Primary metric:** mrr
**Swept knob:** DEDUP_JACCARD_THRESHOLD

## Per-threshold aggregate table

| DEDUP_JACCARD_THRESHOLD | added | updated | drained | updateRate | dedupHitRate | recallAt5 | mrr | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|
| 0.5 | 2752 | 127 | 5805 | 0.0441 | 0.0219 | 0.0057 | 0.1118 | 1.99 | 4.37 |
| 0.6 | 2811 | 68 | 5805 | 0.0236 | 0.0117 | 0.0056 | 0.1118 | 2.25 | 4.55 |
| 0.7 | 2837 | 42 | 5805 | 0.0146 | 0.0072 | 0.0056 | 0.1118 | 2.25 | 4.61 |
| 0.8 | 2848 | 31 | 5805 | 0.0108 | 0.0053 | 0.0056 | 0.1118 | 2.26 | 4.68 |
| 0.9 | 2859 | 20 | 5805 | 0.0069 | 0.0034 | 0.0056 | 0.1119 | 2.12 | 4.34 |

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
| 11 | 69 | 110 | 183 |

Rule-based mock produces facts averaging 69 chars; at ~4 chars/token
this implies median ~17 tokens. Real-LLM extraction (sub-phase 9.5)
may differ. EXTRACT_MAX_TOKENS is defined in extractFacts.js (value redacted
in display output); if p95 < 0.5×cap, room to reduce; if p95 ≈ cap, consider raising.

## envSnapshot

```json
{
  "n": 1986,
  "n_scored": 1415,
  "n_skipped": 571,
  "precisionAtK": {
    "1": 0.0007067137809187279,
    "3": 0.001177856301531213,
    "5": 0.0011307420494699645,
    "10": 0.08676285826462392
  },
  "recallAtK": {
    "1": 0.0007067137809187279,
    "3": 0.0035335689045936395,
    "5": 0.005653710247349823,
    "10": 0.610777385159011
  },
  "mrr": 0.11184925002174932
}
```
