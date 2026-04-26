# lambda1_tripwire sweep — 2026-04-26

**Corpus:** LongMemEval-S-500 (500 QA items, live extraction)
**Swept:** TIER3_LAMBDA_1
**Base overrides (inlined into every point):** `{"TIER2_TAU_GAP": 10, "BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15}`

## Results

| TIER3_LAMBDA_1 | n_scored | recallAt5 | mrr | coverage | ΔMRR vs min | p50 | p95 |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 393 | 0.9606 | 0.9038 | 0.8362 | +0.0000 | 5.89 | 11.29 |
| 0.75 | 393 | 0.9606 | 0.9038 | 0.8362 | +0.0000 | 5.25 | 10.88 |
| 1 | 393 | 0.9606 | 0.9038 | 0.8362 | +0.0000 | 5.59 | 10.75 |
| 1.25 | 393 | 0.9606 | 0.9038 | 0.8362 | +0.0000 | 5.59 | 10.15 |
| 1.5 | 393 | 0.9606 | 0.9038 | 0.8362 | +0.0000 | 5.62 | 10.23 |

## Elbow

**Recommended:** `{"TIER3_LAMBDA_1": 0.5}`
**Rationale:** Axis flat (maxΔ/Δknob = 0.000000 ≤ 0.005); held at spec on TIER3_LAMBDA_1. Highest observed mrr = 0.9038.
### Amendment verdict

No distinct candidate point found — held at spec.

### Per-task-type slice

| Task type                    | MRR      | Coverage | n scored | n skipped |
|------------------------------|----------|----------|----------|-----------|
| single-session-user          |   0.9456 |   0.7656 |       49 |        15 |
| single-session-assistant     |   0.9474 |   0.6786 |       38 |        18 |
| single-session-preference    |   0.7746 |   0.5333 |       16 |        14 |
| temporal-reasoning           |   0.8892 |   0.8898 |      113 |        14 |
| knowledge-update             |   0.9727 |   0.9167 |       66 |         6 |
| multi-session                |   0.8631 |   0.9174 |      111 |        10 |


**Abstention QAs excluded from scoring:** 30
