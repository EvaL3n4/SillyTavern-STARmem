# STARmem Phase 12 — Multi-Corpus Benchmarking

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a second benchmark corpus (LongMemEval) alongside LoCoMo so Phase 10 (UI/UX) can make decisions against a multi-corpus retrieval surface rather than the single-corpus LoCoMo bottleneck that produced four provably-inert Tier 3 edge-weight knobs across three reproductions.

**Architecture:** Introduce a formal `CorpusAdapter` interface (`loadConversations() → CorpusConversation[]`) and port the existing LoCoMo loader behind it, then ship a LongMemEval-S adapter that flattens each 30-40-session haystack into a single `CorpusConversation` (one QA per item, all sessions concatenated into `turns[]`). QA items gain optional `taskType` (LongMemEval's 6 question types) and `abstention` fields; metrics and renderers slice on them when present. Modal substrate gains a `--corpus` parameter on `run-point`, `run-baselines`, and `run-sweep` so every dispatch mode handles either corpus interchangeably. Tier 2 demolition (~30 LOC warmup, zero retrieval-surface risk because `TIER2_TAU_GAP=10` already makes it inert) lands first to clean the ladder before the corpus work touches the retrieval path.

**Tech Stack:** Vanilla JS ES2022 modules (runtime), Python 3.12 + Modal SDK (sweep substrate), Jest (unit tests), Pytest (bench/modal tests), HuggingFace dataset hosting (LongMemEval-cleaned).

---

**Decisions locked before writing this plan (see conversation 2026-04-23):**

1. **Corpora.** LongMemEval (full, 5 task types analyzed separately) + LoCoMo single as regression control. LoCoMo single-session is non-negotiable.
2. **External baselines (Zep/Mem0/Mem3/MemGPT).** Deferred to v2.1.
3. **First live baselines-on-Modal dispatch.** In scope. Eva dispatches `--mode run-baselines` on current LoCoMo corpus in parallel with this plan drafting; results feed Task 6 synthesis.
4. **Knob re-sweep.** λ₁ tripwire on LongMemEval as Task 7. Decision gate: if `ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp` on any λ₁ grid point, expand Task 7 into a full 4-knob sweep (λ₁, λ₂, `EXPLICIT_RELATION_WEIGHT`, `COOCCURRENCE_WEIGHT`). If flat: two-corpus "provably inert" finding, stronger than one-corpus flatness — feeds v2.1 corpus-expansion plan.
5. **Corpus adapter.** Formal `CorpusAdapter` interface. LoCoMo ported first (moves `bench/loaders/locomo.js` behind the interface), then LongMemEval greenfield.
6. **Warmup task.** Tier 2 demolition — Task 1. ~30 LOC in `src/retrieval/ladder.js`.
7. **LongMemEval variant.** `_s` only (115K-tok haystack, 30-40 sessions per item, 500 items). `_oracle` (evidence-only upper-bound) and `_m` (500 sessions per item, ~1.5M tok) both deferred to v2.1 if needed.
8. **Shape mapping.** Flatten each haystack: one LongMemEval item → one `CorpusConversation` with all sessions' turns concatenated. 500 items → 500 single-conversation seedings, 1 QA each. This is the "ST pretends all history is one session" interpretation; LongMemEval-multi-session task type tanking on this shape while single-session types hold = Eva's ST-mismatch hypothesis evidence.
9. **Task-type reporting.** Per-task-type MRR + coverage slice (6 task types + aggregated). Abstention questions reported by count only, not scored.
10. **Abstention handling.** Excluded from scoring this phase. Report task-type counts but exclude `_abs` questions from MRR/coverage computation. Inverted metric (precision-at-emptiness, null-recall) deferred to v2.1.
11. **Deferred from Phase 11 retro.** `EXTRACT_MAX_TOKENS → 256` punted again; deserves dedicated attention post-multi-corpus. Renderer-signature convention inconsistency flagged, not addressed.
12. **Hypothesis evidence captured, not acted on.** ST-single-session-mismatch hypothesis remains Eva's v2.1/13 territory. Phase 12 captures the task-type breakdown that would support or falsify it; we do not pivot the retrieval surface on the finding.

---

## Execution status (2026-04-23 preflight)

Plan drafted + preflight-audited on 2026-04-23 against HEAD `7dae9a2`. Because the plan file had not yet landed on disk, preflight fixes are folded into the initial plan commit rather than being tracked as a separate `docs(plans): phase 12 preflight` patch. The findings below document what was caught at audit time so the retro paper-trail ties cleanly to the `plan-preflight-audit` skill's expectations. No tasks pre-shipped (all file targets `bench/corpora/*`, `bench/render/by-task-type.js`, `bench/modal/tests/test_corpus_param.py` confirmed absent at HEAD).

**Pre-dispatch fixes folded into the Task 0 commit:**

1. **Task 1 semantic-claim (false cache-warming migration).** Plan Step 3 said "move `recordTier0`/`recordTier1` into the Tier 3 success path." Reality: `ladder.js::retrieve()` already calls both in the Tier 3 success path. Removed the migration instruction; rewrote Step 3 + post-demolition shape + commit message as pure-delete. Caught by reading `src/retrieval/ladder.js::retrieve#function` source.

2. **Task 4 runner/seeder scope creep.** Plan listed `bench/runner.js` and `bench/harness/seeder.js` as "Modify" targets. Reality: `runHarness` already pushes the full `qa` object into each `runs[]` record (line ~105 of `bench/runner.js`); seeder doesn't touch QA propagation. Task 4's surface reduced from 3 Modify + 1 Create + 2 test files → 1 Modify + 1 Create + 2 test files. LOC estimate 250 → 150. Test fixtures rewritten to match the real `{ conversationId, qa, retrieved: [{ id, content, sourceMessages, score, tier }] }` shape (earlier draft used `{ chatId, queryStr, gold, retrieved: [{ provenance: { sourceMessages } }] }`, which `matchGoldByEvidence` would silently miss).

3. **Task 5 subprocess targets.** Plan Step 2 had `run_point` shelling to `["node", "bench/runner.js", "--corpus", corpus]`. Reality: `run_point` shells to `bench/sweeps/_modal-point.js`; `run_baseline_point` to `bench/baselines/_modal-point.js`; `run_batchsize_point` to `bench/sweeps/_modal-batchsize-point.js`. Task 5's file list extended to include all three entrypoints; runner.js marked explicitly untouched (its `runHarness({ corpus, ... })` already accepts a pre-loaded corpus array).

4. **Task 5 decorator-invariant mismodel.** Plan's Step 7 audit grep claimed `run_sweep` / `run_baselines` are undecorated orchestrators. Reality: both are top-level `@app.function`-decorated entries (they're what `modal run` targets directly). The Phase 11 Task 6 hot-fix was specifically about *sub-orchestrators* (`run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep`), which run inside `run_sweep`'s already-opened Modal context and would nest contexts if re-decorated. Rewrote the audit grep to target sub-orchestrators only.

5. **Task 5 CLI routing.** Plan said `bench/runner.js` should parse `--corpus` CLI. Reality: `bench/runner.js` exports the `runHarness` function, has no CLI parsing. The local CLI is `bench/cli.js` (line ~84 hardcodes `corpus !== 'locomo' → exit 1`); Modal-dispatched subprocesses are the three entrypoint files from fix #3. Moved corpus-selection edits to the correct files.

6. **Task 2 port must extend `QAItem` typedef.** Plan's "copy the entire current content" step would have copied the pre-Phase-12 `QAItem` typedef (no `taskType`/`abstention` fields), even though §1.2 already declares the extended shape as the target. Made the typedef extension explicit in Step 2.

7. **Test-count arithmetic.** Task 1 adds 2 assertions to an *existing* suite (`ladder.test.js`), not a new one. Task 2 → 79 suites / 835 tests. Task 3 → 80 / 845. Task 4 → 81 / 852. Fixed inline.

8. **ROADMAP §3 Phase 12 anchor placement.** Plan Step 4 said "after Phase 11 entry" in §3. Reality: §3 goes up to Phase 9 (Phase 10 skipped; Phase 11 lives only in §6 Phase Retro Log by prior-session convention). Fixed to append after Phase 9 with a note explaining the §6-only-for-retro convention.

9. **Plan length guardrail.** Task 0 Step 1 expected 1800–2200 lines; plan landed at 2639. Updated guardrail to ≥2500.

**Design-call annotations (not bugs, noted for retro clarity):**

- `baseline.json` will duplicate LoCoMo retriever entries at root AND under `perCorpus.locomo` so the Phase 9 schema validator stays green without extending it. This is a deliberate Phase 12 transitional shape; Phase 13 cleanup can collapse the duplication once the validator is updated.
- Post Task 1, `TIER2_TAU_GAP=10` inlining into graph/hops/relw sweeps becomes architecturally meaningless (no `t2.hit` branch to short-circuit). Kept in sweep configs for command-template durability per the preflight skill; Phase 13 removal candidate.

---

## 0. Scope and non-goals

**In scope:**
- Tier 2 demolition in `src/retrieval/ladder.js`
- `CorpusAdapter` interface at `bench/corpora/adapter.js`
- LoCoMo adapter port at `bench/corpora/locomo.js` (moves current `bench/loaders/locomo.js` logic behind the interface, keeps cache behavior identical)
- LongMemEval-S adapter at `bench/corpora/longmemeval.js` with HuggingFace fetch/cache
- QA items gain optional `taskType` + `abstention` fields via schema update
- `computeMetrics` produces per-taskType slice when `taskType` present on QA items
- Modal `sweep_app.py` parameterizes `--corpus {locomo,longmemeval-s}` across `run-point`, `run-baselines`, `run-sweep` modes
- Per-task-type renderer (`bench/render/by-task-type.js` + Python mirror in `sweep_app.py`)
- First live 4-retriever baselines run on **both** corpora, documented at `docs/bench/baselines/2026-04-XX-{locomo,longmemeval-s}.md`
- λ₁ tripwire sweep on LongMemEval-S with decision gate
- Phase 12 retro + Phase 10 handoff notes in ROADMAP

**Out of scope (explicit):**
- External-system baselines (Zep, Mem0, Mem3, MemGPT) — v2.1
- LongMemEval `_oracle` and `_m` variants — v2.1 if needed
- Abstention-scoring inverted metric — v2.1
- `EXTRACT_MAX_TOKENS → 256` sweep — post-Phase 12
- Renderer-signature convention cleanup (graph/consolidation stubs vs tau/bm25/hops/relw mismatch) — flagged in Phase 11 retro, not this phase
- ST-single-session-mismatch surgical fix (pivoting retrieval to handle multi-session) — v2.1 or Phase 13 after Phase 10 UI/UX informs it
- v1 migration code — per spec §11, clean break
- UI/UX changes — Phase 10 scope

---

## 1. Architecture

### 1.1 `CorpusAdapter` interface

```javascript
/**
 * @typedef {object} CorpusAdapter
 * @property {string} name
 *   Canonical corpus identifier. Matches `--corpus` CLI flag.
 *   Current values: 'locomo' | 'longmemeval-s'.
 * @property {() => Promise<CorpusConversation[]>} loadConversations
 *   Returns conversations in normalized shape. Implementations handle their
 *   own fetching, caching, and normalization. Deterministic ordering.
 * @property {object} metadata
 *   Human-readable corpus metadata for renderers / baseline.json writes.
 *   @property {string} metadata.sourceUrl       Canonical dataset URL
 *   @property {string} metadata.cacheKey        Relative path under bench/.cache/
 *   @property {number} metadata.itemCount       Total QA items (for sanity checks)
 *   @property {string[]} [metadata.taskTypes]   Task types present (LongMemEval only)
 */
```

### 1.2 `CorpusConversation` shape (unchanged from LoCoMo)

```javascript
/**
 * @typedef {object} CorpusConversation
 * @property {string} id
 *   Unique within corpus. LoCoMo: conv0 .. conv9. LongMemEval: question_id.
 * @property {Turn[]} turns
 *   All turns flattened across sessions. For LongMemEval, sessions are
 *   concatenated in `haystack_session_ids` order.
 * @property {QAItem[]} qa
 *   Questions for this conversation. LoCoMo: many per conv. LongMemEval: 1.
 *
 * @typedef {object} Turn
 * @property {string} speaker
 * @property {string} text
 * @property {number} sessionId
 *   Source session id (monotonic int for LongMemEval, session index for LoCoMo).
 * @property {number} turnIndex
 *   Global turn index within the flattened conversation (0-indexed).
 *
 * @typedef {object} QAItem
 * @property {string} question
 * @property {string} answer
 * @property {number[]} evidenceTurns
 *   Turn indices into conv.turns[] that contain the evidence for this answer.
 *   Empty array for abstention QAs.
 * @property {string} category
 *   Corpus-specific category (LoCoMo: 1..5 reasoning types; LongMemEval: question_type).
 * @property {string} [taskType]
 *   LongMemEval question_type ('single-session-user' | 'single-session-assistant' |
 *   'single-session-preference' | 'temporal-reasoning' | 'knowledge-update' |
 *   'multi-session'). Undefined for LoCoMo.
 * @property {boolean} [abstention]
 *   True for LongMemEval `_abs`-suffixed question_ids. Excluded from scoring
 *   in Phase 12 per Decision 10.
 */
```

### 1.3 File layout after Phase 12

```
bench/
├── corpora/                      # NEW directory
│   ├── adapter.js                # CorpusAdapter typedef + helpers
│   ├── locomo.js                 # Port of existing bench/loaders/locomo.js
│   ├── longmemeval.js            # NEW adapter
│   └── index.js                  # Barrel: getAdapter(name)
├── loaders/                      # DEPRECATED but kept for one phase (see T2)
│   ├── locomo.js                 # Re-exports from corpora/locomo.js
│   └── index.js                  # Re-exports from corpora/
├── harness/
│   ├── seeder.js                 # Unchanged signature; reads qa.taskType when present
│   └── ...
├── runner.js                     # Unchanged; runs returned carry qa.taskType through
├── metrics/
│   └── retrieval.js              # computeMetrics slices by taskType when present
├── render/
│   ├── by-task-type.js           # NEW per-task-type table renderer
│   └── amendment-rule.js         # Unchanged
└── modal/
    └── sweep_app.py              # --corpus parameter on run-point/baselines/sweep
```

Python mirror of `by-task-type.js` lives inside `bench/modal/sweep_app.py` for Modal-side rendering (consistent with existing `_should_amend` / `_elbow_on_slice` mirror pattern).

### 1.4 Per-corpus Modal dispatch commands

```bash
# Point-eval (ladder only, spec defaults):
modal run bench/modal/sweep_app.py --mode run-point --corpus locomo --overrides-json '{}' --local-out docs/bench/runs
modal run bench/modal/sweep_app.py --mode run-point --corpus longmemeval-s --overrides-json '{}' --local-out docs/bench/runs

# 4-retriever baselines:
modal run bench/modal/sweep_app.py --mode run-baselines --corpus locomo --local-out docs/bench/baselines
modal run bench/modal/sweep_app.py --mode run-baselines --corpus longmemeval-s --local-out docs/bench/baselines

# λ₁ tripwire on LongMemEval:
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name graph --corpus longmemeval-s --local-out docs/bench/sweeps
```

### 1.5 Test counts (baseline for preflight)

HEAD at plan commit: **77 suites / 824 tests (jest) + 8 tests (pytest bench/modal)**, all green.
Phase 12 target: +expected-additions documented per-task, total reported in retro.

---

## 2. Execution mode

**Controller (Azure / Opus 4.7) owns:**
- Task 0 (plan commit + preflight)
- Task 1 (Tier 2 demolition — 30 LOC, zero retrieval-surface risk, no subagent overhead)
- Task 6 (first live baselines synthesis from Eva's dispatch)
- Task 8 (retro + ROADMAP append)

**Subagent (Fireworks / Kimi K2.6 via `delegate_task`) owns:**
- Task 2 (CorpusAdapter interface + LoCoMo port)
- Task 3 (LongMemEval adapter)
- Task 4 (task-type propagation through seeder/metrics)
- Task 5 (Modal `--corpus` parameterization + per-task-type renderer)
- Task 7 (λ₁ tripwire — Eva dispatches Modal sweep; subagent preps sweep wiring)

**Parallel dispatch opportunities:**
- Task 1 (controller) ∥ Task 2 (subagent) — disjoint file sets. Task 2 touches `bench/corpora/` + `bench/loaders/` re-exports; Task 1 touches `src/retrieval/ladder.js` + its test.
- Task 4 ∥ Task 5 — both depend on Tasks 2 + 3. Disjoint files: Task 4 owns `bench/metrics/retrieval.js`, seeder wire, and `bench/render/by-task-type.js` JS renderer; Task 5 owns `bench/modal/sweep_app.py` `--corpus` parameterization and Python renderer mirror.

**Sequential dependencies:**
- Task 0 → Task 1 ∥ Task 2 (after Task 0 commits)
- Task 2 → Task 3 (interface must exist first)
- Task 3 → {Task 4 ∥ Task 5}
- Task 5 + Eva's Modal runs → Task 6
- {Task 4, Task 5} → Task 7 → Task 8

**Azure-flakiness posture:** Phase 11's hybrid split held cleanly (see retro). Same pattern — controller on mechanical/narrative, subagents on the large-surface refactors. Task 7's Modal dispatch is Eva's (continuing the established 9.4.8/9.4.9/9.5/11-Task-7 pattern).

---

## Overview of tasks

| # | Task | Primary files | Owner | Est. LOC | Est. tests added |
|---|------|--------------|-------|----------|------------------|
| 0 | Plan commit + jcm re-index verification | `docs/plans/phase-12-multi-corpus.md` | Controller | plan only | 0 |
| 1 | Tier 2 demolition | `src/retrieval/ladder.js`, `tests/unit/retrieval/ladder.test.js` | Controller | ~50 Δ | +2 assertions (regression) |
| 2 | `CorpusAdapter` interface + LoCoMo port | `bench/corpora/{adapter,locomo,index}.js`, `bench/loaders/{locomo,index}.js` | Subagent | ~250 | +6 |
| 3 | LongMemEval-S adapter + HF fetch/cache | `bench/corpora/longmemeval.js` | Subagent | ~300 | +10 |
| 4 | Task-type propagation through metrics | `bench/metrics/retrieval.js`, `bench/render/by-task-type.js` | Subagent | ~150 | +7 |
| 5 | Modal `--corpus` + Python renderer mirror | `bench/modal/sweep_app.py`, `bench/modal/tests/test_corpus_param.py` | Subagent | ~300 | +5 |
| 6 | First live 4-retriever baselines (both corpora) | `docs/bench/baselines/2026-04-XX-{locomo,longmemeval-s}.md`, `docs/bench/baseline.json` | Controller + Eva | artifacts | 0 |
| 7 | λ₁ tripwire sweep on LongMemEval (decision gate) | `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md`, maybe 3 more if gate expands | Subagent + Eva Modal | artifacts | 0 |
| 8 | Retro + Phase 10 handoff | `docs/plans/phase-12-retro.md`, `docs/plans/ROADMAP.md` | Controller | retro | 0 |

**Total estimate:** ~1050 LOC of runtime/test code + 4-7 artifact files + retro. +28 tests expected (jest 852 target, pytest 13 target).

**Worst-case Modal wall-clock:** LongMemEval-S is ~2-3× LoCoMo's per-conversation size (115K-tok haystack, ~40 sessions × ~10 turns vs LoCoMo's ~400 msgs). 500 items × ~2s seeding per item ≈ 17 min sequential on live extraction with warm cache. Cold cache worst case: 500 × 40 sessions × 1 extraction call × 5s = 100K calls ≈ 139 hours if unsharded. **This is a Task 3 decision gate: LongMemEval-S adapter must support conversation-level sharding from the first day.** See §Task 3 preflight for arithmetic.

---

## Task 0: Plan commit and preflight verification

**Objective:** Land this plan in `docs/plans/`, confirm jcm index freshness, run baseline test suite, and commit a Phase 12 open anchor in ROADMAP.

**Files:**
- Create: `docs/plans/phase-12-multi-corpus.md` (this file)
- Modify: `docs/plans/ROADMAP.md` (add Phase 12 anchor under §3)

**Step 1: Confirm plan file contents**

```bash
wc -l docs/plans/phase-12-multi-corpus.md
grep -c "^## Task " docs/plans/phase-12-multi-corpus.md
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-12-multi-corpus.md
```

Expected:
- `wc -l` ≥ 2500 (plan landed at 2639 lines at draft commit; `+` a handful from preflight patch)
- `grep -c "^## Task "` = 9 (Tasks 0-8)
- Secrets-guard redaction check: empty output

**Step 2: Re-index with jcm (incremental)**

```
mcp_jcodemunch_index_folder(
    path="/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem",
    incremental=true,
    use_ai_summaries=false
)
```

Expected: `git_head` matches current HEAD (`7dae9a2` at plan draft). If it doesn't, note the drift and re-run incremental.

**Step 3: Baseline test run**

```bash
npm test 2>&1 | tail -8
# Expected: Test Suites: 77 passed, 77 total
#           Tests:       824 passed, 824 total
cd bench/modal && python -m pytest -q 2>&1 | tail -5
# Expected: 8 passed
cd ../..
```

