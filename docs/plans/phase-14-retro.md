# Phase 14 Retro — v2.0 Closure (2026-04-29)

**Plan:** [`phase-14-v2-closure.md`](./phase-14-v2-closure.md)
**Shipped:** 2026-04-29 at commit `015a457` (this retro is the closing commit)
**Scope:** v2.0 closure. One correctness fix backed by sweep evidence (`EXTRACT_MAX_TOKENS` 2048 → 4096), Tier 2 dead-code follow-through, `chunkWalls` instrumentation + variance analysis, renderer-signature cleanup, and a skill extension for Modal cell-timeout sizing.
**Companion artifact:** [`docs/bench/sweeps/2026-04-29-longmemeval-extract-max-tokens-live.md`](../bench/sweeps/2026-04-29-longmemeval-extract-max-tokens-live.md) (sweep + LoCoMo regression smoke), [`docs/bench/sweeps/2026-04-29-chunkwalls-variance-analysis.md`](../bench/sweeps/2026-04-29-chunkwalls-variance-analysis.md) (Task 7).

---

## 1. What shipped

**v2.0 closes clean.** One correctness amendment, three demolitions/refactors, three instrumentation additions, two analyses, one skill extension. No architectural shifts — the λ₁ structural fix stays deferred to v2.1, as planned.

### Artifacts + code changes

| # | Task | Commit | Notes |
|---|---|---|---|
| 0 | Plan | `83750e5` | 8-task plan with mid-phase splits to 5/5.5/6 |
| 1 | `chunkWalls: List[int]` cell-record schema + `_build_cell_record` helper | `139a7b3` | Backward-compatible additive field; `wallMs` (max-of-chunkWalls) preserved |
| 2 | Tier 2 dead-code demolition | `f0f5300` | Removed `TIER2_TAU_*` constants, `tau.js`, `render_tau_report`, `_SWEEP_BASE_OVERRIDES` for `hops`/`relw`, base-overrides cleanup |
| 3 | `graph.js renderReport` positional signature | `97a213a` | Phase 11 retro debt; mechanical, no semantic change |
| 4 | `modal-cell-timeout-sizing` skill — extended `persist-serverless-compute-results` | *(this commit)* | Three new sub-sections: variance-origin chunk-vs-dispatch test, late-chunk slowdown audit, outlier shape + sizing rule |
| 5 | Modal vLLM re-warmup at `EXTRACT_MAX_TOKENS={4096, 6144}` on LongMemEval-S | Eva (Modal) | Two-phase warmup; correct shape encoded after `e281c5d` hotfix |
| 5.5 | Unlock `EXTRACT_MAX_TOKENS` for runtime sweep override | `068f3be`, `ba0cc09` | Pattern from `unlock-knob-for-runtime-sweep` skill |
| 6 | Sweep + LoCoMo regression smoke + amend constant + baseline refresh | `19837ab` (wire), `89ee9a9` (amend), `97f3585` (plan track) | Single skill-following unit per `benchmark-driven-constant-amendment` |
| 6+ | Drop dead `'tau'` sweep_name default + guard | `f1e4aa8` | Leftover after Task 2 demolition |
| 7 | Cell variance + late-chunk slowdown analysis | `015a457` | Mines `chunkWalls` from Task 6's sweep — closes Phase 12 retro §6 candidates 3+4 |
| 8 | This retro + ROADMAP entry | *(this commit)* | — |

**Total: ~13 commits** across the phase (`83750e5..HEAD`). Phase 13 was ~10. Phase 12 was 79 (architectural reality).

The phase ran straight through the planned task order with two mid-flight inserts (Task 5 hotfix + Task 5.5 unlock). No architectural pivots, no substrate swaps, no dead-end paths. The dispatch-to-amendment pipeline that Phases 11–13 built carried this phase end-to-end with no friction.

### Test counts

- Phase 13 close: 89 suites / 945 tests (jest), 57 tests (pytest bench/modal)
- Phase 14 entry baseline (post-security-batch merge `8683515`): **97 suites / 979 tests (jest)**, 57 tests (pytest)
- Phase 14 close: **97 suites / 973 tests (jest, −6 from baseline: Task 2 Tier 2 demolition removed tests for now-deleted code paths), 58 tests (pytest bench/modal, +1 from 57: `test_cell_record_includes_chunkWalls` pins the schema invariant)**
- Net delta vs Phase 14 entry: −6 jest (deletions), +1 pytest, all green, zero regressions.

