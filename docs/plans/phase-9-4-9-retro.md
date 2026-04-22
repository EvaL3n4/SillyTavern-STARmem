# Sub-phase 9.4.9 Retro — Graph + Consolidation Sweep Refresh

**Status:** Complete — both sweeps ran on the post-9.4.8 retrieval surface; zero constant amendments landed; Branch C fired for consolidation; coverage-bias trap gated three graph winners.
**Commits:** 10 (`7eab8ab` plan → `09049f5` baseline.json refresh).
**Duration:** One working session (~3 hours controller + subagent + Modal wall-clock).

---

## What happened

9.4.8 amended `TIER2_TAU_GAP` to 10 (Tier 3 becomes the hot path) and reversed 9.4.6's "graph adds nothing" finding (Tier 3 now contributes +0.0794 MRR). 9.4.9's deal was the two deferred sweeps against that new surface: a 6-round graph coordinate descent, and a consolidation sweep on `DEDUP_JACCARD_THRESHOLD` + `BATCH_SIZE`. Both got lifted into the 9.4.8 Modal substrate without infrastructure changes — `SWEEP_CONFIGS["graph"]` and `SWEEP_CONFIGS["consolidation"]` entries, per-round renderers in Python, aggStats plumbing extended through `run_point` → `_modal-point.js`.

Task 1 unblocked the sweep: `TIER3_SEEDS_K` and `BATCH_SIZE` weren't in `_SWEPT_*_KEYS`, so overrides silently no-op'd; `src/consolidation/consolidate.js:47` destructured `BATCH_SIZE` at module top (the writing-plans runtime-swappable-constants preflight trap). Rewrote to call-time reads, added `TIER3_SEEDS_K` / `BATCH_SIZE` to the swept-keys registries, added guard tests so these don't regress.

Tasks 2–6 built the Modal configs and the Python renderers (graph + consolidation, hardened amendment criteria). Tasks 7–8 ran both full sweeps on Modal against the post-9.4.8 baseline (gap=10).

The graph sweep produced two honest-but-inert rounds (`TIER3_LAMBDA_1`, `TIER3_LAMBDA_2` — identical MRR across every sampled value) and one borderline round (`TIER3_BEAM_WIDTH=3` at +0.0055 MRR, below the 0.02 threshold). Then the three graph-structure rounds — `TIER3_SEEDS_K`, `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT` — produced headline ΔMRR of +0.1151 → +0.1300 at their "winners." That's more than 5× the amendment threshold. On a naive reading, the spec would have amended three defaults in one commit.

It didn't, because `n_scored` in the table told a different story. Baseline gap=10 alone retrieves against 1277 evidence-bearing QAs (coverage ~64% of 1986). `TIER3_SEEDS_K=1` retrieved against 995 (50.1%). `EDGE_CAP_PER_ENTRY=10` retrieved 968 (48.7%). The "winners" weren't winning — they were narrowing retrieval so aggressively that the remaining evidence-bearing subset got easier, inflating MRR on what got through. Mirror image of 9.4.6's vacuous-true recall, except instead of `recallAtK` lying on empty matches, `mrr` was inflating on a shrunken evaluation set.

Commit `d9ee80c` hardened the amendment criteria mid-flight: ΔMRR ≥ 0.02 **AND** `n_scored` within 5pp of baseline coverage. All three graph-structure winners failed the coverage clause and were marked `HOLD (subset-selection bias)`. The renderer stamps ⚠️ on each offending row and prints an explicit coverage-warning block per round.

The consolidation sweep was shorter. `BATCH_SIZE` went first — the synthetic smoke at commit `b4ec654` took a 600s Modal function timeout. Diagnosis: cache key is `sha256(model + messages + maxTokens)`, and changing `BATCH_SIZE` changes batch composition, so every cache lookup missed, every miss fell through to live LLM, every live-LLM call hit the 600s function ceiling. Commit `53e57db` dropped `BATCH_SIZE` from 9.4.9 scope and filed it for 9.5 where live extraction regenerates the cache on demand. `DEDUP_JACCARD_THRESHOLD` swept cleanly — 5 points, single wave, ~90s — and fired Branch C: MRR range 0.0045 across values `[0.5, 0.6, 0.7, 0.8, 0.9]`, below the 0.005 flatness threshold. `updateRate` sat at 0.007–0.045 against a band target of `[0.2, 0.4]`; rule-based extractor doesn't produce enough near-duplicates to stress dedup regardless of threshold. Exactly the 9.4.6 finding, pre-registered, reproduced.

