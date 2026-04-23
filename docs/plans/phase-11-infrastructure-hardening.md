# Phase 11 — Measurement Infrastructure Hardening

> **For Hermes:** Execute with `subagent-driven-development` — Fireworks is reliable, Azure (the controller) is the flaky path. Prefer subagents for non-trivial tasks; keep controller turns small.

**Goal:** Close five measurement-infrastructure gaps surfaced during sub-phase 9.5 so future sweeps (corpus expansion, v2.1) land on trustworthy substrate. Zero behavior changes to the shipped retrieval ladder.

**Architecture:** Two surfaces touched. (1) `bench/modal/sweep_app.py` — elbow-detector guard, `--local-out` parity for `run-point`, new `run-baselines` mode, conversation-level BATCH_SIZE redesign. (2) `bench/runner.js` + `bench/metrics/retrieval.js` — coverage column alongside the existing metric columns, with hardened amendment rule `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp`. No spec edits, no constants amendments (Tier 2 demolition and `EXTRACT_MAX_TOKENS` land in Phase 12).

**Tech stack:** Python 3.12 (Modal), Node 20 (bench), pytest for the new Python unit tests, jest for Node. No new dependencies.

**Source of truth for gaps:** [`phase-9-5-retro.md`](./phase-9-5-retro.md) §5 "Phase 11 scope — six candidates filed during 9.5."

---

## Decisions locked before writing this plan (see conversation 2026-04-23)