Any failure here blocks Task 1. Fix must land in its own pre-Task-1 commit.

**Step 4: Append Phase 12 anchor to ROADMAP.md §3**

Add to `docs/plans/ROADMAP.md` §3 (Phase-by-Phase), after the Phase 9 entry (Phase 10 skipped; Phase 11 lives only in §6 Phase Retro Log by prior-session convention — Phase 12 follows the same "retro in §6, new phases not retroactively added to §3 past the baseline 0-9" pattern, and simply appends a §3 entry so Phase 12's forward scope is discoverable):

```markdown
### Phase 12 — Multi-Corpus Benchmarking

**Purpose:** Ship a second benchmark corpus (LongMemEval-S) alongside LoCoMo so Phase 10 (UI/UX) designs against a multi-corpus retrieval surface.

**Inputs:** Phase 11 baseline infrastructure (coverage column, elbow guard, baselines-on-Modal surface, conversation-level-split template). Four provably-inert Tier 3 edge-weight knobs on LoCoMo single-session (λ₁, λ₂, EXPLICIT_RELATION_WEIGHT, COOCCURRENCE_WEIGHT, three-time reproduction).

**Outputs:**
- `bench/corpora/{adapter,locomo,longmemeval,index}.js`
- Tier 2 demolition landed in `src/retrieval/ladder.js`
- Per-task-type metrics slice in `bench/metrics/retrieval.js` + renderer `bench/render/by-task-type.js`
- Modal `--corpus` parameter across run-point/run-baselines/run-sweep modes
- First live 4-retriever baselines on both corpora (`docs/bench/baselines/*.md`)
- λ₁ tripwire sweep on LongMemEval-S (expands to full 4-knob sweep if signal surfaces)
- `docs/bench/baseline.json` refresh with per-corpus headlines

**Spec reference:** §6.1 (retrieval evaluation), §7 (benchmark harness). No spec changes required; LongMemEval fits the existing "deterministic QA-over-haystack" shape.

**Inter-phase contract:**
```typescript
// What Phase 10 inherits:
type CorpusAdapter = {
    name: 'locomo' | 'longmemeval-s';
    loadConversations: () => Promise<CorpusConversation[]>;
    metadata: { sourceUrl: string; cacheKey: string; itemCount: number; taskTypes?: string[] };
};

type MetricsResult = {
    // existing fields unchanged: recallAt1/5/10, mrr, coverage, p50/p95Latency, n_scored, n_skipped
    byTaskType?: Record<string, { mrr: number; coverage: number; n: number }>;
};
```

**Done-when:**
- [ ] Tier 2 demolition landed, ladder test regression suite green
- [ ] `CorpusAdapter` interface + LoCoMo port + LongMemEval-S adapter
- [ ] `computeMetrics` emits `byTaskType` when QA items carry `taskType`
- [ ] Modal `--corpus` parameter functional across 3 modes
- [ ] Live 4-retriever baselines documented for both corpora
- [ ] λ₁ tripwire + decision-gated expansion resolved
- [ ] Retro in `docs/plans/phase-12-retro.md` + ROADMAP Phase Retro Log entry
- [ ] All jest + pytest green at phase close
```

**Step 5: Commit**

```bash
git add docs/plans/phase-12-multi-corpus.md docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 12 multi-corpus benchmarking plan"
```

Expected range: 1 commit. Plan-commit hash becomes the Phase 12 anchor.

**Done-when:**
- [ ] Plan file lands, `grep -c "^## Task "` = 9
- [ ] jcm index fresh (git_head matches HEAD)
- [ ] npm test 77/824 green, pytest 8 green
- [ ] ROADMAP §3 has Phase 12 entry with typed contract
- [ ] Plan commit landed

---

## Task 1: Tier 2 demolition (warmup)

**Objective:** Simplify the retrieval ladder by removing the Tier 2 confident-hit gating path. `TIER2_TAU_GAP=10` already makes the ladder hit Tier 3 on every query (confirmed three-time across 9.4.8/9.4.9/9.5 live-extraction sweeps); Tier 2's role has collapsed to "BM25 candidate provider for Tier 3 seeding." Remove the Tier 2-returns-early branch and rename the call site to reflect the remaining role.

**Owner:** Controller (Azure). ~30 LOC, zero retrieval-surface risk because the demolition eliminates a code path that is never taken under the current amendment.

**Files:**
- Modify: `src/retrieval/ladder.js`
- Modify: `tests/unit/retrieval/ladder.test.js` — verify Tier 2-returns-early tests flip to "never fires" regression assertions
- Modify: `docs/plans/ROADMAP.md` (Phase 12 §6 entry note on demolition)

**Preflight (controller):**

```
mcp_jcodemunch_get_symbol_source(
    repo="local/SillyTavern-STARmem-036d3fcc",
    symbol_ids=["src/retrieval/ladder.js::retrieve#function"]
)
# Read full retrieve() body to identify the Tier 2 shortcut branch.
# Should be the block that checks for tau-gap satisfaction and returns early
# with tier2 results — typically between the Tier 1 miss continue and the
# Tier 3 seed call.

mcp_jcodemunch_search_text(
    repo="local/SillyTavern-STARmem-036d3fcc",
    query="TIER2_TAU_GAP|TIER2_TAU_CONFIDENCE",
    max_results=50
)
# Map every reference — constants, tier2-bm25.js internal logic, ladder.js
# consumption, tests, renderers. The constants stay; only the ladder branch
# that depends on them goes.
```

**Step 1: Read the current Tier 2 branch in `ladder.js`**

The current ladder shape (from preflight):

```javascript
// After Tier 0/1 miss, compute Tier 2 candidates:
const tier2Scored = tier2(state, queryStr, { ... });
// ... current code has a "confident hit" shortcut here that checks
//     tau_confidence and tau_gap, and if satisfied, returns tier2Scored
//     with tierResolved: 2 without seeding Tier 3.
// Then Tier 3 seeds from tier2Scored and returns graph-expanded results.
```

**Step 2: Write failing regression test (tripwire)**

Create or extend a test at `tests/unit/retrieval/ladder.test.js`:

```javascript
import { retrieve } from '../../../src/retrieval/ladder.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntryFromFact } from '../../../src/memory/entry.js';
// ... existing imports in the test file

describe('Tier 2 demolition (Phase 12 Task 1)', () => {
    test('retrieve() never returns tierResolved: 2 — Tier 2 always feeds Tier 3', () => {
        // Seed a state where a Tier 2 BM25 candidate would previously
        // have short-circuited the ladder (high tau_confidence, large gap).
        // Post-demolition, the ladder must proceed to Tier 3 and return
        // tier3 or floor.
        const state = createEmptyState();
        // ... seed a few entries such that classify() routes to factual
        //     and BM25 scores a rank-1 hit with clear margin.
        // (Use the existing "high-confidence Tier 2" fixture from the
        //  current test file. Preserve seed data exactly.)
        const result = retrieve(state, 'query that would have fired Tier 2 shortcut');
        expect(result.tierResolved).not.toBe(2);
        expect(['floor', 3]).toContain(result.tierResolved);
    });

    test('Tier 2 BM25 candidates still flow through to Tier 3 seeds', () => {
        // Same fixture as above; assert that the `perTier` trace field
        // contains Tier 2 scores even though tierResolved is 3.
        // This pins the "Tier 2 is the seed provider" invariant.
        const state = createEmptyState();
        // ... seed with same data
        const result = retrieve(state, 'query');
        expect(result.trace.perTier['2']).toBeDefined();
        expect(result.trace.perTier['2'].length).toBeGreaterThan(0);
    });
});
```

Run it: `npx jest tests/unit/retrieval/ladder.test.js -t "Tier 2 demolition"`

Expected: FAIL on first assertion because the current ladder still returns `tierResolved: 2` when the tau gating is satisfied.

**Step 3: Demolish the Tier 2 shortcut in `ladder.js`**

**Actual code shape (preflight read 2026-04-23, lines 190-220):**

```javascript
// --- Tier 2 ---
const t2 = tier2(state, queryStr, { now, intent: classifier, k: 10 });
if (t2.hit) {
    const topK = t2.scored.slice(0, k);
    const entriesOnly = topK.map(r => r.entry);
    let cached = recordTier0(state, queryStr, entriesOnly);
    cached = recordTier1(cached, queryStr, entriesOnly);
    const final = applyAccessEventsToReturned(cached, entriesOnly);
    const prepended = prependWorking(topK, working, now);
    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier,
        tierResolved: 2,
        perTier: {
            '2': topK.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
            '3': null,
        },
        finalRanking: prepended.map(r => r.entry.id),
        scorerId,
    });
    const nextState = logTrace(final.state, trace);
    return {
        entries: prepended.map(r => r.entry).slice(0, cap),
        tierResolved: 2,
        trace,
        state: nextState,
    };
}

// --- Tier 3: intent-routed graph expansion ---
if (t2.scored.length > 0) {
    const seeds = t2.scored.slice(0, RETRIEVAL.TIER3_SEEDS_K).map(r => r.entry);
    const t3Scored = tier3(state, seeds, queryStr, classifier, { now, k });
    // ... success path + empty-fallback to Floor with perTier2 ...
```

The `t2.hit` boolean is computed inside `src/retrieval/tier2-bm25.js`'s `tier2()` based on `TIER2_TAU_CONFIDENCE` and `TIER2_TAU_GAP` — that's where the confidence + gap logic lives. `tier2()` still returns a full `{ hit, scored }` object; demolition only removes `ladder.js`'s consumption of `hit`.

**The diff: delete the entire `if (t2.hit) { ... return ...; }` block.** The Tier 3 branch immediately below it becomes the always-taken path when `t2.scored.length > 0`. Two things to touch:

1. Remove the full `if (t2.hit)` block — 30 LOC.
2. Add a one-line explanatory comment at the same location noting the demolition + referencing the retro.

**Preflight note (2026-04-23):** An earlier draft of this step said "move the `recordTier0`/`recordTier1` calls from the Tier 2 shortcut into the Tier 3 success path." That instruction is wrong — the Tier 3 success path in `ladder.js` already calls both `recordTier0` and `recordTier1` on its own top-k (verified by reading `src/retrieval/ladder.js::retrieve#function` source). Demolition is a pure delete; no cache-warming migration needed.

Post-demolition shape:

```javascript
// --- Tier 2 ---
// Phase 12 Task 1: Tier 2 demolished as a resolver. The t2.hit shortcut
// is gone; Tier 2 is now exclusively a BM25 candidate provider for Tier 3
// seeding. TIER2_TAU_CONFIDENCE / TIER2_TAU_GAP constants retained in
// src/core/constants.js for replayability of pre-demolition sweep
// artifacts (Phase 13 removal candidate).
const t2 = tier2(state, queryStr, { now, intent: classifier, k: 10 });

// --- Tier 3: intent-routed graph expansion ---
if (t2.scored.length > 0) {
    const seeds = t2.scored.slice(0, RETRIEVAL.TIER3_SEEDS_K).map(r => r.entry);
    const t3Scored = tier3(state, seeds, queryStr, classifier, { now, k });
    // ... existing Tier 3 success path unchanged (already calls recordTier0 + recordTier1 on its top-k) ...
    // ... existing Tier 3-empty → runFloorBranch fallback with perTier2 prefix ...
}
```

The Tier 3 success path and the Tier 3-empty → Floor fallback both remain exactly as they are today; no behavioral delta beyond the elimination of the never-firing `tierResolved: 2` return.

**Step 4: Run the regression tests**

```bash
npx jest tests/unit/retrieval/ladder.test.js 2>&1 | tail -15
```

Expected: the two new "Tier 2 demolition" assertions PASS. **Any pre-existing test that asserted `tierResolved === 2`** now fails; those tests must be rewritten to match the new invariant (tier 2 → tier 3 seed).

**Step 5: Update pre-existing tests that assumed Tier 2 return**

```bash
grep -rn "tierResolved.*:.*2\|tierResolved === 2\|toBe(2)" tests/ src/ 2>&1 | grep -v node_modules
```

For each hit in tests/: rewrite the assertion. If the test's intent was "Tier 2 handles this query," rewrite to "Tier 3 handles this query using Tier 2 candidates as seeds" and assert `tierResolved === 3` + `trace.perTier['2'].length > 0`.

For hits in `src/` that consume `tierResolved`: verify none of them branch on the `2` value — the interceptor, trace renderer, and debug viewer should treat 2/3 as equivalent "retrieval succeeded." Any code that switches on tier === 2 specifically should be flagged in retro (shouldn't exist post-Phase 8 interceptor review, but verify).

**Step 6: Run full suite**

```bash
npm test 2>&1 | tail -8
```

Expected: 77 suites / 826 tests (+2 new Tier 2 demolition assertions, same suite). All green.

**Step 7: Commit**

```bash
git add src/retrieval/ladder.js tests/unit/retrieval/ladder.test.js
git commit -m "feat(retrieval): tier 2 demolition — always seed tier 3 (Phase 12 Task 1)

Removes the Tier 2 confident-hit shortcut that 9.4.8's TIER2_TAU_GAP=10
amendment + Phase 11's three-time flatness reproduction made inert. Tier
2 now serves exclusively as BM25 candidate provider for Tier 3 graph
expansion. Constants TIER2_TAU_CONFIDENCE and TIER2_TAU_GAP retained in
src/core/constants.js for replayability of pre-demolition sweep
artifacts; removal candidate for Phase 13.

Pure delete — Tier 3 success path already records top-k into T0/T1,
so no cache-warming migration needed. ~30 LOC diff in
src/retrieval/ladder.js; 2 regression assertions added to
tests/unit/retrieval/ladder.test.js pinning the no-tier-2-return
invariant and the tier-2-candidates-as-tier-3-seeds invariant."
```

**Done-when:**
- [ ] Tier 2 shortcut branch removed from `retrieve()`; `tier3(...)` call is unconditional on Tier 2 candidate presence
- [ ] Floor fallback handles Tier 3 empty result with Tier 2 trace prefix
- [ ] Two new regression assertions in ladder.test.js pinning the invariant
- [ ] Pre-existing `tierResolved === 2` assertions rewritten or tripwire-documented as "was Tier 2 path, now Tier 3 seeded by Tier 2"
- [ ] `npm test` green, test count 824 → 826
- [ ] Commit landed

---

## Task 2: `CorpusAdapter` interface + LoCoMo port

**Objective:** Introduce the formal `CorpusAdapter` interface under `bench/corpora/`, port the existing LoCoMo loader behind it without behavior change, and keep `bench/loaders/` as a backward-compatible re-export shim for one phase (removed in Phase 13 cleanup).

**Owner:** Subagent (Fireworks / Kimi K2.6 via `delegate_task`). Self-contained file-set refactor; ~250 LOC. Low Azure exposure by design.

**Files:**
- Create: `bench/corpora/adapter.js` — `CorpusAdapter` typedef + `getAdapter(name)` registry
- Create: `bench/corpora/locomo.js` — Port of `bench/loaders/locomo.js` exposing a `CorpusAdapter` instance
- Create: `bench/corpora/index.js` — Barrel: `getAdapter`, `locomoAdapter`
- Modify: `bench/loaders/locomo.js` — Convert to re-export shim pointing at `bench/corpora/locomo.js`
- Modify: `bench/loaders/index.js` — Re-export shim
- Create: `tests/unit/bench/corpora/adapter.test.js` — Interface shape + registry tests
- Create: `tests/unit/bench/corpora/locomo-adapter.test.js` — LoCoMo adapter returns the same conversations as the legacy loader (round-trip equality)

**Preflight (controller, before dispatch):**

```bash
# Confirm the current LoCoMo loader shape; Task 2 must preserve identity under re-export
grep -n "^export " bench/loaders/locomo.js bench/loaders/index.js
# Confirm no runtime import of bench/loaders/ outside bench/
grep -rn "from.*bench/loaders" src/ tests/ --include="*.js" | grep -v "bench/"
```

Expected:
- `bench/loaders/locomo.js`: `export const CANONICAL_URL` + `export async function loadLocomo(opts)`
- `bench/loaders/index.js`: `export { loadLocomo, CANONICAL_URL } from './locomo.js'`
- No `from.*bench/loaders` hits outside `bench/` (loaders are bench-internal)

**Step 1: Write the `CorpusAdapter` typedef and registry**

Create `bench/corpora/adapter.js`:

```javascript
/**
 * Corpus adapter interface.
 *
 * Every benchmark corpus (LoCoMo, LongMemEval, and future additions) implements
 * this interface. The bench harness (runner.js, sweep_app.py) is written against
 * the interface, not against any specific corpus.
 *
 * Adapters are responsible for:
 * 1. Fetching + caching raw dataset files (conventionally under bench/.cache/)
 * 2. Normalizing to `CorpusConversation[]` in deterministic order
 * 3. Exposing metadata for renderers / baseline.json writes
 *
 * Adapters are NOT responsible for:
 * - Seeding STARmem state (that's bench/harness/seeder.js)
 * - Scoring retrieval (that's bench/metrics/retrieval.js)
 * - Dispatching to Modal (that's bench/modal/sweep_app.py)
 *
 * @module bench/corpora/adapter
 */

/**
 * @typedef {object} CorpusAdapter
 * @property {string} name
 *   Canonical identifier. Matches the `--corpus` CLI flag. Must be unique.
 *   Current values: 'locomo' | 'longmemeval-s'.
 * @property {() => Promise<CorpusConversation[]>} loadConversations
 *   Returns conversations in normalized shape. Implementations handle
 *   their own fetching, caching, and normalization. MUST be deterministic
 *   across calls with the same cache state (sort order stable).
 * @property {CorpusMetadata} metadata
 *
 * @typedef {object} CorpusMetadata
 * @property {string} sourceUrl      Canonical dataset URL (HF dataset URL, GitHub raw URL, etc.)
 * @property {string} cacheKey       Relative path under bench/.cache/ (e.g. 'locomo10.json')
 * @property {number} itemCount      Expected total QA item count for sanity checks (10 convs × ~200 QA ≈ 2000 for LoCoMo; 500 for LongMemEval-S)
 * @property {string[]} [taskTypes]  Task types present, LongMemEval only
 * @property {boolean} [multiSession] True if corpus has multi-session haystacks (LongMemEval-S: true; LoCoMo: false — per Decision 8 LoCoMo's sessions are already flattened)
 *
 * @typedef {import('../loaders/locomo.js').CorpusConversation} CorpusConversation
 */

/**
 * Registry of known adapters. Populated at import time by
 * bench/corpora/index.js's barrel.
 *
 * @type {Map<string, CorpusAdapter>}
 */
const REGISTRY = new Map();

/**
 * Register a corpus adapter. Called by each adapter's module-load side effect.
 *
 * @param {CorpusAdapter} adapter
 */
export function registerAdapter(adapter) {
    if (!adapter || typeof adapter.name !== 'string' || adapter.name.length === 0) {
        throw new Error(`registerAdapter: adapter must have a non-empty name, got ${JSON.stringify(adapter)}`);
    }
    if (typeof adapter.loadConversations !== 'function') {
        throw new Error(`registerAdapter(${adapter.name}): loadConversations must be a function`);
    }
    if (!adapter.metadata || typeof adapter.metadata.sourceUrl !== 'string') {
        throw new Error(`registerAdapter(${adapter.name}): metadata.sourceUrl required`);
    }
    REGISTRY.set(adapter.name, adapter);
}

/**
 * Retrieve an adapter by name. Throws on unknown name to surface config
 * typos early (e.g. `--corpus locomo10` vs `locomo`).
 *
 * @param {string} name
 * @returns {CorpusAdapter}
 */
export function getAdapter(name) {
    const adapter = REGISTRY.get(name);
    if (!adapter) {
        const known = Array.from(REGISTRY.keys()).sort().join(', ') || '(none registered)';
        throw new Error(`getAdapter: unknown corpus ${JSON.stringify(name)}. Known: ${known}`);
    }
    return adapter;
}

/**
 * List all registered adapter names.
 * @returns {string[]}
 */
export function listAdapters() {
    return Array.from(REGISTRY.keys()).sort();
}

/**
 * Test helper: clear the registry. Adapters re-register on re-import;
 * tests that want isolated registries should use jest.resetModules().
 */
export function _clearRegistryForTests() {
    REGISTRY.clear();
}
```

**Step 2: Port LoCoMo loader to `bench/corpora/locomo.js`**

Copy the entire current content of `bench/loaders/locomo.js` to `bench/corpora/locomo.js`, **with one mandatory edit during the copy**: extend the `QAItem` typedef to match Phase 12 §1.2 — add `taskType?: string` and `abstention?: boolean` optional fields. LoCoMo never populates these; the typedef update is purely forward-compatibility for `bench/runner.js` and `bench/metrics/retrieval.js` which will read `qa?.taskType` / `qa?.abstention` in Task 4 regardless of corpus.

Concretely, the ported `QAItem` typedef block must look like:

```javascript
/**
 * @typedef {object} QAItem
 * @property {string} question
 * @property {string} answer
 * @property {number[]} evidenceTurns
 * @property {string} category
 * @property {string} [taskType]
 *   LongMemEval question_type. Undefined for LoCoMo. See Phase 12 §1.2.
 * @property {boolean} [abstention]
 *   True for LongMemEval `_abs`-suffixed question_ids. Excluded from
 *   scoring per Phase 12 Decision 10. Undefined (≡ false) for LoCoMo.
 */
```

At the end, add a module-load side effect that registers the adapter:

```javascript
// ... existing file content from bench/loaders/locomo.js
// (loadLocomo, CANONICAL_URL, CorpusConversation typedef, Turn typedef, QAItem typedef — all kept as-is)

import { registerAdapter } from './adapter.js';

/**
 * LoCoMo corpus adapter.
 *
 * @type {import('./adapter.js').CorpusAdapter}
 */
export const locomoAdapter = {
    name: 'locomo',
    loadConversations: (opts = {}) => loadLocomo(opts),
    metadata: {
        sourceUrl: CANONICAL_URL,
        cacheKey: 'locomo10.json',
        itemCount: 1986,
        multiSession: false,
    },
};

registerAdapter(locomoAdapter);
```

Keep the existing `loadLocomo(opts)` signature exactly — it accepts `{ maxConversations, offline, cachePath }`. The adapter's `loadConversations(opts)` is a thin forwarder so that legacy callers (seeder, runner smoke tests) still work while the new corpus-driven paths use the adapter.

**Step 3: Convert `bench/loaders/locomo.js` to a re-export shim**

Replace the entire content of `bench/loaders/locomo.js` with:

```javascript
/**
 * @deprecated Import from `bench/corpora/locomo.js` instead. This file
 * is a re-export shim kept for backward compatibility during Phase 12;
 * removed in Phase 13 cleanup.
 *
 * @module bench/loaders/locomo
 */

export {
    loadLocomo,
    CANONICAL_URL,
    locomoAdapter,
} from '../corpora/locomo.js';
```

Replace `bench/loaders/index.js`:

```javascript
/**
 * @deprecated Import from `bench/corpora/` instead. Shim for Phase 12.
 * @module bench/loaders
 */
export { loadLocomo, CANONICAL_URL, locomoAdapter } from './locomo.js';
```

**Step 4: Create `bench/corpora/index.js` barrel**

```javascript
/**
 * Corpus adapter barrel. Imports every adapter's module (registering it
 * as a side effect) and re-exports the registry API for consumers.
 *
 * @module bench/corpora
 */

// Adapter registrations happen at import time via module-load side effect.
import './locomo.js';
// import './longmemeval.js'; // uncomment when Task 3 lands

export { getAdapter, listAdapters, registerAdapter } from './adapter.js';
export { locomoAdapter, loadLocomo, CANONICAL_URL } from './locomo.js';
```

The `longmemeval.js` import is commented out deliberately. Task 3 uncomments it as part of the LongMemEval adapter landing. This keeps Task 2 self-contained: the registry works with just LoCoMo; the barrel is explicit about what's wired.

**Step 5: Write adapter interface tests**

Create `tests/unit/bench/corpora/adapter.test.js`:

```javascript
import { getAdapter, listAdapters, registerAdapter, _clearRegistryForTests } from '../../../../bench/corpora/adapter.js';

describe('CorpusAdapter registry', () => {
    afterEach(() => {
        _clearRegistryForTests();
    });

    test('registerAdapter accepts a valid adapter and it can be retrieved', () => {
        const mockAdapter = {
            name: 'test-corpus',
            loadConversations: async () => [],
            metadata: { sourceUrl: 'https://example.com/test', cacheKey: 'test.json', itemCount: 0 },
        };
        registerAdapter(mockAdapter);
        expect(getAdapter('test-corpus')).toBe(mockAdapter);
        expect(listAdapters()).toEqual(['test-corpus']);
    });

    test('registerAdapter rejects adapters missing a name', () => {
        expect(() => registerAdapter({ loadConversations: async () => [], metadata: { sourceUrl: 'x', cacheKey: 'x', itemCount: 0 } }))
            .toThrow(/non-empty name/);
    });

    test('registerAdapter rejects adapters missing loadConversations', () => {
        expect(() => registerAdapter({ name: 'x', metadata: { sourceUrl: 'x', cacheKey: 'x', itemCount: 0 } }))
            .toThrow(/loadConversations must be a function/);
    });

    test('registerAdapter rejects adapters missing metadata.sourceUrl', () => {
        expect(() => registerAdapter({ name: 'x', loadConversations: async () => [], metadata: {} }))
            .toThrow(/metadata\.sourceUrl required/);
    });

    test('getAdapter throws on unknown name and lists known adapters', () => {
        registerAdapter({
            name: 'corpus-a',
            loadConversations: async () => [],
            metadata: { sourceUrl: 'x', cacheKey: 'x', itemCount: 0 },
        });
        expect(() => getAdapter('corpus-b'))
            .toThrow(/unknown corpus "corpus-b"\. Known: corpus-a/);
    });

    test('getAdapter throws with "(none registered)" when registry is empty', () => {
        expect(() => getAdapter('anything'))
            .toThrow(/\(none registered\)/);
    });
});
```

Run: `npx jest tests/unit/bench/corpora/adapter.test.js -v`
Expected: 6 tests pass.

**Step 6: Write LoCoMo adapter round-trip test**

Create `tests/unit/bench/corpora/locomo-adapter.test.js`:

```javascript
import { getAdapter, listAdapters } from '../../../../bench/corpora/index.js';
import { loadLocomo } from '../../../../bench/loaders/locomo.js';

describe('LoCoMo adapter (Phase 12 Task 2 port)', () => {
    test('locomoAdapter is registered after importing the barrel', () => {
        expect(listAdapters()).toContain('locomo');
    });

    test('getAdapter("locomo") returns an adapter with the expected metadata', () => {
        const adapter = getAdapter('locomo');
        expect(adapter.name).toBe('locomo');
        expect(adapter.metadata.sourceUrl).toMatch(/snap-research\/locomo/);
        expect(adapter.metadata.cacheKey).toBe('locomo10.json');
        expect(adapter.metadata.multiSession).toBe(false);
    });

    test('adapter.loadConversations({maxConversations:1}) matches legacy loadLocomo({maxConversations:1})', async () => {
        const adapter = getAdapter('locomo');
        const viaAdapter = await adapter.loadConversations({ maxConversations: 1, offline: true });
        const viaLegacy = await loadLocomo({ maxConversations: 1, offline: true });
        expect(viaAdapter.length).toBe(viaLegacy.length);
        expect(viaAdapter[0].id).toBe(viaLegacy[0].id);
        expect(viaAdapter[0].turns.length).toBe(viaLegacy[0].turns.length);
        expect(viaAdapter[0].qa.length).toBe(viaLegacy[0].qa.length);
    });
});
```

Run: `npx jest tests/unit/bench/corpora/locomo-adapter.test.js -v`
Expected: 3 tests pass (requires `bench/.cache/locomo10.json` to be present, which it is from prior phases).

**Step 7: Full suite regression**

```bash
npm test 2>&1 | tail -8
```

Expected: 79 suites / 835 tests (+2 new suites from Task 2 — adapter.test.js, locomo-adapter.test.js — +9 assertions total; Task 1's +2 landed into an existing suite). Everything green.

**Step 8: Commit**

```bash
git add bench/corpora/ bench/loaders/ tests/unit/bench/corpora/
git commit -m "feat(bench): CorpusAdapter interface + LoCoMo port (Phase 12 Task 2)

Introduces bench/corpora/ as the new home for benchmark corpus adapters.
CorpusAdapter interface (adapter.js) defines a registry-based plugin model;
adapters register themselves at module-load time. LoCoMo port (corpora/locomo.js)
wraps the existing loader behind the interface while preserving the
loadLocomo() signature for legacy callers.

bench/loaders/ converted to re-export shims for backward compatibility
during Phase 12; scheduled removal in Phase 13.

Tests: 9 new assertions across adapter.test.js (6 registry API) and
locomo-adapter.test.js (3 round-trip equality with legacy loader)."
```

**Done-when:**
- [ ] `bench/corpora/{adapter,locomo,index}.js` created
- [ ] `bench/loaders/{locomo,index}.js` converted to re-export shims
- [ ] Module-load side effect registers LoCoMo adapter
- [ ] `getAdapter('locomo')` works, returns adapter with correct metadata
- [ ] Legacy `loadLocomo()` still works unchanged via shim
- [ ] Round-trip equality test passes (adapter vs legacy loader produce identical conversations)
- [ ] +9 tests green; 835 total, 79 suites

**Subagent delegation context (include verbatim when dispatching):**

> You are implementing STARmem Phase 12 Task 2. The plan is at `docs/plans/phase-12-multi-corpus.md` — read the `## Task 2` section in full before starting. Key invariants: (1) `bench/loaders/locomo.js` must remain a working import path for legacy callers (re-export shim). (2) `loadLocomo(opts)` signature is unchanged — `{ maxConversations, offline, cachePath }`. (3) `CorpusConversation` shape is unchanged from the current `bench/loaders/locomo.js` typedef; do not modify it. (4) Do NOT import `bench/corpora/longmemeval.js` in the barrel yet — it's Task 3. (5) If you see `const FOO = ***` in the plan, that is a tooling redaction, not real code — stop and report. (6) Commit exactly as specified in Step 8; nothing else.

---

## Task 3: LongMemEval-S adapter + HF fetch/cache

**Objective:** Ship a LongMemEval-S adapter that fetches `longmemeval_s_cleaned.json` from HuggingFace, caches it under `bench/.cache/`, and flattens each 30-40-session haystack into one `CorpusConversation` with all sessions concatenated into `turns[]`. The adapter propagates `taskType` from LongMemEval's `question_type` field and `abstention` from `_abs` suffix detection onto each QA item.

**Owner:** Subagent (Fireworks / Kimi K2.6). ~300 LOC; self-contained after Task 2 lands.

**Files:**
- Create: `bench/corpora/longmemeval.js` — Adapter with HF fetch, caching, normalization
- Modify: `bench/corpora/index.js` — Uncomment the `import './longmemeval.js'` line
- Create: `tests/unit/bench/corpora/longmemeval-adapter.test.js` — Shape invariants + task-type propagation + abstention detection + fixture-based deterministic test (no network)
- Create: `tests/fixtures/bench/longmemeval-s-fixture.json` — 3-item trimmed LongMemEval-S sample for deterministic unit tests (no network calls in tests)

**Decision gate — conversation-level sharding preparedness:**

LongMemEval-S is 500 items × ~115K tokens of haystack each. Rough worst-case Modal arithmetic (per writing-plans preflight rule §B):

```
Per-item seeding cost (cold cache):
  ~40 sessions × ~10 turns × 1 extraction call × 5s per live Gemma call
  = ~2000s per item cold
  × 500 items = 1,000,000s = ~278 container-hours cold

Per-item seeding cost (warm cache):
  ~40 sessions × ~10 turns × 1 cache hit × 0.01s
  = ~4s per item warm
  × 500 items = 2000s = ~33 minutes single-container warm

Modal free-tier concurrent cap: 32 containers
  500 items / 32 containers = 16 items per container
  Wall-clock at 4s/item warm: 64s (~1 min)
  Wall-clock at 2000s/item cold: ~9 hours (sharded)
```

**Decision:** Task 3 ships the adapter only. Cache warming is Eva's Modal dispatch in Task 6's preamble (runs `run-point --corpus longmemeval-s` on every item once to populate the extraction cache; discards the metrics). Sharding is Task 5's responsibility — the adapter just returns 500 conversations; the substrate decides how to distribute them across containers.

**Preflight (controller, before dispatch):**

Verify dataset schema matches what the adapter will parse. The schema was captured during conversation:

```
LongMemEval-S item fields:
- question_id: str (ends with '_abs' for abstention questions)
- question_type: 'single-session-user' | 'single-session-assistant' |
                 'single-session-preference' | 'temporal-reasoning' |
                 'knowledge-update' | 'multi-session'
- question: str
- answer: str
- question_date: str (ISO)
- haystack_session_ids: list[str]    (sorted by timestamp in _s)
- haystack_dates: list[str]
- haystack_sessions: list[list[Turn]]  (aligned with session_ids)
  Turn: { role: 'user' | 'assistant', content: str, has_answer?: bool }
- answer_session_ids: list[str]       (evidence sessions)
```

The adapter reads `has_answer: true` on individual turns to populate `qa[0].evidenceTurns[]` (global turn indices post-flattening). Without `has_answer`, `answer_session_ids` provides session-level evidence; the adapter falls back to marking every turn in an evidence session as evidence.

**Step 1: Download a 3-item fixture for deterministic tests**

Controller runs this before dispatch (one-time):

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
mkdir -p tests/fixtures/bench
# Fetch the cleaned _s dataset, slice 3 items including 1 abstention + 1 single-session + 1 multi-session
# (HF raw URL; if this fails from the sandbox, Eva downloads locally and copies into tests/fixtures/)
cat <<'EOF_NOTE' > /tmp/fixture-note.md
Three items needed in tests/fixtures/bench/longmemeval-s-fixture.json:
- One single-session-user item with has_answer turns, small haystack (3-5 sessions)
- One multi-session item with evidence across 2 sessions
- One abstention item (question_id ending in _abs)
Trim each haystack_sessions to 3-5 sessions × 5-10 turns for small fixture size.
EOF_NOTE
```

**Note to subagent:** If `tests/fixtures/bench/longmemeval-s-fixture.json` doesn't exist at dispatch time, stop and ask the controller — Eva will source the fixture manually. Do NOT attempt a network fetch from the sandbox to create the fixture.

**Step 2: Write the adapter**

Create `bench/corpora/longmemeval.js`:

```javascript
/**
 * LongMemEval-S corpus adapter.
 *
 * Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * Paper: https://arxiv.org/abs/2410.10813
 *
 * The _s variant has 500 items. Each item has:
 * - One question + answer
 * - A haystack of ~30-40 sessions (~115K tokens total)
 * - A question_type (6 types + abstention suffix)
 * - Evidence markers (has_answer on turns, answer_session_ids)
 *
 * This adapter flattens each haystack into a single CorpusConversation:
 * all sessions concatenated into turns[] in haystack_session_ids order,
 * with sessionId=int index and turnIndex=global position.
 *
 * Per Phase 12 Decision 8, the flatten shape intentionally collapses
 * multi-session structure so that the retrieval ladder sees LongMemEval
 * the same way SillyTavern presents chat history — as one long session.
 * Task-type slicing in Task 4 preserves the signal needed to test
 * whether this collapse harms multi-session reasoning specifically.
 *
 * @module bench/corpora/longmemeval
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAdapter } from './adapter.js';

/** @typedef {import('./adapter.js').CorpusAdapter} CorpusAdapter */
/** @typedef {import('./locomo.js').CorpusConversation} CorpusConversation */
/** @typedef {import('./locomo.js').Turn} Turn */
/** @typedef {import('./locomo.js').QAItem} QAItem */

export const CANONICAL_URL =
    'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';

const DEFAULT_CACHE = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'longmemeval_s_cleaned.json',
);

