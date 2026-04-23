# Phase 12 Task 6 — Extraction cost blowout decision doc

**Status:** Paused mid-smoke, 2026-04-23 ~18:15. Need direction.
**Handoff:** Fresh chat picks this up. Don't re-derive; read and decide.

---

## What happened

Task 6 dispatch requires warming the extraction cache for LongMemEval-S before
the 4-retriever baselines run. The plan's wall-clock estimate (~4–5 min full
warmup, ~7s per item) was off by **2+ orders of magnitude**.

Two live smoke runs, `--corpus-size 1`:

| Attempt | Model | Wall-clock | Outcome |
|---|---|---|---|
| #1 | Gemma 4 26B A4B | 28 min | `FunctionTimeoutError` at 600s budget (first smoke); cache lost (no periodic commit) |
| #2 | Gemma 4 26B A4B | hit 30 min | `FunctionTimeoutError` at 1800s budget after bump; cache lost again, possibly due to second bug |

During triage, **five real bugs** were patched into `bench/modal/sweep_app.py`
(all currently uncommitted — see §"Working tree state"):

1. `run_longmemeval_warmup_point` timeout 600s → 1800s (not enough).
2. `run_batchsize_point` had **zero** `volume.commit()` calls on any path —
   sibling bug to `run_baseline_point`'s 9.5 fix, silently broken.
3. `run_longmemeval_warmup` orchestrator self-seeds the corpus symlink with
   clear error when the Volume is missing `longmemeval_s_cleaned.json`
   (was a `FileNotFoundError` cascade on first smoke).
4. `subprocess.run(capture_output=True)` buffers stderr until exit; swapped to
   `Popen(stderr=sys.stdout)` so Modal's live log shows checkpoint progress.
5. Added background `threading.Event` + 60s-tick `volume.commit()` loop so
   SIGKILL loses ≤1 min of cache writes instead of everything.

All five bugs are valid findings regardless of direction; they should **not** be
thrown out. They ship together when Task 6 lands, whichever direction wins.

Plus one CLI improvement, also uncommitted:

6. `--extractor-model` flag plumbed through `main()` →
   `run_longmemeval_warmup` → `run_longmemeval_warmup_point` and
   `run_baselines` → `run_baseline_point`. Cache is keyed on the model string
   via `extractionCache._cacheKey`, so model changes *partition* the cache
   rather than corrupting it. Not plumbed through `run_point` /
   `run_batchsize_point` (not needed for Task 6).

---

## The real constraint

STARmem's extraction is **O(turns) per item** because `seedConversation` walks
turn-by-turn, triggering `maybeConsolidate` every `BATCH_SIZE=10` turns.

| Corpus | Turns/item (typical) | Extraction calls/item | P99 item calls |
|---|---|---|---|
| LoCoMo-10 | ~300 | ~30 | ~50 |
| LongMemEval-S (post-Decision-8 flatten) | **400–800** | **~50–150** | **~200+** |

Combined with Gemma 4 26B A4B's observed ~10–20s/call (2500 tok in, 1000 tok
out, much bigger than LoCoMo's short batches), P99 items take 30+ minutes each.
Model swap to GPT-OSS-20B (~170 tok/s vs ~40) helps ~4× but doesn't change the
shape.

**This is the disease. Everything else is a symptom.**

`EXTRACT_MAX_TOKENS=2048` is STARmem's current configured ceiling — per-call
cost is bounded but call count per item isn't.

---

## Four directions

### (1) Adapt the benchmark to STARmem's shape — *shrink LongMemEval*

- **1a. Sample 50 items stratified across 6 task types.** ~10× faster.
  Conflict: Hindsight memory "Eva prefers to use the full benchmark (5 task
  types) for LongMemEval to obtain the ST-mismatch signal for free." Sampling
  weakens per-task-type MRR error bars but preserves the hypothesis check.
- **1b. Truncate each item's haystack** to `answer_session_ids` + N neighbor
  sessions. Preserves needle-in-haystack semantics, shrinks haystack to ~5–10
  sessions per item. Defensible but no longer pure LongMemEval-S — a variant.

### (2) Adapt STARmem to LongMemEval's shape — *fix the SUT*

- **2a. Per-corpus `BATCH_SIZE` override.** Crank to ~50 for LongMemEval only.
  Same total work, ~5× fewer HTTP round trips. Cheapest real fix. Risk:
  extraction quality regression; invalidates Phase 11's BATCH_SIZE tuning for
  this corpus.
- **2b. Intra-item parallelism.** Split each item's turn stream into K chunks,
  extract in parallel. Requires `seedConversation` internal surgery (~80–150
  LOC) — lock semantics around consolidation, ordering guarantees, state
  merge. K=8 → ~8× per-item speedup. **Eva's lean.** This is the "right fix
  over cheap fix" answer: makes STARmem actually capable at this workload
  shape, not smaller benchmarks.

### (3) Accept and move on — *ship something*

