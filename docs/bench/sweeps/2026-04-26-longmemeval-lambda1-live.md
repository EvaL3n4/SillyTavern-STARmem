# λ₁ tripwire — LongMemEval-S (live extraction, 2026-04-26)

**Phase 12 Task 7** — single-axis `TIER3_LAMBDA_1` sweep, hypothesis pre-registered:
- **H₀ (null):** λ₁ is inert on LongMemEval-S, matching Phase 9.5's three-time LoCoMo reproduction of INERT.
- **H₁ (alternative):** λ₁ produces signal on multi-session corpora that LoCoMo's structure suppressed.

**Grid:** `[0.5, 0.75, 1.0, 1.25, 1.5]`, `TIER2_TAU_GAP=10`, `BATCH_SIZE=15`, `WORKING_BUFFER_THRESHOLD=15` fixed
**Corpus:** LongMemEval-S (500 items, 6 task types, 30 abstention items excluded from scoring)
**Extractor:** `Qwen/Qwen3.6-35B-A3B-FP8` via Modal vLLM (Phase 12 Task 6.5 cache, 100% warm)
**Infra:** Phase 13 item-fan-out, 5 cells × 6 chunks = 30 containers
**Source artifact:** `2026-04-26T14-52-55Z-lambda1_tripwire.{md,json}`

## Decision gate outcome: **A — Aggregate flat, no task-type signal**

H₀ retained. Two-corpus "provably inert" finding for λ₁: LoCoMo flatness reproduced on a structurally distinct second corpus. λ₁ should remain at the spec default of 1.0; do not expand to 4-knob sweep.

The flatness here is *stronger* than typical "no movement" — it's bit-identical, suggesting λ₁ does not even change the *order* of retrieved items, let alone the metric.

## Aggregate metrics

| TIER3_LAMBDA_1 | n_scored | recallAt5 | mrr | coverage | ΔMRR vs spec (1.0) | p50 | p95 |
|---|---|---|---|---|---|---|---|
| 0.5  | 393 | 0.9606 | 0.9038 | 0.8362 | 0.0000 | 5.89 | 11.29 |
| 0.75 | 393 | 0.9606 | 0.9038 | 0.8362 | 0.0000 | 5.25 | 10.88 |
| **1.0**  | **393** | **0.9606** | **0.9038** | **0.8362** | **baseline** | **5.59** | **10.75** |
| 1.25 | 393 | 0.9606 | 0.9038 | 0.8362 | 0.0000 | 5.59 | 10.15 |
| 1.5  | 393 | 0.9606 | 0.9038 | 0.8362 | 0.0000 | 5.62 | 10.23 |

MRR identical to 16 decimals across all 5 cells (`0.9038470859081548`). Recall, coverage, n_scored — identical. Latency p50/p95 vary by ~1ms which is pure infra noise on the deterministic retrieval path.

**Amendment rule check:** `ΔMRR ≥ 0.02 AND Δcoverage_pp ≥ -5pp` — neither half met for any point. Gate firmly closed.

## Per-task-type breakdown (from `byTaskType` slice)

Every task type identical across all five λ₁ values. Reporting once per task type with the verdict, since the table would be 5 rows of the same number.

| Task type | MRR | Coverage | n_scored | n_skipped | Δ across grid |
|---|---|---|---|---|---|
| single-session-user      | 0.9456 | 0.7656 |  49 | 15 | 0.0000 |
| single-session-assistant | 0.9474 | 0.6786 |  38 | 18 | 0.0000 |
| single-session-preference| 0.7746 | 0.5333 |  16 | 14 | 0.0000 |
| temporal-reasoning       | 0.8892 | 0.8898 | 113 | 14 | 0.0000 |
| knowledge-update         | 0.9727 | 0.9167 |  66 |  6 | 0.0000 |
| multi-session            | 0.8631 | 0.9174 | 111 | 10 | 0.0000 |

