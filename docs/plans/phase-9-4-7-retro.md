# Sub-phase 9.4.7 Retro — Ladder Inversion Diagnosis

**Status:** Complete — NARROW_FIX shipped.
**Commits:** 7 (70ec03e plan → 17508e3 cleanup)
**Duration:** ~60 min end-to-end controller work (well under the 90-min day-budget).

---

## What happened

9.4.6's honest-metrics sweep revealed the retrieval ladder scoring MRR 0.1118 — 0.19 below random and 0.58 below bm25only — on the same seeded state. Recall@10 was 0.6074 while recall@5 was 0.0056, meaning gold entries sat in the candidate window but ranked dead last. The retro's gating rule was tight: a single-file/single-stage finding was 9.4.7 material, anything broader was Phase 11.

The pre-registered hypotheses (H1 recency dominance, H2 maturity compression, H3 pool mismatch) all pointed at the scorer formula `bm25 × (1 + importance/100) × recencyAt × maturityBoost`. The diagnostic showed none of them were contributing materially on LoCoMo: recencyFactor was uniform at 0.9350 across all sampled candidates (conversation turn timestamps fall in a tight band), maturityFactor was uniform at 0.85 (100% draft post-seed — no entries had been accessed enough to promote), importanceFactor ranged 1.50–1.55. The multiplier's total dynamic range was 1.00× vs BM25's 7.06× — the scorer chain was barely touching rank order.

The actual cause was an unanticipated fourth factor: the ladder's `prependWorking` prepends every working-buffer entry at `score = Infinity`, and the bench's seeder was leaving 3–8 un-drained residual turns in `state.workingBuffer` at end-of-conversation. Those residuals flooded the top-K of every retrieval, burying consolidated episodic (gold-containing) entries at rank 10+. In production this never happens — SillyTavern's idle timer fires `maybeConsolidate('idle', ...)` within 60s and drains the buffer. The bench seeder only fired the per-turn `'buffer'` reason, which skipped when buffer was below `WORKING_BUFFER_THRESHOLD = 10`.

The fix was a 13-line addition to `bench/harness/seeder.js`: a `while` loop of `maybeConsolidate(chatId, 'idle', opts)` calls after the seed for-loop, folded into `consolidationStats`. The loop is required because `consolidate()` drains at most `BATCH_SIZE = 5` entries per call — a 9-entry residual needs two iterations.

## Hypothesis results

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1 — Recency dominance | NOT SUPPORTED | recencyFactor uniform at 0.9350 across all 200 diagnostic candidates on 20 sampled queries (LoCoMo turn timestamps fall in a tight band; decay τ=30 days barely engages) |
| H2 — Maturity compression | NOT SUPPORTED | 100% of post-seed entries are draft (maturityFactor 0.85, uniform); no variation means no rank effect |
| H3 — Pool mismatch | NOT SUPPORTED | Tier 2 pool size vs bm25only pool size differed by only 9 entries on the 13-turn conversation (exactly the residual working-buffer entries), and the gold entries appeared in both pools; mismatch quantitatively negligible |
| (unregistered) — seeder residual buffer + prependWorking Infinity sentinel | SUPPORTED | 100% of tier2-resolved top-K rankings led with working-scope entries at uniform score per query (21.0945, 11.6118, etc.). Pre-fix assertion: `state.workingBuffer.length === 8` on 13-turn fixture. |

The pre-registered hypotheses all targeted the scorer chain. The actual cause was in a completely different file (`bench/harness/seeder.js`) and layer (seeding, not scoring). Good lesson: the diagnostic instrumentation was correctly built around the pre-registered hypotheses, but the data it produced ruled all three out and surfaced the real cause as a byproduct — the per-query rank-diff tables showed working-scope entries saturating top-9 in every query, which is what pointed to the prepend mechanism.

## Decision gate record

