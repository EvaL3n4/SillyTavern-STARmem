# Sub-phase 9.5 Retro — Live-LLM Extraction

**Plan:** [`phase-9-5-live-extraction.md`](./phase-9-5-live-extraction.md)
**Shipped:** 2026-04-23 (multi-day session 2026-04-22 → 2026-04-23) at commit `04d76f1`
**Corpus:** LoCoMo 10 conversations (1986 QA items)
**Extractor:** `google/gemma-4-26b-a4b-it` via Nano-GPT, temperature=0, warm cache from 9.4.8
**Baseline artifact:** [`docs/bench/baseline.json`](../bench/baseline.json)

---

## 1. What shipped

**Zero constant amendments.** Every swept knob under live extraction was flat, inert, or coverage-bias gated. The 9.4.8 `TIER2_TAU_GAP=10` plateau reproduces within ±0.005 MRR noise. 9.5's contribution is principled confirmation that LoCoMo's elbow surface is **corpus-structural, not extractor-dependent** — plus two new swept knobs, an EXTRACT_MAX_TOKENS observation, and five filed Phase 11 candidates.

### Artifacts produced

- **6 sweep writeups** under `docs/bench/sweeps/*-live.md`: τ (48 pts), graph (6 rounds, 27 pts), consolidation (DEDUP only, 5 pts), bm25 (16 pts), hops (2-pt preview), relw (5 pts)
- **1 baseline comparison** at `docs/bench/baselines/2026-04-23-comparison.md`: 4 retrievers, full LoCoMo live
- **baseline.json refreshed** from 9.4.8/9.4.9 values → 9.5 live-extraction values. 14 entries in `tuned/` (up from 11), new `observations/` section for EXTRACT_MAX_TOKENS
- **11 commits** across the sub-phase (`0cb964e` preflight → `04d76f1` baseline refresh)

### Structural findings

| Finding | Verdict | Evidence |
|---|---|---|
| Ladder beats bm25only by +0.1159 MRR on full live LoCoMo | PASS (Decision 8 invariant) | ~6× amendment threshold |
| τ gap=10 plateau reproduces under live extraction | HELD | 9.4.8 measured 0.8077, 9.5 measured 0.8057 |
| `TIER2_TAU_CONFIDENCE` inert (second-time repro) | HELD | Identical MRR to 4dp across 8 values |
| Tier 3 λ/cooccurrence knobs inert (third-time repro) | HELD | Identical MRR to 4dp across all values |
| `TIER3_BEAM_WIDTH=3` borderline clean signal | OBSERVATION | +0.0055 MRR, below 0.02 threshold |
| Graph subset-selection bias reproduces identically | HELD | 3 knobs, same coverage drops as 9.4.9 rule-based |
| DEDUP_JACCARD_THRESHOLD Branch C fires (fourth-time) | HELD | MRR range 0.002 across thresholds, updateRate 0.007-0.045 |
| Tags populated 0% → 100% under live Gemma | STRUCTURAL (non-ranking) | Scorer now has content to score on; still flat |
| bm25 TAG_BOOST × SUBJECT_BOOST flat under live | HELD | Spread 0.0065, disconfirms 9.4.8's "+0.0098" micro-signal |
| `EXPLICIT_RELATION_WEIGHT` structurally inert | HELD | New knob, 4th edge-weight inert on LoCoMo |

### Test counts

- Sub-phase 9.4.9 close: 75 suites / 816 tests
- Sub-phase 9.5 close: 75 suites / 816 tests (**no delta** — infra Tasks 1–3 pre-shipped in 9.4.x; 9.5 work was configuration, sweeps, and artifacts)

---

## 2. Decisions held / revised