/**
 * @typedef {object} LongMemEvalTurn
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {boolean} [has_answer]
 */

/**
 * @typedef {object} LongMemEvalItem
 * @property {string} question_id
 * @property {string} question_type
 * @property {string} question
 * @property {string} answer
 * @property {string} question_date
 * @property {string[]} haystack_session_ids
 * @property {string[]} haystack_dates
 * @property {LongMemEvalTurn[][]} haystack_sessions
 * @property {string[]} answer_session_ids
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.cachePath] Override cache location
 * @param {boolean} [opts.offline]  Never touch the network, fail if cache missing
 * @param {number}  [opts.maxItems] Truncate for smoke runs; default is full 500
 * @returns {Promise<CorpusConversation[]>}
 */
export async function loadLongMemEvalS(opts = {}) {
    const { cachePath = DEFAULT_CACHE, offline = false, maxItems } = opts;

    let raw;
    if (existsSync(cachePath)) {
        raw = JSON.parse(await readFile(cachePath, 'utf8'));
    } else if (offline) {
        throw new Error(`loadLongMemEvalS: cache missing at ${cachePath} and offline=true`);
    } else {
        // Network fetch + cache
        const response = await fetch(CANONICAL_URL);
        if (!response.ok) {
            throw new Error(`loadLongMemEvalS: fetch ${CANONICAL_URL} returned ${response.status}`);
        }
        raw = await response.json();
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(raw));
    }

    if (!Array.isArray(raw)) {
        throw new Error(`loadLongMemEvalS: expected array at root, got ${typeof raw}`);
    }

    const items = maxItems ? raw.slice(0, maxItems) : raw;
    return items.map(normalizeItem);
}

/**
 * Flatten one LongMemEval item into a CorpusConversation.
 *
 * @param {LongMemEvalItem} item
 * @returns {CorpusConversation}
 */
export function normalizeItem(item) {
    const turns = /** @type {Turn[]} */ ([]);
    const evidenceTurns = /** @type {number[]} */ ([]);

    const evidenceSessionSet = new Set(item.answer_session_ids || []);

    for (let sessionIdx = 0; sessionIdx < item.haystack_sessions.length; sessionIdx++) {
        const session = item.haystack_sessions[sessionIdx];
        const sessionId = item.haystack_session_ids[sessionIdx];
        const isEvidenceSession = evidenceSessionSet.has(sessionId);

        for (let turnInSession = 0; turnInSession < session.length; turnInSession++) {
            const rawTurn = session[turnInSession];
            const turnIndex = turns.length;

            turns.push({
                speaker: rawTurn.role,
                text: rawTurn.content,
                sessionId: sessionIdx,
                turnIndex,
            });

            // Prefer has_answer per-turn marker; fall back to whole-session
            // evidence marking when has_answer is absent.
            if (rawTurn.has_answer === true) {
                evidenceTurns.push(turnIndex);
            }
        }

        // Fallback: if this session is flagged as evidence but NO turn had
        // has_answer, mark every turn in the session as evidence (coarser
        // but safer than returning empty evidence for a question that has
        // a known evidence location).
        const sessionHasGranularEvidence = session.some(t => t.has_answer === true);
        if (isEvidenceSession && !sessionHasGranularEvidence) {
            const sessionStart = turns.length - session.length;
            for (let i = sessionStart; i < turns.length; i++) {
                evidenceTurns.push(i);
            }
        }
    }

    const abstention = item.question_id.endsWith('_abs');

    const qa = /** @type {QAItem} */ ({
        question: item.question,
        answer: item.answer,
        evidenceTurns,
        category: item.question_type,  // Preserve for backward-compat with any LoCoMo consumer
        taskType: item.question_type,
        abstention,
    });

    return {
        id: item.question_id,
        turns,
        qa: [qa],
    };
}

/**
 * LongMemEval-S adapter.
 *
 * @type {CorpusAdapter}
 */
export const longmemevalSAdapter = {
    name: 'longmemeval-s',
    loadConversations: (opts = {}) => loadLongMemEvalS(opts),
    metadata: {
        sourceUrl: CANONICAL_URL,
        cacheKey: 'longmemeval_s_cleaned.json',
        itemCount: 500,
        taskTypes: [
            'single-session-user',
            'single-session-assistant',
            'single-session-preference',
            'temporal-reasoning',
            'knowledge-update',
            'multi-session',
        ],
        multiSession: true,
    },
};

registerAdapter(longmemevalSAdapter);
```

**Step 3: Uncomment the barrel import**

In `bench/corpora/index.js`:

```javascript
import './locomo.js';
import './longmemeval.js';  // Uncommented in Phase 12 Task 3

export { getAdapter, listAdapters, registerAdapter } from './adapter.js';
export { locomoAdapter, loadLocomo, CANONICAL_URL as LOCOMO_URL } from './locomo.js';
export { longmemevalSAdapter, loadLongMemEvalS, CANONICAL_URL as LONGMEMEVAL_S_URL } from './longmemeval.js';
```

Note the `CANONICAL_URL as LOCOMO_URL` renames — both adapter modules export `CANONICAL_URL`, so the barrel disambiguates.

**Step 4: Write fixture-based adapter tests**

Create `tests/unit/bench/corpora/longmemeval-adapter.test.js`:

```javascript
import { getAdapter, listAdapters } from '../../../../bench/corpora/index.js';
import { normalizeItem, loadLongMemEvalS } from '../../../../bench/corpora/longmemeval.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '..', '..', 'fixtures', 'bench', 'longmemeval-s-fixture.json',
);