## Decisions held

1. **Graph sweep as single Modal entry doing coordinate descent internally.** Held. One `modal run --sweep-name graph` invocation runs all 6 rounds sequentially, each winner feeds the next round's `baseOverrides`.
2. **`TIER3_SEEDS_K` IN the graph sweep.** Held. Pinned at 3 up through 9.4.8; with gap=10 making Tier 3 the hot path, it materially affects retrieval. (And it turned out to be one of the three coverage-bias knobs — confirming the decision to include it was right.)
3. **Consolidation sweep: DEDUP_JACCARD_THRESHOLD only.** **Revised mid-flight (2026-04-22, commit `53e57db`).** `BATCH_SIZE` breaks the warm-extraction cache contract. Filed as 9.5 candidate.
4. **Pre-register Branch C for consolidation.** Held, and **fired.** `DEDUP_JACCARD_THRESHOLD` MRR range 0.0045 < 0.005 flatness threshold. No amendment; deferred to 9.5.
5. **Amend constants + baseline.json if any round clears ΔMRR ≥ 0.02.** **Held and hardened.** Commit `d9ee80c` added the coverage clause (`n_scored` within 5pp of baseline) after `TIER3_SEEDS_K=1`'s +0.1151 headline came back with coverage=50%. The intent of decision 5 held; the mechanism tightened.
6. **No Phase 11 work in 9.4.9.** Held. Tier 2 demolition stays Phase 11. 9.4.9 ran every graph point with `TIER2_TAU_GAP=10` baseOverride to measure against the current production ladder shape.
7. **Scope-locked preflight fixes.** Held. Task 1 landed all four items (`TIER3_SEEDS_K` / `BATCH_SIZE` into `_SWEPT_*_KEYS`, `consolidate.js` destructure rewrite, guard tests).
8. **Modal persistence already fixed, no infra work.** Held. Every sweep ran with `--local-out docs/bench/runs`; no reconstruction needed.
9. **Seed rounds with `TIER2_TAU_GAP=10`.** Held. Every graph point ran with gap=10 baseOverride. Consolidation sweep didn't need it (consolidation runs offline before retrieval), but the run config still carried it for belt-and-suspenders.
10. **Retro at `docs/plans/phase-9-4-9-retro.md`.** Held — you're reading it.

## Decisions revised mid-flight

- **Decision 3** (consolidation sweep scope). `BATCH_SIZE` dropped after the synthetic smoke at `b4ec654` took a `FunctionTimeoutError`. Plan header was updated in the same commit (`53e57db`) so the sweep and the plan stay consistent for provenance. Filed as 9.5 candidate where live extraction regenerates cache on demand.
- **Decision 5** (amendment criteria). Coverage clause added in `d9ee80c` after the full graph sweep surfaced three ΔMRR ≥ +0.11 "winners" with ~48–50% coverage. Without this hardening the retro would have shipped three bogus amendments in one sub-phase. Criteria is now: ΔMRR ≥ 0.02 **AND** `n_scored` within 5pp of baseline coverage. The renderer enforces it — `HOLD (subset-selection bias)` is a first-class verdict alongside `AMEND` / `hold` / `flat`.

## Sweep findings summary

### Graph sweep (6 rounds, coordinate descent, TIER2_TAU_GAP=10 baseOverride)

| Round | Knob | Values | Winner | Winner MRR | ΔMRR vs gap=10 | Coverage (n_scored) | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `TIER3_LAMBDA_1` | 0.5 – 1.5 (5 pts) | 0.5 | 0.8057 | -0.0020 | 1277 (baseline) | hold (inert) |
| 2 | `TIER3_LAMBDA_2` | 0.1 – 0.5 (5 pts) | 0.1 | 0.8057 | -0.0020 | 1277 (baseline) | hold (inert) |
| 3 | `TIER3_BEAM_WIDTH` | 3 – 10 (4 pts) | 3 | 0.8132 | +0.0055 | 1263 (baseline) | hold (below threshold) |
| 4 | `TIER3_SEEDS_K` | 1 – 7 (4 pts) | 1 | 0.9228 | +0.1151 | ⚠️ 995 (50.1%) | **HOLD (subset-selection bias)** |
| 5 | `EDGE_CAP_PER_ENTRY` | 10 – 50 (5 pts) | 10 | 0.9377 | +0.1300 | ⚠️ 968 (48.7%) | **HOLD (subset-selection bias)** |
| 6 | `COOCCURRENCE_WEIGHT` | 0.25 – 1.0 (4 pts) | 0.25 | 0.9377 | +0.1300 | ⚠️ 968 (48.7%) | **HOLD (subset-selection bias, inherited coverage warning)** |