The jest delta is the structurally-honest signal that Tier 2 demolition was real: the test surface shrank because the code surface shrank. The Phase 13 → Phase 14-entry jest jump (+34) came from the security batch merged mid-phase (`8683515`), not from Phase 14 itself.

### Headline correctness fix

**`EXTRACT_MAX_TOKENS = 4096` (was 2048).** Sweep grid `{2048, 4096, 6144}` on LongMemEval-S 500 produced:

| EMT | n_scored | recallAt5 | mrr | coverage |
|---|---|---|---|---|
| 2048 | 393 | 0.9606 | 0.9038 | 0.8362 |
| **4096** | **399** | 0.9540 | 0.9128 | **0.8489** |
| 6144 | 390 | 0.9525 | 0.9058 | 0.8298 |

The mechanical elbow detector reported "axis flat" because it gates on ΔMRR/Δknob (calibrated for efficiency knobs). For a *correctness knob* like EXTRACT_MAX_TOKENS, the relevant signal is `n_scored` recovery + coverage: at 4096, +6 items the system literally failed to score at 2048 because extraction truncated and cache-replay failed. 6144 sanity check is noise. LoCoMo regression smoke at 4096 showed no regression (truncation didn't bind on LoCoMo's sparser conversation structure). Plan flagged the override in advance.

---

## 2. Variance + slowdown closure (the Phase 12 retro §6 follow-up)

Two questions that Phase 13 couldn't answer for lack of data are now closed by the Task 7 analysis:

**Q1 — Cell wall-time variance origin.** 36 per-chunk wall samples (3 cells × 12 chunks) from Task 6's sweep. Cross-cell Pearson and Spearman on chunk-index-aligned walls are scattered noise (range −0.07 to +0.40, no consistent direction). Slow chunks migrate between cells (cell B was slow on chunks 0/1/9; cell C was slow on chunks 3/10). **Verdict: dispatch-level / cold-container variance, not chunk-content.** Phase 13's 3.7× spread on the λ₁ sweep was the same intrinsic dispatch variance, not a chunk-assignment artifact. "Smaller chunks for tighter parallelism" is the wrong lever — the variance is per-container, not per-chunk-size.

**Q2 — Late-chunk slowdown.** `spearman(chunk_index, chunkWall)` per cell: −0.217, −0.238, +0.210. Two cells negatively correlate; one weakly positive. Mean(idx 6–11) was *lower* than mean(idx 0–5) on all three cells. **Verdict: no signal.** Eva's live observation during the failed Phase 13 dispatches was almost certainly cold-container outliers landing on chunks watched late in a sequential timeline — recency bias on outlier reads, not a structural effect.

**Outlier shape.** 4 of 36 chunks (11%) above Tukey upper fence (915,510ms). Worst outlier was 2× the second-slowest chunk in its own cell. Cell wall = max(chunkWalls) is single-outlier-dominated.

**Sizing rule that fell out of the data:** `timeout = max(chunkWalls from prior sweep on same corpus) × 2`. Tighter misses tail outliers; wider wastes budget. Corpus-shape-specific. Encoded into the `persist-serverless-compute-results` skill (Task 4 extension).

---

## 3. Decisions held / revised

All 10 plan-header decisions held:

1. EXTRACT_MAX_TOKENS amendment as correctness fix (not efficiency). HELD — coverage signal moved as predicted, n_scored recovered.
2. Sweep grid `{2048, 4096, 6144}`. HELD.
3. Single-cell LoCoMo regression smoke at winner. HELD — no regression.
4. No λ₁ re-run. HELD — two-corpus inert verdict stands on uncorrupted scored-pool data.
5. Cache invalidation as the gate. HELD — both warmup runs (4096 full + 6144 full) executed as Phase 14 prerequisite, not hidden sweep cost.
6. Tier 2 demolition follow-through. HELD — constants, sweep config, render fn, base overrides all gone.
7. Renderer-signature cleanup mechanical. HELD — `graph.js` positional, no semantic change.
8. `chunkWalls` on cell record (not chunk record). HELD — readers ask "how did this λ₁=1.0 cell's chunks vary?", and the audit query in §2 above worked first try against the persisted JSON.
9. Sequencing (1–4 parallel with 5, 6–8 sequential after 5). HELD with one mid-phase insert: Task 5.5 (`EXTRACT_MAX_TOKENS` runtime-override unlock) was added between 5 and 6 after the 9.4.5/Phase-11 unlock-knob pattern surfaced — clean preflight catch.
10. Plan size target ~800 lines. REVISED IN EXECUTION — final plan was ~1000 lines after the 5/5.5 split, still well within phase-13's 1640 footprint.