1. **Scope breadth.** Five of six filed candidates land: elbow guard, `--local-out` parity, baselines on Modal, coverage-weighted metric (two-column), BATCH_SIZE redesign. **Tier 2 demolition** stays deferred — we functionally bypass Tier 2 via `TIER2_TAU_GAP=10`, so it's not blocking. `EXTRACT_MAX_TOKENS` amendment also deferred to Phase 12.
2. **BATCH_SIZE redesign.** Option (b) conversation-level splitting only: 5 convs × 5 BATCH_SIZE values = 25 bounded containers, each running 1 conv × 1 batch size. Mid-subprocess `volume.commit()` (option a) is defensive infra that deserves its own later track if a second cache-invalidating sweep ever fails; the redesign alone should be enough.
3. **Coverage metric shape.** Two-column reporting — `MRR` and `coverage` as separate columns, with the existing hardened amendment rule extended to `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp`. No composite metric. Interpretation stays explicit.
4. **Re-sweep policy.** Re-render from cached per-point JSON where possible (τ, bm25, graph, hops, relw — all have artifacts). Baselines get re-run under new metric as part of Task 3 (they have no cached per-query traces). No forward-only cliff.
5. **Baselines on Modal.** New `--mode run-baselines` dispatch, not a fake `SWEEP_CONFIGS["baselines"]` parameter axis. Cleaner semantics; baselines are retriever-function swaps, not parameter sweeps.
6. **Elbow guard test shape.** Two-fixture regression test: one flat-axis fixture (proves guard fires), one genuine-elbow fixture (proves guard doesn't over-suppress). No historical-data pin — the guard should hold for any future axis shape.
7. **Plan filename.** `docs/plans/phase-11-infrastructure-hardening.md`.
8. **Execution mode.** Azure (controller) is the flaky path — keep my turns small. Controller owns Tasks 0, 1, 2, 8, 9 (all small-surface `sweep_app.py` edits plus retro). Subagents (Fireworks) own Tasks 3, 4, 5, 6 (larger scopes, well-defined interfaces, amenable to delegation). Task 7 is a single `modal run` dispatch — controller runs it and reads the artifact.

---

## Task overview

| # | Files touched | Owner | Est. LOC |
|---|---|---|---|
| 0 | `docs/plans/phase-11-infrastructure-hardening.md` | Controller | 0 (plan commit) |
| 1 | `bench/modal/sweep_app.py`, `bench/modal/tests/test_detect_elbow.py` (new) | Controller | ~30 |
| 2 | `bench/modal/sweep_app.py` | Controller | ~12 |
| 3 | `bench/modal/sweep_app.py`, `bench/baselines/runner.js` (new), `bench/modal/tests/test_baselines_mode.py` (new) | Subagent | ~200 |
| 4 | `bench/runner.js`, `bench/metrics/retrieval.js`, `bench/modal/sweep_app.py` (renderers), `bench/render/amendment-rule.js` (new) | Subagent | ~250 |
| 5 | `docs/bench/sweeps/2026-04-23-*-live.md`, `docs/bench/baselines/2026-04-23-comparison.md` | Subagent | re-rendered |
| 6 | `bench/modal/sweep_app.py` (new `run_consolidation_batchsize_sweep`), `bench/modal/tests/test_batchsize_split.py` (new) | Subagent | ~180 |
| 7 | Dispatch only — read `docs/bench/sweeps/2026-04-XX-batchsize-live.md` | Controller | — |
| 8 | `docs/bench/baseline.json` | Controller | schema update + knownIssues entry |
| 9 | `docs/plans/phase-11-retro.md` | Controller | narrative |

**Inter-phase contracts into Phase 12:**

```python
# sweep_app.py — new mode surface
modal run bench/modal/sweep_app.py --mode run-baselines --local-out docs/bench/baselines/
    → writes {baseline_id}.md + {baseline_id}.json per retriever in ["ladder","bm25only","recency","random"]

# _detect_elbow contract
# If every axis has maxΔ below ABS_DELTA_FLOOR (default 0.005), returns:
#   { "overrides": <all-spec-defaults>, "rationale": "axis flat (maxΔ=… ≤ …); held at spec" }
# instead of sort-first-corner fallback.
```

```javascript
// bench/metrics/retrieval.js — new export
function coverage(queryMetrics) {
    // queryMetrics: array of { mrr, recallAtK, precisionAtK } per QA item
    // Returns: { scored: number, skipped: number, coverage: number in [0,1] }
    // A query is "skipped" when its mrr/recallAtK/precisionAtK are NaN (no gold match).
}

// bench/render/amendment-rule.js — new module
function shouldAmend({ baseline, candidate, minMrrDelta = 0.02, maxCoverageDrop = 0.05 }) {
    // Returns { amend: bool, reason: string }
    // amend = true only if candidate.mrr - baseline.mrr >= minMrrDelta
    //                AND baseline.coverage - candidate.coverage <= maxCoverageDrop.
}
```

---

## Task 0 — Commit this plan

**Objective:** Stabilize the reference for subagents and future sessions.

**Files:** `docs/plans/phase-11-infrastructure-hardening.md` (this file)

**Steps:**

1. Sanity-check the file exists at the canonical path:
   ```bash
   wc -l docs/plans/phase-11-infrastructure-hardening.md
   grep -c '^## Task ' docs/plans/phase-11-infrastructure-hardening.md  # should equal 10 (0..9)
   ```
2. Grep for heredoc-secret redactions (none expected — this plan has no numeric literals written via heredoc, but muscle memory):
   ```bash
   grep -nE '=\s*\*\*\*|=\*\*\*' docs/plans/phase-11-infrastructure-hardening.md || echo "clean"
   ```
3. Commit:
   ```bash
   git add docs/plans/phase-11-infrastructure-hardening.md
   git commit -m "docs(plans): phase 11 infrastructure hardening plan"
   ```

**Done-when:** file tracked at commit N+1, task count check passes, redaction grep clean.

---

## Task 1 — Elbow-detector zero-axis-Δ guard

**Objective:** Stop `_elbow_on_slice` from proposing the sort-first corner as the elbow when the axis is flat (maxΔ ≈ 0). Field-validated failure: three 9.5 false positives (τ `TIER2_TAU_CONFIDENCE`, bm25 full grid, relw axis).

**Files:**
- Modify: `bench/modal/sweep_app.py:179-206` (`_elbow_on_slice`)
- Create: `bench/modal/tests/__init__.py` (if missing)
- Create: `bench/modal/tests/test_detect_elbow.py`

**Context grounded from live code (2026-04-23):**

```python
# bench/modal/sweep_app.py:179 — current implementation
def _elbow_on_slice(sorted_pts, primary_name, accessor, ratio):
    if len(sorted_pts) < 2:
        return None

    metrics = [accessor(p["metrics"]) for p in sorted_pts]
    primary_values = [p["overrides"][primary_name] for p in sorted_pts]

    deltas = []
    for i in range(len(metrics) - 1):
        delta_knob = primary_values[i + 1] - primary_values[i]
        deltas.append(0 if delta_knob == 0 else (metrics[i + 1] - metrics[i]) / delta_knob)

    max_delta = max(abs(d) for d in deltas)
    threshold = ratio * max_delta + 1e-12  # ← bug: when max_delta=0, threshold≈1e-12

    for i, d in enumerate(deltas):
        if abs(d) <= threshold:  # ← every delta ≤ 1e-12, so index 0 always fires
            return { ... "overrides": sorted_pts[i]["overrides"] ... }
    return None
```

The existing `_detect_elbow` caller doesn't notice because `_elbow_on_slice` returns a non-None result; the final "no elbow ⇒ fall back to max" branch never fires.

**Step 1 — Write the two-fixture regression test**

Create `bench/modal/tests/__init__.py` if it doesn't exist (empty file).

Create `bench/modal/tests/test_detect_elbow.py`:

```python
"""Regression tests for _detect_elbow + _elbow_on_slice flat-axis guard.

Field-validated against the 3 false-positives surfaced during STARmem sub-phase
9.5 (TIER2_TAU_CONFIDENCE, bm25 TAG_BOOST×SUBJECT_BOOST grid, EXPLICIT_RELATION_WEIGHT).
See docs/plans/phase-9-5-retro.md §4 surprise #3.
"""
import sys
from pathlib import Path

# Allow `from sweep_app import ...` when run via `pytest bench/modal/tests/`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sweep_app import _detect_elbow, _elbow_on_slice


def _mk_point(overrides, mrr):
    return {"overrides": overrides, "metrics": {"mrr": mrr}}


def test_flat_axis_is_held_at_spec():
    """Flat MRR axis must NOT produce an amendment proposal."""
    # 8 points along TIER2_TAU_CONFIDENCE, MRR identical to 4dp (9.5 τ sweep reality).
    points = [
        _mk_point({"TIER2_TAU_CONFIDENCE": v, "TIER2_TAU_GAP": 10}, 0.8057)
        for v in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
    ]
    knobs = [
        {"name": "TIER2_TAU_CONFIDENCE", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
        {"name": "TIER2_TAU_GAP", "values": [10]},
    ]
    result = _detect_elbow(points, knobs, "mrr")
    assert "held at spec" in result["rationale"].lower() or "flat" in result["rationale"].lower(), (
        f"Expected flat-axis rationale, got: {result['rationale']!r}"
    )


def test_genuine_elbow_still_detected():
    """Monotonic climb into plateau must still surface the elbow."""
    # 9.4.8/9.5 TIER2_TAU_GAP reality: climbs 0.73 → 0.81 across gap 0.1..10.
    gaps_and_mrrs = [
        (0.1, 0.7303),
        (0.5, 0.7450),
        (1.0, 0.7610),
        (2.0, 0.7780),
        (3.0, 0.7876),
        (5.0, 0.8000),
        (7.0, 0.8050),
        (10.0, 0.8057),
    ]
    points = [
        _mk_point({"TIER2_TAU_GAP": gap, "TIER2_TAU_CONFIDENCE": 2.0}, mrr)
        for gap, mrr in gaps_and_mrrs
    ]
    knobs = [
        {"name": "TIER2_TAU_GAP", "values": [g for g, _ in gaps_and_mrrs]},
        {"name": "TIER2_TAU_CONFIDENCE", "values": [2.0]},
    ]
    result = _detect_elbow(points, knobs, "mrr")
    # Expect an elbow somewhere in [3.0, 10.0] — the plateau shoulder.
    chosen_gap = result["overrides"]["TIER2_TAU_GAP"]
    assert chosen_gap >= 3.0, (
        f"Expected elbow at gap ≥ 3.0 on climbing axis; got gap={chosen_gap}, rationale={result['rationale']!r}"
    )


def test_slice_returns_none_on_flat_axis():
    """Unit test on _elbow_on_slice directly — the guard's primary entry point."""
    points = [
        _mk_point({"X": v}, 0.5000) for v in [1, 2, 3, 4, 5]
    ]
    result = _elbow_on_slice(
        sorted_pts=sorted(points, key=lambda p: p["overrides"]["X"]),
        primary_name="X",
        accessor=lambda m: m["mrr"],
        ratio=0.1,
    )
    assert result is None, f"Expected None on flat axis; got {result!r}"
```

**Step 2 — Run test to verify it FAILS against current code**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
python -m pytest bench/modal/tests/test_detect_elbow.py -v
```

Expected: `test_flat_axis_is_held_at_spec` FAIL (returns sort-first corner, not flat rationale). `test_slice_returns_none_on_flat_axis` FAIL (returns a dict, not None). `test_genuine_elbow_still_detected` should PASS against current code.

If pytest isn't installed globally, try `python3 -m pytest` or install with `pip install --user pytest`. Record which command works; the remaining test steps in this phase use the same.

**Step 3 — Implement the guard**

Patch `bench/modal/sweep_app.py:179-206` (`_elbow_on_slice`) and `_detect_elbow`:

```python
# Module-level constant (add near other threshold constants, ~line 115)
ABS_DELTA_FLOOR = 0.005
"""Below this absolute Δmetric/Δknob on every point, the axis is considered
flat and no elbow is proposed. Field-validated against STARmem 9.5 false
positives (see docs/plans/phase-11-infrastructure-hardening.md Task 1)."""
```

Modify `_elbow_on_slice` — insert the guard right after `max_delta` is computed:

```python
def _elbow_on_slice(sorted_pts, primary_name, accessor, ratio):
    if len(sorted_pts) < 2:
        return None

    metrics = [accessor(p["metrics"]) for p in sorted_pts]
    primary_values = [p["overrides"][primary_name] for p in sorted_pts]

    deltas = []
    for i in range(len(metrics) - 1):
        delta_knob = primary_values[i + 1] - primary_values[i]
        deltas.append(0 if delta_knob == 0 else (metrics[i + 1] - metrics[i]) / delta_knob)

    max_delta = max(abs(d) for d in deltas)

    # Zero-axis-Δ guard (Phase 11 Task 1). If the axis has no meaningful
    # variation, the sort-first corner is not an elbow — it's an artifact of
    # the ratio=0.1×max_delta threshold collapsing to ~1e-12. Return None so
    # _detect_elbow's "no elbows found" branch can surface a flat-axis
    # rationale instead of a false amendment.
    if max_delta < ABS_DELTA_FLOOR:
        return None

    threshold = ratio * max_delta + 1e-12

    for i, d in enumerate(deltas):
        if abs(d) <= threshold:
            return {
                "overrides": sorted_pts[i]["overrides"],
                "metric": metrics[i],
                "rationale": (
                    f"Elbow at {primary_name}={primary_values[i]} (metric={metrics[i]:.4f}). "
                    f"Δmetric/Δknob dropped to {abs(d):.6f} "
                    f"≤ {ratio}×maxΔ={threshold:.6f}. "
                    f"Chosen as the highest-metric elbow across secondary-knob slices."
                ),
            }
    return None
```

Modify `_detect_elbow` — the "no elbows" fallback branch (currently "fallback to highest metric"). Replace with a flat-axis-aware rationale:

```python
    if not elbows:
        # No slice surfaced an elbow. Two sub-cases:
        # (1) Every slice was flat (all max_delta < ABS_DELTA_FLOOR) — honest
        #     answer is "axis flat, hold at spec defaults."
        # (2) Real data but no elbow shape (rare) — same fallback message
        #     mentions the data shape explicitly.
        # Both cases: compute spec-default overrides from knobs and report.
        default_overrides = {k["name"]: k["values"][0] for k in knobs}
        # Compute maxΔ per primary knob across the full point set, to surface
        # in the rationale whether the axis was genuinely flat.
        sorted_all = sorted(points, key=lambda p: p["overrides"][primary_knob["name"]])
        all_metrics = [accessor(p["metrics"]) for p in sorted_all]
        all_values = [p["overrides"][primary_knob["name"]] for p in sorted_all]
        all_deltas = []
        for i in range(len(all_metrics) - 1):
            dk = all_values[i + 1] - all_values[i]
            all_deltas.append(0 if dk == 0 else (all_metrics[i + 1] - all_metrics[i]) / dk)
        axis_max_delta = max((abs(d) for d in all_deltas), default=0.0)
        best = max(points, key=lambda p: accessor(p["metrics"]))
        best_metric = accessor(best["metrics"])
        if axis_max_delta < ABS_DELTA_FLOOR:
            return {
                "overrides": default_overrides,
                "rationale": (
                    f"Axis flat (maxΔ/Δknob = {axis_max_delta:.6f} ≤ {ABS_DELTA_FLOOR}); "
                    f"held at spec on {primary_knob['name']}. Highest observed {primary_metric} = "
                    f"{best_metric:.4f}."
                ),
            }
        return {
            "overrides": best["overrides"],
            "rationale": f"No clear elbow detected; fallback to highest {primary_metric} = {best_metric:.4f}.",
        }
```

Notes for the implementer:

- `primary_knob` is already defined inside `_detect_elbow` at line ~143 (before the slice loop). If the variable isn't in scope at the fallback branch (reread the function), recompute it: `primary_knob = knobs[0]`.
- `knobs[...]['values'][0]` — the "spec default" convention for these configs is that the first value in the sweep grid is the spec default. Confirm by glancing at `SWEEP_CONFIGS` at line 560; if the convention doesn't hold, set `default_overrides = {k["name"]: <explicit lookup>}`. (At plan time the convention does hold for tau/bm25/hops/relw.)

**Step 4 — Verify the test now PASSES**

```bash
python -m pytest bench/modal/tests/test_detect_elbow.py -v
```

All three tests green.

**Step 5 — Regression check: the whole module still imports**

```bash
python -c "from bench.modal import sweep_app; print(sweep_app.ABS_DELTA_FLOOR)"
# Expected: 0.005
```

**Step 6 — Commit**

```bash
git add bench/modal/sweep_app.py bench/modal/tests/__init__.py bench/modal/tests/test_detect_elbow.py
git commit -m "fix(bench): elbow-detector zero-axis-Δ guard (Phase 11 Task 1)

Field-validated against 3 false positives in 9.5 (τ TIER2_TAU_CONFIDENCE,
bm25 TAG×SUBJECT grid, relw axis). Guard: if maxΔ/Δknob < ABS_DELTA_FLOOR
(0.005) on a slice, _elbow_on_slice returns None. The 'no elbows'
fallback in _detect_elbow now emits 'axis flat; held at spec' when the
full-axis maxΔ is also sub-threshold, preserving the honest-outcome
pattern established in 9.4.6.

See docs/plans/phase-11-infrastructure-hardening.md Task 1."
```

**Done-when:**
- [ ] `pytest bench/modal/tests/test_detect_elbow.py -v` passes 3/3
- [ ] `python -c "from bench.modal import sweep_app; print(sweep_app.ABS_DELTA_FLOOR)"` prints 0.005
- [ ] Committed

---

## Task 2 — `--local-out` parity for `run-point` mode

**Objective:** `run-point` mode should mirror its output to a host directory like `run-sweep` already does. Filed in 9.5 retro as a "low-urgency ergonomics" gap; low-risk; in-phase because we're already opening `sweep_app.py` for Task 1.

**Files:**
- Modify: `bench/modal/sweep_app.py:1279-1327` (`main`)

**Context grounded from live code (2026-04-23):**

`main()` at line 1279 currently handles `mode == "run-point"` with `print(run_point.remote(overrides_json))` only — the function returns a JSON string, `main` prints to stdout, nothing is written to disk. The `run-sweep` branch (lines ~1305-1327) already mirrors `report.md` + `result.json` when `--local-out` is passed. Replicate the pattern for `run-point`.

**Step 1 — Patch `main()` `run-point` branch**

Replace:

```python
    elif mode == "run-point":
        print(run_point.remote(overrides_json))
```

with:

```python
    elif mode == "run-point":
        result_str = run_point.remote(overrides_json)
        print(result_str)
        if local_out:
            import json as _json
            from datetime import datetime as _dt
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            # Stem mirrors run-sweep's convention: ISO-ish timestamp + 'point'.
            stem = _dt.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ") + "-point"
            (out / f"{stem}.json").write_text(result_str)
            print(
                f"<!-- mirrored to host: {out / stem}.json -->",
                file=__import__("sys").stderr,
            )
```

**Step 2 — Update `main()` docstring** — add an example line under the existing usage block:

```
        modal run bench/modal/sweep_app.py --mode run-point \\
            --overrides-json '{"TIER2_TAU_GAP": 10}' --local-out docs/bench/runs
            → run_point() with override + mirror {ts}-point.json to host dir
```

**Step 3 — Smoke the change (no Modal run needed; just import + introspection)**

```bash
python -c "from bench.modal.sweep_app import main; print('OK')"
# Expected: OK
```

We intentionally don't add a Modal-dispatch integration test here; `--local-out` is a controller-side host-writer, and the `run-sweep` version has been stable since 9.4.8 — same pattern repeated, same confidence level.

**Step 4 — Commit**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): --local-out parity for run-point mode (Phase 11 Task 2)

Mirrors the JSON result to host dir when --local-out is passed. Stem
convention matches run-sweep: {ISO-timestamp}-point.json. Closes 9.5
retro filed gap #6 (low-urgency ergonomics)."
```

**Done-when:**
- [ ] Module still imports cleanly
- [ ] Committed

---
## Task 3 — Baselines on Modal

**Objective:** Move the baseline comparison off local wall-clock (30+ min sequential per 9.5) onto parallel Modal containers (~8 min target). New `--mode run-baselines` dispatch, parallel fan-out across `["ladder", "bm25only", "recency", "random"]`.

**Owner:** Subagent (Fireworks). Scope is well-defined, signatures are stable, runs in isolation from Tasks 1/2/4.

**Files:**
- Modify: `bench/modal/sweep_app.py` — add `run_baseline_point` function + `run_baselines` orchestrator + `run-baselines` dispatch in `main()`
- Create: `bench/baselines/_modal-point.js` — Node entry point one retriever × full corpus, analogous to `bench/sweeps/_modal-point.js`
- Create: `bench/modal/tests/test_baselines_mode.py` — unit test for dispatch shape
- Modify: `bench/baselines/index.js` — export `BASELINE_IDS` constant for Python-side iteration

**Context grounded from live code (2026-04-23):**

```javascript
// bench/baselines/index.js — current
import { bm25only } from './bm25only.js';
import { recency } from './recency.js';
import { random } from './random.js';
export const BASELINES = [
    { id: 'bm25only', fn: bm25only },
    { id: 'recency', fn: recency },
    { id: 'random', fn: random },
];
```

```javascript
// bench/runner.js — runHarness accepts a `retriever` option that defaults
// to the real ladder. Passing bm25only/recency/random as `retriever`
// reuses all corpus-loading + metric-aggregation infrastructure.
```

The ladder retriever is the default (`retriever` undefined → falls through to `retrieve` import). Baselines are a retriever-function swap, no parameter overrides needed — this is why we picked a dedicated mode rather than shoehorning into `SWEEP_CONFIGS`.

**Step 1 — Add `BASELINE_IDS` export to `bench/baselines/index.js`**

Add at the bottom of the file:

```javascript
/** Canonical IDs including the ladder. Python-side Modal dispatch iterates this. */
export const BASELINE_IDS = ['ladder', 'bm25only', 'recency', 'random'];
```

**Step 2 — Create `bench/baselines/_modal-point.js`**

Mirror `bench/sweeps/_modal-point.js` but parameterize on `retriever_id` instead of `overrides`. Reads `STARMEM_RETRIEVER_ID` env var, calls `runHarness` with the matching retriever function (or undefined for `ladder`), and prints the JSON result.

```javascript
/**
 * Modal entry point: run one baseline retriever over full corpus.
 *
 * Invoked by bench/modal/sweep_app.py::run_baseline_point via subprocess.
 * Reads STARMEM_RETRIEVER_ID env var ∈ BASELINE_IDS.
 * Prints JSON: { retrieverId, metrics, latencyMs, runCount, wallMs }.
 *
 * Mirrors bench/sweeps/_modal-point.js but parameterizes on retriever,
 * not overrides.
 *
 * @module bench/baselines/_modal-point
 * @see docs/plans/phase-11-infrastructure-hardening.md Task 3
 */
import { performance } from 'node:perf_hooks';
import { runHarness } from '../runner.js';
import { loadLocomo } from '../loaders/locomo.js';
import { bm25only } from './bm25only.js';
import { recency } from './recency.js';
import { random } from './random.js';
import { BASELINE_IDS } from './index.js';

const RETRIEVERS = {
    ladder: undefined,   // runHarness uses the real ladder when retriever is undefined
    bm25only,
    recency,
    random,
};

async function main() {
    const retrieverId = process.env.STARMEM_RETRIEVER_ID;
    if (!retrieverId || !BASELINE_IDS.includes(retrieverId)) {
        console.error(`Unknown STARMEM_RETRIEVER_ID: ${retrieverId!r}. Expected one of ${BASELINE_IDS.join(', ')}`);
        process.exit(2);
    }
    const retriever = RETRIEVERS[retrieverId];

    const corpus = await loadLocomo('bench/.cache/locomo10.json');
    const wallT0 = performance.now();
    const { runs, metrics, envSnapshot } = await runHarness({
        corpus,
        retriever,
        chatIdPrefix: `bench-${retrieverId}`,
    });
    const wallMs = performance.now() - wallT0;

    // Latency: average per-run latency across the corpus.
    const latencyMs = runs.length > 0
        ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length
        : 0;

    process.stdout.write(JSON.stringify({
        retrieverId,
        metrics,
        latencyMs,
        runCount: runs.length,
        wallMs,
        envSnapshot,
    }, null, 2));
}

main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
});
```

**Gotcha:** `!r}` is Python-style, not JS. Replace with template literal: `Unknown STARMEM_RETRIEVER_ID: ${retrieverId}.` (I'll flag this explicitly because subagents have been known to copy the Python-flavored string verbatim.)

**Step 3 — Add `run_baseline_point` to `bench/modal/sweep_app.py`**

Insert after the existing `run_point` function (around line 113). Mirrors `run_point`'s structure — symlink cache, subprocess-run Node, forward stdout/stderr.

```python
@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,
    memory=4096,
)
def run_baseline_point(retriever_id: str) -> str:
    """Run one baseline retriever over the full corpus.

    Args:
        retriever_id: one of BASELINE_IDS ("ladder", "bm25only", "recency", "random").

    Returns:
        JSON string with { retrieverId, metrics, latencyMs, runCount, wallMs, envSnapshot }.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_RETRIEVER_ID"] = retriever_id

    result = subprocess.run(
        ["node", "bench/baselines/_modal-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        import json as _json
        return _json.dumps({
            "error": "node subprocess failed",
            "retrieverId": retriever_id,
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
        }, indent=2)
    return result.stdout.strip()
```

**Step 4 — Add `run_baselines` orchestrator**

Insert after `run_baseline_point`:

```python
BASELINE_IDS = ["ladder", "bm25only", "recency", "random"]


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,
    memory=4096,
)
def run_baselines() -> dict:
    """Fan out baseline retrievers to parallel containers.

    Returns:
        Dict with keys:
            - report (str): rendered Markdown comparison table.
            - result_json (str): JSON-serialized payload (all 4 baselines' metrics).
            - run_dir (str): path inside the Modal Volume.
    """
    import json
    from datetime import datetime

    # Fan out
    point_results = list(run_baseline_point.map(BASELINE_IDS))
    points = [json.loads(pr) for pr in point_results]

    # Persist to Volume
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-baselines"
    import os
    os.makedirs(run_dir, exist_ok=True)

    result_payload = {
        "name": "baselines",
        "timestamp": ts,
        "points": points,
    }
    result_json_str = json.dumps(result_payload, indent=2)
    with open(f"{run_dir}/result.json", "w") as f:
        f.write(result_json_str)

    report = render_baselines_report(result_payload)
    with open(f"{run_dir}/report.md", "w") as f:
        f.write(report)

    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


def render_baselines_report(payload):
    """Render the four-retriever comparison as Markdown.

    Columns: retriever, mrr, coverage, recall@5, recall@10, latencyMs.
    Coverage comes from Task 4; if unavailable, emit '—' and note schema version.
    """
    lines = []
    lines.append(f"# Baselines comparison — {payload['timestamp']}")
    lines.append("")
    lines.append("| Retriever | MRR | Coverage | R@5 | R@10 | Latency (ms) |")
    lines.append("|---|---|---|---|---|---|")
    for pt in payload["points"]:
        rid = pt["retrieverId"]
        m = pt.get("metrics", {})
        mrr_v = m.get("mrr", float("nan"))
        cov = m.get("coverage", None)  # Task 4 surfaces this; fallback to '—'
        r5 = m.get("recallAtK", {}).get("5", float("nan"))
        r10 = m.get("recallAtK", {}).get("10", float("nan"))
        lat = pt.get("latencyMs", float("nan"))
        cov_cell = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        lines.append(
            f"| `{rid}` | {mrr_v:.4f} | {cov_cell} | {r5:.4f} | {r10:.4f} | {lat:.1f} |"
        )
    lines.append("")
    # Structural-invariant check — surface in the report
    ladder = next((p for p in payload["points"] if p["retrieverId"] == "ladder"), None)
    bm25 = next((p for p in payload["points"] if p["retrieverId"] == "bm25only"), None)
    if ladder and bm25:
        delta = ladder["metrics"]["mrr"] - bm25["metrics"]["mrr"]
        verdict = "PASS" if delta >= -0.02 else "FAIL"
        lines.append(f"**Structural invariant (ladder ≥ bm25only − 0.02):** ladder_mrr − bm25only_mrr = {delta:+.4f} → **{verdict}**")
    return "\n".join(lines)
```

**Step 5 — Wire `run-baselines` into `main()`**

In `bench/modal/sweep_app.py::main`, add after the existing `elif mode == "run-sweep":` block and before the final `else:`:

```python
    elif mode == "run-baselines":
        baselines_out = run_baselines.remote()
        report = baselines_out["report"]
        result_json_str = baselines_out["result_json"]
        run_dir = baselines_out["run_dir"]
        print(report)
        print(f"\n<!-- saved to Modal Volume: {run_dir} -->", file=__import__("sys").stderr)
        if local_out:
            import os as _os
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            stem = _os.path.basename(run_dir)
            (out / f"{stem}.md").write_text(report)
            (out / f"{stem}.json").write_text(result_json_str)
            print(f"<!-- mirrored to host: {out / stem}.{{md,json}} -->", file=__import__("sys").stderr)
```

Update the docstring usage block to include `run-baselines`.

**Step 6 — Unit test for dispatch shape**

Create `bench/modal/tests/test_baselines_mode.py`:

```python
"""Dispatch-shape tests for run-baselines mode (doesn't execute Modal)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sweep_app import BASELINE_IDS, render_baselines_report


def test_baseline_ids_canonical():
    assert BASELINE_IDS == ["ladder", "bm25only", "recency", "random"]


def test_render_baselines_report_shape():
    payload = {
        "name": "baselines",
        "timestamp": "2026-04-23T00-00-00Z",
        "points": [
            {"retrieverId": "ladder",   "metrics": {"mrr": 0.8057, "coverage": 0.64, "recallAtK": {"5": 0.61, "10": 0.70}}, "latencyMs": 12.3},
            {"retrieverId": "bm25only", "metrics": {"mrr": 0.6898, "coverage": 0.62, "recallAtK": {"5": 0.55, "10": 0.65}}, "latencyMs": 8.1},
            {"retrieverId": "recency",  "metrics": {"mrr": 0.1200, "coverage": 0.62, "recallAtK": {"5": 0.10, "10": 0.15}}, "latencyMs": 3.5},
            {"retrieverId": "random",   "metrics": {"mrr": 0.0500, "coverage": 0.62, "recallAtK": {"5": 0.04, "10": 0.08}}, "latencyMs": 2.0},
        ],
    }
    report = render_baselines_report(payload)
    assert "# Baselines comparison" in report
    assert "ladder" in report and "bm25only" in report
    assert "0.8057" in report
    assert "PASS" in report  # 0.8057 - 0.6898 = +0.1159 >= -0.02


def test_structural_invariant_fails_when_ladder_worse():
    payload = {
        "name": "baselines",
        "timestamp": "x",
        "points": [
            {"retrieverId": "ladder",   "metrics": {"mrr": 0.50, "coverage": 0.60, "recallAtK": {"5": 0.3, "10": 0.4}}, "latencyMs": 10.0},
            {"retrieverId": "bm25only", "metrics": {"mrr": 0.80, "coverage": 0.60, "recallAtK": {"5": 0.5, "10": 0.6}}, "latencyMs": 8.0},
        ],
    }
    report = render_baselines_report(payload)
    assert "FAIL" in report
```

Run it:

```bash
python -m pytest bench/modal/tests/test_baselines_mode.py -v
```

Expected: 3/3 green.

**Step 7 — Integration test for `_modal-point.js` (skipped if cache not warm)**

Add a short smoke test to `bench/baselines/_modal-point.js` invocation via package.json or as a manual step. For the plan, document the local smoke:

```bash
# Requires bench/.cache/locomo10.json to exist (warm from prior 9.x runs).
# Host smoke — NOT a Modal run, just proves the Node entry point works.
ls bench/.cache/locomo10.json && \
    STARMEM_RETRIEVER_ID=random node bench/baselines/_modal-point.js | \
    python -c "import json, sys; d=json.load(sys.stdin); assert d['retrieverId']=='random'; assert 'mrr' in d['metrics']; print('OK')"
```

If the cache file doesn't exist locally, skip this smoke — it'll validate at Task 7 dispatch time.

**Step 8 — Commit**

```bash
git add bench/baselines/_modal-point.js bench/baselines/index.js \
        bench/modal/sweep_app.py bench/modal/tests/test_baselines_mode.py
git commit -m "feat(bench): baselines on Modal (Phase 11 Task 3)

New --mode run-baselines dispatch fans out the 4-retriever comparison
across parallel containers. Replaces 9.5's 30-min sequential-local run
with ~8min parallel. render_baselines_report surfaces MRR, coverage,
R@5, R@10, latency + structural invariant PASS/FAIL inline.

Closes 9.5 retro filed candidate #4."
```

**Done-when:**
- [ ] `pytest bench/modal/tests/test_baselines_mode.py -v` passes 3/3
- [ ] `python -c "from bench.modal import sweep_app; print(sweep_app.BASELINE_IDS)"` prints `['ladder', 'bm25only', 'recency', 'random']`
- [ ] `sweep_app.run_baseline_point` and `sweep_app.run_baselines` both exist (check via `dir()` in Python REPL)
- [ ] Committed
- [ ] Modal dispatch itself is deferred to Task 7 proof — this task just lands the surface

---

## Task 4 — Coverage-weighted metric (two-column)

**Objective:** Surface `coverage = n_scored / n` as a first-class metric column alongside MRR/recall/precision, and extend the amendment rule to `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp`. No composite metric. The rule catches subset-selection bias (9.4.9/9.5 graph-knob pattern) without interpretation debt.

**Owner:** Subagent (Fireworks). Multi-file, needs careful review — but scope is bounded and signatures are stable.

**Files:**
- Modify: `bench/metrics/retrieval.js:232` (`computeMetrics`) — add `coverage` field to return type
- Modify: `bench/metrics/retrieval.js` header `@typedef MetricsResult` — add coverage
- Create: `bench/render/amendment-rule.js` — pure-function `shouldAmend({baseline, candidate})`
- Modify: `bench/modal/sweep_app.py` renderers (`render_tau_report`, `render_bm25_report`, `render_graph_report_stub`, `render_consolidation_report_stub`, `render_single_axis_report`) — add coverage column + amendment-rule application
- Create: `tests/unit/bench/metrics-coverage.test.js` — unit test for coverage field
- Create: `bench/render/amendment-rule.test.js` OR `tests/unit/bench/amendment-rule.test.js` (match existing convention — `ls tests/unit/bench/` first)

**Context grounded from live code (2026-04-23):**

Good news: `computeMetrics` (line 232) already tracks `n_scored` and `n_skipped` as part of the 9.4.6 honest-metrics fix. Coverage is literally `n_scored / n`. The change is additive — no existing callers break.

```javascript
// Current MetricsResult shape (JSDoc at line ~55):
/**
 * @property {number} n              - Total run count.
 * @property {number} n_scored       - Runs that produced numeric metrics.
 * @property {number} n_skipped      - Runs that produced NaN (empty matchedIds).
 * @property {Record<number, number>} precisionAtK
 * @property {Record<number, number>} recallAtK
 * @property {number} mrr
 */
```

Add `coverage: number` and compute it as `n > 0 ? n_scored / n : NaN`.

**Step 1 — Extend `computeMetrics` and its typedef**

Patch the `@typedef MetricsResult` JSDoc to add:

```javascript
 * @property {number} coverage       - n_scored / n. NaN if n === 0.
```

In the return object of `computeMetrics` (line ~303), add:

```javascript
    return {
        n: runs.length,
        n_scored,
        n_skipped,
        coverage: runs.length > 0 ? n_scored / runs.length : NaN,
        precisionAtK: precisionResult,
        recallAtK: recallResult,
        mrr: mrrCount > 0 ? mrrSum / mrrCount : NaN,
    };
```

**Step 2 — Write failing unit test**

First check existing convention: `ls tests/unit/bench/` — if there's already a `metrics-*.test.js`, match that naming. Create:

```javascript
// tests/unit/bench/metrics-coverage.test.js
import { test, expect } from '@jest/globals';
import { computeMetrics } from '../../../bench/metrics/retrieval.js';

test('coverage = n_scored / n', () => {
    const runs = [
        { retrieved: [{ id: 'a', content: '', sourceMessages: [0] }], qa: { evidenceTurns: [0] } },
        { retrieved: [{ id: 'b', content: '', sourceMessages: [1] }], qa: { evidenceTurns: [5] } }, // no intersect → skipped
        { retrieved: [{ id: 'c', content: '', sourceMessages: [2] }], qa: { evidenceTurns: [2] } },
    ];
    const m = computeMetrics(runs);
    expect(m.n).toBe(3);
    expect(m.n_scored).toBe(2);
    expect(m.n_skipped).toBe(1);
    expect(m.coverage).toBeCloseTo(2 / 3, 6);
});

test('coverage is NaN on empty input', () => {
    const m = computeMetrics([]);
    expect(Number.isNaN(m.coverage)).toBe(true);
});

test('coverage is 1.0 when every run scores', () => {
    const runs = [
        { retrieved: [{ id: 'a', content: '', sourceMessages: [0] }], qa: { evidenceTurns: [0] } },
        { retrieved: [{ id: 'b', content: '', sourceMessages: [1] }], qa: { evidenceTurns: [1] } },
    ];
    const m = computeMetrics(runs);
    expect(m.coverage).toBe(1.0);
});
```

Verify the shape assumption: `matchGoldByEvidence` intersects `retrieved.sourceMessages` with `evidenceTurns`. If a `retrieved` entry has `sourceMessages: [0]` and `evidenceTurns: [0]`, it matches. This is the 9.4.6 semantics; if the test fails with unexpected skip counts, re-read `matchGoldByEvidence` at line 137 and fix the fixtures.

Run: `npm test -- tests/unit/bench/metrics-coverage.test.js -v`. Expected: FAIL (coverage undefined on current code).

**Step 3 — Apply the patch from Step 1, re-run test. Expected: PASS 3/3.**

**Step 4 — Create `bench/render/amendment-rule.js`**

```javascript
/**
 * Amendment rule for sweep-to-baseline comparisons.
 *
 * A candidate amendment lands ONLY when it beats the baseline on MRR by
 * at least minMrrDelta AND does not drop coverage by more than
 * maxCoverageDrop. Catches subset-selection bias (9.4.9/9.5 graph-knob
 * pattern: MRR climbs because coverage falls, not because retrieval
 * improved).
 *
 * @module bench/render/amendment-rule
 * @see docs/plans/phase-11-infrastructure-hardening.md Task 4
 * @see docs/plans/phase-9-4-9-retro.md (subset-selection bias origin)
 */

/**
 * @typedef {object} MetricSample
 * @property {number} mrr
 * @property {number} coverage
 */

/**
 * @param {object} args
 * @param {MetricSample} args.baseline
 * @param {MetricSample} args.candidate
 * @param {number} [args.minMrrDelta] - Default 0.02.
 * @param {number} [args.maxCoverageDrop] - Default 0.05 (5pp).
 * @returns {{amend: boolean, reason: string, mrrDelta: number, coverageDelta: number}}
 */
export function shouldAmend({ baseline, candidate, minMrrDelta = 0.02, maxCoverageDrop = 0.05 }) {
    const mrrDelta = candidate.mrr - baseline.mrr;
    const coverageDelta = candidate.coverage - baseline.coverage;

    if (Number.isNaN(mrrDelta) || Number.isNaN(coverageDelta)) {
        return {
            amend: false,
            reason: `Cannot amend: NaN in baseline or candidate (mrr=${baseline.mrr}/${candidate.mrr}, coverage=${baseline.coverage}/${candidate.coverage}).`,
            mrrDelta,
            coverageDelta,
        };
    }

    if (mrrDelta < minMrrDelta) {
        return {
            amend: false,
            reason: `ΔMRR = ${mrrDelta.toFixed(4)} < ${minMrrDelta} (below amendment threshold).`,
            mrrDelta,
            coverageDelta,
        };
    }

    if (coverageDelta < -maxCoverageDrop) {
        return {
            amend: false,
            reason: `ΔMRR = ${mrrDelta.toFixed(4)} ≥ ${minMrrDelta}, but coverage drops ${(-coverageDelta * 100).toFixed(1)}pp > ${maxCoverageDrop * 100}pp allowed (subset-selection bias suspected).`,
            mrrDelta,
            coverageDelta,
        };
    }

    return {
        amend: true,
        reason: `ΔMRR = ${mrrDelta.toFixed(4)} ≥ ${minMrrDelta} and Δcoverage = ${(coverageDelta * 100).toFixed(1)}pp ≥ −${maxCoverageDrop * 100}pp.`,
        mrrDelta,
        coverageDelta,
    };
}
```

**Step 5 — Test `shouldAmend`**

Create `tests/unit/bench/amendment-rule.test.js` (or `bench/render/amendment-rule.test.js` — match existing convention found in Step 2):

```javascript
import { test, expect } from '@jest/globals';
import { shouldAmend } from '../../../bench/render/amendment-rule.js';

test('amends when MRR jumps and coverage holds', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.75, coverage: 0.63 },
    });
    expect(r.amend).toBe(true);
    expect(r.mrrDelta).toBeCloseTo(0.05, 6);
});

test('refuses when MRR gain is below threshold', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.71, coverage: 0.64 },
    });
    expect(r.amend).toBe(false);
    expect(r.reason).toMatch(/below amendment threshold/);
});

test('refuses on subset-selection bias (MRR ↑ but coverage drops)', () => {
    // 9.4.9 graph-knob pattern: MRR +0.10 but coverage falls from 0.64 to 0.48.
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.80, coverage: 0.48 },
    });
    expect(r.amend).toBe(false);
    expect(r.reason).toMatch(/subset-selection bias/);
});

test('allows small coverage drop within budget', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.75, coverage: 0.60 },  // -4pp
    });
    expect(r.amend).toBe(true);
});

test('refuses on NaN inputs', () => {
    const r = shouldAmend({
        baseline: { mrr: NaN, coverage: 0.64 },
        candidate: { mrr: 0.75, coverage: 0.64 },
    });
    expect(r.amend).toBe(false);
    expect(r.reason).toMatch(/NaN/);
});
```

Run: `npm test -- tests/unit/bench/amendment-rule.test.js -v`. Expected: 5/5 green.

**Step 6 — Add coverage column to Python renderers**

Five renderers in `bench/modal/sweep_app.py` emit Markdown tables: `render_tau_report` (line 209), `render_bm25_report` (line 307), `render_graph_report_stub` (line 510), `render_consolidation_report_stub` (line 843), `render_single_axis_report` (line — grep for it). Each builds a table from `p["metrics"]` per point.

For each renderer:
1. Add a `coverage` column after the `mrr` column in the Markdown table header and body.
2. Source: `p["metrics"].get("coverage", float("nan"))` — fall back to `—` if missing (for old cached per-point JSON before Task 4 shipped).
3. When the renderer surfaces an elbow proposal, look up baseline vs chosen point and emit `shouldAmend`-equivalent verdict as a rationale block. The Python-side check mirrors the JS rule:

```python
def _should_amend(baseline_metrics, candidate_metrics, min_mrr_delta=0.02, max_coverage_drop=0.05):
    """Python mirror of bench/render/amendment-rule.js::shouldAmend."""
    mrr_delta = candidate_metrics.get("mrr", float("nan")) - baseline_metrics.get("mrr", float("nan"))
    cov_delta = candidate_metrics.get("coverage", float("nan")) - baseline_metrics.get("coverage", float("nan"))

    import math
    if math.isnan(mrr_delta) or math.isnan(cov_delta):
        return {
            "amend": False,
            "reason": f"Cannot amend: NaN in baseline or candidate metrics.",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    if mrr_delta < min_mrr_delta:
        return {"amend": False, "reason": f"ΔMRR = {mrr_delta:+.4f} < {min_mrr_delta} (below amendment threshold).",
                "mrr_delta": mrr_delta, "coverage_delta": cov_delta}
    if cov_delta < -max_coverage_drop:
        return {"amend": False,
                "reason": f"ΔMRR = {mrr_delta:+.4f} ≥ {min_mrr_delta}, but coverage drops {-cov_delta * 100:.1f}pp > {max_coverage_drop * 100:.0f}pp allowed (subset-selection bias suspected).",
                "mrr_delta": mrr_delta, "coverage_delta": cov_delta}
    return {"amend": True,
            "reason": f"ΔMRR = {mrr_delta:+.4f} ≥ {min_mrr_delta} and Δcoverage = {cov_delta * 100:+.1f}pp ≥ −{max_coverage_drop * 100:.0f}pp.",
            "mrr_delta": mrr_delta, "coverage_delta": cov_delta}
```

Place `_should_amend` as a module-level helper near `_detect_elbow`.

In each renderer, after `_detect_elbow` returns, look up the baseline point (the one with overrides matching the first grid row — spec defaults) and the elbow's candidate point, then call `_should_amend` and append the verdict as a block after the elbow proposal:

```markdown
### Amendment verdict

ΔMRR = +0.0005 < 0.02 (below amendment threshold). **Held at spec.**
```

**Step 7 — Update renderer contract tests (if any exist)**

Check: `grep -rn "render_tau_report\|render_bm25_report" bench/modal/tests/` — if there are existing contract tests, extend them with a coverage-column assertion. If not, no new tests needed here (the per-function tests in Step 2/5 cover the metric surface; the renderers are mechanically producing tables).

**Step 8 — Verify all existing tests still green**

```bash
npm test                  # full jest suite — should stay at 816 tests green (baseline from 9.5)
python -m pytest bench/modal/tests/ -v
```

No existing tests should fail. If `bench/` tests count changed, that's expected: +3 for coverage, +5 for amendment-rule. Python test count: +3 (Task 1) + +3 (Task 3) = +6.

**Step 9 — Commit**

Two commits, logically separable:

```bash
git add bench/metrics/retrieval.js tests/unit/bench/metrics-coverage.test.js
git commit -m "feat(bench): coverage field on MetricsResult (Phase 11 Task 4.a)

Surfaces n_scored/n as a first-class metric alongside MRR/recall/
precision. Closes the coverage-weighted metric candidate from 9.5
retro — implemented as two-column reporting rather than a composite."

git add bench/render/amendment-rule.js tests/unit/bench/amendment-rule.test.js \
        bench/modal/sweep_app.py
git commit -m "feat(bench): amendment rule with coverage guard (Phase 11 Task 4.b)

shouldAmend requires ΔMRR ≥ 0.02 AND coverage_delta ≥ -5pp. Python
mirror _should_amend wired into all 5 renderers. Catches 9.4.9-style
subset-selection bias at render time so elbow proposals are labeled
'Held at spec' vs 'Amend' inline."
```

**Done-when:**
- [ ] `npm test -- tests/unit/bench/metrics-coverage.test.js` passes 3/3
- [ ] `npm test -- tests/unit/bench/amendment-rule.test.js` passes 5/5
- [ ] `npm test` full suite green (no regressions — expected count: 816 + 8 = 824)
- [ ] `python -m pytest bench/modal/tests/ -v` still green (Task 1/3 tests unaffected)
- [ ] Two commits landed
- [ ] `bench/modal/sweep_app.py` renderers all emit "coverage" column (`grep -c "coverage" bench/modal/sweep_app.py` ≥ 10)

---
## Task 5 — Re-render 9.5 sweep artifacts under the new metric

**Objective:** Reprocess the 9.5 per-point JSON artifacts (τ, bm25, graph, hops, relw, consolidation) through the Task 4 renderers so every sweep writeup has a coverage column and an amendment verdict. No live re-execution — pure re-render from cached data.

**Owner:** Subagent (Fireworks). Mechanical scope; amenable to delegation.

**Files:**
- Read: `docs/bench/sweeps/2026-04-22-tau-live.md`, `-bm25-live.md` (actually 2026-04-23), `-graph-live.md`, `-hops-live.md`, `-consolidation-live.md`, `docs/bench/sweeps/2026-04-23-relw-live.md`
- Read: the per-point `result.json` sidecar for each (landed in `docs/bench/sweeps/` by 9.5 Task's `--local-out` mirror, stems like `2026-04-23T15-23-45Z-tau.json`)
- Modify or replace each `-live.md` file with the new two-column render
- Preserve: the `-rulebased` non-live artifacts are not in scope; leave them untouched

**Context:** 9.5 persisted full per-point payloads (`{ overrides, metrics: { mrr, precisionAtK, recallAtK, n_scored, n_skipped }, latencyMs, runCount, wallMs }`) via `--local-out`. The `n_scored / n` ratio gives coverage retroactively. What's *not* recoverable without re-execution: if any sweep's JSON was lost or schema-incompatible. Discover-first-then-decide on each file.

**Step 1 — Discover the on-disk artifacts**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
ls -1 docs/bench/sweeps/*.md | grep -E '2026-04-2[23].*-live\.md$'
ls -1 docs/bench/sweeps/*.json 2>/dev/null | grep -E '2026-04-2[23]' || echo "no JSONs at top level"
ls -1 docs/bench/runs/ 2>/dev/null | head -20 || echo "no runs dir"
```

If per-point `result.json` files live under `docs/bench/runs/<stem>/result.json` instead of `docs/bench/sweeps/`, adjust the read paths accordingly. If ANY sweep's JSON is missing, document it in the re-render output and skip that file's re-render (note in Task 9 retro what couldn't be recovered).

**Step 2 — Build a one-shot re-render script**

Create `bench/modal/rerender.py` (temporary; committed with the re-render outputs and deleted in Task 9 if not useful long-term — decide at retro time):

```python
"""One-shot: re-render 9.5 sweep artifacts using Task 4 renderers.

Usage:
    python bench/modal/rerender.py <sweep_name> <result.json path> [output.md path]

Example:
    python bench/modal/rerender.py tau docs/bench/runs/2026-04-22T...-tau/result.json \\
        docs/bench/sweeps/2026-04-22-tau-live.md
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sweep_app import (
    render_tau_report,
    render_bm25_report,
    render_graph_report_stub,
    render_consolidation_report_stub,
    render_single_axis_report,
)


def main():
    if len(sys.argv) < 3:
        print("Usage: rerender.py <sweep_name> <result.json> [output.md]", file=sys.stderr)
        sys.exit(2)

    sweep_name, input_path = sys.argv[1], sys.argv[2]
    output_path = sys.argv[3] if len(sys.argv) >= 4 else None

    with open(input_path) as f:
        payload = json.load(f)

    # Back-fill coverage into each point's metrics if n_scored + n are present.
    for pt in payload.get("points", []):
        m = pt.get("metrics", {})
        if "coverage" not in m and "n_scored" in m and "n" in m and m["n"] > 0:
            m["coverage"] = m["n_scored"] / m["n"]

    # 9.4.9 sweeps often embed corpus_len / qa_count at the top level.
    corpus_len = payload.get("corpus_len", payload.get("corpusStats", {}).get("corpus_len", 0))
    qa_count = payload.get("qa_count", payload.get("corpusStats", {}).get("qa_count", 0))
    tags_stats = payload.get("tags_stats")

    if sweep_name == "tau":
        out = render_tau_report(payload, corpus_len, qa_count)
    elif sweep_name == "bm25":
        out = render_bm25_report(payload, corpus_len, qa_count, tags_stats)
    elif sweep_name in ("hops", "relw"):
        out = render_single_axis_report(payload, corpus_len, qa_count)
    elif sweep_name == "graph":
        out = render_graph_report_stub(payload)
    elif sweep_name == "consolidation":
        out = render_consolidation_report_stub(payload)
    else:
        print(f"Unknown sweep_name: {sweep_name!r}", file=sys.stderr)
        sys.exit(2)

    if output_path:
        Path(output_path).write_text(out)
        print(f"Wrote {output_path}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    main()
```

**Step 3 — Re-render each sweep, diff the outputs, sanity-check**

For each sweep found in Step 1:

```bash
# Example shape — adapt paths to actual discovery output
python bench/modal/rerender.py tau \
    docs/bench/runs/<2026-04-22T...-tau>/result.json \
    /tmp/tau-live-new.md
diff docs/bench/sweeps/2026-04-22-tau-live.md /tmp/tau-live-new.md | head -80
```

Expected shape of the diff: old table had no "coverage" column; new table has one with values ~0.60-0.65 across the τ grid. Old amendment proposal (if any) now annotated "Held at spec — ΔMRR below threshold" or "Held at spec — coverage drops". Genuine elbow on `TIER2_TAU_GAP` should remain as an elbow proposal but now with `coverage_delta ≈ 0` verdict "Amend".

If the diff looks sensible, overwrite:

```bash
mv /tmp/tau-live-new.md docs/bench/sweeps/2026-04-22-tau-live.md
```

Repeat for bm25, hops, relw, graph, consolidation. Six re-renders in total.

**Step 4 — Cross-check against retro invariants**

The re-rendered files must reproduce the 9.5 retro narrative: zero amendments ship. After all six re-renders, grep:

```bash
grep -l 'amend\.\? *= *\(true\|Amend\)' docs/bench/sweeps/2026-04-2[23]-*-live.md || echo "no amendments — matches retro"
```

If any file has `"amend": true` or "**Amend**" in the verdict block, re-read the original 9.5 retro to confirm; if the retro said it's held but the re-render says amend, the coverage-drop test is miscalibrated — drop back to the amendment-rule unit tests to debug.

**Step 5 — Commit**

```bash
git add docs/bench/sweeps/2026-04-2[23]-*-live.md bench/modal/rerender.py
git commit -m "docs(bench): re-render 9.5 sweeps under two-column metric (Phase 11 Task 5)

Six sweep artifacts refreshed: tau, bm25, graph, hops, relw, consolidation
— all with coverage column and amendment-rule verdict inline. Pure
re-render from cached per-point JSON; no live re-execution. All verdicts
'Held at spec' per 9.5 retro invariant.

rerender.py committed as a working tool; consider removing in Phase 12
if unused by then."
```

**Done-when:**
- [ ] Six `-live.md` files updated (or documented as unrecoverable)
- [ ] All files show "coverage" column in their primary metric table
- [ ] No file shows "Amend" verdict (matches 9.5 retro invariant)
- [ ] Committed

---

## Task 6 — BATCH_SIZE redesign: conversation-level splitting

**Objective:** Make `BATCH_SIZE` sweepable without cache-key-flow timeouts. Per 9.5 Decision: option (b) — 5 convs × 5 BATCH_SIZE values = 25 bounded containers, each running 1 conv × 1 BATCH_SIZE value. Each container completes in ~2-3 minutes (single-conv extraction load). Parallel fan-out across 25 containers finishes well under the 600s per-container timeout.

**Owner:** Subagent (Fireworks). Larger scope, well-defined interfaces.

**Files:**
- Create: `bench/sweeps/_modal-batchsize-point.js` — Node entry point: 1 conv × 1 BATCH_SIZE → metrics
- Modify: `bench/modal/sweep_app.py` — new `run_batchsize_point` Modal function + `run_consolidation_batchsize_sweep` orchestrator + wire into `run_consolidation_sweep` dispatch (as a new round, alongside existing DEDUP)
- Create: `bench/modal/tests/test_batchsize_split.py` — unit test for grid-shape and aggregation
- Modify: `bench/modal/sweep_app.py::render_consolidation_report_stub` — add a BATCH_SIZE round section

**Context grounded from 9.5 retro:**

9.5 attempted the naive approach (full corpus × one BATCH_SIZE at a time). Both attempts (600s and 1500s timeouts) hit `FunctionTimeoutError` because BATCH_SIZE is in the extraction cache key — every sweep value triggers 100% miss rate for that seed pass. Conversation-level splitting solves this three ways:

1. Per-container workload bounded: 1 conv ≈ 400 messages ≈ 40 extraction calls at BATCH_SIZE=10, 27 at BATCH_SIZE=15. Each extraction is ~3-5s on Nano-GPT → ~2-3 min per container. Comfortably under 600s.
2. `volume.commit()` fires on clean exit per container — partial progress persists naturally.
3. Parallel fan-out: 25 containers → effective wall-clock ≈ slowest-container time (~3 min) vs serial ≈ 60-80 min.

**Aggregation question:** when we split a sweep point (conv, BATCH_SIZE=10) into 5 per-conv runs, we get 5 `MetricsResult` per BATCH_SIZE. Aggregate by summing `n_scored`/`n_skipped` counts + weighted-averaging MRR/recall/precision. `updateRate` (the primary signal for DEDUP, also relevant to BATCH_SIZE) aggregates similarly.

**Step 1 — Audit the shape of existing `run_consolidation_sweep`**

Read `bench/modal/sweep_app.py::run_consolidation_sweep` (line 1029) and `render_consolidation_report_stub` (line 843) in full. Understand how the DEDUP round is structured — the BATCH_SIZE round should mirror that pattern. Note:
- How rounds are named and keyed
- How aggregation currently handles per-round metrics
- How the renderer decides which rounds to surface

If the DEDUP round uses a single-conv or small-sample workload already, the BATCH_SIZE round may be able to reuse that infrastructure rather than building parallel per-conv fan-out from scratch. If it uses the full corpus per container (the 9.5 failure mode), new per-conv fan-out is needed.

**Step 2 — Create `bench/sweeps/_modal-batchsize-point.js`**

```javascript
/**
 * Modal entry point: run ONE conversation × ONE BATCH_SIZE value.
 *
 * Invoked by bench/modal/sweep_app.py::run_batchsize_point via subprocess.
 * Reads STARMEM_CONV_IDX and STARMEM_BATCH_SIZE env vars.
 * Prints JSON: { convIdx, batchSize, metrics, consolidationStats, latencyMs, wallMs }.
 *
 * Conversation-level splitting (9.5 → Phase 11 redesign): each container
 * does one (conv, BATCH_SIZE) cell so the 600s timeout comfortably covers
 * the 100%-cache-miss extraction load per cell.
 *
 * @module bench/sweeps/_modal-batchsize-point
 * @see docs/plans/phase-11-infrastructure-hardening.md Task 6
 */
import { performance } from 'node:perf_hooks';
import { runHarness } from '../runner.js';
import { loadLocomo } from '../loaders/locomo.js';
import { setConstantOverrides, resetConstantOverrides } from '../../src/core/constants.js';

async function main() {
    const convIdx = parseInt(process.env.STARMEM_CONV_IDX ?? '', 10);
    const batchSize = parseInt(process.env.STARMEM_BATCH_SIZE ?? '', 10);
    if (!Number.isFinite(convIdx) || !Number.isFinite(batchSize)) {
        console.error(`Bad env: STARMEM_CONV_IDX=${process.env.STARMEM_CONV_IDX} STARMEM_BATCH_SIZE=${process.env.STARMEM_BATCH_SIZE}`);
        process.exit(2);
    }

    const fullCorpus = await loadLocomo('bench/.cache/locomo10.json');
    const conv = fullCorpus[convIdx];
    if (!conv) {
        console.error(`convIdx ${convIdx} out of range (corpus size ${fullCorpus.length})`);
        process.exit(2);
    }

    const wallT0 = performance.now();
    const { runs, metrics } = await runHarness({
        corpus: [conv],
        overrides: { BATCH_SIZE: batchSize },
        chatIdPrefix: `bench-bs${batchSize}-c${convIdx}`,
    });
    const wallMs = performance.now() - wallT0;

    const consolidationStats = runs[0]?.consolidationStats ?? null;
    const latencyMs = runs.length > 0
        ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length
        : 0;

    process.stdout.write(JSON.stringify({
        convIdx,
        batchSize,
        metrics,
        consolidationStats,
        latencyMs,
        wallMs,
    }, null, 2));
}

main().catch(err => {
    console.error(err.stack || String(err));
    process.exit(1);
});
```

**Step 3 — Add `run_batchsize_point` Modal function**

Mirror `run_point` + `run_baseline_point`. Symlink cache, subprocess Node, forward.

```python
@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,
    memory=4096,
)
def run_batchsize_point(conv_idx: int, batch_size: int) -> str:
    """Run one (conversation, BATCH_SIZE) cell.

    Args:
        conv_idx: 0-indexed conversation slot in LoCoMo-10.
        batch_size: BATCH_SIZE override to apply.

    Returns:
        JSON string with { convIdx, batchSize, metrics, consolidationStats, latencyMs, wallMs }.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_CONV_IDX"] = str(conv_idx)
    env["STARMEM_BATCH_SIZE"] = str(batch_size)

    result = subprocess.run(
        ["node", "bench/sweeps/_modal-batchsize-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        import json as _json
        return _json.dumps({
            "error": "node subprocess failed",
            "convIdx": conv_idx,
            "batchSize": batch_size,
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
        }, indent=2)
    return result.stdout.strip()
```

**Step 4 — Add `run_consolidation_batchsize_sweep` orchestrator**

Grid: `BATCH_SIZE ∈ {3, 5, 7, 10, 15}` × first 5 conversations (indices 0..4). 25 cells total. Spec default is `BATCH_SIZE = 10` per the 9.5 plan.

```python
BATCHSIZE_VALUES = [3, 5, 7, 10, 15]
BATCHSIZE_CONV_INDICES = [0, 1, 2, 3, 4]


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,
    memory=4096,
)
def run_consolidation_batchsize_sweep() -> dict:
    """Conversation-level-split BATCH_SIZE sweep (Phase 11 Task 6).

    25 cells (5 values × 5 convs) fanned out to parallel containers,
    then aggregated into one MetricsResult per BATCH_SIZE value.

    Returns:
        Dict with keys { report, result_json, run_dir }.
    """
    import json
    from datetime import datetime
    import os

    # Build (conv_idx, batch_size) pairs for parallel map
    pairs = [(ci, bs) for bs in BATCHSIZE_VALUES for ci in BATCHSIZE_CONV_INDICES]

    cell_results = list(run_batchsize_point.map(
        [p[0] for p in pairs],
        [p[1] for p in pairs],
    ))
    cells = [json.loads(cr) for cr in cell_results]

    # Aggregate: group by batch_size, weighted-average metrics
    by_bs = {}
    for cell in cells:
        bs = cell.get("batchSize")
        by_bs.setdefault(bs, []).append(cell)

    points = []
    for bs in BATCHSIZE_VALUES:
        cells_for_bs = by_bs.get(bs, [])
        if not cells_for_bs:
            continue
        total_n = sum(c.get("metrics", {}).get("n", 0) for c in cells_for_bs)
        total_n_scored = sum(c.get("metrics", {}).get("n_scored", 0) for c in cells_for_bs)
        total_n_skipped = sum(c.get("metrics", {}).get("n_skipped", 0) for c in cells_for_bs)

        # Weighted MRR: sum(mrr * n_scored) / sum(n_scored), skipping NaN.
        mrr_num = 0.0
        mrr_den = 0
        for c in cells_for_bs:
            m = c.get("metrics", {})
            if m.get("n_scored", 0) > 0 and not _is_nan(m.get("mrr")):
                mrr_num += m["mrr"] * m["n_scored"]
                mrr_den += m["n_scored"]
        mrr_agg = (mrr_num / mrr_den) if mrr_den > 0 else float("nan")

        # Aggregate updateRate from consolidationStats
        total_updated = sum(
            (c.get("consolidationStats") or {}).get("updated", 0)
            for c in cells_for_bs
        )
        total_added = sum(
            (c.get("consolidationStats") or {}).get("added", 0)
            for c in cells_for_bs
        )
        update_rate = (
            total_updated / (total_updated + total_added)
            if (total_updated + total_added) > 0
            else 0.0
        )

        points.append({
            "overrides": {"BATCH_SIZE": bs},
            "metrics": {
                "n": total_n,
                "n_scored": total_n_scored,
                "n_skipped": total_n_skipped,
                "coverage": (total_n_scored / total_n) if total_n > 0 else float("nan"),
                "mrr": mrr_agg,
                "updateRate": update_rate,
            },
            "cells": cells_for_bs,  # retained for provenance / diagnostics
        })

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-batchsize"
    os.makedirs(run_dir, exist_ok=True)

    knobs = [{"name": "BATCH_SIZE", "values": BATCHSIZE_VALUES}]
    elbow = _detect_elbow(points, knobs, "mrr")

    result_payload = {
        "name": "batchsize",
        "timestamp": ts,
        "points": points,
        "elbow": elbow,
        "convs_sampled": BATCHSIZE_CONV_INDICES,
    }
    result_json_str = json.dumps(result_payload, indent=2)
    with open(f"{run_dir}/result.json", "w") as f:
        f.write(result_json_str)

    report = render_batchsize_report(result_payload)
    with open(f"{run_dir}/report.md", "w") as f:
        f.write(report)

    volume.commit()
    return {"report": report, "result_json": result_json_str, "run_dir": run_dir}


def _is_nan(x):
    import math
    try:
        return math.isnan(x)
    except (TypeError, ValueError):
        return x is None


def render_batchsize_report(payload):
    lines = []
    lines.append(f"# BATCH_SIZE sweep — {payload['timestamp']}")
    lines.append("")
    lines.append(f"**Convs sampled:** indices {payload['convs_sampled']}")
    lines.append("")
    lines.append("| BATCH_SIZE | MRR | Coverage | Update rate | n (QA) |")
    lines.append("|---|---|---|---|---|")
    for pt in payload["points"]:
        bs = pt["overrides"]["BATCH_SIZE"]
        m = pt["metrics"]
        lines.append(
            f"| {bs} | {m['mrr']:.4f} | {m['coverage']:.4f} | {m.get('updateRate', 0):.4f} | {m['n']} |"
        )
    lines.append("")
    # Amendment verdict (Task 4 rule)
    if len(payload["points"]) >= 2:
        baseline_pt = next((p for p in payload["points"] if p["overrides"]["BATCH_SIZE"] == 10), payload["points"][0])
        if payload.get("elbow", {}).get("overrides"):
            chosen_bs = payload["elbow"]["overrides"].get("BATCH_SIZE")
            candidate_pt = next((p for p in payload["points"] if p["overrides"]["BATCH_SIZE"] == chosen_bs), None)
            if candidate_pt and candidate_pt is not baseline_pt:
                verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
                lines.append(f"### Amendment verdict")
                lines.append("")
                lines.append(f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}")
                lines.append("")
    lines.append(f"**Elbow rationale:** {payload.get('elbow', {}).get('rationale', '—')}")
    return "\n".join(lines)
```

**Step 5 — Wire into `run-sweep` dispatch**

In `run_sweep()` at line ~1124, add branch for `sweep_name == "batchsize"`:

```python
    if sweep_name == "batchsize":
        return run_consolidation_batchsize_sweep()
```

(Order the `if` after the existing `graph` and `consolidation` branches.)

Update the `main()` docstring usage block:

```
        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name batchsize
            → 25-cell (5 BATCH_SIZE × 5 convs) split sweep, ~3min parallel
```

**Step 6 — Unit test**

Create `bench/modal/tests/test_batchsize_split.py`:

```python
"""Unit tests for BATCH_SIZE sweep aggregation shape."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sweep_app import (
    BATCHSIZE_VALUES,
    BATCHSIZE_CONV_INDICES,
    render_batchsize_report,
)


def test_grid_is_5x5():
    assert len(BATCHSIZE_VALUES) == 5
    assert len(BATCHSIZE_CONV_INDICES) == 5
    assert 10 in BATCHSIZE_VALUES, "Spec default BATCH_SIZE=10 must be in grid"


def test_render_batchsize_shape():
    payload = {
        "name": "batchsize",
        "timestamp": "2026-04-24T00-00-00Z",
        "convs_sampled": [0, 1, 2, 3, 4],
        "points": [
            {"overrides": {"BATCH_SIZE": bs}, "metrics": {"n": 500, "n_scored": 320, "n_skipped": 180, "coverage": 0.64, "mrr": 0.80, "updateRate": 0.02}}
            for bs in BATCHSIZE_VALUES
        ],
        "elbow": {"overrides": {"BATCH_SIZE": 10}, "rationale": "spec default held"},
    }
    report = render_batchsize_report(payload)
    assert "# BATCH_SIZE sweep" in report
    for bs in BATCHSIZE_VALUES:
        assert f"| {bs} |" in report, f"BATCH_SIZE row {bs} missing from report"
    assert "Update rate" in report
```

Run:

```bash
python -m pytest bench/modal/tests/test_batchsize_split.py -v
```

Expected: 2/2 green.

**Step 7 — Commit**

```bash
git add bench/sweeps/_modal-batchsize-point.js bench/modal/sweep_app.py \
        bench/modal/tests/test_batchsize_split.py
git commit -m "feat(bench): BATCH_SIZE conversation-level-split sweep (Phase 11 Task 6)

Option (b) from 9.5 Phase 11 candidate #2: 5 values × 5 convs = 25
bounded containers, each running 1 conv × 1 BATCH_SIZE value. Per-cell
workload ~2-3min comfortably under 600s timeout; full sweep wall-clock
~3-5min parallel. Aggregation: weighted-average MRR by n_scored,
pooled coverage/updateRate. Dispatches via --mode run-sweep --sweep-name
batchsize."
```

**Done-when:**
- [ ] `pytest bench/modal/tests/test_batchsize_split.py -v` passes 2/2
- [ ] Module still imports: `python -c "from bench.modal import sweep_app; print(sweep_app.BATCHSIZE_VALUES)"`
- [ ] Committed

---

## Task 7 — Execute the BATCH_SIZE sweep on Modal

**Objective:** The proof-of-redesign dispatch. Task 6 lands the surface; Task 7 proves it works end-to-end on real Modal infrastructure.

**Owner:** Controller. One dispatch, artifact read, plan-patch commit.

**Files:**
- Read: the `report.md` and `result.json` artifacts from the run (via `--local-out`)
- Create/move: `docs/bench/sweeps/2026-04-XX-batchsize-live.md` (date from the dispatch)
- Move: `docs/bench/sweeps/2026-04-XX-batchsize-result.json` (copy alongside)

**Step 1 — Preflight**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
grep -n "BATCHSIZE_VALUES\|run_consolidation_batchsize_sweep" bench/modal/sweep_app.py | head -5
# Confirms Task 6 symbols are present.
```

If Modal deployment changed since 9.5, reconfirm cache state and env vars (`.env.bench` or Modal secret).

**Step 2 — Dispatch**

```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name batchsize \
    --local-out docs/bench/sweeps
```

**Pre-registered Branch expectations** (per `sweep-cache-invalidation-audit` skill):

- **Branch A (Δ >> threshold, coverage holds):** BATCH_SIZE has measurable effect on retrieval MRR. Unlikely — BATCH_SIZE affects consolidation/update-rate, not ranking directly. If this fires, flag for deep investigation in Task 9 retro.
- **Branch B (no signal, honest flat surface):** Most likely outcome. MRR flat ±0.005 across the grid. Coverage stable. Amendment verdict "Held at spec". This matches 9.4.6/9.5 framing: dedup/BATCH_SIZE are corpus-structural on LoCoMo's single-session distribution.
- **Branch C (below-noise Δ):** MRR delta < 0.02 but non-zero. Held-at-spec.
- **Branch D (timeout):** Redesign failed. The per-cell workload estimate was wrong. Triage: read `stderr` from the Modal dispatch, identify which cell(s) timed out, reduce per-cell workload (e.g., sample first 200 messages of each conv) or further-split grid. DO NOT re-dispatch the same shape — that's the 9.5 retro's "do not chase a timing-out sweep" lesson applied.

**Step 3 — Read the artifact, append observations**

Read the produced `docs/bench/sweeps/<stem>.md`. If Branch B (expected): rename to `2026-04-XX-batchsize-live.md` (substitute actual date):

```bash
mv docs/bench/sweeps/<stem>.md docs/bench/sweeps/2026-04-XX-batchsize-live.md
mv docs/bench/sweeps/<stem>.json docs/bench/sweeps/2026-04-XX-batchsize-live.json
```

Append a short "Phase 11 Task 7 observation" section at the bottom:

- Grid shape: 5 × 5 = 25 cells
- Wall-clock (from `wallMs` across cells): report min / median / max per cell and orchestrator total
- Cache behavior: note whether container-level `volume.commit()` persisted partial progress (visible as re-run shrinking observed wall-clock on re-dispatch)
- Verdict: amendment result per Task 4 rule
- Classification: which pre-registered Branch fired

**Step 4 — Commit**

```bash
git add docs/bench/sweeps/2026-04-XX-batchsize-live.*
git commit -m "docs(bench): Phase 11 Task 7 — BATCH_SIZE sweep complete

25-cell split sweep wall-clock: <min>s median / <max>s max per cell,
<total>s orchestrator. Branch <X> fired. Per Phase 11 Task 4 amendment
rule: <Held at spec | Amend>.

Closes 9.5 retro Phase 11 candidate #2 (BATCH_SIZE budget-aware redesign)."
```

**Done-when:**
- [ ] Modal dispatch completed without timeout (Branch D not fired, or if fired: triage commit landed with diagnosis)
- [ ] Artifact renamed to canonical path under `docs/bench/sweeps/`
- [ ] Observation section appended
- [ ] Committed

---
## Task 8 — Baseline.json refresh

**Objective:** Update `docs/bench/baseline.json` to reflect Phase 11's infrastructure changes. No tuned-knob amendments (the retrieval surface is unchanged). What changes: schema adds `coverage` field per measurement, `knownIssues` gets a Phase 11 closure entry, `headlineMetrics` refreshed from the Task 7 baselines re-run under new metric.

**Owner:** Controller. Small, mechanical.

**Files:**
- Modify: `docs/bench/baseline.json`

**Step 1 — Read current shape**

```bash
python -m json.tool docs/bench/baseline.json | head -60
```

The 9.5 shape (from memory-recall): top-level keys `asOf`, `gitSha`, `corpus`, `nodeVersion`, `scorerId`, `status`, `statusReason`, `knownIssues`, `tuned`, `observations`, `headlineMetrics`. Per-entry under `tuned`: `specDefault`, `measured`, `source`, `note`.

**Step 2 — Patch surgically**

Update the following fields only. Do NOT rewrite the whole file.

- `asOf`: today's ISO date (e.g., `2026-04-XX`)
- `gitSha`: current HEAD (run `git rev-parse HEAD`)
- `statusReason`: prepend a short sentence — "Phase 11 landed measurement-infrastructure hardening (elbow guard, coverage column, amendment-rule coverage gate, baselines on Modal, BATCH_SIZE conversation-level split). No tuned-knob amendments; the 9.4.8 retrieval surface holds."

Append to `knownIssues`:

```json
"Phase 11 infrastructure hardening landed 2026-04-XX: (1) _elbow_on_slice zero-axis-Δ guard (ABS_DELTA_FLOOR=0.005) prevents the 9.5 three-time false-positive pattern; (2) two-column coverage reporting with shouldAmend/ _should_amend applying the ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp gate at render time; (3) --mode run-baselines + --mode run-sweep --sweep-name batchsize dispatch paths; (4) --local-out parity for run-point mode. All sweep artifacts under docs/bench/sweeps/2026-04-2[23]-*-live.md re-rendered under the new metric. Zero tuned-knob amendments shipped — the 9.4.8 retrieval surface (TIER2_TAU_GAP=10, MRR 0.8057, coverage ~64%) remains the production default. Tier 2 demolition (Phase 11 candidate #5) and EXTRACT_MAX_TOKENS amendment deferred to Phase 12."
```

For each entry under `tuned` where 9.5 already stored `measured`, add a `coverage` field if the per-point JSON was re-rendered in Task 5. If the coverage wasn't recoverable (e.g., older artifacts), leave it absent and note in the entry's `note` that coverage is unrecoverable pre-Task-4.

Refresh `headlineMetrics` from the Task 7 Modal baselines re-run under the new metric. Expected shape:

```json
"headlineMetrics": {
    "retriever": "ladder",
    "corpus": "locomo10-full",
    "mrr": 0.8057,
    "coverage": 0.64,
    "recallAtK": { "1": ..., "3": ..., "5": 0.61, "10": 0.70 },
    "precisionAtK": { ... },
    "asOf": "2026-04-XX",
    "source": "docs/bench/baselines/2026-04-XX-comparison.md (Phase 11 Task 3, Modal dispatch)"
}
```

If the Task 3 dispatch wasn't run (subagent blocked, whatever reason), note in `headlineMetrics.source` that it references the 9.5 comparison, and plan to refresh in Phase 12.

**Step 3 — Validate**

```bash
python -m json.tool docs/bench/baseline.json > /dev/null && echo "JSON valid"
# Existing schema test:
npm test -- tests/integration/bench/baseline-json.test.js
# Expected: green. If the test rejects the new `coverage` field, extend the schema test in-phase.
```

If the schema test asserts on exact top-level keys (closed shape), extend the whitelist. If it asserts on tuned-entry shape, extend that too.

**Step 4 — Commit**

```bash
git add docs/bench/baseline.json
# If schema test was extended:
git add tests/integration/bench/baseline-json.test.js
git commit -m "docs(bench): baseline.json refresh — Phase 11 infrastructure hardening

- asOf + gitSha bumped to Phase 11 HEAD
- statusReason + knownIssues append Phase 11 closure entry
- coverage field added where recoverable from cached per-point JSON
- headlineMetrics refreshed from Task 3 Modal baselines run
- Zero tuned-knob amendments; 9.4.8 retrieval surface holds unchanged"
```

**Done-when:**
- [ ] `python -m json.tool docs/bench/baseline.json` exits 0
- [ ] `npm test -- tests/integration/bench/baseline-json.test.js` green
- [ ] `asOf`, `gitSha`, `statusReason`, `knownIssues`, `headlineMetrics` all updated
- [ ] Committed

---

## Task 9 — Retro

**Objective:** Narrate Phase 11 — what shipped, what held, what surprised, handoff notes for Phase 12.

**Owner:** Controller. Retro quality > subagent speed, per established Phase 9 pattern.

**Files:**
- Create: `docs/plans/phase-11-retro.md`

**Template structure (mirrors 9.5 retro):**

```markdown
# Phase 11 Retro — Measurement Infrastructure Hardening

**Plan:** [`phase-11-infrastructure-hardening.md`](./phase-11-infrastructure-hardening.md)
**Shipped:** 2026-04-XX at commit `<hash>`
**Scope:** 5 of 6 filed Phase 11 candidates (Tier 2 demolition deferred to Phase 12)

---

## 1. What shipped

- Elbow-detector zero-axis-Δ guard (`ABS_DELTA_FLOOR = 0.005`)
- `--local-out` parity for `run-point` mode
- `--mode run-baselines` Modal dispatch, 4 retrievers × parallel containers
- Coverage column as first-class MetricsResult field
- `bench/render/amendment-rule.js` + Python `_should_amend` mirror — enforces ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp at render time
- Six 9.5 sweep artifacts re-rendered under two-column metric; zero amendment verdicts (matches 9.5 retro invariant)
- BATCH_SIZE conversation-level-split sweep: 25 bounded containers, <X> min wall-clock (vs 9.5's two timeout failures)
- `docs/bench/baseline.json` refreshed with Phase 11 knownIssues closure + coverage fields

## 2. Decisions held / revised

(Fill in per the 10-decision list from the plan header. Expected: all held unless Task 7 surfaced a Branch D redesign miss.)

## 3. Execution mode

Controller-driven for Tasks 0/1/2/7/8/9, subagents for Tasks 3/4/5/6. Total commits: X. Azure flakiness: <observed / not observed>.

## 4. Surprises

(Fill in during execution — at minimum the Branch classification for Task 7, any preflight drift caught, any sub-phase-trigger moments that didn't happen.)

## 5. Notes for Phase 12

- **Tier 2 demolition.** 9.5 candidate #5. `TIER2_TAU_GAP=10` already functionally disables Tier 2; the ladder could simplify to always-Tier-3-as-Tier-2-seed. Low-risk refactor once BATCH_SIZE measurement substrate is verified. Likely first task of Phase 12.
- **`EXTRACT_MAX_TOKENS → 256`.** 9.5 observation-only. Cache-key-bound, so requires either a fresh cache or the same conversation-level split trick Phase 11 built for BATCH_SIZE. Now that infrastructure exists, Phase 12 can sweep against it directly.
- **Corpus expansion (v2.1 scope).** LoCoMo's single-session structure remains the retrieval-surface bottleneck. All three Tier 3 edge-weight knobs (λ₁, λ₂, EXPLICIT_RELATION_WEIGHT) fully inert. Multi-session / cross-character corpus required to exercise edge-weighting meaningfully.
- **`rerender.py` disposition.** Tool committed in Task 5 for one-shot backfill. Decide at Phase 12 start: either remove (no longer useful once Phase 11's renderers ship coverage natively), promote to `bench/modal/rerender.py` as a permanent tool, or leave it for ad-hoc future rescues.
- **Baselines on Modal re-use.** Task 3's pattern (`run_baseline_point` + `BASELINE_IDS`) is the template for future retriever-swap comparisons (Zep, Mem0, etc. — Phase 10 scope). The Node entry point `_modal-point.js` variants are the seam to extend.

## 6. Notes for the skill library

- **`sweep-cache-invalidation-audit` Branch D follow-up.** 9.5 BATCH_SIZE timeout → Phase 11 conversation-level split. Skill's "don't chase a timing-out sweep" guidance holds perfectly, but the *redesign* pattern (split the cache-invalidating axis across bounded containers, aggregate by weighted mean) is a candidate addition to the skill under a "Recovery Patterns" section. Phase 11 field-validated this for BATCH_SIZE; likely applicable to any future cache-key-bound sweep.
- **`detecting-vacuous-metrics` field-validation #5.** The zero-axis-Δ guard (Task 1) is the mechanical fix for the pattern the skill has diagnosed four times. Skill already covers the detection; Phase 11 adds the structural prevention. Consider a "Prevention Patterns" subsection referencing ABS_DELTA_FLOOR.
- **`writing-plans` pre-flight effectiveness.** Phase 11's plan was grounded against live code via JCM at draft time (`_elbow_on_slice` source, `computeMetrics` shape, `main()` dispatch). Zero preflight-drift commits expected during execution. If that holds through retro, it's a cheap confirmation that the pre-flight pattern from 9.5 carries forward.

## 7. Commit graph

(Generated by `git log --oneline <Phase 11 base>..HEAD`.)

---

**Phase 11 closes.** Measurement infrastructure is hardened: every future sweep renders a coverage column, proposes amendments only when both MRR and coverage pass the gate, and runs on Modal without cache-key-flow timeouts. The retrieval surface itself is unchanged from 9.4.8/9.5. Phase 12 can now tune with confidence: any sweep that says "amend" actually means amend.
```

**Step 1 — Generate commit graph**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
# Base commit = commit before Task 0 landed. Find via:
git log --oneline docs/plans/phase-9-5-retro.md | head -1
# That's the base. All Phase 11 commits follow.
git log --oneline <base-sha>..HEAD > /tmp/phase-11-commits.txt
cat /tmp/phase-11-commits.txt
```

Paste into the retro's §7.

**Step 2 — Fill in §1 through §6 based on actual execution**

Specifically:
- §3: observed Azure flakiness count (how many `(empty)` turns landed during controller tasks)
- §4: any preflight bugs found in the plan during execution (per `plan-preflight-audit` skill, should be low — <3 — if the draft grounded correctly)
- §4: Task 7 Branch classification (B expected)

**Step 3 — Commit**

```bash
git add docs/plans/phase-11-retro.md
git commit -m "docs(plans): phase 11 retro"
```

**Step 4 — Update `docs/plans/ROADMAP.md` retro log**

Append a `## Phase 11—<date>` section mirroring the Phase 9 / Phase 8 format: what shipped, test totals, commits this phase, execution mode, decisions held/revised, surprises, notes for next phase.

```bash
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 11 retro entry in ROADMAP"
```

**Done-when:**
- [ ] `docs/plans/phase-11-retro.md` exists, ~200 lines, mirrors 9.5 retro structure
- [ ] `docs/plans/ROADMAP.md` has a `## Phase 11—<date>` section appended
- [ ] Both committed
- [ ] Phase 11 declared closed

---

## Phase-level done-when checklist

Before declaring Phase 11 complete:

- [ ] All 10 tasks committed and their per-task done-when items green
- [ ] `npm test` — full suite green. Expected delta: +3 coverage tests, +5 amendment-rule tests = 824 total (from 816).
- [ ] `python -m pytest bench/modal/tests/` — three test files green: `test_detect_elbow.py` (3), `test_baselines_mode.py` (3), `test_batchsize_split.py` (2) = 8 tests
- [ ] `grep -c '^## Phase 11' docs/plans/ROADMAP.md` returns 1
- [ ] `docs/bench/baseline.json`'s `asOf` matches Phase 11 HEAD date
- [ ] Zero tuned-knob amendments shipped (the whole point — Phase 11 is pure infrastructure)
- [ ] Six 9.5 sweep artifacts re-rendered under new metric, no file shows "Amend" verdict
- [ ] `modal run bench/modal/sweep_app.py --mode run-baselines` dispatches cleanly (Task 3 proof)
- [ ] `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name batchsize` dispatches cleanly (Task 7 proof; Branch D not fired, or if fired: diagnosis committed)

---

## Out of scope (explicit — do not let scope creep in)

Per 9.5 retro + decisions locked at plan start:

- ❌ **Tier 2 demolition** — Phase 12 candidate
- ❌ **`EXTRACT_MAX_TOKENS → 256`** — Phase 12
- ❌ **Corpus expansion (multi-session, cross-character)** — v2.1
- ❌ **Playwright smoke harness / UX polish / external memory-system baselines** — Phase 10 (skipped until further notice)
- ❌ **Spec edits** — no spec amendments land in Phase 11; the spec remains accurate as-is
- ❌ **Drift detection, influence propagation, multi-agent research loop, embeddings** — v2.1+ always, never in any v2.0 phase