describe('LongMemEval-S adapter (Phase 12 Task 3)', () => {
    test('longmemevalSAdapter is registered after importing the barrel', () => {
        expect(listAdapters()).toContain('longmemeval-s');
    });

    test('adapter metadata lists the 6 expected task types and multiSession=true', () => {
        const adapter = getAdapter('longmemeval-s');
        expect(adapter.metadata.taskTypes).toEqual([
            'single-session-user',
            'single-session-assistant',
            'single-session-preference',
            'temporal-reasoning',
            'knowledge-update',
            'multi-session',
        ]);
        expect(adapter.metadata.multiSession).toBe(true);
        expect(adapter.metadata.itemCount).toBe(500);
    });

    describe('normalizeItem shape', () => {
        const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
        // Fixture item 0: single-session-user with has_answer turns
        // Fixture item 1: multi-session with evidence across 2 sessions
        // Fixture item 2: abstention item (_abs suffix)

        test('flattens all haystack sessions into a single turns[] array', () => {
            const conv = normalizeItem(fixture[0]);
            const totalTurns = fixture[0].haystack_sessions.reduce((n, s) => n + s.length, 0);
            expect(conv.turns.length).toBe(totalTurns);
        });

        test('assigns monotonically increasing turnIndex across sessions', () => {
            const conv = normalizeItem(fixture[0]);
            for (let i = 0; i < conv.turns.length; i++) {
                expect(conv.turns[i].turnIndex).toBe(i);
            }
        });

        test('preserves per-session sessionId through flattening', () => {
            const conv = normalizeItem(fixture[0]);
            let lastSessionId = -1;
            for (const t of conv.turns) {
                expect(t.sessionId).toBeGreaterThanOrEqual(lastSessionId);
                lastSessionId = t.sessionId;
            }
        });

        test('propagates taskType from question_type', () => {
            const conv = normalizeItem(fixture[0]);
            expect(conv.qa[0].taskType).toBe('single-session-user');
        });

        test('populates evidenceTurns from has_answer markers', () => {
            const conv = normalizeItem(fixture[0]);
            expect(conv.qa[0].evidenceTurns.length).toBeGreaterThan(0);
            // Every evidenceTurn index should point to a turn with has_answer
            // true in the original fixture (or belong to an evidence session
            // under the fallback rule).
            for (const idx of conv.qa[0].evidenceTurns) {
                expect(conv.turns[idx]).toBeDefined();
            }
        });

        test('falls back to session-level evidence when has_answer is absent', () => {
            const conv = normalizeItem(fixture[1]);
            // Fixture item 1 is multi-session; evidence set covers ≥2 sessions
            // but does not use has_answer at turn level. Every turn in
            // evidence sessions should be marked.
            expect(conv.qa[0].evidenceTurns.length).toBeGreaterThan(0);
            const sessionsOfEvidence = new Set(
                conv.qa[0].evidenceTurns.map(i => conv.turns[i].sessionId),
            );
            expect(sessionsOfEvidence.size).toBeGreaterThanOrEqual(2);
        });

        test('detects abstention from _abs suffix', () => {
            const conv = normalizeItem(fixture[2]);
            expect(conv.qa[0].abstention).toBe(true);
            expect(conv.id.endsWith('_abs')).toBe(true);
        });

        test('non-abstention items have abstention=false', () => {
            const conv = normalizeItem(fixture[0]);
            expect(conv.qa[0].abstention).toBe(false);
        });
    });

    test('loadLongMemEvalS({offline:true}) reads from cache without network', async () => {
        // Requires bench/.cache/longmemeval_s_cleaned.json to exist.
        // Eva warms this before running the full suite; tests that don't
        // have the cache should skip cleanly.
        const cachePath = path.resolve(
            fileURLToPath(new URL('.', import.meta.url)),
            '..', '..', '..', '..', 'bench', '.cache', 'longmemeval_s_cleaned.json',
        );
        const fs = await import('node:fs');
        if (!fs.existsSync(cachePath)) {
            console.warn('Skipping offline cache test: bench/.cache/longmemeval_s_cleaned.json missing');
            return;
        }
        const convs = await loadLongMemEvalS({ offline: true, maxItems: 3 });
        expect(convs.length).toBe(3);
        expect(convs[0].qa.length).toBe(1);
        expect(convs[0].qa[0].taskType).toBeDefined();
    });
});
```

Run: `npx jest tests/unit/bench/corpora/longmemeval-adapter.test.js -v`
Expected: 10 tests pass (the final cache test skips if cache not present).

**Step 5: Full suite**

```bash
npm test 2>&1 | tail -8
```

Expected: 80 suites / 845 tests (+1 suite, +10 assertions from Task 3). All green.

**Step 6: Commit**

```bash
git add bench/corpora/longmemeval.js bench/corpora/index.js tests/unit/bench/corpora/longmemeval-adapter.test.js tests/fixtures/bench/longmemeval-s-fixture.json
git commit -m "feat(bench): LongMemEval-S corpus adapter (Phase 12 Task 3)

Adds second benchmark corpus. Each of the 500 items becomes one
CorpusConversation with all haystack sessions flattened into turns[]
in haystack_session_ids order. Per Phase 12 Decision 8, this flatten
shape preserves ST-single-session parity — the retrieval ladder sees
LongMemEval the same way SillyTavern presents chat history.

QA items gain taskType (from question_type) and abstention (from _abs
suffix detection) fields. Evidence is populated from per-turn
has_answer markers with session-level fallback.

Network fetch on first call caches to bench/.cache/longmemeval_s_cleaned.json;
subsequent calls read from cache. Tests use a 3-item fixture (one
single-session, one multi-session, one abstention) — no network calls
in the unit suite."
```

**Done-when:**
- [ ] `bench/corpora/longmemeval.js` created with `loadLongMemEvalS`, `normalizeItem`, `longmemevalSAdapter`
- [ ] Barrel uncommented; `getAdapter('longmemeval-s')` works
- [ ] Fixture committed with 3 representative items (covers single-session, multi-session, abstention cases)
- [ ] 10 new test assertions green (+1 suite)
- [ ] `bench/.cache/longmemeval_s_cleaned.json` produced on first non-offline load (not committed — gitignored)
- [ ] Commit landed

**Subagent delegation context (include verbatim when dispatching):**

> You are implementing STARmem Phase 12 Task 3. The plan is at `docs/plans/phase-12-multi-corpus.md` — read the `## Task 3` section in full before starting. Task 2 (CorpusAdapter interface + LoCoMo port) must have landed first — verify `bench/corpora/adapter.js` and `bench/corpora/locomo.js` exist and the adapter tests pass before you start. Key invariants: (1) Flatten all sessions into one `turns[]` with monotonic `turnIndex` in `haystack_session_ids` order. (2) `taskType` propagates from `question_type` directly; don't rename. (3) `abstention` is true iff `question_id.endsWith('_abs')`. (4) Prefer per-turn `has_answer` evidence; fall back to whole-session marking only when a session is in `answer_session_ids` but has no `has_answer` turns. (5) Do NOT make network calls from tests — fixture only. (6) If `tests/fixtures/bench/longmemeval-s-fixture.json` is missing, stop and ask — Eva will source it manually. (7) If you see `const FOO = ***` in the plan that's a tooling redaction, not real code — stop and report.

---

## Task 4: Task-type propagation through metrics + per-task-type renderer

**Objective:** Extend `computeMetrics` to emit `byTaskType: Record<taskType, {mrr, coverage, n_scored, n_skipped}>` alongside aggregated metrics when any `runs[i].qa` carries `taskType`. Exclude abstention runs from scoring per Decision 10; report `abstentionCount` separately. Ship a standalone per-task-type renderer (`bench/render/by-task-type.js`) that formats the slice for baseline and sweep reports.

**Owner:** Subagent (Fireworks / Kimi K2.6). ~150 LOC; touches one file plus one new renderer plus two test files. **Smaller than original estimate** — preflight confirmed the runner already threads the full `qa` object through `runs[]` (see below), so no seeder or runner changes are needed.

**Files:**
- Modify: `bench/metrics/retrieval.js` — `computeMetrics` reads `run.qa?.taskType` / `run.qa?.abstention` and emits `byTaskType` + `abstentionCount` when applicable
- Create: `bench/render/by-task-type.js` — Table renderer for `byTaskType` slice
- Modify: `tests/unit/bench/metrics/retrieval.test.js` — Add `byTaskType` emission test
- Create: `tests/unit/bench/render/by-task-type.test.js` — Renderer shape tests

**Not needed (confirmed by 2026-04-23 preflight, recorded here to prevent well-meaning subagent scope creep):**
- ~~`bench/runner.js`~~ — `runHarness` already pushes `{ conversationId, qa, retrieved, goldTurns, ... }` into `runs[]`, so the full `qa` object (including `taskType`/`abstention` when corpus provides them) is already accessible to `computeMetrics`. Do not modify.
- ~~`bench/harness/seeder.js`~~ — Seeder returns `{ chatId, stateHash, factCount, turnsProcessed, consolidationStats }`; the QA items are carried forward directly by `runHarness` via `conv.qa`, not through seeder. Do not modify.

**Preflight (controller, done 2026-04-23, preserved here for subagent verification):**

```
mcp_jcodemunch_get_symbol_source(
    repo="local/SillyTavern-STARmem-036d3fcc",
    symbol_ids=[
        "bench/metrics/retrieval.js::computeMetrics#function",
        "bench/runner.js::runHarness#function",
    ]
)
```

Confirmed shapes at HEAD (7dae9a2):

```javascript
// bench/runner.js runs[] push (line ~105, verbatim):
runs.push({
    conversationId: conv.id,
    qa,                       // ← full QA object threaded
    retrieved: result.entries.map(e => ({ id, content, sourceMessages, score, tier })),
    goldTurns,
    traces: [result.trace],
    latencyMs,
    consolidationStats,
    retrieverId: retriever?.name ?? 'ladder',
});

// bench/metrics/retrieval.js computeMetrics (line 233, verbatim):
for (const run of runs) {
    const evidenceTurns = run.qa?.evidenceTurns ?? [];
    const { matchedIds } = matchGoldByEvidence(run.retrieved, evidenceTurns);
    // ... rest of aggregation ...
}
```

Task 4's entire change surface: (a) route scoring loop through a scorable-runs filter that excludes `run.qa?.abstention === true`; (b) after aggregation, bucket scorable runs by `run.qa?.taskType` and recurse for per-type slices; (c) emit `byTaskType` + `abstentionCount`.

**Step 1: Extend `computeMetrics` to slice by `taskType`**

In `bench/metrics/retrieval.js`, extend the `computeMetrics(runs, opts)` signature. The current function returns:

```javascript
// Current (Phase 11):
{
    recallAt1, recallAt5, recallAt10,
    precisionAt1, precisionAt5, precisionAt10,
    mrr,
    coverage,         // = n_scored / n_total, Phase 11
    n_scored,         // Phase 9
    n_skipped,        // Phase 9
    p50LatencyMs,     // if perQueryMs provided
    p95LatencyMs,
}
```

Add, when any run has `taskType` defined:

```javascript
// Phase 12 addition:
byTaskType: {
    'single-session-user':        { mrr, coverage, n_scored, n_skipped },
    'single-session-assistant':   { mrr, coverage, n_scored, n_skipped },
    'single-session-preference':  { mrr, coverage, n_scored, n_skipped },
    'temporal-reasoning':         { mrr, coverage, n_scored, n_skipped },
    'knowledge-update':           { mrr, coverage, n_scored, n_skipped },
    'multi-session':              { mrr, coverage, n_scored, n_skipped },
}
```

Implementation pattern (pseudo; real code reads `run.qa?.taskType` and `run.qa?.abstention` since the runner pushes the full `qa` object into each run):

```javascript
export function computeMetrics(runs, opts = {}) {
    // ... existing aggregated computation ...

    // Phase 12: exclude abstention from scoring per Decision 10
    const scorableRuns = runs.filter(r => r.qa?.abstention !== true);

    // Existing aggregated metrics computed over scorableRuns
    // (behavior change: if any abstention runs present, they're excluded
    // from headline numbers too — matches "ignored for scoring" decision)

    // Phase 12: per-task-type slice (only when at least one run has taskType)
    const hasTaskType = scorableRuns.some(r => typeof r.qa?.taskType === 'string');
    let byTaskType;
    if (hasTaskType && !opts._suppressByTaskType) {
        byTaskType = {};
        const byType = new Map();
        for (const run of scorableRuns) {
            const tt = run.qa?.taskType || '__untyped__';
            if (!byType.has(tt)) byType.set(tt, []);
            byType.get(tt).push(run);
        }
        for (const [tt, bucket] of byType) {
            if (tt === '__untyped__') continue;
            // Recursively compute metrics on the bucket using the same function
            // (_suppressByTaskType prevents infinite recursion).
            const sliceMetrics = computeMetrics(bucket, { ...opts, _suppressByTaskType: true });
            byTaskType[tt] = {
                mrr: sliceMetrics.mrr,
                coverage: sliceMetrics.coverage,
                n_scored: sliceMetrics.n_scored,
                n_skipped: sliceMetrics.n_skipped,
            };
        }
    }

    return {
        ...aggregated,
        ...(byTaskType ? { byTaskType } : {}),
        // Abstention count (reported, not scored) — only emit when any abstention run exists
        ...(runs.some(r => r.qa?.abstention === true)
            ? { abstentionCount: runs.filter(r => r.qa?.abstention === true).length }
            : {}),
    };
}
```

**Edge cases to handle:**

1. **Empty per-type bucket** — a task type with zero scorable runs (all abstentions): skip entry entirely, don't emit zeros.
2. **Mixed corpora in one runs[] array** — theoretically `runs[]` could mix LoCoMo + LongMemEval runs. Don't handle this; assume one corpus per `computeMetrics` call. Add assertion: if `byTaskType` fires, no run should be missing `taskType` (mixed-corpus flagged as bug).
3. **`_suppressByTaskType` flag** — internal, undocumented, prevents infinite recursion. Callers should never set it.

**Step 2: Confirm the runner change is NOT needed (no-op — preflight already verified)**

Historical plan drafts of Task 4 included a runner edit to push `taskType`/`abstention` fields. Preflight (2026-04-23) showed `runHarness` already pushes `qa` directly into each run record, so `computeMetrics` can read `run.qa?.taskType` / `run.qa?.abstention` with no runner change. Skip any runner.js edits.

**Step 3: Confirm the seeder change is NOT needed (no-op — preflight already verified)**

Seeder's return shape `{ chatId, stateHash, factCount, turnsProcessed, consolidationStats }` is unchanged from Phase 11. QA items travel through `runHarness` via `conv.qa`, independent of seeder. Skip any seeder.js edits.

**Step 4: Write `bench/render/by-task-type.js`**

```javascript
/**
 * Per-task-type metrics table renderer. Consumed by both JS baseline
 * scripts and the live-extraction baseline synthesizer in Task 6.
 *
 * @module bench/render/by-task-type
 */

/**
 * @param {Record<string, { mrr: number, coverage: number, n_scored: number, n_skipped?: number }>} byTaskType
 * @param {object} [opts]
 * @param {string} [opts.headline] Optional headline line prepended above the table
 * @returns {string} Markdown table string ready for concatenation into a report
 */
export function renderByTaskType(byTaskType, opts = {}) {
    if (!byTaskType || Object.keys(byTaskType).length === 0) {
        return '_No per-task-type slice available (corpus did not provide taskType)._\n';
    }

    const lines = [];
    if (opts.headline) {
        lines.push(opts.headline);
        lines.push('');
    }
    lines.push('| Task type                    | MRR      | Coverage | n scored | n skipped |');
    lines.push('|------------------------------|----------|----------|----------|-----------|');

    // Stable ordering: known LongMemEval types first, then any unknown
    const KNOWN_ORDER = [
        'single-session-user',
        'single-session-assistant',
        'single-session-preference',
        'temporal-reasoning',
        'knowledge-update',
        'multi-session',
    ];
    const ordered = [
        ...KNOWN_ORDER.filter(k => k in byTaskType),
        ...Object.keys(byTaskType).filter(k => !KNOWN_ORDER.includes(k)).sort(),
    ];

    for (const tt of ordered) {
        const m = byTaskType[tt];
        const mrrStr = m.mrr.toFixed(4);
        const covStr = m.coverage.toFixed(4);
        const skipped = m.n_skipped !== undefined ? String(m.n_skipped) : '—';
        lines.push(`| ${tt.padEnd(28)} | ${mrrStr.padStart(8)} | ${covStr.padStart(8)} | ${String(m.n_scored).padStart(8)} | ${skipped.padStart(9)} |`);
    }

    return lines.join('\n') + '\n';
}
```

**Step 5: Tests**

Extend `tests/unit/bench/metrics/retrieval.test.js` with a byTaskType test (append to the existing `describe('computeMetrics')` block):

```javascript
test('emits byTaskType when any run has taskType', () => {
    const runs = [
        // 3 single-session-user runs (2 perfect, 1 miss)
        { conversationId: 'x', qa: { question: 'q1', answer: 'a1', evidenceTurns: [0], category: 'x', taskType: 'single-session-user' },
          retrieved: [{ id: 'e0', content: '', sourceMessages: [0], score: 0, tier: 3 }] },
        { conversationId: 'x', qa: { question: 'q2', answer: 'a2', evidenceTurns: [1], category: 'x', taskType: 'single-session-user' },
          retrieved: [{ id: 'e1', content: '', sourceMessages: [1], score: 0, tier: 3 }] },
        { conversationId: 'x', qa: { question: 'q3', answer: 'a3', evidenceTurns: [2], category: 'x', taskType: 'single-session-user' },
          retrieved: [{ id: 'e9', content: '', sourceMessages: [99], score: 0, tier: 3 }] },
        // 2 multi-session runs (both hit)
        { conversationId: 'x', qa: { question: 'q4', answer: 'a4', evidenceTurns: [3], category: 'x', taskType: 'multi-session' },
          retrieved: [{ id: 'e3', content: '', sourceMessages: [3], score: 0, tier: 3 }] },
        { conversationId: 'x', qa: { question: 'q5', answer: 'a5', evidenceTurns: [4], category: 'x', taskType: 'multi-session' },
          retrieved: [{ id: 'e4', content: '', sourceMessages: [4], score: 0, tier: 3 }] },
    ];
    const metrics = computeMetrics(runs);
    expect(metrics.byTaskType).toBeDefined();
    expect(metrics.byTaskType['single-session-user']).toBeDefined();
    expect(metrics.byTaskType['single-session-user'].n_scored).toBe(2);   // only 2 of 3 have matching sourceMessages → gold
    expect(metrics.byTaskType['single-session-user'].n_skipped).toBe(1);
    expect(metrics.byTaskType['multi-session']).toBeDefined();
    expect(metrics.byTaskType['multi-session'].n_scored).toBe(2);
    expect(metrics.byTaskType['multi-session'].mrr).toBeCloseTo(1.0, 4);
});

test('does not emit byTaskType when no runs have taskType (LoCoMo-shaped)', () => {
    const runs = [
        { conversationId: 'x', qa: { question: 'q1', answer: 'a1', evidenceTurns: [0], category: 'x' },
          retrieved: [{ id: 'e0', content: '', sourceMessages: [0], score: 0, tier: 3 }] },
    ];
    const metrics = computeMetrics(runs);
    expect(metrics.byTaskType).toBeUndefined();
});

test('excludes abstention runs from scoring, reports count separately', () => {
    const runs = [
        { conversationId: 'x', qa: { question: 'q1', answer: 'a1', evidenceTurns: [0], category: 'x', taskType: 'single-session-user' },
          retrieved: [{ id: 'e0', content: '', sourceMessages: [0], score: 0, tier: 3 }] },
        { conversationId: 'x', qa: { question: 'q2_abs', answer: '', evidenceTurns: [], category: 'x', taskType: 'single-session-user', abstention: true },
          retrieved: [{ id: 'e9', content: '', sourceMessages: [99], score: 0, tier: 3 }] },
    ];
    const metrics = computeMetrics(runs);
    expect(metrics.abstentionCount).toBe(1);
    expect(metrics.byTaskType['single-session-user'].n_scored).toBe(1);
});
```

**Shape note:** fixtures above mirror the real `runHarness` push shape (line ~105 in `bench/runner.js`): `run.qa` is the full QA object (NOT flat fields on the run), and `run.retrieved[i].sourceMessages` is flat (NOT nested under `provenance`). `matchGoldByEvidence` (line 138 of `bench/metrics/retrieval.js`) reads `entry.sourceMessages` directly. Earlier plan drafts used `{ provenance: { sourceMessages } }` incorrectly.

Create `tests/unit/bench/render/by-task-type.test.js`:

```javascript
import { renderByTaskType } from '../../../../bench/render/by-task-type.js';

describe('renderByTaskType', () => {
    test('renders empty byTaskType as informational message', () => {
        expect(renderByTaskType({})).toContain('No per-task-type slice');
        expect(renderByTaskType(null)).toContain('No per-task-type slice');
    });

    test('renders full LongMemEval 6-type table in canonical order', () => {
        const input = {
            'multi-session':              { mrr: 0.5, coverage: 0.6, n_scored: 50, n_skipped: 10 },
            'single-session-user':        { mrr: 0.9, coverage: 0.95, n_scored: 100, n_skipped: 5 },
            'single-session-assistant':   { mrr: 0.85, coverage: 0.9, n_scored: 80, n_skipped: 5 },
            'single-session-preference':  { mrr: 0.88, coverage: 0.92, n_scored: 60, n_skipped: 4 },
            'temporal-reasoning':         { mrr: 0.4, coverage: 0.5, n_scored: 40, n_skipped: 20 },
            'knowledge-update':           { mrr: 0.6, coverage: 0.7, n_scored: 30, n_skipped: 10 },
        };
        const out = renderByTaskType(input);
        const lines = out.trim().split('\n');
        // Header (2 lines) + 6 data rows
        expect(lines.length).toBe(8);
        // Canonical order: single-session-user first, multi-session last
        expect(lines[2]).toMatch(/single-session-user/);
        expect(lines[7]).toMatch(/multi-session/);
    });

    test('includes headline when provided', () => {
        const out = renderByTaskType({ 'x': { mrr: 1, coverage: 1, n_scored: 1 } }, { headline: '## My headline' });
        expect(out).toMatch(/## My headline/);
    });

    test('puts unknown task types after known ones, sorted alphabetically', () => {
        const input = {
            'custom-b': { mrr: 0.5, coverage: 0.5, n_scored: 1 },
            'single-session-user': { mrr: 0.5, coverage: 0.5, n_scored: 1 },
            'custom-a': { mrr: 0.5, coverage: 0.5, n_scored: 1 },
        };
        const out = renderByTaskType(input);
        const lines = out.trim().split('\n').slice(2);
        expect(lines[0]).toMatch(/single-session-user/);
        expect(lines[1]).toMatch(/custom-a/);
        expect(lines[2]).toMatch(/custom-b/);
    });
});
```

