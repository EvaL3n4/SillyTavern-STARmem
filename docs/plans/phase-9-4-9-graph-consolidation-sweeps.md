# Sub-phase 9.4.9: Graph + Consolidation Sweep Refresh Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Run the deferred graph and consolidation sweeps against the post-9.4.8 retrieval surface. Port both into the Modal `SWEEP_CONFIGS` registry, add required renderers and aggregate-stats plumbing, execute via Modal, and amend constants + baseline.json if any round shows meaningful lift (>0.02 MRR absolute).

**Architecture:** Both sweeps already exist as Node CLIs under `bench/sweeps/{graph,consolidation}.js` (5 rounds × 4-5 values each for graph coordinate descent; single-axis 5-point sweep for consolidation). 9.4.9 lifts them into `bench/modal/sweep_app.py::SWEEP_CONFIGS` so they run on Modal's per-point parallelism, ports the report renderers to Python, extends `run_point` to surface consolidation `aggStats`, lands two preflight source-code fixes that unblock sweeping, then runs everything and interprets.

**Tech Stack:** Python 3.11 (Modal aggregator, renderers), Node 20.x (bench harness inside containers), existing STARmem infrastructure from 9.4.7/9.4.8 (pure-JS bench, `.env.bench` Secret, `starmem-bench-data` Volume).

---

**Decisions locked before writing this plan (see conversation 2026-04-22):**