Round 6 is inert on MRR (identical 0.9377 across all 4 values) — the composite coverage warning comes from the round's pinned `TIER3_SEEDS_K=1` + `EDGE_CAP_PER_ENTRY=10` baseOverrides, not the `COOCCURRENCE_WEIGHT` knob itself.

### Consolidation sweep (1 round)

| Round | Knob | Values | MRR range | updateRate range | Verdict |
|---|---|---|---|---|---|
| 1 | `DEDUP_JACCARD_THRESHOLD` | 0.5 – 0.9 (5 pts) | 0.0045 | 0.007 – 0.045 | **BRANCH C (flat, deferred to 9.5)** |

`BATCH_SIZE` round dropped mid-flight (cache-key trap, `53e57db`), filed as 9.5.

## Constants amendments landed

**Zero.**

Every graph round either fell below the 0.02 threshold (LAMBDA_1/LAMBDA_2/BEAM_WIDTH) or failed the coverage clause (SEEDS_K/EDGE_CAP/COOCCURRENCE). Consolidation fired Branch C. `baseline.json` got a refresh documenting all 10 `tuned.*` entries with measured values, sources, and the coverage-bias narrative (commit `09049f5`); `src/core/constants.js` untouched post-9.4.8.

This is the right outcome. The alternative reading — "we amended three graph constants and shipped +0.13 MRR" — would have been benchmark fraud in the 9.4.6 vacuous-true sense, just on a different metric. Hardening the amendment criteria before committing is what the pre-registered Branch C pattern from 9.4.6 was designed to enable.

## What worked

- **9.4.8 substrate absorbed both new sweeps without infra changes.** `SWEEP_CONFIGS` entries + new renderers only. The substrate's design goal (each sweep = one entry + one renderer) paid off exactly as 9.4.8's retro predicted.
- **Preflight source audit caught the `consolidate.js:47` destructure trap before any sweep ran.** The runtime-swappable-constants skill pattern (`grep -rnE "^const \\{[^}]*\\} = (RETRIEVAL|CONSOLIDATION)\\b"`) surfaced it on first pass; Task 1 rewrote to call-time reads and added guard-test coverage.
- **Coverage warnings in the renderer, not in post-hoc analysis.** `render_graph_report` stamps ⚠️ on any `n_scored` outside baseline ±5pp and prints a per-round warning block. Made the amendment verdict unambiguous at read time, not a judgment call during retro writing.
- **Branch C pre-registration worked exactly as designed.** The 9.4.6 consolidation retro predicted rule-based extractor under-stresses dedup; 9.4.9 reproduced the flatness and deferred cleanly without me (or a subagent) chasing a signal that isn't there.
- **Manual Modal invocation protocol inherited cleanly.** Three Modal handoffs across the sub-phase, no protocol drift, no subagent tried to invoke `modal` directly. The "subagent STOP → Eva runs → controller passes output" contract is self-enforcing once the subagents know the pattern.

## What surprised us

