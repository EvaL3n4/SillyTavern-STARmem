# Phase 12 Retro — Multi-Corpus Benchmarking

**Plan:** [`phase-12-multi-corpus.md`](./phase-12-multi-corpus.md)
**Sub-plans:** [`phase-12-task-6-extraction-cost-decision.md`](./phase-12-task-6-extraction-cost-decision.md), [`phase-12-task-6-fireworks-batch.md`](./phase-12-task-6-fireworks-batch.md), [`phase-12-task-6-5-modal-vllm-warmup.md`](./phase-12-task-6-5-modal-vllm-warmup.md), [`phase-12-task-6-5-retro.md`](./phase-12-task-6-5-retro.md), [`phase-13-item-fan-out.md`](./phase-13-item-fan-out.md)
**Shipped:** 2026-04-26 at commit `707e975` (this retro is the closing commit)
**Corpora:** LoCoMo 10 conversations (1986 QA items, regression control) + LongMemEval-S (500 QA items, 6 task types, multi-session evaluation)
**Extractor:** `Qwen/Qwen3.6-35B-A3B-FP8` via Modal vLLM, temperature=0 — *substrate swap from `google/gemma-4-26b-a4b-it` via Nano-GPT*, executed in Task 6.5 after Task 6's Fireworks Batch path dead-ended (see §4 surprise 1)
**Baseline artifact:** [`docs/bench/baseline.json`](../bench/baseline.json) (now with `perCorpus` structure)
**Scope:** 8 of 8 tasks landed (with one mid-phase substrate swap as Task 6.5). λ₁ tripwire decision-gate on LongMemEval-S: **Outcome A — provably inert**, two-corpus reproduction of Phase 9.5's flatness.

---

## 1. What shipped

**The substrate that lets STARmem be measured against more than one corpus.** Phase 11 had the right gates and the right metrics; Phase 12 had the right *corpora* to put under them. The two pivotal landings: a `CorpusAdapter` interface with a fixture-tested LongMemEval-S adapter, and a Modal `--corpus` parameter that flows through every dispatch mode. Around those, a major substrate swap (Fireworks Batch → Modal vLLM) and an item-fan-out infrastructure refactor (Phase 13, pulled forward) were forced by reality and shipped successfully.

### Artifacts + code changes

| # | Task | Commit | Notes |
|---|---|---|---|
| 0 | Plan | `8ab5231` | 2639 LOC plan, preflight-verified |
| 1 | Tier 2 demolition (always seed Tier 3) | `4e353c9` + `7a8ce5e` (review) | ~30 LOC, zero retrieval-surface risk |
| 2 | `CorpusAdapter` + LoCoMo port | `b2f6a8e` | `bench/loaders/` → `bench/corpora/` (re-export shim retained) |
| 3 | LongMemEval-S adapter + HF fetch/cache | `5cd7e93` | Stratified sampling, fixture-based tests |
| 4 | `byTaskType` slice in `computeMetrics` | `d123af5` + `c62a083` (review) | LoCoMo backward compat preserved |
| 5 | Modal `--corpus` across all 3 modes | `4384d12` | Decorator invariant verified post-landing |
| 6 (Fireworks path) | Fireworks batch warmup wiring | 14 commits, `f5c689b..3ebce17` | Ultimately **dead-ended** at Fireworks API-shape mismatches; substrate swap forced |
| 6.5 (substrate swap) | Modal vLLM warmup app | 13 commits, `a901ac9..1c71882` | New plan `phase-12-task-6-5-modal-vllm-warmup.md` (see [Task 6.5 retro](./phase-12-task-6-5-retro.md)) |
| 7 (λ₁ tripwire) | Live sweep on LongMemEval-S | `707e975` (artifact + closure) | **Decision-gate Outcome A**, two-corpus inert |
| 13 (item-fan-out, pulled forward) | `run_point_chunk` + harness slice | 7 commits, `f033c85..6dc88c4` | Mid-Task-7 architectural fix; see §4 surprise 3 |
| 8 | This retro + ROADMAP entry | *(current)* | — |

**Total: 79 commits** across the phase (`8ab5231..HEAD`). Phase 11 was 13.

The 79-commit count is real, not bookkeeping noise. Task 6 alone produced 14 commits (Fireworks API shape mismatches surfaced one at a time on each new dispatch — see §4 surprise 1), Task 6.5 the substrate swap added another 13, Phase 13 pulled forward added 7 plus 4 tactical timeout fixes inside Task 7. The "core 8 tasks" themselves are ~10 commits; the rest is architectural reality.

### Test counts

