# Phase 14 — v2.0 Closure Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to execute task-by-task. Every measurement task follows `benchmark-driven-constant-amendment`.

**Goal:** Close STARmem v2.0 cleanly. Ship one correctness fix backed by sweep evidence (`EXTRACT_MAX_TOKENS` 2048 → 4096, with 6144 sanity check), instrument what Phase 13 couldn't answer (cell wall-time variance, late-chunk slowdown), and demolish the remaining Tier 2 dead surface left after Phase 12 Task 1.

**Architecture:** Three independent threads of work, joined by one Modal warmup gate. Tasks 1–4 are pure controller/subagent work (schema addition, dead-code removal, renderer convention, skill writing) — they run in parallel with Eva's Modal warmup (Task 5). Once warmup lands, Task 6 ships the `EXTRACT_MAX_TOKENS` amendment as a single skill-following unit (sweep → LoCoMo regression smoke → amend + baseline refresh). Task 7 mines the chunkWalls data already produced by Task 6 to answer the variance + slowdown questions. Task 8 closes.

**Tech Stack:** STARmem v2 (vanilla JS ES2022 modules, no build step). `bench/modal/sweep_app.py` (Modal serverless dispatch), `bench/modal/vllm_warmup.py` (Volume-resident JSONL → vLLM offline batch; substrate-agnostic, takes only `--input-path` + `--max-tokens-override`), `bench/harness/fireworks-warmup.js enumerate` (host-side batch enumerator that hashes `EXTRACT_MAX_TOKENS` from `constants.js` into customIds), `bench/sweeps/*.js` (Node renderers), Python pytest + Jest unit tests. LongMemEval-S corpus on `Qwen/Qwen3.6-35B-A3B-FP8` via Modal vLLM. v2.0 closure means: no architectural shifts, no λ₁ structural fix (deferred to v2.1).

---

## Decisions locked before writing this plan (see conversation 2026-04-26)

1. **EXTRACT_MAX_TOKENS amendment is a correctness fix, not efficiency.** `extractFacts.js:73-76` documents the truncation bug — Modal vLLM warmup wrote truncated responses to disk on dense LongMemEval-S batches under `EXTRACT_MAX_TOKENS=2048` + `BATCH_SIZE=15`. Bumping to 4096 is required for cache integrity, not optimisation.
2. **Sweep grid is `{2048, 4096, 6144}` on LongMemEval-S.** 2048 reproduces the truncation finding numerically; 4096 is the proposed amendment; 6144 is a sanity check. Eva expects 6144 to shift MRR slightly but not change the verdict.
3. **Single-cell LoCoMo regression smoke at the winner only** (probably 4096). EXTRACT_MAX_TOKENS isn't corpus-specific in mechanism but the truncation evidence is LongMemEval-S-specific; one cell catches any LoCoMo regression cheaply.
4. **No λ₁ re-run.** Truncation moves items into `n_skipped`, not silently into `n_scored` with bad scores. The two-corpus inert verdict from Phase 12 (reproduced 4× across 9.4.8/9.4.9/9.5/12 lambda1_tripwire) stands on uncorrupted scored-pool data. λ₁ structural fix is a v2.1 project.
5. **Cache invalidation is the gate.** `_modal-warmup-point.js` cache key is `(model, messages, maxTokens)`. Bumping `EXTRACT_MAX_TOKENS` from 2048 → 4096 invalidates 100% of the existing extraction cache. Two warmup runs (4096 full + 6144 full) are a Phase 14 prerequisite, not hidden sweep cost.
6. **Tier 2 demolition follow-through.** Phase 12 Task 1 removed the runtime `if (t2.hit)` branch. Constants `TIER2_TAU_CONFIDENCE` / `TIER2_TAU_GAP` (`constants.js:80,82`), the `tau` sweep config (`sweep_app.py:2002-2014`), `render_tau_report` (`sweep_app.py:1587`, `rerender.py:76,120`), `bench/sweeps/tau.js`, and `_SWEEP_BASE_OVERRIDES["hops"|"relw"]` entries all remain. The `tau` sweep is now vacuous-by-construction. Remove all of it.
7. **Renderer-signature cleanup is mechanical.** Phase 11 retro flagged `graph.js`'s `renderReport({ baselineResult, roundResults, corpus, primaryMetric })` (object) vs sibling `tau.js` / `bm25.js` / `consolidation.js` `renderReport(result, corpus, ...)` (positional). Standardise to positional. No semantic change.
8. **`chunkWalls: List[int]` schema lives on the cell record** (post-concat in `sweep_app.py:3231`), not the chunk record. Cell-level is the right granularity — readers ask "how did this λ₁=1.0 cell's chunks vary?", not "what was chunk 3's wall?" Keep `wallMs` (cell wall = max chunk wall) for backward compat alongside.
9. **Sequencing.** Tasks 1–4 run in parallel with Task 5's Modal warmup window. Tasks 6–8 are sequential after 5 lands. Decision lock prevents any subagent from blocking on Eva.
10. **Plan size target ~800 lines.** Smaller than Phase 13 (1640) because verbatim sources only required for Task 1 (schema concat), Task 2 (tau removal patches), and Task 6 (sweep config + dispatch). Tasks 3, 4, 5, 7, 8 reference existing files / skills.

---

## Task list

| # | Task | Owner | Wall | Cost |
|---|---|---|---|---|
| 0 | Plan commit | Controller | — | — |
| 1 | Add `chunkWalls: List[int]` to cell record schema | Subagent | small | — |
| 2 | Tier 2 dead-code removal (constants + sweep config + `tau.js` + `render_tau_report` + base overrides) | Subagent | small | — |
| 3 | Renderer-signature convention cleanup (`graph.js` object → positional) | Subagent | small | — |
| 4 | `modal-cell-timeout-sizing` skill | Controller | small | — |
| 5 | Modal vLLM re-warmup at `EXTRACT_MAX_TOKENS={4096, 6144}` on LongMemEval-S | Eva (Modal) | ~2-3h | ~$10-16 |
| 6 | EXTRACT_MAX_TOKENS sweep `{2048, 4096, 6144}` on LongMemEval-S → LoCoMo regression smoke at winner → amend constant + refresh `baseline.json` (single skill-following task per `benchmark-driven-constant-amendment`) | Subagent (wiring) + Eva (Modal) + Controller (synthesis) | ~30 min Modal + analysis | warm cache + ~$0.10 |
| 7 | Cell variance + late-chunk slowdown analysis using Task 6's `chunkWalls` data | Controller | analysis only | — |
| 8 | Retro + ROADMAP | Controller | small | — |

**Dependency graph:**
```
0  →  ┌─ 1, 2, 3, 4 ─┐  →  6  →  7  →  8
      └─ 5 ──────────┘
```

**Skills that apply:**
- Task 6 → `benchmark-driven-constant-amendment` (canonical four-surface dance: constant, spec, guard test, mechanism tests)
- Task 4 produces a new skill (or extends `persist-serverless-compute-results`)

---

## Task 0: Commit this plan

**Objective:** Stabilise the plan file as the canonical reference for Tasks 1–8. Subagents downstream read it directly without needing the conversation history.

**Files:**
- Create: `docs/plans/phase-14-v2-closure.md` (this file)

**Step 1: Verify file exists and has expected line count**

```bash
wc -l docs/plans/phase-14-v2-closure.md
# Expected: 700-900 lines
grep -c "^## Task " docs/plans/phase-14-v2-closure.md
# Expected: 9 (tasks 0–8)
```

**Step 2: Verify no `***` redactions snuck in**

```bash
grep -n "= \*\*\*\|=\*\*\*" docs/plans/phase-14-v2-closure.md
# Expected: empty output. Any hits = secrets-guard redaction; patch back the literal value.
```

**Step 3: Commit**

