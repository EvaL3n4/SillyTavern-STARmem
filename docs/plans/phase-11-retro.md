# Phase 11 Retro — Measurement Infrastructure Hardening

**Plan:** [`phase-11-infrastructure-hardening.md`](./phase-11-infrastructure-hardening.md)
**Shipped:** 2026-04-23 at commit `27a839a`
**Corpus:** LoCoMo 10 conversations (1986 QA items) — inherited unchanged from 9.5
**Extractor:** `google/gemma-4-26b-a4b-it` via Nano-GPT, temperature=0 — inherited unchanged
**Baseline artifact:** [`docs/bench/baseline.json`](../bench/baseline.json)
**Scope:** 5 of 6 filed Phase 11 candidates landed. Tier 2 demolition + `EXTRACT_MAX_TOKENS → 256` deferred to Phase 12.

---

## 1. What shipped

**Pure measurement substrate.** Zero tuned-knob amendments. The 9.4.8 retrieval surface (`TIER2_TAU_GAP=10`, MRR 0.8057, coverage 0.643) holds unchanged. The value Phase 11 adds is **trustworthy instrumentation**: every future sweep renders a coverage column, proposes amendments only when both MRR and coverage pass the gate, and runs on Modal without cache-key-flow timeouts.

### Artifacts + code changes

| # | Task | Commit | Ins / Del |
|---|---|---|---|
| 0 | Plan | `c541d4c` | 1990 / 0 |
| 1 | `_elbow_on_slice` zero-axis-Δ guard (`ABS_DELTA_FLOOR = 0.005`) + 3 tests | `58d937e` | — |
| 2 | `--local-out` parity for `run-point` mode | `1c5cc38` | 19 / 1 |
| 3 | Baselines on Modal: `--mode run-baselines`, 4-retriever parallel fan-out + 3 tests | `00269f3` | 326 / 1 |
| 4.a | `coverage` field on `MetricsResult` + 3 tests | `fb69adb` | ~32 / 0 |
| 4.b | `shouldAmend` JS module + Python `_should_amend` mirror, wired into 5 renderers + 5 tests | `442456d` | 250 / 80 |
| 5 | Six 9.5 sweep artifacts re-rendered under two-column metric + `rerender.py` one-shot tool | `7f10b82` | 306 / 146 |
| 6 | BATCH_SIZE conversation-level-split sweep (25 bounded containers) + 2 tests | `e28b598` | 378 / 0 |
| 6-hfx | Remove spurious `@app.function` decorator on orchestrator | `344e88f` | 5 / 7 |
| 6-hfx2 | Bump `run_batchsize_point` per-cell timeout 600s → 1800s | `6c7fbaa` | 1 / 1 |
| 7 | Modal dispatch: BATCH_SIZE sweep complete, Branch C observation | `0e9c17d` | 7157 / 0 |
| 8 | `baseline.json` refresh: Phase 11 closure, `BATCH_SIZE` entry, `coverage` field | `27a839a` | 15 / 4 |
| 9 | This retro + ROADMAP entry | *(current commit)* | ~260 / 0 |

**Total: 13 commits across the phase** (11 landed tasks + 2 hot-fixes). `c541d4c..HEAD`.

### Test counts

- Sub-phase 9.5 close: 77 suites / **816 tests** (jest), 3 tests (pytest bench/modal — `test_detect_elbow.py`)
- Phase 11 close: 77 suites / **824 tests** (jest, +8: 3 coverage + 5 amendment-rule), **8 tests** (pytest bench/modal, +5: 3 baselines + 2 batchsize)
- Net delta: +8 jest, +5 pytest. All green, no regressions.

### Infrastructure surface added

```python
# bench/modal/sweep_app.py — new Modal functions / orchestrators
@app.function(...) def run_baseline_point(retriever_id: str) -> str
@app.function(...) def run_baselines() -> dict
@app.function(...) def run_batchsize_point(conv_idx: int, batch_size: int) -> str
                   def run_consolidation_batchsize_sweep() -> dict  # no decorator — runs inside run_sweep's container
                   def render_baselines_report(payload)
                   def render_batchsize_report(payload)
                   def _should_amend(baseline_metrics, candidate_metrics, ...) -> dict
BASELINE_IDS = ["ladder", "bm25only", "recency", "random"]
BATCHSIZE_VALUES = [3, 5, 7, 10, 15]
BATCHSIZE_CONV_INDICES = [0, 1, 2, 3, 4]
ABS_DELTA_FLOOR = 0.005
```

