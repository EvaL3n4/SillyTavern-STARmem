# Phase 13 Retro — Item-Level Fan-Out + λ₁ Closure (2026-04-26)

**Plan:** [`phase-13-item-fan-out.md`](./phase-13-item-fan-out.md)
**Closure scope:** Phase 12 Task 7 (parked at the previous cell-serial dispatch attempts).
**Dispatch substrate:** Modal item-fan-out (5 cells × 6 chunks = 30 containers; ~6.3 min wall-clock).

> **Note on retro scope.** Phase 13 was pulled forward mid-Phase-12 as Task 7.5 to unblock the λ₁ tripwire (see [`phase-12-retro.md`](./phase-12-retro.md) §3 mid-phase pivots). The canonical narrative — what shipped, the headline finding, decisions held, surprises, Phase 14 candidates — lives in the Phase 12 retro because the two phases interleave too tightly to separate honestly. **This file is a pointer, not a duplicate.** If you came here looking for "what happened in Phase 13," follow the cross-references below.

---

## 1. What shipped — pointer

7 of 7 tasks landed (no Task 6.5 expansion — decision gate fired Outcome A).

Per-task commits, in order:

| # | Task | Commit |
|---|---|---|
| 0 | Plan | `f033c85` |
| 1 | `_modal-chunk.js` harness slice | `d877d62` |
| 2 | `run_point_chunk` Modal function | `5097056` |
| 3 | `run_sweep` item-fan-out + `_recompute-metrics.js` | `10b7183` |
| 4 | `--chunks K` CLI override | `d1e967e` |
| 5 | `_compute_chunk_plan` extraction + 9 tests | `578189f` (+ tactical fixes `92594fd`, `8a6e806`, `1b15372`) |
| 6 | λ₁ tripwire dispatch + closure artifact | `707e975` (+ timeout fix `6dc88c4`) |
| 7 | Retro + ROADMAP entry | *(this commit)* |

Phase 13 range: `f033c85..HEAD`. ~10 commits including tactical fixes inside Task 6.

Detailed coverage of each landing lives in:
- **Phase 12 retro §1** — full artifacts table including all Phase 13 entries
- **Phase 12 retro §4 surprise 3** — the architectural pull-forward narrative
- **Phase 12 retro §4 surprise 4** — the "drops a ton of batches" resolution
- **`docs/bench/sweeps/2026-04-26-longmemeval-lambda1-live.md`** — Task 6 closure report with decision-gate synthesis

---

## 2. Headline finding — pointer

**Decision gate: Outcome A — λ₁ provably inert on two structurally distinct corpora.**

LongMemEval-S λ₁ ∈ {0.5, 0.75, 1.0, 1.25, 1.5}: MRR identical to 16 decimals (`0.9038470859081548`), recall identical, coverage identical, every aggStats counter identical, every task-type slice identical. Combined with Phase 9.5's three-time LoCoMo reproduction, this is the strongest possible "not worth tuning" verdict the harness produces.

`TIER3_LAMBDA_1 = 1.0` retained at spec default. v2.1 hypothesis filed: λ₁ may need to operate at candidate generation rather than re-ranking.

Full data, per-task-type breakdown, and synthesis: **`docs/bench/sweeps/2026-04-26-longmemeval-lambda1-live.md`**.

---

## 3. Decisions held — Phase 13 plan header

All 10 decisions locked in the plan header survived execution:

1. **Phase 13 scope = infra + Task 7 closure.** HELD. Closed in-phase, not parked.
2. **K=6 chunks default for full LongMemEval-S.** HELD. 30 containers, comfortable headroom on Modal free tier.
3. **Chunks heuristic = `max(1, items // 80)`.** HELD. LoCoMo → 1 chunk (zero overhead), LongMemEval-S → 6.
4. **Flat starmap over (cell × chunk) tuples.** HELD. Single dispatch round, no nested-container pain.
5. **`run_point` preserved as thin wrapper.** HELD. Sub-orchestrators (`run_graph_sweep` / `run_consolidation_sweep` / `run_consolidation_batchsize_sweep`) keep their existing `run_point.map(...)` calls untouched.
6. **Per-chunk `volume.commit()` + stderr streaming preserved.** HELD.
7. **`run_point_chunk` per-chunk timeout = 1200s.** REVISED → 3000s in `6dc88c4`. Initial sizing priced the *average* item; cell 1 actually wall-clocked 1381s. Filed as Phase 14 skill candidate (worst-case-cell sizing, not mean-item).
8. **Aggregation seam = `runs[]` concat + recompute.** HELD. `_recompute-metrics.js` is the single source of truth on metrics; zero Python+JS drift risk.
9. **`wallMs` per-cell = `max(chunk_wallMs)`.** HELD.
10. **Decision gate unchanged from Phase 12 Task 7.** HELD. Three-outcome flow applied as specified; Outcome A fired.

---

## 4. What worked / what didn't — pointer

Phase 12 retro §4 surprises 3-4 cover the substantive Phase 13 lessons (architectural pull-forward, cell wall-time variance, "drops a ton of batches" resolution). Two narrow Phase-13-specific notes that fit better here than there:

- **`_compute_chunk_plan` extraction was the right shape.** Pulling the chunk-plan math out of `run_sweep`'s body into a pure helper made it testable in isolation; 9 tests went green first try and now serve as a regression net for any future heuristic tuning. The test harness (Phase 11 sandbox-stub pattern via `sys.modules['modal']`) carried over cleanly from Task 6 of Phase 11.
- **Single-source-of-truth on metrics via `_recompute-metrics.js` paid off.** No Python re-implementation of `computeMetrics`; cell aggregation shells out to the same Node code that per-chunk dispatch uses. Catches drift by construction.

---

## 5. Phase 14 candidates — pointer

Filed in **Phase 12 retro §6 candidates 3, 4, 5**:

3. **Cell wall-time variance.** 3.7× spread (373s vs 1381s) across cells with identical work. NOT λ-correlated. Likely chunk-assignment or cold-container variance. Profiling sub-phase candidate.
4. **Late-chunk slowdown signal.** Eva's live observation during failed dispatches; per-chunk wall-clock isn't currently in the cell record schema. Add `chunkWalls: List[int]` if Phase 14 wants to investigate.
5. **`run_point_chunk` worst-case timeout sizing.** Skill candidate — extension to `persist-serverless-compute-results` or a new `modal-cell-timeout-sizing` skill.

---

## 6. Handoff to Phase 14

Item-fan-out is the substrate now. Any future LongMemEval-shape sweep dispatched via `run_sweep` automatically inherits 30-container parallelism. No further infra work is needed for the sweep mechanics themselves; Phase 14 inherits a measurement substrate that survived contact with a 500-item corpus.

The λ₁-on-LongMemEval-S verdict (Outcome A, two-corpus inert) closes the prior-art question: this is structural to current Tier 3 placement, not a corpus artifact. v2.1 graph-tier work should treat λ₁ as a fixed parameter at 1.0 and pursue the upstream-of-re-ranking hypothesis if there's appetite for graph-tier follow-through.

The cell wall-time variance (§5 candidate 3) is the most likely Phase 14 input from this phase — if Phase 14 plans more sweeps on this corpus shape, profile first.

---

**End of retro.** Cross-references, not duplication, are the point. Phase 12 retro is the canonical doc for the interleaved phases.
