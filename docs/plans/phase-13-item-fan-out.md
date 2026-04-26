# Phase 13 — Item-level fan-out for LongMemEval sweeps + λ₁ tripwire closure

> **For Hanami:** Use `subagent-driven-development` skill to execute this plan task-by-task. Tasks marked **Owner: Subagent** dispatch via `delegate_task`; tasks marked **Owner: Controller** are in-controller work; tasks marked **Owner: Eva** are out-of-band Modal dispatches.

**Goal:** Refactor `bench/modal/sweep_app.py` from per-cell-serial to item-chunk-parallel fan-out, then close Phase 12 Task 7 by re-dispatching the λ₁ tripwire on LongMemEval-S, evaluating the decision gate, and writing the retro.

**Architecture:**
- New `@app.function run_point_chunk(overrides_json, corpus, extractor_model, item_indices_json)` runs the same harness body as `run_point` but slices the corpus to a specified item-index list.
- New `bench/sweeps/_modal-chunk.js` — harness entry that reads `STARMEM_ITEM_INDICES` (JSON array) and feeds `runHarness({ corpus: corpus.slice_by_indices(...) })`.
- `run_sweep` builds a flat `(cell_idx, chunk_idx, overrides_json, corpus, extractor_model, indices_json)` cartesian product; one `run_point_chunk.starmap(...)` call fans across grid × chunks. Aggregator groups results back by `cell_idx`, concatenates `runs[]`, calls `computeMetrics` once per cell.
- Chunks-per-cell defaults to `max(1, items // 80)` so LoCoMo (10 items) stays serial (1 chunk = identical to old `run_point` shape) and LongMemEval-S (500 items) gets 6 chunks ≈ 83 items each ≈ 300s wall.

**Tech stack:** Modal Python (`@app.function`, `.starmap`), Node.js harness (`bench/sweeps/_modal-chunk.js` mirrors `_modal-point.js`), JS aggregation in `bench/runner.js` (no changes — pure-data `runs[]` + `computeMetrics` is the seam).

---

## Decisions locked before writing this plan (conversation 2026-04-26 with Eva):

