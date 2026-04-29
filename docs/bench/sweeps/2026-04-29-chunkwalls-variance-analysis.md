# Cell wall-time variance + late-chunk slowdown analysis

**Phase 14 Task 7.** Mining `chunkWalls: List[int]` data captured by the Task 1 schema addition off the EXTRACT_MAX_TOKENS sweep (`docs/bench/runs/2026-04-29T14-44-03Z-extract_max_tokens/result.json`).

**Filed inputs:**

- Phase 12 retro §6 candidate 3: 3.7× cell wall-time spread on the Phase 13 λ₁ sweep (`373s vs 1381s` on identical work). Hypothesis: chunk-assignment vs cold-container variance.
- Phase 12 retro §6 candidate 4: Eva's live observation that "later chunks slow down" during the failed Task 7 dispatches under the cell-serial architecture.

**Substrate:** 3 cells × 12 chunks = 36 per-chunk wall samples, LongMemEval-S 500 items, Modal item-fan-out, `Qwen/Qwen3.6-35B-A3B-FP8` via vLLM. Same corpus, same chunk plan (`max(1, 500//80) = 6`… wait, actual `chunksRun=12` — sweep used `--chunks 12` override). Different `EXTRACT_MAX_TOKENS` per cell (2048, 4096, 6144).

---

## Q1 — Chunk-assignment vs cold-container variance

**Hypothesis test.** If the variance is chunk-assignment driven, `chunkWalls[i]` carries the *same items* across cells (chunk plan is deterministic in `corpus_len`), so chunk-index-aligned values across cells should correlate strongly. If the variance is cold-container / dispatch-level, correlations should be noise.

### Pairwise correlations

| Pair | Pearson r | Spearman ρ |
|---|---|---|
| EMT=2048 vs EMT=4096 | −0.055 | +0.056 |
| EMT=2048 vs EMT=6144 | +0.353 | −0.070 |
| EMT=4096 vs EMT=6144 | −0.003 | +0.399 |

**Verdict:** noise. Both Pearson and Spearman are scattered across positive *and* negative values, no pair shows the strong-positive correlation chunk-assignment would produce. The 0.35 / 0.40 hits are isolated and contradicted by the other coefficient on the same pair.

### Per-chunk-index walls (eyeball check)

Same chunk index, same corpus, same dispatch shape, work scales with EMT only if the cell's items hit the truncation cap:

| chunk_idx | EMT=2048 | EMT=4096 | EMT=6144 | range |
|---|---|---|---|---|
| 0 | 314,856 | **1,451,440** | 509,925 | 1.14M |
| 1 | 336,703 | **1,709,125** | 498,803 | 1.37M |
| 2 | 321,872 | 343,393 | 328,683 | 21,521 |
| 3 | 527,906 | 608,755 | **1,812,144** | 1.28M |
| 4 | 315,164 | 292,861 | 305,084 | 22,303 |
| 5 | 346,787 | 481,223 | 350,611 | 134,436 |
| 6 | 414,642 | 220,392 | 313,924 | 194,250 |
| 7 | 310,081 | 357,747 | 529,420 | 219,339 |
| 8 | 604,849 | 472,416 | 624,291 | 151,875 |
| 9 | 340,826 | **1,281,182** | 497,348 | 940,356 |
| 10 | 174,501 | 346,683 | 903,467 | 728,966 |
| 11 | 254,404 | 559,327 | 508,194 | 304,923 |

If chunk content drove wall time, indices 0/1/9 would be slow on **all three** cells. They aren't. EMT=4096 is slow on 0/1/9; EMT=6144 is slow on 3/10. The slow chunks **migrate** between cells. **Variance is dispatch-level, not chunk-content-level.**

### Ratification of Phase 13 finding

Phase 13's 3.7× spread (373s vs 1381s on the λ₁ sweep) was on chunkWalls-less cells, so it couldn't be decomposed at the time. With 36 per-chunk samples now in hand, the answer is unambiguous: **cold-container / dispatch-level variance**, not deterministic chunk-assignment. No mitigation via "smaller chunks for tighter parallelism" — the per-container variance is intrinsic to Modal's containerization on this workload, not to chunk size.

---

## Q2 — Late-chunk slowdown signal

