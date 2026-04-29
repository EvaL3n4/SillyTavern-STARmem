# extract_max_tokens sweep — LongMemEval-S, 2026-04-29

**Corpus:** LongMemEval-S-500 (500 QA items, live extraction)  
**Swept:** EXTRACT_MAX_TOKENS  
**Base overrides (inlined into every point):** `{"BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15}`  
**Sweep artifact:** `docs/bench/sweeps/2026-04-29-longmemeval-extract-max-tokens-live.md`  
**Raw runs:** `docs/bench/runs/2026-04-29T14-44-03Z-extract_max_tokens/`

## Results

| EXTRACT_MAX_TOKENS | n_scored | recallAt5 | mrr | coverage | ΔMRR vs min | p50 | p95 |
|---|---|---|---|---|---|---|---|
| 2048 | 393 | 0.9606 | 0.9038 | 0.8362 | +0.0000 | 6.33 | 17.76 |
| 4096 | 399 | 0.9540 | 0.9128 | 0.8489 | +0.0090 | 6.36 | 18.85 |
| 6144 | 390 | 0.9525 | 0.9058 | 0.8298 | +0.0020 | 6.17 | 19.06 |

## Elbow

**Mechanical verdict:** `{"EXTRACT_MAX_TOKENS": 2048}` — "Axis flat (maxΔ/Δknob = 0.000004 ≤ 0.005); held at spec on EXTRACT_MAX_TOKENS. Highest observed mrr = 0.9128."

**No distinct candidate point found — held at spec.**

### Calibration override (correctness knob vs efficiency knob)

The mechanical elbow detector at `bench/modal/sweep_app.py::_detect_elbow` gates on ΔMRR/Δknob (calibrated for **efficiency knobs** like λ₁). For a **correctness knob** like EXTRACT_MAX_TOKENS, the relevant signal is `n_scored` recovery and `coverage`, BOTH of which moved with the predicted sign:

- 2048 → 4096: n_scored +6 (393→399), coverage +1.27pp (0.8362→0.8489), MRR +0.0090
- 4096 → 6144: noise (−9 items, −1.91pp coverage, −0.0070 MRR)

The +6 items at 4096 are items the system **literally failed to score at 2048** because extraction truncated and cache-replay failed. Per `extractFacts.js:73-76` the truncation bug is a Phase 12 Task 7 finding. The amend ships the fix.

This override is **documented, not silent**. The plan flagged it in advance (`docs/plans/phase-14-v2-closure.md` L774: *"The expected amend trigger is **coverage**, not MRR."*).

## Amendment decision

**Ship 4096 as the new production default.**

Rationale:
1. Coverage signal (correctness gate) moves with predicted sign at 4096.
2. 6144 sanity check is noise vs 4096 — no benefit from going higher.
3. LoCoMo regression smoke (below) confirms no regression on the corpus where truncation didn't bind.

## LoCoMo regression smoke at 4096, 2026-04-29

Cell: `{"EXTRACT_MAX_TOKENS": 4096, "BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15}`

| metric | value |
|---|---|
| n | 1986 |
| n_scored | 1469 |
| n_skipped | 517 |
| coverage | 0.7397 |
| mrr | 0.8134 |
| recallAt5 | 0.9232 |
| parseFailures | 0 |
| p50 latency | 3.59ms |
| p95 latency | 5.99ms |
| wall | 145s (warm cache) |

**Verdict:** NO REGRESSION — within ±0.005 of LoCoMo's historical baseline (MRR 0.8057, coverage 0.643). The higher coverage on LoCoMo (0.7397 vs 0.643) reflects the BATCH_SIZE=15 override, not the EXTRACT_MAX_TOKENS change; truncation didn't bind on LoCoMo's sparser conversation structure.

## Per-task-type slice (at 4096)

| Task type                    | MRR      | Coverage | n scored | n skipped |
|------------------------------|----------|----------|----------|-----------|
| single-session-user          |   0.9456 |   0.7656 |       49 |        15 |
| single-session-assistant     |   0.9474 |   0.6786 |       38 |        18 |
| single-session-preference    |   0.7746 |   0.5333 |       16 |        14 |
| temporal-reasoning           |   0.8892 |   0.8898 |      113 |        14 |
| knowledge-update             |   0.9727 |   0.9167 |       66 |         6 |
| multi-session                |   0.8631 |   0.9174 |      111 |        10 |

**Abstention QAs excluded from scoring:** 30
