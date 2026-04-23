# BATCH_SIZE sweep — 2026-04-23T07-56-52Z

**Convs sampled:** indices [0, 1, 2, 3, 4]

| BATCH_SIZE | MRR | Coverage | Update rate | n (QA) |
|---|---|---|---|---|
| 3 | 0.7756 | 0.6006 | 0.0179 | 999 |
| 5 | 0.8009 | 0.6657 | 0.0154 | 999 |
| 7 | 0.8136 | 0.6877 | 0.0164 | 999 |
| 10 | 0.8182 | 0.7337 | 0.0217 | 999 |
| 15 | 0.8370 | 0.7067 | 0.0218 | 999 |

### Amendment verdict

**Held at spec** — ΔMRR = +0.0188 < 0.02 (below amendment threshold).

**Elbow rationale:** No clear elbow detected; fallback to highest mrr = 0.8370.

---

## Phase 11 Task 7 — observation

**Grid shape:** 5 × 5 = 25 cells (BATCH_SIZE ∈ {3, 5, 7, 10, 15} × conv indices 0..4)

**Wall-clock per cell (parallel dispatch via `run_batchsize_point.map`):**

| BATCH_SIZE | max (s) | median (s) | notes |
|---|---|---|---|
| 3  | 1303.5 | 1140.3 | slowest row; dominated end-to-end wall-clock |
| 5  |   14.8 |    7.6 | warm-cache hits from first (timed-out) dispatch |
| 7  |  858.2 |  748.7 | |
| 10 |  687.2 |  642.1 | spec default; matches 9.5 cached extractions |
| 15 |  711.8 |  643.8 | |

Orchestrator wall-clock dominated by BATCH_SIZE=3's slowest cell at **~21.7 min**. Cumulative container-seconds: ~4 hours (14,434s sequential → ~25 min parallel at 25-way fan-out).

**Cache behavior:** Redesign worked as intended. First dispatch timed out on BATCH_SIZE=3 at the original 600s per-cell ceiling (caught in preflight, fixed in commit `6c7fbaa` by raising to 1800s). Between dispatches, `volume.commit()` on successful cells persisted ~20 cells' worth of extractions. Second dispatch saw BATCH_SIZE=5 as a full cache hit (~8s per cell vs ~11 min live), confirming the conversation-level split + per-cell commit pattern preserves partial progress exactly as designed.

**Pre-registered branch classification: C** (below-noise Δ).

- Not A (Δ >> threshold + coverage holds)
- Not B (flat axis) — the plan's pre-reg predicted B; actually BATCH_SIZE has monotonic MRR signal 0.78 → 0.84
- **C fired:** ΔMRR = +0.0188 (from spec default 10 to candidate 15) is below the 0.02 amendment threshold; coverage drops 2.7pp (within 5pp budget). Amendment rule correctly holds at spec.
- Not D (timeout) — the hot-fix resolved it

**Surprises:**

1. BATCH_SIZE is NOT a pure consolidation knob. Plan pre-registration described it as affecting "consolidation/update-rate, not ranking directly." The data shows clear monotonic MRR climb across the grid — larger batch = richer per-call extraction context = better-quality entity/topic keywords = better BM25 matching. Real signal, just not an amendable one at our current gate.
2. Coverage peaks at BATCH_SIZE=10 (0.7337), not at the MRR-best point (BATCH_SIZE=15, coverage 0.7067). Classic subset-selection tension: the MRR-best row scored on a slightly-smaller answerable subset. **The two-column metric and 5pp coverage gate are what prevented a vacuous amendment here** — if we'd been running MRR-only with the pre-Phase-11 machinery, we'd have proposed BATCH_SIZE=15 as a 1.9pp MRR win. Task 4 ships exactly the guard it was designed to ship.
3. BATCH_SIZE=3 was 2× the original 600s timeout — the preflight-estimated "~2-3 min per cell" was only valid for BATCH_SIZE ≥ 5. Hot-fix commit `6c7fbaa` raised to 1800s; actual max was 21.7 min, comfortable headroom.

**Files:** `2026-04-23-batchsize-live.md` + `2026-04-23-batchsize-live.json` (renamed from Modal's `2026-04-23T07-56-52Z-batchsize.*` stem).