```bash
git add docs/plans/phase-14-v2-closure.md
git commit -m "docs(plans): phase 14 v2.0 closure plan

9-task plan, decisions §1-10. Tasks 1-4 parallelise with Task 5
Modal warmup. Task 6 follows benchmark-driven-constant-amendment
for the EXTRACT_MAX_TOKENS 2048 → 4096 correctness fix. Tasks
7-8 close v2.0; v2.1 (lambda1 structural fix) deferred."
```

**Verification:** `git log -1 --oneline` shows the commit; the plan file is the only delta.

---

## Task 1: `chunkWalls: List[int]` schema addition

**Objective:** Capture per-chunk wall times on every multi-chunk cell record so Phase 13's variance + slowdown questions become answerable from any sweep dispatched after this lands. Backward-compatible: `wallMs` (cell wall = max chunk wall) stays.

**Files:**
- Modify: `bench/modal/sweep_app.py` (lines ~3225-3262, the cell-record concat block)
- Modify: `bench/modal/tests/test_sweep_app.py` (or nearest sibling test) — add a chunkWalls assertion
- Modify: `docs/specs/2026-04-20-starmem-v2-design.md` if the spec defines the cell record shape (controller verifies first)

**Step 1: Verify current schema location**

```bash
sed -n '3225,3265p' bench/modal/sweep_app.py
```

Expected output includes `max_chunk_wall = 0` initialisation and the per-chunk loop that updates it; the `points.append({...})` block that builds the cell record.

**Step 2: Write failing test**

Append to `bench/modal/tests/test_sweep_app.py` (or create a new test file if no sibling exists — controller checks first via `ls bench/modal/tests/`):

```python
def test_cell_record_includes_chunkWalls(monkeypatch, tmp_path):
    """Cell record schema must include chunkWalls: List[int] per Phase 14 Task 1."""
    # Arrange: synthesise two chunk results with distinct wallMs values
    chunks_by_cell = {
        0: [
            (0, {"overrides": {"X": 1}, "runs": [], "wallMs": 1500}),
            (1, {"overrides": {"X": 1}, "runs": [], "wallMs": 2300}),
            (2, {"overrides": {"X": 1}, "runs": [], "wallMs": 1800}),
        ],
    }
    # Act: feed through the cell-record builder (extract logic into helper if not already)
    # Assert: cell record has chunkWalls=[1500, 2300, 1800] in chunk order
    #         AND wallMs == max(chunkWalls) == 2300 (backward compat)
    ...
```

Run: `cd /repo && pytest bench/modal/tests/test_sweep_app.py::test_cell_record_includes_chunkWalls -v`
Expected: FAIL — `KeyError: 'chunkWalls'` on the cell record.

**Step 3: Implement**

Patch `bench/modal/sweep_app.py` — the cell-record concat block. The current loop at ~line 3228:

```python
        # Concat runs[] across chunks for this cell.
        concat_runs = []
        max_chunk_wall = 0
        cell_overrides = cell_chunks[0][1].get("overrides", {})
        for (_chi, chunk) in cell_chunks:
            concat_runs.extend(chunk.get("runs", []))
            max_chunk_wall = max(max_chunk_wall, chunk.get("wallMs", 0))
```

becomes:

```python
        # Concat runs[] across chunks for this cell.
        # Phase 14 Task 1: also collect per-chunk wall times in chunk-index
        # order so variance + late-chunk-slowdown analysis can read them
        # off any post-Phase-14 cell record. wallMs (cell wall = max chunk
        # wall) stays for backward compat.
        concat_runs = []
        max_chunk_wall = 0
        chunk_walls = []
        cell_overrides = cell_chunks[0][1].get("overrides", {})
        for (_chi, chunk) in cell_chunks:
            concat_runs.extend(chunk.get("runs", []))
            chunk_wall = chunk.get("wallMs", 0)
            chunk_walls.append(chunk_wall)
            max_chunk_wall = max(max_chunk_wall, chunk_wall)
```

And the `points.append({...})` block at ~line 3257:

```python
        points.append({
            "overrides": cell_overrides,
            "metrics": recompute_out["metrics"],
            "aggStats": recompute_out.get("aggStats"),
            "latencyMs": latency_p50_p95,
            "runCount": len(concat_runs),
            "wallMs": max_chunk_wall,   # cell wall = max chunk wall (parallel)
            "chunkWalls": chunk_walls,  # Phase 14: per-chunk wall in dispatch order
            "chunksRun": len(cell_chunks),
            "totalChunks": n_chunks,
        })
```

**Step 4: Verify test passes**

```bash
pytest bench/modal/tests/test_sweep_app.py::test_cell_record_includes_chunkWalls -v
```
Expected: PASS.

**Step 5: Run full pytest + jest suites**

```bash
pytest bench/modal/tests/ -v
npm test
```
Expected: All green. No existing test reads `chunkWalls`, so additive field can't break anything.

**Step 6: Commit**

```bash
git add bench/modal/sweep_app.py bench/modal/tests/
git commit -m "feat(bench): chunkWalls per-chunk wall times on cell record

Phase 14 Task 1. Additive schema field on multi-chunk cell records
captured in chunk-index dispatch order. wallMs (cell wall = max
chunk wall) preserved for backward compat. Enables Phase 14 Task 7
analysis of cell wall-time variance and late-chunk slowdown that
Phase 13 retro filed against future work."
```

---

## Task 2: Tier 2 dead-code removal

**Objective:** Demolish the remaining Tier 2 surface left after Phase 12 Task 1's runtime fix. The `if (t2.hit)` branch is gone, so `TIER2_TAU_CONFIDENCE` / `TIER2_TAU_GAP` no longer affect retrieval, the `tau` sweep is vacuous-by-construction, and `_SWEEP_BASE_OVERRIDES` entries that inline `TIER2_TAU_GAP=10` into other sweeps are architecturally meaningless.