- **Coverage-bias trap (mirror of 9.4.6's vacuous-true).** Three separate graph knobs produced headline ΔMRR ≥ +0.11 by narrowing retrieval, not by improving it. On inspection each winner's `n_scored` column was 12–16% below baseline. The amendment criteria as written (ΔMRR ≥ 0.02 alone) would have gated them through. The hardening was the same shape as the 9.4.6 hardening (recallAtK NaN on empty matches), caught mid-flight in the same way: renderer inspection flagged an anomaly in the table, diagnosis revealed the metric was lying, criteria got tightened before any amendment landed. The v2.1 scope note is real — **LoCoMo benchmarks need a coverage-weighted retrieval metric** before graph-structure knobs can be tuned honestly.
- **`TIER3_LAMBDA_1` and `TIER3_LAMBDA_2` are fully inert on LoCoMo.** Identical MRR to 4 decimals across every sampled value at fixed gap=10. The `exp(λ₁·edge + λ₂·bm25)` scoring rescales uniformly on LoCoMo's edge landscape — rank order is preserved regardless of the λ coefficients. That's not noise; it's structural. Either the edges are too homogeneous to discriminate, or the BM25 component dominates so thoroughly that the edge term never tips a rank. Worth revisiting on a corpus with more edge-type variance (multi-session, cross-character — 9.5+ territory).
- **`COOCCURRENCE_WEIGHT` round is pure inertness, not noise.** Identical MRR (0.9377) across `[0.25, 0.5, 0.75, 1.0]` — four decimal places flat. The coverage warning on this round is *inherited* from the pinned `TIER3_SEEDS_K=1` + `EDGE_CAP_PER_ENTRY=10` baseOverrides, not the knob itself. If the knob ever does have a signal on a different corpus, it's currently hidden behind 100% overlap on LoCoMo's co-occurrence distribution.
- **`BATCH_SIZE` cache-key trap.** The plan explicitly included `BATCH_SIZE` after "future-proofing 9.5." The synthetic smoke exposed that warm-cache-based sweeps can't touch any knob that enters the cache key. This generalizes: any swept key that's upstream of a content-addressed cache invalidates the cache for that sweep. Filed against the skill library as a generic sweep-safety rule (see skill notes below).
- **`TIER3_BEAM_WIDTH=3`'s +0.0055 is the *only* clean non-coverage-bias signal in the graph sweep.** Below threshold, but it's the single point in the six rounds where a structural knob moved MRR in the right direction without eating coverage. Flagged for re-measurement in 9.5 against live extraction.

## Metrics

- **Plan length:** 1164 lines (plan) + 189 lines (this retro) = 1353 total.
- **Commits:** 10 (`7eab8ab` → `09049f5`).
- **Duration:** ~3 hours controller + subagent; ~9 min Modal wall-clock total (8 min graph sweep + 90s consolidation); Task 1 preflight ~25 min; plan drafting prior to commit `17fe9cc` not counted.
- **Modal spend:** <$1 (graph sweep: 6 rounds × ~32 containers × ~1–2 min each = ~120 container-minutes; consolidation: 5 containers × 30s). Free tier absorbed it.
- **Modal wall-clock breakdown:**
  - Graph full sweep: ~8 min (6 sequential rounds, each a single 4–5 container wave under the 32-container cap).
  - Consolidation full sweep: ~90s (5 points, single wave).
  - `BATCH_SIZE` synthetic smoke timeout: 600s before diagnosis (counted against decision-3 revision cost).
- **Files created:** `docs/bench/sweeps/2026-04-22-graph.md`, `docs/bench/sweeps/2026-04-22-consolidation.md`, `tests/unit/core/swept-constants-overridable.test.js`, `docs/plans/phase-9-4-9-retro.md` (this file), `docs/bench/runs/2026-04-22T1*-{graph,consolidation}.{md,json}` (Modal `--local-out` mirrors, not committed to canonical sweep path).
- **Files modified:** `bench/modal/sweep_app.py` (graph sweep config + consolidation sweep config + both renderers + hardened amendment gate, cumulative +743 lines across `2caf95a`, `8af04bd`, `53e57db`, `2faac47`, `75c71be`, `d9ee80c`), `bench/sweeps/_modal-point.js` (aggStats plumbing, `b4ec654`), `src/core/constants.js` (+2 lines swept-keys), `src/consolidation/consolidate.js` (destructure rewrite, `7eab8ab`), `docs/bench/baseline.json` (+45 lines refreshed `tuned` section + knownIssues, `09049f5`), `docs/plans/phase-9-4-9-graph-consolidation-sweeps.md` (+3 lines decision-3 revision note, `53e57db`).
- **Tests:** 75 suites / 816 tests green on close (+4 tests from Task 1's new guard-test file; no suite count change).
- **Zero amendments to `src/core/constants.js` defaults** — the preflight swept-keys additions count as infrastructure, not knob amendments.

## Notes for sub-phase 9.5 (live extraction)

- **Consolidation tuning is waiting for live extraction.** 9.4.9 `DEDUP_JACCARD_THRESHOLD` sweep fired Branch C on rule-based extractor output (updateRate 0.007–0.045 vs band target [0.2, 0.4]). Once Gemma-4-26B-A4B produces realistic near-duplicates, re-run this sweep — same 5-point grid `[0.5, 0.6, 0.7, 0.8, 0.9]`, same Branch C fallback. Expectation: `updateRate` climbs into the band, and dedup pressure becomes a real tunable.
- **`BATCH_SIZE` is waiting for live extraction** for a different reason. Under rule-based + warm cache, changing `BATCH_SIZE` invalidates the cache (cache key includes batch composition). Under live extraction, cache misses regenerate on demand — expected miss rate per sweep point should be <20% once the 9.4.8 warm cache is reused as a seed. Budget: 5 points × ~30s per regen × 32 containers = ~2.5 min wall-clock. Same grid as originally planned: `[8, 16, 24, 32, 48]`.
- **Graph-structure knobs (`TIER3_SEEDS_K`, `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT`) are waiting for a coverage-weighted metric.** All three showed apparent +0.11–0.13 MRR lift by narrowing retrieval. On LoCoMo's rule-based extraction the "true" coverage baseline is fragile — live extraction may shift it materially. Two options for 9.5: (a) gate these knobs on `recall@5 × coverage` as a composite metric, or (b) re-sweep post live extraction and see if coverage becomes less sensitive to the knob. Option (a) is more honest; option (b) is cheaper. Field decision deferred.
- **`TIER3_LAMBDA_1` / `TIER3_LAMBDA_2` are structurally inert on LoCoMo and probably on any single-session corpus.** Not worth re-sweeping in 9.5 unless the live extractor changes the edge landscape (e.g. if live extraction produces more `supports` / `temporal_next` edges that give λ₁ something to boost). Candidate for removal from the sweep registry if 9.5 confirms inertness on live data.
- **`TIER3_BEAM_WIDTH=3` is the only borderline signal worth re-measuring.** +0.0055 MRR without coverage loss. If 9.5 live extraction bumps it into 0.02+ territory, amend.

## Notes for Phase 11

- **Tier 2 gating demolition candidacy (inherited from 9.4.8) confirmed.** 9.4.9 ran every graph point with `TIER2_TAU_GAP=10` baseOverride, i.e. Tier 2 gating effectively disabled. All the interesting signal (positive and coverage-negative alike) came from Tier 3. The τ_confidence / τ_gap comparison code and constants are dead weight on the current corpus. Phase 11 can drop them, simplify the ladder to always-Tier-2-as-Tier-3-seed, and retire the two constants + the τ sweep infra.
- **Scorer chain review still pending.** 9.4.7 measured multiplicative scorer dynamic range at 1.00× vs BM25's 7.06×. 9.4.9 didn't touch the scorer chain; `recency × importance × maturity_boost` is still barely affecting rank order. Phase 11 candidate.
- **LoCoMo needs a coverage-weighted retrieval metric.** The coverage-bias trap from 9.4.9 isn't specific to graph knobs — any knob that can narrow the retrieved set will inflate MRR on the narrowed subset. v2.1 scope: add `coverage` or `recall×coverage` as a first-class tracked metric in `bench/metrics/retrieval.js`. Until then, every sweep needs the `n_scored` coverage gate, enforced in the renderer.
- **Edge-type differentiation on LoCoMo is thin.** `TIER3_LAMBDA_1` / `TIER3_LAMBDA_2` inertness suggests the edge landscape on a single-session conversational corpus doesn't have enough structural variance for edge-type weighting to matter. If STARmem targets multi-session / long-horizon scenarios, the λ knobs should matter there — but verify on real data before investing.

## Commit graph

```
09049f5   docs(bench): update baseline.json with 9.4.9 findings (Task 7)
307b63c   feat(bench): 9.4.9 full-grid graph + consolidation sweep artifacts (Task 7)
d9ee80c   fix(bench): gate amendment summary on coverage, matching hardened criteria
75c71be   feat(bench): full render_consolidation_report + hardened amendment criteria (9.4.9 Task 6)
2faac47   feat(bench): full render_graph_report with coverage-warning (9.4.9 Task 5)
53e57db   fix(bench): drop BATCH_SIZE from 9.4.9 consolidation sweep — cache-key trap
b4ec654   feat(bench): pass consolidationStats aggregate through _modal-point (9.4.9 Task 4)
8af04bd   feat(bench): Modal consolidation sweep — dedup + batch_size rounds (9.4.9 Task 3)
2caf95a   feat(bench): Modal graph sweep with 6-round coordinate descent (9.4.9 Task 2)
7eab8ab   feat(core): unlock TIER3_SEEDS_K + BATCH_SIZE for sweep overrides (9.4.9 Task 1)
17fe9cc   docs(plans): sub-phase 9.4.9 graph + consolidation sweep refresh           ← 9.4.9 plan
36da97a   feat(retrieval): amend TIER2_TAU_GAP default 0.5 → 10 per 9.4.8 sweep     ← 9.4.8 amendment
d403fcf   docs(plans): sub-phase 9.4.8 retro                                         ← 9.4.8 retro
```

## Notes for the skill library

- **Amendment criteria need a coverage clause by default.** Phase 9's amendment threshold `ΔMRR ≥ 0.02` is necessary but not sufficient. Any swept knob that can narrow retrieval (graph structure, tier gating, seed selection) can produce inflated MRR on a shrunken evaluation set. Add to the renderer template: `n_scored within ±Npp of baseline coverage`, with the coverage gate enforced as a first-class `HOLD (subset-selection bias)` verdict. 9.4.6 taught this on recall (NaN-on-empty); 9.4.9 taught it on MRR (inflated-on-subset). Generalize to any benchmark with a "coverage" analogue. Candidate addition to `writing-plans/SKILL.md` and/or the `detecting-vacuous-metrics` skill.
- **Sweep-safety rule: swept keys upstream of content-addressed caches.** If a swept constant participates in the cache key for any warm-cache-backed computation on the sweep path, that knob can't be swept against the warm cache. Every sweep point misses, every miss falls through to live compute, and the sweep budget explodes (or times out on Modal). Workaround: either (a) sweep under live-compute mode (expensive), (b) exclude the knob and document the reason, (c) key the cache on a stable substitute (expensive refactor). 9.4.9 encountered this on `BATCH_SIZE`; generalizable to any `_SWEPT_*_KEYS` entry that `sha256`-flows into a cache key elsewhere. Candidate addition to the `detecting-vacuous-metrics` skill or a new "sweep-safety-audit" skill sibling.
- **Pre-registered Branch C saved ~30 min of retro writing.** 9.4.6's consolidation retro called out "rule-based seeder may under-stress dedup; defer tuning to live extraction if we see it again." 9.4.9 reproduced and deferred cleanly because the decision was already made — no debate about whether flatness is signal or noise. Pattern worth keeping: when a sub-phase retro flags "this measurement is on the wrong substrate, re-measure when substrate changes," pre-register the re-measurement decision at the same time, not at the next retro. Covered implicitly by `writing-plans/SKILL.md` branch-pre-registration subsection; 9.4.9 field-validates it a second time.
- **`n_scored` is the silent column you should always read first.** Every retrieval benchmark table in Phase 9 has `n_scored`. It's the one that tells you whether MRR is measuring what you think. 9.4.9's graph renderer now stamps a ⚠️ on any row where `n_scored` is >5pp below baseline; 9.5+ should consider making this the leftmost column and sorting rows by coverage-stability before MRR.

---

**9.4.9 closes.** Zero constant amendments shipped; the hardened amendment criteria (ΔMRR + coverage) gated out three bogus graph-structure winners, Branch C fired cleanly on consolidation, `BATCH_SIZE` deferred to 9.5 for principled reasons. The retrieval surface from 9.4.8 (gap=10, +0.0625 MRR) remains the current production default and the v2.0 advisory baseline. baseline.json documents every swept knob with measured values, sources, and the coverage-bias narrative — future maintainers have the "why we didn't amend" context in the durable artifact, not just the retro.

Next open work: **9.5** — live extraction subphase. Swap the extractor to Gemma-4-26B-A4B on the hot path (off-hot-path for retrieval per spec §11 clarification), re-measure consolidation dedup pressure, re-sweep `DEDUP_JACCARD_THRESHOLD` + `BATCH_SIZE`, populate the 9.5 baseline.json. **Phase 11** candidate: Tier 2 gating demolition, scorer chain review, coverage-weighted retrieval metric.