1. **Graph sweep structure: single Modal sweep name (`graph`) that runs coordinate descent internally** (decision 1b). Matches existing `bench/sweeps/graph.js` shape: 5 sequential rounds, each picks best-MRR override value, feeds into `baseOverrides` for the next round. Eva runs one `modal run` invocation, not five.
2. **`TIER3_SEEDS_K` IS in the graph sweep.** Pinned at 3 forever up to 9.4.8; with TIER2_TAU_GAP=10 making Tier 3 the hot path, whether we seed from top-1/3/5 now materially affects retrieval. Sweep values: `[1, 3, 5, 7]`. +1 round on the existing 5; total 6 rounds / ~27 points across the graph sweep.
3. **Consolidation sweep: DEDUP_JACCARD_THRESHOLD only.** ~~Adds `BATCH_SIZE`.~~ **Revised mid-flight (2026-04-22 synthetic smoke):** `BATCH_SIZE` sweep breaks the warm extraction cache contract — cache key is `sha256(model + messages + maxTokens)`, changing BATCH_SIZE changes batch composition → all new keys → systematic misses → live-LLM fallback → 600s Modal function timeout. Observed FunctionTimeoutError on synthetic BATCH_SIZE round at commit `b4ec654`. Filed as 9.5 candidate — live-extraction sub-phase regenerates cache on demand, making the sweep tractable there. 9.4.9 ships DEDUP_JACCARD_THRESHOLD only (5 points, single wave, ~90s).
4. **Pre-register Branch C (no-signal outcome) for consolidation.** 9.4.6 consolidation retro found rule-based seeder under-stresses dedup (`updateRate` 4.4% → 0.7% across thresholds, retrieval quality flat to 4 decimals). If 9.4.9's consolidation sweep reproduces that flatness post-9.4.7 (ΔMRR < 0.005 across all 9 points), the honest conclusion is "defer consolidation tuning to sub-phase 9.5 live-extraction" and we do NOT amend constants. Branch C is pre-registered so I don't chase a flat surface.
5. **Amend constants + baseline.json if any round shows meaningful lift** (ΔMRR ≥ 0.02 absolute at the round's elbow vs current spec default). If no round clears 0.02, ship the measurement artifacts only. Separate commits per amended knob to keep the history interpretable.
6. **No Phase 11 work in 9.4.9.** TIER2_TAU_GAP=10 effectively disabled Tier 2 gating; Phase 11 may remove the τ comparison code entirely. 9.4.9 stays out of that — we measure Tier 3 / consolidation against the *current* ladder shape. Phase 11 demolition stays Phase 11.
7. **Scope-locked preflight fixes** — two source-code issues that block sweeping cleanly must land in 9.4.9 Task 1 before any sweep runs:
   - `BATCH_SIZE` is NOT in `_SWEPT_CONSOLIDATION_KEYS` — adds. (Kept even after decision 3 revision — future-proofs 9.5 when BATCH_SIZE re-enters scope.)
   - `TIER3_SEEDS_K` is NOT in `_SWEPT_RETRIEVAL_KEYS` — adds.
   - `src/consolidation/consolidate.js:47` destructures `BATCH_SIZE` at module top (**writing-plans preflight trap**) — rewrites to `CONSOLIDATION.BATCH_SIZE` at call time.
   - Add guard-test coverage so these don't regress.
8. **Modal persistence is already fixed** (9.4.8 commit `f5baae5`). Every sweep writes `result.json` + `report.md` to `/data/runs/<ts>-<sweep>/` on the Volume and supports `--local-out` host mirror. No infra work in 9.4.9; run with `--local-out docs/bench/runs` on every real sweep command.
9. **Seed rounds with `TIER2_TAU_GAP=10`.** Every point in every graph sweep round runs with gap=10 baseOverride so Tier 3 is actually exercised (otherwise Tier 2 shortcut fires and graph knobs don't matter). Consolidation sweep doesn't need this (consolidation runs offline before retrieval), but belt-and-suspenders doesn't hurt.
10. **Retro lives at `docs/plans/phase-9-4-9-retro.md`** following the 9.4.5/9.4.6/9.4.7/9.4.8 convention. Structure per 9.4.8-retro template (what happened, decisions held, what worked, what surprised, metrics, handoff notes, skill library notes).

---

## Tentative task breakdown

| # | Task | Files |
|---|------|-------|
| 0 | Commit the plan | `docs/plans/phase-9-4-9-graph-consolidation-sweeps.md` |
| 1 | Preflight source fixes: `_SWEPT_*_KEYS` additions, destructure rewrite, guard tests | `src/core/constants.js`, `src/consolidation/consolidate.js`, `tests/unit/core/swept-constants-overridable.test.js` |
| 2 | Port graph coordinate descent to `SWEEP_CONFIGS["graph"]` + `run_graph_sweep` helper | `bench/modal/sweep_app.py` |
| 3 | Port consolidation sweep to `SWEEP_CONFIGS["consolidation"]` + `run_consolidation_sweep` helper | `bench/modal/sweep_app.py` |
| 4 | Extend `run_point` to surface `aggStats` for consolidation path | `bench/modal/sweep_app.py`, `bench/modal/_modal-point.js` |
| 5 | Python `render_graph_report` (ports `bench/sweeps/graph.js:142-260`) | `bench/modal/sweep_app.py` |
| 6 | Python `render_consolidation_report` with updateRate band-rule recommendation (ports `bench/sweeps/consolidation.js:142-240`) | `bench/modal/sweep_app.py` |
| 7 | Smoke + full graph sweep via Modal → interpret → amend | Modal invocation + `src/core/constants.js` + `docs/bench/baseline.json` (conditional) |
| 8 | Smoke + full consolidation sweep via Modal → interpret → amend | Modal invocation + `src/core/constants.js` + `docs/bench/baseline.json` (conditional) |
| 9 | Retro | `docs/plans/phase-9-4-9-retro.md` |

---

## Manual Modal Invocation Protocol (inherited from 9.4.8)

Agent sandbox does not have the `modal` Python package; Eva's environment does. Modal CLI invocations are routed to Eva.

**Protocol (same as 9.4.8):**

- **Subagents write code, edit files, and commit.** No `modal` CLI invocations from subagents.
- **When a step says "Run: `modal run ...`"**, the subagent MUST:
  1. Finish all file edits + local verifications in that step.
  2. Commit whatever is committable at that point.
  3. STOP and return with: *"Ready for Eva to run `<exact command>` in the repo root. Expected output: `<expected>`."*
  4. Do NOT proceed until the controller supplies Eva's output.
- **Controller role:** passes Eva's stdout back to the subagent (or next subagent) via delegation context. Eva's output becomes the "expected" verification that would otherwise be checked directly.
- **Local (non-Modal) commands are agent-runnable.** `npm test`, `npm run lint`, `git ...`, file reads/writes run in the sandbox.

**Affected steps in 9.4.9** (subagent STOPs at these):
- Task 2 Step 4 (synthetic graph smoke via Modal)
- Task 3 Step 4 (synthetic consolidation smoke via Modal)
- Task 7 Steps 1 and 2 (graph smoke + full graph sweep)
- Task 8 Steps 1 and 2 (consolidation smoke + full consolidation sweep)

---

## Task 0: Commit the plan

**Objective:** Stabilize the plan as a reference for subagents and future sessions.

**Files:**
- Create: `docs/plans/phase-9-4-9-graph-consolidation-sweeps.md` (this file)

**Step 1: Write + review the plan.** Already done by the time you're reading this.

**Step 2: Commit.**

```bash
git add docs/plans/phase-9-4-9-graph-consolidation-sweeps.md
git commit -m "docs(plans): sub-phase 9.4.9 graph + consolidation sweep refresh

Port deferred graph (coordinate descent, 6 rounds) and consolidation
(DEDUP_JACCARD_THRESHOLD + BATCH_SIZE) sweeps into Modal substrate.
Preflight source fixes unblock sweeping: add TIER3_SEEDS_K and
BATCH_SIZE to _SWEPT_*_KEYS, rewrite consolidate.js module-top
destructure to call-time reads. Amends constants + baseline.json
if any round shows ΔMRR ≥ 0.02; pre-registers Branch C no-signal
fallback for consolidation per 9.4.6 flatness finding."
```

**Verification:** `git log -1 --stat` shows the plan file at 700+ lines, no other files touched.

---

## Task 1: Preflight source fixes + guard tests

**Objective:** Make `BATCH_SIZE` and `TIER3_SEEDS_K` overridable via the sweep harness. Rewrite the one module-top destructure that would silently swallow overrides. Add guard tests so neither regresses.

**Files:**
- Modify: `src/core/constants.js` (lines 186-203, `_SWEPT_*_KEYS` arrays)
- Modify: `src/consolidation/consolidate.js` (lines 45-48 destructure block, ~line 105 BATCH_SIZE reference)
- Modify: `tests/unit/core/swept-constants-overridable.test.js` (add guard coverage for new keys)
- Modify: `tests/unit/core/constants.test.js` (update _SWEPT_*_KEYS length assertion if present)

**Background:** Writing-plans skill field-validated preflight ("Runtime-Swappable 'Constants' Require More Than `export let`") flags module-top destructures as a silent failure mode. `consolidate.js:47` destructures `BATCH_SIZE` from `CONSOLIDATION`. Post-sweep override, the destructured local retains the pre-override value; the sweep will produce identical results across all BATCH_SIZE values and "prove" the knob is inert. It's not — the measurement is broken.

**Step 1: Write failing tests first (TDD).**

Patch `tests/unit/core/swept-constants-overridable.test.js`:

```js
// Add inside the existing describe('setConstantOverrides', ...) block
// near the similar TIER2_TAU_CONFIDENCE test (approx line 115):

test('TIER3_SEEDS_K override lands on RETRIEVAL and restores', () => {
    const before = RETRIEVAL.TIER3_SEEDS_K;
    const restore = setConstantOverrides({ TIER3_SEEDS_K: 7 });
    expect(RETRIEVAL.TIER3_SEEDS_K).toBe(7);
    restore();
    expect(RETRIEVAL.TIER3_SEEDS_K).toBe(before);
});

test('BATCH_SIZE override lands on CONSOLIDATION and restores', () => {
    const before = CONSOLIDATION.BATCH_SIZE;
    const restore = setConstantOverrides({ BATCH_SIZE: 10 });
    expect(CONSOLIDATION.BATCH_SIZE).toBe(10);
    restore();
    expect(CONSOLIDATION.BATCH_SIZE).toBe(before);
});
```

Patch the no-destructure guard (existing in same file, grep for `const \\{` invariant test) to explicitly include `BATCH_SIZE` and `TIER3_SEEDS_K` in the key list that must not appear in module-top destructures.

**Step 2: Run tests to verify failure.**

```bash
npm test tests/unit/core/swept-constants-overridable.test.js -- -t "TIER3_SEEDS_K|BATCH_SIZE"
```

**Expected:** Both new tests FAIL — `setConstantOverrides({ TIER3_SEEDS_K: 7 })` throws "unknown swept key" because TIER3_SEEDS_K isn't in `_SWEPT_RETRIEVAL_KEYS`. Same for BATCH_SIZE on the CONSOLIDATION side.

**Step 3: Land the constants.js fix.**

Patch `src/core/constants.js` lines 186-203:

```js
/** @type {ReadonlyArray<string>} Swept keys in RETRIEVAL. Used by the guard test. */
export const _SWEPT_RETRIEVAL_KEYS = Object.freeze([
    'TIER2_TAU_CONFIDENCE',
    'TIER2_TAU_GAP',
    'TIER3_LAMBDA_1',
    'TIER3_LAMBDA_2',
    'TIER3_MAX_HOPS',
    'TIER3_SEEDS_K',       // NEW (9.4.9)
    'TIER3_BEAM_WIDTH',
    'EDGE_CAP_PER_ENTRY',
    'COOCCURRENCE_WEIGHT',
    'EXPLICIT_RELATION_WEIGHT',
    'SUBJECT_BOOST',
    'TAG_BOOST',
]);

/** @type {ReadonlyArray<string>} Swept keys in CONSOLIDATION. */
export const _SWEPT_CONSOLIDATION_KEYS = Object.freeze([
    'DEDUP_JACCARD_THRESHOLD',
    'BATCH_SIZE',           // NEW (9.4.9)
]);
```

**Step 4: Run the test again to verify _SWEPT_RETRIEVAL_KEYS side passes.**

```bash
npm test tests/unit/core/swept-constants-overridable.test.js -- -t "TIER3_SEEDS_K"
```

**Expected:** TIER3_SEEDS_K test PASSES. BATCH_SIZE may still fail because of the destructure trap (Step 5).

**Step 5: Rewrite the module-top destructure in `src/consolidation/consolidate.js`.**

Current shape (line 45-48):

```js
import { RETRIEVAL, CONSOLIDATION } from '../core/constants.js';
const {
    BATCH_SIZE,
    DEDUP_JACCARD_THRESHOLD,
} = CONSOLIDATION;
```

Rewrite to read through CONSOLIDATION at call time. Keep the import, remove the destructure block entirely, then find every reference to the bare `BATCH_SIZE` or `DEDUP_JACCARD_THRESHOLD` identifier in this file and replace with `CONSOLIDATION.BATCH_SIZE` / `CONSOLIDATION.DEDUP_JACCARD_THRESHOLD`.

Grep for uses first to know the scope:

```bash
grep -n "BATCH_SIZE\\|DEDUP_JACCARD_THRESHOLD" src/consolidation/consolidate.js
```

Expected matches: the destructure itself (remove), one reference around line 105 (`Math.min(BATCH_SIZE, state.workingBuffer.length)` → `Math.min(CONSOLIDATION.BATCH_SIZE, state.workingBuffer.length)`), and whatever dedup threshold uses exist in the same file.

After the rewrite, re-run the guard test suite:

```bash
npm test tests/unit/core/swept-constants-overridable.test.js
```

**Expected:** All guard tests PASS, including the destructure invariant guard (grep-based; confirms no `const \{ BATCH_SIZE \}` or `const \{ DEDUP_JACCARD_THRESHOLD \}` destructures exist anywhere in `src/`).

**Step 6: Tripwire-verify the destructure guard.**

Writing-plans skill mandates tripwire protocol for grep-based guard tests. Inject a sentinel:

```bash
echo "// TEST-SENTINEL: const { BATCH_SIZE } = CONSOLIDATION;" >> src/consolidation/consolidate.js
npm test tests/unit/core/swept-constants-overridable.test.js 2>&1 | grep -E "FAIL|BATCH_SIZE" | head -5
```

**Expected:** Guard test FAILS with a specific error naming `src/consolidation/consolidate.js` as the destructure offender. If it passes, the regex is too narrow — fix it before proceeding.

**Cleanup (critical choice of command):**

```bash
# SAFE DEFAULT — uses patch() with exact sentinel text.
# Does NOT use `git checkout src/consolidation/consolidate.js`
# because Task 1's other edits are uncommitted in this file.
```

Use `patch(path="src/consolidation/consolidate.js", old_string="// TEST-SENTINEL: const { BATCH_SIZE } = CONSOLIDATION;\n", new_string="")`.

Re-run full suite to confirm green:

```bash
npm test
```

**Step 7: Run full test suite.**

```bash
npm test
```

**Expected:** 75 suites / 814 tests green (was 812; +2 new tests for TIER3_SEEDS_K and BATCH_SIZE overrides).

**Step 8: Commit.**

```bash
git add src/core/constants.js src/consolidation/consolidate.js \\
        tests/unit/core/swept-constants-overridable.test.js \\
        tests/unit/core/constants.test.js
git commit -m "feat(core): unlock TIER3_SEEDS_K + BATCH_SIZE for sweep overrides

Adds both keys to _SWEPT_RETRIEVAL_KEYS / _SWEPT_CONSOLIDATION_KEYS so
setConstantOverrides() accepts them. Rewrites consolidate.js's
module-top destructure (BATCH_SIZE, DEDUP_JACCARD_THRESHOLD) to
read through CONSOLIDATION.* at call time — the destructure would
have silently snapshotted pre-override values and made 9.4.9's
BATCH_SIZE sweep produce identical results across all values.

Guard tests cover both override paths. Destructure invariant guard
tripwire-verified by sentinel injection → FAIL → cleanup."
```

---

## Task 2: Port graph coordinate descent to `SWEEP_CONFIGS["graph"]`

**Objective:** Lift the 6-round graph coordinate descent from `bench/sweeps/graph.js` into `bench/modal/sweep_app.py`. Each round sweeps one knob on the Modal parallel fabric; best-MRR value from round N feeds `baseOverrides` for round N+1.

**Files:**
- Modify: `bench/modal/sweep_app.py` (add `SWEEP_CONFIGS["graph"]`, add `run_graph_sweep` helper)

**Background:** Unlike tau/bm25 (single parallel grid), graph is inherently sequential across rounds because each round picks a winner that becomes the next round's base. Within a round, the knob's values still fan out in parallel via `run_point.map()`. 6 rounds × 4-5 values = 27 points total; total wall-clock estimate ~8 min on Modal (6 sequential 32-container waves, each wave ~60-90s including cold starts).

**Step 1: Define the rounds table.**

Add to `bench/modal/sweep_app.py` near the existing `SWEEP_CONFIGS` dict:

```python
# Graph sweep — coordinate descent across 6 Tier 3 / edge knobs.
# Mirrors bench/sweeps/graph.js:254-269. Each round pins previous
# rounds' winners as baseOverrides and sweeps one knob. Winner =
# point with highest MRR in the round.
GRAPH_ROUNDS = [
    {"name": "lambda_1",     "knob": "TIER3_LAMBDA_1",      "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
    {"name": "lambda_2",     "knob": "TIER3_LAMBDA_2",      "values": [0.1, 0.2, 0.3, 0.4, 0.5]},
    {"name": "beam",         "knob": "TIER3_BEAM_WIDTH",    "values": [3, 5, 8, 10]},
    {"name": "seeds_k",      "knob": "TIER3_SEEDS_K",       "values": [1, 3, 5, 7]},   # NEW (9.4.9)
    {"name": "edge_cap",     "knob": "EDGE_CAP_PER_ENTRY",  "values": [10, 15, 20, 30, 50]},
    {"name": "cooccurrence", "knob": "COOCCURRENCE_WEIGHT", "values": [0.25, 0.5, 0.75, 1.0]},
]

# Every point in every graph round runs with TIER2_TAU_GAP=10
# (9.4.8 amendment). Without this baseOverride, Tier 2 shortcut fires
# for most queries and graph knobs don't affect retrieval.
GRAPH_BASE_OVERRIDES = {"TIER2_TAU_GAP": 10}
```

**Step 2: Implement `run_graph_sweep` helper.**

Add a new function in `bench/modal/sweep_app.py`:

```python
def run_graph_sweep(synthetic: bool = False) -> dict:
    """Run the 6-round graph coordinate descent.

    Each round sweeps one knob with previous winners pinned.
    Returns the same shape as run_sweep but with a 'rounds' list
    of per-round results and a final 'composite_elbow' that stacks
    every winner.

    Args:
        synthetic: If True, shrinks each round's grid to 2 points
            for smoke testing. Corpus stays full LoCoMo-10.
    """
    import os, json
    from datetime import datetime, timezone

    rounds_out = []
    accumulated_overrides = dict(GRAPH_BASE_OVERRIDES)

    for round_def in GRAPH_ROUNDS:
        knob_name = round_def["knob"]
        values = round_def["values"][:2] if synthetic else round_def["values"]

        # Build grid for this round: one point per value, with
        # accumulated_overrides as the base.
        grid = [
            {**accumulated_overrides, knob_name: v}
            for v in values
        ]
        overrides_jsons = [json.dumps(p) for p in grid]
        point_results = list(run_point.map(overrides_jsons))
        points = [json.loads(pr) for pr in point_results]

        # Pick winner by MRR
        winner = max(points, key=lambda p: p["metrics"]["mrr"])
        winning_value = winner["overrides"][knob_name]
        winning_mrr = winner["metrics"]["mrr"]

        rounds_out.append({
            "name": round_def["name"],
            "knob": knob_name,
            "values": values,
            "points": points,
            "winner": {"value": winning_value, "mrr": winning_mrr},
        })

        # Pin the winner for the next round
        accumulated_overrides[knob_name] = winning_value

    # Persist raw + rendered outputs (mirrors run_sweep pattern)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-graph"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": "graph",
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": 10,
        "qa_count": points[0]["runCount"] if points else 0,
        "base_overrides": GRAPH_BASE_OVERRIDES,
        "rounds": rounds_out,
        "composite_elbow": {
            "overrides": accumulated_overrides,
            "rationale": "Coordinate descent winners across 6 rounds, each round pinned for the next.",
        },
    }
    result_json_str = json.dumps(payload, indent=2)

    report = render_graph_report(payload)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)
    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }
```

**Step 3: Wire `graph` into the dispatch.**

Extend `SWEEP_CONFIGS` and the `run_sweep` Modal function to recognize the "graph" name. Simplest: add a branch at the top of `run_sweep`:

```python
@app.function(image=image, volumes={"/data": volume}, secrets=[env_secret], timeout=1800, memory=4096)
def run_sweep(sweep_name: str, synthetic: bool = False) -> dict:
    """...existing docstring...

    For sweep_name='graph' or 'consolidation', dispatches to the
    specialized runner; tau/bm25 use the generic grid path.
    """
    # ... existing symlink setup ...

    if sweep_name == "graph":
        return run_graph_sweep(synthetic)
    if sweep_name == "consolidation":
        return run_consolidation_sweep(synthetic)  # added in Task 3

    # ... existing tau/bm25 grid path ...
```

**Step 4: Synthetic graph smoke via Modal.**

Commit what's written so far (Task 2 is committable before Task 3's consolidation runner even exists — `run_sweep` branches cleanly, and graph doesn't depend on consolidation):

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): Modal graph sweep with 6-round coordinate descent

Lifts bench/sweeps/graph.js coordinate descent into SWEEP_CONFIGS.
Each round pins previous winners as baseOverrides; within a round,
values fan out via run_point.map(). Adds TIER3_SEEDS_K round (new
in 9.4.9, +1 round on the original 5). Every point runs with
TIER2_TAU_GAP=10 baseOverride so Tier 3 is actually exercised.

Persistence matches 9.4.8 f5baae5 pattern — result.json + report.md
land on Modal Volume at /data/runs/<ts>-graph/."
```

**STOP here.** Hand off to Eva:

> Ready for Eva to run `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name graph --synthetic --local-out docs/bench/runs` in the repo root.
>
> Expected: ~90s wall-clock; prints a Markdown graph report with 6 rounds × 2 points each = 12 points total. Mirrors to `docs/bench/runs/<ts>-graph.{md,json}`. MRR on the synthetic grid should be ≥0.80 for most points (TIER2_TAU_GAP=10 + warm cache).

Do NOT proceed to Task 3 until Eva's output confirms the synthetic smoke ran clean and produced a graph report with 6 round sections.

---

## Task 3: Port consolidation sweep to `SWEEP_CONFIGS["consolidation"]`

**Objective:** Lift the DEDUP_JACCARD_THRESHOLD sweep from `bench/sweeps/consolidation.js` into Modal substrate, and add BATCH_SIZE as a second round (per decision 3).

**Files:**
- Modify: `bench/modal/sweep_app.py` (add CONSOLIDATION_ROUNDS, `run_consolidation_sweep`)

**Background:** Consolidation is structurally simpler than graph — 2 rounds, each a single-axis sweep, each with 4-5 points. ~9 points total. No coordinate descent across rounds because the two knobs are independent (dedup fires during consolidation; batch_size gates how many entries a single consolidation call processes). Each round is interpreted separately.

**Step 1: Define the rounds.**

Add to `bench/modal/sweep_app.py`:

```python
# Consolidation sweep — two independent single-axis rounds.
# Mirrors bench/sweeps/consolidation.js:281-283; adds BATCH_SIZE
# round (new in 9.4.9 per 9.4.7 finding that BATCH_SIZE affects
# idle-drain semantics).
CONSOLIDATION_ROUNDS = [
    {"name": "dedup",       "knob": "DEDUP_JACCARD_THRESHOLD", "values": [0.5, 0.6, 0.7, 0.8, 0.9]},
    {"name": "batch_size",  "knob": "BATCH_SIZE",              "values": [3, 5, 10, 15]},  # NEW (9.4.9)
]
```

**Step 2: Implement `run_consolidation_sweep`.**

```python
def run_consolidation_sweep(synthetic: bool = False) -> dict:
    """Run two independent consolidation knob sweeps.

    Each round is interpreted standalone — no coordinate descent
    across rounds because the knobs affect orthogonal parts of
    the consolidation pipeline (dedup Jaccard gates merge
    decisions; batch_size gates per-call drain cardinality).
    """
    import os, json
    from datetime import datetime, timezone

    rounds_out = []

    for round_def in CONSOLIDATION_ROUNDS:
        knob_name = round_def["knob"]
        values = round_def["values"][:2] if synthetic else round_def["values"]
        grid = [{knob_name: v} for v in values]
        overrides_jsons = [json.dumps(p) for p in grid]
        point_results = list(run_point.map(overrides_jsons))
        points = [json.loads(pr) for pr in point_results]

        # Branch-C pre-registration: flag flat rounds.
        mrr_values = [p["metrics"]["mrr"] for p in points]
        mrr_range = max(mrr_values) - min(mrr_values)
        is_flat = mrr_range < 0.005  # decision 4 threshold

        # Elbow: highest-MRR point; if flat, spec-default fallback.
        if is_flat:
            elbow = {"value": None, "mrr": max(mrr_values), "flat": True}
        else:
            winner = max(points, key=lambda p: p["metrics"]["mrr"])
            elbow = {"value": winner["overrides"][knob_name], "mrr": winner["metrics"]["mrr"], "flat": False}

        rounds_out.append({
            "name": round_def["name"],
            "knob": knob_name,
            "values": values,
            "points": points,
            "elbow": elbow,
            "mrr_range": mrr_range,
        })

    # Persist + render (same pattern as run_graph_sweep)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-consolidation"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": "consolidation",
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": 10,
        "qa_count": points[0]["runCount"] if points else 0,
        "rounds": rounds_out,
    }
    result_json_str = json.dumps(payload, indent=2)
    report = render_consolidation_report(payload)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)
    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }
```

**Step 3: Commit.**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): Modal consolidation sweep — dedup + batch_size rounds

Two independent single-axis rounds (dedup Jaccard 0.5-0.9 and
BATCH_SIZE 3-15). Pre-registers Branch C: rounds with MRR range
<0.005 are flagged flat (9.4.6 retro found rule-based seeder
under-stresses dedup; if 9.4.9 reproduces flatness post-9.4.7,
defer tuning to 9.5 live extraction).

Renderer (render_consolidation_report) lands in Task 6."
```

**Step 4: Synthetic consolidation smoke via Modal.**

**STOP here.** Hand off to Eva:

> Ready for Eva to run `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name consolidation --synthetic --local-out docs/bench/runs` in the repo root.
>
> Expected: ~60s wall-clock; 2 rounds × 2 points each = 4 points total. Smoke currently prints raw payload since `render_consolidation_report` ships in Task 6; look for two rounds (dedup, batch_size) in the JSON payload.

Note: the synthetic run will NOT emit full Markdown yet — `render_consolidation_report` is Task 6. The smoke validates the runner dispatch + Modal fan-out, not the report shape.

---

## Task 4: Extend `run_point` to surface `aggStats`

**Objective:** Consolidation reports need per-point `added`/`updated`/`drained`/`updateRate`/`dedupHitRate` counters. Currently `run_point` returns metrics + latency but not consolidation aggregate stats. Both sides of the wire (Node `_modal-point.js` and Python dispatch) need the extension.