**Hypothesis test.** If items at higher chunk indices wall-clocked progressively longer, `spearman(chunk_index, chunkWall)` should be positive and consistent across cells; mean of 2nd-half walls should exceed 1st-half walls.

| Cell | spearman(idx, wall) | mean(idx 0–5) | mean(idx 6–11) | Δ |
|---|---|---|---|---|
| EMT=2048 | −0.217 | 360,548ms | 349,884ms | **−3.0%** |
| EMT=4096 | −0.238 | 814,466ms | 539,624ms | **−33.7%** |
| EMT=6144 | +0.210 | 634,208ms | 562,774ms | **−11.3%** |

**Verdict:** no signal. Two cells negatively correlate (early chunks ran longer), one weakly positively correlates. No consistent ordering effect. Eva's live observation during the failed Phase 13 dispatches was almost certainly the cold-container outliers happening to land on chunks she watched late in a sequential timeline — *recency bias on outlier reads*, not a structural slowdown.

---

## Outlier shape

Tukey upper fence on the 36-chunk distribution: 915,510ms (Q3 + 1.5·IQR).

| Cell | Chunk | Wall (ms) | Wall (s) | Headroom over 2nd-highest |
|---|---|---|---|---|
| EMT=6144 | 3 | 1,812,144 | 1812s | **+101%** |
| EMT=4096 | 1 | 1,709,125 | 1709s | +18% |
| EMT=4096 | 0 | 1,451,440 | 1451s | — |
| EMT=4096 | 9 | 1,281,182 | 1281s | — |

4 of 36 chunks (11%) are >Q3+1.5·IQR outliers. All four exceed mean by 1.4–2.3× and median by 3.3–4.7×.

**Cell wall = max(chunkWalls).** This means cell wall is **single-outlier-dominated**: bumping the slowest chunk by 50% bumps the cell wall by 50%, regardless of the other 11 chunks. EMT=6144 cell wall is *2× the second-slowest chunk in the same cell*.

---

## Implications

### For the timeout-sizing rule (feeds Task 4 skill)

Phase 13's 1200s sizing was based on `~83 items × ~3.6s/item ≈ 300s` × ~4 mean-item headroom. It missed because:

1. **Mean-item arithmetic is the wrong basis.** Per-chunk wall time on this corpus shape clusters around a 350s median, but the upper tail extends to 1812s — a 5× multiplier the mean-of-means doesn't see.
2. **The right basis is `max(chunkWalls)` from a prior sweep on the same corpus shape, with a fixed multiplicative headroom.** From the data here, `max(chunkWalls) × 2` would clear all 36 observed chunks comfortably. `max × 1.5` would miss the EMT=6144 chunk 3 outlier.
3. **The 3000s post-fix sizing has clear margin.** `max(chunkWalls)` across the whole sweep is 1812s; 3000s = 1.66× headroom. Tight but adequate. If a `_m` (500-session haystack) corpus enters scope, this number goes back up — `max(chunkWalls)` is corpus-shape-specific, not portable across corpora.

### For future sweep planning

- **Don't sweep `--chunks K` for tighter parallelism on this corpus.** The variance is per-container, not per-chunk-size. Smaller chunks would proliferate cold-start cost without reducing tail.
- **Cell wall is a noisy budget anchor.** Use `median(chunkWalls)` if you want a "typical" cell-wall budget; use `max(chunkWalls)` × 2 for timeout sizing. Don't conflate them.
- **3.7× spread is the corpus's intrinsic variance band, not a regression signal.** If a future sweep shows tighter spread, that's the surprise — not the wider one.

### For Phase 15 (UI/UX) — non-impact

UI/UX phase doesn't dispatch sweeps, so this is purely an infra finding. No Phase 15 action item. Filed for v2.1 / future LongMemEval-shape sweeps.

---

## Data provenance

- Source: `docs/bench/runs/2026-04-29T14-44-03Z-extract_max_tokens/result.json`
- Sample size: 3 cells × 12 chunks = 36 per-chunk wall observations
- Computation: ad-hoc Python (no committed harness — analysis is one-shot, mining a closed sweep)
- Reproducibility: re-running the analysis from `result.json` would reproduce all numbers byte-for-byte.

**End of analysis.**
