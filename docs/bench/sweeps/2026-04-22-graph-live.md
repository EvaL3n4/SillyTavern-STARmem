# Graph sweep — 2026-04-22

**Corpus:** 10 conversations, 1986 QA items
**Primary metric:** mrr
**Baseline:** `TIER2_TAU_GAP=10` alone (MRR 0.8077, docs/bench/baseline.json::headlineMetrics.ladder post-9.4.8)
**Base overrides on every point:** `{"TIER2_TAU_GAP": 10}`
**Rounds:** 6 coordinate-descent; each round's winner pins into the next.

## Round — TIER3_LAMBDA_1

**Base overrides:** `{"TIER2_TAU_GAP": 10}`

| TIER3_LAMBDA_1 | n_scored | recallAt5 | precisionAt3 | mrr | p50 | p95 | ΔMRR vs gap=10 |
|---|---|---|---|---|---|---|---|
| **0.5** | 1277 | 0.9363 | 0.3981 | 0.8057 | 4.18 | 6.15 | -0.0020 |
| 0.75 | 1277 | 0.9363 | 0.3981 | 0.8057 | 4.10 | 6.66 | -0.0020 |
| 1 | 1277 | 0.9363 | 0.3981 | 0.8057 | 4.41 | 6.84 | -0.0020 |
| 1.25 | 1277 | 0.9363 | 0.3981 | 0.8057 | 4.39 | 6.96 | -0.0020 |
| 1.5 | 1277 | 0.9363 | 0.3981 | 0.8057 | 3.92 | 5.98 | -0.0020 |

**Winner:** `TIER3_LAMBDA_1 = 0.5` (mrr=0.8057, ΔMRR vs gap=10 = -0.0020)

## Round — TIER3_LAMBDA_2

**Base overrides:** `{"TIER2_TAU_GAP": 10, "TIER3_LAMBDA_1": 0.5}`

| TIER3_LAMBDA_2 | n_scored | recallAt5 | precisionAt3 | mrr | p50 | p95 | ΔMRR vs gap=10 |
|---|---|---|---|---|---|---|---|
| **0.1** | 1277 | 0.9363 | 0.3981 | 0.8057 | 3.73 | 5.64 | -0.0020 |
| 0.2 | 1277 | 0.9363 | 0.3981 | 0.8057 | 3.96 | 5.93 | -0.0020 |
| 0.3 | 1277 | 0.9363 | 0.3981 | 0.8057 | 3.90 | 6.20 | -0.0020 |
| 0.4 | 1277 | 0.9363 | 0.3981 | 0.8057 | 3.92 | 6.56 | -0.0020 |
| 0.5 | 1277 | 0.9363 | 0.3981 | 0.8057 | 4.24 | 6.53 | -0.0020 |

**Winner:** `TIER3_LAMBDA_2 = 0.1` (mrr=0.8057, ΔMRR vs gap=10 = -0.0020)

## Round — TIER3_BEAM_WIDTH

**Base overrides:** `{"TIER2_TAU_GAP": 10, "TIER3_LAMBDA_1": 0.5, "TIER3_LAMBDA_2": 0.1}`

| TIER3_BEAM_WIDTH | n_scored | recallAt5 | precisionAt3 | mrr | p50 | p95 | ΔMRR vs gap=10 |
|---|---|---|---|---|---|---|---|
| **3** | 1263 | 0.9559 | 0.4025 | 0.8132 | 4.29 | 6.61 | +0.0055 |
| 5 | 1277 | 0.9363 | 0.3981 | 0.8057 | 3.69 | 5.66 | -0.0020 |
| 8 | 1291 | 0.9188 | 0.3938 | 0.7982 | 3.83 | 5.42 | -0.0095 |
| 10 | 1292 | 0.9167 | 0.3934 | 0.7976 | 4.14 | 6.22 | -0.0101 |

**Winner:** `TIER3_BEAM_WIDTH = 3` (mrr=0.8132, ΔMRR vs gap=10 = +0.0055)

## Round — TIER3_SEEDS_K

**Base overrides:** `{"TIER2_TAU_GAP": 10, "TIER3_LAMBDA_1": 0.5, "TIER3_LAMBDA_2": 0.1, "TIER3_BEAM_WIDTH": 3}`

| TIER3_SEEDS_K | n_scored | recallAt5 | precisionAt3 | mrr | p50 | p95 | ΔMRR vs gap=10 |
|---|---|---|---|---|---|---|---|
| **1** | ⚠️ 995 | 0.9709 | 0.5278 | 0.9228 | 3.67 | 5.34 | +0.1151 |
| 3 | 1263 | 0.9559 | 0.4025 | 0.8132 | 3.67 | 5.45 | +0.0055 |
| 5 | 1362 | 0.9302 | 0.3732 | 0.7689 | 3.95 | 6.04 | -0.0388 |
| 7 | ⚠️ 1424 | 0.8632 | 0.3570 | 0.7414 | 4.22 | 6.40 | -0.0663 |

**Winner:** `TIER3_SEEDS_K = 1` (mrr=0.9228, ΔMRR vs gap=10 = +0.1151) **(clears amendment threshold)**

> **⚠️ Coverage warning:** at least one point in this round deviates >5.0pp from post-9.4.8 baseline coverage (~64%). MRR gains may reflect subset-selection bias — the knob traded coverage for per-query precision. Verify against recall@5 on the full corpus before amending.

## Round — EDGE_CAP_PER_ENTRY