```javascript
// bench/metrics/retrieval.js — MetricsResult gains coverage
coverage: runs.length > 0 ? n_scored / runs.length : NaN

// bench/render/amendment-rule.js — new module
export function shouldAmend({ baseline, candidate, minMrrDelta = 0.02, maxCoverageDrop = 0.05 })

// bench/baselines/index.js — new canonical ID list
export const BASELINE_IDS = ['ladder', 'bm25only', 'recency', 'random'];

// bench/baselines/_modal-point.js       — new Node entry (1-retriever × full corpus)
// bench/sweeps/_modal-batchsize-point.js — new Node entry (1-conv × 1-BATCH_SIZE cell)
```

---

## 2. Decisions held / revised

| Decision | Status | Notes |
|---|---|---|
| 1. Scope breadth: 5 of 6 (Tier 2 demo deferred) | **Held** | |
| 2. BATCH_SIZE option (b) conversation-level split | **Held** | Redesign worked; BATCH_SIZE=5 row on re-dispatch ran ~8s per cell (warm) vs ~11min (cold) — partial-progress preservation is exactly as designed |
| 3. Coverage: two-column reporting, no composite | **Held → Validated first-time** | Task 7 Branch C is the first real-world catch: coverage peaks at BATCH_SIZE=10 (spec default) while MRR peaks at 15 — pre-Phase-11 machinery would have proposed BATCH_SIZE=15 as a 1.9pp MRR win on a slightly-smaller answerable subset. The guard works |
| 4. Re-render from cached per-point JSON | **Held** | All six 9.5 sweep JSONs recovered cleanly; zero unrecoverable files; `rerender.py` handled both multi-round (graph, consolidation) and single-axis (hops, relw) renderer shapes |
| 5. Baselines on Modal: dedicated `--mode run-baselines` dispatch | **Held** | Surface shipped; not actually dispatched live — Task 3's commit is the surface landing, any comparative run happens in Phase 12 |
| 6. Elbow guard: two-fixture regression test | **Held** | Flat-axis + genuine-elbow fixtures both green; no historical-data pin needed |
| 7. Plan filename | **Held** | |
| 8. Execution mode: Controller small tasks, Subagent large tasks | **Held → Fireworks zero-flake** | Zero Azure empty-turn events mid-execution. One empty turn landed on a large tool-result batch during Task 7 preflight (shell-output-heavy) but recovered on next controller turn. Subagent delegations (Fireworks/Kimi) were all clean — pattern from 9.4.x held |
| 9. Task 7 = single `modal run` dispatch, controller | **Revised shape** | Eva dispatched Modal manually (continuing the 9.4.8/9.4.9/9.5 pattern); the controller picked up artifact reading + observation append + commit |
| Task 6 **Branch B predicted** (flat axis) | **Revised → Branch C** | BATCH_SIZE has a real monotonic retrieval-quality signal (0.7756 → 0.8370 across the grid). Pre-reg framing as "consolidation-only knob" was incomplete. Signal is real but below the 0.02 amendment gate — held at spec. See §4 Surprises |

---

## 3. Execution mode

**Controller-driven with parallel Fireworks subagents for Tasks 3, 4, 5, 6.** Hybrid split matched the plan's pre-registered ownership declarations exactly:

- **Controller (Azure):** Tasks 0, 1, 2, 7, 8, 9 + both Task 6 hot-fixes. Small-surface mechanical edits plus narrative work.
- **Subagents (Fireworks/Kimi, delegated):** Tasks 3, 4, 5, 6. Scope-bounded, well-specified interfaces.

**Parallelization events:**
- Tasks 5 + 6 dispatched in parallel (separate subagents, zero file overlap — Task 5 reads `sweep_app.py` and writes Markdown/`rerender.py`, Task 6 writes to `sweep_app.py` and new JS/test files). Wall-clock: 155s + 113s ran in ~155s, saving ~2 min over sequential.
- Parallel dispatch guard language held perfectly: zero cross-file leaks, zero `git add -A` accidents, clean commits from both subagents.

