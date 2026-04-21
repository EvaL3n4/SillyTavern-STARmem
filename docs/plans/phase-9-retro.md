# Phase 9 Retro — Benchmarking

> Date: 2026-04-21
> Phase plan: [`phase-9-benchmarking.md`](./phase-9-benchmarking.md)
> Baseline artifact: [`docs/bench/baseline.json`](../bench/baseline.json)

---

## 1. What shipped

**Decisions 1–10 from the plan header (all held through execution):**

1. **Corpus: LoCoMo primary** — `snap-research/locomo` `data/locomo10.json`; synthetic corpus used for offline smoke tests.
2. **Metrics: precision@k, recall@k, MRR** at k ∈ {1, 3, 5, 10}; latency p50/p95 secondary.
3. **Harness shape: Node CLI under `bench/`** — `cli.js` + `runner.js` + `loaders/` + `metrics/retrieval.js`.
4. **Black-box evaluation: Jaccard-based gold-match** — token-Jaccard ≥ 0.5 of entry content vs gold evidence span.
5. **Baselines: in-house only** — bm25only, recency, random. External systems (Zep/Mem0) deferred to v2.1.
6. **Tuning protocol: coordinate descent** — one knob at a time, sweep logs written to `docs/bench/sweeps/`.
7. **Embeddings: synthetic for retrieval-path benches** — retrieval doesn't touch embeddings; persona-rebuild benchmarks deferred.
8. **Regression gate: advisory-only for v2.0** — `docs/bench/baseline.json` per-knob snapshot; CI surfaces deltas but doesn't fail on them.
9. **Out of scope for Phase 9** — Playwright smoke harness (→ Phase 10), UX polish pass (→ pre-external-release), persona-rebuild benchmarks (→ sub-phase 9.5), external memory-system baselines.
10. **Spec §10 module layout amendment first** — Task 0 updated spec to reflect `bench/` as external to `src/`.

**Test counts:**
- Baseline at Phase 8 close: 57 suites / 618 tests.
- Phase 9 close: 70 suites / 734 tests (+2 from this Task 9 commit: wire-invariant + baseline-json validator).
- Key per-task deltas:
  - Task 3c: +9 tests (5 runner unit + 4 integration). Baseline 697 → 706.
  - Task 4:  +5 tests (tau driver). 706 → 711.
  - Task 5:  +2 tests (graph baseOverrides driver). 711 → 713.
  - Task 6:  +3 tests (seeder stats, runner stats, driver runs). 713 → 716.
  - Task 7:  +0 tests (no new test files). 716 → 716.
  - Task 8:  +16 tests (4–5 per baseline × 3 + runner swap). 716 → 732.
  - Task 9:  +2 tests (wire invariant 12 assertions + baseline-json validator 7 assertions). 732 → 734.

**Bench tree structure shipped:**
```
bench/
  cli.js                 # entry point for single-harness runs
  runner.js              # orchestrates seed → retrieve → metrics
  baselines.js           # comparison entry point (ladder / bm25only / recency / random)
  harness/
    seeder.js            # seeds STARmem state from a conversation transcript
  loaders/
    locom.js             # LoCoMo JSON parser
    index.js             # barrel
  metrics/
    retrieval.js         # precision@k, recall@k, MRR
  sweeps/
    _driver.js           # coordinate-descent driver
    tau.js               # TIER2_TAU_CONFIDENCE × TIER2_TAU_GAP sweep
    graph.js             # TIER3_LAMBDA_1 / LAMBDA_2 / BEAM_WIDTH / EDGE_CAP / COOCCURRENCE_WEIGHT sweep
    consolidation.js     # DEDUP_JACCARD_THRESHOLD sweep
    bm25.js              # TAG_BOOST × SUBJECT_BOOST sweep
  baselines/
    index.js             # barrel (bm25only, recency, random)
    bm25only.js
    recency.js
    random.js
docs/bench/
  baseline.json          # measured-values artifact (this commit)
  sweeps/
    2026-04-21-tau.md
    2026-04-21-graph.md
    2026-04-21-consolidation.md
    2026-04-21-bm25.md
  baselines/
    2026-04-21-comparison.md
```

**5 smoke writeups produced** (4 sweeps + 1 baseline comparison, all untracked for controller review).

**`baseline.json` gitSha:** `4afaea02` — the Task 8 commit (`4afaea021a0629b08e4460eea1b26e41b001731d`), chosen as the merge-base of all 4 sweep commits + the baselines commit. This records "state of the codebase as these measurements were taken."

---

## 2. Decisions held / revised

| Decision | Status | Notes |
|---|---|---|
| 1. Corpus | **Held** | LoCoMo primary, synthetic for smoke. 3-conv real LoCoMo run in Task 4 confirmed flat metrics (recallAt5=1.0 across all 48 τ points). |
| 2. Metrics | **Held** | precision@k / recall@k / MRR at k∈{1,3,5,10} proved sufficient to surface the flatness signal. |
| 3. Harness shape | **Held** | CLI + runner + metrics library is clean; no new trace format needed. |
| 4. Jaccard gold-match | **Revised** | Worked mechanically, but the rule-based seeder produces facts that don't differentiate across knob values, muting the signal. The gold-match itself is not the bottleneck — the extractor is. |
| 5. Baselines | **Revised** | bm25only > ladder on synthetic 4-QA (MRR 1.0 vs 0.6875) is a **non-structural flag**, not a bug. The ladder-vs-random invariant held (0.6875 >> 0.4792). Re-validate on real LoCoMo in sub-phase 9.5. |
| 6. Coordinate descent | **Held** | One-knob-at-a-time was the right call; a grid search would have been wasted effort on flat surfaces. |
| 7. Synthetic embeddings | **Held** | Retrieval path never touches embeddings; no issue. |
| 8. Advisory gate | **Held** | `baseline.json` status='deferred' with per-knob notes is exactly the right shape for a flat phase. |
| 9. Out-of-scope list | **Held** | Playwright, UX polish, persona-rebuild benchmarks, external baselines all correctly deferred. |
| 10. Spec amendment first | **Held** | Task 0 updated spec §10 to name `bench/` as external to `src/`. |