| Decision | Status | Notes |
|---|---|---|
| 1. Plan filename `phase-9-5-live-extraction.md` | **Held** | |
| 2. LLM transport via OpenAI-compatible HTTP + env vars | **Held** | Transport swapped from LiteLLM→Nano-GPT during preflight; env var names and code shape unchanged |
| 3. Extraction cache keyed by sha256(model, messages, maxTokens) | **Held** | Pre-shipped in 9.4.x, reused verbatim |
| 4. Determinism gate via `STARMEM_BENCH_LIVE_EXTRACTOR=1` | **Held** | CI still on rule-based path (816 tests unchanged) |
| 5. Model `google/gemma-4-26b-a4b-it` via Nano-GPT | **Held** | Exact-match string preserved cache hit rate |
| 6. Full LoCoMo (10 convs) by default | **Held** | All sweeps on full corpus |
| 7. Temperature hard-locked at 0 | **Held** | Not in cache key, not in any override path |
| 8. Baseline invariant gate `ladder_mrr ≥ bm25only_mrr − 0.02` | **Held → PASSED** | Actually passed by +0.1159 (~6× threshold) |
| 9. New sweeps TIER3_MAX_HOPS + EXPLICIT_RELATION_WEIGHT + BATCH_SIZE | **Partially Revised** | hops/relw shipped; BATCH_SIZE deferred to Phase 11 after Branch D fired twice |
| 10. EXTRACT_MAX_TOKENS folded into Task 7 | **Revised shape** | Done as host-side observation (p95 ≈ 70 tokens), not via sweep — the knob is cache-key-bound like BATCH_SIZE |
| 11. Retro framing: honest about flat elbows, propose Phase 11 | **Held** | This retro is the artifact |
| 12. Execution substrate: Modal | **Held with scar tissue** | Smooth for retrieval sweeps; Task 9 baselines ran locally (30+ min) because no Modal wrapper exists for baselines yet |
| 13. Full sweep grids restored (τ 48pts, bm25 16pts) | **Held** | Both surfaced Branch-C-flat shapes under live extraction |

---

## 3. Execution mode

**Controller-driven with Modal dispatches handed to Eva manually.** Tasks 1–3 pre-shipped during 9.4.x (discovered at Batch A dispatch, `b180bb6` URL-fix was the only new 9.5 contribution). Tasks 4–10 ran as a serial controller-driven loop: each Modal dispatch was followed by artifact reading, finding extraction, plan-patch commit before moving on.

**Sweep-protocol additions during 9.5 execution:**
- `render_single_axis_report` added to `bench/modal/sweep_app.py` for hops/relw (`f5541c5`)
- `run_point` timeout raised 600s → 1500s and per-point `volume.commit()` added (`5905581`) — both defensively useful even though they didn't rescue BATCH_SIZE
- `SWEEP_CONFIGS["tau"]` and `["bm25"]` grids restored from 9.4.8 validation configs to full cartesian

**Preflight pattern:** 9.5 started with a dedicated preflight audit pass (`0cb964e`, 1445 → 1249 line trim of the plan + transport swap + Modal integration + BATCH_SIZE Task 7 addition + stale test-count updates). Plus three mid-sub-phase preflight findings:
- Tasks 1–3 pre-shipped — mark `[x]` + document as pre-9.5 artifacts, not re-implement (`fd1ef1b`)
- `--local-out` gap for `run-point` mode — file to Phase 11 rather than fix mid-flight (`63412c5`)
- `--mode run-graph-sweep` and `--mode run-consolidation-sweep` bogus — entrypoint only supports `hello`/`run-point`/`run-sweep`, caught before dispatch (`7dbee98`)

---

## 4. Surprises

1. **Tasks 1–3 were already shipped.** The preflight audit on 2026-04-22 discovered `llmExtractor.js`, `extractionCache.js`, and the seeder's `_resolveExtractor` all landed during 9.4.8's Modal warm-cache work, folded into the 816-test baseline. The plan was drafted 2026-04-21 against a pre-9.4.8 mental model. Net contribution from "Tasks 1–3 execution": one URL-fix commit updating a test file's stale LiteLLM references (`b180bb6`). Documentation-truth fix (`fd1ef1b`) noted pre-shipment explicitly rather than pretending to rediscover the files.

2. **Live Gemma changed one structural thing (tags 0% → 100%) and zero ranking things.** Tags-populated-rate probe on Task 8 confirmed the extractor cooperates with the system prompt. But the 4×4 `TAG_BOOST × SUBJECT_BOOST` grid is Branch-C-flat under live extraction (spread 0.0065 across 16 cells) — disconfirms 9.4.8's borderline "+0.0098 MRR" reading as corpus-noise, not micro-signal. The scorer now has content to score on and still doesn't differentiate.

3. **Elbow-detector false-positive reproduced 3 times in 9.5.** τ sweep proposed `TIER2_TAU_CONFIDENCE: 2.0 → 0.5`, bm25 proposed `TAG_BOOST: 2 → 1` + `SUBJECT_BOOST: 2 → 4`, relw proposed `EXPLICIT_RELATION_WEIGHT: 1.0 → 0.5`. All three on axes with zero variance or below-noise Δ. Renderer's own rationale block self-admits `Δmetric/Δknob = 0.000000 ≤ 0.1×maxΔ = 0.000000`. None shipped to `baseline.json` thanks to manual audit; Phase 11 candidate upgraded from speculative to confirmed-recurring.

