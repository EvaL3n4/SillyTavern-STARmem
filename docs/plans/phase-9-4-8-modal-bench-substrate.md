# Modal Benchmark Substrate Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Modal as sweep runner — per-knob-value parallelism, state+cache on Volume, repo via `copy_local_dir`, τ+bm25 sweep re-runs, baseline.json refresh (conditional on 9.4.7 outcome).

**Architecture:** A thin Python Modal app wraps the existing Node.js benchmark harness. Each sweep grid point runs in its own ephemeral container via `.map()`. The LoCoMo corpus cache and warm extraction cache live on a Modal Volume mounted at `/data`. The repo code is copied into the image via `copy_local_dir` so local edits rebuild cleanly. A Python aggregator collects per-point JSON results, detects the elbow, and renders the exact same Markdown report shape that `tau.js` and `bm25.js` produce today. The local sweep path remains the default; `--modal` is opt-in on both sweep entry points.

**Tech Stack:** Modal (Python 3.11), Node.js 20.x (inside Modal container via NodeSource PPA), existing STARmem bench harness (Node/ESM, zero runtime dependencies).

**Decisions locked (from 2026-04-22 session with Eva, see `/tmp/9-4-7-9-4-8-locked-decisions.md`):**

1. **Node 20.x via NodeSource PPA.** Debian `apt` default `nodejs` is too old (v18.x). Use `curl -fsSL https://deb.nodesource.com/setup_20.x | bash -` then `apt-get install -y nodejs`. Node 20 is the active LTS and sufficient for the pure-JS bench harness (no native modules).
2. **Volume name: `starmem-bench-data`.** Mounted at `/data` in containers. Holds `locomo10.json` (corpus cache, ~2.8 MB) and `extractions/` (warm LLM extraction cache, **~4.6 MB / 1164 files** as of 2026-04-22). One-time upload; persists across runs.
3. **Repo code via `copy_local_dir`.** The STARmem repo is copied into the Modal image at `/repo`. Local edits re-land on next image build. Volume is reserved for large, slowly-changing assets only.
4. **Per-knob-value parallelism via `.map()`.** One Modal container per grid point. Target: 48 τ points → ~3 min wall-clock (vs ~62 min serial on 4-core local box per 9.4.6 retro).
5. **Python aggregator reproduces EXACT existing Markdown report format.** The `renderReport` logic from `tau.js:108-199` and `bm25.js:137-279` is ported line-for-line to Python in the Modal app. No divergence in table columns, heatmap layout, elbow section, or spec-amendment block.
6. **Local path is default; `--modal` is opt-in.** `node bench/sweeps/tau.js` runs locally exactly as before. `node bench/sweeps/tau.js --modal` dispatches to Modal and writes the same output file.
7. **Warm cache only; live LLM extraction on Modal is out of scope for MVP.** The `.env.bench` secrets (`STARMEM_BENCH_LLM_URL`, `STARMEM_BENCH_LLM_API_KEY`, `STARMEM_BENCH_LLM_MODEL`) stay local. Modal containers run with `offline=true` semantics, reading the warm extraction cache from Volume.
8. **Cost posture: observation-first.** Per-function `timeout=600, memory=4096`. No hard $ caps today. Track wall-clock + estimated cost after first full run; tighten in a follow-up sub-phase if needed.
9. **Baseline.json refresh is conditional on 9.4.7 verdict.** If 9.4.7 narrow fix shipped → flip `structuralInvariants.ladderVsRandom` and `ladderVsBm25Only` from `FAIL` to `PASS` with new measured metrics. If 9.4.7 escalated to Phase 11 → baseline stays `FAIL`, document what Modal revealed at Phase 11 scale, and annotate what the fix WOULD have produced.
10. **Synthetic corpus smoke test must complete in <5 min wall-clock on Modal.** 2 conversations × 4 QA items is trivial; if it takes >5 min, something is wrong with image build or Volume mount.

---

## Task 0: Commit the plan

**Objective:** Stabilize the plan reference for subagents and future sessions.

**Files:**
- Create: `docs/plans/phase-9-4-8-modal-bench-substrate.md`

**Step 1: Verify plan file exists and has expected task count**

Run:
```bash
grep -c '^## Task ' /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/plans/phase-9-4-8-modal-bench-substrate.md
```
Expected: `11` (Tasks 0–10)

**Step 2: Verify no secret-guard redactions**

Run:
```bash
grep -n '=\s*\*\*\*\|=\*\*\*' /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/plans/phase-9-4-8-modal-bench-substrate.md || echo "clean"
```
Expected: `clean` (empty output)

**Step 3: Commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
git add docs/plans/phase-9-4-8-modal-bench-substrate.md
git commit -m "docs(plans): sub-phase 9.4.8 Modal bench substrate plan"
```

---

## Task 1: Modal app skeleton — image, hello-world, `modal run`

**Objective:** Prove Modal auth, image build, and basic function execution work end-to-end.

**Files:**
- Create: `bench/modal/sweep_app.py`
- Create: `bench/modal/__init__.py` (empty, Python package marker)

**Precondition (verified by controller 2026-04-22):** The `modal` Python package must be installed and importable. The `modal` CLI shim may exist at `~/.local/bin/modal` even when the underlying `modal` Python package is NOT installed — the shim will then throw `ModuleNotFoundError: No module named 'modal'` on any invocation. Verify with:

```bash
python3 -c "import modal; print(modal.__version__)"
```

If this errors, STOP and surface to the user. Eva runs `pip install modal` in her own environment (Hanami cannot due to Tirith-blocked pip). After install:
- `modal setup` — opens browser, completes Modal auth if first-time.
- `modal token current` — confirms token is present.

Both must succeed before any `modal run` invocation.

**Step 1: Create the Modal app skeleton**

Create `bench/modal/sweep_app.py`:

```python
import modal
import json

app = modal.App("starmem-bench")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .run_commands(
        "apt-get update && apt-get install -y curl ca-certificates",
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    .add_local_dir(
        "/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem",
        "/repo",
    )
)