**Azure flakiness observed:** 1 empty-turn event during Task 7 preflight (heavy shell output from `find docs/bench/runs`). Context recovered cleanly on next turn. Zero empty turns during subagent delegation (as designed — `delegate_task` routes through Fireworks, not Azure).

**Subagent self-report accuracy:**
- Task 3: `loadLocomo({ offline: true })` signature adaptation flagged and applied correctly without re-delegation; subagent correctly noted the deviation in its summary.
- Task 4: subagent refactored graph/consolidation renderers' pre-existing inline coverage-aware logic to use the shared `_should_amend` — good judgment call not in the plan, reported honestly.
- Task 5: zero renderer adaptations needed beyond passing `payload['result']` vs `payload` for different renderer types. Reported zero unrecoverable sweeps. Verified by controller (`grep -l '**Amend**'` returned clean).
- Task 6: landed the decorator bug verbatim from the plan text. Tests passed because they never exercised the Modal dispatch path. Caught only at Eva's live dispatch — see §4.

---

## 4. Surprises

### 1. Plan's verbatim Task 6 code had two Modal-wiring bugs

Both surfaced only at real Modal dispatch time; both invisible to `py_compile`, jest, and pytest:

**Bug A (`344e88f`):** `run_consolidation_batchsize_sweep` was decorated with `@app.function(...)`. This turns the name into a `modal.Function` **object**, not a plain callable. The `run_sweep` dispatch at line 1738 calls it like a normal function: `return run_consolidation_batchsize_sweep()`. First dispatch hit `TypeError: 'Function' object is not callable`.

The fix was obvious once diagnosed — sibling orchestrators `run_graph_sweep` and `run_consolidation_sweep` are **undecorated**; they inherit `run_sweep`'s container context (volume, secrets, timeout, memory). Task 6's plan text copied the decorator from `run_baseline_point` (which genuinely is a per-cell Modal function) and pasted it onto the orchestrator.

