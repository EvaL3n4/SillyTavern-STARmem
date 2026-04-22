# Sub-phase 9.4.6 Retro — Honest Metrics

**Status:** Complete.
**Commits:**
- `9064b98` docs(plans): sub-phase 9.4.6 honest metrics plan
- `e1080a5` docs(plans): amend 9.4.6 — insert Task 2 for LoCoMo evidence-loader fix
- `42723a8` docs(bench): vacuous-metrics audit — scope the 9.4.6 fix
- `c382ec2` fix(bench): LoCoMo evidence-key mapping supports D<day>:<turn> format (Task 2)
- `f1e04e4` feat(bench): pass provenance.sourceMessages through runner projection (Task 3)
- `0b5e823` feat(bench): evidence-turn gold matcher + NaN unscorable semantics (Task 4)
- `f421a6d` docs(bench): honest-metrics sweeps + baselines + measured baseline.json (Tasks 5+6)

**Duration:** ~4 hours end-to-end (planning + 8 commits + 2h 15m of sweep CPU)

---

## What happened

Sub-phase 9.5 Task 5 produced a full-LoCoMo τ sweep where every one of 48 points on 10 conversations / 1986 QA items returned `recallAt5=1.0000 / precisionAt3=0.0000 / mrr=0.0000`. Under correct IR semantics this is impossible — recall=1.0 requires at least one hit, which would give precision>0 and MRR≥1/k.

Investigation uncovered two compounding bugs, plus a third discovered during execution:

1. **`matchGold` vacuous-match** (`bench/metrics/retrieval.js:70` pre-9.4.6). Text-Jaccard with threshold 0.5 between LLM-synthesized fact entries and raw gold turn text. Token overlap for rephrased third-person facts vs dialogue sits at 0.1–0.3 — nowhere near 0.5 — so `matchedIds` was empty on every query.

2. **`recallAtK` silent-default** (`recallAtK:132` pre-9.4.6). Returned `1.0` when `matchedIds.size === 0`, codified by `tests/unit/bench/metrics/retrieval.test.js:124`. The empty-set vacuous-true antipattern turned every zero-match into perfect-recall.

3. **LoCoMo evidence-loader mismatch** (`bench/loaders/locomo.js:150` pre-9.4.6, discovered by Task 1 audit). `parseEvidence()` regex matched `S<session>:T<index>` but actual LoCoMo v10 evidence uses `D<day>:<turn>` format. `evidenceTurns` was `[]` on all 1986 QA items. Would have rendered the 9.4.6 evidence-turn matcher just as useless as the old matcher had we not caught it in preflight.

All three existed before Phase 9 Task 8 shipped. Every Phase 9 sweep artifact, the baseline comparison, the original `baseline.json`, and Phase 9's retro's "flat surface" finding are downstream of the same pair of metrics bugs combined with the latent loader bug.

## Shadow over Phase 9 findings