**Files:**
- Modify: `bench/modal/_modal-point.js` (extract and emit `aggStats` from the harness result)
- Modify: `bench/modal/sweep_app.py` (document the new field in `run_point` contract; no code change, it flows through JSON unchanged)

**Background:** `bench/sweeps/consolidation.js` already computes `aggStats` from the Node-side harness (`consolidationStats` aggregated across runs). `_modal-point.js` currently strips it. Pass it through so the consolidation renderer has the counters without a separate round-trip.

**Step 1: Write a local test first.**

Run a single consolidation-shaped point locally without Modal to see what the harness returns:

```bash
node -e "
import('./bench/harness/runner.js').then(async ({ runHarness }) => {
    const result = await runHarness({
        corpus: [/* ... */],  // use bench/fixtures/miniCorpus.js equivalent
        overrides: { DEDUP_JACCARD_THRESHOLD: 0.7 },
        seed: 42,
    });
    console.log(JSON.stringify({
        metrics: result.metrics,
        consolidationStats: result.consolidationStats,
    }, null, 2));
});
"
```

Confirm `consolidationStats` exists on the result object with `{added, updated, drained, ...}`. If naming differs from the consolidation.js sweep's expected shape, note the delta and handle in Step 2.

**Step 2: Update `_modal-point.js` to pass through `aggStats`.**