**Bug B (`6c7fbaa`):** Per-cell timeout was 600s. BATCH_SIZE=3 on a ~400-msg conversation is ~133 extraction calls × ~5s per call = ~665s. Dispatch hit `FunctionTimeoutError` on the BATCH_SIZE=3 row. Fixed by bumping to 1800s (matching `run_sweep`'s orchestrator timeout). Actual max cell wall-clock on re-dispatch: 1303.5s — comfortable but well above the original ceiling.

**Both preventable at plan-review time** with:
- "grep sibling pattern for decorator presence" (would have caught A: `run_graph_sweep` / `run_consolidation_sweep` both undecorated)
- "compute worst-case per-cell wall-clock vs timeout" arithmetic (would have caught B: 400/3 × 5s = 667s > 600s, fail obvious)

Filed for `writing-plans` skill update — see §6.

### 2. Coverage gate earned its keep on its first real-world test

Task 4's amendment rule was specified against the 9.4.9 graph-sweep subset-selection bias pattern. Task 7's BATCH_SIZE sweep produced a **different** pattern:

```
BATCH_SIZE | MRR     | Coverage
10         | 0.8182  | 0.7337  ← spec default, coverage optimum
15         | 0.8370  | 0.7067  ← MRR optimum, −2.7pp coverage
```

`ΔMRR = +0.0188` (below 0.02 gate). `Δcoverage = −2.7pp` (within 5pp budget). Rule correctly holds at spec.

But the interesting fact is **the coverage signal itself** — MRR optimum and coverage optimum are at different grid points. Pre-Phase-11 machinery (MRR-only elbow detection) would have proposed BATCH_SIZE=15 as a +1.9pp MRR win. The two-column metric is what made this legible: the MRR-best row scored on a slightly-smaller answerable subset. Not a rejection (coverage drop was inside the 5pp guard), but the amendment would have been on thin ice — it took the 0.02 ΔMRR gate to actually hold.

Both guards worked together: coverage made the trade-off visible, the ΔMRR threshold held the line.

### 3. BATCH_SIZE is not the pure consolidation knob we pre-registered

The plan's Branch-B pre-registration (line 1730): *"MRR flat ±0.005 across the grid... BATCH_SIZE affects consolidation/update-rate, not ranking directly."*

Actual data: monotonic MRR climb 0.7756 → 0.8009 → 0.8136 → 0.8182 → 0.8370 across [3, 5, 7, 10, 15]. Clear signal. The mechanism: larger batch size = richer per-call extraction context = better-quality entity/topic keywords surfaced during extraction = better BM25 keyword matching at retrieval time. It's a *retrieval* knob by mechanism, not just a consolidation knob.

Doesn't change the verdict (below the 0.02 gate), does update the mental model. The updateRate column (0.0154 → 0.0218) confirms BATCH_SIZE *also* affects consolidation modestly — it's doing both.

Worth flagging in Phase 12's EXTRACT_MAX_TOKENS plan: if BATCH_SIZE affects retrieval quality via extraction-context richness, `EXTRACT_MAX_TOKENS` might too (truncated extractions = less content to surface as keywords). Pre-register that hypothesis explicitly.

### 4. Parallel dispatch of Tasks 5 + 6 was clean

First real parallel-subagent dispatch in Phase 11 (Tasks 3, 4 ran sequentially because Task 4 depends on Task 3's renderer surface). Tasks 5 and 6 have **zero file overlap** by design: Task 5 reads `sweep_app.py` and writes `rerender.py` + 6 `-live.md` files; Task 6 writes to `sweep_app.py` and new JS/test files. Parallel dispatch guard language ("another subagent is running Task N at the same time...") held perfectly — both commits landed with exactly the files they owned, zero cross-contamination, no `git add -A` slips, no staged foreign files in either commit.

Saves ~2 minutes wall-clock over sequential in this case. Pattern worth keeping: when two tasks own **disjoint file sets**, fan them out; when they overlap (even on a shared file, even additively), serialize.

### 5. BATCH_SIZE=3 wall-clock was 4× the plan's estimate

Plan estimated "~2-3 min per cell." Actual median: 10.7 min per cell, max 21.7 min (BATCH_SIZE=3 dominated). Cumulative container-seconds across all 25 cells: ~4 hours (14,434s sequential, ~22 min parallel with 25-way fan-out). 

At Modal A10G pricing this is non-trivial per run. For Phase 12: if we sweep EXTRACT_MAX_TOKENS (another 100%-cache-miss knob) and use the same conversation-level-split pattern, expect similar wall-clock — plan accordingly.

### 6. `rerender.py` revealed schema fragility in the renderer interface

Task 5 discovered that `render_tau_report(result, corpus_len, qa_count)` takes `result` while `render_graph_report_stub(payload)` takes the whole payload. Not a bug, but a surface inconsistency: if future sweeps are added, the renderer-signature convention is undocumented and easy to get wrong. `rerender.py`'s dispatch block (`if sweep_name == 'tau': out = render_tau_report(payload, ...)`) has the knowledge baked in but it's not enforced anywhere.

Minor debt. Flag for Phase 12 if we touch the renderer surface.

---

## 5. Notes for Phase 12

### Primary candidates (filed from Phase 11)

1. **Tier 2 demolition.** 9.5 Phase 11 candidate #5, deferred out of scope here. `TIER2_TAU_GAP=10` already functionally disables Tier 2 (gap-10 is never satisfied at Tier 2); the ladder could simplify to "always-Tier-3-as-Tier-2-seed" — ~30 LOC change in `src/retrieval/ladder.js`. Zero retrieval-surface risk because the current setting is the zero-gating case. Likely first task of Phase 12.

2. **`EXTRACT_MAX_TOKENS → 256`.** 9.5 observation (p95 ~ 280 chars ≈ 70 tokens on observed live Gemma output). Cache-key-bound knob, so we now have the conversation-level-split infrastructure to sweep it safely. Pre-register Branch-C-or-better: truncation at 256 might degrade extraction quality minimally and the coverage column will show any subset-selection tension. If Phase 12 sweeps it, reuse `_modal-batchsize-point.js` as the template (rename + parameterize on `EXTRACT_MAX_TOKENS` instead of `BATCH_SIZE`).

### Infrastructure to reuse

3. **Baselines-on-Modal surface (Task 3 landed, never live-dispatched).** `--mode run-baselines` + `BASELINE_IDS` + `_modal-point.js` is ready for its first real run. Natural fit whenever Phase 12 (or a v2.1 external-baselines phase: Zep, Mem0) wants the 4-retriever comparison.

4. **Conversation-level-split pattern.** The `bench/sweeps/_modal-batchsize-point.js` + `run_batchsize_point` + `run_consolidation_batchsize_sweep` triplet is a reusable template for any cache-key-bound sweep. Rename + parameterize on the new knob.

### Corpus expansion (v2.1 territory, but note here)

5. **LoCoMo's single-session structure remains the retrieval-surface bottleneck.** Four Tier 3 edge-weight knobs (λ₁, λ₂, `EXPLICIT_RELATION_WEIGHT`, `COOCCURRENCE_WEIGHT`) all provably inert across three+ reproductions. Multi-session / cross-character corpus is required to exercise edge-weighting meaningfully. Not Phase 12 scope unless we explicitly pivot.

### Tools to decide on

6. **`bench/modal/rerender.py` disposition.** Committed in Task 5 as a one-shot backfill. All Phase 11+ sweep artifacts ship coverage natively now, so the re-render use case is closed. Options: (a) keep for ad-hoc future rescues, (b) promote to a documented bench-tools directory, (c) remove at Phase 12 open. Lean toward (a) — ~140 LOC, harmless, costs nothing to keep.

---

## 6. Notes for the skill library

### `writing-plans` — two preflight additions from Task 6 bugs

The decorator bug (`344e88f`) and the timeout bug (`6c7fbaa`) were both preventable at plan-review time, both invisible to the static-check toolchain (`py_compile`, jest, pytest), and both surfaced only at real Modal dispatch. Two concrete preflight protocols worth adding:

**A. "Grep sibling pattern for decorator presence."** When a plan adds a new function that will be *called from* an existing dispatch path (vs. *dispatched directly*), grep the existing siblings in that path for decorator presence and match the pattern. Example: if the plan adds `foo()` to be called by `dispatcher()`, and the existing siblings `bar()`, `baz()` called by the same `dispatcher()` are undecorated, `foo()` must also be undecorated. Decorator-vs-bare-function is a Modal-specific trap but the pattern generalizes to any framework where a decorator changes the callability semantics of a name (Flask routes, Celery tasks, Dask delayed, pytest fixtures, etc.).

**B. "Compute worst-case per-cell wall-clock vs timeout."** When a plan sets a per-cell or per-task timeout on a sweep, the plan must include an inline arithmetic check: "worst-case cell has N ops × T seconds/op ≈ X seconds, timeout Y seconds, headroom Y−X." For cache-invalidating knobs where the whole grid is cold, the check is mandatory. 600s for BATCH_SIZE=3 was 665s-bound; the arithmetic would have caught it in 15 seconds of plan review.

Both patches belong under a new `writing-plans` sub-section: "Preflight patterns for Modal/serverless sweep plans."

### `detecting-vacuous-metrics` — field validation #5

The skill's subset-selection-bias pattern has now been field-validated **five times**:
1. 9.4.6 Task 4 TAG_BOOST/SUBJECT_BOOST original detection
2. 9.4.9 graph sweep (TIER3_SEEDS_K, EDGE_CAP_PER_ENTRY, COOCCURRENCE_WEIGHT)
3. 9.5 graph sweep reproduction under live Gemma (same three knobs, identical signatures)
4. Phase 11 Task 4 formalized the rule (`shouldAmend` / `_should_amend`)
5. **Phase 11 Task 7 BATCH_SIZE sweep** — the first live dispatch run where the rule **prevented an amendment** (not just flagged one for manual hold)

Worth noting in the skill that the rule is now **structurally enforced** at render time via Task 4's modules, not just analytically applied by the retro author. Add a "Prevention" subsection referencing `bench/render/amendment-rule.js` and the `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp` formula.

Also, BATCH_SIZE surfaced a **different** coverage tension than the graph-knob pattern: instead of "MRR climbs because coverage collapses" (subset-selection bias), it was "MRR peaks where coverage dips" (differential retrievability across the grid). Same rule fires, same held-at-spec outcome, different mechanism. Worth distinguishing in the skill.

### `subagent-driven-development` — parallel dispatch field validation

Tasks 5 + 6 parallel dispatch: zero cross-contamination, zero `git add -A` accidents, both subagents produced clean commits with exactly their owned files. Pattern works as designed when:
- File sets are provably disjoint (not just "shouldn't overlap" — *verified* disjoint)
- Both tasks have absolute paths + tripwire hashes in their context
- Both tasks are told explicitly about the other task's existence
- Both tasks have explicit `git add <paths>` in their commit step with `git add -A` forbidden

Skill already documents this (STARmem Phase 4 Tasks 4+5 was the original field validation). Phase 11 adds a second data point: **the pattern scales to text-heavy tasks with multi-file writes**. Tasks 5 wrote 7 files (rerender.py + 6 markdown); Tasks 6 wrote 3 files (new JS + new Python + new test). Both serialized cleanly. Consider adding a "scales to multi-file writes" note.

### `sweep-cache-invalidation-audit` — Branch D recovery pattern field validation

The skill's Branch D guidance ("do not chase a timing-out sweep") is what deferred BATCH_SIZE from 9.5 to Phase 11. Phase 11's conversation-level-split redesign is the **recovery pattern** referenced in the skill. Add a "Recovery Patterns" subsection:

> When a cache-invalidating sweep hits Branch D (timeout), don't re-dispatch with a bigger timeout. Split the cache-invalidating axis across bounded containers: one container per (cell-axis, row-axis) pair. Aggregate results by the statistically-appropriate mean (weighted by `n_scored` for MRR; pooled counts for coverage/updateRate). Field-validated: STARmem BATCH_SIZE 5×5 split, Phase 11 Task 6-7.

Cross-reference: this mitigation is also in `docs/bench/baseline.json` knownIssues — the sweep-cache-invalidation-audit skill should link back to that for the mechanical detail.

### `writing-plans` — "pre-flight effectiveness" confirmation

Phase 11's plan was grounded against live code via jcm index at draft time (`_elbow_on_slice` source, `computeMetrics` shape, renderer line numbers, `run_sweep` dispatch structure). **Zero preflight-drift commits fired during execution** — every task's live-code reference in the plan matched reality. Exception: the two Task 6 Modal-wiring bugs, which were framework-level (not source-drift) and would not have been caught by source grounding.

Framing for the skill: source grounding is necessary and sufficient for source-level drift prevention, but not sufficient for framework-semantic bugs (decorator effects, timeout math, ORM session state, etc.). A distinct preflight pattern ("framework-semantic checks") covers the other class. Worth adding to the skill's preflight section as a second-category check.

---

## 7. Commit graph

Base: `738be46 docs(plans): check off final 9.5 done-when items` (immediately before Phase 11 Task 0).

```
27a839a docs(bench): baseline.json refresh — Phase 11 infrastructure hardening
0e9c17d docs(bench): Phase 11 Task 7 — BATCH_SIZE sweep complete
6c7fbaa fix(bench): bump run_batchsize_point timeout 600s → 1800s (Phase 11 Task 6 hot-fix 2)
344e88f fix(bench): remove @app.function from batchsize orchestrator (Phase 11 Task 6 hot-fix)
7f10b82 docs(bench): re-render 9.5 sweeps under two-column metric (Phase 11 Task 5)
e28b598 feat(bench): BATCH_SIZE conversation-level-split sweep (Phase 11 Task 6)
442456d feat(bench): amendment rule with coverage guard (Phase 11 Task 4.b)
fb69adb feat(bench): coverage field on MetricsResult (Phase 11 Task 4.a)
00269f3 feat(bench): baselines on Modal (Phase 11 Task 3)
1c5cc38 feat(bench): --local-out parity for run-point mode (Phase 11 Task 2)
58d937e fix(bench): elbow-detector zero-axis-Δ guard (Phase 11 Task 1)
c541d4c docs(plans): phase 11 infrastructure hardening plan
```

**12 commits + this retro commit = 13 total.** Phase 11 commit range: `c541d4c..HEAD`.

---

**Phase 11 closes.** The retrieval surface is unchanged from 9.4.8/9.5 — same `TIER2_TAU_GAP=10` spec default, same MRR 0.8057, same coverage 0.643. What changed is the measurement substrate: every future sweep renders a coverage column, proposes amendments only when both MRR and coverage pass the gate, and runs on Modal without cache-key-flow timeouts. Phase 12 can tune with confidence — any sweep that says "Amend" now actually means amend.