Artifacts that reported vacuous numbers:
- `docs/bench/sweeps/2026-04-21-tau-rulebased-prefix.md` (renamed from 2026-04-21-tau.md during 9.5 Task 5 setup)
- `docs/bench/sweeps/2026-04-21-tau-VACUOUS-pre-9-4-6.md` (renamed from 9.5 Task 5's output after evidence of vacuousness)
- `docs/bench/sweeps/2026-04-21-graph.md`
- `docs/bench/sweeps/2026-04-21-consolidation.md`
- `docs/bench/sweeps/2026-04-21-bm25.md`
- `docs/bench/baseline.json` (pre-9.4.6 "deferred" state — honest in status, but the sweep data it was deferring against was itself vacuous)
- `docs/plans/phase-9-retro.md` — "flat surface / specDefaults hold" narrative is now moot. The surfaces were flat because the matcher was broken, not because the knobs didn't matter.

Honest replacements (committed 2026-04-22):
- `docs/bench/sweeps/2026-04-22-tau.md`
- `docs/bench/sweeps/2026-04-22-graph.md`
- `docs/bench/sweeps/2026-04-22-consolidation.md`
- `docs/bench/sweeps/2026-04-22-bm25.md`
- `docs/bench/baselines/2026-04-22-comparison.md`
- `docs/bench/baseline.json` (status: measured, with FAIL flags on both structural invariants)

Old files preserved in-tree — they remain authoritative for historical audit of Phase 9's reasoning, just not for current tuning.

## Decisions held

1. **Matcher strategy** — evidenceTurns intersection. **Held.**
2. **Empty-match semantics** — NaN. **Held.**
3. **Aggregation** — nanmean with `n_scored`/`n_skipped`. **Held.**
4. **Runner plumbing** — `sourceMessages` passthrough. **Held.**
5. **Scope — tests** — surgical rewrite of the vacuous-case assertion. **Held.** Plus one small in-controller decision: NaN-tolerance update to `tests/integration/bench/runner.integration.test.js:103` was added mid-execution (Eva-approved inline) because the CONV_A/CONV_B synthetic fixture is too small to guarantee scorable queries. Assertion is now `Number.isNaN(p1) || (p1 >= 0 && p1 <= 1)`.
6. **Scope — callers** — transparent. **Held.** NaN propagates through sweep renderers as the literal string "NaN" via `.toFixed()`; didn't crash anything.
7. **Preserved-but-deprecated** old `matchGold` + `jaccard` + `DEFAULT_GOLD_THRESHOLD`. **Held.**
8. **Re-run scope** — all 4 sweeps + 3 baselines + ladder, warm cache. **Held.**
9. **Baseline.json regeneration** — absorbed into 9.4.6 Task 6. **Held.**
10. **Retro shape** — single retro, this file, includes shadow ack. **Held.**

## Decisions revised mid-flight

- **Plan amendment `e1080a5` inserted Task 2** (LoCoMo evidence-loader fix) between the audit and the runner-plumbing task. Task 1's grep surfaced that `parseEvidence()` returned `[]` on all 1986 QAs — fixing the matcher alone would have produced `n_skipped === 1986` on every sweep point. Amendment added a new task rather than creating a separate 9.4.7 sub-phase because the fix was a one-function change and the matcher's tests needed a working loader anyway (per the plan-drift pragmatism call recorded in Eva's conversation log for this session).
- **Task 5 parallelization** — per-plan, the four sweeps ran serially via `/tmp/run-9-4-6-sweeps.sh`. Mid-run, after the τ sweep took ~62 min and graph was trending toward similar, we observed the load-avg-1 picture on a 4-core box and parallelized the remaining three sweeps across free cores. Consolidation, bm25, and graph all running concurrently stayed healthy (load 2.44, memory untouched). The wrapper script continued redundantly re-running each sweep afterward; harmless (same cache, same seeds, identical output). Net savings: ~45 min, final wall clock 08:28 → 10:44.

## What worked

- **Task 1 audit was load-bearing.** The enumeration surfaced not just the callers and tests we expected, but the third bug (loader regex) that would have silently degraded the fix. Five minutes of grep prevented an otherwise-catastrophic oversight.
- **Evidence-turn intersection** is a cleaner matcher than text-Jaccard in every dimension. Deterministic, zero thresholds, unit-testable with exact set membership assertions, survives extractor rephrasing. Should have been the spec from day one.
- **NaN + nanmean** surfaced the skip rate (29% on full LoCoMo) as an explicit signal in every sweep report. No more silent zero-match queries pretending to be perfect-recall.
- **Warm extraction cache held through** — 1164 entries / 4.6 MB from the 9.5 Task 5 overnight run stayed valid under 9.4.6's changes (we didn't touch extraction or consolidation; only matching and plumbing). Zero live LLM traffic during Task 5 re-runs.
- **`recallAtK(empty) === 1.0` is now explicitly forbidden** by `tests/unit/bench/metrics/retrieval.test.js:line_TBD` — the test that codified the vacuous behavior has been inverted to enforce the correct behavior. This class of regression can't silently return.
- **Retro framing held.** When the baseline comparison exposed the ladder underperforming bm25only by 6× MRR (and random by 2.7×), we resisted expanding 9.4.6's scope. The fix-the-measurement sub-phase produced the measurement; the fix-the-retrieval sub-phase is a separate concern.

## What surprised us

- **The vacuous bug had three root causes, not one.** After finding the `recallAtK` default and fixing the matcher, the Task 1 audit turning up the loader regex miss was a genuine "oh no" moment. Each bug individually would have made the bench useless; the combination produced the specific `recall=1.0, precision=0, mrr=0` shape that fooled Phase 9's narrative.
- **LoCoMo evidenceTurns coverage jumped from 0% to 99.5% after the loader fix.** Average of 1.42 evidence turns per QA. Before 9.4.6, no QA in the corpus was scorable.
- **Ladder retrieval is catastrophically broken on LoCoMo** — the bm25only and random baselines both beat it by significant margins on MRR and recall@5:

  | Retriever | recall@5 | MRR | recall@10 |
  |-----------|---------|------|-----------|
  | ladder    | 0.0056  | 0.1118 | 0.6074 |
  | bm25only  | 0.7932  | 0.6909 | 1.0000 |
  | recency   | 0.5692  | 0.2703 | 1.0000 |
  | random    | 0.5040  | 0.3028 | 1.0000 |

  Same content bm25only retrieves at MRR 0.69 ends up at MRR 0.11 through the ladder. The ladder's recall@10 is 0.6074, meaning the gold entry IS inside the ladder's retrieval window — it's just ranked poorly inside it. The scorer chain (Tier 2 + Tier 3 graph) is actively demoting correct results.

- **Tier 3 contributes 0.0001 MRR lift over Tier-2-only baseline** at its best elbow. Graph sweep's structural-bug check fires on all 5 rounds (lift < 0.05 threshold). The graph tier Phase 4–5 built isn't earning its keep on this corpus.

- **Consolidation dedup is silent on retrieval quality.** DEDUP_JACCARD_THRESHOLD sweep showed `updateRate` varying 4.4% → 0.7% across thresholds (the knob is clearly functional), but `recall@5` and `MRR` were constant to 4 decimals. Dedup affects storage, not retrieval — at least on this corpus under the current ladder.

- **Parallelizing the remaining sweeps was the right call.** Bench wasn't designed for concurrency, but per-sweep isolation (separate node processes, separate output files, fresh backend resets) held up fine. Backup `/tmp/starmem-9-4-6-sweep-backup-101410/` was precautionary; not needed.

## Notes for sub-phase 9.5 Tasks 6–10

- Sub-phase 9.5's original Tasks 5–10 are **superseded by 9.4.6 Task 5**. The warm cache from 9.5 Task 4 was reused; no live LLM traffic needed. 9.5's Task 11 (baseline.json) is done (9.4.6 Task 6).
- **9.5 Task 10 remains open** — new sweeps for `TIER3_MAX_HOPS` and `EXPLICIT_RELATION_WEIGHT`. Given the graph-tier structural-bug flag from 9.4.6, there's little point running these sweeps until the underlying ladder issue is diagnosed. Defer to Phase 11 context.
- The 9.5 plan can be closed with its own retro pointing at this one.

## Notes for sub-phase 9.4.7 or Phase 11 (ladder structural review)

- **Starting point:** bm25only reaches MRR 0.6909 on the same state bundle where ladder reaches 0.1118. The data is findable; the scorer chain is the problem.
- **Observation:** ladder recall@10 = 0.6074 means 61% of scorable QAs have the gold entry somewhere in the top-10 — but only 0.56% are in the top-5. Score distribution is "right entry is in the candidate set but ranks dead last." Suggests the scorer's top-scoring candidates are systematically wrong, not that retrieval is missing candidates.
- **Candidate hypotheses** (for Phase 11 investigation, not prescriptive):
  1. Tier-2 BM25 score is being overwritten or transformed by the graph walk in a way that inverts the ranking.
  2. The scorer chain combines signals (tier, recency, graph confidence) in a way that over-weights non-BM25 signals on short-tail content.
  3. Tag/subject boosts on the ladder's BM25 aren't firing the same way bm25only's are (post-9.4.6 bm25only uses the same BM25 implementation; verified in `bench/baselines/bm25only.js`).
- **First diagnostic move** would be a small instrumented run: same state, same query set, log per-tier scores on both ladder and bm25only, diff the top-10 rank order for 10–20 queries to identify where the inversion happens.
- **Gating for sub-phase 9.4.7:** if it takes more than a day of investigation, it's a Phase 11 problem. If it's "one file, one scorer, one stage combining signals wrong," it's a 9.4.7 candidate.

## Notes for the skill library

- **Confirmed: the `writing-plans` "Insert an N.M.5 Sub-Phase" pattern works under pressure.** 9.4.5 (determinism) and 9.4.6 (honest metrics) both followed the same shape: smoke surfaces a pre-existing blocker, sub-phase N.M.X slots between phases, retro cites the motivating finding, scope stays surgical. Field-validated twice now; two is enough to count.
- **The vacuous-metric antipattern** — `return 1.0 on empty matchedIds` — is worth adding as a skill or pitfall doc somewhere. Same shape as SQL `NULL == NULL` returning true vs NULL: the safe default is NaN/NULL, not a neutral value. Candidate for a new `benchmark-hygiene` or `ir-metrics-pitfalls` skill if this becomes a recurring class of bug. (Not saving now; one instance isn't yet a pattern.)
- **NaN propagation through Markdown renderers** is interesting — `.toFixed(4)` on NaN yields the literal string `"NaN"`, which is legible in Markdown tables and doesn't crash. This was a saved failure mode we got for free from JavaScript's semantics; worth remembering that strict-null-safe numeric chains often need less ceremony than TypeScript strictNullChecks would suggest.

## Metrics

- **Plan length:** 1417 lines (target was 700; overshot due to Task 4's full verbatim rewrite and Task 2's amendment)
- **Duration:** ~4 hours end-to-end (30 min planning, 10 min for audit + amendment, ~30 min for the first 3 tasks, ~1.5h for Task 4 + spot patches, 2h 15m of sweep CPU, ~30 min for baseline.json + retro)
- **Tests added:** 33 (metrics rewrite) + 2 (loader coverage) + 1 (runner passthrough) = **36 new tests**
- **Tests changed/removed:** 1 vacuous-case assertion inverted (`recallAtK(Set(), ranked, k).toBe(1.0)` → `expect(Number.isNaN(…)).toBe(true)`), 1 runner integration test updated for NaN tolerance, 1 baseline-json test flipped deferred → measured
- **Suite total after:** 74 suites / 809 tests green (from 800 at 9.4.5 close — net +9)
- **Files touched:**
  - 3 source modified: `bench/loaders/locomo.js`, `bench/runner.js`, `bench/metrics/retrieval.js`
  - 1 source modified via barrel: `bench/metrics/index.js` (added `matchGoldByEvidence` re-export)
  - 4 tests modified: `tests/unit/bench/loaders/locomo.test.js` (+2 tests), `tests/integration/bench/runner.integration.test.js` (+1 test, +1 updated), `tests/unit/bench/metrics/retrieval.test.js` (full rewrite, 33 tests), `tests/unit/bench/sweeps/driver.test.js` (fake MetricsResult carries n_scored/n_skipped), `tests/integration/bench/baseline-json.test.js` (status assertion flipped)
  - 5 new artifacts: 4 sweep reports + 1 baseline comparison
  - `docs/bench/baseline.json` regenerated (deferred → measured)
  - `docs/plans/phase-9-4-6-honest-metrics.md` (the plan)
  - `docs/bench/audits/2026-04-22-vacuous-metrics-audit.md` (the audit)
  - `docs/plans/phase-9-4-6-retro.md` (this file)
- **Lint + typecheck:** clean throughout.

## Commit graph

```
(pending) docs(plans): sub-phase 9.4.6 retro
f421a6d   docs(bench): 9.4.6 honest-metrics sweeps + baselines + measured baseline.json (Tasks 5+6)
0b5e823   feat(bench): evidence-turn gold matcher + NaN unscorable semantics (9.4.6 Task 4)
f1e04e4   feat(bench): pass provenance.sourceMessages through runner projection (9.4.6 Task 3)
c382ec2   fix(bench): LoCoMo evidence-key mapping supports D<day>:<turn> format (9.4.6 Task 2)
42723a8   docs(bench): vacuous-metrics audit — scope the 9.4.6 fix
e1080a5   docs(plans): amend 9.4.6 — insert Task 2 for LoCoMo evidence-loader fix
9064b98   docs(plans): sub-phase 9.4.6 honest metrics plan
a4f164e   docs(plans): sub-phase 9.4.5 retro     ← 9.4.5 tip
```

---

**9.4.6 closes.** STARmem's benchmark bench now measures retrieval quality honestly. The honest measurements reveal a broken ladder — which is exactly what a good bench is supposed to do. Benchmarking-as-TDD, one level up: the bench is a unit test for the system under test, and our system just failed a test it previously appeared to pass. That's progress.

Next open work: **9.5 Task 10** (TIER3 new-knob sweeps, deferred pending ladder diagnosis) or a **sub-phase 9.4.7 / Phase 11** for the ladder structural review.