Find the current result-emission block in `bench/modal/_modal-point.js` (likely near the end, after `runHarness` completes). It currently emits something like:

```js
const output = {
    overrides,
    metrics: result.metrics,
    latencyMs: result.latencyMs || {},
    runCount: result.runCount || 0,
};
console.log(JSON.stringify(output));
```

Extend to include `aggStats`:

```js
// Compute aggStats the same way bench/sweeps/consolidation.js does —
// sum consolidationStats across all per-QA runs, derive rates.
function aggregate(stats) {
    if (!stats || !Array.isArray(stats)) return null;
    const totals = stats.reduce((acc, s) => ({
        added:   acc.added   + (s.added   || 0),
        updated: acc.updated + (s.updated || 0),
        drained: acc.drained + (s.drained || 0),
        batches: acc.batches + (s.batches || 0),
    }), { added: 0, updated: 0, drained: 0, batches: 0 });
    const updateRate   = totals.updated / Math.max(1, totals.added + totals.updated);
    const dedupHitRate = totals.updated / Math.max(1, totals.drained);
    return { ...totals, updateRate, dedupHitRate };
}

const output = {
    overrides,
    metrics: result.metrics,
    latencyMs: result.latencyMs || {},
    runCount: result.runCount || 0,
    aggStats: aggregate(result.consolidationStats),  // NEW
};
console.log(JSON.stringify(output));
```

**Step 3: Verify local consolidation run emits aggStats.**