**Base overrides:** `{"TIER2_TAU_GAP": 10, "TIER3_LAMBDA_1": 0.5, "TIER3_LAMBDA_2": 0.1, "TIER3_BEAM_WIDTH": 3, "TIER3_SEEDS_K": 1}`

| EDGE_CAP_PER_ENTRY | n_scored | recallAt5 | precisionAt3 | mrr | p50 | p95 | ΔMRR vs gap=10 |
|---|---|---|---|---|---|---|---|
| **10** | ⚠️ 968 | 0.9751 | 0.5344 | 0.9377 | 3.73 | 5.69 | +0.1300 |
| 15 | ⚠️ 982 | 0.9717 | 0.5261 | 0.9287 | 3.72 | 5.67 | +0.1210 |
| 20 | ⚠️ 995 | 0.9709 | 0.5278 | 0.9228 | 3.67 | 5.82 | +0.1151 |
| 30 | ⚠️ 1002 | 0.9690 | 0.5281 | 0.9194 | 4.19 | 6.40 | +0.1117 |
| 50 | ⚠️ 1021 | 0.9685 | 0.5295 | 0.9088 | 4.30 | 6.46 | +0.1011 |

**Winner:** `EDGE_CAP_PER_ENTRY = 10` (mrr=0.9377, ΔMRR vs gap=10 = +0.1300) **(clears amendment threshold)**

> **⚠️ Coverage warning:** at least one point in this round deviates >5.0pp from post-9.4.8 baseline coverage (~64%). MRR gains may reflect subset-selection bias — the knob traded coverage for per-query precision. Verify against recall@5 on the full corpus before amending.

## Round — COOCCURRENCE_WEIGHT

**Base overrides:** `{"TIER2_TAU_GAP": 10, "TIER3_LAMBDA_1": 0.5, "TIER3_LAMBDA_2": 0.1, "TIER3_BEAM_WIDTH": 3, "TIER3_SEEDS_K": 1, "EDGE_CAP_PER_ENTRY": 10}`

| COOCCURRENCE_WEIGHT | n_scored | recallAt5 | precisionAt3 | mrr | p50 | p95 | ΔMRR vs gap=10 |
|---|---|---|---|---|---|---|---|
| **0.25** | ⚠️ 968 | 0.9751 | 0.5344 | 0.9377 | 3.87 | 5.93 | +0.1300 |
| 0.5 | ⚠️ 968 | 0.9751 | 0.5344 | 0.9377 | 4.03 | 6.04 | +0.1300 |
| 0.75 | ⚠️ 968 | 0.9751 | 0.5344 | 0.9377 | 3.72 | 5.40 | +0.1300 |
| 1 | ⚠️ 968 | 0.9751 | 0.5344 | 0.9377 | 3.65 | 5.73 | +0.1300 |

**Winner:** `COOCCURRENCE_WEIGHT = 0.25` (mrr=0.9377, ΔMRR vs gap=10 = +0.1300) **(clears amendment threshold)**

> **⚠️ Coverage warning:** at least one point in this round deviates >5.0pp from post-9.4.8 baseline coverage (~64%). MRR gains may reflect subset-selection bias — the knob traded coverage for per-query precision. Verify against recall@5 on the full corpus before amending.

## Composite elbow

All round winners stacked as a single override set:

```json
{
  "TIER2_TAU_GAP": 10,
  "TIER3_LAMBDA_1": 0.5,
  "TIER3_LAMBDA_2": 0.1,
  "TIER3_BEAM_WIDTH": 3,
  "TIER3_SEEDS_K": 1,
  "EDGE_CAP_PER_ENTRY": 10,
  "COOCCURRENCE_WEIGHT": 0.25
}
```

**Composite ΔMRR vs gap=10 baseline:** +0.1300 — clears amendment threshold (0.02).

## Spec amendment proposal

Per-round amendments (amendment threshold = ΔMRR ≥ 0.02):

- `TIER3_LAMBDA_1`: spec default `1.0` → measured `0.5` (ΔMRR -0.0020) — below threshold, hold at spec default
- `TIER3_LAMBDA_2`: spec default `0.3` → measured `0.1` (ΔMRR -0.0020) — below threshold, hold at spec default
- `TIER3_BEAM_WIDTH`: spec default `5` → measured `3` (ΔMRR +0.0055) — below threshold, hold at spec default
- `TIER3_SEEDS_K`: spec default `3` → winning value `1` (ΔMRR +0.1151 but coverage 50.1% deviates >5.0pp from baseline) — **HOLD (subset-selection bias)**
- `EDGE_CAP_PER_ENTRY`: spec default `20` → winning value `10` (ΔMRR +0.1300 but coverage 48.7% deviates >5.0pp from baseline) — **HOLD (subset-selection bias)**
- `COOCCURRENCE_WEIGHT`: spec default `0.5` → winning value `0.25` (ΔMRR +0.1300 but coverage 48.7% deviates >5.0pp from baseline) — **HOLD (subset-selection bias)**

Each AMEND knob ships as a separate commit per plan decision 5 —
src/core/constants.js default + docs/specs/2026-04-20-starmem-v2-design.md
§5.1 tuning callout + docs/bench/baseline.json::tuned entry update.

## Notes

- The baseline is gap=10 alone (not spec-default gap=0.5). Graph knobs
  are only meaningful when Tier 2 gating is disabled, and 9.4.8 showed
  that's the current production default. ΔMRR measurements here are
  therefore on top of 9.4.8's +0.0625 MRR amendment.
- Winner rows are **bolded** in each round's table. The elbow is the
  MRR-best point in the round, not necessarily the middle of the range.