Run: `npx jest tests/unit/bench/metrics/retrieval.test.js tests/unit/bench/render/by-task-type.test.js -v`
Expected: +3 assertions in retrieval.test.js + 4 assertions in by-task-type.test.js.

**Step 6: Full suite regression**

```bash
npm test 2>&1 | tail -8
```

Expected: 81 suites / 852 tests (+1 suite from by-task-type, +7 total assertions — 3 in retrieval.test.js, 4 in by-task-type.test.js). All green.

**Step 7: Commit**

```bash
git add bench/metrics/retrieval.js bench/render/by-task-type.js tests/unit/bench/metrics/retrieval.test.js tests/unit/bench/render/by-task-type.test.js
git commit -m "feat(bench): task-type propagation through metrics (Phase 12 Task 4)

computeMetrics reads run.qa?.taskType and emits byTaskType slice when
any run carries it (LongMemEval). Aggregated headline metrics exclude
abstention runs per Phase 12 Decision 10; abstentionCount emitted
separately when ≥1 abstention present. LoCoMo-shaped runs (no taskType,
no abstention) produce the Phase 11 metrics schema unchanged — neither
byTaskType nor abstentionCount is present.

Runner + seeder unchanged: runHarness already threads the full qa
object through runs[], so computeMetrics has direct access to
run.qa.taskType and run.qa.abstention without any upstream edits.

bench/render/by-task-type.js formats the slice as a canonical-order
Markdown table (LongMemEval 6 types first, unknowns alphabetical).
Consumed by Task 5's Python mirror and Task 6's baseline synthesis."
```

**Done-when:**
- [ ] `computeMetrics` emits `byTaskType` when any `run.qa?.taskType` present + excludes abstention runs + reports `abstentionCount` only when ≥1 abstention exists
- [ ] Runner unchanged (preflight-confirmed: `qa` is already threaded into `runs[]`)
- [ ] Seeder unchanged (preflight-confirmed: QA travels via `conv.qa` through `runHarness`, not through seeder)
- [ ] `bench/render/by-task-type.js` new, tests green
- [ ] +7 test assertions total across 2 suites; 845 → 852, 81 suites
- [ ] Commit landed

**Subagent delegation context (include verbatim when dispatching):**

> You are implementing STARmem Phase 12 Task 4. The plan is at `docs/plans/phase-12-multi-corpus.md` — read `## Task 4` in full. Tasks 2 + 3 must have landed first. Key invariants: (1) DO NOT modify `bench/runner.js` or `bench/harness/seeder.js`. Preflight confirmed the runner already pushes the full `qa` object into `runs[]`, so `computeMetrics` reads `run.qa?.taskType` and `run.qa?.abstention` directly. If tests or intuition suggest a runner edit is needed, STOP and ask — the plan intentionally omits it. (2) LoCoMo-shaped runs (no `qa.taskType`) MUST produce exactly the Phase 11 metrics output unchanged — no `byTaskType`, no `abstentionCount`. Verify by running the existing LoCoMo runner smoke. (3) Do NOT mutate `runs[]` records. (4) Use the `_suppressByTaskType` recursion flag; DON'T duplicate aggregation logic. (5) Preserve deterministic ordering in renderer (LongMemEval 6 types first, unknowns sorted). (6) If you see `const FOO = ***` in the plan that's a tooling redaction, not real code — stop and report. (7) Commit exactly as Step 7.

---

## Task 5: Modal `--corpus` parameterization + Python renderer mirror

**Objective:** Extend `bench/modal/sweep_app.py` to accept a `--corpus {locomo,longmemeval-s}` parameter across `run-point`, `run-baselines`, and `run-sweep` modes. Each Modal `@app.function` reads the corpus name, passes it through to the Node entrypoint it dispatches (via env var + CLI flag), and each entrypoint resolves to the appropriate corpus adapter via `getAdapter(corpusName)`. Python-side renderer mirror (`render_by_task_type`) formats the `byTaskType` slice in Modal reports to match the JS renderer.

**Owner:** Subagent (Fireworks / Kimi K2.6). ~300 LOC across one Python file + three Node entrypoints + 5 new pytest assertions.

**Files:**
- Modify: `bench/modal/sweep_app.py` — Add `--corpus` parameter to CLI; thread through `run_point.remote(corpus=...)`, `run_baseline_point.remote/map(corpus=...)`, `run_sweep.remote(corpus=...)`. Add `render_by_task_type(byTaskType)` Python function mirroring `bench/render/by-task-type.js`. Include byTaskType slice in per-knob sweep reports when corpus is LongMemEval.
- Modify: `bench/sweeps/_modal-point.js` — Read `STARMEM_BENCH_CORPUS` env var (and optional `--corpus` flag); replace hardcoded `loadLocomo` with `getAdapter(corpusName).loadConversations(...)`.
- Modify: `bench/baselines/_modal-point.js` — Same env-var + adapter-lookup change as the sweeps entrypoint.
- Modify: `bench/sweeps/_modal-batchsize-point.js` — Same env-var + adapter-lookup change (used by `run_batchsize_point` under `run-sweep --sweep-name batchsize`).
- Modify: `bench/cli.js` — Accept `--corpus` values beyond `locomo`; resolve via `getAdapter(name)`; preserve `--conversations` as LoCoMo-legacy alias for `maxConversations`, add `--max-items` for LongMemEval.
- Create: `bench/modal/tests/test_corpus_param.py` — 5 pytest assertions covering the `--corpus` parameter wiring.
- Leave untouched: `bench/runner.js` — `runHarness({ corpus, ... })` already accepts a pre-loaded corpus array; corpus selection happens in the *entrypoints*, not in `runHarness`. Do not add CLI parsing to `runner.js`.

**Preflight (controller, done 2026-04-23):**

Confirmed at HEAD (7dae9a2):

- `run_point` (line 55) is `@app.function`-decorated; shells to `["node", "bench/sweeps/_modal-point.js"]` at line 97.
- `run_baseline_point` (line 141) is `@app.function`-decorated; shells to `["node", "bench/baselines/_modal-point.js"]` at line 166.
- `run_batchsize_point` (line 192) is `@app.function`-decorated; shells to `["node", "bench/sweeps/_modal-batchsize-point.js"]` at line 220.
- `run_baselines` (line 252) is `@app.function`-decorated top-level orchestrator; calls `run_baseline_point.map(BASELINE_IDS)` at line 265.
- `run_sweep` (line 1708) is `@app.function`-decorated top-level orchestrator; calls `run_point.map(overrides_jsons)` at line 1799.
- `run_graph_sweep` (line 1169 vicinity), `run_consolidation_sweep` (line 1613), `run_consolidation_batchsize_sweep` — these are *sub-orchestrators* called from `run_sweep` and are undecorated (per Phase 11 Task 6 hot-fix; decorating them would nest Modal contexts and blow the 1800s timeout).

**So the Phase 11 "orchestrators undecorated" rule applies only to sub-orchestrators, NOT to top-level `@app.local_entrypoint()`-dispatched functions.** The audit grep in this task's Step 7 targets sub-orchestrators.

**Step 1: Add `--corpus` CLI arg to the local entrypoint**

Current `main()` signature (from preflight) uses `mode`, `sweep_name`, `synthetic`, `overrides_json`, `local_out`. Extend:

```python
@app.local_entrypoint()
def main(
    mode: str = "hello",
    sweep_name: str = "tau",
    synthetic: bool = False,
    overrides_json: str = "{}",
    local_out: str = "",
    corpus: str = "locomo",   # Phase 12 addition
) -> None:
    """
    ... existing docstring ...

    --corpus CORPUS:
        Benchmark corpus to run against. One of:
          - locomo           (default; LoCoMo-10, 1986 QA items)
          - longmemeval-s    (LongMemEval-S, 500 items, ~115K tok haystacks)
        Passed through to the Node runner via STARMEM_BENCH_CORPUS env var.
    """
    # Validate early
    if corpus not in {"locomo", "longmemeval-s"}:
        raise ValueError(f"--corpus must be one of: locomo, longmemeval-s. Got: {corpus!r}")

    if mode == "hello":
        # ... existing hello path ...
    elif mode == "run-point":
        point_out = run_point.remote(overrides_json, corpus=corpus)  # Threading added
        # ... existing local_out mirror logic ...
    elif mode == "run-baselines":
        baselines_out = run_baselines.remote(corpus=corpus)  # Threading added
        # ... existing baseline output logic ...
    elif mode == "run-sweep":
        sweep_out = run_sweep.remote(sweep_name, synthetic, corpus=corpus)  # Threading added
        # ... existing sweep output logic ...
```

**Step 2: Thread `corpus` through the remote functions**

For each `@app.function`-decorated per-cell/per-point function, add `corpus: str = "locomo"` parameter. Pass it into the subprocess environment when invoking the Node entrypoint:

```python
@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1500,
    memory=4096,
)
def run_point(overrides_json: str, corpus: str = "locomo") -> str:
    """Runs one sweep point with the specified corpus. corpus is threaded
    to the Node entrypoint via STARMEM_BENCH_CORPUS env var.
    """
    import subprocess
    import os

    # ... existing symlink setup, env construction ...
    env = {
        **os.environ,
        "STARMEM_BENCH_CORPUS": corpus,
        # ... existing env vars ...
    }

    result = subprocess.run(
        ["node", "bench/sweeps/_modal-point.js"],  # unchanged entrypoint
        env=env,
        cwd="/repo",
        capture_output=True,
        text=True,
        timeout=1400,
    )
    # ... existing output parsing ...
```

Apply the same threading to `run_baseline_point(retriever_id, corpus="locomo")` (subprocess target: `bench/baselines/_modal-point.js`) and `run_batchsize_point(conv_idx, batch_size, corpus="locomo")` (subprocess target: `bench/sweeps/_modal-batchsize-point.js`). Each `@app.function` reads `corpus`; each Node entrypoint reads `STARMEM_BENCH_CORPUS` and resolves the adapter.

**Top-level orchestrators (`run_sweep`, `run_baselines`) are also `@app.function`-decorated** (they are the top-level `modal run` targets — undecorating would break the entrypoint wiring). The Phase 11 "undecorated orchestrators" rule applies specifically to the *sub-orchestrators* `run_sweep` calls into (`run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep`), not to `run_sweep`/`run_baselines` themselves.

```python
# @app.function IS on run_sweep — it's the top-level dispatcher for --mode run-sweep.
@app.function(image=image, volumes={"/data": volume}, secrets=[env_secret], timeout=1800, memory=4096)
def run_sweep(sweep_name: str, synthetic: bool = False, corpus: str = "locomo") -> dict:
    # ... existing sweep config lookup ...
    # Threading: pass corpus to every run_point in the grid via .map(kwargs=...)
    overrides_jsons = [json.dumps(point) for point in grid]
    # run_point.map only accepts positional tuples; wrap with a list of (overrides, corpus) pairs
    point_results = list(run_point.map(
        [(oj, corpus) for oj in overrides_jsons],
    ))
    # ... rest unchanged except for report header which now includes corpus ...
```

Note the `run_point.map` call shape — Modal's `.map()` accepts an iterable of argument tuples when the function takes multiple positional args. Alternative: use `.starmap()` if reading cleaner. For `run_baselines`, threading is analogous: `run_baseline_point.map([(rid, corpus) for rid in BASELINE_IDS])`.

**Sub-orchestrator note (Phase 11 Task 6 regression vector):** `run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep` are called *from within* `run_sweep`'s already-opened Modal context; they MUST remain undecorated. Adding `@app.function` to any of them nests Modal contexts and triggers the 1800s-timeout hot-fix from Phase 11 Task 6. After adding `--corpus` threading, re-run the Step 7 decorator grep to verify the sub-orchestrators stayed undecorated.

**Step 3: Teach each Modal Node entrypoint to route through the adapter registry**

`bench/runner.js` (`runHarness({ corpus, ... })`) already accepts a pre-loaded corpus array — no change needed there. Corpus selection lives in the *entrypoints* that `run_point` / `run_baseline_point` / `run_batchsize_point` subprocess-launch. At HEAD, all three hardcode `loadLocomo`; Task 5 replaces the hardcode with adapter-registry lookup.

**Pattern applied to `bench/sweeps/_modal-point.js`:**

```javascript
// Replace:
// import { loadLocomo } from '../loaders/index.js';
// const corpus = await loadLocomo({ offline: true });
//
// With:
import { getAdapter } from '../corpora/index.js';

const corpusName = process.env.STARMEM_BENCH_CORPUS ?? 'locomo';
const adapter = getAdapter(corpusName);
const corpus = await adapter.loadConversations({ offline: true });

// Pass corpus to runHarness unchanged:
const result = await runHarness({ corpus, overrides: ... });
```

Apply the identical pattern to:
- `bench/baselines/_modal-point.js` (consumed by `run_baseline_point`)
- `bench/sweeps/_modal-batchsize-point.js` (consumed by `run_batchsize_point`)

The pattern is three-line: (1) swap import, (2) read env var, (3) resolve adapter. Each entrypoint preserves its current `offline: true` flag (Modal Volume is the source of truth for corpus JSON; network fetch disabled by design on Modal).

**Step 3b: Extend `bench/cli.js` for local dispatch**

`bench/cli.js` (local CLI entrypoint, used outside Modal) currently hardcodes `if (corpusName !== 'locomo') exit(1)` at line ~84. Replace:

```javascript
// Replace the hardcoded-locomo branch:
if (corpusName !== 'locomo') {
    console.error(`Unknown corpus: ${corpusName}`);
    process.exit(1);
}
const corpus = await loadLocomo({ maxConversations, offline });

// With adapter-registry lookup:
import { getAdapter } from './corpora/index.js';  // new import at top

const adapter = getAdapter(corpusName);  // throws with known-list on typos
const corpus = await adapter.loadConversations({
    maxConversations,                                               // LoCoMo legacy
    maxItems: args['max-items'] ? Number(args['max-items']) : undefined,  // LongMemEval
    offline,
});
```

This preserves the existing `--corpus locomo --conversations 10` invocation (LoCoMo passes `maxConversations`, LongMemEval ignores it) and adds `--corpus longmemeval-s --max-items 10` for the new corpus.

**Step 4: Python renderer mirror**

In `sweep_app.py`, add:

```python
def render_by_task_type(by_task_type: dict, headline: str = "") -> str:
    """Mirror of bench/render/by-task-type.js. Kept in sync manually —
    there's no shared source of truth across JS/Python (same pattern as
    _should_amend mirror).
    """
    if not by_task_type:
        return "_No per-task-type slice available (corpus did not provide taskType)._\n"

    KNOWN_ORDER = [
        "single-session-user",
        "single-session-assistant",
        "single-session-preference",
        "temporal-reasoning",
        "knowledge-update",
        "multi-session",
    ]
    ordered = [k for k in KNOWN_ORDER if k in by_task_type] + sorted(
        k for k in by_task_type if k not in KNOWN_ORDER
    )

    lines = []
    if headline:
        lines.append(headline)
        lines.append("")
    lines.append("| Task type                    | MRR      | Coverage | n scored | n skipped |")
    lines.append("|------------------------------|----------|----------|----------|-----------|")
    for tt in ordered:
        m = by_task_type[tt]
        mrr = f"{m['mrr']:.4f}"
        cov = f"{m['coverage']:.4f}"
        n_scored = str(m.get("n_scored", "?"))
        n_skipped = str(m.get("n_skipped", "—"))
        lines.append(
            f"| {tt.ljust(28)} | {mrr.rjust(8)} | {cov.rjust(8)} | {n_scored.rjust(8)} | {n_skipped.rjust(9)} |"
        )
    return "\n".join(lines) + "\n"
```

**Step 5: Include byTaskType slice in sweep reports**

In `run_point`, `run_sweep`, and `run_baselines` report generation, append the task-type table when present:

```python
# Inside report-building (per-point or aggregated):
metrics = point_result["metrics"]
report_lines = [
    # ... existing headline metrics ...
]
if "byTaskType" in metrics and metrics["byTaskType"]:
    report_lines.append("")
    report_lines.append(render_by_task_type(metrics["byTaskType"], headline="### Per-task-type slice"))
if metrics.get("abstentionCount", 0) > 0:
    report_lines.append(f"\n**Abstention QAs excluded from scoring:** {metrics['abstentionCount']}")
```

Apply the same pattern to the baselines report (per-retriever) and each sweep renderer (tau, bm25, graph, consolidation, etc.) — but only inject the slice when corpus is LongMemEval (detect via presence of `byTaskType` key).

**Step 6: Pytest coverage**

Create `bench/modal/tests/test_corpus_param.py`:

```python
"""Phase 12 Task 5: --corpus parameter wiring tests.

These tests don't dispatch to real Modal — they import sweep_app and
verify the main() entrypoint's validation and arg threading.
"""
import pytest
from unittest.mock import patch, MagicMock


def test_main_rejects_unknown_corpus(monkeypatch):
    """--corpus foo must raise, not silently default to locomo."""
    from bench.modal import sweep_app
    with pytest.raises(ValueError, match="must be one of"):
        sweep_app.main(mode="run-point", corpus="foo")


def test_main_accepts_locomo_and_longmemeval_s():
    """Both canonical corpus names must pass validation."""
    from bench.modal import sweep_app
    # Use monkeypatch or a mock to prevent actual Modal dispatch
    with patch.object(sweep_app, "run_point") as mock_rp:
        mock_rp.remote.return_value = {"report": "", "result_json": "{}", "run_dir": "/tmp"}
        sweep_app.main(mode="run-point", corpus="locomo")
        sweep_app.main(mode="run-point", corpus="longmemeval-s")
        # Both calls threaded corpus into run_point.remote
        assert mock_rp.remote.call_count == 2
        assert mock_rp.remote.call_args_list[0].kwargs.get("corpus") == "locomo"
        assert mock_rp.remote.call_args_list[1].kwargs.get("corpus") == "longmemeval-s"


def test_render_by_task_type_empty_returns_placeholder():
    """Empty byTaskType dict shows informational message."""
    from bench.modal.sweep_app import render_by_task_type
    out = render_by_task_type({})
    assert "No per-task-type slice available" in out


def test_render_by_task_type_canonical_order():
    """LongMemEval 6 types in canonical order, single-session-user first."""
    from bench.modal.sweep_app import render_by_task_type
    data = {
        "multi-session":             {"mrr": 0.5, "coverage": 0.6, "n_scored": 50, "n_skipped": 10},
        "single-session-user":       {"mrr": 0.9, "coverage": 0.95, "n_scored": 100, "n_skipped": 5},
    }
    out = render_by_task_type(data)
    lines = out.strip().split("\n")
    # Header (2 lines) + 2 data rows
    assert len(lines) == 4
    assert "single-session-user" in lines[2]
    assert "multi-session" in lines[3]


def test_run_baselines_threads_corpus(monkeypatch):
    """run-baselines mode passes corpus through to run_baselines.remote()."""
    from bench.modal import sweep_app
    with patch.object(sweep_app, "run_baselines") as mock_rb:
        mock_rb.remote.return_value = {"report": "", "result_json": "{}", "run_dir": "/tmp"}
        sweep_app.main(mode="run-baselines", corpus="longmemeval-s")
        assert mock_rb.remote.call_args.kwargs.get("corpus") == "longmemeval-s"
```

Note: these tests need `modal` module stubbed (per Phase 11 Task 1 pattern — `bench/modal/__init__.py` shadows real modal). If conftest.py already stubs it, reuse. If not, add at the top of `test_corpus_param.py`:

```python
# Stub the modal package at module scope if bench.modal.__init__ shadow
# issue triggers ImportError. Matches Phase 11 Task 1 pattern.
import sys
from types import ModuleType
if "modal" not in sys.modules:
    modal_stub = ModuleType("modal")
    modal_stub.App = lambda name: MagicMock(name=f"App({name})")
    modal_stub.Image = MagicMock(name="Image")
    modal_stub.Secret = MagicMock(name="Secret")
    modal_stub.Volume = MagicMock(name="Volume")
    sys.modules["modal"] = modal_stub
```

Run: `cd bench/modal && python -m pytest tests/test_corpus_param.py -v`
Expected: 5 assertions pass.

**Step 7: Full suite regression + invariant re-check**