**Files:**
- Modify: `src/core/constants.js` — remove `TIER2_TAU_CONFIDENCE`, `TIER2_TAU_GAP` from `RETRIEVAL` block; remove from `_SWEPT_RETRIEVAL_KEYS`
- Modify: `src/retrieval/tier2-bm25.js` — remove the `hit` field from the return shape (callers post-Phase-12 don't read it; verify with grep)
- Modify: `src/retrieval/ladder.js` — remove the stale comment block referencing `TIER2_TAU_*` constants (lines ~190-200)
- Delete: `bench/sweeps/tau.js`
- Modify: `bench/modal/sweep_app.py` — remove `render_tau_report` (line ~1587), remove `"tau"` from `SWEEP_CONFIGS` (line ~2002), remove `TIER2_TAU_GAP` from `_SWEEP_BASE_OVERRIDES["hops"]` and `_SWEEP_BASE_OVERRIDES["relw"]` (lines ~1989-2000)
- Modify: `bench/modal/rerender.py` — remove the `render_tau_report` import (line ~76) and the tau dispatch branch (line ~120)
- Delete: `tests/unit/retrieval/tau-*.test.js` if any still exist (verify first)
- Modify: `tests/unit/core/constants.test.js` — remove the `TIER2_TAU_CONFIDENCE` / `TIER2_TAU_GAP` assertions
- Modify: `tests/unit/retrieval/tier2-bm25.test.js` — remove `hit`-related assertions if any survive (Phase 12 Task 1 should have already cleaned these but verify)

**Step 1: Inventory grep — confirm everything still referenced will be touched**

```bash
grep -rn "TIER2_TAU_CONFIDENCE\|TIER2_TAU_GAP\|render_tau_report\|sweeps/tau\.js\|\"tau\":\|'tau'" src/ bench/ tests/ docs/specs/ \
  | grep -v "^docs/plans/\|^docs/bench/sweeps/\|^docs/bench/baseline\.json\|^docs/bench/runs/"
```

Filter the output:
- **Edit/delete:** `src/`, `bench/sweeps/`, `bench/modal/`, `tests/` matches
- **Leave alone (historical record):** `docs/plans/*` (retros and prior plans), `docs/bench/sweeps/*-tau*.md`, `docs/bench/baseline.json::tuned.TIER2_TAU_GAP`, `docs/bench/runs/*-tau*`

The provenance trail in `baseline.json::tuned` and the `docs/bench/sweeps/*-tau*.md` artifacts is the historical record of why this knob was held / amended. Don't touch it.

**Step 2: Patch `src/core/constants.js`**

Remove lines 79-82 from the `RETRIEVAL` block (the `TIER2_TAU_CONFIDENCE` and `TIER2_TAU_GAP` entries with their docstrings). Then remove the corresponding entries from `_SWEPT_RETRIEVAL_KEYS` (lines ~189-190).

Use `patch` (uniqueness verified — `TIER2_TAU_GAP` appears in `RETRIEVAL` block exactly once for the value, once for the swept-keys entry).

**Step 3: Patch `src/retrieval/tier2-bm25.js`**

Read the current `tier2()` return shape:

```bash
grep -n "return\|hit" src/retrieval/tier2-bm25.js | head -20
```

If `hit` is still computed and returned, remove the `hit` computation (line ~101) and drop the field from the return object. The function continues to return `{ scored }` (the BM25-ranked candidate list).

**Step 4: Patch `src/retrieval/ladder.js`**

Remove the stale Tier-2 docstring block at lines ~190-200 (still referencing the old gating). Replace with a concise comment that names the post-demolition role (Tier 2 = BM25 candidate provider for Tier 3 seeding). Verify the runtime path is already gone — Phase 12 Task 1 commit `707e975` parent removed `if (t2.hit)`.

**Step 5: Delete `bench/sweeps/tau.js`**

```bash
git rm bench/sweeps/tau.js
```

**Step 6: Patch `bench/modal/sweep_app.py`**

Three patches:

1. **Remove `render_tau_report`** — the entire function definition starting at line ~1587. Read the bounds first via `grep -n "^def render_" bench/modal/sweep_app.py` to find the next function.

2. **Remove `"tau"` from `SWEEP_CONFIGS`** — the dict entry at line ~2003. Use `patch` with the entire `"tau": { ... }` block as `old_string`.

3. **Remove `TIER2_TAU_GAP` from `_SWEEP_BASE_OVERRIDES`** — the `"hops"` and `"relw"` entries. The `"lambda1_tripwire"` entry keeps `BATCH_SIZE=15` and `WORKING_BUFFER_THRESHOLD=15` but loses `TIER2_TAU_GAP: 10`.

Diff for `_SWEEP_BASE_OVERRIDES`:

```python
# Before:
_SWEEP_BASE_OVERRIDES = {
    "hops": {"TIER2_TAU_GAP": 10},
    "relw": {"TIER2_TAU_GAP": 10},
    "lambda1_tripwire": {"TIER2_TAU_GAP": 10, "BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15},
}

# After:
# Phase 14 Task 2: TIER2_TAU_GAP entries removed — Tier 2 demolition (Phase
# 12 Task 1 + Phase 14 Task 2) means these inlines are architecturally
# meaningless. lambda1_tripwire keeps BATCH_SIZE + WORKING_BUFFER_THRESHOLD
# for cache-key alignment with the warmed Modal vLLM extraction cache.
_SWEEP_BASE_OVERRIDES = {
    "lambda1_tripwire": {"BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15},
}
```

(Note: `hops` and `relw` keys disappear entirely — empty dict isn't worth a key.)

**Step 7: Patch `bench/modal/rerender.py`**

Remove the `render_tau_report` import (line ~76) and the `if payload["sweep"] == "tau":` dispatch branch (line ~120). Run `grep -n "tau" bench/modal/rerender.py` to verify nothing else references it.

**Step 8: Patch `tests/unit/core/constants.test.js`**

Remove the assertions on `TIER2_TAU_CONFIDENCE` and `TIER2_TAU_GAP`. Run the test file alone first to confirm it's the only test surface that needs editing:

```bash
grep -rn "TIER2_TAU_CONFIDENCE\|TIER2_TAU_GAP" tests/
```

**Step 9: Run full test suites**

```bash
npm test
pytest bench/modal/tests/ -v
npm run lint
npm run typecheck
```
Expected: All green. If anything fails on `tau`-named symbols, it's a missed reference — grep again.

**Step 10: Commit**

```bash
git add -A
git commit -m "refactor(retrieval): demolish remaining Tier 2 surface

Phase 14 Task 2. Phase 12 Task 1 removed the runtime if (t2.hit)
branch; this commit removes the now-dead constants, sweep config,
renderer, and base-overrides entries:

- src/core/constants.js: drop TIER2_TAU_CONFIDENCE, TIER2_TAU_GAP
- src/retrieval/tier2-bm25.js: drop unused hit field from return
- src/retrieval/ladder.js: docstring cleanup (no behavioural delta)
- bench/sweeps/tau.js: deleted (sweep is vacuous-by-construction)
- bench/modal/sweep_app.py: drop render_tau_report, SWEEP_CONFIGS[tau],
  _SWEEP_BASE_OVERRIDES[hops|relw]
- bench/modal/rerender.py: drop tau import + dispatch branch
- tests/unit/core/constants.test.js: drop tau-knob assertions

baseline.json::tuned.TIER2_TAU_GAP and docs/bench/sweeps/*-tau*.md
preserved as historical provenance per benchmark-driven-constant-amendment."
```

---

## Task 3: Renderer-signature convention cleanup

**Objective:** Standardise sweep renderer signatures to positional `(result, corpus, ...optional)` per `tau.js` / `bm25.js` / `consolidation.js` pattern. `bench/sweeps/graph.js` is the only outlier with object-arg `renderReport({ baselineResult, roundResults, corpus, primaryMetric })`. Phase 11 retro flagged this; Phase 14 closes it.

**Files:**
- Modify: `bench/sweeps/graph.js` (line ~132 signature, line ~238 call site)
- Modify: any renderer-shape tests in `bench/modal/tests/` — verify first via grep

**Step 1: Verify the outlier**

```bash
grep -n "function renderReport" bench/sweeps/*.js
```

Expected:
```
bench/sweeps/bm25.js:137:function renderReport(result, corpus, tagsStats) {
bench/sweeps/consolidation.js:129:function renderReport(result, corpus, primaryMetric) {
bench/sweeps/graph.js:132:function renderReport({ baselineResult, roundResults, corpus, primaryMetric }) {
bench/sweeps/tau.js:108:function renderReport(result, corpus) {     # gone after Task 2
```

`graph.js` is the outlier.

**Step 2: Read graph.js renderReport body**

```bash
sed -n '130,170p' bench/sweeps/graph.js
```

Identify the four destructured fields and how they're used inside the body.

**Step 3: Convert to positional**

New signature: `renderReport(result, corpus, primaryMetric)` where `result = { baselineResult, roundResults }` (both fields under one object — that's the natural shape from the upstream sweep harness).

Patch the function definition:

```js
// Before:
function renderReport({ baselineResult, roundResults, corpus, primaryMetric }) {
    // ... body uses baselineResult, roundResults, corpus, primaryMetric directly ...
}

// After:
/**
 * @param {{baselineResult: object, roundResults: object[]}} result
 * @param {string} corpus
 * @param {string} primaryMetric
 */
function renderReport(result, corpus, primaryMetric) {
    const { baselineResult, roundResults } = result;
    // ... rest of body unchanged ...
}
```

**Step 4: Update the call site**

Find the upstream call (line ~238):

```bash
sed -n '230,245p' bench/sweeps/graph.js
```

Repackage the args:

```js
// Before:
await writeFile(outPath, renderReport({ baselineResult, roundResults, corpus, primaryMetric }), 'utf8');

// After:
const result = { baselineResult, roundResults };
await writeFile(outPath, renderReport(result, corpus, primaryMetric), 'utf8');
```

**Step 5: Run tests**

```bash
npm test
npm run lint
npm run typecheck
```
Expected: All green. If `graph.js` has a unit test that checks the signature, update it to match.

**Step 6: Commit**

```bash
git add bench/sweeps/graph.js tests/
git commit -m "refactor(bench): graph.js renderReport positional signature

Phase 14 Task 3. Bring graph.js into alignment with bm25/consolidation
sibling pattern: renderReport(result, corpus, primaryMetric) where
result = { baselineResult, roundResults }. Flagged in Phase 11 retro
§6.10. No behavioural delta — same fields, same output."
```

---

## Task 4: `modal-cell-timeout-sizing` skill

**Objective:** Codify the worst-case-cell timeout-sizing pattern surfaced by Phase 13 Decision 7 (timeout 1200s → 3000s revision). The pattern lives in `writing-plans` as one paragraph under "Compute worst-case per-cell wall-clock vs timeout" — Phase 13's revision gives it a concrete LongMemEval-S example worth promoting to its own skill (or extending `persist-serverless-compute-results`).

**Decision: standalone skill or extension?**

Read both candidates first:

```bash
ls ~/.hermes/profiles/hanami/skills/devops/persist-serverless-compute-results/ 2>&1
ls ~/.hermes/profiles/hanami/skills/devops/ | grep modal
```

If `persist-serverless-compute-results` already covers Modal worst-case sizing as a sub-pattern, extend it. Otherwise create `modal-cell-timeout-sizing` as a standalone in `~/.hermes/profiles/hanami/skills/devops/`.

**Skill content outline:**

- **When to use:** Sizing per-cell timeout for Modal (or any serverless) sweep where workload shape varies by knob value (cache-miss Pattern 2 from `sweep-cache-invalidation-audit`).
- **The arithmetic:** `worst_case_sec = max_calls_per_cell(most_expensive_grid_value) × live_compute_latency_sec_p95`. Multiply by 2× for jitter headroom. Worst-case cell is usually the smallest grid value of a "smaller = more calls" knob.
- **Phase 13 worked example:**
  - LongMemEval-S full corpus = 6 chunks × ~83 items.
  - `lambda1_tripwire` per-cell at λ₁=0.5 with full extraction at `BATCH_SIZE=15` + `WORKING_BUFFER_THRESHOLD=15`.
  - Worst observed cell wall: 1381s. Pre-revision timeout 1200s → 5 cells dispatched, 1 hit `FunctionTimeoutError`. Post-revision timeout 3000s → comfortable headroom.
  - Lesson: 1.5× of *measured* p95 for cells with cache hits ≠ 1.5× of *worst-case live extraction* if the cache went cold mid-cell.
- **Cache-miss compounding:** When the swept knob participates in the cache key (`EXTRACT_MAX_TOKENS`, `BATCH_SIZE`, `WORKING_BUFFER_THRESHOLD` all do — see `extractFacts.js:cacheKey`), worst case = full live re-extraction even on a "warm" run. Plan timeout against this scenario, not against best-case warm wall.
- **Failure surface:** Modal's `FunctionTimeoutError` SIGKILLs the worker. `volume.commit()` only fires on clean function exit, so timeout = lost work for that cell. Phase 9.5 lost ~1700 live Nano-GPT calls this way before the conversation-level-split redesign.
- **Mitigation ladder:**
  1. **Right-size the timeout.** Cheapest fix when worst-case is bounded.
  2. **Conversation-level-split.** Bound per-container workload structurally (Phase 11 redesign).
  3. **Mid-subprocess `volume.commit()` via threading.** Last resort; complicates error handling.

**Files:**
- Create: `~/.hermes/profiles/hanami/skills/devops/modal-cell-timeout-sizing/SKILL.md` (or amend `persist-serverless-compute-results/SKILL.md`)

**Step 1: Decide standalone vs amend**

Read `persist-serverless-compute-results` SKILL.md if it exists. If it already has a "Worst-case cell sizing" or similar section, amend. Otherwise standalone.

**Step 2: Write SKILL.md**

Use `skill_manage` (action: `create` for standalone, action: `patch` for amend). Include:

- Frontmatter: `name`, `description`, `tags: [modal, serverless, benchmarking, capacity-planning]`, `related_skills: [sweep-cache-invalidation-audit, persist-serverless-compute-results, llm-benchmark-shape-matching]`
- Body: when-to-use, the arithmetic, the Phase 13 worked example, cache-miss compounding, failure surface, mitigation ladder.

**Step 3: Verify the skill loads**

```bash
# In a fresh subagent or:
skills_list category="devops" | grep modal-cell-timeout
```

Expected: skill is present.

**Step 4: Commit (skills live in profile, not the repo — controller commits the skill via skill_manage; verify via session_search after if needed)**

`skill_manage` writes directly to the profile. No git commit needed in `STARmem` repo.

---

## Task 5: Modal vLLM re-warmup at `EXTRACT_MAX_TOKENS={4096, 6144}`

**Objective:** Pre-populate the on-disk extraction cache for the two new `EXTRACT_MAX_TOKENS` values so Task 6's sweep can dispatch warm. The 2048 cache from Phase 12 Task 6.5 stays for the sweep's reproduction-of-truncation cell. Cache key is `(model, messages, maxTokens)` per `_modal-warmup-point.js` — bumping `EXTRACT_MAX_TOKENS` invalidates 100% of the existing cache for that grid point.

**Owner: Eva (Modal dispatch).**

**Files:**
- Used: `node bench/harness/fireworks-warmup.js enumerate` — host-side enumerator. Pulls `EXTRACT_MAX_TOKENS` from `src/core/constants.js` directly (no flag override exists). Output: a JSONL where every row's `customId` hashes `(model, messages, EXTRACT_MAX_TOKENS)` per `extractionCache._cacheKey`.
- Used: `bench/modal/vllm_warmup.py` — substrate-agnostic Modal warmup. Reads a Volume-resident JSONL (default `/data/warmup-input.jsonl`, `--input-path` overrides). Has no `--corpus` / `--batch-size` / `--extract-max-tokens` flags — those live on the enumerator side. The `--max-tokens-override` flag here only caps `SamplingParams.max_tokens` at dispatch and **does not change customIds**, so it cannot retarget cache writes to a different `EXTRACT_MAX_TOKENS` shard.
- Used: existing Phase 12 Task 6.5 corpus enumerator at `BATCH_SIZE=15` shape, `Qwen/Qwen3.6-35B-A3B-FP8` model.

**Cache-key correctness:** because `EXTRACT_MAX_TOKENS` is hashed into `customId` at enumerate time, the warmup must be done in the constant's reality — temporarily edit `src/core/constants.js`, enumerate, upload, run, revert. Three `EXTRACT_MAX_TOKENS` shards = three constants edits = three enumerator runs = three uploads = three Modal warmups. There is no shortcut. (For Phase 15, wire `--extract-max-tokens` through `enumerate.js` to drop this dance — out of scope for v2.0 closure.)

**Step 1: Sanity-check the harness at the current 2048 default**

No constants edit needed; current default is 2048. Tiny enumeration + upload + warmup, ~$0.10, ~3 min. Confirms harness is healthy before committing $10–16 of Modal time.

```bash
# enumerate 5 batches at the current EXTRACT_MAX_TOKENS=2048 (matching Phase 12 Task 6.5 cache shard)
node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input-2048-smoke.jsonl \
  --corpora longmemeval-s \
  --batch-size 15 \
  --limit 5
modal volume put starmem-bench-data /tmp/warmup-input-2048-smoke.jsonl /warmup-input-2048-smoke.jsonl
modal run bench/modal/vllm_warmup.py \
  --input-path /data/warmup-input-2048-smoke.jsonl \
  --skip-existing
```

Expected: `warmedCount=0` (5 items already cached at 2048 from Phase 12 Task 6.5), `failedCount=0`. If `warmedCount=5` instead of 0, the Phase 12 cache shard is missing or the enumerator is producing different customIds than Phase 12 — pause and diagnose, don't proceed to Steps 2–3.

**Note (Phase 14 hotfix 2026-04-26):** if a `--skip-existing` full-corpus enumeration was accidentally dispatched at the unchanged 2048 default (the canonical example: a no-op `sed` against the wrong path or wrong syntax silently leaves the constant unedited), the result is identical to a maxed-out Step 1: `dispatched=0, skippedExisting=16682, perPromptFailures=0`, and is by definition ≤ Step 1's signal because it covers the full corpus. **That counts as Step 1 passing**; skip the explicit smoke and proceed to Step 2 with the sanity already in hand.

**Step 2: Full warmup at 4096**

```bash
# 1. Bump the constant locally (NOT committed; reverted at end of step). The
#    constant lives in src/consolidation/extractFacts.js as a top-level export
#    `export const EXTRACT_MAX_TOKENS = 2048;` (NOT in src/core/constants.js,
#    NOT object-key syntax — sed must match the exact form including spaces).
sed -i 's/EXTRACT_MAX_TOKENS = 2048/EXTRACT_MAX_TOKENS = 4096/' src/consolidation/extractFacts.js
git diff src/consolidation/extractFacts.js  # MUST show one-line change; if empty, sed no-op'd, halt.

# 2. Enumerate at the new value (customIds will encode 4096)
node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input-4096.jsonl \
  --corpora longmemeval-s \
  --batch-size 15

# 3. Upload to Modal Volume
modal volume put starmem-bench-data /tmp/warmup-input-4096.jsonl /warmup-input-4096.jsonl

# 4. Warmup
modal run bench/modal/vllm_warmup.py \
  --input-path /data/warmup-input-4096.jsonl \
  --skip-existing

# 5. Revert extractFacts.js — Task 5.5 will properly unlock the constant for
#    runtime override; the on-disk default stays 2048 until Task 6's amend.
git checkout src/consolidation/extractFacts.js
```

Expected: ~2-3h wall-clock (Phase 12 Task 6.5 measured ~74-min worst-case at 1.5K out tok/s; 4096 max output is twice the 2048 ceiling but most batches won't hit it — closer to 2× p95 = ~10-15% slowdown on average). `warmedCount=16,682` (full LongMemEval-S × `BATCH_SIZE=15`), `failedCount=0`.

If `failedCount > 0`, inspect the diagnostics report; common causes are vLLM engine OOM on dense batches (Decision 7 from `phase-12-task-6-5-modal-vllm-warmup.md`).

**Step 3: Full warmup at 6144**

Same shape as Step 2, with `4096` → `6144` everywhere:

```bash
sed -i 's/EXTRACT_MAX_TOKENS = 2048/EXTRACT_MAX_TOKENS = 6144/' src/consolidation/extractFacts.js
git diff src/consolidation/extractFacts.js  # MUST show one-line change

node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input-6144.jsonl \
  --corpora longmemeval-s \
  --batch-size 15

modal volume put starmem-bench-data /tmp/warmup-input-6144.jsonl /warmup-input-6144.jsonl

modal run bench/modal/vllm_warmup.py \
  --input-path /data/warmup-input-6144.jsonl \
  --skip-existing

git checkout src/consolidation/extractFacts.js
```

Expected: similar wall to the 4096 warmup or slightly longer (most batches still well under 6144).

**Step 4: Sanity-verify the three shards coexist**

```bash
modal volume ls starmem-bench-cache extractions/ | wc -l
# Expect: ~3× the per-shard count from Phase 12 Task 6.5. Three customId shards
# (each shard = one EXTRACT_MAX_TOKENS value) coexist; cache files are
# customId-keyed so different shards live as different filenames.
```

**Step 5: Eva reports back to controller**

Eva pings controller with: total warmup time, cost (Modal dashboard), `warmedCount` / `failedCount` per dispatch, and a one-line pass/fail. Controller proceeds to Task 5.5 → Task 6 only if both warmups report `failedCount=0`. If `failedCount > 0` in either, Phase 14 pauses for diagnosis (likely a Decision 7-class issue).

**Pre-flight tripwire (added 2026-04-26 after the `--corpus`/`--extract-max-tokens`/`--batch-size` flag drift was caught on a `modal run -h` probe; refined after a no-op-sed misfire on the 4096 dispatch):** before each step, `git diff src/consolidation/extractFacts.js` must show the expected one-line bump (NOT empty — empty = sed didn't match), and `node bench/harness/fireworks-warmup.js enumerate -h 2>&1 | head` must confirm the enumerator's flag surface hasn't drifted from this plan. The plan's commands are tied to two surfaces (Node enumerator + Modal warmup); a flag rename in either, OR a constant-path or syntax drift in extractFacts.js, silently re-targets cache writes at zero error signal.

**No commit:** Task 5 produces no source-tree changes. Cache state lives on the Modal Volume. The `git checkout src/consolidation/extractFacts.js` at end of Steps 2 and 3 reverts the temporary local edit.

---

## Task 5.5: Unlock `EXTRACT_MAX_TOKENS` for runtime sweep override

**Objective:** Refactor `EXTRACT_MAX_TOKENS` from a top-level `const` export in `src/consolidation/extractFacts.js` into the `CONSOLIDATION` group in `src/core/constants.js`, then add to `_SWEPT_CONSOLIDATION_KEYS`. This is a precondition for Task 6: the sweep mechanism mutates `RETRIEVAL[key]` / `CONSOLIDATION[key]` in place, but a top-level `const` binding is immutable, so `setConstantOverrides({ EXTRACT_MAX_TOKENS: N })` cannot land. Task 6 as originally drafted ("add to `_SWEPT_RETRIEVAL_KEYS`") would be a no-op without the move.

**Owner:** Subagent (mechanical refactor; full skill recipe is `unlock-knob-for-runtime-sweep`). Controller dispatches with the skill name in context.

**Architectural note:** `EXTRACT_MAX_TOKENS` belongs in `CONSOLIDATION`, not `RETRIEVAL`. It governs the consolidation-time extraction LLM call ceiling, not the retrieval ladder. Sits semantically next to `BATCH_SIZE` and `WORKING_BUFFER_THRESHOLD`.

**Files (preflight grep confirms 4 reader sites + 1 declarer + 1 test file):**
- Modify: `src/consolidation/extractFacts.js` — drop the top-level `export const EXTRACT_MAX_TOKENS = 2048;`, drop the import-side dependents, change the call-site at L260 to read `CONSOLIDATION.EXTRACT_MAX_TOKENS` at call time
- Modify: `src/core/constants.js` — add `EXTRACT_MAX_TOKENS: 2048` inside the `CONSOLIDATION` block (next to `BATCH_SIZE`); add `'EXTRACT_MAX_TOKENS'` to `_SWEPT_CONSOLIDATION_KEYS` Object.freeze list
- Modify: `bench/harness/fireworks-warmup.js` (L22, L291, L336, L369) — change import + 3 call sites to read through `CONSOLIDATION.EXTRACT_MAX_TOKENS` at call time. **No module-top destructure** — that would re-snapshot the value and silently swallow Task 6's overrides.
- Modify: `bench/harness/_modal-warmup-point.js` (L59, L139) — same call-time-read rewrite.
- Modify: `tests/unit/core/swept-constants-overridable.test.js` — add the round-trip test for `EXTRACT_MAX_TOKENS` per the skill's TDD step. The auto-generated destructure-guard loop picks up the new key automatically.

**Step 1: Skill recipe**

Follow `software-development/unlock-knob-for-runtime-sweep` end-to-end. Steps 1–7 of that skill map directly: write the round-trip test (RED), add to `_SWEPT_CONSOLIDATION_KEYS`, do the destructure rewrite (one of the listed patterns: top-level export → group property → call-time read), tripwire-verify the destructure guard, clean up the sentinel via `patch()` not `git checkout`, run the full suite green, commit.

**PREFLIGHT cache-key audit (skill-mandated):** confirm the audit before starting code. `EXTRACT_MAX_TOKENS` flows into the customId cache key (`bench/harness/extractionCache.js:_cacheKey(model, messages, maxTokens)`). Decision matrix per the skill: **warm cache + key in cache-key path = not sweepable against warm cache without special handling**. The handling for Phase 14 is exactly Task 5: pre-warm three shards (2048 from Phase 12, 4096 + 6144 from Task 5) so Task 6's sweep at all three values is fully cache-warm. **Confirmation:** if Task 5 reports `failedCount=0` for both 4096 and 6144, the audit is satisfied.

**Step 2: Verify the round-trip test**

```bash
npm test tests/unit/core/swept-constants-overridable.test.js -- -t "EXTRACT_MAX_TOKENS"
```

Expected: PASS for `setConstantOverrides({ EXTRACT_MAX_TOKENS: 4096 })` round-trip. Auto-generated destructure-guard test PASSes against the rewritten readers.

**Step 3: Tripwire-verify the destructure guard**

Inject sentinel per the skill recipe:
```bash
echo "const { EXTRACT_MAX_TOKENS: SENTINEL_P14_T55 } = CONSOLIDATION;" >> src/consolidation/extractFacts.js
npm test tests/unit/core/swept-constants-overridable.test.js -- -t "EXTRACT_MAX_TOKENS is not destructured"
```

Expected: FAIL with `extractFacts.js` in offenders. Then clean up with `patch` (NOT `git checkout` — extractFacts.js has uncommitted Task 5.5 work):

```
patch(path="src/consolidation/extractFacts.js",
      old_string="const { EXTRACT_MAX_TOKENS: SENTINEL_P14_T55 } = CONSOLIDATION;\n",
      new_string="")
```

**Step 4: Full-suite green-gate**

```bash
npm test
cd bench/modal && python -m pytest tests/ -q
```

Expected: all green. Watch specifically for `tests/unit/bench/warmup/enumerate.test.js` — the enumerator now reads `CONSOLIDATION.EXTRACT_MAX_TOKENS` at call time, so any test that sets up the module under a stub may see different behavior. Fix on the spot if it surfaces.

**Step 5: Commit**

One commit per the skill's commit-message template:

```
feat(consolidation): unlock EXTRACT_MAX_TOKENS for sweep overrides (P14 T5.5)

Moves EXTRACT_MAX_TOKENS from a top-level const in extractFacts.js into
the CONSOLIDATION group in constants.js, so setConstantOverrides() can
reach it. Adds to _SWEPT_CONSOLIDATION_KEYS. Five reader sites rewritten
to call-time reads through CONSOLIDATION.EXTRACT_MAX_TOKENS — no module-
top destructures, so Phase 14 Task 6's sweep observes the override.

Cache-key audit: EXTRACT_MAX_TOKENS flows into customId; Task 5 pre-warms
three shards {2048, 4096, 6144} so Task 6's sweep is fully cache-warm.

Tripwire: sentinel const-destructure injected → guard FAIL with
extractFacts.js in offenders → cleanup via patch().

Test count: N suites / M tests green (was M-1; +1 for the EXTRACT_MAX_TOKENS
round-trip + auto-generated destructure guard).

Plan: docs/plans/phase-14-v2-closure.md (Task 5.5)
Skill: software-development/unlock-knob-for-runtime-sweep
```

**Wall-clock estimate:** ~30 min subagent + 5 min controller review.

---

---

## Task 6: EXTRACT_MAX_TOKENS sweep + LoCoMo regression smoke + amend (single skill-following task)

**Objective:** Ship the `EXTRACT_MAX_TOKENS` 2048 → 4096 amendment via `benchmark-driven-constant-amendment` end-to-end: sweep `{2048, 4096, 6144}` on LongMemEval-S → LoCoMo single-cell regression smoke at the winner → amend constant + refresh `baseline.json`. One subagent owns the full skill recipe.

**Owner:** Subagent (controller delegates with `delegate_task`, full skill recipe inlined in context).

**Files:**
- Modify: `bench/modal/sweep_app.py` — add `extract_max_tokens` sweep config + base overrides
- Modify: `src/core/constants.js` — `CONSOLIDATION.EXTRACT_MAX_TOKENS` default 2048 → 4096 (assuming sweep wins; subagent verifies first). Already in `_SWEPT_CONSOLIDATION_KEYS` from Task 5.5.
- Modify: `docs/specs/2026-04-20-starmem-v2-design.md` — tuning amendment callout
- Modify: `tests/unit/core/constants.test.js` — assertion 2048 → 4096
- Modify: any tests that exercise the `EXTRACT_MAX_TOKENS` mechanism (grep first; surface 4 of the skill)
- Modify: `docs/bench/baseline.json` — update `tuned.EXTRACT_MAX_TOKENS` entry from 9.5's "OVERBUDGETED 256" observation to "AMENDED 4096"
- Create: `docs/bench/sweeps/2026-04-26-longmemeval-extract-max-tokens-live.md` — sweep artifact (auto-generated by sweep harness)

**Step 1: Subagent reads `benchmark-driven-constant-amendment` skill in full**

```bash
# Subagent context: load this skill before doing anything else
# It defines the four-surface dance and the surface-4 (mechanism-test) trap
```

**Step 2: Wire the sweep into `bench/modal/sweep_app.py`**

Add to `SWEEP_CONFIGS` after the existing sweeps:

```python
"extract_max_tokens": {
    "knobs": [
        {"name": "EXTRACT_MAX_TOKENS", "values": [2048, 4096, 6144]},
    ],
    "primary_metric": "mrr",
    "renderer": render_lambda1_report,  # or a new render_extract_max_tokens_report;
                                         # subagent reuses lambda1_tripwire-style
                                         # one-knob renderer if it exists
},
```

Add to `_SWEEP_BASE_OVERRIDES`:

```python
"extract_max_tokens": {"BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15},
# Cache-key alignment with the warmup (matches lambda1_tripwire pattern).
```

If a sibling renderer exists for one-knob lambda1_tripwire-style sweeps, reuse. Otherwise add a `render_extract_max_tokens_report` that emits a 3-row table of `{knob, primary_metric, coverage, latency_p95}` plus elbow detection. Pattern matches `render_lambda1_report` from Phase 13.

**Step 3: Verify `EXTRACT_MAX_TOKENS` is sweep-reachable** (precondition from Task 5.5)

Task 5.5 already moved `EXTRACT_MAX_TOKENS` into `CONSOLIDATION` and added it to `_SWEPT_CONSOLIDATION_KEYS`. Confirm before kicking off the sweep:

```bash
grep -n "EXTRACT_MAX_TOKENS" src/core/constants.js
# Expect: one line in CONSOLIDATION block, one line in _SWEPT_CONSOLIDATION_KEYS

npm test tests/unit/core/swept-constants-overridable.test.js -- -t "EXTRACT_MAX_TOKENS"
# Expect: PASS — round-trip and destructure-guard tests both green
```

If either fails, Task 5.5 didn't fully land — back-fill before proceeding.

**Step 4: Run the LongMemEval-S sweep**

```bash
modal run bench/modal/sweep_app.py \
  --mode run-sweep \
  --sweep-name extract_max_tokens \
  --corpus longmemeval-s \
  --chunks 6 \
  --extractor-model "Qwen/Qwen3.6-35B-A3B-FP8"
```

Expected wall-clock: ~30 min (3 cells × full LongMemEval-S corpus, all warm cache from Task 5). Expected outcome:
- 2048 cell: lower coverage (truncation skips items), MRR within noise of historical figures.
- 4096 cell: higher coverage (truncation rate near zero), MRR similar to 2048 on the *intersection* of scored items, possibly slightly different on the union.
- 6144 cell: marginally higher coverage if any items still truncated at 4096; MRR within noise.

The ΔMRR ≥ 0.02 + Δcoverage ≥ −5pp gate from Phase 11 applies. The expected amend trigger is **coverage**, not MRR.

**Step 5: Read the sweep artifact and identify the winner**

```bash
cat docs/bench/sweeps/2026-04-26-longmemeval-extract-max-tokens-live.md | head -60
```

Likely winner: 4096 (the proposed amendment). 6144 sanity check should be flat/marginal vs 4096. If 6144 wins materially over 4096, that's a finding worth its own paragraph in the retro.

**Step 6: LoCoMo regression smoke at the winner**

Single-cell, single-corpus dispatch:

```bash
modal run bench/modal/sweep_app.py \
  --mode run-point \
  --corpus locomo \
  --extractor-model "Qwen/Qwen3.6-35B-A3B-FP8" \
  --overrides "EXTRACT_MAX_TOKENS=4096,BATCH_SIZE=15,WORKING_BUFFER_THRESHOLD=15"
```

Expected: ~5 min wall-clock, <$0.20. MRR / coverage within ±0.005 of LoCoMo's recent baseline (Phase 12 / 9.5 figures). If LoCoMo regresses materially, pause — don't amend.

**Step 7: Amend the constant per the four-surface skill**

Surface 1: `src/core/constants.js`
```js
// Before:
export const EXTRACT_MAX_TOKENS = 2048;

// After:
/**
 * Max output tokens for fact extraction. Phase 14 Task 6 amended
 * 2048 → 4096 (correctness fix). The 2048 ceiling was hit on dense
 * LongMemEval-S batches at BATCH_SIZE=15, producing truncated
 * responses that failed cache-replay parsing (ExtractionParseError).
 * Sweep `docs/bench/sweeps/2026-04-26-longmemeval-extract-max-tokens-live.md`.
 */
export const EXTRACT_MAX_TOKENS = 4096;
```

Surface 2: `docs/specs/2026-04-20-starmem-v2-design.md` — append a tuning amendment callout under the consolidation/extraction section. Don't rewrite the original; blockquote the amendment.

Surface 3: `tests/unit/core/constants.test.js` — assertion 2048 → 4096 with a comment naming the sweep.

Surface 4: grep tests for `EXTRACT_MAX_TOKENS` mechanism dependence:

```bash
grep -rn "EXTRACT_MAX_TOKENS" tests/
```

For each hit not in `constants.test.js`, read the test and check whether it relies on the 2048 default. If a test asserts truncation behaviour at 2048, wrap the body with `setConstantOverrides({ EXTRACT_MAX_TOKENS: 2048 })` so the test exercises the truncation logic without depending on the new default.

**Step 8: Refresh `baseline.json::tuned.EXTRACT_MAX_TOKENS`**

Replace the 9.5 "OVERBUDGETED 256" observation with the Phase 14 amendment record:

```json
"EXTRACT_MAX_TOKENS": {
  "specDefault": 2048,
  "measured": 4096,
  "verdict": "AMENDED",
  "phase": "14",
  "sweep": "sweeps/2026-04-26-longmemeval-extract-max-tokens-live.md",
  "note": "AMENDED (Phase 14 Task 6, correctness fix). 2048 ceiling caused truncated extractions on dense LongMemEval-S batches at BATCH_SIZE=15, producing ExtractionParseError on cache replay. 4096 lifts coverage from <Y>pp to <Z>pp; MRR within noise on the scored intersection. 6144 sanity check flat vs 4096. LoCoMo regression smoke at 4096: <Δ MRR>, <Δ coverage>, no regression. Supersedes 9.5's OVERBUDGETED 256 observation — that was efficiency-framed against a corpus (LoCoMo) where truncation didn't bind; LongMemEval-S exposed the correctness floor."
}
```

(Subagent fills `<Y>`, `<Z>`, `<Δ MRR>`, `<Δ coverage>` from the actual sweep + smoke output.)

**Step 9: Run full test suite + lint + typecheck**

```bash
npm test
npm run lint
npm run typecheck
pytest bench/modal/tests/ -v
```
Expected: All green. If any test fails on `EXTRACT_MAX_TOKENS`, surface 4 was incomplete — fix.

**Step 10: Commit atomically**

```bash
git add -A
git commit -m "feat(consolidation): amend EXTRACT_MAX_TOKENS 2048 → 4096

Phase 14 Task 6, correctness fix per benchmark-driven-constant-amendment.

The 2048 default was hit on dense LongMemEval-S batches at BATCH_SIZE=15,
producing truncated extractions that failed cache-replay parsing
(ExtractionParseError). Phase 12 Task 7 surfaced the bug; Phase 14
Task 6 ships the fix.

Sweep: docs/bench/sweeps/2026-04-26-longmemeval-extract-max-tokens-live.md
- Grid: {2048, 4096, 6144} on LongMemEval-S
- Coverage 2048 → 4096: <delta>
- MRR 2048 → 4096: <delta> (scored intersection)
- 6144: flat vs 4096 (sanity check)
- LoCoMo regression smoke at 4096: no regression

Four-surface dance:
- src/core/constants.js: 2048 → 4096, docstring updated
- docs/specs/2026-04-20-starmem-v2-design.md: tuning amendment callout
- tests/unit/core/constants.test.js: assertion + comment
- (mechanism tests): <list any wrapped with setConstantOverrides>

baseline.json::tuned.EXTRACT_MAX_TOKENS rewritten as AMENDED record;
9.5's OVERBUDGETED 256 observation superseded (LongMemEval-S exposed
the correctness floor that LoCoMo didn't reach).

Full suite: <N> jest + <M> pytest green. Sweep artifact + smoke
artifact committed."
```

---

## Task 7: Cell variance + late-chunk slowdown analysis

**Objective:** Use the `chunkWalls` data populated by Task 1 (and now riding every Task 5/6 dispatch for free) to answer Phase 13 retro §5's two open questions: (1) what drives the 3.7× cell wall-time spread observed in Phase 13's λ₁ tripwire? (2) does late-chunk slowdown reproduce, and what's its magnitude?

**Owner: Controller (analysis only, no Modal time).**

**Files:**
- Read: `docs/bench/runs/<Task 6 sweep run dir>/result.json` — contains all `chunkWalls` arrays from Task 6's 3-cell sweep
- Read: optionally re-dispatch Phase 13's lambda1_tripwire on the new schema for a 5-cell × `chunkWalls` profile if the Task 6 data isn't enough (only if needed; flag explicitly)
- Create: `docs/bench/analysis/2026-04-26-cell-variance.md` — analysis writeup

**Step 1: Extract chunkWalls from Task 6's result.json**

```bash
jq '.points[] | {overrides, chunkWalls, wallMs, chunksRun}' \
  docs/bench/runs/<Task6-run-dir>/result.json
```

Expected: 3 cells (one per `EXTRACT_MAX_TOKENS` value) × 6 chunks each (LongMemEval-S = 6 chunks at `chunks=6`) × `chunkWalls = [w0, w1, w2, w3, w4, w5]`.

**Step 2: Variance analysis**

For each cell, compute:
- `mean(chunkWalls)`, `stddev(chunkWalls)`, `max/min ratio`
- Compare across cells: does the ratio reproduce regardless of `EXTRACT_MAX_TOKENS`? (Expected: yes — variance is dispatch-shape-driven, not knob-driven.)

Phase 13's observation was 3.7× spread (373s/1381s/423s/409s/634s on a single 5-cell λ₁ sweep). Task 6 gives 3 cells × 6 chunks = 18 data points. If max/min ratio across all 18 chunks ≈ 3-4×, variance reproduces.

**Step 3: Late-chunk-slowdown analysis**

For each cell, plot `chunkWalls[i]` against chunk index `i`:
- Does `chunkWalls[5]` (last chunk) systematically exceed `chunkWalls[0]` (first chunk)?
- What's the slope across chunks within a single cell?

Eva's live observation was that late chunks ran progressively slower. The hypothesis is one of:
1. **Cold-container variance** — first chunk pays engine init cost, gets penalised once.
2. **Item ordering effect** — later items happen to be denser (LongMemEval-S session counts grow toward end of corpus).
3. **vLLM cache-hit decay** — KV cache from chunk N doesn't help chunk N+1, but engine state may degrade across long-running batches.
4. **Modal Volume contention** — late chunks compete with cache-write IO from earlier chunks.

Match the data shape against each hypothesis. Likely answer: a mix of (1) and (2).

**Step 4: Write the analysis doc**

`docs/bench/analysis/2026-04-26-cell-variance.md`:

```markdown
# Cell wall-time variance + late-chunk slowdown — Phase 14 Task 7

## Data sources

- Task 6 sweep `extract_max_tokens × {2048, 4096, 6144}` on LongMemEval-S, 3 cells × 6 chunks
- Phase 13 lambda1_tripwire (5 cells × 6 chunks, retro figures)
- Optional Task 7 supplementary dispatch (only if needed)

## Variance finding

| Cell | mean(chunkWalls) | stddev | max/min ratio |
|------|------------------|--------|---------------|
| 2048 | <X>s             | <Y>s   | <Z>           |
| 4096 | <X>s             | <Y>s   | <Z>           |
| 6144 | <X>s             | <Y>s   | <Z>           |

[Discuss whether ratio is consistent across cells, supporting or refuting
the hypothesis that variance is dispatch-shape-driven.]

## Late-chunk slowdown finding

[Per-chunk plot or table; slope analysis; classification against the
4 hypotheses.]

## Conclusion

[One paragraph answering: was the variance dispatch-driven? Was the
slowdown real, and what's its mechanism? Is this filed against v2.1
or closed as understood?]
```

**Step 5: Commit**

```bash
git add docs/bench/analysis/2026-04-26-cell-variance.md
git commit -m "docs(bench): cell variance + late-chunk slowdown analysis

Phase 14 Task 7. Uses chunkWalls data (Task 1 schema, Task 6 dispatch)
to answer Phase 13 retro §5 questions. <One-sentence summary of the
finding — variance mechanism + slowdown verdict.>"
```

---

## Task 8: Retro + ROADMAP

**Objective:** Close v2.0 with a Phase 14 retro that captures the EXTRACT_MAX_TOKENS amendment, the Tier 2 cleanup, the chunkWalls instrumentation + variance findings, and hands off to v2.1.

**Files:**
- Create: `docs/plans/phase-14-retro.md`
- Modify: `docs/plans/ROADMAP.md` — append `## Phase 14 — 2026-04-26` heading

**Phase 14 retro structure:**

1. **§1 Artifacts table** — task # × commit SHA × short description.
2. **§2 Decisions audit** — Decisions 1-10 from the plan header. Each gets a "held / revised / superseded" verdict with one-line rationale.
3. **§3 What shipped** — bulleted summary of the four landed deliverables: EXTRACT_MAX_TOKENS amendment, Tier 2 demolition, chunkWalls schema + variance analysis, modal-cell-timeout-sizing skill.
4. **§4 Surprises** — anything that came up during execution that wasn't predicted in the plan. (Likely candidates: 6144 sanity check shifted MRR more / less than expected; LoCoMo regression smoke surprised us; cell variance hypothesis was wrong.)
5. **§5 What didn't ship and why** — explicit deferral list:
    - λ₁ structural fix → v2.1
    - Abstention scoring → v2.1 (UX research first)
    - External baselines (Zep / Mem0 / Mem3 / MemGPT) → v2.1
    - LongMemEval `_oracle` and `_m` variants → v2.1
6. **§6 Phase 15 / v2.1 candidates** — the deferred list above promoted to candidate status, plus anything Task 7 surfaced.
7. **§7 v2.0 closure** — explicit one-paragraph statement that v2.0 is done. Phase counts, commit count, test totals, sweep count.

**ROADMAP entry shape:**

```markdown
## Phase 14 — 2026-04-26

**Theme:** v2.0 closure. EXTRACT_MAX_TOKENS amendment (correctness fix), Tier 2 demolition follow-through, instrumentation for cell variance / late-chunk slowdown, and one new skill.

**Headline:** EXTRACT_MAX_TOKENS amended 2048 → 4096 per LongMemEval-S sweep evidence (`docs/bench/sweeps/2026-04-26-longmemeval-extract-max-tokens-live.md`). 6144 sanity check flat vs 4096; LoCoMo regression smoke clean. <Variance + slowdown verdict in one line.>

**Phase 14 final tally:**
- <N> commits in range `<plan SHA>..<retro SHA>`
- 10 of 10 decisions held / <X> revised / <Y> superseded
- New skill: `modal-cell-timeout-sizing`
- <Test deltas if material>

**v2.0 closed.** v2.1 inherits four candidates: λ₁ structural fix, abstention scoring, external baselines, LongMemEval `_oracle` / `_m` variants.
```

**Step 1: Write `docs/plans/phase-14-retro.md`**

Use the structure above. Pull commit SHAs from `git log --oneline <plan-sha>..HEAD`. Pull test deltas by running `npm test 2>&1 | tail -5` and `pytest bench/modal/tests/ 2>&1 | tail -3` against the post-Task-7 tree.

**Step 2: Append ROADMAP entry**

`patch` `docs/plans/ROADMAP.md` to insert the `## Phase 14 — 2026-04-26` block before the `## Phase 13` heading. (ROADMAP is reverse-chronological.)

**Step 3: Verify ROADMAP heading count**

```bash
grep -c "^## Phase " docs/plans/ROADMAP.md
# Expected: 14 (was 13 after Phase 13 close at 7ca9c8f)
```

**Step 4: Commit**

```bash
git add docs/plans/phase-14-retro.md docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 14 retro + ROADMAP entry

Phase 14 closes v2.0. EXTRACT_MAX_TOKENS amended 2048 → 4096
(correctness fix), Tier 2 demolition follow-through, chunkWalls
instrumentation + variance analysis, modal-cell-timeout-sizing
skill. v2.1 candidates filed: lambda1 structural fix, abstention
scoring, external baselines, LongMemEval _oracle/_m variants."
```

---

## Closing checklist

After Task 8 lands:

- [ ] `git log --oneline <plan-sha>..HEAD | wc -l` shows the expected commit count (~10-14)
- [ ] `npm test` green
- [ ] `npm run lint` green
- [ ] `npm run typecheck` green
- [ ] `pytest bench/modal/tests/` green
- [ ] `grep -c "^## Phase " docs/plans/ROADMAP.md` returns 14
- [ ] `docs/bench/baseline.json::tuned.EXTRACT_MAX_TOKENS.verdict` is `"AMENDED"`
- [ ] `docs/bench/baseline.json::tuned.TIER2_TAU_GAP` left untouched (historical record)
- [ ] No `git status --short` output (working tree clean)
- [ ] `git push origin main` (Eva runs this; not Phase 14's responsibility)

**v2.0 done.** Phase 15 = v2.1 kickoff (probably λ₁ structural fix).