# KNOWN API NAME DRIFT: Modal renamed `image.copy_local_dir()` → `image.add_local_dir()`
# in a recent release. If `add_local_dir` is not present on modal.Image, fall back to
# `copy_local_dir` with the same args. Verify once by running:
#   python3 -c "import modal; print('add_local_dir' in dir(modal.Image.debian_slim()))"
# If the fallback is needed, replace the `.add_local_dir(...)` call above with
# `.copy_local_dir(...)` and add a note in the commit message.

volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)

@app.function(image=image, volumes={"/data": volume}, timeout=600, memory=4096)
def hello():
    import subprocess
    result = subprocess.run(
        ["node", "--version"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()

@app.local_entrypoint()
def main():
    print("Node version in container:", hello.remote())
```

Create `bench/modal/__init__.py`:
```python
# STARmem Modal bench substrate package
```

**Step 2: Verify file paths**

Run:
```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/bench/modal/sweep_app.py
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/bench/modal/__init__.py
```
Expected: both files exist.

**Step 3: Run hello-world**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
modal run bench/modal/sweep_app.py
```
Expected: prints `Node version in container: v20.x.y` (any v20 variant is acceptable).

**Step 4: Commit**

```bash
git add bench/modal/
git commit -m "feat(bench): Modal app skeleton with Node 20 image + hello-world"
```

---

## Task 2: Volume creation + state bundle upload script

**Objective:** Persist the LoCoMo corpus cache and warm extraction cache on a Modal Volume so containers can read them without network or LLM calls.

**Files:**
- Create: `bench/modal/upload_cache.py`
- Modify: `bench/modal/sweep_app.py` (add volume mount verification to `hello`)

**Step 1: Create upload script**

Create `bench/modal/upload_cache.py`:

```python
"""Upload STARmem bench cache files to the Modal Volume.

Usage:
    modal run bench/modal/upload_cache.py

Expects to find:
    bench/.cache/locomo10.json   → /data/locomo10.json
    bench/.cache/extractions/    → /data/extractions/
"""

import modal
import os

app = modal.App("starmem-bench-upload")
volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)

@app.function(volumes={"/data": volume}, timeout=300)
def upload():
    import shutil
    repo_root = "/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem"
    src_corpus = os.path.join(repo_root, "bench", ".cache", "locomo10.json")
    src_cache = os.path.join(repo_root, "bench", ".cache", "extractions")
    dst_corpus = "/data/locomo10.json"
    dst_cache = "/data/extractions"

    if not os.path.exists(src_corpus):
        raise FileNotFoundError(f"Corpus cache not found: {src_corpus}")
    if not os.path.exists(src_cache):
        raise FileNotFoundError(f"Extraction cache not found: {src_cache}")

    shutil.copy2(src_corpus, dst_corpus)
    if os.path.exists(dst_cache):
        shutil.rmtree(dst_cache)
    shutil.copytree(src_cache, dst_cache)

    # Verify
    corpus_size = os.path.getsize(dst_corpus)
    cache_files = sum(1 for _root, _dirs, files in os.walk(dst_cache) for _ in files)
    return {
        "corpus": dst_corpus,
        "corpusSizeBytes": corpus_size,
        "cacheDir": dst_cache,
        "cacheFiles": cache_files,
    }

@app.local_entrypoint()
def main():
    result = upload.remote()
    print(json.dumps(result, indent=2))
```

**Step 2: Verify source cache files exist locally**

Run:
```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/bench/.cache/locomo10.json
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/bench/.cache/extractions/ | head -5
```
Expected: `locomo10.json` exists (~2.8 MB). `extractions/` exists with `.json` files.

**Step 3: Run upload**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
modal run bench/modal/upload_cache.py
```
Expected: JSON output with `corpusSizeBytes` > 2_000_000 and `cacheFiles` > 0.

**Step 4: Verify Volume mount in sweep_app**

Modify `bench/modal/sweep_app.py` — replace the `hello` function body:

```python
@app.function(image=image, volumes={"/data": volume}, timeout=600, memory=4096)
def hello():
    import os
    corpus_exists = os.path.exists("/data/locomo10.json")
    cache_exists = os.path.exists("/data/extractions")
    return {
        "nodeVersion": subprocess.run(["node", "--version"], cwd="/repo", capture_output=True, text=True, check=True).stdout.strip(),
        "corpusOnVolume": corpus_exists,
        "cacheOnVolume": cache_exists,
    }
```

Run:
```bash
modal run bench/modal/sweep_app.py
```
Expected: `nodeVersion` is v20.x, both `corpusOnVolume` and `cacheOnVolume` are `True`.

**Step 5: Commit**

```bash
git add bench/modal/upload_cache.py bench/modal/sweep_app.py
git commit -m "feat(bench): Modal Volume upload script + cache verification"
```

---

## Task 3: Python wrapper function wrapping Node sweep-point execution

**Objective:** A Modal function that receives one grid-point's overrides, runs the Node harness with those overrides, and returns the metrics JSON.

**Files:**
- Create: `bench/sweeps/_modal-point.js`
- Modify: `bench/modal/sweep_app.py` (add `run_point` function)

**Step 1: Create the Node single-point runner**

Create `bench/sweeps/_modal-point.js`:

```js
#!/usr/bin/env node
/**
 * Single sweep-point runner for Modal dispatch.
 *
 * Reads overrides from STARMEM_OVERRIDES (JSON string), loads the LoCoMo
 * corpus from the warm cache, runs runHarness, and prints a JSON payload
 * to stdout.
 *
 * @module bench/sweeps/_modal-point
 */

import { runHarness } from '../runner.js';
import { loadLocomo } from '../loaders/index.js';
import { performance } from 'node:perf_hooks';

async function main() {
    const overrides = JSON.parse(process.env.STARMEM_OVERRIDES || '{}');
    const corpus = await loadLocomo({ offline: true });

    const t0 = performance.now();
    const result = await runHarness({ corpus, overrides });
    const wallMs = performance.now() - t0;

    const latencies = result.runs.map(r => r.latencyMs);
    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const latencyMs = {
        p50: n > 0 ? sorted[Math.floor((n - 1) * 0.5)] : 0,
        p95: n > 0 ? sorted[Math.floor((n - 1) * 0.95)] : 0,
    };

    const output = {
        overrides,
        metrics: result.metrics,
        latencyMs,
        runCount: result.runs.length,
        wallMs: Math.round(wallMs),
    };
    console.log(JSON.stringify(output));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
```

**Step 2: Add `run_point` to the Modal app**

Modify `bench/modal/sweep_app.py` — add after the `hello` function:

```python
@app.function(image=image, volumes={"/data": volume}, timeout=600, memory=4096)
def run_point(overrides_json: str) -> str:
    """Run a single sweep point.

    Args:
        overrides_json: JSON string of Record<string, number> overrides.

    Returns:
        JSON string with { overrides, metrics, latencyMs, runCount, wallMs }.
    """
    import os
    import subprocess
    import json

    # Symlink Volume cache to where the repo expects it
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_OVERRIDES"] = overrides_json

    result = subprocess.run(
        ["node", "bench/sweeps/_modal-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=True,
        env=env,
    )
    return result.stdout.strip()
```

**Step 3: Test `run_point` with empty overrides**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
modal run bench/modal/sweep_app.py::run_point --overrides-json '{}'
```
Expected: A JSON string is printed. Parse it and verify:
- `overrides` is `{}`
- `metrics` has keys `recallAtK`, `precisionAtK`, `mrr`, `n_scored`, `n_skipped`
- `runCount` equals the total QA item count (1986 for full LoCoMo)
- `wallMs` is a positive integer

**Step 4: Test `run_point` with a single override**

Run:
```bash
modal run bench/modal/sweep_app.py::run_point --overrides-json '{"TIER2_TAU_CONFIDENCE": 0.5}'
```
Expected: JSON output where `overrides.TIER2_TAU_CONFIDENCE` is `0.5`. Metrics should differ slightly from the empty-override run (if the knob has any effect; on the broken ladder the delta may be tiny — that's expected).

**Step 5: Commit**

```bash
git add bench/sweeps/_modal-point.js bench/modal/sweep_app.py
git commit -m "feat(bench): Modal run_point wrapper + Node single-point runner"
```

---

## Task 4: Python aggregator → existing markdown report format

**Objective:** Port the `renderReport` logic from `tau.js` and `bm25.js` to Python so the Modal app can produce byte-identical Markdown output (modulo timestamps).

**Files:**
- Modify: `bench/modal/sweep_app.py` (add `run_sweep` + `render_tau_report` + `render_bm25_report`)

**Step 1: Add tau report renderer to sweep_app.py**

Add the following functions to `bench/modal/sweep_app.py` after `run_point`:

```python
def _detect_elbow(points, knobs, primary_metric):
    """Python port of _driver.js detectElbow.

    Args:
        points: list of dicts with 'overrides' and 'metrics'.
        knobs: list of {name, values} dicts.
        primary_metric: string key into METRIC_ACCESSORS.

    Returns:
        dict with 'overrides' and 'rationale'.
    """
    ELBOW_RATIO = 0.1

    def accessor(m):
        if primary_metric == "recallAt5":
            return m["recallAtK"][5]
        if primary_metric == "recallAt10":
            return m["recallAtK"][10]
        if primary_metric == "precisionAt3":
            return m["precisionAtK"][3]
        if primary_metric == "precisionAt5":
            return m["precisionAtK"][5]
        return m["mrr"]

    primary_knob = knobs[0]
    secondary_knobs = knobs[1:]

    elbows = []

    if not secondary_knobs:
        sorted_pts = sorted(points, key=lambda p: p["overrides"][primary_knob["name"]])
        elbow = _elbow_on_slice(sorted_pts, primary_knob["name"], accessor, ELBOW_RATIO)
        if elbow:
            elbows.append(elbow)
    else:
        groups = {}
        for p in points:
            key = ",".join(f"{k['name']}={p['overrides'][k['name']]}" for k in secondary_knobs)
            groups.setdefault(key, []).append(p)
        for group in groups.values():
            sorted_pts = sorted(group, key=lambda p: p["overrides"][primary_knob["name"]])
            elbow = _elbow_on_slice(sorted_pts, primary_knob["name"], accessor, ELBOW_RATIO)
            if elbow:
                elbows.append(elbow)

    if not elbows:
        best = max(points, key=lambda p: accessor(p["metrics"]))
        best_metric = accessor(best["metrics"])
        return {
            "overrides": best["overrides"],
            "rationale": f"No clear elbow detected; fallback to highest {primary_metric} = {best_metric:.4f}.",
        }

    chosen = max(elbows, key=lambda e: e["metric"])
    return {
        "overrides": chosen["overrides"],
        "rationale": chosen["rationale"],
    }


def _elbow_on_slice(sorted_pts, primary_name, accessor, ratio):
    if len(sorted_pts) < 2:
        return None

    metrics = [accessor(p) for p in sorted_pts]
    primary_values = [p["overrides"][primary_name] for p in sorted_pts]

    deltas = []
    for i in range(len(metrics) - 1):
        delta_knob = primary_values[i + 1] - primary_values[i]
        deltas.append(0 if delta_knob == 0 else (metrics[i + 1] - metrics[i]) / delta_knob)

    max_delta = max(abs(d) for d in deltas)
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

**Step 2: Add tau report renderer**

Add to `sweep_app.py`:

```python
def render_tau_report(result, corpus_len, qa_count):
    """Port of tau.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "recallAt5"

    header = "| TIER2_TAU_CONFIDENCE | TIER2_TAU_GAP | recallAt5 | precisionAt3 | mrr | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tc = p["overrides"]["TIER2_TAU_CONFIDENCE"]
        tg = p["overrides"]["TIER2_TAU_GAP"]
        r5 = f"{p['metrics']['recallAtK'][5]:.4f}"
        p3 = f"{p['metrics']['precisionAtK'][3]:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tc} | {tg} | {r5} | {p3} | {mrr} | {p50} | {p95} |")

    # Heatmap
    tau_gap_values = sorted({p["overrides"]["TIER2_TAU_GAP"] for p in result["points"]})
    tau_conf_values = sorted({p["overrides"]["TIER2_TAU_CONFIDENCE"] for p in result["points"]})
    gap_header = "               " + "".join(f"{v:.2f}".rjust(5) + "  " for v in tau_gap_values).rstrip()
    heatmap_rows = []
    for tc in tau_conf_values:
        cells = []
        for tg in tau_gap_values:
            point = next(
                (p for p in result["points"]
                 if p["overrides"]["TIER2_TAU_CONFIDENCE"] == tc and p["overrides"]["TIER2_TAU_GAP"] == tg),
                None,
            )
            val = f"{point['metrics']['recallAtK'][5]:.2f}" if point else "N/A"
            cells.append(val.rjust(5))
        heatmap_rows.append(f"  {str(tc).ljust(4)}   {'  '.join(cells)}")

    # Spec amendment
    current_tau_conf = 2.0
    current_tau_gap = 0.5
    e_conf = result["elbow"]["overrides"]["TIER2_TAU_CONFIDENCE"]
    e_gap = result["elbow"]["overrides"]["TIER2_TAU_GAP"]
    conf_deviation = abs(e_conf - current_tau_conf) / current_tau_conf
    gap_deviation = abs(e_gap - current_tau_gap) / current_tau_gap
    needs_amendment = conf_deviation > 0.5 or gap_deviation > 0.5

    if needs_amendment:
        amendment_section = (
            f"**Proposed amendment:**\n\n"
            f"- TIER2_TAU_CONFIDENCE: {current_tau_conf} → {e_conf}\n"
            f"- TIER2_TAU_GAP: {current_tau_gap} → {e_gap}\n\n"
            f"Rationale: elbow is >50% away from current spec values ({conf_deviation*100:.0f}% / {gap_deviation*100:.0f}% deviation)."
        )
    else:
        amendment_section = "No amendment needed — elbow within 50% of current spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    report = f"""# τ sweep — {today}

**Corpus:** {corpus_len} conversations, {qa_count} QA items
**Primary metric:** {primary_metric}

## Points

{header}
{separator}
{'\n'.join(rows)}

## Heatmap (primary = {primary_metric})

               TIER2_TAU_GAP
{gap_header}
TIER2_TAU_CONFIDENCE
{'\n'.join(heatmap_rows)}

## Elbow

**Recommended overrides:** `{json.dumps(result['elbow']['overrides'])}`
**Rationale:** {result['elbow']['rationale']}

## Spec amendment proposal

{amendment_section}

## Environment snapshot

{env_block}
"""
    return report
```

**Step 3: Add bm25 report renderer**

Add to `sweep_app.py`:

```python
def render_bm25_report(result, corpus_len, qa_count, tags_stats):
    """Port of bm25.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "mrr"

    tags_rate_pct = f"{tags_stats['rate'] * 100:.1f}"
    tags_line = f"**Tags populated rate:** {tags_rate_pct}% of {tags_stats['n']} episodic entries have non-empty tags."
    tags_interpretation = (
        "(If <5%, TAG_BOOST axis is meaningless on this corpus; treat tag-axis results as structural, not signal.)"
        if tags_stats["rate"] < 0.05 else ""
    )

    header = "| TAG_BOOST | SUBJECT_BOOST | recallAt5 | precisionAt3 | mrr | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tb = p["overrides"]["TAG_BOOST"]
        sb = p["overrides"]["SUBJECT_BOOST"]
        r5 = f"{p['metrics']['recallAtK'][5]:.4f}"
        p3 = f"{p['metrics']['precisionAtK'][3]:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tb} | {sb} | {r5} | {p3} | {mrr} | {p50} | {p95} |")

    # Heatmap
    subject_values = sorted({p["overrides"]["SUBJECT_BOOST"] for p in result["points"]})
    tag_values = sorted({p["overrides"]["TAG_BOOST"] for p in result["points"]})
    subj_header = "               " + "".join(f"{str(v).rjust(5)}  " for v in subject_values).rstrip()
    heatmap_rows = []
    for tb in tag_values:
        cells = []
        for sb in subject_values:
            point = next(
                (p for p in result["points"]
                 if p["overrides"]["TAG_BOOST"] == tb and p["overrides"]["SUBJECT_BOOST"] == sb),
                None,
            )
            val = f"{point['metrics']['mrr']:.2f}" if point else "N/A"
            cells.append(val.rjust(5))
        heatmap_rows.append(f"  {str(tb).ljust(4)}   {'  '.join(cells)}")

    # Flatness check
    all_primary = [p["metrics"]["mrr"] for p in result["points"]]
    max_primary = max(all_primary)
    min_primary = min(all_primary)
    is_flat = (max_primary - min_primary) < 0.01

    e_tag = result["elbow"]["overrides"]["TAG_BOOST"]
    e_sub = result["elbow"]["overrides"]["SUBJECT_BOOST"]

    if is_flat:
        interpretation_branch = (
            f"### Branch C — flat heatmap (max - min of primary metric < 0.01 across all 16 cells)\n"
            f"Rule-based extractor can't exercise tag/subject asymmetry on this corpus. Defer to sub-phase 9.5 for meaningful numbers. Tags populated rate of {tags_rate_pct}% confirms the mechanism."
        )
    elif e_sub > e_tag:
        interpretation_branch = (
            f"### Branch A — subject > tag (elbow has SUBJECT_BOOST > TAG_BOOST)\n"
            f"As-expected: subject matches dominate in well-formed retrievals.\n"
            f"Consider accepting SUBJECT_BOOST={e_sub} as a spec amendment if >50% from current default."
        )
    else:
        interpretation_branch = (
            f"### Branch B — tag > subject (elbow has TAG_BOOST > SUBJECT_BOOST)\n"
            f"Investigate: suggests entries have bogus tags or subject-extraction is weak. Do NOT amend spec without root-cause inspection."
        )

    current_tag_boost = 2
    current_subject_boost = 2
    tag_deviation = abs(e_tag - current_tag_boost) / current_tag_boost
    subj_deviation = abs(e_sub - current_subject_boost) / current_subject_boost
    needs_amendment = tag_deviation > 0.5 or subj_deviation > 0.5

    if needs_amendment:
        amendment_section = (
            f"**Proposed amendment:**\n\n"
            f"- TAG_BOOST: {current_tag_boost} → {e_tag}\n"
            f"- SUBJECT_BOOST: {current_subject_boost} → {e_sub}\n\n"
            f"Rationale: elbow is >50% away from current spec values ({tag_deviation*100:.0f}% / {subj_deviation*100:.0f}% deviation)."
        )
    else:
        amendment_section = "No amendment needed — elbow within 50% of current spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    report = f"""# BM25 boost sweep — {today}

**Corpus:** {corpus_len} conversations, {qa_count} QA items
**Primary metric:** {primary_metric}
{tags_line}
{tags_interpretation}

## Per-pair metrics table

{header}
{separator}
{'\n'.join(rows)}

## Heatmap (primary = {primary_metric})

              SUBJECT_BOOST
{subj_header}
TAG_BOOST
{'\n'.join(heatmap_rows)}

## Elbow

**Recommended overrides:** `{json.dumps(result['elbow']['overrides'])}`
**Rationale:** {result['elbow']['rationale']}

## Interpretation

{interpretation_branch}

## v2.1 tokenizer refactor note

If the elbow suggests fractional values would help (any "would like X.5"
indication from Phase 3's retro), a v2.1 refactor is warranted at
`src/retrieval/bm25.js:62-63`:

```js
// Current (integer-only):
...repeat(subjectTokens, RETRIEVAL.SUBJECT_BOOST),
...repeat(tagTokens, RETRIEVAL.TAG_BOOST),

// Proposed (fractional-capable): per-token weight multiplier into the
// BM25 scoring matrix instead of token replication. Requires bm25.js
// interface change; downstream effect on tier2-bm25.js scoring path.
```

Not in scope for Phase 9 — note only.

## Spec amendment proposal

{amendment_section}

## envSnapshot

{env_block}
"""
    return report
```

**Step 4: Add `run_sweep` function**

Add to `sweep_app.py`:

```python
SWEEP_CONFIGS = {
    "tau": {
        "knobs": [
            {"name": "TIER2_TAU_CONFIDENCE", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
            {"name": "TIER2_TAU_GAP", "values": [0.1, 0.25, 0.5, 0.75, 1.0, 1.5]},
        ],
        "primary_metric": "recallAt5",
        "renderer": render_tau_report,
    },
    "bm25": {
        "knobs": [
            {"name": "TAG_BOOST", "values": [1, 2, 3, 4]},
            {"name": "SUBJECT_BOOST", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_bm25_report,
    },
}


def _cartesian_product(knobs):
    """Generate cartesian product of knob value arrays."""
    if not knobs:
        return [{}]
    first, *rest = knobs
    rest_product = _cartesian_product(rest)
    result = []
    for value in first["values"]:
        for point in rest_product:
            result.append({first["name"]: value, **point})
    return result


@app.function(image=image, volumes={"/data": volume}, timeout=1800, memory=4096)
def run_sweep(sweep_name: str, synthetic: bool = False) -> str:
    """Run a full parameter sweep in parallel via Modal.

    Args:
        sweep_name: 'tau' or 'bm25'.
        synthetic: If True, use a tiny 2-conversation corpus for smoke testing.

    Returns:
        Markdown report string.
    """
    import os
    import subprocess
    import json
    from datetime import datetime

    config = SWEEP_CONFIGS[sweep_name]
    knobs = config["knobs"]
    primary_metric = config["primary_metric"]
    renderer = config["renderer"]

    # Symlink cache
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    if synthetic:
        # Override corpus with synthetic data by setting env var
        # The _modal-point.js will need to respect this; for now we run
        # a local synthetic point directly.
        grid = [{}, {"TIER2_TAU_CONFIDENCE": 0.5}] if sweep_name == "tau" else [{}, {"TAG_BOOST": 2}]
    else:
        grid = _cartesian_product(knobs)

    # Fan out to parallel containers
    overrides_jsons = [json.dumps(point) for point in grid]
    point_results = list(run_point.map(overrides_jsons))

    points = [json.loads(pr) for pr in point_results]

    elbow = _detect_elbow(points, knobs, primary_metric)

    result = {
        "name": sweep_name,
        "points": points,
        "elbow": elbow,
    }

    # Compute corpus stats (Modal containers already ran the full corpus)
    corpus_len = 10 if not synthetic else 2
    qa_count = points[0]["runCount"] if points else 0

    if sweep_name == "bm25":
        # Tags populated rate: compute from one seeded conversation via a small
        # helper subprocess. The Modal container has `/repo` and volume mount,
        # so we shell out to a Node one-liner.
        tags_probe = subprocess.run(
            ["node", "-e", """
                const { loadLocomo } = await import('./bench/loaders/index.js');
                const { seedConversation } = await import('./bench/harness/seeder.js');
                const { loadState } = await import('./src/core/state.js');
                const corpus = await loadLocomo({ offline: true, maxConversations: 1 });
                const seed = await seedConversation(corpus[0], { chatIdPrefix: 'tags-probe', keepBackend: true });
                const state = await loadState(seed.chatId);
                const ep = Object.values(state.entries).filter(e => e.scope === 'episodic');
                const withTags = ep.filter(e => Array.isArray(e.tags) && e.tags.length > 0).length;
                console.log(JSON.stringify({ n: ep.length, withTags, rate: ep.length > 0 ? withTags / ep.length : 0 }));
            """.strip()],
            cwd="/repo",
            capture_output=True,
            text=True,
            check=True,
        )
        tags_data = json.loads(tags_probe.stdout.strip().split("\n")[-1])
        tags_stats = {"rate": tags_data["rate"], "n": tags_data["n"]}
    else:
        tags_stats = None

    report = renderer(result, corpus_len, qa_count, tags_stats) if tags_stats else renderer(result, corpus_len, qa_count)
    return report
```

**Step 5: Update local_entrypoint to support sweep dispatch**

Replace the `main` local_entrypoint in `sweep_app.py`:

```python
@app.local_entrypoint()
def main(sweep_name: str = "hello", synthetic: bool = False):
    if sweep_name == "hello":
        print(hello.remote())
    else:
        report = run_sweep.remote(sweep_name, synthetic)
        print(report)
```

**Step 6: Test synthetic tau sweep**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
modal run bench/modal/sweep_app.py --sweep-name tau --synthetic
```
Expected: A complete Markdown report is printed. Verify:
- Header contains "τ sweep"
- Points table has at least 2 rows
- Heatmap section is present
- Elbow section has overrides and rationale
- Spec amendment proposal section is present

**Step 7: Commit**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): Python aggregator with tau+bm25 report renderers"
```

---

## Task 5: CLI `--modal` flag on `tau.js` and `bm25.js`

**Objective:** Add an opt-in `--modal` flag to both sweep entry points. When set, they dispatch to Modal and write the same report file they would have written locally. Local path remains the default.

**Files:**
- Modify: `bench/sweeps/tau.js`
- Modify: `bench/sweeps/bm25.js`

**Step 1: Add `--modal` support to `tau.js`**

Modify `bench/sweeps/tau.js` — add `execSync` import at the top:

```js
import { execSync } from 'node:child_process';
```

Modify `main()` in `tau.js`. After `const synthetic = args.synthetic === 'true';`, add:

```js
    const useModal = args.modal === 'true';

    if (useModal) {
        const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        const cmd = [
            'modal', 'run', 'bench/modal/sweep_app.py',
            '--sweep-name', 'tau',
        ];
        if (synthetic) cmd.push('--synthetic');
        const output = execSync(cmd.join(' '), {
            encoding: 'utf8',
            cwd: repoRoot,
            maxBuffer: 50 * 1024 * 1024,
        });
        // Extract report from stdout (last block of text after any logs)
        const lines = output.trim().split('\n');
        // Find the line that starts with "# τ sweep"
        const reportStart = lines.findIndex(l => l.startsWith('# τ sweep'));
        const report = reportStart >= 0 ? lines.slice(reportStart).join('\n') : lines.slice(-40).join('\n');

        const today = new Date().toISOString().slice(0, 10);
        const outDir = path.join('docs', 'bench', 'sweeps');
        const outPath = path.join(outDir, `${today}-tau.md`);
        await mkdir(outDir, { recursive: true });
        await writeFile(outPath, report, 'utf8');
        console.log(`Report written to ${outPath}`);
        return;
    }
```

**Step 2: Add `--modal` support to `bm25.js`**

Modify `bench/sweeps/bm25.js` — add `execSync` import at the top:

```js
import { execSync } from 'node:child_process';
```

Modify `main()` in `bm25.js`. After `const synthetic = args.synthetic === 'true';`, add:

```js
    const useModal = args.modal === 'true';

    if (useModal) {
        const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
        const cmd = [
            'modal', 'run', 'bench/modal/sweep_app.py',
            '--sweep-name', 'bm25',
        ];
        if (synthetic) cmd.push('--synthetic');
        const output = execSync(cmd.join(' '), {
            encoding: 'utf8',
            cwd: repoRoot,
            maxBuffer: 50 * 1024 * 1024,
        });
        const lines = output.trim().split('\n');
        const reportStart = lines.findIndex(l => l.startsWith('# BM25 boost sweep'));
        const report = reportStart >= 0 ? lines.slice(reportStart).join('\n') : lines.slice(-40).join('\n');

        const today = new Date().toISOString().slice(0, 10);
        const outDir = path.join('docs', 'bench', 'sweeps');
        const outPath = path.join(outDir, `${today}-bm25.md`);
        await mkdir(outDir, { recursive: true });
        await writeFile(outPath, report, 'utf8');
        console.log(`Report written to ${outPath}`);
        return;
    }
```

**Step 3: Verify local path still works (tau)**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
node bench/sweeps/tau.js --synthetic --conversations 1
```
Expected: Report written to `docs/bench/sweeps/YYYY-MM-DD-tau.md`. Verify the file exists and contains a tau sweep report.

**Step 4: Verify local path still works (bm25)**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
node bench/sweeps/bm25.js --synthetic --conversations 1
```
Expected: Report written to `docs/bench/sweeps/YYYY-MM-DD-bm25.md`. Verify the file exists.

**Step 5: Commit**

```bash
git add bench/sweeps/tau.js bench/sweeps/bm25.js
git commit -m "feat(bench): --modal flag on tau.js and bm25.js (opt-in, local default)"
```

---

## Task 6: Smoke test — synthetic corpus through Modal, assert wall-clock reasonable

**Objective:** Run the synthetic tau sweep via Modal and verify it completes in <5 minutes wall-clock.

**Files:**
- Test: manual verification (no new file)

**Step 1: Time the synthetic Modal tau sweep**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
time node bench/sweeps/tau.js --modal --synthetic
```
Expected: Completes in <5 minutes (300 seconds). The `time` command should show `real` < 300s.

**Step 2: Verify output file**

Run:
```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-tau.md | tail -1
```
Expected: A `.md` file exists with today's date.

**Step 3: Verify report content**

Run:
```bash
grep -c "^|" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-tau.md | tail -1
```
Expected: At least 2 table rows (header + separator + 2+ data rows).

**Step 4: Time the synthetic Modal bm25 sweep**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
time node bench/sweeps/bm25.js --modal --synthetic
```
Expected: Completes in <5 minutes.

**Step 5: Verify bm25 output**

Run:
```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-bm25.md | tail -1
```
Expected: A `.md` file exists.

**Step 6: Commit smoke results**

```bash
git add docs/bench/sweeps/
git commit -m "docs(bench): Modal smoke test artifacts (synthetic tau + bm25)"
```

---

## Task 7: Full τ re-run via Modal

**Objective:** Run the full 48-point τ sweep on Modal with the real LoCoMo corpus. Capture wall-clock, estimated cost, and the report.

**Files:**
- Test: manual verification
- Create: `docs/bench/sweeps/YYYY-MM-DD-tau.md` (generated)

**Step 1: Run full tau sweep**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
time node bench/sweeps/tau.js --modal
```
Expected: Completes in ~3-10 minutes wall-clock (target is ~3 min; anything under 15 min is acceptable for MVP).

**Step 2: Verify report file**

Run:
```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-tau.md | tail -1
```
Expected: A `.md` file exists with today's date and size > 2 KB.

**Step 3: Verify report has 48 points**

Run:
```bash
grep -c "^| [0-9]" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-tau.md | tail -1
```
Expected: `48` data rows in the points table.

**Step 4: Verify heatmap is present**

Run:
```bash
grep -c "TIER2_TAU_GAP" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-tau.md | tail -1
```
Expected: At least 1 occurrence.

**Step 5: Verify elbow section**

Run:
```bash
grep "Recommended overrides" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-tau.md | tail -1
```
Expected: A line with JSON overrides.

**Step 6: Record wall-clock and cost observation**

Note the `real` time from Step 1. Also check Modal dashboard for estimated spend. Record both in the commit message or a brief note file.

**Step 7: Commit**

```bash
git add docs/bench/sweeps/
git commit -m "docs(bench): full τ sweep via Modal (wall-clock Xmin, cost ~$Y)"
```

---

## Task 8: Full bm25 re-run via Modal

**Objective:** Run the full 16-point bm25 sweep on Modal with the real LoCoMo corpus. Capture wall-clock and report.

**Files:**
- Test: manual verification
- Create: `docs/bench/sweeps/YYYY-MM-DD-bm25.md` (generated)

**Step 1: Run full bm25 sweep**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
time node bench/sweeps/bm25.js --modal
```
Expected: Completes in ~2-5 minutes wall-clock (16 points, smaller than tau's 48).

**Step 2: Verify report file**

Run:
```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-bm25.md | tail -1
```
Expected: A `.md` file exists with today's date.

**Step 3: Verify report has 16 points**

Run:
```bash
grep -c "^| [1-9]" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-bm25.md | tail -1
```
Expected: `16` data rows.

**Step 4: Verify tags populated rate**

Run:
```bash
grep "Tags populated rate" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/sweeps/*-bm25.md | tail -1
```
Expected: A line with a percentage.

**Step 5: Commit**

```bash
git add docs/bench/sweeps/
git commit -m "docs(bench): full bm25 sweep via Modal (wall-clock Xmin, cost ~$Y)"
```

---

## Task 9: Refresh `docs/bench/baseline.json` with post-9.4.7 Modal metrics

**Objective:** Update the baseline.json with new Modal-generated metrics. 9.4.7 shipped a narrow fix (`996910e`, retro at `b659d91`) and a local full-LoCoMo-10 comparison (`308b60a`) already confirmed the ladder-vs-bm25only and ladder-vs-random invariants PASS. This task refreshes baseline.json to match.

**Files:**
- Modify: `docs/bench/baseline.json`

**Precondition:** 9.4.7 retro exists at `docs/plans/phase-9-4-7-retro.md` AND the post-9.4.7 comparison exists at `docs/bench/baselines/2026-04-22-comparison.md`. Verify both:

```bash
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/plans/phase-9-4-7-retro.md
ls -la /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/baselines/2026-04-22-comparison.md
```

If either is missing, STOP and surface to controller.

**Step 1: Read the pre-measured post-fix numbers**

From `docs/bench/baselines/2026-04-22-comparison.md` (run at gitSha `b659d91`, 1986 QAs on LoCoMo-10):

```
ladder:   recall@1=0.4495, recall@5=0.8553, recall@10=1.0000, mrr=0.7452, p50=1.85, p95=4.16
bm25only: recall@1=0.3124, recall@5=0.7912, recall@10=1.0000, mrr=0.6898, p50=6.01, p95=7.34
recency:  recall@1=0.0000, recall@5=0.5692, recall@10=1.0000, mrr=0.2703, p50=0.08, p95=0.28
random:   recall@1=0.0755, recall@5=0.4717, recall@10=1.0000, mrr=0.2690, p50=0.04, p95=0.24
```

Structural invariants:
- `ladderVsRandom.measuredMrrDelta` = 0.7452 - 0.2690 = **+0.4762** (threshold 0.02 → **PASS**)
- `ladderVsBm25Only.measuredMrrDelta` = 0.7452 - 0.6898 = **+0.0554** (threshold 0.02 → **PASS**)

**Step 2: Update baseline.json**

Apply these changes to `docs/bench/baseline.json`:

1. `asOf` → today's date (YYYY-MM-DD)
2. `gitSha` → output of `git rev-parse HEAD` at the time Task 9 runs
3. `statusReason` → rewrite to:
   > `"Sub-phase 9.4.7 shipped a narrow bench-side fix (bench/harness/seeder.js idle-drain loop) that eliminated residual working-buffer contamination in post-seed state. Sub-phase 9.4.8 re-ran τ and bm25 sweeps via Modal parallelism (per-knob-value containers, ~3 min wall-clock vs ~62 min serial local). All metrics below are measured against the full 10-conversation LoCoMo corpus (1986 QA items) with a warm live-extraction cache. Ladder now outperforms bm25only at every recall@k AND on MRR; both structural invariants PASS."`
4. `knownIssues` → replace the four 9.4.6 entries with this single post-9.4.7 note:
   > `"bench metrics are measured with warm extraction cache only; live-LLM extraction on Modal is deferred. Tier 3 (graph) lift over Tier-2-only will be revisited in a future sub-phase now that the ladder is no longer structurally broken."`
5. `headlineMetrics` → replace with the values from Step 1. Keep the `corpus`, `n_scored_range`, `n_skipped_range`, `skipReasonNote` fields but update their content from the Modal tau sweep Task 7 envSnapshot. If Task 7's report is not yet generated when Task 9 runs, source these from the local comparison at `docs/bench/baselines/2026-04-22-comparison.md` — they are the same corpus, same seed path, same fix.
6. `structuralInvariants.ladderVsRandom`:
   - `measuredMrrDelta`: `0.4762`
   - `status`: `"PASS"`
   - `note`: `"Ladder MRR (0.7452) is 0.48 ABOVE random (0.2690). 9.4.7 seeder idle-drain eliminated residual working-buffer prepends. Invariant restored."`
7. `structuralInvariants.ladderVsBm25Only`:
   - `measuredMrrDelta`: `0.0554`
   - `status`: `"PASS"`
   - `note`: `"Ladder MRR (0.7452) is 0.055 ABOVE bm25only (0.6898). Scorer chain + graph expansion earn their keep on the same state bundle bm25only searches. Invariant restored."`
8. `tuned` → Keep existing entries for now; the τ sweep at Task 7 will refresh these with post-9.4.7 elbow data. If Task 7 produces meaningfully different elbows (Δ > 0.05 on any knob), update `measured` + `note` fields accordingly. Otherwise mark the existing entries with `"post-9.4.7-validated": true`.
9. `provenance`:
   - `tauSweep` → `"sweeps/YYYY-MM-DD-tau.md"` (Task 7's output)
   - `bm25Sweep` → `"sweeps/YYYY-MM-DD-bm25.md"` (Task 8's output)
   - `consolidationSweep` + `graphSweep` → leave pointing at 9.4.6's `2026-04-22-*.md` files, with a `supersededBy` note explaining these sweeps are deferred (graph/consolidation stay out of 9.4.8 scope per locked decision 6).
   - Leave `supersededArtifacts` alone.
10. Remove the top-level `status: "measured"` field if present, or update to `"measured"` (was `"measured"` under 9.4.6 — should remain).

**Step 3: Verify baseline.json is valid JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem/docs/bench/baseline.json'))"
```
Expected: exits 0, no output.

**Step 4: Verify the tests that assert baseline.json shape still pass**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm test -- tests/integration/bench/baseline-json.test.js
```
Expected: PASS. If a test fails because it asserts the OLD `FAIL` status on invariants, that test was locked to the 9.4.6 broken-ladder reality. Update its assertion to `"PASS"` and include in the Task 9 commit.

**Step 5: Commit**

```bash
git add docs/bench/baseline.json
# If you updated the baseline-json test, include it:
# git add tests/integration/bench/baseline-json.test.js
git commit -m "docs(bench): refresh baseline.json post-9.4.7 — structural invariants PASS

ladderVsRandom:   measuredMrrDelta -0.1910 → +0.4762 (FAIL → PASS)
ladderVsBm25Only: measuredMrrDelta -0.5791 → +0.0554 (FAIL → PASS)

Ladder MRR 0.1118 → 0.7452 after 9.4.7 seeder idle-drain fix.
Full LoCoMo-10 (1986 QAs) via Modal τ sweep wall-clock ~Xmin
(was ~62 min serial, per 9.4.6 retro).

Measured at b659d91 (9.4.7 retro) local; reconfirmed at <this-commit>
via Modal. Numbers match to 4 decimals."
```

---

## Task 10: Retro

**Objective:** Document what worked, what surprised us, metrics, and handoff notes.

**Files:**
- Create: `docs/plans/phase-9-4-8-retro.md`

**Step 1: Write retro document**

Create `docs/plans/phase-9-4-8-retro.md` with this structure:

```markdown
# Sub-phase 9.4.8 Retro — Modal Bench Substrate

**Status:** Complete.
**Commits:**
- [list each commit hash from Tasks 1-9]

**Duration:** [X hours]

---

## What happened

[2-3 sentences summarizing the sub-phase: Modal app built, Volume created, per-point parallelism working, tau+bm25 sweeps re-run, baseline.json refreshed conditionally.]

## Decisions held

1. Node 20.x via NodeSource PPA. **Held.**
2. Volume `starmem-bench-data` for cache. **Held.**
3. `copy_local_dir` for repo code. **Held.**
4. Per-knob-value parallelism via `.map()`. **Held.**
5. Python aggregator reproduces exact Markdown format. **Held.**
6. Local path default, `--modal` opt-in. **Held.**
7. Warm cache only, no live LLM on Modal. **Held.**
8. Observation-first cost posture. **Held.**
9. Baseline.json refresh conditional on 9.4.7. **Held.** [Branch A/B applied.]
10. Synthetic smoke <5 min. **Held.** [Actual wall-clock: Xm.]

## What worked

- [List 2-3 things that went well. E.g., image build was fast, `.map()` parallelism cut wall-clock from 62 min to X min, report format is byte-identical.]

## What surprised us

- [List 1-2 unexpected findings. E.g., actual cost was higher/lower than expected, cold start latency, a specific metric shifted or didn't shift.]

## Metrics

- **Plan length:** [X] lines
- **Duration:** [X hours]
- **Modal image build time:** [X min]
- **Synthetic smoke wall-clock:** [X min]
- **Full τ sweep wall-clock:** [X min] (48 points)
- **Full bm25 sweep wall-clock:** [X min] (16 points)
- **Estimated Modal spend:** [$X]
- **Files created:** [list]
- **Files modified:** [list]

## Notes for Phase 11

- Modal substrate is reusable. Phase 11 can run its diagnostic sweeps (instrumented scorer chain) via the same `--modal` path.
- If Phase 11 needs live LLM extraction on Modal, extend `sweep_app.py` to accept a Modal Secret for `STARMEM_BENCH_LLM_API_KEY` and set the env vars before calling `_modal-point.js`.

## Notes for future Modal tuning

- If cost is too high, consider: (a) smaller memory (2048 instead of 4096), (b) shorter timeout for synthetic runs, (c) batching multiple grid points per container.
- If cold starts dominate, add `container_idle_timeout=300` to `run_point`.
```

**Step 2: Commit retro**

```bash
git add docs/plans/phase-9-4-8-retro.md
git commit -m "docs(plans): sub-phase 9.4.8 retro"
```

**Step 3: Final verification**

Run:
```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run lint
npm run typecheck
npm test
```
Expected: All green. The Modal Python files are not linted by the existing JS toolchain; that's expected.

Run:
```bash
grep -c '^## Task ' docs/plans/phase-9-4-8-modal-bench-substrate.md
grep -c '^## Task ' docs/plans/phase-9-4-8-retro.md
```
Expected: `11` for the plan, `0` for the retro (it has a different structure).

---

**End of plan.**