- Phase 11 close: 77 suites / 824 tests (jest), 8 tests (pytest bench/modal)
- Phase 12 close: **89 suites / 945 tests (jest, +12 suites / +121 assertions), 57 tests (pytest bench/modal, +49)**
- Net delta: +121 jest, +49 pytest, all green, zero regressions across the phase boundary.

The pytest gain is dominated by Task 6.5 (vLLM warmup tests) and Phase 13 (chunk-plan + cell-aggregator coverage). The jest gain spreads across CorpusAdapter, byTaskType propagation, LongMemEval fixture tests, and the various per-task-6 helper functions extracted from the Fireworks/Modal warmup pipeline.

### Infrastructure surface added

```
bench/corpora/                              # CorpusAdapter interface (Task 2)
  ├── adapter.js                            # base contract
  ├── locomo.js                             # ported from bench/loaders/
  └── longmemeval.js                        # new (Task 3)

bench/modal/sweep_app.py
  ├── run_point_chunk(...)                  # item-fan-out worker (Phase 13 pulled forward)
  ├── run_sweep --chunks K                  # CLI override for chunk count
  └── --corpus {locomo, longmemeval-s}      # parameterized across all modes (Task 5)

bench/modal/vllm_warmup.py                  # NEW — Modal vLLM offline batch (Task 6.5)
bench/sweeps/_modal-chunk.js                # harness slice for item-indexed dispatch
bench/sweeps/_recompute-metrics.js          # metric recomputation per cell post-fan-out

docs/bench/sweeps/2026-04-26-longmemeval-lambda1-live.md  # Task 7 closure
docs/bench/runs/                            # gitignored ephemeral artifacts (Decision)
```

---

## 2. Decision-gate outcome (the headline)

**Outcome A — λ₁ provably inert on two structurally distinct corpora.**

LongMemEval-S λ₁ ∈ {0.5, 0.75, 1.0, 1.25, 1.5} sweep results: MRR identical to 16 decimals across all 5 cells (`0.9038470859081548`), recall identical, coverage identical, every aggStats counter identical, every task-type slice identical. Combined with Phase 9.5's three-time LoCoMo reproduction of the same flatness, this is the strongest possible "not worth tuning" verdict the harness can produce.

**Spec hold:** `TIER3_LAMBDA_1 = 1.0` retained at default. No 4-knob expansion. No task-type-only signal (Outcome B was conclusively ruled out — every task type, including `multi-session` and `temporal-reasoning` where signal was most plausible, is bit-identical across the grid).

**v2.1 hypothesis surfaced:** the flatness is *structural* to the current Tier 3 placement of λ₁. Either (a) candidate sets are already locked in by Tier 0–2 before λ₁ sees them, or (b) the score adjustments don't reorder enough candidates to change top-K. Future re-tuning attempts should move λ₁ upstream — to candidate generation rather than re-ranking — not re-sweep at the current site.

---

## 3. Decisions held / revised

- **Decisions 1–9, 12:** held.
- **Decision 10 (abstention scoring):** held — abstention QAs reported by count not scored.
- **Decision 11 (`EXTRACT_MAX_TOKENS → 256` deferral):** held — still deferred to v2.1.
- **Mid-phase substrate swap (Task 6 → Task 6.5):** Fireworks Batch path was the planned warmup substrate; six API-shape mismatch fixes later, the path was abandoned and replaced with Modal vLLM offline batch on a single H100. This wasn't a planned decision; it was forced by Fireworks's batch API surface being more brittle than the docs implied. The substrate swap is documented in `phase-12-task-6-5-modal-vllm-warmup.md`.
- **Phase 13 pulled forward as Task 7.5:** Original plan reserved item-fan-out for Phase 13. Task 7's λ₁ sweep timed out repeatedly under the cell-serial architecture; rather than continue bumping timeouts, Eva called the architectural fix forward. New plan `phase-13-item-fan-out.md` written mid-Task-7, executed in 7 commits, then Task 7 dispatched cleanly.

---

## 4. Surprises

### 1. Fireworks Batch API-shape brittleness forced a full substrate swap

The plan budgeted Task 6 as a 1–2 commit warmup wiring against Fireworks Batch. Reality was 14 commits chasing API-shape mismatches that surfaced one at a time on each new dispatch:

- `dataset-create` API shape (`example_count` placement, snake_case wire fields)
- Job state strings arrive proto-prefixed (`JOB_STATE_COMPLETED` not `COMPLETED`)
- Results filename is `BIJOutputSet.jsonl`, not `results*.jsonl`
- Download GET must not send a body (per spec — but spec was wrong on this)
- Response shape lacks the OpenAI-Batch wrapper documented elsewhere

