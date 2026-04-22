# Vacuous Metrics Audit — 2026-04-22

Ran before Task 3 of sub-phase 9.4.6 to confirm the scope of the fix. Also surfaced a second latent bug (LoCoMo evidence-loader mismatch) that triggered the Task 2 insertion amendment.

## Production callers of affected functions

All callers of `computeMetrics` consume the aggregated `MetricsResult` positionally by field name — they don't call `matchGold` / `precisionAtK` / `recallAtK` / `mrr` directly.

| File:Line | Consumer | Fix impact |
|---|---|---|
| `bench/runner.js:127` | `computeMetrics(runs)` — core harness caller | Transparent. Adds `n_scored` / `n_skipped` to result. |
| `bench/baselines.js:128,144` | `computeMetrics` over per-baseline runs | Transparent. Renderers at lines 189/204 call `.toFixed(4)` on numeric fields — `NaN.toFixed(4) === "NaN"` renders as the string "NaN" in Markdown output. Legible signal. |
| `bench/sweeps/_driver.js:18-22` | `METRIC_ACCESSORS` — accessor functions for sweep drivers | Transparent. Accessors return NaN when input is NaN — propagates correctly. |
| `bench/sweeps/tau.js:122-127` | `.toFixed(4)` on `recallAt5`, `precisionAt3`, `mrr` | Renders "NaN" in tables; elbow-detection may need review. |
| `bench/sweeps/graph.js:112-144` | Same pattern | Same. |
| `bench/sweeps/consolidation.js:172-176` | Same pattern | Same. |
| `bench/sweeps/bm25.js:157-162` | Same pattern | Same. |
| `bench/metrics/index.js:3-7` | Barrel re-exports | Must add `matchGoldByEvidence` to re-export list. |

**Sweep elbow detection** (`bench/sweeps/_driver.js:detectElbow`) operates on numeric metric values. NaN arithmetic in sort/subtraction will break elbow detection — the expected behavior post-9.4.6 is that any sweep point with `n_skipped > 0` (i.e., unscorable queries in the batch) will pollute the aggregate. `computeMetrics` nanmeans over scorable queries only, so as long as at least one query per sweep point is scorable, aggregates remain numeric. If a sweep point has zero scorable queries, elbow detection fails loudly (NaN comparison is false everywhere) — acceptable signal, not a silent bug.

## Tests that encode the vacuous-true behavior

From `tests/unit/bench/metrics/retrieval.test.js`:

| Line | Assertion | Status after 9.4.6 |
|---|---|---|
| 48-82 | `matchGold` direct tests (4 tests, Jaccard over tokenized text) | Keep — tests the deprecated `matchGold` export for backward-compat. |
| 91 | `precisionAtK(matched, ranked, 1).toBe(1.0)` | **Keep** — legitimate full-precision case with real matches. |
| 103 | `precisionAtK(matched, [], 3).toBe(0)` | **Keep** — empty `rankedIds` ≠ unscorable; retrieval produced nothing, precision is 0. |
| 107 | `precisionAtK(Set(['z']), ranked, 2).toBe(0)` | **Keep** — legitimate no-hit. |
| 116 | `recallAtK(matched, ranked, 3).toBe(1.0)` | **Keep** — real matches, full recall. |
| 120 | `recallAtK(matched, ranked, 1).toBe(0.5)` | **Keep** — partial recall. |
| 124 | `recallAtK(new Set(), ranked, 2).toBe(1.0)` | **🔴 THIS IS THE BUG.** Delete; replace with NaN assertion. |
| 128 | `recallAtK(matched, ['b', 'd'], 2).toBe(0)` | **Keep** — no hits in top-k. |
| 136 | `mrr(matched, ['a','b','c']).toBe(1.0)` | **Keep** — rank-1 hit. |
| 140 | `mrr(matched, ['b','d','a']).toBe(1/3)` | **Keep** — rank-3 hit. |
| 144 | `mrr(matched, ['b','d','e']).toBe(0)` | **Keep** — no hit (matched has 'a' but ranked doesn't). |
| 148 | `mrr(matched, []).toBe(0)` | **Keep** — empty ranked. |
| 152-186 | `computeMetrics` aggregate-shape tests over synthetic runs | Update to include `n_scored`/`n_skipped` fields. |
| 208 | `result.mrr.toBe(1.0)` | **Keep** — legitimate aggregate over two rank-1 runs. |

Task 4's full test-file rewrite supersedes surgical patching.

## Other tests touching metric shape

| File:Line | Test | Action |
|---|---|---|
| `tests/integration/bench/runner.integration.test.js:103-105` | `expect(metrics.precisionAtK[1])` is a number in [0,1] | **Update** — post-9.4.6, may be NaN if all QAs in the synthetic test corpus are unscorable. Replace with "is NaN OR in [0,1]" tolerance. |
| `tests/integration/bench/cli-mounts-wired.test.js:63` | Asserts `computeMetrics` is imported from `./metrics/retrieval.js` | Transparent — name unchanged. |
| `tests/unit/bench/sweeps/driver.test.js:34-36` | Constructs a fake `MetricsResult` | **Update** — add `n_scored` and `n_skipped` to the fake object. |

## LoCoMo evidenceTurns coverage

**Critical finding** — triggered the Task 2 amendment.

Raw LoCoMo v10 corpus evidence format:

- 1986 QA items across 10 conversations
- 1982 items (99.8%) have non-empty `evidence` arrays
- 650 unique evidence strings, all in `D<day>:<turn>` format (e.g. `"D1:3"`, `"D10:12"`, `"D11:14"`)
- **0 of 650** match the loader's `/S(\d+):T(\d+)/` regex
- 4 items have the degenerate bare string `"D"` — will remain unmatched even post-fix, which is correct (they're malformed)

Per-turn `dia_id` field confirms the mapping: `session_<n>[m].dia_id === "D<n>:<m+1>"` (sessions map to days directly, turn indices are 1-based within the day).

**Under the current loader + 9.4.6 evidence-turn matcher:** `evidenceTurns = []` on every QA → `matchedIds.size === 0` on every query → `n_skipped === 1986` on every sweep point → benches remain useless.

**Conclusion:** Task 2 (loader fix) is a prerequisite for Task 4's matcher being measurable. Inserted into plan via commit `e1080a5`.

## Summary

Fix spans:
- `bench/loaders/locomo.js` (new Task 2, ~40 delta): accept `D<day>:<turn>` evidence keys
- `bench/runner.js` (Task 3, ~5 delta): carry `sourceMessages` through retrieved-entry projection
- `bench/metrics/retrieval.js` (Task 4, ~200 delta): add `matchGoldByEvidence`, rewrite `precisionAtK`/`recallAtK`/`mrr` for NaN semantics, rewrite `computeMetrics` for nanmean + `n_scored`/`n_skipped`; deprecate `matchGold`
- `tests/unit/bench/metrics/retrieval.test.js` (Task 4, full rewrite)
- `tests/integration/bench/runner.integration.test.js` (spot patch)
- `tests/unit/bench/sweeps/driver.test.js` (spot patch — add `n_scored`/`n_skipped`)
- `tests/unit/bench/loaders/locomo.test.js` (new, Task 2)
- `bench/metrics/index.js` (spot patch — add `matchGoldByEvidence` re-export)

Transparent to:
- `bench/sweeps/{tau,graph,consolidation,bm25}.js` renderers (NaN flows through `.toFixed(4)` as string "NaN")
- `bench/sweeps/_driver.js` elbow detection (propagates NaN; fails loudly if entire sweep point is unscorable)
- `bench/baselines.js` renderer (same)

Phase 9 published artifacts to supersede in Task 5:
- `docs/bench/sweeps/2026-04-21-tau.md` (and the VACUOUS-pre-9-4-6 rename)
- `docs/bench/sweeps/2026-04-21-graph.md`
- `docs/bench/sweeps/2026-04-21-consolidation.md`
- `docs/bench/sweeps/2026-04-21-bm25.md`
- `docs/bench/baseline.json` (deferred → measured in Task 6)

Historical artifacts preserved in-tree for provenance; `docs/plans/phase-9-4-6-retro.md` (Task 7) links old → new.