4. **BATCH_SIZE Branch D fired twice.** First attempt at `run_point timeout=600s` hit `FunctionTimeoutError` after ~470 live Nano-GPT calls; raised to 1500s, hit again at ~1200+ calls. Neither run persisted cache writes — `volume.commit()` only fires on clean function exit, and Modal's SIGKILL skips the error-path `try/except`. Zero permanent damage but ~1700 live calls of burnt cost. Root cause: 9.4.9 retro's "~20% miss rate" budget estimate was wrong by ~10× (cache-key change = 100% miss for that seed pass). Per `sweep-cache-invalidation-audit`'s Branch D: "Do not chase a timing-out sweep." Deferred to Phase 11 with three redesign options.

5. **Baseline comparison took 30+ minutes locally.** Plan predicted 5–10. Sequential over 4 retrievers × 1986 QA × full-LoCoMo seed per retriever; no Modal wrapper for baselines exists today. Filed to Phase 11.

6. **EXTRACT_MAX_TOKENS is ~29× overbudget.** Host-side post-cache analysis: p95 extraction response is ~280 chars ≈ 70 tokens; spec default is 2048. Proposing 256 (still 3.5× p95) as a Phase 11 candidate target. Not swept because it sits directly in the cache key (Pattern 1, same class as BATCH_SIZE).

7. **Third-time reproduction patterns crystallized framing.** λ₁/λ₂ inertness (9.4.6 rule-based, 9.4.9 rule-based, 9.5 live), DEDUP Branch C (9.4.6, 9.4.9, 9.5 smoke, 9.5 full), graph subset-selection bias (9.4.9, 9.5). Changing the extractor doesn't change any of them. LoCoMo's single-session structure is the bottleneck; the retrieval surface is exactly as good as the corpus allows.

---

## 5. Notes for Phase 10 (Playwright harness) and Phase 11 (infrastructure hardening + corpus expansion)

### Phase 10 scope (unchanged from Phase 9 retro)

- Playwright smoke harness (live ST integration end-to-end)
- UX polish deferred from Phase 8
- External memory-system baselines (Zep, Mem0) per Decision 5 footnote

### Phase 11 scope — six candidates filed during 9.5

Listed in rough priority order:

1. **Elbow-detector zero-axis-Δ guard** *(confirmed recurring, 3 reproductions in 9.5)*. `_detect_elbow` in `bench/modal/sweep_app.py` proposes amendments when any axis has zero or below-threshold variance. Guard: when `maxΔ` on any axis is below the amendment threshold, suppress the elbow recommendation and emit "held at spec — knob flat/inert on this corpus." ~6 LOC fix in the detector; cleaner if shipped alongside renderer amendment-threshold-aware logic.

2. **BATCH_SIZE consolidation round — budget-aware redesign.** Three option tracks: (a) mid-subprocess periodic `volume.commit()` via threading (commit every 60s so SIGKILL loses ≤1 min), (b) conversation-level splitting (5 convs × 5 BATCH_SIZE values = 25 bounded Modal containers, each doing 1 conv × 1 batch size), (c) cheaper stress-test model (Gemma 4 1B A1B for 10× speedup if dedup signal is the only question). Option (b) is most architecturally clean; (a) is defensive across all future sweeps that might live-regenerate cache.

3. **Coverage-weighted retrieval metric** *(inherited from 9.4.9, now with 9.5 confirmation)*. `recall@k × coverage` or similar to neutralize subset-selection bias on graph-structure knobs. Until this lands, graph/structure knob tuning stays gated out of `baseline.json`.

4. **Baselines sweep onto Modal substrate.** Field-surfaced 2026-04-23 during Task 9 (30+ min local wall-clock). Requires either a new `SWEEP_CONFIGS["baselines"]` entry or a distinct `--mode run-baselines` dispatch — baselines aren't a parameter sweep, they're a retriever-function swap. ~8 min parallel across 4 containers.

5. **Tier 2 gating demolition** *(inherited from 9.4.8/9.4.9)*. `TIER2_TAU_GAP=10` effectively disables Tier 2; ladder could simplify to always-Tier-3-as-Tier-2-seed. 9.5's `TIER2_TAU_CONFIDENCE` inertness confirmation strengthens the case.

6. **`--local-out` parity for `run-point` mode.** `bench/modal/sweep_app.py`'s `@app.local_entrypoint()` handles `--local-out` only under `run-sweep` mode. ~8 LOC fix to extend the `run-point` branch. Low-urgency ergonomics.

### Corpus expansion (inherited v2.1 scope, now with firmer evidence)