```bash
npm test 2>&1 | tail -8
# Expected: 81 suites / 852 tests — Task 4's gain unchanged; Task 5 added Python tests only
cd bench/modal && python -m pytest -q 2>&1 | tail -5
cd ../..
# Expected: 13 tests (+5 from Task 5: test_corpus_param.py 5 assertions)

# Sub-orchestrator decorator invariant check (Phase 11 Task 6 regression vector):
grep -B1 "^def run_graph_sweep\b\|^def run_consolidation_sweep\b\|^def run_consolidation_batchsize_sweep\b" bench/modal/sweep_app.py | grep -c "@app.function"
# Expected: 0 (these three sub-orchestrators MUST stay undecorated — they run inside run_sweep's Modal context).

# Top-level orchestrator + per-cell decorator count (should be unchanged by Task 5):
grep -B1 "^def run_point\b\|^def run_baseline_point\b\|^def run_batchsize_point\b\|^def run_sweep\b\|^def run_baselines\b" bench/modal/sweep_app.py | grep -c "@app.function"
# Expected: 5 (all 5 are @app.function-decorated top-level entries)
```

**Step 8: Commit**

```bash
git add bench/modal/sweep_app.py bench/sweeps/_modal-point.js bench/baselines/_modal-point.js bench/sweeps/_modal-batchsize-point.js bench/cli.js bench/modal/tests/test_corpus_param.py
git commit -m "feat(bench): Modal --corpus parameter across run-point/baselines/sweep (Phase 12 Task 5)

Modal sweep_app.py accepts --corpus {locomo, longmemeval-s} on all three
dispatch modes. Corpus threads through run_point.remote, run_baseline_point.map,
run_batchsize_point.map, and run_sweep.remote/run_baselines.remote as a
keyword arg, then into each Node entrypoint subprocess via
STARMEM_BENCH_CORPUS env var.

Three Modal Node entrypoints switch from hardcoded loadLocomo to
getAdapter(STARMEM_BENCH_CORPUS).loadConversations():
  bench/sweeps/_modal-point.js
  bench/baselines/_modal-point.js
  bench/sweeps/_modal-batchsize-point.js

bench/cli.js (local CLI) gains the same adapter-lookup path plus a
--max-items flag for LongMemEval; --conversations preserved as the
LoCoMo-legacy maxConversations alias. bench/runner.js unchanged —
runHarness accepts pre-loaded corpora; corpus selection belongs in
entrypoints, not runHarness.

render_by_task_type Python mirror of bench/render/by-task-type.js
keeps report rendering consistent between Node-side baselines and
Modal-side sweeps. Canonical LongMemEval 6-type order, unknown
types alphabetical.

+5 pytest assertions (test_corpus_param.py); sub-orchestrator
decorator invariant preserved (run_graph_sweep, run_consolidation_sweep,
run_consolidation_batchsize_sweep remain undecorated per Phase 11 Task 6
hot-fix)."
```

**Done-when:**
- [ ] `--corpus` parameter on main() + validated against {locomo, longmemeval-s}
- [ ] `run_point`, `run_baseline_point`, `run_batchsize_point` accept `corpus` kwarg, thread to Node subprocess env
- [ ] `run_sweep` + `run_baselines` accept `corpus` kwarg, fan out via `.map([(arg, corpus), ...])`
- [ ] Three Node Modal entrypoints (`bench/sweeps/_modal-point.js`, `bench/baselines/_modal-point.js`, `bench/sweeps/_modal-batchsize-point.js`) read `STARMEM_BENCH_CORPUS` and dispatch via `getAdapter`
- [ ] `bench/cli.js` uses `getAdapter` for local CLI (`--corpus longmemeval-s --max-items N` works)
- [ ] `bench/runner.js` unchanged (no CLI parsing, no env-var reading — it just accepts a pre-loaded `corpus` array)
- [ ] `render_by_task_type` Python function mirrors JS renderer
- [ ] Per-task-type slice appended to relevant reports when byTaskType present
- [ ] 5 new pytest assertions green (13 total)
- [ ] Sub-orchestrator decorator invariant holds: `run_graph_sweep` + `run_consolidation_sweep` + `run_consolidation_batchsize_sweep` undecorated
- [ ] Top-level entry decorator count unchanged (5: `run_point`, `run_baseline_point`, `run_batchsize_point`, `run_sweep`, `run_baselines` all `@app.function`)
- [ ] Commit landed

**Subagent delegation context (include verbatim when dispatching):**

> You are implementing STARmem Phase 12 Task 5. Read `## Task 5` in `docs/plans/phase-12-multi-corpus.md` in full. Tasks 2, 3, and 4 must have landed. Key invariants: (1) The decorator invariant is **sub-orchestrator specific**: `run_graph_sweep`, `run_consolidation_sweep`, `run_consolidation_batchsize_sweep` MUST stay undecorated; they run inside `run_sweep`'s Modal context per Phase 11 Task 6 hot-fix. Top-level entries (`run_point`, `run_baseline_point`, `run_batchsize_point`, `run_sweep`, `run_baselines`) are ALL `@app.function`-decorated — do not remove their decorators. Verify with the grep commands in Step 7 before committing. (2) `render_by_task_type` Python ordering must match `bench/render/by-task-type.js` exactly — canonical LongMemEval 6 types first, unknowns alphabetical. (3) Modal module stubbing follows the Phase 11 Task 1 pattern (sys.modules['modal'] = stub). (4) DO NOT modify `bench/runner.js` — corpus selection lives in the Modal Node entrypoints (`bench/sweeps/_modal-point.js`, `bench/baselines/_modal-point.js`, `bench/sweeps/_modal-batchsize-point.js`) and in `bench/cli.js`, not in `runHarness`. `runHarness` already accepts a pre-loaded `corpus` array. (5) STARMEM_BENCH_CORPUS is the canonical env var name for corpus threading to Node entrypoints. (6) If you see `const FOO = ***` or `BAR = ***` in the plan that's a tooling redaction, not real code — stop and report. (7) Commit exactly as Step 8.

---

## Task 6: First live 4-retriever baselines on both corpora

**Objective:** Execute the first live 4-retriever baselines dispatch on LongMemEval-S via Phase 11's `--mode run-baselines` Modal surface, and refresh `docs/bench/baseline.json` into a multi-corpus shape. LoCoMo baselines already landed pre-Task 3 at commit `0e9c17d` (see `docs/bench/baselines/2026-04-23-comparison.md` + the existing `headlineMetrics` block in `baseline.json`); Task 6's real work is the LongMemEval-S dispatch + the JSON restructure.

**Owner:** Eva (Modal dispatch) + Controller (synthesis, baseline.json write, commits).

**Execution status (2026-04-23 preflight, 9 Task-1-to-5 commits deep):**
- [x] LoCoMo baselines already landed at commit `0e9c17d`, report at `docs/bench/baselines/2026-04-23-comparison.md`, numbers already written to `baseline.json`'s `headlineMetrics` + `structuralInvariants` blocks. No re-dispatch needed.
- [ ] LongMemEval-S baselines dispatch (cold extraction cache, see Finding 2 below).
- [ ] `baseline.json` multi-corpus restructure (no validator changes — LoCoMo values stay at root, LongMemEval-S gets a new `perCorpus.longmemevalS` block).

**Files:**
- Create: `docs/bench/baselines/2026-04-XX-longmemeval-s-live.md` — 4-retriever baselines report for LongMemEval-S (includes `byTaskType` slice from Task 4's renderer work)
- Modify: `docs/bench/baseline.json` — Update `corpus` + `statusReason` to reflect multi-corpus; add `perCorpus.longmemevalS.{ladder,bm25only,recency,random}` block; keep LoCoMo values at `headlineMetrics` + `structuralInvariants` root for schema validator compatibility (no validator edit needed).
- **Not needed (preflight-verified):**
  - ~~LoCoMo report creation~~ — already exists as `docs/bench/baselines/2026-04-23-comparison.md`.
  - ~~`tests/integration/bench/baseline-json.test.js` extension~~ — validator asserts `headlineMetrics.{4 retrievers}` + `structuralInvariants.{ladderVsRandom, ladderVsBm25Only}`; keeping LoCoMo at those paths leaves all assertions passing. Adding a sibling `perCorpus` key doesn't violate any assertion (it's an additional property, not a replacement).

**Preflight:**

1. **Confirm LoCoMo artifact is intact.** `ls docs/bench/baselines/2026-04-23-comparison.md` should resolve; the file is 101 lines, contains overall + per-category tables. Numbers in the current `baseline.json::headlineMetrics` must match the report's top-line row (ladder MRR 0.8057, bm25only 0.6898, recency 0.2703, random 0.2690). If they drift, fix the report before proceeding — `baseline.json` is source of truth after Phase 11 close.