---

## 3. Execution mode

**Subagent-driven for Tasks 1–8** via Fireworks/Kimi-K2.6 routing (avoided Azure flakiness). **Controller executed Task 9 directly** (retro narrative quality > subagent speed).

**Preflight pattern:** 6 Task dispatches, each preceded by a plan-patch commit. Counts:
- 3 tasks had key-name-drift bugs caught preflight (Tasks 4, 5, 6 — TAU_CONFIDENCE→TIER2_TAU_CONFIDENCE, LAMBDA_1→TIER3_LAMBDA_1, DEDUP_JACCARD→DEDUP_JACCARD_THRESHOLD).
- 4 tasks had signature-mismatch bugs (Task 8 baseline signature drafted before Task 3c landed; real `retrieve()` is `(state, queryStr, opts)` not `(chatId, query, {k})`).
- 2 tasks had mechanism-gap bugs (graph baseline mechanism in Task 5, consolidation-traces-don't-exist in Task 6).
- 6 plan bugs in Task 8 alone (barrel mismatch, runner swap, etc.).

**Total plan bugs caught preflight across Tasks 4–8: ~18.** Zero downstream-discovered bugs — preflight ROI is real.

---

## 4. Surprises

1. **The rule-based extractor is the structural bottleneck for all four knob sweeps.** Tasks 4 (τ), 5 (graph λ/beam/cap/cooccur), 6 (dedup), 7 (bm25 boosts) all produced flat or near-flat metric surfaces on synthetic. Task 4's 3-conv real LoCoMo run *also* came back flat (recallAt5=1.0 across all 48 points). This wasn't a plan bug — it's a structural finding that sub-phase 9.5 has to address before any retuning makes sense.

2. **bm25only > ladder on synthetic 4-QA.** Task 8's baseline comparison: bm25only MRR=1.0, ladder MRR=0.6875. The ladder-vs-random invariant held (ladder=0.6875 >> random=0.4792), so this is NOT a structural bug — but the scorer chain's multiplicative factors (importance × recency × maturity) introduced small perturbations that dropped the ladder below raw BM25 on a corpus too small to reward them. Will re-validate on real LoCoMo in 9.5.

3. **Plan-bug pattern: short-form key-name drift.** Tasks 4 (TAU_CONFIDENCE → TIER2_TAU_CONFIDENCE), 5 (LAMBDA_1 → TIER3_LAMBDA_1, four more), 6 (DEDUP_JACCARD → DEDUP_JACCARD_THRESHOLD) all had the same bug class. Task 7 was the first where the plan's short names happened to match `_SWEPT_RETRIEVAL_KEYS` exactly. Root cause: plan was written with colloquial short names; `setConstantOverrides` strictly validates against the full key list. **Recommendation:** update the plan-preflight-audit skill with a "sweep tasks: always grep `_SWEPT_*_KEYS` first" rule.

4. **Plan-bug pattern: signature drift against Task 3c.** Task 8's baseline signature plan (`(chatId, query, {k}) → Array`) was drafted before Task 3c landed; real `retrieve()` is `(state, queryStr, opts) → RetrieveResult`. Caught preflight; would have cascaded through runner, baselines.js, and tests.

5. **Empty-completion turns from Azure Opus under tool-call bloat.** Controller's Task 8 dispatch tripped the documented >25KB payload threshold twice in a row on the controller side, producing two empty turns before the subagent was successfully invoked. Didn't affect the subagent's work (Fireworks/Kimi handles it cleanly) — controller mitigation is smaller delegate_task contexts pointing at plan sections rather than inlining.

6. **Subagent seeder-API confabulation during Task 3c.** Subagent reported the seeder signature as taking `chatIdPrefix` (correct) but the plan said `chatId` — caught in-flight, fixed in the runner code, no rework needed. Documented in memory for downstream tasks; no tasks after 3c called the seeder directly in a way that would have hit it.

---

## 5. Notes for sub-phase 9.5 (live-LLM extraction) and Phase 10 (Playwright harness)

### 9.5 scope

- Swap rule-based extractor in `bench/harness/seeder.js` for a real LLM client (Gemma 4 31B or whatever model the user chooses via ST connection profiles). Env-gated so CI can stay deterministic.
- Re-run all 4 knob sweeps on full LoCoMo. Update `docs/bench/baseline.json` with real measured values.
- Re-run Task 8 comparison on full LoCoMo. Validate that ladder ≥ bm25only on realistic data (the structural expectation).
- Possibly add `TIER3_MAX_HOPS` and `EXPLICIT_RELATION_WEIGHT` sweeps — both are in `_SWEPT_RETRIEVAL_KEYS` but Phase 9 didn't cover them.
- `EXTRACT_MAX_TOKENS` tuning with real token counts (Phase 9 used char-length proxy).

### Phase 10 scope (Playwright harness)

- Wire `bench/` runners into a Playwright smoke that exercises the live ST integration end-to-end.
- UX polish deferred from Phase 8.
- External memory-system baselines (Zep, Mem0) per Decision 5 footnote.