Each fix unblocked one further request and surfaced the next. The pattern is "API surface is documented optimistically" and the only way to find each mismatch is to actually dispatch and read the failure. Eventually we shipped `c3aa4c7` — a smoke-audit doc — and pivoted entirely to Modal vLLM (Task 6.5). **Modal vLLM landed in 13 commits** including a successful `Qwen/Qwen3.6-35B-A3B-FP8` warmup at 2,731 sustainedOutTokPerS, byte-compat with the existing extraction cache schema. Full retro at [`phase-12-task-6-5-retro.md`](./phase-12-task-6-5-retro.md).

**Lesson:** Vendor batch APIs that aren't OpenAI-Batch-compatible should be smoke-audited end-to-end *before* a phase plan budgets them. The Fireworks docs implied compatibility; the wire didn't.

### 2. λ₁ tripwire decision-gate Outcome A is the headline finding

Pre-registration was: H₀ inert (matches LoCoMo) vs H₁ signal on multi-session corpus. Phase 9.5's three-time LoCoMo flatness left "could be a corpus artifact" as the structural-skeptic alternative. **The data destroyed it:** 16-decimal identical MRR across the grid, on every task type. Not "small effect drowned in noise" — the retrieval order is bit-identical across a 3× λ₁ range. The v2.1 hypothesis is now well-formed (move λ₁ upstream of re-ranking) and the spec stays at 1.0 with confidence.

### 3. Cell-serial architecture didn't survive contact with LongMemEval-S; pulled Phase 13 forward

The pre-fan-out `run_point` design was 1 container per cell × N items serial. With LoCoMo (~10 items per QA) this was 30s wall per cell, fine. With LongMemEval-S (500 items per cell, all serial) it was 1500s+ per cell on warm cache, and timed out as `FunctionTimeoutError` four times under successive timeout bumps (1500 → 1800 → 3000 → still SIGKILL). Even at 5/32 Modal containers in parallel, the architecture was sized wrong. Eva called the architectural fix forward; Phase 13 plan written mid-Task-7, item-fan-out (`run_point_chunk` + chunked harness) shipped in 7 commits, λ₁ sweep dispatched cleanly afterward (5 cells × 6 chunks = 30 containers, ~6.3 min wall).

The forward-pull was the right call: bumping timeouts treats the symptom, and we'd have eaten that pain again on every future LongMemEval-shape sweep. **Lesson for budget arithmetic:** size container timeouts off observed worst-case-cell, not mean-item — Phase 13's initial 1200s sizing was based on `~83 items × ~3.6s/item` but cell 1 actually wall-clocked 1381s. Fixed in `6dc88c4` to 3000s.

### 4. "Drops a ton of batches" worry resolved; cell wall-time variance flagged for v2.1

Eva's live observation during the failed Task 7 dispatches was that the run "drops a ton of batches" with progressive slowdown. Concern was: silent loss in metrics, or O(n²) graph growth. The aggStats from the clean run resolved the first half — 0.71% parse failures, 0.016% entries skipped, all healthy consolidation. The 77/500 `n_skipped` items are *scoring-side* skips (retrieval found no scorable evidence), belong to the coverage discussion not the infra reliability one.

The slowdown half is real but *not* λ₁-correlated: cells finished at 373s / 1381s / 423s / 409s / 634s with identical work. 3.7× spread between cell 0 and cell 1, identical metrics. Likely chunk-assignment or cold-container variance. Filed for Phase 14.

### 5. Tier 2 demolition had zero downstream impact

`TIER2_TAU_GAP=10` already functionally disabled Tier 2 in Phase 11; Task 1 made that structural by removing the `t2.hit` short-circuit branch. Confirmed via Task 6 LoCoMo baselines: retrieval metrics unchanged from Phase 11 within infra noise. The shortcut was genuinely never firing under the Phase 11 amendment.

### 6. CorpusAdapter abstraction was the right shape on first try

Task 2's choice of an abstract interface (over a side-by-side module) was Eva's mildly-leaned position with explicit awareness of the premature-abstraction risk. Result: Task 3's LongMemEval adapter dropped in cleanly behind the same interface, no signature changes needed when `byTaskType` was added in Task 4. The adapter shape held across the whole phase.

---

## 5. Notes for Phase 10 (UI/UX)

### What Phase 10 now has