Re-run the local harness eval from Step 1 and confirm `aggStats` now appears in the output with non-zero counters (rule-based seeder generates consolidation activity; 0 across the board means the harness isn't wiring `consolidationStats` through).

**Step 4: Verify tau/bm25 paths don't break.**

The `aggregate(result.consolidationStats)` call returns `null` when `consolidationStats` is absent (tau/bm25 sweeps don't surface it). Confirm:

```bash
node bench/modal/_modal-point.js --overrides-json '{"TIER2_TAU_CONFIDENCE": 0.5}' 2>&1 | tail -5
```

Output's `aggStats` field should be `null`. If the JSON has missing-field instead of null, adjust the renderer side to handle either.

**Step 5: Commit.**

```bash
git add bench/modal/_modal-point.js
git commit -m "feat(bench): pass consolidationStats aggregate through run_point

Extends the Modal point runner to surface {added, updated, drained,
batches, updateRate, dedupHitRate} as aggStats alongside metrics and
latency. Null for tau/bm25 sweeps (no consolidation counters);
populated for consolidation. Enables render_consolidation_report to
emit the per-threshold table without a second round-trip."
```

---

## Task 5: Python `render_graph_report`

**Objective:** Port `bench/sweeps/graph.js:142-260` renderReport to Python. Output is a multi-round Markdown report with per-round tables, composite elbow, spec-amendment proposal.

**Files:**
- Modify: `bench/modal/sweep_app.py` (add `render_graph_report` function)

**Background:** The existing `render_tau_report` / `render_bm25_report` pattern provides the template. Graph is multi-round, so the renderer iterates `payload["rounds"]`, emits a table per round, and closes with the composite elbow across all rounds.

**Step 1: Read the JS source as the port reference.**

```bash
cat bench/sweeps/graph.js | sed -n '142,260p'
```

Note the exact column order, elbow detection, and amendment logic. The Python port must match line-for-line (byte-identical output is the 9.4.8 Python-aggregator-parity bar).

**Step 2: Implement the renderer.**

Add to `bench/modal/sweep_app.py`:

```python
def render_graph_report(payload):
    """Render a multi-round graph sweep report.

    Port of bench/sweeps/graph.js:142-260. Output shape:
    - Header with date, corpus, primary metric, base overrides
    - One section per round: knob name, values table, winner
    - Composite elbow section with all round winners stacked
    - Spec amendment proposal per-knob (>50% deviation from spec default)
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    rounds = payload["rounds"]
    base = payload["base_overrides"]
    composite = payload["composite_elbow"]["overrides"]

    # Per-round sections
    round_sections = []
    for r in rounds:
        knob = r["knob"]
        header = f"| {knob} | recallAt5 | precisionAt3 | mrr | p50 | p95 |"
        separator = "|---|---|---|---|---|---|"
        rows = []
        for p in r["points"]:
            v = p["overrides"][knob]
            r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
            p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
            mrr = f"{p['metrics']['mrr']:.4f}"
            p50 = f"{p['latencyMs']['p50']:.2f}"
            p95 = f"{p['latencyMs']['p95']:.2f}"
            rows.append(f"| {v} | {r5} | {p3} | {mrr} | {p50} | {p95} |")
        rows_joined = "\n".join(rows)
        winner_line = (
            f"**Round winner:** `{knob}={r['winner']['value']}` "
            f"(mrr={r['winner']['mrr']:.4f})"
        )
        round_sections.append(
            f"### Round {r['name']}\n\n{header}\n{separator}\n{rows_joined}\n\n{winner_line}"
        )

    rounds_joined = "\n\n".join(round_sections)

    # Spec amendment proposal — per-knob, flag knobs >50% deviation
    spec_defaults = {
        "TIER3_LAMBDA_1": 1.0,
        "TIER3_LAMBDA_2": 0.3,
        "TIER3_BEAM_WIDTH": 5,
        "TIER3_SEEDS_K": 3,
        "EDGE_CAP_PER_ENTRY": 20,
        "COOCCURRENCE_WEIGHT": 0.5,
    }
    amendments = []
    for knob, measured in composite.items():
        if knob == "TIER2_TAU_GAP":
            continue  # base override, not a graph knob
        spec = spec_defaults.get(knob)
        if spec is None:
            continue
        deviation = abs(measured - spec) / spec if spec else float('inf')
        flag = " **(AMEND)**" if deviation > 0.5 else ""
        amendments.append(
            f"- `{knob}`: spec={spec}, measured={measured} "
            f"(deviation {deviation*100:.0f}%){flag}"
        )
    amendment_section = "\n".join(amendments) if amendments else "No amendments proposed."

    base_overrides_json = json.dumps(base)
    composite_json = json.dumps(composite, indent=2)

    report = f"""# Graph sweep — {today}

**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items
**Primary metric:** mrr
**Base overrides:** `{base_overrides_json}` (9.4.8 amendment: TIER2_TAU_GAP=10 disables Tier 2 shortcut, forces Tier 3 to be exercised)
**Rounds:** {len(rounds)} coordinate-descent rounds; each round's winner pins into the next.

{rounds_joined}

## Composite elbow

All round winners stacked as a single override set:

```json
{composite_json}
```

## Spec amendment proposal

{amendment_section}

Rationale: per-knob deviation >50% from spec default flags as AMEND candidate.
Sub-phase 9.4.9 ships amendments only for knobs with composite-elbow ΔMRR ≥0.02
absolute vs TIER2_TAU_GAP=10 baseline alone (see retro).
"""
    return report
```

**Step 3: Commit.**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): Python render_graph_report for 6-round sweep

Ports bench/sweeps/graph.js:142-260 to Python. Multi-round output
with per-round tables, composite elbow, and per-knob amendment
proposal flagging >50% deviations. Matches 9.4.8 tau/bm25 renderer
style for consistency across sweep artifacts."
```

---

## Task 6: Python `render_consolidation_report`

**Objective:** Port `bench/sweeps/consolidation.js:142-240` renderReport. Emit per-threshold table with aggStats counters (updateRate, dedupHitRate), band-rule recommendation (target updateRate [0.2, 0.4]), flat-surface detection.

**Files:**
- Modify: `bench/modal/sweep_app.py` (add `render_consolidation_report`)

**Step 1: Implement.**

```python
def render_consolidation_report(payload):
    """Render the two-round consolidation sweep report.

    Port of bench/sweeps/consolidation.js:142-240. Per-round table
    includes aggStats counters; recommendation follows the Phase 6
    retro band rule (prefer updateRate in [0.2, 0.4]); pre-registered
    Branch C triggers when MRR range <0.005 across a round.
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    rounds = payload["rounds"]

    round_sections = []
    for r in rounds:
        knob = r["knob"]
        header = (
            f"| {knob} | added | updated | drained | updateRate | "
            f"dedupHitRate | recallAt5 | mrr | p50 | p95 |"
        )
        separator = "|---|---|---|---|---|---|---|---|---|---|"
        rows = []
        for p in r["points"]:
            v = p["overrides"][knob]
            agg = p.get("aggStats") or {}
            added = agg.get("added", "—")
            updated = agg.get("updated", "—")
            drained = agg.get("drained", "—")
            ur = f"{agg['updateRate']:.4f}" if "updateRate" in agg else "—"
            dhr = f"{agg['dedupHitRate']:.4f}" if "dedupHitRate" in agg else "—"
            r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
            mrr = f"{p['metrics']['mrr']:.4f}"
            p50 = f"{p['latencyMs']['p50']:.2f}"
            p95 = f"{p['latencyMs']['p95']:.2f}"
            rows.append(
                f"| {v} | {added} | {updated} | {drained} | {ur} | {dhr} | "
                f"{r5} | {mrr} | {p50} | {p95} |"
            )
        rows_joined = "\n".join(rows)

        # Branch C detection + recommendation
        if r["elbow"]["flat"]:
            recommendation = (
                f"**Branch C — flat surface (MRR range {r['mrr_range']:.4f} "
                f"< 0.005 across all {len(r['points'])} points)**\n\n"
                f"Knob is inert on this corpus with rule-based extractor. "
                f"Defer tuning to sub-phase 9.5 live-extraction. Keep {knob} "
                f"at spec default."
            )
        else:
            # Band rule: prefer updateRate in [0.2, 0.4], closest to 0.3
            best_point = min(
                r["points"],
                key=lambda p: abs((p.get("aggStats") or {}).get("updateRate", 0) - 0.3)
            )
            best_v = best_point["overrides"][knob]
            best_ur = (best_point.get("aggStats") or {}).get("updateRate")
            best_mrr = best_point["metrics"]["mrr"]
            ur_str = f"{best_ur:.4f}" if best_ur is not None else "n/a"
            recommendation = (
                f"**Recommendation:** {knob} = {best_v}\n\n"
                f"Rationale: updateRate = {ur_str} falls closest to target band [0.2, 0.4] "
                f"(Phase 6 retro band rule); round MRR = {best_mrr:.4f}."
            )

        round_sections.append(
            f"### Round {r['name']}\n\n**Swept knob:** `{knob}`\n\n"
            f"{header}\n{separator}\n{rows_joined}\n\n{recommendation}"
        )

    rounds_joined = "\n\n".join(round_sections)

    report = f"""# Consolidation sweep — {today}

**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items
**Primary metric:** mrr (retrieval) + updateRate (consolidation-internal band rule)
**Rounds:** {len(rounds)} independent single-axis sweeps

{rounds_joined}

## Notes

- Branch C is pre-registered per 9.4.6 consolidation retro finding: rule-based
  seeder may under-stress dedup/consolidation machinery. Rounds with MRR range
  <0.005 defer tuning to 9.5 live extraction.
- BATCH_SIZE round is new in 9.4.9 per 9.4.7 finding that single idle
  consolidation call drains only BATCH_SIZE entries; larger residuals need
  while-loop drain.
"""
    return report
```

**Step 2: Commit.**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): Python render_consolidation_report with band rule + Branch C

Ports bench/sweeps/consolidation.js:142-240 plus 9.4.9 extensions.
Per-round table includes aggStats (added/updated/drained/updateRate/
dedupHitRate). Recommendation follows Phase 6 retro band rule
(updateRate ∈ [0.2, 0.4], closest to 0.3). Branch C fires on flat
surfaces (MRR range <0.005) and defers tuning to 9.5 live extraction
per the pre-registered 9.4.6 finding."
```

---

## Task 7: Full graph sweep via Modal + interpret + amend

**Objective:** Run the full 6-round graph sweep on Modal, interpret results against the ΔMRR ≥ 0.02 amendment threshold, land constant amendments + baseline.json refresh for any winning knob.

**Files (conditional on results):**
- Modify: `src/core/constants.js` (per-knob amendment)
- Modify: `docs/specs/2026-04-20-starmem-v2-design.md` §5.1 (per-knob tuning note)
- Modify: `docs/bench/baseline.json` (tuned section updates)
- Modify: `tests/unit/core/constants.test.js` (per-knob assertion if default changed)

**Step 1: Baseline reference point.**

Before running the sweep, capture the TIER2_TAU_GAP=10-alone MRR as the comparison baseline. This is already in `docs/bench/baseline.json` (ladder gap=10 MRR ~0.8077 from 9.4.8 validation sweep cb30323). Graph amendments are ΔMRR relative to this, NOT to spec defaults, because the gap=10 baseOverride already delivers +0.0625.

**Step 2: Synthetic smoke (if not already done in Task 2 Step 4).**

If Task 2's synthetic smoke didn't run (e.g., Task 2 committed but Eva hadn't yet invoked Modal), run it first. Otherwise skip to Step 3.

**STOP.** Hand off to Eva:

> Ready for Eva to run `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name graph --synthetic --local-out docs/bench/runs` (if not already run).

**Step 3: Full graph sweep via Modal.**

**STOP.** Hand off to Eva:

> Ready for Eva to run `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name graph --local-out docs/bench/runs` in the repo root.
>
> Expected: ~8 min wall-clock (6 sequential rounds × 32-container waves, each ~60-90s). Prints full graph report to stdout; mirrors to `docs/bench/runs/<ts>-graph.{md,json}`. Copies also land on Modal Volume at `/data/runs/<ts>-graph/`.
>
> Watch for any round where the winner's MRR is materially above the gap=10 baseline (~0.8077). Round winners at 0.81-0.83 MRR are interesting; ≥0.83 is strongly worth amending.

Controller passes Eva's output back to the subagent.

**Step 4: Interpret and classify.**

For each round, compute `round_winner_mrr - 0.8077` (gap=10 baseline). Three outcomes per round:

- **ΔMRR ≥ 0.02:** meaningful lift. Amend constant. Round winner becomes the new default.
- **0.005 ≤ ΔMRR < 0.02:** borderline signal. Document in retro; DO NOT amend (noise floor on LoCoMo is ~0.005 per 9.4.6). Flag for re-measurement in sub-phase 9.5 (live extraction may change the picture).
- **ΔMRR < 0.005:** flat / noise. Keep spec default. Document in retro.

Cross-check against the composite elbow: if no individual round clears 0.02 but the composite (all winners stacked) does, that's a separate Phase 11 finding (suggests the knobs are mutually reinforcing).

**Step 5: Land amendments (per-knob commits).**

For each round that cleared 0.02, land a separate commit following the 9.4.8 TIER2_TAU_GAP amendment pattern:

```bash
# Example for TIER3_BEAM_WIDTH amendment (placeholder values — replace with measured).
# 1. Edit src/core/constants.js:84 — bump the default.
# 2. Update the comment with the 9.4.9 amendment note.
# 3. Update tests/unit/core/constants.test.js:73 assertion.
# 4. Update docs/specs/2026-04-20-starmem-v2-design.md §5.1 with a per-knob
#    "tuning amendment (9.4.9, 2026-04-22)" callout.
# 5. Update docs/bench/baseline.json::tuned.<KNOB> with measured value
#    and source-sweep reference.

git add src/core/constants.js tests/unit/core/constants.test.js \\
        docs/specs/2026-04-20-starmem-v2-design.md docs/bench/baseline.json
git commit -m "feat(retrieval): amend TIER3_BEAM_WIDTH default X → Y per 9.4.9 sweep

9.4.9 graph sweep round 'beam' measured MRR Z at BEAM_WIDTH=Y vs
0.8077 at spec default 5 (TIER2_TAU_GAP=10 baseline). ΔMRR = +0.XXX
clears the 0.02 amendment threshold.

Rationale: with TIER2_TAU_GAP=10 making Tier 3 the hot path, beam
width affects how many graph neighbors each seed expands against.
Post-9.4.8 Tier 3 contributions (+0.0794 MRR) justify exploring
wider beams.

Full sweep: docs/bench/sweeps/2026-04-22-graph.md (date per actual
Eva run)."
```

**Step 6: Commit the sweep artifact itself.**

After amendments (or if none, after analysis):

```bash
# The --local-out dir has the .md + .json; copy the .md to canonical
# sweep location.
cp docs/bench/runs/<ts>-graph.md docs/bench/sweeps/$(date +%Y-%m-%d)-graph.md
git add docs/bench/sweeps/$(date +%Y-%m-%d)-graph.md
git commit -m "docs(bench): 9.4.9 graph sweep results

6-round coordinate descent against TIER2_TAU_GAP=10 baseline.
[Summary of winners and amendments, or 'no amendments cleared 0.02
threshold' if flat.]"
```

**Step 7: Full test suite green.**

```bash
npm test
```

**Expected:** If any constant changed, the per-knob assertion update must accompany it. Suite should be 75 / 814+ green.

---

## Task 8: Full consolidation sweep via Modal + interpret + amend

**Objective:** Run the 2-round consolidation sweep on Modal. Interpret against Branch C pre-registration (MRR range < 0.005 → defer to 9.5). Amend if any round clears 0.02 MRR lift.

**Files (conditional):**
- Modify: `src/core/constants.js` (BATCH_SIZE or DEDUP_JACCARD_THRESHOLD default)
- Modify: `docs/specs/2026-04-20-starmem-v2-design.md` §6 (per-knob tuning note)
- Modify: `docs/bench/baseline.json` (tuned section)

**Step 1: Synthetic smoke (if not done in Task 3 Step 4).**

**STOP** for Modal if needed.

**Step 2: Full consolidation sweep via Modal.**

**STOP.** Hand off to Eva:

> Ready for Eva to run `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name consolidation --local-out docs/bench/runs` in the repo root.
>
> Expected: ~90s wall-clock (2 rounds × single 32-container wave each). Full Markdown report with per-threshold / per-batch-size tables, aggStats counters, updateRate band-rule recommendation. Mirrors to `docs/bench/runs/<ts>-consolidation.{md,json}`.

**Step 3: Interpret per pre-registered branches.**

For each round:

- **If MRR range <0.005 across all points:** Branch C fires. No amendment. Document in retro as "deferred to 9.5 live-extraction." Note that 9.4.6's dedup-threshold round also fired Branch C; if 9.4.9 reproduces, that's confirmation the rule-based seeder under-stresses the mechanism consistently across sub-phases.
- **If MRR range ≥0.005 but best-point Δ<0.02 vs spec default:** borderline. Document; no amendment. Re-measure in 9.5.
- **If best-point ΔMRR ≥0.02 vs spec default:** amend per Task 7 Step 5 pattern. Note: for DEDUP_JACCARD_THRESHOLD, the band rule also wants updateRate ∈ [0.2, 0.4]. Prefer the point closest to updateRate=0.3 that clears the 0.02 MRR threshold; if no such point exists, the MRR-best point wins but flag the band violation in retro.

**Step 4: Land amendments (if any) + commit sweep artifact.**

Pattern identical to Task 7 Steps 5-6.

**Step 5: Full test suite green.**

```bash
npm test
```

---

## Task 9: Retro

**Objective:** Close 9.4.9 with a retro at `docs/plans/phase-9-4-9-retro.md` following the 9.4.8 template. Include sweep findings, amendments landed, Branch C / flatness verdicts, and handoff notes for sub-phase 9.5 (live extraction).

**Files:**
- Create: `docs/plans/phase-9-4-9-retro.md`

**Step 1: Write retro.**

Structure per 9.4.8 template:

1. **What happened.** 2-4 paragraphs: 9.4.8 closed with Tier 3 value-add reversed (+0.0794 MRR), TIER2_TAU_GAP=10 amended. 9.4.9 runs the deferred graph and consolidation sweeps against the post-9.4.8 surface. Document the preflight source fixes (TIER3_SEEDS_K, BATCH_SIZE, destructure rewrite) and why they were necessary before sweeping.
2. **Decisions held.** Numbered list matching the 10 locked decisions from plan header; each gets "Held." or "Revised (see X)."
3. **Sweep findings summary (table).**

```markdown
| Round | Knob | Values | Winner | ΔMRR vs gap=10 | Verdict |
|---|---|---|---|---|---|
| 1 | TIER3_LAMBDA_1 | 0.5-1.5 | X | +0.YYY | AMENDED / hold / flat |
| ... |
```

4. **Constants amendments landed.** Per-knob list of commits; each names the constant, the old→new default, and the MRR lift. Empty list is fine if Branch C fired across the board.
5. **What worked.** Infrastructure reuse (9.4.8 substrate handled graph's sequential-rounds-with-parallel-fan-out cleanly without changes), preflight source fixes caught the destructure trap before sweeping.
6. **What surprised us.** Any measurement-reversal findings (like 9.4.8's Tier 3 value-add reversal), any knobs that went inert despite expectations, any interactions between rounds.
7. **Metrics.** Plan length, duration, Modal spend estimate, per-sweep wall-clock, tests added/modified, final suite count.
8. **Notes for sub-phase 9.5.** Which Branch C rounds (if any) are waiting for live extraction to produce meaningful signal. Which knobs are still at spec default and why. Any latent bugs caught during the preflight audit.
9. **Notes for Phase 11.** Tier 2 gating demolition candidacy (inherited from 9.4.8, update based on 9.4.9's TIER3 findings). Scorer chain review (if any round's MRR was suspiciously flat, that's another signal the scorer chain is not earning its keep).
10. **Commit graph.**

**Step 2: Commit.**

```bash
git add docs/plans/phase-9-4-9-retro.md
git commit -m "docs(plans): sub-phase 9.4.9 retro

Graph + consolidation sweeps on post-9.4.8 retrieval surface.
[One-line summary of amendments landed or Branch C verdicts.]
Handoff notes for sub-phase 9.5 + Phase 11 candidacy updates."
```

**Step 3: Push.**

```bash
git push
```

---

## Preflight audit summary

Ran before writing this plan (decisions 7 + 9):

- `_SWEPT_*_KEYS` audit surfaced two unregistered keys (`TIER3_SEEDS_K`, `BATCH_SIZE`) that Task 1 lands.
- Module-top destructure audit (`grep -rnE "^const \\{[^}]*\\} = (RETRIEVAL|CONSOLIDATION)\\b" src/`) surfaced one violator (`consolidate.js:47`) that Task 1 rewrites. Other hits (`triggers.js:25`, `bm25.js:13`, `tier1-fuzzy.js:13`) destructure non-swept keys (`WORKING_BUFFER_THRESHOLD`, `IDLE_TRIGGER_SECONDS`, `BM25_*`, `FUZZY_JACCARD_THRESHOLD`) — none are swept in 9.4.9, so no rewrite needed.
- Constants test assertions for defaults touched by 9.4.9 amendments get updated in the same commit as the constant (9.4.8 precedent).

## Scope / anti-scope

**In scope:**
- Graph coordinate descent (6 rounds; adds TIER3_SEEDS_K).
- Consolidation sweep (DEDUP_JACCARD_THRESHOLD + BATCH_SIZE).
- Preflight source fixes (swept-keys, destructure rewrite, guard tests).
- Python renderers for both sweeps.
- aggStats plumbing through `run_point`.
- Per-knob constant amendments (conditional on ΔMRR ≥0.02).
- Per-knob spec §5/§6 tuning-note callouts.
- Baseline.json `tuned` section refresh.
- Retro at `docs/plans/phase-9-4-9-retro.md`.

**Out of scope:**
- Tier 2 gating demolition (Phase 11).
- Live LLM extraction on Modal (9.5).
- WORKING_BUFFER_THRESHOLD sweep (decision 3 — kept out unless consolidation round signals otherwise).
- EXPLICIT_RELATION_WEIGHT sweep (not in GRAPH_ROUNDS — currently pinned at 1.0, no evidence it needs tuning).
- Any scorer-chain changes (see 9.4.7 finding that multiplicative chain dynamic range is 1.00× vs BM25's 7.06×; handling in Phase 11).
- Synthetic corpus sweeps beyond smoke — every real sweep runs on full LoCoMo-10.
- Regression-gating the baseline on 9.4.9 amendments (Phase 9 spec says advisory-only through v2.0).

## Risks + mitigations

1. **Preflight source fixes break existing tests.** Mitigation: Task 1 TDD's the new coverage first and runs the full suite before committing.
2. **Graph round winners are noisy across repeat runs.** Only 4-5 values per knob; if the same sweep re-run picks different winners because MRR differences are <0.005, the amendment is on noise. Mitigation: ΔMRR ≥0.02 threshold is ~4× the noise floor; genuine signal clears it.
3. **TIER2_TAU_GAP=10 baseOverride breaks graph runs if a subagent forgets to include it.** Mitigation: `GRAPH_BASE_OVERRIDES` is centralized and applied in `run_graph_sweep` automatically; subagents don't set it per-round.
4. **Python renderer divergence from JS output.** 9.4.8 set the parity bar (byte-identical to 4 decimals). 9.4.9 renderers are NEW (graph/consolidation JS renderers weren't ported during 9.4.8). No strict parity target — aim for the 9.4.8 tau/bm25 style consistency.
5. **Session drop during sweep execution.** Mitigation: 9.4.8's persistence fix (`f5baae5`) writes result.json + report.md to Volume + `--local-out` mirror before returning. No reconstruction path needed.

## Wall-clock budget

- Task 1 (preflight): ~20 min controller + ~15 min subagent
- Tasks 2-3 (Modal configs): ~15 min subagent each
- Task 4 (aggStats): ~20 min subagent
- Tasks 5-6 (renderers): ~30 min subagent each
- Task 7 (graph sweep): ~8 min Modal + ~20 min interpret/amend
- Task 8 (consolidation sweep): ~90s Modal + ~15 min interpret/amend
- Task 9 (retro): ~30 min controller

**Total:** ~3 hours of subagent + controller work, ~10 min of Modal wall-clock, ~30 min of Eva wait-time across Modal handoffs.

**Day-budget hard stop:** 4 hours controller time. If any task blows past 45 min, escalate to Phase 11 scoping conversation.

---

**Ready for execution.** 9 tasks, ~3h controller budget, clear decision gates at each step.