1. **Phase 13 scope = infra + Task 7 closure.** Task 7's λ₁ tripwire re-dispatch + decision gate + retro all live in this phase, not parked. The whole motivation for the refactor is the parked sweep; closing it inside the same phase is honest scope.
2. **K=6 chunks default for full LongMemEval-S** (500 items). 6 chunks × 5 cells = 30 containers, fits in Modal's 100-container free-tier ceiling with comfortable headroom. Per-chunk wall ≈ 83 items × ~3.6s/item ≈ 300s, well under any reasonable timeout.
3. **Chunks heuristic = `max(1, items // 80)`.** LoCoMo → 1 chunk (no fan-out, identical to old shape, zero overhead). Stratified subsamples scale automatically. CLI override `--chunks K` for tuning.
4. **Flat starmap over (cell × chunk) tuples**, not nested. Aggregator groups by `cell_idx`. Single `.starmap` call, single Modal dispatch round, no nested-container issues.
5. **`run_point` is preserved as a thin wrapper.** Calls `run_point_chunk` with `item_indices=null` (sentinel = "full corpus"). `--mode run-point` and the LoCoMo-only sub-orchestrators (`graph`, `consolidation`, `batchsize`) keep their existing call sites unchanged. No breaking change to those code paths.
6. **Per-chunk `volume.commit()` + stderr streaming preserved.** Both load-bearing from Phase 12 Task 7's debugging — keep them in `run_point_chunk` with the existing pattern.
7. **`run_point_chunk` per-chunk timeout = 1200s.** Worst-case ~300s wall + 4× headroom. Compatible with Modal free-tier limits, far below the old 3000s. The 10800s parent timeout on `run_sweep` stays — it's still the orchestration ceiling.
8. **Aggregation seam = `runs[]` concat + recompute.** `runs[]` is pure data; `computeMetrics(runs)` is a pure function. No MRR/coverage merge math, no numerator/denominator preservation drama. `aggStats` (consolidation telemetry) re-aggregates from concatenated `runs[]` via the existing `aggregateConsolidationStats` helper, which already dedups by `conversationId` (LongMemEval items each have unique convos so dedup is a no-op there; LoCoMo wouldn't even reach this code path because items < 80).
9. **`wallMs` per-cell = `max(chunk_wallMs)`** — chunks within a cell run in parallel, so the cell wall-clock is the slowest chunk, not the sum. Sum would mislead about effective throughput.
10. **Decision gate unchanged.** Phase 11 amendment rule (ΔMRR ≥ 0.02 AND Δcoverage_pp ≥ -5pp) and the three-outcome flow (A: aggregate flat, B: task-type-only signal, C: aggregate signal → 4-knob expansion) all carry over verbatim from Phase 12 Task 7 spec.

---

## Task overview

| # | Task | Owner | Files | Wall-clock |
|---|---|---|---|---|
| 0 | Plan commit | Controller | `docs/plans/phase-13-item-fan-out.md` | 30s |
| 1 | `_modal-chunk.js` harness slice | Subagent | `bench/sweeps/_modal-chunk.js` | 5min |
| 2 | `run_point_chunk` Modal function | Subagent | `bench/modal/sweep_app.py` | 5min |
| 3 | `run_sweep` flat-fan-out + cell aggregator | Subagent | `bench/modal/sweep_app.py` | 8min |
| 4 | Chunks heuristic + `--chunks` CLI flag | Subagent | `bench/modal/sweep_app.py` | 4min |
| 5 | Synthetic smoke + decorator audit + tests | Controller | `bench/modal/test_sweep_app.py` (or sibling) + Eva's smoke dispatch | 10min |
| 6 | λ₁ tripwire re-dispatch + report | Eva + Controller | `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md` | 30min Modal + 15min controller |
| 7 | Retro + ROADMAP append + Phase 14 handoff notes | Controller | `docs/plans/phase-13-retro.md`, `docs/plans/ROADMAP.md` | 20min |

**Optional Task 6.5** (conditional, only if decision gate Outcome C fires): 4-knob coordinate-descent expansion sweep. Not pre-written — defer to in-context decision after Task 6.

---

## Task 0: Plan commit

**Objective:** Stabilize this plan as a reference for subagents and future sessions.

**Owner:** Controller.

**Steps:**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
git add docs/plans/phase-13-item-fan-out.md
git commit -m "docs(plans): Phase 13 item-fan-out + λ₁ closure plan

Refactors bench/modal/sweep_app.py from per-cell-serial to
item-chunk-parallel fan-out. K=6 chunks × 5 cells = 30 containers
on Modal free tier; per-chunk wall ~300s comfortably under any
timeout. Chunks heuristic = max(1, items // 80) so LoCoMo stays
serial (no fan-out overhead) and LongMemEval-S scales cleanly.

Phase 13 scope = infra + Phase 12 Task 7 closure: λ₁ tripwire
re-dispatch, decision gate evaluation, retro all in-phase.
Closes the parked Task 7 from Phase 12 (last attempt SIGKILL'd
on parent timeout per commit 47bc288)."
```

**Done-when:**
- [ ] `docs/plans/phase-13-item-fan-out.md` committed
- [ ] `git log -1` shows the plan commit on `main`

---

## Task 1: `_modal-chunk.js` harness slice

**Objective:** Create a per-chunk harness entry that reads `STARMEM_ITEM_INDICES` (JSON array of item indices into the corpus) and runs `runHarness` against only those items. Mirrors `_modal-point.js` exactly except for the slicing step + payload identity fields.

**Owner:** Subagent.

**Files:**
- Create: `bench/sweeps/_modal-chunk.js`

**Why a new file, not a flag on `_modal-point.js`?** Keeps the call sites distinct and the existing tests/harness invocations stable. `_modal-point.js` runs full corpus; `_modal-chunk.js` runs a slice. Two files, two responsibilities. The bodies are 95% identical but that's fine — the alternative (one file, one flag) creates a branch in the hot path of Phase 12's existing dispatches and risks breaking them.

**Verbatim source:**

```javascript
#!/usr/bin/env node
/**
 * Per-chunk sweep-point runner for Modal item-fan-out dispatch.
 *
 * Reads overrides from STARMEM_OVERRIDES (JSON), the corpus name from
 * STARMEM_BENCH_CORPUS, and an item-index list from STARMEM_ITEM_INDICES
 * (JSON array of integers). Loads the corpus, slices by the indices,
 * runs runHarness, and prints a JSON payload to stdout.
 *
 * Identical to _modal-point.js except for:
 *   - reads STARMEM_ITEM_INDICES and slices the corpus
 *   - payload includes itemIndices (echoed) so the aggregator can verify
 *     coverage ("did every dispatched chunk return?")
 *
 * Cell-level aggregation happens in run_sweep (Python side): concat all
 * runs[] across chunks for a cell, recompute metrics once.
 *
 * @module bench/sweeps/_modal-chunk
 */

import { runHarness } from '../runner.js';
import { getAdapter } from '../corpora/index.js';
import { performance } from 'node:perf_hooks';

// Route harness log output to stderr so stdout is reserved for the
// single-line JSON payload that run_sweep will json.loads().
const _origLog = console.log;
console.log = (...args) => console.error(...args);

/**
 * Aggregate per-run consolidation stats. Identical to _modal-point.js;
 * dedups by conversationId. For LongMemEval-S (each item = unique convo)
 * dedup is a no-op; for LoCoMo it would matter, but Phase 13's chunking
 * heuristic (items // 80) means LoCoMo always runs as 1 chunk = identical
 * to the old run_point shape, so this code path stays as a no-op for
 * LongMemEval and never fires for LoCoMo through this entry.
 */
function aggregateConsolidationStats(runs) {
    if (!runs || runs.length === 0) return null;
    if (!runs[0]?.consolidationStats) return null;

    const seen = new Set();
    const totals = { added: 0, updated: 0, drained: 0, batches: 0, parseFailures: 0, entriesSkipped: 0 };
    for (const run of runs) {
        if (seen.has(run.conversationId)) continue;
        seen.add(run.conversationId);
        const cs = run.consolidationStats || {};
        totals.added         += cs.added         || 0;
        totals.updated       += cs.updated       || 0;
        totals.drained       += cs.drained       || 0;
        totals.batches       += cs.batches       || 0;
        totals.parseFailures += cs.parseFailures || 0;
        totals.entriesSkipped += cs.entriesSkipped || 0;
    }
    const updateRate     = totals.updated / Math.max(1, totals.added + totals.updated);
    const dedupHitRate   = totals.updated / Math.max(1, totals.drained);
    const parseFailRate  = totals.parseFailures / Math.max(1, totals.batches);
    const entrySkipRate  = totals.entriesSkipped / Math.max(1, totals.added + totals.updated + totals.entriesSkipped);
    return { ...totals, updateRate, dedupHitRate, parseFailRate, entrySkipRate };
}

async function main() {
    const overrides = JSON.parse(process.env.STARMEM_OVERRIDES || '{}');
    const corpusName = process.env.STARMEM_BENCH_CORPUS ?? 'longmemeval-s';
    const itemIndicesRaw = process.env.STARMEM_ITEM_INDICES;
    if (!itemIndicesRaw) {
        throw new Error('_modal-chunk.js requires STARMEM_ITEM_INDICES env (JSON array of item indices). For full-corpus runs, use _modal-point.js.');
    }
    const itemIndices = JSON.parse(itemIndicesRaw);
    if (!Array.isArray(itemIndices) || itemIndices.length === 0) {
        throw new Error(`STARMEM_ITEM_INDICES must be a non-empty JSON array; got: ${itemIndicesRaw}`);
    }

    console.error(`[diag] _modal-chunk env: corpus=${corpusName} ` +
        `model=${process.env.STARMEM_BENCH_LLM_MODEL ?? '<unset>'} ` +
        `overrides=${JSON.stringify(overrides)} ` +
        `itemIndices=[${itemIndices[0]}..${itemIndices[itemIndices.length - 1]}] (n=${itemIndices.length})`);

    const adapter = getAdapter(corpusName);
    const fullCorpus = await adapter.loadConversations({ offline: true });

    // Slice by indices. Out-of-range indices are surfaced loudly — they
    // indicate either a stale chunk plan or a corpus-size mismatch.
    const corpus = [];
    const missingIndices = [];
    for (const idx of itemIndices) {
        if (idx < 0 || idx >= fullCorpus.length) {
            missingIndices.push(idx);
            continue;
        }
        corpus.push(fullCorpus[idx]);
    }
    if (missingIndices.length > 0) {
        throw new Error(`STARMEM_ITEM_INDICES contains ${missingIndices.length} out-of-range indices (corpus size = ${fullCorpus.length}); first 5: ${missingIndices.slice(0, 5).join(',')}`);
    }

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

    // Phase 13: emit raw runs[] alongside per-chunk metrics. Cell aggregator
    // (run_sweep Python side) concatenates runs[] across chunks and recomputes
    // metrics ONCE per cell. Per-chunk metrics are advisory — useful for
    // streaming progress views and for the "does per-chunk wall-clock
    // correlate with item-index range?" Phase 14 candidate.
    const output = {
        overrides,
        itemIndices,                              // echoed for aggregator coverage check
        runs: result.runs,                        // raw runs for cell-level recompute
        metrics: result.metrics,                  // per-chunk advisory metrics
        latencyMs,
        runCount: result.runs.length,
        wallMs: Math.round(wallMs),
        aggStats: aggregateConsolidationStats(result.runs),
    };
    _origLog(JSON.stringify(output));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
```

**Step 1: Write the file.**

Use `write_file` (NOT heredoc — secrets-guard trap on numeric-looking literals like `0.95`, `0.5`).

**Step 2: Smoke-check syntax.**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
node --check bench/sweeps/_modal-chunk.js
# Expected: no output, exit 0
```

**Step 3: Commit.**

```bash
git add bench/sweeps/_modal-chunk.js
git commit -m "feat(bench): _modal-chunk.js harness slice for item-fan-out

Mirrors _modal-point.js but slices corpus by STARMEM_ITEM_INDICES
(JSON array). Emits raw runs[] alongside per-chunk metrics so
the cell aggregator (Phase 13 Task 3) can concatenate and recompute
metrics once per cell instead of merging per-chunk numerator/denominators.

Out-of-range indices are surfaced loudly to catch stale chunk plans
or corpus-size mismatches.

Phase 13 Task 1 (item-fan-out infrastructure)."
```

**Done-when:**
- [ ] `bench/sweeps/_modal-chunk.js` exists and `node --check` passes
- [ ] Commit landed on `main`

**Subagent delegation context (verbatim):**

> You are implementing Phase 13 Task 1 for STARmem. Read `## Task 1` of `docs/plans/phase-13-item-fan-out.md` in full. Your job: (1) write `bench/sweeps/_modal-chunk.js` exactly as specified in the verbatim source block; (2) run `node --check bench/sweeps/_modal-chunk.js` to verify syntax; (3) commit with the exact message in the plan. ABSOLUTE REPO PATH: `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem`. Verify with `git log -1` showing `<plan-commit-hash>` before starting. Do NOT use `~` or `cd ~`. Do NOT use heredoc to write the file (secrets-guard trap) — use write_file. Do NOT add features not in the plan. Do NOT run `git add -A` (use explicit path). If you see `***` in any numeric literal in the plan, STOP and report — that's a tooling redaction, not real code.

---
## Task 2: `run_point_chunk` Modal function

**Objective:** Add a new `@app.function`-decorated `run_point_chunk(overrides_json, corpus, extractor_model, item_indices_json)` to `bench/modal/sweep_app.py`. Same body as `run_point` except it threads `STARMEM_ITEM_INDICES` to the subprocess and invokes `_modal-chunk.js` instead of `_modal-point.js`. Per-chunk timeout = 1200s.

**Owner:** Subagent.

**Files:**
- Modify: `bench/modal/sweep_app.py` — add `run_point_chunk` immediately after the existing `run_point` definition (around line 365 after `run_point` exits, before `run_baseline_point`).

**Why a new function, not a flag on `run_point`?** Two reasons. First, the decorator `timeout=` differs (1200s vs the existing 3000s) and Modal decorators are baked at app-build time — can't switch dynamically. Second, sub-orchestrators (`run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep`) call `run_point.map(...)` directly with the existing 3-tuple shape; changing `run_point`'s signature would ripple to all of them. New function = isolated change, zero regression risk to LoCoMo paths.

**Verbatim source** (insert immediately after `run_point`'s closing `return result.stdout.strip()`, search for `# Previously commit only happened at run_sweep exit, which meant` to anchor):

```python
@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1200,   # Phase 13: per-chunk worst-case ~83 items × ~3.6s/item
                    # = ~300s wall + 4× headroom. Comfortably under the
                    # old run_point 3000s; chunked dispatch makes timeouts
                    # a non-issue. Tune downward if Phase 14 sweeps show
                    # stable per-chunk wall < 200s on this corpus.
    memory=4096,
)
def run_point_chunk(
    overrides_json: str,
    corpus: str,
    extractor_model: str,
    item_indices_json: str,
) -> str:
    """Run a single (overrides × item-chunk) sweep cell on a corpus slice.

    Phase 13 item-fan-out entry point. Mirrors run_point exactly except:
      - threads STARMEM_ITEM_INDICES env var to the Node subprocess
      - invokes bench/sweeps/_modal-chunk.js (which slices the corpus)
        instead of _modal-point.js (which runs the full corpus)
      - per-chunk timeout=1200s instead of run_point's 3000s

    Cell-level metrics aggregation happens in run_sweep, not here. This
    function emits per-chunk runs[] + advisory metrics; run_sweep groups
    by cell_idx, concatenates runs[], and recomputes metrics once per
    cell via the existing computeMetrics path.

    Args:
        overrides_json: JSON string of Record<string, number> overrides.
        corpus: 'locomo' or 'longmemeval-s'. Note: Phase 13 chunking
            heuristic (items // 80) means LoCoMo always runs as 1 chunk
            covering all 10 items, identical to the old run_point shape.
            LongMemEval-S full corpus = 6 chunks of ~83 items.
        extractor_model: Optional model override (see run_point docstring
            for cache-key alignment requirements).
        item_indices_json: JSON array of integer item indices into the
            corpus (e.g. "[0, 1, 2, ..., 82]"). Required — there is no
            "full corpus" sentinel; full-corpus runs go through run_point
            via run_sweep's chunks=1 path.

    Returns:
        JSON string with { overrides, itemIndices, runs, metrics,
        latencyMs, runCount, wallMs, aggStats }. The runs[] field is the
        raw HarnessRun array; cell-level recompute downstream concatenates
        across chunks.
    """
    import os
    import subprocess

    # Symlink Volume cache to where the repo expects it.
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(cache_link, "/data/extractions")
    if corpus == "longmemeval-s":
        longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
        _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")

    diag = {
        "repo_cache_contents": sorted(os.listdir(repo_cache)) if os.path.isdir(repo_cache) else None,
        "corpus_link_target": os.readlink(corpus_link) if os.path.islink(corpus_link) else "not-a-symlink",
        "corpus_link_size": os.path.getsize(corpus_link) if os.path.exists(corpus_link) else 0,
        "cache_link_target": os.readlink(cache_link) if os.path.islink(cache_link) else "not-a-symlink",
        "cache_link_isdir": os.path.isdir(cache_link),
        "modal_chunk_js_exists": os.path.exists("/repo/bench/sweeps/_modal-chunk.js"),
        "runner_js_exists": os.path.exists("/repo/bench/runner.js"),
        "node_modules_exists": os.path.exists("/repo/node_modules"),
    }

    env = os.environ.copy()
    env["STARMEM_OVERRIDES"] = overrides_json
    env["STARMEM_BENCH_CORPUS"] = corpus
    env["STARMEM_ITEM_INDICES"] = item_indices_json   # Phase 13: chunk slice
    if extractor_model:
        env["STARMEM_BENCH_LLM_MODEL"] = extractor_model

    # Stream stderr live to Modal's log stream — same Popen pattern as
    # run_point (post-2026-04-26 fix). Per-chunk wall-clock is short
    # enough (~300s) that buffering wouldn't be catastrophic, but
    # consistency with run_point + free progress visibility wins.
    import sys
    proc = subprocess.Popen(
        ["node", "bench/sweeps/_modal-chunk.js"],
        cwd="/repo",
        stdout=subprocess.PIPE,
        stderr=sys.stdout,
        text=True,
        env=env,
    )
    stdout_str, _ = proc.communicate()
    returncode = proc.returncode

    if returncode != 0:
        import json as _json
        try:
            volume.commit()
        except Exception:
            pass
        return _json.dumps({
            "error": "node subprocess failed",
            "returncode": returncode,
            "stderr_note": "streamed live to Modal function log",
            "stdout_tail": (stdout_str or "")[-2000:],
            "diagnostics": diag,
            "overrides_echo": overrides_json,
            "item_indices_echo": item_indices_json,
        })

    # Per-chunk volume.commit() — durability for cache writes from any
    # live extraction fall-through that happened in this chunk. Mirror
    # of run_point's pattern.
    try:
        volume.commit()
    except Exception:
        pass

    return stdout_str.strip()
```

**Step 1: Patch the file.**

Use the `patch` tool with `old_string` anchored on the line before the insertion point and `new_string` containing both the anchor and the new function. The cleanest anchor is the closing of `run_point`:

```python
# anchor (search target):
        return _json.dumps({
            "error": "node subprocess failed",
            ...
        })

    volume.commit()
    return stdout_str.strip()
```

After this block (which is inside `run_point`), there's whitespace and then either `@app.function` (for `run_baseline_point`) or `def run_baseline_point`. Insert `run_point_chunk` between these two functions.

Concretely: read lines 350-370 of `bench/modal/sweep_app.py` to find the exact text after `run_point`'s `return stdout_str.strip()` and before `run_baseline_point`'s `@app.function`. Use that as the patch anchor.

**Step 2: Sibling-decorator audit.**

Per `persist-serverless-compute-results` skill, when adding any `@app.function`-decorated function, audit sibling functions in the same file for the same pattern. Confirm `run_point_chunk` has the same decorator shape as `run_point` (same image, same volumes, same env_secret, same memory) and only differs in `timeout=`.

```bash
grep -B 1 "^def run_point\|^def run_point_chunk\|^def run_baseline_point" bench/modal/sweep_app.py | head -20
# Expected: each `def run_*_point*` line is preceded by a `)` closing
#           an `@app.function(...)` decorator. None should be bare.
```

**Step 3: Smoke-compile.**

```bash
python3 -m py_compile bench/modal/sweep_app.py
# Expected: no output, exit 0
```

**Step 4: Commit.**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): run_point_chunk Modal function for item-fan-out

Mirrors run_point but slices the corpus to a specified item-index
list via STARMEM_ITEM_INDICES env. Per-chunk timeout=1200s (vs
run_point's 3000s) since each chunk is ~83 items × ~3.6s = ~300s
wall worst-case.

Phase 13 Task 2 (item-fan-out infrastructure). Cell-level metrics
aggregation lands in Task 3 (run_sweep refactor)."
```

**Done-when:**
- [ ] `run_point_chunk` defined in `bench/modal/sweep_app.py` with `@app.function(timeout=1200, ...)`
- [ ] `python3 -m py_compile` passes
- [ ] Sibling decorator audit confirms no decorator drift
- [ ] Commit landed

**Subagent delegation context (verbatim):**

> You are implementing Phase 13 Task 2 for STARmem. Read `## Task 2` of `docs/plans/phase-13-item-fan-out.md` in full. Your job: (1) add `run_point_chunk` to `bench/modal/sweep_app.py` exactly as specified in the verbatim source block, inserted between `run_point` and `run_baseline_point`; (2) run sibling-decorator audit (grep) and `python3 -m py_compile`; (3) commit with the exact message in the plan. ABSOLUTE REPO PATH: `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem`. Verify with `git log -1` showing the commit from Task 1 before starting. Do NOT use `~` or `cd ~`. Do NOT modify `run_point` itself — Task 2 is purely additive. Do NOT remove or alter the existing `_install_volume_symlink` helper (used by both functions). Do NOT run `git add -A`. If you see `***` in any numeric literal, STOP and report.

---

## Task 3: `run_sweep` flat-fan-out + cell aggregator

**Objective:** Replace the existing `run_point.starmap([(oj, corpus, extractor_model) for oj in overrides_jsons])` call in `run_sweep` with a flat `run_point_chunk.starmap(...)` over `(cell_idx, chunk_idx, oj, corpus, extractor_model, indices_json)` tuples, then aggregate by `cell_idx` to produce per-cell metrics.

**Owner:** Subagent.

**Files:**
- Modify: `bench/modal/sweep_app.py` — replace lines ~2953-2960 in `run_sweep` (the `point_results = list(run_point.starmap(...))` block) and the immediately-following `points = [json.loads(pr) for pr in point_results]` line.

**Critical constraint: this Task only touches the GENERIC grid path in `run_sweep`** (the path reached after the `if sweep_name == "batchsize"` / `"graph"` / `"consolidation"` early-returns). The three sub-orchestrators (`run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep`) keep their existing `run_point.map()` calls — they're LoCoMo-only and the chunking heuristic gives LoCoMo 1 chunk anyway, so chunking would be pure overhead for them. Phase 13 leaves them unchanged.

**Verbatim source — replacement block:**

Find the existing block (around line 2953):

```python
    # Fan out to parallel containers
    overrides_jsons = [json.dumps(point) for point in grid]
    point_results = list(run_point.starmap(
        [(oj, corpus, extractor_model) for oj in overrides_jsons]
    ))

    points = [json.loads(pr) for pr in point_results]
```

Replace with:

```python
    # Phase 13: item-fan-out. Each grid cell is split into K chunks of
    # item indices; chunks fan out in parallel alongside cells, then we
    # aggregate runs[] back per-cell and recompute metrics once.
    #
    # K = max(1, items // 80) so LoCoMo (10 items) → 1 chunk (identical
    # to old run_point.starmap shape, no overhead) and LongMemEval-S
    # (500 items) → 6 chunks of ~83 items each. CLI override --chunks
    # is honored when set (>0).
    #
    # See docs/plans/phase-13-item-fan-out.md decision 4 for why this
    # uses a flat starmap over (cell × chunk) tuples instead of nested
    # dispatch.
    overrides_jsons = [json.dumps(point) for point in grid]
    corpus_size = 500 if corpus == "longmemeval-s" else 10
    if chunks_override > 0:
        n_chunks = chunks_override
    else:
        n_chunks = max(1, corpus_size // 80)

    # Build chunk plans: list of (cell_idx, chunk_idx, item_indices) for
    # each (cell, chunk) pair. Chunk i covers items [i*chunk_size, ...)
    # using contiguous slicing — preserves item-order so any temporal
    # locality in the corpus stays within a chunk where possible.
    chunk_size = (corpus_size + n_chunks - 1) // n_chunks  # ceil
    chunk_plans = []  # list of (cell_idx, chunk_idx, indices_list)
    for cell_idx in range(len(grid)):
        for chunk_idx in range(n_chunks):
            start = chunk_idx * chunk_size
            end = min(start + chunk_size, corpus_size)
            if start >= end:
                continue   # last chunk may be empty if corpus_size % n_chunks != 0
            indices = list(range(start, end))
            chunk_plans.append((cell_idx, chunk_idx, indices))

    print(
        f"[run_sweep] dispatching {len(chunk_plans)} chunks "
        f"({len(grid)} cells × {n_chunks} chunks, "
        f"chunk_size={chunk_size}, corpus_size={corpus_size})",
        file=sys.stderr,
    )

    # Fan out via run_point_chunk. starmap argument tuple matches the
    # function signature: (overrides_json, corpus, extractor_model,
    # item_indices_json).
    chunk_results_raw = list(run_point_chunk.starmap([
        (overrides_jsons[cell_idx], corpus, extractor_model, json.dumps(indices))
        for (cell_idx, chunk_idx, indices) in chunk_plans
    ]))

    # Group chunk results by cell_idx for aggregation.
    chunks_by_cell = {}  # cell_idx -> list of parsed chunk payloads
    chunk_errors = []  # parallel list of (cell_idx, chunk_idx, error_dict)
    for (cell_idx, chunk_idx, _indices), raw in zip(chunk_plans, chunk_results_raw):
        parsed = json.loads(raw)
        if "error" in parsed and "overrides" not in parsed and "runs" not in parsed:
            chunk_errors.append((cell_idx, chunk_idx, parsed))
            continue
        chunks_by_cell.setdefault(cell_idx, []).append((chunk_idx, parsed))

    # Surface chunk-level errors loudly. A cell with ANY chunk error is
    # tainted — its aggregated metrics would be missing items and silently
    # under-count, which breaks the decision gate. Hard-fail per cell.
    if chunk_errors:
        print(
            f"\n[run_sweep] {len(chunk_errors)} of {len(chunk_plans)} chunks failed:",
            file=sys.stderr,
        )
        for (ci, chi, ep) in chunk_errors:
            stdout_tail = (ep.get("stdout_tail") or "").splitlines()[-10:]
            print(
                f"  cell={ci} chunk={chi} error={ep.get('error')!r} "
                f"returncode={ep.get('returncode')}\n"
                f"    stdout_tail (last 10 lines):\n      "
                + "\n      ".join(stdout_tail),
                file=sys.stderr,
            )

    # Aggregate per cell: concat runs[], recompute metrics once.
    # We delegate the recompute to a Node helper rather than re-implementing
    # computeMetrics in Python — single source of truth, no drift risk.
    points = []
    error_points = []
    for cell_idx, oj in enumerate(overrides_jsons):
        # Cell tainted by any chunk error: emit error_point, skip.
        cell_chunk_errors = [(ci, chi, ep) for (ci, chi, ep) in chunk_errors if ci == cell_idx]
        if cell_chunk_errors:
            first = cell_chunk_errors[0][2]
            error_points.append({
                "error": "chunk_failure",
                "cell_idx": cell_idx,
                "overrides_echo": oj,
                "failed_chunks": len(cell_chunk_errors),
                "total_chunks": n_chunks,
                "first_chunk_error": first.get("error"),
                "first_chunk_returncode": first.get("returncode"),
            })
            continue

        cell_chunks = sorted(chunks_by_cell.get(cell_idx, []), key=lambda t: t[0])
        if not cell_chunks:
            error_points.append({
                "error": "no_chunks_returned",
                "cell_idx": cell_idx,
                "overrides_echo": oj,
            })
            continue

        # Concat runs[] across chunks for this cell.
        concat_runs = []
        max_chunk_wall = 0
        cell_overrides = cell_chunks[0][1].get("overrides", {})
        for (_chi, chunk) in cell_chunks:
            concat_runs.extend(chunk.get("runs", []))
            max_chunk_wall = max(max_chunk_wall, chunk.get("wallMs", 0))

        # Recompute metrics once on concat_runs via Node helper.
        recompute_input = json.dumps({"runs": concat_runs})
        recompute_proc = subprocess.run(
            ["node", "-e",
             "import('./bench/sweeps/_recompute-metrics.js')"
             ".then(m => m.runFromStdin(process.stdin))"],
            cwd="/repo",
            input=recompute_input,
            capture_output=True,
            text=True,
            check=True,
        )
        recompute_out = json.loads(recompute_proc.stdout.strip().split("\n")[-1])

        latencies = [r.get("latencyMs", 0) for r in concat_runs]
        sorted_lat = sorted(latencies)
        n = len(sorted_lat)
        latency_p50_p95 = {
            "p50": sorted_lat[int((n - 1) * 0.5)] if n > 0 else 0,
            "p95": sorted_lat[int((n - 1) * 0.95)] if n > 0 else 0,
        }

        points.append({
            "overrides": cell_overrides,
            "metrics": recompute_out["metrics"],
            "aggStats": recompute_out.get("aggStats"),
            "latencyMs": latency_p50_p95,
            "runCount": len(concat_runs),
            "wallMs": max_chunk_wall,   # cell wall = max chunk wall (parallel)
            "chunksRun": len(cell_chunks),
            "totalChunks": n_chunks,
        })

    # Pre-existing run_sweep logic continues to consume `points` and
    # `error_points` exactly as before — no further changes needed.
```

**Verbatim source — `_recompute-metrics.js` helper** (new file):

Create `bench/sweeps/_recompute-metrics.js`:

```javascript
#!/usr/bin/env node
/**
 * Recompute metrics from a runs[] array. Reads {runs: [...]} as JSON
 * from stdin, calls computeMetrics + aggregateConsolidationStats, and
 * prints {metrics, aggStats} as JSON to stdout.
 *
 * Used by run_sweep's per-cell aggregator (Phase 13 Task 3) to recompute
 * metrics ONCE on concatenated runs[] across chunks for a cell, instead
 * of merging per-chunk metric values.
 *
 * @module bench/sweeps/_recompute-metrics
 */

import { computeMetrics } from '../metrics/index.js';

const _origLog = console.log;
console.log = (...args) => console.error(...args);

function aggregateConsolidationStats(runs) {
    if (!runs || runs.length === 0) return null;
    if (!runs[0]?.consolidationStats) return null;

    const seen = new Set();
    const totals = { added: 0, updated: 0, drained: 0, batches: 0, parseFailures: 0, entriesSkipped: 0 };
    for (const run of runs) {
        if (seen.has(run.conversationId)) continue;
        seen.add(run.conversationId);
        const cs = run.consolidationStats || {};
        totals.added         += cs.added         || 0;
        totals.updated       += cs.updated       || 0;
        totals.drained       += cs.drained       || 0;
        totals.batches       += cs.batches       || 0;
        totals.parseFailures += cs.parseFailures || 0;
        totals.entriesSkipped += cs.entriesSkipped || 0;
    }
    const updateRate     = totals.updated / Math.max(1, totals.added + totals.updated);
    const dedupHitRate   = totals.updated / Math.max(1, totals.drained);
    const parseFailRate  = totals.parseFailures / Math.max(1, totals.batches);
    const entrySkipRate  = totals.entriesSkipped / Math.max(1, totals.added + totals.updated + totals.entriesSkipped);
    return { ...totals, updateRate, dedupHitRate, parseFailRate, entrySkipRate };
}

export async function runFromStdin(stdin) {
    let buf = '';
    for await (const chunk of stdin) buf += chunk;
    const { runs } = JSON.parse(buf);
    if (!Array.isArray(runs)) {
        throw new Error(`_recompute-metrics: expected {runs: [...]}, got: ${typeof runs}`);
    }
    const metrics = computeMetrics(runs);
    const aggStats = aggregateConsolidationStats(runs);
    _origLog(JSON.stringify({ metrics, aggStats }));
}
```

**Step 1: Add the import for `chunks_override`.**

`run_sweep`'s signature must accept a `chunks_override` parameter passed from `main()`. Update the function signature:

Find:
```python
def run_sweep(sweep_name: str, synthetic: bool = False, corpus: str = "locomo", extractor_model: str = "") -> dict:
```

Replace with:
```python
def run_sweep(sweep_name: str, synthetic: bool = False, corpus: str = "locomo", extractor_model: str = "", chunks_override: int = 0) -> dict:
```

Update the docstring to document `chunks_override`.

**Step 2: Add `import sys` if not already imported in `run_sweep`'s body.**

Search for `import sys` near the start of `run_sweep`. If absent, add it alongside `import os`, `import subprocess`, `import json`.

**Step 3: Patch in the new fan-out + aggregator block.**

Replace the existing 5-line block (`# Fan out to parallel containers` through `points = [json.loads(pr) for pr in point_results]`) with the verbatim block above.

**Step 4: Write `_recompute-metrics.js`.**

Use `write_file`. Then `node --check bench/sweeps/_recompute-metrics.js`.

**Step 5: Smoke the recompute helper end-to-end.**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
echo '{"runs":[]}' | node -e "import('./bench/sweeps/_recompute-metrics.js').then(m => m.runFromStdin(process.stdin))"
# Expected: {"metrics":{...with NaN values for empty runs...},"aggStats":null}
# (The exact NaN serialization may print as null in JSON — that's fine,
#  computeMetrics handles n=0 cleanly.)
```

**Step 6: Smoke-compile + sibling audit.**

```bash
python3 -m py_compile bench/modal/sweep_app.py
node --check bench/sweeps/_recompute-metrics.js

# Audit: confirm no other run_point.starmap call site changed unintentionally
grep -n "run_point\.\(map\|starmap\)" bench/modal/sweep_app.py
# Expected: 4 hits (run_graph_sweep, run_consolidation_sweep,
# run_consolidation_batchsize_sweep, plus any others that haven't moved).
# run_sweep's starmap call should now read run_point_chunk.starmap.
```

**Step 7: Commit.**

```bash
git add bench/modal/sweep_app.py bench/sweeps/_recompute-metrics.js
git commit -m "feat(bench): run_sweep item-fan-out via run_point_chunk

run_sweep's generic grid path now fans out (cell × chunk) tuples
to run_point_chunk.starmap and aggregates per-cell by concatenating
runs[] across chunks and recomputing metrics once via a new
_recompute-metrics.js helper. Single-source-of-truth on metrics
(reuses computeMetrics from bench/metrics/) — no per-chunk
numerator/denominator merge math.

Sub-orchestrators (run_graph_sweep / run_consolidation_sweep /
run_consolidation_batchsize_sweep) still use run_point.map directly;
they are LoCoMo-only and chunking would be pure overhead for them.

chunks_override parameter threads through from main() (Task 4).
Default is items // 80 = 6 chunks for LongMemEval-S, 1 for LoCoMo.

Phase 13 Task 3 (item-fan-out core)."
```

**Done-when:**
- [ ] `run_sweep` signature has `chunks_override: int = 0`
- [ ] Fan-out block uses `run_point_chunk.starmap` over `(cell × chunk)` tuples
- [ ] Per-cell aggregation concats `runs[]` and shells out to `_recompute-metrics.js`
- [ ] Chunk errors taint their cell with explicit `error_point`
- [ ] `_recompute-metrics.js` exists and `node --check` passes
- [ ] `python3 -m py_compile` passes
- [ ] Commit landed

**Subagent delegation context (verbatim):**

> You are implementing Phase 13 Task 3 for STARmem. Read `## Task 3` of `docs/plans/phase-13-item-fan-out.md` in full. This is the largest task in Phase 13 — give it full attention. Your job: (1) update `run_sweep` signature to add `chunks_override: int = 0`; (2) replace the existing `run_point.starmap` fan-out block with the verbatim chunked-fanout block from the plan; (3) write `bench/sweeps/_recompute-metrics.js` exactly as specified; (4) smoke both with `python3 -m py_compile` + `node --check` + the recompute-helper smoke from Step 5; (5) run the sibling-`run_point.starmap`-audit grep (Step 6) and confirm only the intended call site changed; (6) commit with the exact message in the plan. ABSOLUTE REPO PATH: `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem`. Verify with `git log -1` showing Task 2's commit before starting. Do NOT use `~` or `cd ~`. Do NOT modify the LoCoMo-only sub-orchestrator paths (`run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep`) — they retain their `run_point.map(...)` calls. Do NOT modify `run_point` itself. Do NOT touch the synthetic-grid path (lines ~2901-2937) or the `_SWEEP_BASE_OVERRIDES` table — both are intact and used by the new chunked path. Do NOT run `git add -A`. If the subprocess-based `_recompute-metrics.js` smoke fails, STOP and report — don't try alternative invocations. If you see `***` in any numeric literal, STOP and report.

---
## Task 4: Chunks heuristic + `--chunks` CLI flag

**Objective:** Plumb the `chunks_override` parameter through `main()` to `run_sweep.remote()`. Default = 0 (use heuristic). Operator can override with `--chunks K`.

**Owner:** Subagent.

**Files:**
- Modify: `bench/modal/sweep_app.py` — `main()` signature (around line 3092) and the `run-sweep` dispatch branch (around line 3193).

**Verbatim source — `main()` signature update:**

Find:
```python
def main(
    mode: str = "hello",
    overrides_json: str = "{}",
    sweep_name: str = "tau",
    synthetic: bool = False,
    local_out: str = "",
    corpus: str = "locomo",
    corpus_size: int = 500,
    extractor_model: str = "",
    stratified_sample: int = 0,
    stratify_seed: int = 2026,
    warmup_concurrency: int = 10,
    batch_size: int = 0,
):
```

Add `chunks: int = 0` between `batch_size` and the closing `):`:

```python
def main(
    mode: str = "hello",
    overrides_json: str = "{}",
    sweep_name: str = "tau",
    synthetic: bool = False,
    local_out: str = "",
    corpus: str = "locomo",
    corpus_size: int = 500,
    extractor_model: str = "",
    stratified_sample: int = 0,
    stratify_seed: int = 2026,
    warmup_concurrency: int = 10,
    batch_size: int = 0,
    chunks: int = 0,   # Phase 13: --chunks K override for run-sweep
                       # item-fan-out. 0 (default) uses heuristic
                       # max(1, items // 80). LoCoMo always = 1 chunk.
):
```

**Verbatim source — `--chunks` docstring entry:**

Add this block to `main()`'s docstring, after the existing `--stratify-seed N:` block:

```
    --chunks K:
        Only relevant to --mode run-sweep. Override the per-cell chunk
        count for item-fan-out dispatch. Default 0 = heuristic
        max(1, corpus_size // 80) — LoCoMo (10 items) → 1 chunk (no
        fan-out, identical to pre-Phase-13 shape); LongMemEval-S
        (500 items) → 6 chunks of ~83 items each. Set higher for finer
        parallelism (e.g. K=10 for ~50 items/chunk if you want sub-200s
        per-chunk wall on slow corpora). Set to 1 to disable fan-out
        entirely. Cell × chunk total must fit Modal's container ceiling
        (currently 100 free-tier; 5 cells × K chunks ≤ 100).
```

**Verbatim source — `run-sweep` dispatch:**

Find the `run-sweep` dispatch branch in `main()`:

```python
    elif mode == "run-sweep":
        result = run_sweep.remote(sweep_name, synthetic, corpus=corpus, extractor_model=extractor_model)
```

Replace with:

```python
    elif mode == "run-sweep":
        result = run_sweep.remote(
            sweep_name,
            synthetic,
            corpus=corpus,
            extractor_model=extractor_model,
            chunks_override=chunks,
        )
```

**Step 1: Patch the three locations** (signature, docstring, dispatch).

**Step 2: Smoke-compile.**

```bash
python3 -m py_compile bench/modal/sweep_app.py
```

**Step 3: Smoke the CLI flag is parsed.**

```bash
modal run bench/modal/sweep_app.py --help 2>&1 | grep -A 1 "chunks"
# Expected: --chunks INTEGER  Only relevant to --mode run-sweep...
```

If `modal run --help` doesn't surface custom flags (depends on Modal SDK version), fall back to a no-op smoke that confirms the function accepts the kwarg without error:

```bash
python3 -c "
from bench.modal.sweep_app import main as _main
import inspect
sig = inspect.signature(_main.func if hasattr(_main, 'func') else _main)
assert 'chunks' in sig.parameters, f'chunks param missing: {list(sig.parameters)}'
print('OK — chunks param present in main()')
"
```

**Step 4: Commit.**

```bash
git add bench/modal/sweep_app.py
git commit -m "feat(bench): --chunks K CLI override for run-sweep item-fan-out

main() gains --chunks K parameter (default 0 = heuristic). Threads
through to run_sweep.remote(chunks_override=...). Default heuristic
max(1, corpus_size // 80) gives LoCoMo 1 chunk and LongMemEval-S 6.

Operator can override for finer parallelism (e.g. --chunks 10 for
~50-item chunks) or disable fan-out (--chunks 1) for diagnostic
parity with the pre-Phase-13 run_point shape.

Phase 13 Task 4 (item-fan-out CLI surface)."
```

**Done-when:**
- [ ] `main()` signature accepts `chunks: int = 0`
- [ ] Docstring documents `--chunks K`
- [ ] `run-sweep` branch passes `chunks_override=chunks` to `run_sweep.remote()`
- [ ] `python3 -m py_compile` passes
- [ ] Commit landed

**Subagent delegation context (verbatim):**

> You are implementing Phase 13 Task 4 for STARmem. Read `## Task 4` of `docs/plans/phase-13-item-fan-out.md` in full. Your job: (1) patch three locations in `bench/modal/sweep_app.py` per the verbatim sources (signature, docstring, dispatch); (2) smoke-compile; (3) commit. ABSOLUTE REPO PATH: `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem`. Verify Task 3's commit hash with `git log -1` before starting. Do NOT use `~` or `cd ~`. Do NOT modify any other parameters in `main()`'s signature. Do NOT modify other dispatch branches (`run-point`, `run-baselines`, `warmup-longmemeval`). Do NOT run `git add -A`. If you see `***` in any numeric literal, STOP and report.

---

## Task 5: Synthetic smoke + decorator audit + tests

**Objective:** Verify the new fan-out path works end-to-end on the smallest possible workload before Eva commits Modal-time to a real LongMemEval-S dispatch. Two layers: (a) a Python unit test confirming chunk-plan construction is correct for several `(corpus_size, chunks)` combinations; (b) Eva's smoke dispatch of `--mode run-sweep --sweep-name lambda1_tripwire --synthetic` against LongMemEval-S to confirm the live Modal path actually runs.

**Owner:** Controller (writes the Python test); Eva (runs the Modal smoke).

**Files:**
- Modify: `bench/modal/test_sweep_app.py` if exists, else create — append new test class `TestChunkPlan`. Check for existing test file first.

**Step 1: Check for existing test infra.**

```bash
ls bench/modal/test_*.py 2>&1 || echo "no existing tests"
find bench/ -name "test_*.py" -path "*/modal/*" 2>&1 | head
```

If no test file exists in `bench/modal/`, create `bench/modal/test_sweep_app.py` with a `pytest`-style header:

```python
"""Tests for bench/modal/sweep_app.py.

These tests exercise pure-Python helpers (chunk-plan construction,
heuristic math) without requiring Modal or a network connection. They
ride on the Phase 11 pattern of mocking Modal at import time so unit
tests can import sweep_app freely.

See docs/plans/phase-11-infrastructure-hardening.md for the import-time
sandbox pattern.
"""
import sys
import types
from unittest.mock import MagicMock


# Stub modal at import time so importing sweep_app doesn't require the
# real Modal SDK. Mirror of the Phase 11 Task 6 unit-test pattern.
def _stub_modal():
    if "modal" in sys.modules:
        return
    mod = types.ModuleType("modal")
    mod.App = MagicMock()
    mod.Image = MagicMock()
    mod.Volume = MagicMock()
    mod.Secret = MagicMock()
    mod.Function = MagicMock()
    sys.modules["modal"] = mod


_stub_modal()
```

**Step 2: Append `TestChunkPlan` class.**

The plan-level acceptance test isn't \"does run_sweep work end-to-end\" (that's Eva's smoke); it's \"does the chunk-plan math produce the expected shapes for representative inputs.\" Test the heuristic + override logic directly.

Since the chunk-plan logic is inlined in `run_sweep`'s body and not factored out, Phase 13 takes a pragmatic approach: extract the math into a tiny helper `_compute_chunk_plan(grid_size, corpus_size, chunks_override)` that `run_sweep` calls, then test that helper.

**Verbatim source — helper extraction in `bench/modal/sweep_app.py`:**

Add this helper near the top of `sweep_app.py` (after `stratified_longmemeval_indices`, around line 215, before the `@app.function image=image` for `hello`):

```python
def _compute_chunk_plan(
    grid_size: int,
    corpus_size: int,
    chunks_override: int = 0,
) -> tuple[int, int, list[tuple[int, int, list[int]]]]:
    """Build the chunk plan for a sweep dispatch.

    Returns (n_chunks, chunk_size, plan) where plan is a list of
    (cell_idx, chunk_idx, item_indices) tuples covering the full corpus
    for every cell in the grid.

    Args:
        grid_size: Number of cells in the sweep grid.
        corpus_size: Number of items in the corpus.
        chunks_override: When > 0, use this value for n_chunks. Else
            apply the heuristic max(1, corpus_size // 80).

    Phase 13 Task 5 (extracted from run_sweep for unit-testability).
    """
    if chunks_override > 0:
        n_chunks = chunks_override
    else:
        n_chunks = max(1, corpus_size // 80)

    chunk_size = (corpus_size + n_chunks - 1) // n_chunks  # ceil
    plan = []
    for cell_idx in range(grid_size):
        for chunk_idx in range(n_chunks):
            start = chunk_idx * chunk_size
            end = min(start + chunk_size, corpus_size)
            if start >= end:
                continue   # last chunk may be empty if corpus_size % n_chunks != 0
            indices = list(range(start, end))
            plan.append((cell_idx, chunk_idx, indices))
    return n_chunks, chunk_size, plan
```

Then in `run_sweep`, replace the inlined math with a call:

Find (the block added in Task 3):
```python
    overrides_jsons = [json.dumps(point) for point in grid]
    corpus_size = 500 if corpus == "longmemeval-s" else 10
    if chunks_override > 0:
        n_chunks = chunks_override
    else:
        n_chunks = max(1, corpus_size // 80)

    chunk_size = (corpus_size + n_chunks - 1) // n_chunks
    chunk_plans = []
    for cell_idx in range(len(grid)):
        for chunk_idx in range(n_chunks):
            start = chunk_idx * chunk_size
            end = min(start + chunk_size, corpus_size)
            if start >= end:
                continue
            indices = list(range(start, end))
            chunk_plans.append((cell_idx, chunk_idx, indices))
```

Replace with:
```python
    overrides_jsons = [json.dumps(point) for point in grid]
    corpus_size = 500 if corpus == "longmemeval-s" else 10
    n_chunks, chunk_size, chunk_plans = _compute_chunk_plan(
        grid_size=len(grid),
        corpus_size=corpus_size,
        chunks_override=chunks_override,
    )
```

**Verbatim source — `TestChunkPlan` test class** (append to `test_sweep_app.py`):

```python
import pytest

from bench.modal.sweep_app import _compute_chunk_plan


class TestChunkPlan:
    """Verify chunk-plan construction for representative inputs.

    Covers:
      - LoCoMo (10 items) → 1 chunk per cell, no fan-out overhead
      - LongMemEval-S full (500 items) → 6 chunks per cell at ~83 items
      - Stratified subsample (e.g. 100 items) → 1 chunk per cell
      - --chunks override paths
      - Edge cases: 1 item, exact multiple of chunk_size
    """

    def test_locomo_default_one_chunk(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=10, chunks_override=0,
        )
        assert n_chunks == 1
        assert chunk_size == 10
        assert len(plan) == 5   # 5 cells × 1 chunk
        # Every cell's single chunk covers all 10 items
        for cell_idx, chunk_idx, indices in plan:
            assert chunk_idx == 0
            assert indices == list(range(10))

    def test_longmemeval_s_full_six_chunks(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=500, chunks_override=0,
        )
        assert n_chunks == 6
        assert chunk_size == 84   # ceil(500/6)
        assert len(plan) == 5 * 6   # 30 chunk-cells total
        # First chunk of cell 0 covers 0..83; last chunk of cell 0 covers 420..499
        cell_0_chunks = [(ci, indices) for (cell, ci, indices) in plan if cell == 0]
        cell_0_chunks.sort(key=lambda t: t[0])
        assert cell_0_chunks[0][1][0] == 0
        assert cell_0_chunks[-1][1][-1] == 499
        # Every chunk has size <= chunk_size
        for _ci, indices in cell_0_chunks:
            assert len(indices) <= chunk_size
        # Coverage: union of all indices in cell 0 = full range
        union = set()
        for _ci, indices in cell_0_chunks:
            union.update(indices)
        assert union == set(range(500))

    def test_chunks_override_one_disables_fan_out(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=500, chunks_override=1,
        )
        assert n_chunks == 1
        assert chunk_size == 500
        assert len(plan) == 5

    def test_chunks_override_ten(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=500, chunks_override=10,
        )
        assert n_chunks == 10
        assert chunk_size == 50
        assert len(plan) == 50   # 5 cells × 10 chunks

    def test_stratified_subsample_one_chunk(self):
        # A stratified 100-item subsample stays as 1 chunk per cell
        # since 100 // 80 = 1.
        n_chunks, _chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=100, chunks_override=0,
        )
        assert n_chunks == 1
        assert len(plan) == 5

    def test_corpus_exact_multiple_of_chunk_size(self):
        # 80 items, default heuristic = 80 // 80 = 1. No remainder issue.
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=1, corpus_size=80, chunks_override=0,
        )
        assert n_chunks == 1
        assert chunk_size == 80
        assert len(plan) == 1
        assert plan[0][2] == list(range(80))

    def test_empty_chunk_skipped(self):
        # 5 items split into 10 chunks: chunks 0..4 have 1 item each;
        # chunks 5..9 are empty and must be skipped.
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=1, corpus_size=5, chunks_override=10,
        )
        assert n_chunks == 10
        assert chunk_size == 1
        # Only 5 non-empty chunks survive
        assert len(plan) == 5
        # Each surviving chunk covers exactly one item
        for cell_idx, chunk_idx, indices in plan:
            assert len(indices) == 1
            assert indices[0] == chunk_idx

    def test_single_item_corpus(self):
        n_chunks, _chunk_size, plan = _compute_chunk_plan(
            grid_size=1, corpus_size=1, chunks_override=0,
        )
        assert n_chunks == 1
        assert len(plan) == 1
        assert plan[0][2] == [0]

    def test_total_coverage_per_cell(self):
        # Property test: for any (grid_size, corpus_size, chunks),
        # the union of indices for any cell equals range(corpus_size).
        for corpus_size in [10, 50, 80, 100, 250, 500, 999]:
            for chunks in [0, 1, 3, 7, 13]:
                _n, _cs, plan = _compute_chunk_plan(
                    grid_size=2, corpus_size=corpus_size, chunks_override=chunks,
                )
                cell_0_union = set()
                cell_1_union = set()
                for cell_idx, _ci, indices in plan:
                    if cell_idx == 0:
                        cell_0_union.update(indices)
                    else:
                        cell_1_union.update(indices)
                expected = set(range(corpus_size))
                assert cell_0_union == expected, (
                    f"corpus={corpus_size} chunks={chunks} cell_0 missing: "
                    f"{expected - cell_0_union}"
                )
                assert cell_1_union == expected
```

**Step 3: Run the new tests.**

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
python3 -m pytest bench/modal/test_sweep_app.py::TestChunkPlan -v
# Expected: 9 passed
```

**Step 4: Run the full test suite for regressions.**

```bash
python3 -m pytest bench/ -v 2>&1 | tail -10
# Expected: pre-existing test count + 9 new tests, all green.

npm test 2>&1 | tail -5
# Expected: pre-existing JS test count, all green. No new JS tests
# in Phase 13 — _modal-chunk.js is exercised by the smoke dispatch.
```

If a JS test fails on something unrelated to Phase 13 (e.g. CPU-contention flake — see `subagent-driven-development` skill's flake section), re-run once. If it fails twice or fails in code touched by Phase 13, diagnose before continuing.

**Step 5: Sibling-decorator audit.**

```bash
grep -B 1 "^def run_point\b\|^def run_point_chunk\b\|^def run_baseline_point\b\|^def run_longmemeval_warmup_point\b\|^def run_batchsize_point\b" bench/modal/sweep_app.py
```

Confirm every `run_*_point*` function has `@app.function(...)` directly above. Counts:
- `run_point` — `timeout=3000`
- `run_point_chunk` — `timeout=1200`
- `run_baseline_point` — pre-existing timeout
- `run_longmemeval_warmup_point` — pre-existing timeout
- `run_batchsize_point` — pre-existing timeout

If any function is missing its decorator, that's a regression and the prior Task's commit needs amending.

**Step 6: Synthetic Modal smoke (Eva's hand).**

Once all tasks above land, Eva dispatches:

```bash
modal run bench/modal/sweep_app.py --mode run-sweep \
    --sweep-name lambda1_tripwire --synthetic \
    --corpus longmemeval-s \
    --extractor-model "Qwen/Qwen3.6-35B-A3B-FP8" \
    --chunks 2
```

The `--synthetic` flag uses the 2-point grid defined in `run_sweep` lines 2932-2935 (`TIER3_LAMBDA_1` ∈ {1.0, 0.5}, both inlined with `BATCH_SIZE=15` + `TIER2_TAU_GAP=10`). With `--chunks 2`, that's 2 cells × 2 chunks × 250 items = 4 containers. Fast (~5min wall) and exercises every Phase 13 path:
- `run_point_chunk` invocation
- `_modal-chunk.js` slicing
- Per-cell aggregation via `_recompute-metrics.js`
- Chunk-plan construction with override

Expected: synthetic report renders, `points` has 2 entries with `chunksRun: 2`, `totalChunks: 2`, `runCount: 500` per cell, no `error_points`. Cache hits should be >95% since the warm cache from Phase 12 Task 6.5 covers all 500 items.

**Step 7: Commit Python helper extraction + tests.**

```bash
git add bench/modal/sweep_app.py bench/modal/test_sweep_app.py
git commit -m "test(bench): extract _compute_chunk_plan + 9 tests

Lifts the chunk-plan math from run_sweep's body into a pure
helper for unit-testability. run_sweep now calls
_compute_chunk_plan(grid_size, corpus_size, chunks_override)
and consumes the returned (n_chunks, chunk_size, plan) tuple.

9 tests cover: LoCoMo defaults (1 chunk), LongMemEval-S full
(6 chunks of 84), --chunks 1/10 overrides, stratified subsamples,
exact-multiple corpus, empty-chunk skipping, single-item corpus,
and a property test asserting full coverage per cell across 35
(corpus_size, chunks) combinations.

Phase 13 Task 5 (item-fan-out tests + synthetic smoke prep)."
```

**Done-when:**
- [ ] `_compute_chunk_plan` extracted as a pure helper, `run_sweep` calls it
- [ ] `bench/modal/test_sweep_app.py::TestChunkPlan` has 9 tests, all green
- [ ] `python3 -m pytest bench/` green
- [ ] `npm test` green
- [ ] Sibling decorator audit confirms no decorator drift
- [ ] Synthetic Modal smoke (Eva) runs cleanly, 2 cells × 2 chunks × 250 items returns
- [ ] Commit landed

**Subagent delegation context (verbatim):**

> You are implementing Phase 13 Task 5 for STARmem. Read `## Task 5` of `docs/plans/phase-13-item-fan-out.md` in full. Your job covers ONLY the test-side work: (1) extract `_compute_chunk_plan` from `run_sweep` into a top-level helper as specified; (2) update `run_sweep` to call the helper; (3) write/append `bench/modal/test_sweep_app.py::TestChunkPlan` with the 9 tests in the verbatim source; (4) run `python3 -m pytest bench/modal/test_sweep_app.py::TestChunkPlan -v` (expect 9 passed) + `python3 -m pytest bench/` (expect green) + `npm test` (expect green); (5) run the sibling-decorator audit (Step 5); (6) commit with the exact message in the plan. The Modal synthetic smoke (Step 6) is Eva's work — do NOT attempt to dispatch Modal yourself. ABSOLUTE REPO PATH: `/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem`. Verify Task 4's commit hash with `git log -1` before starting. Do NOT use `~` or `cd ~`. Do NOT modify the chunked fan-out block in `run_sweep` other than to substitute the helper call. Do NOT run `git add -A`. If `python3 -m pytest bench/modal/test_sweep_app.py` fails because of missing modal stubbing, the import-time stub block at the top of the file may need expanding — see Phase 11 Task 6's pattern in any existing `bench/modal/test_*.py` file. If you see `***` in any numeric literal, STOP and report.

---
## Task 6: λ₁ tripwire re-dispatch + decision gate evaluation + report

**Objective:** Close Phase 12 Task 7. Eva dispatches the λ₁ tripwire on LongMemEval-S using the new fan-out path; controller reads the artifact, applies the Phase 11 amendment rule, and writes the live sweep report at `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md`.

**Owner:** Eva (Modal dispatch); Controller (artifact read + decision-gate synthesis + report).

**Files:**
- Read: artifact written to `/data/runs/<ts>-lambda1_tripwire/{result.json,report.md}` on the Modal Volume + mirrored to `docs/bench/sweeps/<ts>-lambda1_tripwire.{md,json}` if `--local-out` is passed.
- Create: `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md` (rename of the local-out file with the canonical Phase 12 Task 7 stem).

**Step 1: Pre-dispatch sanity grep (Eva or controller).**

Before burning Modal time, confirm the cache is still warm. From Eva's environment:

```bash
modal volume ls starmem-bench-cache extractions | head -5
modal volume ls starmem-bench-cache extractions | wc -l
# Expected: ~16K+ entries (Phase 12 Task 6.5 warmup populated this).
# If the count is well below 16K, the cache may have been pruned —
# pause and check before dispatch.
```

**Step 2: Dispatch (Eva).**

```bash
modal run bench/modal/sweep_app.py --mode run-sweep \
    --sweep-name lambda1_tripwire --corpus longmemeval-s \
    --extractor-model "Qwen/Qwen3.6-35B-A3B-FP8" \
    --local-out docs/bench/sweeps
```

No explicit `--chunks` — heuristic gives 6 chunks × 5 cells = 30 containers. Per-chunk wall ~300s. Total expected: 5-10 min wall-clock.

**Step 3: Watch the streamed log (Eva).**

Modal's function log will stream `[diag] _modal-chunk env: ...` lines from each chunk + `[run_sweep] dispatching N chunks ...` from the orchestrator. Two things to watch for during the run:

1. **\"Dropping a ton of batches\" carryover.** Eva flagged this from the previous attempt. Watch for `[STARmem:consolidation] skipped X/Y entries (validation)` lines from `f0fab65`'s soft-fail counter. If they accumulate heavily, surface in the retro — could explain part of the slowdown observed in the pre-Phase-13 attempt.

2. **Per-chunk wall-clock variance.** Each chunk should report `wallMs` ~280-320ms in its return JSON. If chunk N consistently reports 2x what chunk 0 reported within the same cell, that's the \"slows down later\" pattern surfaced cleanly — file as Phase 14 candidate (O(n²) graph compute scaling).

**Step 4: Read the artifact (controller).**

After Eva confirms the dispatch returned cleanly:

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
ls -lt docs/bench/sweeps/ | head
# Find the freshly-mirrored {ts}-lambda1_tripwire.{md,json} pair.
```

Read the `.json` first (raw payload) and the `.md` second (rendered).

**Step 5: Apply the decision gate.**

Per Phase 11 amendment rule, for each grid point `p` ∈ {λ₁=0.5, 0.75, 1.0, 1.25, 1.5}:

```
baseline = metrics at TIER3_LAMBDA_1 = 1.0   (spec default)
candidate = metrics at p
ΔMRR = candidate.mrr - baseline.mrr
Δcoverage_pp = (candidate.coverage - baseline.coverage) * 100

if ΔMRR ≥ 0.02 AND Δcoverage_pp ≥ -5:
    DECISION_GATE = EXPAND (gate opens on at least one point)
```

Three outcomes:

- **Outcome A — Aggregate flat.** No point's ΔMRR ≥ 0.02. Two-corpus \"provably inert\" finding for λ₁. Strong v2.1 signal: LoCoMo flatness wasn't corpus artifact; structural to current graph scoring. Skip to Task 7 retro.

- **Outcome B — Task-type-only signal.** Aggregate flat but `byTaskType` shows ΔMRR ≥ 0.02 within at least one task type (likely `multi-session` or `temporal-reasoning`). Report the split; file v2.1 sub-phase for task-type-conditioned tuning. Skip 4-knob expansion.

- **Outcome C — Aggregate signal.** Gate opens. Proceed to optional Task 6.5 (4-knob expansion).

**Step 6: Write the report.**

Save the rendered report at the canonical location and write the synthesis on top of the rendered tables:

```bash
# Find the actual timestamp from the artifact
LATEST=$(ls -t docs/bench/sweeps/*-lambda1_tripwire.md | head -1)
DATE=$(basename "$LATEST" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
TARGET="docs/bench/sweeps/${DATE}-longmemeval-lambda1-live.md"
cp "$LATEST" "$TARGET"
```

Then prepend a controller-written synthesis block. Template:

```markdown
# λ₁ tripwire — LongMemEval-S (live extraction, 2026-04-XX)

**Phase 12 Task 7** (closed under Phase 13) — single-axis TIER3_LAMBDA_1 sweep, hypothesis pre-registered:
- **H₀ (null):** λ₁ is inert on LongMemEval-S, matching Phase 9.5's LoCoMo three-time reproduction.
- **H₁ (alternative):** λ₁ produces signal on multi-session corpora that LoCoMo's single-session structure suppressed.

**Grid:** `[0.5, 0.75, 1.0, 1.25, 1.5]`, TIER2_TAU_GAP=10 fixed, BATCH_SIZE=15 (cache-key alignment with Modal vLLM warm cache).
**Corpus:** LongMemEval-S (500 items, 6 task types).
**Extractor:** Qwen/Qwen3.6-35B-A3B-FP8 via Modal vLLM, temp=0 (Phase 12 Task 6.5 warm).
**Dispatch:** Phase 13 item-fan-out (6 chunks × 5 cells = 30 containers, ~Xmin wall-clock).

## Decision gate outcome: <A: flat / B: task-type signal / C: aggregate signal>

<Fill in based on the data, using the amendment rule from Step 5.>

| λ₁ | MRR | Coverage | ΔMRR vs spec default | Δcoverage_pp | Gate |
|----|-----|----------|----------------------|--------------|------|
| 0.5  | X | X | X | X | <open/closed> |
| 0.75 | X | X | X | X | <open/closed> |
| 1.0  | X | X | — (baseline) | — | — |
| 1.25 | X | X | X | X | <open/closed> |
| 1.5  | X | X | X | X | <open/closed> |

## Per-task-type breakdown

<Pull byTaskType data from each grid point's JSON. Render per-type λ₁ curves.>

### single-session-user
| λ₁ | MRR | Coverage |
|----|-----|----------|
| 0.5  | X | X |
| 0.75 | X | X |
| 1.0  | X | X |
| 1.25 | X | X |
| 1.5  | X | X |

### <each other task type>

## Phase 13 dispatch notes

- **Wall-clock breakdown:** N chunks × ~Yms/chunk; cell aggregation Zms.
- **Cache hit rate:** ~99% (warm cache from Phase 12 Task 6.5; only first-time-seen slice combinations would miss).
- **Validation skip counter (`f0fab65`):** total entriesSkipped / total added — if > 5%, flag as Phase 14 candidate.
- **Per-chunk wall-clock variance within a cell:** chunk 0 vs chunk N delta — if > 50%, surfaces \"slows down later\" suspect (O(n²) graph compute).

## Retrospective

<2-4 paragraphs:>
- What the data says (numerically; quote MRR/coverage to 4 decimals).
- Whether H₀ or H₁ survived.
- What this means for v2.1 corpus work (i.e., LongMemEval-S as the second-corpus regression for graph-tier knobs).
- Any Phase 14 candidates surfaced (slowdown pattern, validation skip rate, chunked-aggregation accuracy concerns if any).

## Sweep tables (rendered)

<Inline the original Modal-rendered single-axis report below — keep the original headlineMetrics + per-point breakdown intact.>
```

**Step 7: Commit.**

```bash
git add docs/bench/sweeps/<DATE>-longmemeval-lambda1-live.md \
        docs/bench/sweeps/<DATE>-lambda1_tripwire.json
git commit -m "feat(bench): λ₁ tripwire on LongMemEval-S — Phase 12 Task 7 closure

Single-axis TIER3_LAMBDA_1 sweep on LongMemEval-S, dispatched via
Phase 13 item-fan-out (6 chunks × 5 cells, ~Xmin wall-clock).
Decision gate per Phase 11 amendment rule: <A: aggregate flat /
B: task-type-only signal / C: aggregate signal with 4-knob expansion>.

<One-line summary of aggregate MRR spread and per-task-type finding.>

Closes Phase 12 Task 7 (was parked at commit 47bc288 due to per-cell
serial dispatch hitting Modal timeout; Phase 13 fan-out unblocked it)."
```

**Done-when:**
- [ ] Modal dispatch returned cleanly (no chunk errors, all 30 chunks accounted for)
- [ ] Artifact at `docs/bench/sweeps/<date>-longmemeval-lambda1-live.md` with synthesis + rendered tables
- [ ] Decision-gate outcome determined and documented (A/B/C)
- [ ] If Outcome C: Task 6.5 (4-knob expansion) dispatched per Phase 12 Task 7 Step 4
- [ ] Per-task-type breakdown rendered
- [ ] Retrospective section written
- [ ] Commit landed

**Subagent delegation context:** Not delegated. This task requires reading the rendered artifact and writing narrative — Controller work.

---

## Optional Task 6.5: 4-knob coordinate-descent expansion (conditional, Outcome C only)

**Trigger:** Decision gate from Task 6 fired Outcome C (aggregate ΔMRR ≥ 0.02 with Δcoverage_pp ≥ -5pp).

**Owner:** Subagent (sweep wiring) + Eva (dispatch) + Controller (synthesis).

**Files:**
- Modify: `bench/modal/sweep_app.py` — add `LONGMEMEVAL_GRAPH_ROUNDS` coordinate-descent definition matching Phase 12 Task 7 Step 4 exactly.
- Create: `docs/bench/sweeps/<date>-longmemeval-graph-extended-live.md`.

**Why optional:** Phase 9.5 reproduced λ₁ as INERT three times on LoCoMo; the prior is strongly toward Outcome A. Outcome C would be genuinely surprising. Don't pre-write the expansion plan — if it fires, it's worth its own focused planning conversation, not a pre-baked task that may not be optimally shaped for the actual signal.

**Sketch only:**
```python
LONGMEMEVAL_GRAPH_ROUNDS = [
    {"name": "lambda_1_expanded", "knob": "TIER3_LAMBDA_1",         "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
    {"name": "lambda_2",          "knob": "TIER3_LAMBDA_2",         "values": [0.1, 0.2, 0.3, 0.4, 0.5]},
    {"name": "explicit_rel",      "knob": "EXPLICIT_RELATION_WEIGHT","values": [0.5, 1.0, 1.5, 2.0, 3.0]},
    {"name": "cooccurrence",      "knob": "COOCCURRENCE_WEIGHT",    "values": [0.25, 0.5, 0.75, 1.0]},
]
```

19 cells × 6 chunks = 114 containers — over Modal's 100 free-tier ceiling. Drop to 4 chunks (114→76, fits) or use coordinate-descent (one round at a time, 5 cells × 6 chunks = 30 per round, 4 rounds sequential). Latter is cleaner — matches Phase 9.5's GRAPH_ROUNDS pattern. Decide at the time.

**Done-when:** Task 6.5 either fires and lands its own report+commit, OR is skipped (Outcome A or B) and explicitly noted as such in Task 7's retro.

---

## Task 7: Retro + ROADMAP append + Phase 14 handoff notes

**Objective:** Write `docs/plans/phase-13-retro.md`, append a Phase 13 entry to `docs/plans/ROADMAP.md §6 Phase Retro Log`, and file handoff notes for any Phase 14 candidates surfaced (slowdown patterns, validation skip rate, etc.).

**Owner:** Controller. Narrative task, no subagent.

**Files:**
- Create: `docs/plans/phase-13-retro.md`
- Modify: `docs/plans/ROADMAP.md` — append §6 entry for Phase 13.

**Phase 13 retro structure:**

```markdown
# Phase 13 Retro — Item-Level Fan-Out + λ₁ Closure (2026-04-XX)

**Plan:** [docs/plans/phase-13-item-fan-out.md](./phase-13-item-fan-out.md)
**Closure scope:** Phase 12 Task 7 (parked at commit 47bc288).
**Dispatch substrate:** Modal item-fan-out (6 chunks × 5 cells = 30 containers; ~Xmin wall-clock).

**Scope:** 7 of 7 tasks landed. (Or 8 if Task 6.5 fired.) Item-fan-out infrastructure (`run_point_chunk` + `_modal-chunk.js` + `_recompute-metrics.js` + chunk-plan helper) replaces per-cell-serial dispatch; LongMemEval-S λ₁ tripwire closed with decision-gate outcome <A/B/C>.

---

## 1. What shipped

<Per-task commits list; 7-9 commits typical.>
- `<sha>` Phase 13 plan (Task 0)
- `<sha>` `_modal-chunk.js` harness slice (Task 1)
- `<sha>` `run_point_chunk` Modal function (Task 2)
- `<sha>` `run_sweep` item-fan-out + `_recompute-metrics.js` (Task 3)
- `<sha>` `--chunks` CLI (Task 4)
- `<sha>` `_compute_chunk_plan` helper + tests (Task 5)
- `<sha>` λ₁ tripwire artifact (Task 6)
- `<sha>` (conditional) 4-knob expansion (Task 6.5)
- `<sha>` Retro + ROADMAP (Task 7)

## 2. Test totals

- pytest: <NNN> suites / <NNN> tests — all green (Phase 13 added 9 tests in TestChunkPlan)
- jest: <NNN> suites / <NNN> tests — all green (no JS test additions; `_modal-chunk.js` exercised by smoke)

## 3. Decisions held / revised

<Walk through the 10 locked decisions from the plan header. Each gets one of:
- HELD: decision survived execution unchanged.
- REVISED: brief one-line rationale.>

## 4. What worked

<2-3 bullets — e.g.>
- `_compute_chunk_plan` extraction made the chunked-fan-out math testable in pure Python — 9 tests caught two off-by-one errors during draft (chunk-size ceil + empty-chunk skip) before any Modal time was spent.
- Single-source-of-truth on metrics via `_recompute-metrics.js` — zero risk of Python+JS computeMetrics drift.
- Item-fan-out wall-clock matched the plan estimate within 10%; cache-warmed dispatch is now repeatable in <10 min for any LongMemEval-S sweep.

## 5. What didn't work / lessons

<2-3 bullets, honest. Examples:>
- <If the synthetic smoke caught a bug:> The synthetic-grid path (lines 2932-2935 in run_sweep) inlines BATCH_SIZE=15 into both grid points; this is correct for cache-key alignment but the helper extraction in Task 5 didn't initially catch a subtle interaction with `_SWEEP_BASE_OVERRIDES` (chunked path applies the overrides before constructing the chunk plan; synthetic path skips them). Documented in <commit>.
- <If \"slows down later\" reproduced:> Per-chunk wall-clock at chunk 5 was ~2.1× chunk 0 within the same cell. Confirms an O(n²)-ish graph-compute pattern. Phase 14 candidate.
- <If validation skip counter spiked:> X% of consolidation entries soft-failed validation, primarily on multi-session items. Likely signal for Phase 14 consolidation hardening.

## 6. Phase 14 candidates filed

<List anything surfaced during execution that deserves its own phase or sub-phase. Examples:>
1. **Per-chunk slowdown investigation.** If wall-clock variance within a cell exceeds 50%, suspect O(n²) graph compute. Worth a profiling sub-phase before Phase 14's headline work.
2. **Validation skip rate.** If `f0fab65`'s soft-fail counter fires heavily on LongMemEval-S, the consolidator's tolerance is too tight for the multi-session pattern. Phase 14 candidate to tune or root-cause.
3. **`run_sweep` LongMemEval support for sub-orchestrators.** Phase 12 Task 5 deferred LongMemEval-S support for `run_graph_sweep` / `run_consolidation_sweep` / `run_consolidation_batchsize_sweep` — they remain LoCoMo-only. If Outcome C fires and the 4-knob expansion validates the signal, those sub-orchestrators may want LongMemEval support too.

## 7. Handoff notes for Phase 14

<2-3 paragraphs on what Phase 14 inherits.>
- Item-fan-out is the substrate now; any future LongMemEval-S sweep dispatches via `run_sweep` automatically inherits it. No further infra work needed for the sweep mechanics.
- λ₁ on LongMemEval-S resolved as <A/B/C>. <If A:> The graph-tier inertness finding is now two-corpus and structural to the current scoring path; v2.1 graph-tier work should treat λ₁ as a fixed parameter at 1.0, not a tunable knob. <If B:> The task-type-conditioned signal opens a v2.1 sub-phase for per-task-type knob tuning. <If C:> The 4-knob expansion at Task 6.5 produced <winner summary>; integrate as Phase 14 baseline.
- The retro flag from today's failed Phase 12 Task 7 attempts (\"slows down heavily later\") was either confirmed/diagnosed or ruled out. <One-line summary.>
```

**ROADMAP append (verbatim — append to `docs/plans/ROADMAP.md` §6, before the existing `## Phase 11` heading):**

```markdown
## Phase 13—2026-04-XX

**What shipped:** Item-level fan-out for Modal sweep dispatch + closure of Phase 12 Task 7. New `run_point_chunk` + `_modal-chunk.js` + `_recompute-metrics.js` + `_compute_chunk_plan` helper replace per-cell-serial dispatch with `(cell × chunk)` flat-fan-out via `run_point_chunk.starmap`. Chunks heuristic = `max(1, items // 80)` so LoCoMo runs as 1 chunk (zero overhead, identical to pre-Phase-13 shape) and LongMemEval-S runs as 6 chunks. CLI override `--chunks K`. Decision gate on λ₁ tripwire fired Outcome <A/B/C>; <one-line summary of finding>. Phase 14 candidates filed: <count> (slowdown investigation, validation skip rate, sub-orchestrator LongMemEval support if applicable).

**Commits this phase:** <count> total. Plan (`<sha>`) → 6 task landings → optional Task 6.5 if Outcome C → retro. Phase 13 range: `<plan-sha>..HEAD`.

**Execution mode:** Hybrid. Controller owned Tasks 0, 6, 7 (narrative + Modal dispatch reading). Subagents owned Tasks 1, 2, 3, 4, 5 (mechanical + verbatim-source). Eva owned Modal dispatches (Tasks 5 smoke, 6 production). Plan-preflight audit caught <N> verbatim-code bugs before subagent dispatch. Zero sandbox-path strays. <One sentence on subagent performance, e.g. \"Tasks 2 and 3 landed first-try; Task 1 needed a re-dispatch on the chunk-coverage assertion.\">

**Post-Phase 13:**
- Item-fan-out is the default for `run-sweep` mode against any corpus ≥ 80 items.
- λ₁ on LongMemEval-S resolved as <A/B/C>; <implication for v2.1>.
- Phase 14 picks up <Phase 14 scope from retro §7>.
```

**Steps:**

1. Write `docs/plans/phase-13-retro.md` per the template above. Fill in the bracketed fields from Tasks 1-6 commits and outcomes.
2. Append the ROADMAP entry. Verify `grep -c "^## Phase " docs/plans/ROADMAP.md` increments by 1.
3. Final commit:

```bash
git add docs/plans/phase-13-retro.md docs/plans/ROADMAP.md
git commit -m "docs(plans): Phase 13 retro + ROADMAP append

Item-fan-out infrastructure shipped + Phase 12 Task 7 closed.
λ₁ tripwire decision gate: Outcome <A/B/C>. <One-line summary>.

Phase 14 candidates filed: <count>. Item-fan-out now the default
substrate for any sweep against corpora ≥ 80 items; LoCoMo paths
unchanged (heuristic gives 1 chunk, identical to pre-Phase-13 shape)."
```

**Done-when:**
- [ ] `docs/plans/phase-13-retro.md` written with all sections filled (no placeholder `<...>` text remaining)
- [ ] `docs/plans/ROADMAP.md` §6 has a Phase 13 entry above Phase 11
- [ ] Final commit landed
- [ ] `git log --oneline phase-13-plan-commit..HEAD` shows the full commit chain for the phase

---

## Phase 13 closeout checklist

After Task 7 commits:

- [ ] `git status --short` is clean
- [ ] `python3 -m pytest bench/ -v` all green
- [ ] `npm test` all green
- [ ] `docs/plans/ROADMAP.md` §6 updated
- [ ] All 7 (or 8) tasks marked done in this plan
- [ ] Eva has the synthesized λ₁ tripwire finding for any v2.1 planning use

---

## Notes on what NOT to do

- **Do not chunk LoCoMo.** The heuristic gives it 1 chunk for a reason — any chunking on a 10-item corpus is pure dispatch overhead. The `--chunks` override exists for tuning, not for forcing fan-out where it doesn't help.
- **Do not change `run_point` or the LoCoMo-only sub-orchestrators** (`run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep`). They keep their pre-Phase-13 shape; the phase is purely additive on the LongMemEval path.
- **Do not merge `_modal-chunk.js` and `_modal-point.js`** into one file with a flag. The bodies look 95% identical but the call sites are distinct (full corpus vs. slice) and Phase 12's existing dispatches need `_modal-point.js` to stay exactly as it is for cache-key continuity.
- **Do not implement metrics merge math** in Python or JS. The aggregation seam is `runs[]` concat + recompute via the existing `computeMetrics`. Anything else risks numerator/denominator drift between LoCoMo (1 chunk) and LongMemEval (6 chunks) paths.
- **Do not bump `run_point_chunk`'s timeout above 1200s** without a wall-clock measurement justifying it. The whole point of Phase 13 is that 1200s is more headroom than any chunk should ever need; if a chunk approaches the limit, the symptom is real (consolidation slowdown, cache miss fallthrough) and deserves diagnosis, not a timeout bump. See `persist-serverless-compute-results` skill: \"Don't bump timeouts when logs are empty — fix visibility first.\"
- **Do not touch `extractor_model` cache-key logic.** `Qwen/Qwen3.6-35B-A3B-FP8` is the only model that aligns with the Modal vLLM warm cache populated in Phase 12 Task 6.5. Any deviation falls through to live extraction (~$80 + 90min wall-clock). The `--extractor-model` flag MUST be passed on every Phase 13 sweep dispatch.