LoCoMo's single-session structure doesn't expose edge-weight asymmetry to any ranking knob. Three distinct Tier 3 edge-weight knobs (`TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `EXPLICIT_RELATION_WEIGHT`) are all fully inert under both rule-based and live extraction. Corpus expansion (multi-session, cross-character dialogue) is where edge-weighting sweeps become meaningful. This was already v2.1 scope; 9.5 gives it firmer evidence.

### EXTRACT_MAX_TOKENS tuning (filed under observations)

Observation-only in `baseline.json`. p95 char-proxy ≈ 70 tokens vs spec 2048. Lower to 256 saves tokens and latency without affecting any observed output. Not swept because it's in the cache key (Pattern 1). Phase 11 option: sweep against a fresh cache, or redesign to keep output-size observations warm under knob changes.

---

## 6. Notes for the skill library

- **`detecting-vacuous-metrics` field-validated for the 4th time** on 9.5's three elbow-detector false-positives. Same shape as 9.4.6 (vacuous-true on empty) and 9.4.9 (subset-selection bias) — "propose the sort-first corner as the elbow when the axis has no real signal." The skill's coverage-check framework caught it; the specific "zero-axis-Δ guard" pattern is worth a subsection addition. Candidate skill patch: add "Axis-variance guard on elbow detectors" to the skill's Prevention Patterns section.

- **`sweep-cache-invalidation-audit` Branch D field-validated.** 9.5 BATCH_SIZE is the first live Branch D firing (9.4.9 was a synthetic-smoke catch; this time the full live attempt timed out). Skill language "Do not chase a timing-out sweep" held exactly — after the second timeout the deferral decision was easy because the pattern was pre-written. The 9.4.9 budget-estimate error ("~20% miss rate") is worth adding to the skill's Red Flags section: *"cache-key-flow budget estimates that assume partial miss rates are often wrong — if the knob changes the hash, assume 100% miss and budget accordingly."*

- **New `plan-preflight-audit` finding: Pre-shipped infrastructure detection.** When a plan file predates the shipping of its own infra, dispatch subagents on Task 1 and have them report back with "already done at commit X" rather than forcing re-implementation. Then mark the Done-when entries with provenance (`[x] Task N *(pre-shipped in N.M.x, commit abc123)*`) and move on. Candidate skill patch: add "Detecting pre-shipped plan infrastructure" to preflight skill.

- **`writing-plans` mental-model-drift reminder.** 9.5's plan was drafted 2026-04-21 against a pre-9.4.8 world and required a 1445→1249 line preflight patch (Modal substrate swap, BATCH_SIZE addition, Nano-GPT transport, test-count updates). If a plan is drafted N days before execution, the preflight audit's line-of-attack should include *"what changed in the codebase between plan date and execution date?"* as its first checklist item. Candidate skill patch: add "Plan-age drift audit" as the first preflight step.

---

## 7. Commit graph

```
04d76f1  docs(bench): refresh baseline.json with 9.5 live-extraction measurements
18c0df3  docs(bench): publish 9.5 sweep artifacts under canonical paths
121de9b  docs(plans): Task 10 relw sweep complete — third edge-weight knob inert
d21e87e  docs(plans): Task 9 baselines complete — structural invariant PASS by 6x
f02b1a5  docs(plans): Task 8 bm25 sweep complete — Branch C flat under live Gemma
fd32a12  defer(bench): drop BATCH_SIZE from 9.5 Task 7 — Branch D fired twice
5905581  fix(bench): per-point volume commit + raise run_point timeout to 1500s
46c698f  fix(bench): re-enable BATCH_SIZE round for 9.5 consolidation sweep
1adac7a  docs(plans): Task 6 graph sweep complete — third-time repro, zero amendments
7dbee98  docs(plans): Task 5 findings + Task 6/7 command fix
f5541c5  feat(bench): restore full tau/bm25 grids + add hops/relw sweep configs
63412c5  docs(plans): Task 4 smoke verified + --local-out gap filed for Phase 11
fd1ef1b  docs(plans): mark Tasks 1-3 shipped pre-9.5 (preflight finding)
b180bb6  feat(bench): Node OpenAI-compatible LLM extractor (Task 1)
0cb964e  docs(plans): 9.5 preflight patch — Modal substrate, full sweep grids, BATCH_SIZE round
```

---

**9.5 closes.** Zero amendments shipped; every swept knob held at spec per the hardened amendment criteria (ΔMRR + coverage). The 9.4.8 retrieval surface (`TIER2_TAU_GAP=10`, MRR 0.81, coverage ~64%) remains the production default. baseline.json now documents every swept knob's live-extraction verdict plus an EXTRACT_MAX_TOKENS observation and six Phase 11 candidates. The next sub-phase is either Phase 10 (Playwright harness, UX polish, external baselines) or Phase 11 (infrastructure hardening: elbow-detector guard, BATCH_SIZE redesign, coverage-weighted metric, Tier 2 demolition, baselines on Modal, run-point local-out parity) depending on priorities.