- **3a. Rule-based extraction for LongMemEval only.** Instant, free,
  deterministic. Confounds apples-to-apples with LoCoMo's live-LLM extraction.
  Reports "we tested retrieval quality on the same extractor flavor as LoCoMo"
  becomes "we tested retrieval on rule-based extraction for this corpus."
  Honest reinterpretation; weaker paper.
- **3b. Accept 2–7h overnight run with GPT-OSS-20B.** Eva dislikes sleeping
  through benchmarks. Likely out.

### (4) Revisit Decision 8 — *un-flatten*

- **4a. Keep session structure.** Tests STARmem on actual multi-session
  haystacks. STARmem currently has no cross-session retrieval semantics
  (explicitly out of scope per Phase 2) — would require SUT changes first.
  This is a v2.1 conversation, not Phase 12. But: if (2b) succeeds and gives
  us fast extraction, this is suddenly affordable enough to ask honestly.

---

## Hanami's read

Eva's lean on **(2b)** is the right one given her standing preference for the
"right fix" over scope-shrinking workarounds. The benchmark arithmetic says:

- **Before (2b):** 500 × 100 × 4s = 55h serial / ~2h on 32 containers, P99
  items still blow per-container timeouts.
- **After (2b) with K=8:** 500 × 12.5 × 4s = ~7h serial / ~15 min on 32
  containers, P99 items fit comfortably under 600s individual-container
  budget.

The critical-path risk on (2b) is **correctness**, not wall-clock: STARmem's
`withWriteLock` exists because consolidation has ordering semantics. Sharding
a single item's turn stream across K parallel extractors means:

- K independent extractor calls produce K independent fact batches.
- Merge strategy: concatenate? deduplicate? some (partial-order) resolution?
- Interaction with `maybeConsolidate`'s batch-size trigger: does each shard
  fire its own consolidation, or does the orchestrator collect all shards
  before one big consolidation?

Any of these choices changes observable behavior. The honest move is: sketch
the parallelism surface before committing. Not a blocker — a design-first
task.

**Time budget:** Eva says "racing against Azure." Translation: whatever
direction we pick, the first move is to stabilize (commit the 6 bugs above)
so a fresh chat isn't blocked on mystery diffs.

---

## Working tree state (2026-04-23 ~18:15)

Uncommitted, on `main`:

```
 M bench/modal/sweep_app.py         # ~200 lines net added across 6 fixes
?? bench/harness/_modal-warmup-point.js   # 75 lines, new file
```

Verified green:
- `python3 -m py_compile bench/modal/sweep_app.py` clean
- `node --check bench/harness/_modal-warmup-point.js` clean
- `cd bench/modal && python3 -m pytest -q` → 13 passed

**Suggested first-move for fresh chat:** commit the 6 fixes as a single
coherent commit titled something like:

```
feat(bench): warmup infrastructure for LongMemEval-S (Phase 12 Task 6)

Six bundled fixes landing together so downstream dispatches work at all:

1. run_longmemeval_warmup_point + run_longmemeval_warmup functions +
   bench/harness/_modal-warmup-point.js orchestration.
2. run_batchsize_point: add missing volume.commit() on both success and
   error paths (sibling bug to run_baseline_point's 9.5 fix).
3. Orchestrator self-heals: preflight checks corpus file on Volume with
   clear error pointing at `modal volume put` instructions (16MB API
   commit limit means in-container seed doesn't work).
4. Live stderr streaming via Popen(stderr=sys.stdout) so Modal's log
   shows checkpoint progress instead of buffering until exit.
5. Background threading.Event + 60s volume.commit() tick so SIGKILL
   loses ≤1 min of cache writes, not everything. Matches pattern
   flagged as pending in line 1561 comment.
6. --extractor-model CLI override plumbed through warmup + baselines
   paths. Cache is keyed on model string; partitions cleanly.

Does NOT resolve the underlying wall-clock problem — see
docs/plans/phase-12-task-6-extraction-cost-decision.md.
```

Then tackle the (2b) decision with a clear head.

---

## What Task 6 explicitly still needs after whichever direction lands

- [ ] LongMemEval-S 4-retriever baselines dispatch (post-warmup).
- [ ] `docs/bench/baselines/2026-04-XX-longmemeval-s-live.md` synthesis report
      with byTaskType table.
- [ ] `baseline.json` `perCorpus.longmemevalS` block (LoCoMo untouched at
      top-level).
- [ ] Validator runs unchanged. Full suite regression green.
- [ ] Commit + retro narrative on ST-mismatch hypothesis signal.

Plus, whichever direction we pick, a follow-up retro datapoint:

- Plan arithmetic was off by 100× on wall-clock. The pattern:
  "LoCoMo-calibrated cost model applied to non-LoCoMo corpus without
  re-derivation." Candidate for a `plan-preflight-audit` skill patch
  alongside the existing "Sub-phase substrate drift" entry.