**Verdict:** NARROW_FIX (overriding the subagent's initial STRUCTURAL recommendation).

**Why the subagent was wrong:** They correctly identified the mechanism (`prependWorking` places working entries at score=Infinity) but framed it as spec §5 structural because that's where the Infinity sentinel is documented. The actual fix site was one level up — the seeder was leaving the buffer full when production would have drained it. Prepend semantics are correct per spec AND match production behavior; the bench was creating an unrealistic state.

**Why NARROW_FIX was right:** ~13-line, single-file change in bench-only code. No spec impact. No ladder changes. `maybeConsolidate('idle', ...)` already exists in `src/consolidation/triggers.js` and is the documented drain-residual mechanism. Fixing the seed matches what production already does within 60s of last turn.

See `docs/bench/audits/2026-04-22-ladder-inversion.md` for the full gate record.

## What was fixed

**File:** `bench/harness/seeder.js`

After the per-turn `maybeConsolidate('buffer', ...)` loop at lines 221-242, added a while loop that repeatedly fires `maybeConsolidate(chatId, 'idle', opts)` until the returned result indicates `skipped` (empty buffer) or `drained === 0`. Each non-skipped result's stats are folded into `consolidationStats.added / updated / drained / batches` using the existing per-turn pattern. The opts block is verbatim-duplicated from the per-turn call — same extractor path, same `now`, same profileId. Deliberately NOT refactored into a shared helper; scope was narrow.

Secondary cleanup (`17508e3`): Task 1's inline factor decomposition in `tier2-bm25.js` left two dead bindings (`const scorer = getScorer()` and an unused `intent` destructure). Removed both, added a comment noting that Tier 2 now bypasses the scorer registry — if Phase 11 reintroduces pluggable scorers, restore `getScorer()` and accept that the diagnostic `factors` breakdown will match the default scorer only.

## Metrics impact (deferred to 9.4.8)

The fix ships untested against full LoCoMo-10 in this sub-phase by design — per locked decision 1, 9.4.7 runs no sweeps. The 13-turn regression test proves the invariant holds at the integration layer (working-buffer empty post-seed, retrieve() returns episodic entries with finite scores). The full-corpus validation is 9.4.8's job.

> **Sweep refresh deferred to 9.4.8.** Expected validation:
>
> - Re-run `npm run bench:baselines -- --conversations 10` on LoCoMo-10 with warm extraction cache.
> - Verify `structuralInvariants.ladderVsRandom.measuredMrrDelta` crosses above 0.02 threshold.
> - Verify `structuralInvariants.ladderVsBm25Only.measuredMrrDelta` crosses above 0.02 threshold.
> - If thresholds are met, flip `docs/bench/baseline.json` structural invariants from FAIL → PASS.
> - If thresholds are not met, a second Phase 11 investigation is required (prepend-semantics review, likely).

## Notes for 9.4.8

9.4.8 MUST validate the following after the 9.4.7 fix:

1. **Sweep refresh:** Run full LoCoMo-10 baselines (`npm run bench:baselines -- --conversations 10`) with warm extraction cache — this will be the first validation of the 9.4.7 fix against the full corpus.
2. **Baseline.json refresh:** Update `docs/bench/baseline.json` with new measured numbers. Bm25only's relative advantage should shrink; ladder should now beat both random and recency substantially.
3. **Structural invariant check:** Confirm both `ladderVsRandom` and `ladderVsBm25Only` show `status: "PASS"` (MRR delta ≥ 0.02).
4. **Tau sweep re-run:** Run `npm run bench:sweep:tau` — 9.4.6 showed a flat 0.003 MRR range across 48 tau points ("noise-level"). Post-9.4.7, this should become a meaningful surface if tau_confidence/tau_gap actually gate anything.
5. **BM25 sweep re-run:** Run `npm run bench:sweep:bm25` to verify tag/subject boosts now influence rank order.
6. **Graph + consolidation sweeps stay deferred.** Per 9.4.6 retro and 9.4.8 MVP scope (locked decision #6), graph and consolidation sweeps are out of 9.4.8's scope. If the ladder-vs-bm25only invariant passes after 9.4.8, a later sub-phase can pick them up.
7. **If invariants still FAIL:** Document findings and open Phase 11 for the prepend-semantics review. Do not run additional sweeps.

### Flag for potential Phase 11 (Eva-raised, 2026-04-22 gate call)

`prependWorking`'s score=Infinity semantics may have production edge cases worth revisiting:

> "If a user asks about a topic from 2 days ago but has a fresh unrelated working buffer, residual working entries could still bury relevant episodic results."

Out of scope for 9.4.7 and 9.4.8. Candidate material for Phase 11 if 9.4.8's LoCoMo numbers look healthy but user-observed retrieval quality surfaces real in-chat edge cases. Options to consider there: relevance-aware working prepend (BM25-score working entries instead of using Infinity), or capping the number of working entries prepended.

## Files touched

**Source:**
- `src/retrieval/tier2-bm25.js` — Task 1 (diagnostic factor decomposition) + 17508e3 cleanup
- `bench/harness/seeder.js` — Task 3 (idle-drain loop)
- `bench/diagnose/ladder-inversion.js` — new, Task 2 diagnostic runner
- `bench/diagnose/render-audit.js` — new, Task 2 audit renderer

**Tests:**
- `tests/unit/retrieval/tier2-bm25.test.js` — +1 test (diagnostic mode), 3 pre-existing tests updated for new factor semantics
- `tests/unit/bench/harness/seeder.test.js` — +1 test (idle-drain invariant)
- `tests/integration/bench/seeder-ladder-integration.test.js` — new, Task 4 regression, tripwire-verified

**Docs:**
- `docs/plans/phase-9-4-7-ladder-diagnosis.md` — plan
- `docs/bench/audits/2026-04-22-ladder-inversion.md` — diagnostic audit + gate record
- `docs/plans/phase-9-4-7-retro.md` — this file

## Metrics

- **Plan length:** 936 lines (target was 700–1100)
- **Duration:** ~60 min end-to-end controller work (4 subagent dispatches, 2 direct controller writes)
- **Tests added:** 3 (diagnostic mode, seeder idle-drain, seeder-ladder integration)
- **Tests modified:** 3 (tier2 threshold/gap tests, reshaped to use lifecycle overrides instead of mocked scorers)
- **Suite total after:** 75 suites / 812 tests green (from 74 / 809 at 9.4.6 close — net +1 suite, +3 tests)
- **Plan bugs caught preflight:** 3 (H2 zeroing→compression; Task 3 fix-site wrong file; 9.4.8 handoff listed graph sweep which is out of 9.4.8 scope)
- **Plan bugs caught in-flight by subagents:** 1 (Task 3's single-call idle drain was insufficient because `BATCH_SIZE=5` — subagent correctly wrote the while-loop)
- **Lint + typecheck:** clean throughout.

## Commit graph

```
17508e3   chore(retrieval): clean up tier2 after diagnostic refactor (9.4.7)
8bda0fe   test(bench): end-to-end regression for ladder inversion fix (9.4.7 Task 4)
996910e   fix(bench): drain residual working buffer via idle consolidation (9.4.7 Task 3)
4b161ec   docs(bench): decision gate record for ladder inversion audit (NARROW_FIX)
9072082   feat(bench): ladder inversion diagnostic runner + audit doc (Task 2)
ffaec2a   feat(retrieval): diagnostic factor breakdown in tier2 (Task 1)
70ec03e   docs(plans): sub-phase 9.4.7 ladder inversion diagnosis plan
f5d7d2b   docs(plans): sub-phase 9.4.6 retro     ← 9.4.6 tip
```

## Notes for the skill library

- **Pre-registered hypotheses can all fail and still produce the answer.** H1/H2/H3 were reasonable but wrong — the real cause was in a layer the hypotheses didn't target (seeding, not scoring). The diagnostic's per-query rank-diff tables, which were infrastructure not tied to any specific hypothesis, were what surfaced the truth. Lesson: even when hypotheses don't pan out, the *instrumentation* built to test them may still reveal the real cause as a byproduct. Build diagnostics broader than the hypotheses when cost allows.
- **Subagent STRUCTURAL flag overrides are the controller's job.** The Task 2 subagent flagged STRUCTURAL because they saw prepend semantics as spec-defined. Controller had the context (production uses idle drain, bench was skipping it) to see the fix was one level up. Pattern: when a subagent recommends escalation, verify their cause-framing by asking "where does this behavior come from, and where does production diverge from the bench?" One of those is often a narrower fix site.
- **`BATCH_SIZE` matters for drain operations.** The plan's Step 3 fix template was a single `maybeConsolidate('idle', ...)` call. The subagent correctly noticed this would only drain `BATCH_SIZE=5` entries on a 9-entry residual and wrote the while-loop. Skill-library candidate: for any "drain until empty" fix, check whether the underlying operation is batch-capped, and loop if so. Two datapoints would turn this into a standing rule; one is a note.
- **Honor subagent stops but verify framing.** The Task 2 subagent correctly stopped at the gate and reported STRUCTURAL. That's the right protocol per `subagent-driven-development`. But the controller must still evaluate the framing — the stop is correct, the verdict may not be.

---

**9.4.7 closes.** The retrieval ladder doesn't have a scorer bug — it has a bench-seeding bug that made the ladder look broken. Same-state benchmarking reveals uncomfortable truths in both directions: 9.4.6 exposed a vacuous metric, 9.4.7 exposed a bench-state bug masquerading as a retrieval bug. Both are wins for the honest-measurement discipline from 9.4.6 — we now have two instances of "the bench caught something the code couldn't have told us."

Next open work: **9.4.8** (Modal bench substrate + full sweep refresh to validate this fix at LoCoMo-10 scale).