2. **LongMemEval-S has no extraction cache yet.** This corpus is being introduced in Phase 12; the `bench/.cache/extractions/` entries from 9.4.8 onward are LoCoMo-keyed (on `sha256(model|messages|maxTokens)` where the message content is LoCoMo-shaped). Dispatching `run-baselines` cold will trigger live Nano-GPT extraction for every LongMemEval-S item on the first retriever to hit a given (conversation, fact-batch) tuple; subsequent retrievers within the same dispatch hit the Volume-persisted cache.

   **Budget arithmetic (corrected from Decision 10's LoCoMo-shaped estimate):**
   - Corpus size: 500 items (Decision 8 flatten-to-single-session shape).
   - Expected extraction calls per item: ~3–5 (varies by session length after flatten; closer to LoCoMo's per-item shape than its per-conversation shape because each LongMemEval-S item is treated as a single conversation).
   - `run_baseline_point` runs in a single Modal container with `timeout=1800s` (confirmed at `bench/modal/sweep_app.py` line ~143). Extraction happens *inside* this container via the `node bench/baselines/_modal-point.js` subprocess — **not** parallelized across Modal containers at extraction time. This is a serial per-container run, fanning out only across the 4 retriever IDs via `run_baseline_point.map()`.
   - At ~4 calls/item × 500 items × ~1.3s/call ≈ 2600s of live-Nano-GPT time in the worst case. **This blows the 1800s container timeout.**

   **Two workable options, pick before dispatch:**

   (a) **Warm the cache first via a `run-point` pre-pass.** One `modal run --mode run-point --corpus longmemeval-s --overrides-json '{}'` seeds the cache for `bm25only`/`recency`/`random` (which reuse the same extraction output as `ladder`). `run_point` has its own `timeout=1800s` but the same single-container-serial constraint applies, so even this pre-pass may timeout on a 500-item corpus. Consider splitting the corpus into halves via a temporary `overrides-json` slicing knob, or adjusting `timeout` on `run_point` to 3600s for the one-shot warm-up dispatch.

   (b) **Pre-warm via a conversation-split sweep** (Phase 11 Task 6's Option B pattern). Add an ephemeral `run_longmemeval_warmup_point(item_idx)` that extracts for a single item in a bounded container, `.map()` over `[0..499]`, let Modal parallelize across 32 free-tier containers. Expected wall-clock: ~2–4 min. Durable if the timeout hits mid-stream because per-item containers land Volume commits on clean per-item exit.

   **Decision (2026-04-23 preflight):** Option (b) — matches the Phase-11-validated pattern (commit `e28b598` + hot-fixes `344e88f`/`6c7fbaa`), per-item Volume commits survive SIGKILL, and the ~30 LOC becomes reusable infrastructure for any future corpus that needs fresh cache warming without blowing a `run_point` timeout. Full sketch below.

**Pre-step: Cache warm-up via conversation-level split (Option B sketch)**

**Files to add:**
- `bench/modal/sweep_app.py` — new `run_longmemeval_warmup_point` (decorated per-cell) + `run_longmemeval_warmup` (decorated top-level orchestrator, called via `modal run ... --mode warmup-longmemeval`).
- `bench/harness/_modal-warmup-point.js` — Node per-item extraction script. Reuses Task 3's `longmemeval-s` adapter + Task 2's `CorpusAdapter` loading path; runs extraction only, emits stats to stdout.

**`bench/modal/sweep_app.py` additions** (insert near `run_baseline_point` / `run_batchsize_point` so the sibling pattern is visually adjacent):

```python
@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,   # per-item; ~5 LLM calls × ~1.3s ≈ 7s in the worst realistic case, huge headroom for network jitter
    memory=4096,
)
def run_longmemeval_warmup_point(item_idx: int) -> str:
    """Warm the extraction cache for a single LongMemEval-S item.

    Executes extraction (no retrieval) on one item via Task 3's adapter
    path, landing cache entries on /data/extractions/ via the repo-cache
    symlink. Commits the Volume before return so the write survives any
    later container crash in the fan-out.

    Per sweep-cache-invalidation-audit Option A + B combined: per-item
    granularity (Option B) + per-cell commit on clean exit (Option A) =
    maximum durability under SIGKILL.

    Returns:
        JSON string { itemIdx, factCount, turnsProcessed,
                      consolidationStats, wallMs }, or { error, ... }
        on subprocess failure.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)

    # Mirror run_baseline_point's symlink setup — longmemeval_s_cleaned.json
    # is the file the adapter's DEFAULT_CACHE path probes via
    # bench/.cache/longmemeval_s_cleaned.json. Without the symlink,
    # `loadConversations({offline: true})` throws.
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
    if not os.path.exists(longmemeval_link):
        os.symlink("/data/longmemeval_s_cleaned.json", longmemeval_link)
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_BENCH_CORPUS"] = "longmemeval-s"
    env["STARMEM_WARMUP_ITEM_IDX"] = str(item_idx)
    # REQUIRED: seedConversation's _resolveExtractor() gates live extraction
    # on this env var. Without it, warmup runs the rule-based extractor
    # and never populates the LLM cache. env_secret also supplies
    # STARMEM_BENCH_LLM_URL / STARMEM_BENCH_API_KEY / STARMEM_BENCH_LLM_MODEL
    # (matches what run_baseline_point relies on for live-extraction runs).
    env["STARMEM_BENCH_LIVE_EXTRACTOR"] = "1"

    result = subprocess.run(
        ["node", "bench/harness/_modal-warmup-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )

    # Commit cache writes BEFORE returning the payload. If the next point
    # in the fan-out SIGKILLs, this item's extractions still survive on
    # the Volume. Matches the Option A pattern from the skill.
    volume.commit()

    if result.returncode != 0:
        import json as _json
        return _json.dumps({
            "error": "warmup subprocess failed",
            "itemIdx": item_idx,
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
        }, indent=2)
    return result.stdout.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,
    memory=4096,
)
def run_longmemeval_warmup(corpus_size: int = 500) -> dict:
    """Fan out per-item LongMemEval-S cache warm-up across bounded containers.

    Top-level Modal entry (decorated): called via
    `modal run bench/modal/sweep_app.py --mode warmup-longmemeval`.

    Not a sub-orchestrator — does NOT match the Phase 11 Task 6 hot-fix
    pattern that removed @app.function from run_graph_sweep et al. Those
    are called from INSIDE run_sweep's open container context; this one
    is the entry itself and must be a modal.Function so Modal spawns
    the container that will drive the .map() fan-out.

    Cache observability: extractionCache.js does not expose a stats API,
    so we report cache-file-count delta on the Volume instead (before vs
    after). Non-zero delta = warmup actually wrote new entries. Zero
    delta + non-zero factCount per item = suspicious (cache-key identity
    mismatch); investigate before dispatching the full baselines run.

    Args:
        corpus_size: number of LongMemEval-S items to warm.
                     Default 500 = full corpus post-flatten (Decision 8).

    Returns:
        Summary dict with { warmedCount, failedCount, wallMs,
                            totalFactCount, cacheFilesBefore,
                            cacheFilesAfter, cacheFilesDelta,
                            failures: [...] }.
    """
    import json
    import os
    import time

    cache_dir = "/data/extractions"
    os.makedirs(cache_dir, exist_ok=True)
    volume.reload()  # pick up any writes from previous dispatches before counting
    cache_files_before = len(os.listdir(cache_dir))

    t0 = time.time()
    results_raw = list(run_longmemeval_warmup_point.map(range(corpus_size)))

    warmed = []
    failed = []
    total_fact_count = 0
    for raw in results_raw:
        parsed = json.loads(raw)
        if "error" in parsed:
            failed.append(parsed)
        else:
            warmed.append(parsed)
            total_fact_count += parsed.get("factCount", 0) or 0

    volume.reload()  # pick up the fan-out's commits
    cache_files_after = len(os.listdir(cache_dir))

    return {
        "warmedCount": len(warmed),
        "failedCount": len(failed),
        "totalFactCount": total_fact_count,
        "cacheFilesBefore": cache_files_before,
        "cacheFilesAfter": cache_files_after,
        "cacheFilesDelta": cache_files_after - cache_files_before,
        "wallMs": int((time.time() - t0) * 1000),
        "failures": failed[:10],  # cap for log legibility on Modal's output tail
    }
```

**Main CLI hook** in the existing `if mode == ...` block (insert alongside `run-baselines` / `run-sweep`):

```python
elif mode == "warmup-longmemeval":
    result = run_longmemeval_warmup.remote(corpus_size=corpus_size)
    print(json.dumps(result, indent=2))
```

**Plumb `corpus_size` through `@app.local_entrypoint()`.** Modal's Click-based CLI only accepts flags declared in the `main()` signature; adding a new CLI flag requires adding a parameter. Extend `def main(...)` at line ~1989:

```python
@app.local_entrypoint()
def main(
    mode: str = "hello",
    overrides_json: str = "{}",
    sweep_name: str = "tau",
    synthetic: bool = False,
    local_out: str = "",
    corpus: str = "locomo",
    corpus_size: int = 500,   # NEW: --corpus-size N for warmup-longmemeval mode
):
```

Modal maps underscores to dashes on the CLI, so `corpus_size` becomes `--corpus-size` automatically. Default 500 = full LongMemEval-S corpus post-flatten (Decision 8). Only `--mode warmup-longmemeval` reads it; other modes ignore it silently.

Also add a docstring line under `--corpus CORPUS:`:

```
    --corpus-size N:
        Only relevant to --mode warmup-longmemeval. Number of LongMemEval-S
        items to warm. Default 500 = full corpus. Use lower values for
        smoke runs: 1 to validate the pipe, 10 to validate parallelism.
```

**`bench/harness/_modal-warmup-point.js`** (new file, ~50 LOC):

```js
/**
 * Warmup point for LongMemEval-S extraction cache.
 *
 * Reads one item by index, runs seedConversation with the live extractor
 * enabled, and emits seed stats. Meant to be fanned out via
 * run_longmemeval_warmup_point.map(range(500)) so Modal parallelizes
 * the first-pass live-LLM cost across 32 free-tier containers.
 *
 * Mirrors bench/baselines/_modal-point.js's stderr-redirect pattern so
 * stdout stays pure JSON for the Python-side json.loads().
 *
 * Env (enforced):
 *   STARMEM_BENCH_CORPUS=longmemeval-s
 *   STARMEM_WARMUP_ITEM_IDX=<int>  (0-indexed into the post-flatten corpus)
 *   STARMEM_BENCH_LIVE_EXTRACTOR=1  (without this, seedConversation's
 *     _resolveExtractor() falls back to rule-based and the cache stays cold)
 *   STARMEM_BENCH_LLM_URL, STARMEM_BENCH_API_KEY, STARMEM_BENCH_LLM_MODEL
 *     (supplied by the env_secret Modal Secret, same as run_baseline_point)
 *
 * @module bench/harness/_modal-warmup-point
 * @see docs/plans/phase-12-multi-corpus.md Task 6 Pre-step
 */
import { getAdapter } from '../corpora/index.js';
import { seedConversation } from './seeder.js';

const corpusName = process.env.STARMEM_BENCH_CORPUS;
const itemIdx = Number(process.env.STARMEM_WARMUP_ITEM_IDX);

if (corpusName !== 'longmemeval-s') {
    console.error(`warmup-point requires STARMEM_BENCH_CORPUS=longmemeval-s, got '${corpusName}'`);
    process.exit(2);
}
if (!Number.isInteger(itemIdx) || itemIdx < 0) {
    console.error(`warmup-point requires STARMEM_WARMUP_ITEM_IDX as non-negative integer, got '${process.env.STARMEM_WARMUP_ITEM_IDX}'`);
    process.exit(2);
}
if (process.env.STARMEM_BENCH_LIVE_EXTRACTOR !== '1') {
    console.error(`warmup requires STARMEM_BENCH_LIVE_EXTRACTOR=1 to populate the extraction cache; rule-based fallback would no-op`);
    process.exit(2);
}

// Route all harness log output to stderr so stdout is reserved for the
// JSON payload that run_longmemeval_warmup_point will json.loads().
const _origLog = console.log;
console.log = (...args) => console.error(...args);

const t0 = Date.now();

const adapter = getAdapter(corpusName);
const items = await adapter.loadConversations({ offline: true });

if (itemIdx >= items.length) {
    console.error(`STARMEM_WARMUP_ITEM_IDX ${itemIdx} out of range (corpus has ${items.length} items)`);
    process.exit(3);
}

const item = items[itemIdx];

const seedResult = await seedConversation(item, {
    chatIdPrefix: `warmup-lme-${itemIdx}`,
    keepBackend: false,  // discard state; we only care about cache side-effects
});

const wallMs = Date.now() - t0;

_origLog(JSON.stringify({
    itemIdx,
    factCount: seedResult.factCount,
    turnsProcessed: seedResult.turnsProcessed,
    consolidationStats: seedResult.consolidationStats,
    wallMs,
}));
```

**Preflight notes for the sketch (verified 2026-04-23 against repo HEAD `5e00563`):**

1. ✅ **Adapter shape compatibility confirmed.** `bench/corpora/longmemeval.js::normalizeItem` emits `CorpusConversation` (`{id, turns[], qa[]}`) with `turns[]` carrying `{speaker, text, sessionId, turnIndex}`. `seedConversation` at `bench/harness/seeder.js:193` iterates `conv.turns` and reads `turn.text` — compatible as-is.
2. ✅ **Adapter API path confirmed.** Import is `from '../corpora/index.js'` (barrel), method is `loadConversations({offline: true})`. Sibling pattern in `bench/baselines/_modal-point.js:16` uses the same import.
3. ✅ **Live extractor gating confirmed.** `_resolveExtractor()` at `seeder.js:42` checks `STARMEM_BENCH_LIVE_EXTRACTOR === '1'`. The warm-up Python sets this explicitly and the Node script refuses to run without it — no silent rule-based fallback risk.
4. ⚠️ **No cache stats API in `extractionCache.js`.** File only exports `_cacheKey` and `wrapWithCache` (verified at `bench/harness/extractionCache.js`). Observability moved to Python-side `os.listdir('/data/extractions')` count delta. ~~Do NOT add counter hooks to `extractionCache.js` just for the warmup — scope creep into a hot path.~~ **Superseded 2026-04-23 (commit `3770cb6`):** An opt-in `stats: {hits, misses}` counter was added to `wrapWithCache` after the first smoke produced `hits=0 misses=110 failures=104/104` with zero top-level error — the subprocess reported batch-level failures, the Python orchestrator classified the item as "warmed." The counter is two synchronous integer increments gated behind an optional keyword arg — zero hot-path cost, permanent operator visibility. Test coverage: `tests/unit/bench/extractionCache.test.js` +3 tests.
5. ✅ **Per-item timeout headroom.** Declared at 600s. LongMemEval-S items post-flatten are typically ≤20 turns with ≤5 extraction calls at ~1.3s each = ~7s expected; even 5× worst-case stays well under 600s.

**Smoke sequence before full dispatch:**

```bash
# 1. Tiny smoke: one item, verify the pipe works end-to-end.
modal run bench/modal/sweep_app.py --mode warmup-longmemeval --corpus-size 1
# Expect: warmedCount=1, failedCount=0, cacheFilesDelta ≥ 1, totalFactCount > 0.
# If cacheFilesDelta=0 but totalFactCount>0, the cache-key identity is off — STOP.
# If warmedCount=0 and failures[0] shows subprocess stderr, read it (usually a missing env var).

# 2. Mid-size smoke: 10 items, validate parallelism kicks in.
modal run bench/modal/sweep_app.py --mode warmup-longmemeval --corpus-size 10
# Expect: wallMs well under single-item × 10 (e.g. ~15s, not ~70s).

# 3. Full run.
modal run bench/modal/sweep_app.py --mode warmup-longmemeval
# Expect: ~4-5 min wall-clock, cacheFilesDelta in the ~1500-3000 range
# (500 items × ~3-5 unique extraction batches each).
```

**Expected full-run wall-clock (original LoCoMo-extrapolated estimate):** 500 items / 32 parallel containers = 16 waves; at ~15-20s per wave (cold-start dominated, not per-item compute) = **~4-5 min total**.

**Expected Nano-GPT cost (original):** ~500 items × ~4 calls/item × Gemma 4 26B A4B token pricing. The 10-item smoke gives a real-dollar extrapolation before committing to the full 500.

---

**2026-04-23 retro: the LoCoMo-extrapolated estimate was wrong by ~100×.**

First live `--corpus-size 1` warmup dispatches hit `FunctionTimeoutError` at both 600s and 1800s budgets. Root cause: LongMemEval-S items post-flatten (Decision 8) concatenate 30–40 sessions into 400–800-turn single conversations, not ≤20-turn items as the preflight estimated. At `BATCH_SIZE=5` and ~1.3s/call that's 80–160 sequential extraction calls per item, totaling ~30 min per-item wall — fully serial inside a single `run_longmemeval_warmup_point` container.

Cost shape also 3× higher than preflight: ~100 batches/item × ~$0.00032/batch (observed, Nano-GPT GPT-OSS-20B) = ~$0.033/item × 500 = **~$16.50 per full-corpus cache partition**. With the extraction-cache keyed on `(model, messages, maxTokens)`, every model swap / prompt edit / BATCH_SIZE change pays the full tab again.

**Response (committed):**

1. **Design A parallel cache prewarming** (`0aee22d`). Rewrote `bench/harness/_modal-warmup-point.js` to bypass the serial `seedConversation` pipeline. Pre-computes the same `(model, messages, maxTokens)` triples `consolidate()` would produce on the filtered turn stream and memoizes them into the same on-disk cache via `wrapWithCache`, with K=16 concurrent calls. Drift self-heals because `renderExtractionPrompt` + `EXTRACT_MAX_TOKENS` are imported from the real `src/consolidation/extractFacts.js`. Per-item wall: ~90s (was ~30 min) for ~110 batches at K=16.

2. **Diagnostic visibility + orchestrator honesty** (`3770cb6`). `wrapWithCache` gained opt-in `stats: {hits, misses}`. `_modal-warmup-point.js` logs every batch failure to stderr and emits `firstError` / `modelResolved` / `urlHost` on the JSON payload. Python orchestrator now classifies `allFailed` items as `failedCount`, not `warmedCount` — no more `warmedCount=10, cacheFilesDelta=0` silent failures.

3. **5xx + network retry at the extractor layer** (`b64229e`). `llmExtractor` retries on HTTP 5xx and classic transient `fetch()` errors (`ECONNRESET`, `ENOTFOUND`, `UND_ERR_*`) with exponential backoff. 4xx + response-shape errors are non-retry (they don't transient-fix). Benefits both warmup and baseline paths.

4. **Stratified sampling as the cost escape hatch.** Because full-corpus warmup at $16.50 per partition makes exploratory sweeps impractical, add `--stratified-sample N --stratify-seed S` flags. Picks N items via seeded round-robin across the 6 LongMemEval question types, reifies the indices to `/data/sampled_items_n{N}_seed{S}.json`, and baselines read the same file so warmup and baselines evaluate identical items. At n=50, cost drops to ~$1.65 and wall-clock to ~2 min; per-task-type error bars widen from ±5% to ±15% — acceptable for mismatch *detection*, the actual signal Task 6 is testing. See `docs/plans/phase-12-task-6-extraction-cost-decision.md`.

**Updated smoke + dispatch sequence (stratified n=50):**

```bash
# Warmup — ~2 min, ~$1.65 (GPT-OSS-20B on Nano-GPT)
modal run bench/modal/sweep_app.py --mode warmup-longmemeval \
    --corpus longmemeval-s --stratified-sample 50 --stratify-seed 2026 \
    --extractor-model openai/gpt-oss-20b

# Baselines — must use same --stratified-sample + --stratify-seed
# + --extractor-model or the cache partitions don't align
modal run bench/modal/sweep_app.py --mode run-baselines \
    --corpus longmemeval-s --stratified-sample 50 --stratify-seed 2026 \
    --extractor-model openai/gpt-oss-20b --local-out docs/bench/baselines
```

**Retro filed for the `plan-preflight-audit` skill:** LoCoMo-calibrated cost models do not transfer to a corpus with different session-count-per-item topology. Preflight audits that cite "~4 calls/item × 500 items" without verifying the per-item turn count against the target corpus will mislead by orders of magnitude. Skill patch pending.

---

3. **Budget visibility — Nano-GPT API cost.** Live extraction on ~500 items × ~4 calls × Gemma 4 26B A4B pricing is the real-dollar cost driver for this task. Eva runs a small smoke first (≤5 items) to validate the `longmemeval-s` adapter is emitting well-formed extraction inputs before committing the full corpus budget.

**Step 1: LoCoMo baselines — already done**

Pre-Task 3 landing at `0e9c17d`. Report lives at `docs/bench/baselines/2026-04-23-comparison.md`. Existing `baseline.json::headlineMetrics` + `baseline.json::structuralInvariants` carry the numbers. Skip dispatch; proceed to Step 2.

**Step 2: Execute LongMemEval-S baselines dispatch**

After cache-warming option is chosen and executed (see Preflight §2):

```bash
modal run bench/modal/sweep_app.py --mode run-baselines --corpus longmemeval-s --local-out docs/bench/baselines
```

Expected artifact: `docs/bench/baselines/<timestamp>-baselines.md` + `.json` pair. Rename to `2026-04-XX-longmemeval-s-live.md` / `.json` (consistent with existing naming).

Expected wall-clock: ~2–5 min once the cache is warm (4 retrievers × single-container serial retrieval at cache-hit latency).

**Step 3: Write synthesis report (LongMemEval-S only)**

Controller writes a short prose synthesis at the top of the LongMemEval-S baseline report before the Modal-rendered body. The LoCoMo report (`2026-04-23-comparison.md`) already has its own prose and does not need re-drafting. Template for LongMemEval-S:

```markdown
# 4-retriever baselines — LongMemEval-S (live extraction, 2026-04-XX)

**Run command:** `modal run bench/modal/sweep_app.py --mode run-baselines --corpus longmemeval-s --local-out docs/bench/baselines`
**Extractor:** `google/gemma-4-26b-a4b-it` via Nano-GPT, temperature=0 (Phase 11 default)
**Wall-clock:** ~X min (Modal free-tier, 4 containers in parallel × 4 retrievers; cache pre-warmed via <option a | option b>)

## Summary

First LongMemEval-S baselines under the Phase 12 adapter. 500 items, 6 task types analyzed separately.

Headline aggregated MRR (excluding abstention):
- Ladder: X
- bm25only: X
- recency: X
- random: X

Per-task-type breakdown below. Expected pattern (Eva's ST-single-session hypothesis preview):
- single-session-* types should score similarly to LoCoMo (~0.8 MRR ladder) — STARmem's core design target.
- multi-session and temporal-reasoning likely tank (<0.5 MRR ladder) — the flatten-to-single-session shape per Decision 8 collapses the cross-session signal these task types need.
- knowledge-update mid-band — depends on whether the corpus' update patterns surface via extraction.

Whatever the numbers actually show goes in the retro as evidence (or falsification) of the ST-mismatch hypothesis.

<Then paste the Modal-rendered body below.>
```

**Step 4: Update `docs/bench/baseline.json`**

The current schema (validated at `tests/integration/bench/baseline-json.test.js`) requires `headlineMetrics.{ladder,bm25only,recency,random}` + `structuralInvariants.{ladderVsRandom, ladderVsBm25Only}` at the top level. Phase 12 extends this by **adding** a sibling `perCorpus` block for LongMemEval-S; LoCoMo values stay at the top-level `headlineMetrics` for validator compatibility (and because LoCoMo is still the primary regression target):

```json
{
    "asOf": "2026-04-XX",
    "gitSha": "<phase-12-task-6-commit>",
    "corpus": "multi-corpus (locomo + longmemeval-s). locomo at top-level headlineMetrics/structuralInvariants; longmemeval-s under perCorpus.longmemevalS.",
    "nodeVersion": "v20.20.2",
    "scorerId": "default",
    "status": "measured",
    "statusReason": "Phase 12 multi-corpus expansion. LongMemEval-S (500 items, 6 task types) added alongside the existing LoCoMo-10 measurement. Tier 2 demolition landed in Task 1; CorpusAdapter + LongMemEval-S adapter in Tasks 2-3; task-type propagation through metrics in Task 4; --corpus wired through Modal dispatch in Task 5. Task 6: first live LongMemEval-S baselines via the Phase 11 run-baselines surface. LoCoMo numbers unchanged from Phase 11 close (Tier 2 demolition was a no-op on the live metric because τ_gap=10 already suppressed Tier 2's shortcut — confirmed by the unchanged 824+2 regression test in Task 1). <Describe LongMemEval-S signal: whether the ST-single-session hypothesis held, which task types tanked vs held, and whether any structural invariant (ladder >> random) held on this corpus.>",
    "knownIssues": [
        // ... preserve all Phase 11 entries unchanged ...
        "Phase 12: LongMemEval-S flatten-to-single-session shape (Decision 8) collapses multi-session structure by design, testing whether ST's single-session UX collapses retrieval quality on cross-session task types. <Describe actual delta per the report, per task-type>."
    ],
    "tuned": { /* preserve Phase 11's tuned block unchanged — LoCoMo-specific knobs */ },
    "headlineMetrics": {
        /* UNCHANGED — LoCoMo-10 live-extraction numbers from Phase 11 close */
        "ladder":   { "recallAt1": 0.5317, "recallAt5": 0.9363, "recallAt10": 1.0, "mrr": 0.8057, "p50LatencyMs": 3.65, "p95LatencyMs": 5.15 },
        "bm25only": { /* ... */ },
        "recency":  { /* ... */ },
        "random":   { /* ... */ }
    },
    "structuralInvariants": {
        /* UNCHANGED — LoCoMo ladder vs random / ladder vs bm25only */
        "ladderVsRandom": { /* ... */ },
        "ladderVsBm25Only": { /* ... */ }
    },
    "perCorpus": {
        "longmemevalS": {
            "corpus": "longmemeval-s (500 items, flattened per Decision 8 to single-session shape)",
            "source": "baselines/2026-04-XX-longmemeval-s-live.md",
            "headlineMetrics": {
                "ladder":   { "recallAt1": X, "recallAt5": X, "recallAt10": X, "mrr": X, "coverage": X, "p50LatencyMs": X, "p95LatencyMs": X,
                              "byTaskType": { /* 6-type breakdown from Task 4 renderer */ },
                              "abstentionCount": N },
                "bm25only": { /* same shape */ },
                "recency":  { /* same shape */ },
                "random":   { /* same shape */ }
            },
            "structuralInvariants": {
                "ladderVsRandom":   { "threshold": 0.02, "measuredMrrDelta": X, "status": "<PASS|FAIL>", "note": "<one-line rationale>" },
                "ladderVsBm25Only": { "threshold": 0.02, "measuredMrrDelta": X, "status": "<PASS|FAIL>", "note": "<one-line rationale>" }
            }
        }
    },
    "provenance": {
        /* preserve; add baselineComparisonLongmemevalS entry pointing at the new report */
    }
}
```

Note: the validator does **not** require `perCorpus` to exist or be shaped any particular way — it's a free-form extension. The contract it enforces is only at the top level. See the "Not needed (preflight-verified)" line in this task's Files block.

**Step 5: Validator runs unchanged**

```bash
npx jest tests/integration/bench/baseline-json.test.js -v
```

Expected: all assertions pass. No edits needed to the validator.

If any top-level assertion now fails (e.g. `structuralInvariants.ladderVsBm25Only` because the `headlineMetrics` values drift), that's a regression-report bug in LoCoMo's entries, not a Phase 12 schema issue — fix the LoCoMo values, don't edit the validator.

**Step 6: Full suite regression**

```bash
npm test 2>&1 | tail -8
cd bench/modal && python -m pytest -q 2>&1 | tail -5
cd ../..
```

Expected: test counts unchanged from Task 5 (Task 6 is artifact-land + JSON edit, no new code).

**Step 7: Commit**

```bash
git add docs/bench/baselines/2026-04-XX-longmemeval-s-live.md docs/bench/baseline.json
git commit -m "docs(bench): first live LongMemEval-S 4-retriever baselines (Phase 12 Task 6)

Dispatches Phase 11's --mode run-baselines surface on LongMemEval-S for
the first time via the new --corpus Modal parameter (Task 5). LoCoMo
baselines already landed pre-Task 3 at 0e9c17d; this task adds the
multi-corpus half. Documents:
- docs/bench/baselines/2026-04-XX-longmemeval-s-live.md — 4-retriever
  report with per-task-type slice (6 LongMemEval types) from Task 4's
  renderer extension.

baseline.json gains a sibling perCorpus.longmemevalS block (headlineMetrics
+ structuralInvariants, same shape as top-level LoCoMo). Top-level schema
unchanged: LoCoMo stays at headlineMetrics/structuralInvariants for
regression-control and validator compatibility. No edits to
tests/integration/bench/baseline-json.test.js — the validator's contract
is satisfied as-is.

<Summarize ST-single-session-mismatch hypothesis signal: 'confirmed' /
'falsified' / 'mixed' with one-line rationale referencing the per-task-type
numbers; flag which task types fell below ladderVsRandom=0.02 if any.>"
```

**Done-when:**
- [x] LoCoMo baselines report already landed (`docs/bench/baselines/2026-04-23-comparison.md` @ `0e9c17d`) — no re-dispatch
- [ ] LongMemEval-S baselines report landed with byTaskType table
- [ ] `baseline.json` gains `perCorpus.longmemevalS` block with `headlineMetrics` + `structuralInvariants`; top-level LoCoMo values preserved
- [ ] Validator runs unchanged (no schema edits)
- [ ] Synthesis narrative in the LongMemEval-S report flagging ST-mismatch hypothesis signal
- [ ] Commit landed

---

## Task 7: λ₁ tripwire sweep on LongMemEval-S with decision gate

**Objective:** Dispatch a single-axis `TIER3_LAMBDA_1` sweep on LongMemEval-S — 5-point grid matching Phase 9.5's graph sweep (`[0.5, 0.75, 1.0, 1.25, 1.5]`). Compare against Phase 9.5's LoCoMo result (three-time reproduction of "INERT": identical MRR to 4 decimals across all points). Decision gate: if any point's ΔMRR ≥ 0.02 AND coverage_delta ≥ −5pp (Phase 11's amendment rule), expand into a full 4-knob sweep (λ₁, λ₂, EXPLICIT_RELATION_WEIGHT, COOCCURRENCE_WEIGHT) to characterize the signal. If flat, two-corpus "provably inert" finding, stronger than one-corpus.

**Owner:** Subagent (Fireworks / Kimi K2.6) for sweep wiring + decision gate logic; Eva for Modal dispatch; Controller for decision-gate synthesis + retro flag.

**Files (tripwire phase):**
- Modify: `bench/modal/sweep_app.py` — Reuse existing `"graph"` SWEEP_CONFIGS but add a `lambda1-only` single-axis variant (or pass baseOverrides to fix other knobs at spec default). Pattern: `sweep_name = "lambda1_tripwire"` entry that's just the λ₁ axis.
- Create: `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md` — Sweep report

**Files (if gate expands — conditional):**
- Modify: `bench/modal/sweep_app.py` — `"lambda_extended"` sweep definition (4 axes, cartesian product = 5×5×5×4 = 500 cells; more likely coordinate descent via GRAPH_ROUNDS pattern)
- Create: `docs/bench/sweeps/2026-04-XX-longmemeval-graph-extended-live.md`

**Preflight:**

1. **Cache state.** Confirm LongMemEval-S extraction cache is warm from Task 6's baselines dispatch. Cold re-run costs ~9 hours container-seconds; warm is minutes.

```bash
# From Eva's environment:
modal volume ls starmem-bench-cache
# Look for longmemeval-s-keyed extraction cache entries (expect ~20K after baselines
# dispatch populated the cache across 500 items × ~40 sessions).
```

2. **Cache-key identity for λ₁ sweep.** λ₁ is a retrieval-path knob (Tier 3 graph scoring), does NOT invalidate the extraction cache. Sweep cost is 5 points × 500 items × warm-cache seeding ≈ 5 × 2000s = ~3 hours container-seconds, ~10-15 min wall-clock with 5-way parallelism. Tractable.

**Step 1: Add `lambda1_tripwire` SWEEP_CONFIGS entry**

In `bench/modal/sweep_app.py`:

```python
SWEEP_CONFIGS = {
    # ... existing tau, bm25, hops, relw entries unchanged ...
    "lambda1_tripwire": {
        # Phase 12 Task 7: LongMemEval-S tripwire for Tier 3 edge-weight knob.
        # Phase 9.5 three-time reproduced λ₁ as INERT on LoCoMo single-session.
        # Tripwire asks whether multi-session corpus surfaces signal.
        "knobs": [
            {"name": "TIER3_LAMBDA_1", "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
        ],
        "primary_metric": "mrr",
        "renderer": render_single_axis_report,
        # Fix TIER2_TAU_GAP=10 so queries reach Tier 3 (same invariant as
        # 9.4.9/9.5 graph sweeps; Tier 2 demolition in Phase 12 Task 1
        # made this a no-op structurally, but preserved for replayability).
        "base_overrides": {"TIER2_TAU_GAP": 10},
    },
}
```

If `run_sweep` does NOT honor a `base_overrides` key (per preflight note), inline the override into each grid point's override JSON — that's the pattern hops and relw use.

**Step 2: Dispatch**

```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name lambda1_tripwire --corpus longmemeval-s --local-out docs/bench/sweeps
```

Expected artifact: `docs/bench/sweeps/<timestamp>-lambda1_tripwire.md` + `.json`. Rename to `2026-04-XX-longmemeval-lambda1-live.md`.

**Step 3: Decision gate evaluation (controller + Eva)**

Read the rendered report + the `.json` file. Apply the Phase 11 amendment rule:

```
FOR each grid point p:
    baseline = metrics at spec default (TIER3_LAMBDA_1 = 1.0)
    candidate = metrics at p
    ΔMRR = candidate.mrr - baseline.mrr
    Δcoverage_pp = (candidate.coverage - baseline.coverage) * 100
    if ΔMRR ≥ 0.02 AND Δcoverage_pp ≥ -5:
        DECISION_GATE = EXPAND (gate opens on at least one point)
```

Also check `byTaskType` slice — even an aggregate-flat λ₁ sweep could hide signal within one task type. If aggregate is flat but any single task type shows `ΔMRR ≥ 0.02 AND Δcoverage_pp ≥ -5`, flag for retro but do NOT expand to full 4-knob sweep (it's a narrower finding deserving its own sub-phase).

**Three outcomes:**

- **Outcome A — Aggregate flat, no task-type signal.** Two-corpus "provably inert" finding for λ₁. Strong v2.1 signal: LoCoMo flatness wasn't corpus artifact; it's structural to the current graph scoring. Skip to Task 8 retro.

- **Outcome B — Task-type-only signal.** λ₁ moves one task type (likely multi-session or temporal-reasoning) but aggregate flat. Report the split; file a v2.1 sub-phase for task-type-conditioned knob tuning. Skip full 4-knob expansion.

- **Outcome C — Aggregate signal.** Gate opens. Proceed to Step 4 expansion.

**Step 4 (conditional — Outcome C only): Expand to 4-knob sweep**

If gate opens, dispatch the full coordinate-descent pattern matching Phase 9.5's GRAPH_ROUNDS (minus seeds_k and edge_cap which were provably inert), prefixed with λ₁'s winner value:

```python
# Add to sweep_app.py:
LONGMEMEVAL_GRAPH_ROUNDS = [
    {"name": "lambda_1_expanded", "knob": "TIER3_LAMBDA_1",         "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
    {"name": "lambda_2",          "knob": "TIER3_LAMBDA_2",         "values": [0.1, 0.2, 0.3, 0.4, 0.5]},
    {"name": "explicit_rel",      "knob": "EXPLICIT_RELATION_WEIGHT","values": [0.5, 1.0, 1.5, 2.0, 3.0]},
    {"name": "cooccurrence",      "knob": "COOCCURRENCE_WEIGHT",    "values": [0.25, 0.5, 0.75, 1.0]},
]
# Same coordinate-descent driver as GRAPH_ROUNDS
```

Dispatch:

```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name longmemeval_graph_extended --corpus longmemeval-s --local-out docs/bench/sweeps
```

Expected cost: 5 + 5 + 5 + 4 = 19 cells; 19 × ~2000s warm ≈ 10 hours container-seconds; ~20-30 min wall-clock.

**Step 5: Synthesis report**

Write `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md` (plus the expanded one if gate opened) with:

```markdown
# λ₁ tripwire — LongMemEval-S (live extraction, 2026-04-XX)

**Phase 12 Task 7** — single-axis TIER3_LAMBDA_1 sweep, hypothesis pre-registered:
- **H₀ (null):** λ₁ is inert on LongMemEval-S, matching Phase 9.5's LoCoMo three-time reproduction.
- **H₁ (alternative):** λ₁ produces signal on multi-session corpora that LoCoMo's single-session structure suppressed.

**Grid:** `[0.5, 0.75, 1.0, 1.25, 1.5]`, TIER2_TAU_GAP=10 fixed
**Corpus:** LongMemEval-S (500 items, 6 task types)
**Extractor:** Gemma 4 26B A4B via Nano-GPT, temp=0 (Phase 11 default)

## Decision gate outcome: <A: flat / B: task-type signal / C: aggregate signal>

<Fill in based on result, using the amendment rule from Step 3.>

## Aggregate metrics

<Modal-rendered single-axis report.>

## Per-task-type breakdown (from byTaskType slice)

<Pull byTaskType data from each grid point's .json and render per-task-type λ₁ curves. Pattern:>

### single-session-user
| λ₁ | MRR | Coverage |
|----|-----|----------|
| 0.5  | X | X |
| 0.75 | X | X |
| 1.0  | X | X |
| 1.25 | X | X |
| 1.5  | X | X |

### <each other task type>

## Retrospective

<2-4 paragraphs: what the data says, whether hypothesis survived, what it means for v2.1 corpus work, and any Phase 13 candidates surfaced.>
```

**Step 6: Commit**

```bash
git add bench/modal/sweep_app.py docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md
# If expansion ran:
git add docs/bench/sweeps/2026-04-XX-longmemeval-graph-extended-live.md

git commit -m "feat(bench): λ₁ tripwire sweep on LongMemEval-S (Phase 12 Task 7)

Single-axis TIER3_LAMBDA_1 sweep on LongMemEval-S tests whether
Phase 9.5's three-time LoCoMo reproduction of INERT holds on a
second corpus. Decision gate per Phase 11 amendment rule:
<DECISION: flat / task-type-only / aggregate-signal with 4-knob expansion>.

<One-line summary of aggregate MRR spread and per-task-type finding.>

<If expansion ran: full 4-knob coordinate-descent sweep committed
alongside; <winner summary>.>"
```

**Done-when:**
- [ ] `lambda1_tripwire` SWEEP_CONFIGS entry landed
- [ ] Modal dispatch completed, artifact at `docs/bench/sweeps/2026-04-XX-longmemeval-lambda1-live.md`
- [ ] Decision gate outcome documented (A/B/C)
- [ ] If gate opened: 4-knob expansion dispatched + report landed
- [ ] Per-task-type breakdown rendered in the report
- [ ] Retrospective section written
- [ ] Commit(s) landed

**Subagent delegation context (include verbatim when dispatching wiring, NOT dispatch itself):**

> You are implementing the WIRING ONLY for STARmem Phase 12 Task 7. Read `## Task 7` in `docs/plans/phase-12-multi-corpus.md` in full. Tasks 2-5 must have landed. You are NOT dispatching Modal — Eva does that from her environment. Your job: (1) add the `lambda1_tripwire` entry to SWEEP_CONFIGS in `bench/modal/sweep_app.py`; (2) verify via pytest stubs that the entry is shape-valid (uses same structure as existing `hops` and `relw` single-axis sweeps); (3) commit the config-only change with message `feat(bench): lambda1_tripwire sweep config (Phase 12 Task 7 wiring)`. Do NOT write the sweep report, that's controller work after Eva's dispatch. Key invariants: (a) reuse `render_single_axis_report` renderer; (b) inline TIER2_TAU_GAP=10 into each grid point if `base_overrides` isn't supported; (c) preserve the `@app.function` decorator invariant from Task 5. If you see `const FOO = ***` or `BAR = ***` that's a tooling redaction — stop and report.

---

## Task 8: Retro + Phase 10 handoff

**Objective:** Write `docs/plans/phase-12-retro.md`, append Phase 12 entry to `docs/plans/ROADMAP.md §6 Phase Retro Log`, and file explicit handoff notes for Phase 10 (UI/UX) — what signal Phase 10 now has to design against, what task-type weaknesses the UX should surface, what v2.1/13 candidates deserve attention.

**Owner:** Controller. Narrative task; no subagent.

**Files:**
- Create: `docs/plans/phase-12-retro.md`
- Modify: `docs/plans/ROADMAP.md` — append §6 entry for Phase 12

**Phase 12 retro structure** (mirrors Phase 11 retro shape for continuity):

```markdown
# Phase 12 Retro — Multi-Corpus Benchmarking (2026-04-XX)

**Plan:** [docs/plans/phase-12-multi-corpus.md](./phase-12-multi-corpus.md)
**Extractor:** `google/gemma-4-26b-a4b-it` via Nano-GPT, temperature=0 — inherited unchanged
**Baseline artifact:** [`docs/bench/baseline.json`](../bench/baseline.json) (now with `perCorpus` structure)

**Scope:** 8 of 8 tasks landed. Tier 2 demolition, CorpusAdapter + LoCoMo port, LongMemEval-S adapter, task-type propagation, Modal --corpus, first live baselines, λ₁ tripwire with decision gate, retro. <One-line summary of decision-gate outcome.>

---

## 1. What shipped

<Per-task commits list; 8-10 commits typical, similar to Phase 11's 13.>

## 2. Test totals

- jest: <NNN> suites / <NNN> tests — all green
- pytest bench/modal: <NN> tests — all green
- Net Phase 12 additions: +<N> suites, +<N> jest assertions, +<N> pytest assertions

## 3. Decisions held (1–12) / revised

- Decisions 1-12 held / <explicit revisions with rationale>

## 4. Surprises

<List actual surprises from execution. Candidates from preflight expectations:>

1. **LongMemEval cold-extraction cost.** Preflight arithmetic estimated 9 hours container-seconds for cold pass; actual was <X>. Wall-clock <X> min with 32-way parallelism.

2. **ST-mismatch hypothesis signal.** <Confirmed / Falsified / Mixed>. <Which task types tanked, which held. Specific numbers.>

3. **λ₁ tripwire decision-gate outcome.** <Branch A/B/C with specific numbers.>

4. **Tier 2 demolition had zero downstream impact.** <Confirmed: retrieval metrics on LoCoMo unchanged from Phase 11 baseline within <X> noise — the shortcut was genuinely never firing under TIER2_TAU_GAP=10.>

5. **Any Modal-semantic bugs caught at dispatch.** <If any; pattern from Phase 11 Task 6 decorator issue.>

6. **Parallel dispatch of Tasks 4 + 5.** <How it went; any cross-contamination.>

## 5. Notes for Phase 10 (UI/UX)

### What Phase 10 now has

- **Two-corpus retrieval surface** — LoCoMo (regression control) + LongMemEval-S (multi-corpus).
- **Per-task-type breakdown** — 6 task-type slices on LongMemEval-S reveal retrieval quality per reasoning category. Phase 10 UX can surface task-type specific affordances (e.g., "temporal reasoning mode" hint when a user query classifies as temporal AND is below retrieval-quality threshold).
- **Abstention QA count** — tracked but not scored. Phase 10 can decide whether/how to surface "I don't know" in the UI; no scoring mechanism yet (v2.1 inverted metric).
- **4-retriever baselines for both corpora** — ladder vs bm25only vs recency vs random comparisons are now live-measured. Phase 10 debug UX can display "your retrieval path is N% better than random on this corpus" for user trust-building.

### What Phase 10 should watch out for

1. **ST-mismatch hypothesis evidence.** <If confirmed: design UX acknowledging multi-session weakness (e.g. session-boundary hints, "check earlier chats" prompts). If falsified: ST-single-session flatten was fine; other LongMemEval weaknesses surface.>

2. **λ₁ still inert two-corpus / OR: Outcome C.** <If inert: Phase 10 doesn't need to surface graph-retrieval tuning UX; it's a dev-only knob. If gate opened: graph tuning becomes a user-facing surface worth exposing.>

3. **Tier 2 is dead.** The ladder is now 0→1→3→Floor; tier 2 BM25 is only visible as seed provider. Any debug UX showing tier resolution should label "tier 2" as "BM25 seed stage" not a resolver.

### What Phase 10 should NOT do

- **Do not re-introduce Tier 2 as a resolver.** Constants stay; semantics don't.
- **Do not pivot the retrieval path on LongMemEval-multi-session signal.** If confirmed weakness, file v2.1; don't handle in UI layer.
- **Do not add UX for abstention scoring.** v2.1.

## 6. v2.1 / Phase 13 candidates filed from Phase 12

<Outcomes drive this section. Candidates:>

1. **ST-single-session mismatch fix.** If LongMemEval-multi-session confirmed the collapse, file a v2.1 sub-phase for multi-session-aware retrieval (per-session indexing, cross-session re-ranking).

2. **Abstention scoring (inverted metric).** Deferred from Phase 12 per Decision 10. v2.1 if user research shows abstention is UX-critical.

3. **Zep / Mem0 / Mem3 / MemGPT external baselines.** Deferred per Decision 2. v2.1 candidate if we want comparison against published numbers.

4. **LongMemEval `_oracle` and `_m` variants.** Deferred per Decision 7. `_m` especially: 500-session haystacks stress the retrieval path much harder than `_s`.

5. **Tier 2 code removal (not just demolition).** Phase 12 kept constants for replayability; full removal of TIER2_TAU_CONFIDENCE, TIER2_TAU_GAP, and the Tier 2 shortcut branch history from the codebase is Phase 13 cleanup.

6. **`EXTRACT_MAX_TOKENS → 256` sweep.** Deferred from Phase 11 *and* Phase 12 per Decision 11. Worth its own sub-phase.

7. **Renderer-signature convention cleanup.** Minor debt from Phase 11; doesn't block anything but worth a tidy-up pass.

<Conditional candidates based on decision-gate outcome:>

8. <IF Outcome B from λ₁ tripwire> **Task-type-conditioned knob tuning.** One task type surfaced signal; dedicated sub-phase to tune per-task-type.

9. <IF Outcome C> **Full 4-knob coordinate-descent expanded.** Landed in Phase 12, but follow-up sub-phase to adopt any amended knob values into `docs/bench/baseline.json` tuned block and spec.

---
```

**ROADMAP.md §6 entry** (append after Phase 11 entry):

```markdown
## Phase 12—2026-04-XX

**What shipped:** Multi-corpus benchmarking substrate. LongMemEval-S (500 items, 6 task types) added alongside LoCoMo-10 as the second benchmark corpus. Tier 2 demolition landed; ladder simplified to Tier 0→1→3→Floor with Tier 2 retained solely as BM25 seed provider. `CorpusAdapter` interface under `bench/corpora/` replaces `bench/loaders/` (kept as re-export shim for one phase). `computeMetrics` emits `byTaskType` slice; abstention QAs reported by count not scored (Decision 10). Modal substrate gains `--corpus {locomo, longmemeval-s}` across `run-point`, `run-baselines`, `run-sweep` modes. First live 4-retriever baselines dispatch on both corpora. λ₁ tripwire on LongMemEval-S: <Outcome A/B/C with numbers>.

**Test totals:** <NNN> suites / <NNN> tests (jest) + <NN> tests (pytest bench/modal). All green.

**Commits this phase:** <N> total. <Commit range>.

**Execution mode:** Hybrid. Controller owned Tasks 0, 1, 6, 8. Subagents owned Tasks 2, 3, 4, 5, 7 (wiring only). Parallel dispatch opportunities used: Task 1 ∥ Task 2, Task 4 ∥ Task 5.

**Decisions held (1–12) / revised:** <summary>

**Surprises:**

<List actual surprises.>

**Notes for Phase 10 (UI/UX):**

- Two-corpus retrieval surface available for UX decisions.
- Per-task-type breakdown reveals retrieval quality per reasoning category.
- ST-mismatch hypothesis: <confirmed / falsified>. <UX implication.>
- Tier 2 is no longer a resolver; debug UX should label as "BM25 seed stage."
- Do not re-introduce Tier 2 semantics.
- Do not pivot retrieval path on LongMemEval-multi-session signal in UX — v2.1 territory.

**v2.1 / Phase 13 candidates filed:** ST-single-session fix (conditional), abstention scoring, Zep/Mem0 external baselines, LongMemEval _oracle/_m, Tier 2 full removal, EXTRACT_MAX_TOKENS sweep, renderer-signature cleanup.
```

**Step 1: Write retro**

Write `docs/plans/phase-12-retro.md` following the structure above. ~250-400 lines typical. Fill in actual numbers from Task 6 baselines and Task 7 sweep.

**Step 2: Append to ROADMAP.md §6**

Use `patch` to insert the Phase 12 entry after the existing Phase 11 entry in ROADMAP's §6 Phase Retro Log.

**Step 3: Full suite final verification**

```bash
npm test 2>&1 | tail -8
cd bench/modal && python -m pytest -q 2>&1 | tail -5
cd ../..
```

All green. Test counts match what the retro documents.

**Step 4: Commit**

```bash
git add docs/plans/phase-12-retro.md
git commit -m "docs(plans): phase 12 retro"

git add docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 12 retro entry in ROADMAP"
```

Two commits (matches Phase 11's retro + ROADMAP split pattern).

**Done-when:**
- [ ] `docs/plans/phase-12-retro.md` written
- [ ] ROADMAP §6 has Phase 12 entry
- [ ] All surprises documented
- [ ] v2.1 / Phase 13 candidates filed
- [ ] Notes for Phase 10 explicit
- [ ] Full suite green; test counts match retro
- [ ] Two commits landed

---

## Verification before declaring phase complete

Run this checklist at the end:

- [ ] Task 1 (Tier 2 demolition): `src/retrieval/ladder.js` retrieve() has no `tierResolved: 2` return path; regression assertions green
- [ ] Task 2 (adapter): `getAdapter('locomo')` works, round-trip equality with legacy loader
- [ ] Task 3 (LongMemEval): `getAdapter('longmemeval-s')` works, fixture-based tests green, network fetch + cache path functional
- [ ] Task 4 (metrics): `computeMetrics` emits `byTaskType` + `abstentionCount`, LoCoMo-shape backward compat preserved
- [ ] Task 5 (Modal): `--corpus` parameter on all 3 modes, decorator invariant holds
- [ ] Task 6 (baselines): both corpora baseline reports landed, `baseline.json` has `perCorpus` nesting
- [ ] Task 7 (λ₁ tripwire): sweep dispatched, decision gate resolved, report landed
- [ ] Task 8 (retro): retro + ROADMAP entry, v2.1 candidates filed
- [ ] All commits pushed; `git status` clean
- [ ] `npm test` green, `pytest bench/modal` green
- [ ] ROADMAP Phase 12 done-when checkboxes all ticked

---

## Runtime considerations

**Budget estimates (revised at plan write time):**

- Controller wall-clock: ~6-8 hours across 8 tasks, excluding Modal dispatches
- Subagent wall-clock: ~15-30 min per delegation, 5 delegations → ~1.5-2.5 hours
- Eva's Modal dispatches:
  - Task 6 baselines × 2 corpora: ~15-30 min each (cold LongMemEval is slower)
  - Task 7 λ₁ tripwire: ~10-15 min warm
  - Conditional Task 7 expansion: ~20-30 min
  - LongMemEval extraction cache warming (if not pre-warmed): ~15-30 min wall-clock at 32-way parallelism
- Total phase: ~1.5-2 days of elapsed controller work; ~1-2 hours of Eva's Modal dispatches

**Azure-flakiness posture:** Continue Phase 11 hybrid pattern. Subagents handle all large-surface refactors (Tasks 2-5, 7-wiring) — routed through Fireworks/Kimi. Controller handles mechanical + narrative (Tasks 0, 1, 6, 8). Eva handles all Modal dispatches. Zero Azure exposure on subagent work by design.

**Cache invalidation audit:** LongMemEval corpus is new; extraction cache on Modal Volume is empty for its keys. Warm via Task 6's baselines dispatch preamble or via a single `run-point --corpus longmemeval-s` dispatch before Task 6. Cold first pass is the expensive one; λ₁ sweep is a retrieval-path knob and does NOT invalidate the extraction cache (confirmed via Phase 9.5 sweep-cache-invalidation-audit pattern).

**Parallel dispatch opportunities revisited:**
- Task 1 (controller) ∥ Task 2 (subagent) — disjoint file sets
- Task 4 (subagent) ∥ Task 5 (subagent) — disjoint file sets once Tasks 2+3 land
- Task 6 LoCoMo dispatch ∥ any controller/subagent work during Tasks 1-5 — Eva's dispatch is already in flight

---

## Phase 13 removal candidates

A running list of architectural dead weight surfaced during Phase 12 work. To be migrated into the Phase 12 retro + ROADMAP "Notes for Phase 13" section at phase close.

- **`TIER2_TAU_CONFIDENCE` and `TIER2_TAU_GAP`** — architecturally dead after Task 1's Tier 2 demolition. The `t2.hit` short-circuit they gated no longer exists; Tier 2 is purely a BM25 seed provider for Tier 3. Kept in `src/core/constants.js` + `_SWEPT_RETRIEVAL_KEYS` for command-template durability and to avoid re-wiring the tau sweep during Phase 12. Also retained: the tau sweep itself (`bench/sweeps/tau.js`, `bench/modal/sweep_app.py::render_tau_report`) is vacuous-by-construction post-demolition (logs flat lines over a dead knob — the exact pattern `detecting-vacuous-metrics` v1.1.0 warns against) and is a removal candidate alongside the constants.
    - Dropped as a W&B wiring target for that reason (2026-04-24): wiring tau into the dashboard would be a logged-flat-line exercise with zero signal. Graph sweep wired instead.
    - Removal surface: 2 constant exports, 2 entries in `_SWEPT_RETRIEVAL_KEYS`, `bench/sweeps/tau.js`, `render_tau_report` + its dispatch branch in `run_sweep`, any `TIER2_TAU_GAP=10` entries in `GRAPH_BASE_OVERRIDES` / `RELW_BASE_OVERRIDES` / similar (no longer semantically meaningful after demolition).

---

## Deferred bugs

Low-urgency issues to resolve at a future phase boundary. Not blocking Phase 12 tasks.

- ~~**`bench/modal/tests/` collection errors on `FilePatternMatcher` import**~~ **RESOLVED 2026-04-24 at `0051c65`.** Extracted the modal stub into `bench/modal/tests/conftest.py::_install_modal_stub()` and stripped the 41-line per-file duplication. All 5 test files now collect; 25 tests pass in 0.10s without the real `modal` package installed. Maintenance contract documented at conftest top: new top-level `from modal import X` lines in `sweep_app.py` must be back-filled into the stub helper.

---

**End of plan.**