**Two mid-phase inserts:**

- **Task 5 hotfix** (`e281c5d`): the plan's two-phase warmup shape was wrong — the original `sed` target structure didn't match the actual `vllm_warmup.py`. Correct shape encoded in-flight; no functional change to the dispatch.
- **Task 5.5 unlock** (`068f3be`, `ba0cc09`): the `EXTRACT_MAX_TOKENS` constant wasn't yet in `_SWEPT_*_KEYS`. Caught preflight before Task 6 dispatch via the `unlock-knob-for-runtime-sweep` skill's checklist. Without this insert, Task 6's sweep would have run all three cells against the unchanged baseline value with no apparent error.

---

## 4. Surprises

### 1. The mechanical elbow detector was right to flag, wrong to verdict

`_detect_elbow` reported "axis flat (maxΔ/Δknob = 0.000004 ≤ 0.005); held at spec." Mathematically correct under the threshold rule. Operationally wrong: this is a correctness knob, not an efficiency knob. The signal that mattered was *coverage*, which moved +1.27pp at 4096 — exactly the predicted sign. The plan flagged the calibration override in advance (line 774: "The expected amend trigger is **coverage**, not MRR"), so the verdict didn't get blocked by the gate. **Lesson:** the gate is calibrated for efficiency knobs (λ₁, τ_gap); a correctness knob needs operator override based on the predicted signal direction. This is the second time the gate has needed an override — it's a calibration-class issue, not a one-off. Worth a v2.1 task: extend `_should_amend` with a `correctness_knob: bool` flag that switches the gate signal from MRR-delta to n_scored-delta or coverage-delta.

### 2. Phase 14 was structurally easy after Phases 11–13 paid the bill

The pipeline that Phases 11–13 built (`benchmark-driven-constant-amendment` skill, `unlock-knob-for-runtime-sweep` skill, `coverage` field, `_should_amend` gate, item-fan-out infra, `chunkWalls` schema) carried this phase straight through. No architectural pivots, no dead-ends, no substrate swaps. The 13-commit count is the natural footprint of a small, focused phase running through a mature pipeline. **Lesson:** the infra investment of Phases 11–13 was the right shape. Future correctness amendments on swept knobs should follow the same pattern (skill-driven, single-task wiring + amend + baseline-refresh) and expect similar low-friction execution.

### 3. Variance origin is dispatch-level, not chunk-content — and it's intrinsic

The Q1 verdict in §2 has a real implication for v2.1 sweep planning: the 3.7× cell-wall spread on LongMemEval-S is **not** mitigable by re-chunking or by smarter `--chunks K` sizing. Smaller chunks shrink the absolute spread but proliferate cold-start cost. Mitigation, if/when needed: pre-warm containers (Modal `keep_warm=N`) or accept the variance band as the corpus's intrinsic floor. **Lesson:** when a future v2.1 sweep on a larger corpus shape (e.g. LongMemEval-`_m` 500-session) shows similar variance, don't waste time trying to re-chunk — the lever isn't there. Budget for the timeout, not the throughput.

### 4. Q2 (late-chunk slowdown) was operator misread, not data signal

The `spearman(idx, wall)` evidence is clear-cut: no late-chunk slowdown across any cell. Eva's live-watch observation during the failed Phase 13 dispatches was real *as a perception* — but it was recency bias on outlier reads happening in a serial-watching timeline, not a structural effect on chunk index. **Lesson:** live operator observations during failed dispatches are valuable as triage signals but *not* as findings. Always re-test against the persisted `chunkWalls` data once the run lands. This is the second time live observation has needed post-hoc validation (Phase 12's "drops a ton of batches" was the first); worth a sentence in the plan-preflight skill if not already there.

### 5. Two unlock-knob preflight catches in one phase — pattern is mature

Task 5.5 caught the `EXTRACT_MAX_TOKENS` runtime-override gap before dispatch via the `unlock-knob-for-runtime-sweep` checklist. Phase 9.x and Phase 11 both surfaced similar gaps post-dispatch (wasted compute). The skill's preflight is now structurally preventing the failure mode it was written for. No mental-model update needed — just a confirmation that the skill is doing its job.

---

## 5. Notes for Phase 15 (UI/UX)

### What Phase 15 inherits from v2.0