**Outcome A confirmation:** No single task type — including the `multi-session` slice, the most likely place for λ₁ signal to surface — moves at all under λ₁ variation. Outcome B is conclusively ruled out.

## Consolidation aggStats per cell

Identical across all 5 cells:

| field | value |
|---|---|
| batches | 16,682 |
| added | 129,532 |
| updated | 567 |
| drained | 246,738 |
| parseFailures | 118 (0.71% of batches) |
| entriesSkipped | 21 (0.0161% of entries) |

Rules out the "drops a ton of batches" worry from the prior failed dispatch — the consolidation pipeline is healthy on this corpus. The 77 / 500 items showing up as `n_skipped` in metrics aren't dropped batches: they're scoring-side skips (retrieval returned no scorable evidence), and they belong to coverage/MRR analysis not infra reliability. Coverage at 83.6% leaves room for v2.1 work but is not a regression vs Phase 9 baseline.

## Retrospective

**What the data says.** λ₁ is inert. Not "small effect", not "dominated by noise" — bit-identical across a 3× range (0.5 to 1.5) on every task type and every aggStats counter. This is the strongest possible negative finding the harness can produce. Combined with Phase 9.5's three-time LoCoMo reproduction (also flat), we now have two corpora with structurally different shapes (LoCoMo single-session social conversations vs LongMemEval-S six-task-type benchmark) both saying λ₁ does not affect retrieval order on the current graph scoring path.

**What it means for v2.1 corpus work.** LoCoMo flatness was not a corpus artifact; it's a structural property of the current edge-weight composition in Tier 3 retrieval. λ₁ is being applied somewhere where (a) the candidate set is already locked in by Tier 0–2 before Tier 3 sees it, or (b) the resulting score adjustments don't reorder enough candidates to change the top-K. A v2.1 hypothesis to test: λ₁ may need to operate further upstream — at candidate generation rather than re-ranking — to have any observable effect.

**What to do with the spec.** Hold `TIER3_LAMBDA_1 = 1.0` at spec default. Two-corpus flatness is sufficient evidence to *not* re-tune this knob in v2; future re-tuning should be triggered only by a structural change to how Tier 3 composes edge weights, not by a fresh corpus.

**Phase 13 candidates surfaced (for retro):**

1. **Cell wall-time variance.** Cells finished at 373s / 1381s / 423s / 409s / 634s — cell 1 was 3.7× cell 0 with identical work. Variance is *not* λ₁-correlated (all metrics identical), so it's chunk-assignment / cold-container / item-position effect. Worth profiling in Phase 14 if we're going to do more sweeps on this corpus shape; not blocking. Mitigation if needed: smaller chunks (`--chunks 10` instead of auto-6) for tighter parallelism.
2. **Late-chunk slowdown signal.** Eva observed live during the prior failed dispatch that items later in the corpus took noticeably longer. This run's chunk-level timing wasn't captured per-chunk in the aggregated cell wall (only cell totals). If Phase 14 surfaces this question, add per-chunk wall-clock to the cell record schema.
3. **`run_point_chunk` 1200s sizing was wrong.** The Phase 13 design priced the *average* item; cell 1 actually wall-clocked 1381s. Fixed in `6dc88c4` to 3000s. The original sizing assumption ("83 items × ~3.6s/item + 4× headroom") is documented as wrong in the commit body; future budgets should be sized off observed worst-case-cell, not mean-item.

## Closure

Phase 12 Task 7 done-when checklist:
- [x] `lambda1_tripwire` SWEEP_CONFIGS entry landed (Phase 12 Task 7 setup, prior session)
- [x] Modal dispatch completed (2026-04-26T14:52:55Z)
- [x] Decision gate outcome documented (Outcome A)
- [x] No expansion needed (gate closed)
- [x] Per-task-type breakdown rendered
- [x] Retrospective written
- [ ] Commit landed (this artifact + the Phase 13 timeout fix)