- **Two-corpus retrieval surface.** LoCoMo (regression control) + LongMemEval-S (multi-corpus, multi-task-type).
- **Per-task-type breakdown.** `byTaskType` slice on `MetricsResult` exposes 6 task types on LongMemEval-S. Phase 10 UX can surface task-type-specific affordances — e.g., "temporal reasoning mode" hint when a query classifies as temporal AND retrieval-quality is below threshold for that slice.
- **Abstention QA count tracked but not scored.** 30/500 LongMemEval-S items are abstention QAs. Phase 10 can decide whether/how to surface "I don't know" UX; no scoring mechanism yet (deferred to v2.1 inverted metric).
- **Modal `--corpus` parameter live.** Sweeps, baselines, and run-point all parameterized. Future UX dev work that wants live-measurement on either corpus is one CLI flag away.

### What Phase 10 should watch out for

1. **λ₁ is provably inert at two-corpus reproduction.** Phase 10 should not surface graph-retrieval λ₁ as a user-facing tuning UX; it's a dev-only knob with confirmed zero retrieval impact under current Tier 3 placement.
2. **Tier 2 is no longer a resolver.** Ladder is now Tier 0 → 1 → 3 → Floor with Tier 2 retained solely as BM25 seed provider for Tier 3. Any debug UX that displays tier resolution should label "tier 2" as **"BM25 seed stage"**, not a resolver.
3. **LongMemEval task-type quality varies.** Coverage by slice ranges from 0.53 (`single-session-preference`, n=16) to 0.92 (`multi-session`, n=111). Phase 10 should not make UX promises that assume uniform retrieval quality across query types.

### What Phase 10 should NOT do

- Do not re-introduce Tier 2 as a resolver. Constants stay; semantics don't.
- Do not pivot retrieval path on LongMemEval-multi-session weakness in the UI layer — that's v2.1 territory if/when the structural λ₁ fix surfaces.
- Do not add UX for abstention scoring. v2.1.

---

## 6. v2.1 / Phase 13 / Phase 14 candidates filed from Phase 12

1. **λ₁ structural fix (v2.1 hypothesis).** Two-corpus inert verdict says the current Tier 3 placement of λ₁ doesn't reorder candidates enough. Hypothesis: λ₁ may need to operate at candidate generation rather than re-ranking. v2.1 sub-phase candidate.

2. **Tier 2 code removal (full).** Phase 12 demolished the runtime path; constants and `bench/sweeps/tau.js` + `render_tau_report` remain as architecturally-dead surface (filed in `phase-12-multi-corpus.md` §"Phase 13 removal candidates"). Tau sweep is a vacuous-by-construction logged-flat-line exercise post-demolition; W&B wiring was correctly skipped on this basis on 2026-04-24.

3. **Cell wall-time variance (Phase 14 retro candidate).** 3.7× spread between cells in Task 7 sweep, NOT λ-correlated. Likely chunk-assignment / cold-container variance. Mitigation: smaller chunks (`--chunks 10` instead of auto-6) for tighter parallelism. Worth profiling if Phase 14 plans more sweeps on this corpus shape.

4. **Late-chunk slowdown signal (Phase 14 retro candidate).** Eva observed live during failed Task 7 dispatches that items at higher corpus indices took progressively longer. Per-chunk wall-clock isn't currently captured in the cell record schema. Add `chunkWalls: List[int]` to the cell record if Phase 14 wants to investigate.

5. **`run_point_chunk` worst-case timeout sizing.** The Phase 13 1200s sizing was off (priced average item; cell 1 wall-clocked 1381s). Documented at `6dc88c4`: future container-timeout budgets should be sized off observed worst-case-cell, not mean-item. Skill candidate, possibly extension to `persist-serverless-compute-results` or new `modal-cell-timeout-sizing` skill.

6. **Abstention scoring (inverted metric).** Deferred from Phase 12 per Decision 10. v2.1 if user research shows abstention is UX-critical.

7. **Zep / Mem0 / Mem3 / MemGPT external baselines.** Deferred per Decision 2. v2.1 candidate for comparison against published numbers.

8. **LongMemEval `_oracle` and `_m` variants.** Deferred per Decision 7. `_m` (500-session haystacks) would stress retrieval much harder than `_s`.

9. **`EXTRACT_MAX_TOKENS → 256` sweep.** Deferred from Phase 11 *and* Phase 12 per Decision 11. Worth its own sub-phase.

10. **Renderer-signature convention cleanup.** Minor debt from Phase 11; flagged again in Phase 12; doesn't block but worth a tidy-up.

11. **Fireworks Batch dead-end documentation.** The 14 commits of Task 6 Fireworks-path work include real wisdom about that API's shape mismatches. `c3aa4c7` is the smoke audit. Worth keeping accessible in case the path is re-attempted later.

---

**End of retro.**