The benchmarking subsystem is **closed for v2.0**. `EXTRACT_MAX_TOKENS=4096`, `TIER2_TAU_GAP=10` (tier demolished anyway), `TIER3_LAMBDA_1=1.0` (two-corpus inert verdict). `baseline.json` is the canonical record; no further sweeps are planned for v2.0. Phase 15 is free to pivot the loop to UX.

The Phase 12 retro §5 "Notes for Phase 10 (UI/UX)" still applies — but with corrections:

- ✅ Two-corpus retrieval surface available (LoCoMo regression-control + LongMemEval-S multi-task-type).
- ✅ `byTaskType` slice on `MetricsResult` exposes 6 LongMemEval task types. Coverage-by-slice ranges 0.53 → 0.92.
- ✅ λ₁ provably inert two-corpus — **do not** surface graph-retrieval λ₁ as user-facing tuning UX.
- ✅ Tier 2 is no longer a resolver. **CORRECTION FROM PHASE 12:** Tier 2 *also no longer exists structurally* (Phase 14 Task 2 demolished the constants, sweep config, and rendering surface). Debug UX has no "tier 2" to label — the ladder is now `Tier 0 → Tier 1 → Tier 3 → Floor`, with Tier 3 internally seeded by BM25 (the Tier 3 candidate-set generator). UI labels should reflect the post-Phase-14 reality.
- ✅ Do not pivot retrieval path on LongMemEval-multi-session signal — still v2.1 territory.
- ✅ Do not add UX for abstention scoring — still v2.1.

### What Phase 15 should pull forward from prior retros

Across Phases 7, 8, and 12, several UI/UX-class candidates were filed and parked. Phase 15 should triage them as a planning input:

- **Memory Viewer Traces tab — consolidation events** (Phase 7 retro §15-class). Currently only retrieval traces render. `consolidate()` returns `{added, updated, drained}`; if Phase 15 wants a "consolidation log" tab, the hook is there.
- **Subtle consolidation indicator** (Eva preference, recorded in memory). The plan-time placeholder is in `index.js`; Phase 15 should pick the visual treatment.
- **Settings menu UI affordance** (Eva preference, recorded in memory). Eva wants the UI to pop up in the settings menu — Phase 15 should land the actual mount point.
- **Memory Viewer episodic tab** (was patched for `createdAt` vs lifecycle in Phase 12 security batch `4de0e20`). Working as intended; Phase 15 can iterate on visual polish without architectural concerns.

### What Phase 15 should NOT do

- Do not re-introduce Tier 2 as a resolver. It is *fully demolished* now; bringing it back means new code, not flipping a constant.
- Do not surface λ₁ or any of the four edge-weight knobs (`hops`, `relw`, `tau`, `λ₁`) as user-facing tuning. All provably inert at the current Tier 3 placement.
- Do not promise uniform retrieval quality across LongMemEval task types. Coverage by slice ranges 0.53 → 0.92.
- Do not add UX for benchmark dispatch. The Modal substrate is dev-only; user-facing UI should not expose `--mode run-sweep` or `bench/`.

---

## 6. v2.1 candidates filed from Phase 14

1. **`_should_amend` correctness-knob mode.** Calibrate the gate for correctness knobs (signal direction = `n_scored` or `coverage`, not MRR-delta). Surfaced again in Phase 14 surprise 1.
2. **λ₁ structural fix.** Move λ₁ upstream of re-ranking to candidate generation. Phase 12 retro candidate, still live.
3. **Pre-warmed Modal containers** (`keep_warm=N`) if v2.1 sweeps on `_m` (500-session) variants need predictable wall-clock. Phase 14 Task 7 verdict says re-chunking won't help; this is the actual lever for the variance band.
4. **Abstention scoring (inverted metric).** Phase 12 Decision 10 deferral, still live.
5. **Zep / Mem0 / Mem3 / MemGPT external baselines.** Phase 12 Decision 2 deferral.
6. **LongMemEval `_oracle` and `_m` variants.** Phase 12 Decision 7 deferral.
7. **`bench/modal/rerender.py` disposition** (Phase 11 close note). Still on disk; ad-hoc utility. Lean toward leaving it; ~140 LOC, harmless.
8. **Live-observation post-hoc validation rule** (Phase 14 surprise 4). One sentence in the plan-preflight skill if not already there: live operator observations during failed dispatches are triage signals, not findings — re-validate against persisted data once the run lands.

---

**End of retro.**
