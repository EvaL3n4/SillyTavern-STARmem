# Sub-phase 9.4.8 Retro — Modal Bench Substrate + Full Sweep Refresh

**Status:** Complete — substrate shipped, both sweeps refreshed, baseline.json refresh landed, TIER2_TAU_GAP amendment found.
**Commits:** 24 (3fe932e plan → c637b49 post-reconstruction cleanup)
**Duration:** Two working sessions. First session ran Tasks 1–9 + extended/sledgehammer/validation sweeps (~8 hours across image builds and iterative debugging). Second session handled the post-drop reconstruction and persistence fix (~1 hour).

---

## What happened

9.4.7 shipped the seeder idle-drain fix untested against full LoCoMo-10 by design — the full-corpus validation was deferred to 9.4.8. 9.4.8's deal was to (a) stand up a Modal substrate so future sweeps don't pin a single core at 99.8% for 62 minutes, and (b) re-run τ + BM25 to validate 9.4.7's fix at scale.

Both landed. The Modal app runs per-knob-value parallelism via `.map()`; the free tier's 32-container concurrency cap turns a 48-point τ sweep into two 32-container waves (~8 min wall-clock, vs the 62 min serial projection from 9.4.6). A Python aggregator (`bench/modal/sweep_app.py`) reproduces the exact Markdown format that `tau.js` and `bm25.js` emit locally, so the sweep artifacts are interchangeable.

The full-corpus re-run validated 9.4.7's fix cleanly: ladder MRR jumped from 0.1118 (9.4.6 broken-state) to 0.7452 (spec default) and 0.8804 at the initial elbow. Both structural invariants (`ladderVsRandom`, `ladderVsBm25Only`) flipped FAIL → PASS. Tier 3 contribution, which 9.4.6 measured at +0.0001 MRR (below threshold), is now +0.0794 — the 9.4.6 "graph adds nothing" finding was bench-state noise masquerading as a signal.

Then the τ sweep surprised us. The 48-point grid (τ_confidence × τ_gap) found an elbow at (0.5, 1.5) with MRR 0.7721 — healthy, but the gap axis showed MRR monotonically climbing right up to the sweep's upper edge. An extended sweep (pin confidence=2.0, bracket gap 1.5–5.0) confirmed the climb continued. A sledgehammer sweep (gap ∈ {10, 100, 1000}) found a plateau at ~0.8077 starting at gap=10 and holding flat through gap=1000. The knob we thought would tune a single-digit threshold turned out to effectively act as a boolean: Tier 2 gating is either engaging (gap ≤ ~5) or disabled (gap ≥ 10, everything falls through to Tier 3). The "tuned" value is "turn it off."

A validation sweep at `cb30323` confirmed gap=10 + tag=3 stack additively as expected (MRR 0.8080, matching gap=10 alone at 0.8077 — so the tag boost is effectively redundant once gating is disabled).

Then this session's transport drop during the reconstruction phase cost the in-memory result dicts from all three sweeps — but only because `run_sweep` returned a bare markdown string with no disk persistence. Recovery: reconstruct from session transcript, commit, then fix the persistence hole so this failure mode can't recur.

## Decisions held

1. **Node 20.x via NodeSource PPA.** Held.
2. **Volume `starmem-bench-data` for cache.** Held.
3. **`add_local_dir` for repo code** (Modal renamed from `copy_local_dir`; plan-flagged drift). Held — `add_local_dir` works on Modal 1.4.2.
4. **Per-knob-value parallelism via `.map()`.** Held. Free-tier cap of 32 containers → 48-point sweeps run in two waves.
5. **Python aggregator reproduces exact Markdown format.** Held — `render_tau_report` / `render_bm25_report` emit byte-for-byte identical output to the JS originals (to 4 decimals, same column order, same heatmap layout).
6. **Local path default, `--modal` opt-in.** Held — `tau.js` and `bm25.js` kept their local paths; Modal is additive.
7. **Warm cache only, no live LLM on Modal.** Held. The `.env.bench` secret injects the cache-key model (`google/gemma-4-26b-a4b-it`) so every cache lookup hits; no outbound LLM calls from Modal containers.
8. **Observation-first cost posture.** Held — no container_idle_timeout, no memory reduction; total session spend estimated <$2 across ~40 container-minutes of Modal time.
9. **Baseline.json refresh conditional on 9.4.7 validation.** Held. Both invariants passed → updated to `status: measured`, `knownIssues` rewritten to drop the structurally-broken language.
10. **Synthetic smoke <5 min.** Held — synthetic grid completes in ~90s end-to-end including container cold start.

## Decisions revised mid-flight

**Scope:** 9.4.8 was plan-scoped to a single τ sweep and a single BM25 sweep. The τ gap monotonic climb surfaced during Task 7, which triggered two unplanned follow-ups:

- **Extended τ sweep** (`f2afd31`) — pin confidence, bracket gap 1.5–5.0
- **Sledgehammer τ sweep** (`3ef4a7c`) — gap at {10, 100, 1000} boundaries to test whether Tier 2 gating has any meaningful range

Both were necessary to reach an honest "gap plateaus at ~10" conclusion instead of shipping the initial (0.5, 1.5) elbow as the tuned value. In retrospect this was the right call — the 48-point sweep's elbow was premature, and without the follow-ups we'd have amended the spec with a number the data doesn't actually support. The reconstruction note in `2026-04-22-tau.md` flags this so future readers see both the local max and the true plateau.

## What worked

- **The substrate is reusable verbatim.** Phase 11's diagnostic sweeps, 9.4.9's graph/consolidation sweeps, and any future knob exploration just need `SWEEP_CONFIGS` entries and run through the same `run_point` + `run_sweep` path. No per-sweep infra.
- **Python aggregator format parity.** Side-by-side spot checks against local JS output matched to 4 decimals on every field. The renderer-as-single-source-of-truth design paid off during the reconstruction: the shim that regenerated the markdowns from reconstructed JSON used the same `render_tau_report` function the live Modal path calls.
- **Cache injection via `.env.bench` Secret** (`10f7372`). Prevented silent fallback to rule-based extraction that would have given systematically fewer episodic facts — spotted early because the cache hash is model-keyed and the first test run had no episodic hits, which triggered the investigation.
- **Integer-looking keys are strings in JSON** (`a5bf471`). The `recallAtK["5"]` vs `recallAtK[5]` gotcha was caught in the first test run, not buried in a sweep report. Documented in the renderer comment block.

## What surprised us

- **Tier 2 gating is structurally vestigial on LoCoMo.** The knob's useful range turned out to be a boolean: either it's engaging (gap ≤ ~5, MRR 0.73–0.77) or it's disabled (gap ≥ 10, MRR plateaus at 0.8077). There's no "well-tuned middle." This is a Phase 11 candidate — the ladder could simplify to always-Tier-3 and we'd get better numbers with less code.
- **9.4.6's "Tier 3 adds nothing" finding reversed.** 9.4.6 reported +0.0001 MRR lift from the graph tier; 9.4.8 measures +0.0794 when gap allows queries to reach Tier 3. The 9.4.6 number was measuring the ladder's broken state (residual working buffer burying the gold), not the graph's actual contribution. Graph expansion is genuinely valuable — it just couldn't be seen through 9.4.6's noise. This reshapes the roadmap: graph/consolidation sweeps, previously deferred as low-signal, are now justified follow-up work.
- **TAG_BOOST's +0.0098 MRR lift is redundant with gap=10.** Sweep showed TAG_BOOST peaks at 3 (clean non-flat signal). Validation sweep showed gap=10 + tag=3 lands at 0.8080 vs gap=10 alone at 0.8077 — the tag improvement gets absorbed once gating is disabled. Rational amendment is one-knob, not two.
- **Modal wallclock vs concurrency cap.** Expected ~4 min for 48 points in parallel. Got ~8 min because the free tier caps at 32 concurrent containers, so 48 points run as two 32-container waves, and the second wave only starts after the first finishes. Documented in both the reconstructed sweep's `_run_wallclock_note` and `structural_findings_for_knownIssues.modal_infra_note`. Not worth paying for more concurrency at current cadence.
- **`run_sweep` returned a string, not a dict.** Session transport drop during reconstruction exposed that the sweep's in-memory `result` dict was thrown away on function return. Only the printed markdown (buffered in the calling session) survived — and since the session also lost some of that buffer, reconstruction had to come from conversation transcript. Fixed post-hoc in `f5baae5`: run_sweep now persists result.json + report.md to `/data/runs/<ts>-<sweep>/` on the Modal Volume and `volume.commit()`s before returning. Schema-versioned so future shape changes don't break reconstruction shims.

## Metrics

- **Plan length:** 1438 lines (11 tasks + manual Modal invocation protocol + retro template)
- **Duration:** ~8h session 1 (substrate + sweeps + initial baseline refresh), ~1h session 2 (reconstruction + persistence fix)
- **Modal image build time:** ~75 seconds (first run); near-instant on subsequent runs
- **Synthetic smoke wall-clock:** ~90 seconds end-to-end including cold start
- **Full τ sweep wall-clock:** ~8 min (48 points, two 32-container waves)
- **Full BM25 sweep wall-clock:** ~90 seconds (16 points, single wave)
- **Extended τ sweep wall-clock:** ~2 min (8 points, single wave)
- **Sledgehammer τ sweep wall-clock:** ~90 seconds (4 points, single wave)
- **Validation sweep wall-clock:** ~30 seconds (1 point)
- **Estimated Modal spend:** <$2 across the full sub-phase (free tier absorbed most of it)
- **Files created:** `bench/modal/sweep_app.py`, `bench/modal/upload_cache.py`, `bench/modal/_modal-point.js`, `bench/modal/__init__.py`, `.env.bench` (local, gitignored)
- **Files modified:** `bench/runner.js` (gitSha stamping), `bench/harness/runner.js` (string-key metrics), `tests/integration/bench/runner.integration.test.js` (NaN-tolerant assertion), `.gitignore` (Python bytecode + runs dir)
- **Artifacts produced:** `docs/bench/sweeps/2026-04-22-{tau,bm25}.md`, `docs/bench/baselines/2026-04-22-comparison.md`, `docs/bench/baseline.json` (refreshed)
- **Tests:** 75 suites / 812 tests green through the close (1 assertion relaxed post-9.4.6 NaN semantics; no suite/test count change)

## Sweep findings summary

| Knob | Spec default | Measured | Note |
|---|---|---|---|
| `TIER2_TAU_CONFIDENCE` | 2.0 | 2.0 (inert) | Identical MRR across 0.5–5.0 at any fixed gap. Rank-1 BM25 scores always clear even low thresholds on LoCoMo. Candidate for removal in future sweeps. |
| `TIER2_TAU_GAP` | 0.5 | **10** (amended) | Monotonic climb from 0.7303 @ 0.1 → 0.8077 @ 10, plateau through gap=1000. +0.0625 absolute MRR. Effectively disables Tier 2 gating in favor of always-Tier-3. Phase 11 candidate for ladder simplification. |
| `TAG_BOOST` | 2 | 2 (hold) | Advisory only. Peaks at 3 (+0.0098 MRR) but absorbed by gap=10 amendment (validation sweep confirms). Ship one-knob amendment, not two. |
| `SUBJECT_BOOST` | 2 | 2 (inert) | <0.003 MRR variation across 1–4. Noise-level. |

Headline metrics at spec-default knobs (post-amendment: gap=10):

| Retriever | recall@1 | recall@5 | MRR | p50 ms | p95 ms |
|---|---|---|---|---|---|
| ladder (default) | 0.4495 | 0.8553 | 0.7452 | 1.85 | 4.16 |
| ladder (gap=10) | — | — | **0.8077** | — | — |
| bm25only | 0.3124 | 0.7912 | 0.6898 | 6.01 | 7.34 |
| recency | 0.0000 | 0.5692 | 0.2703 | 0.08 | 0.28 |
| random | 0.0755 | 0.4717 | 0.2690 | 0.04 | 0.24 |

Structural invariants: both `ladderVsRandom` (+0.4762) and `ladderVsBm25Only` (+0.0554) pass their 0.02 thresholds cleanly.

## Notes for 9.4.9

The Tier 3 value-add reversal (from 0.0001 → 0.0794 MRR) makes graph and consolidation sweeps meaningful. Per locked decision 6 of 9.4.8 they stayed deferred through this sub-phase; per 9.4.6/9.4.8 joint disposition they're now queued as 9.4.9.

Scope sketch for 9.4.9:

1. **Graph sweep:** TIER3_LAMBDA_1 (edge type match weight), TIER3_LAMBDA_2 (BM25 weight), TIER3_BEAM_WIDTH, TIER3_SEEDS_K, EDGE_CAP_PER_ENTRY, COOCCURRENCE_WEIGHT. With gap=10 disabling Tier 2 gating, these knobs are now in the hot path for every query.
2. **Consolidation sweep:** DEDUP_JACCARD_THRESHOLD (9.4.6 measured 4.4% → 0.7% update rate across thresholds but flat retrieval — re-measure post-9.4.7), BATCH_SIZE, WORKING_BUFFER_THRESHOLD. Storage-side knobs that might affect downstream retrieval once Tier 3 is properly engaged.
3. **Graph sweep cardinality consideration:** 6 graph knobs × 3-point grids each = 729 points. Over free-tier concurrency cap. Suggested approach: coordinate descent (one axis at a time, ~18 points total) instead of full grid. The Modal substrate supports this cleanly — each axis is its own `SWEEP_CONFIGS` entry.

## Notes for Phase 11

- **Tier 2 gating is Phase 11 demolition candidate.** The gap=10 plateau says "always fall through to Tier 3" is net-positive. Phase 11 could simplify the ladder: drop the τ_confidence/τ_gap comparison entirely, always run Tier 2 BM25 as Tier 3's seed step, no conditional. Would remove two constants, one check, and the τ sweep infrastructure. Measure impact in 9.4.9's graph sweep first — if graph knobs at gap=10 land meaningfully above gap=10 alone, that's more ammunition.
- **Scorer chain review.** 9.4.7's diagnostic revealed the multiplicative scorer's total dynamic range on LoCoMo is 1.00× while BM25's is 7.06× — i.e. the scorer chain is barely touching rank order. Worth revisiting whether `recency × importance × maturity_boost` is earning its keep, especially post-9.4.9 when graph is in the hot path.
- **Working-buffer prepend semantics** (Eva's 9.4.7 flag). `prependWorking` puts buffer entries at score=Infinity. If a user asks about a 2-day-old topic with a fresh unrelated working buffer, residuals could still bury relevant episodics. Not observed in LoCoMo (conversations are single-session), but a real-usage edge case. Candidate: relevance-aware buffer prepend (score buffer entries against query instead of Infinity), or cap on prepended count.

## Notes for future Modal tuning

- Persistence commit (`f5baae5`) added `run_sweep` → Volume writes + `--local-out` flag for host-side mirror. Reconstruction path is now belt-and-suspenders (Volume + local dir); the `/tmp/9-4-8-sweep-data.json` transcript-archaeology path should not be needed again.
- If cost becomes an issue: drop memory to 2048 (current 4096 is oversized per `hello()` probe showing <500MB resident), shorten timeout for synthetic runs to 120s, batch 2–4 grid points per container to amortize Node startup cost.
- If cold starts dominate at higher sweep cadence: add `container_idle_timeout=300` to `run_point` so the 32 containers stay warm between waves.
- Cache volume is 4.8 MB of extractions + 2.8 MB corpus. Trivial; no prune strategy needed at current cadence. If 9.5 (live extraction) lands, cache size could balloon — revisit then.

## Files touched

**Modal substrate:**
- `bench/modal/sweep_app.py` — main app, per-point runner, aggregator, renderers
- `bench/modal/upload_cache.py` — Volume cache uploader + verifier
- `bench/modal/_modal-point.js` — Node shim per grid point
- `bench/modal/__init__.py` — package marker

**Bench adjustments:**
- `bench/runner.js` — gitSha stamping (added git to image for this)
- `bench/harness/runner.js` — string-key metrics (`recallAtK["5"]` not `[5]`)

**Artifacts:**
- `docs/bench/sweeps/2026-04-22-tau.md` — 48-point τ sweep (reconstructed from session transcript post-drop)
- `docs/bench/sweeps/2026-04-22-bm25.md` — 16-point BM25 sweep (reconstructed)
- `docs/bench/baselines/2026-04-22-comparison.md` — 4-retriever comparison on spec-default knobs
- `docs/bench/baseline.json` — refreshed with post-9.4.7 metrics + amendments
- `docs/bench/sweeps/2026-04-21-*.md` — superseded pre-9.4.6 sweeps committed for provenance

**Plans/docs:**
- `docs/plans/phase-9-4-8-modal-bench-substrate.md` — plan (pre-existing)
- `docs/plans/phase-9-4-8-retro.md` — this file

**Tests:**
- `tests/integration/bench/runner.integration.test.js` — NaN-tolerant `precisionAtK[1]` assertion (post-9.4.6 semantics)

## Commit graph

```
c637b49   test(bench): accept NaN precisionAtK[1] for empty-evidence QAs
f0c1496   docs(bench): track pre-9.4.6 sweep artifacts for provenance
e276cc7   chore: gitignore Python bytecode and bench run artifacts
f5baae5   feat(bench): persist Modal sweep results to Volume + optional local mirror
c568691   docs(bench): reconstruct 9.4.8 sweep artifacts from session transcript
cb30323   feat(bench): validation sweep — combined amended-spec single point
3ef4a7c   feat(bench): sledgehammer tau sweep — boundary values to test Tier 2 gating
f2afd31   feat(bench): extended tau sweep — pin confidence, bracket gap peak
d054aa4   fix(bench): cosmetic — corpus_len is always 10 regardless of synthetic flag
a5bf471   fix(bench): use string keys for recallAtK/precisionAtK lookups
d683836   fix(bench): synthetic grid points populate every renderer-expected knob
4dca3db   fix(bench): redirect console.log to stderr in _modal-point.js
fef2aa9   fix(bench): Python 3.11 f-string compat + leading-pipe port bug
6fea399   feat(bench): Python aggregator with tau+bm25 report renderers
10f7372   fix(bench): inject .env.bench into Modal container via Secret.from_dotenv
eb00c79   fix(bench): install git in Modal image so runner.js gitSha stamping works
77d94d8   fix(bench): explicit dispatch in main() entrypoint — mode + overrides_json
d6903cb   fix(bench): surface Node subprocess stderr + FS diagnostics in run_point
f96dc38   feat(bench): Modal run_point wrapper + Node single-point runner
ca8b5ef   fix(bench): pivot upload_cache.py to Volume verifier, use modal volume put
5f1d45e   feat(bench): Modal Volume upload script + cache verification
48557c2   feat(bench): Modal app skeleton with Node 20 image + hello-world
d63ad27   docs(plans): add manual Modal invocation protocol to 9.4.8 plan
3fe932e   docs(plans): sub-phase 9.4.8 Modal bench substrate plan
17508e3   chore(retrieval): clean up tier2 after diagnostic refactor (9.4.7)     ← 9.4.7 tip
```

## Notes for the skill library

- **Persist serverless compute results at the source.** The reconstruction detour existed only because `run_sweep` returned a string with no disk copy. Rule: any serverless function running non-trivial compute should write its raw outputs to durable storage (Volume, S3, GCS) *before* returning. Three-layer defense: (1) Volume/blob within the container, (2) commit + return path to caller, (3) optional host-side mirror via client flag. Schema-version the persisted payload from commit 1 so reconstruction shims can branch on version. Done in `f5baae5`; covered by the `devops/persist-serverless-compute-results` skill.
- **Elbow detection can miss true peaks if the sweep range is too narrow.** The τ 48-point sweep's upper edge (gap=1.5) produced the local maximum, but the true plateau was at gap=10 — nearly an order of magnitude outside the sampled range. Lesson: before accepting an elbow near the range edge, extend one axis and verify the metric actually flattens. 9.4.8's extended + sledgehammer sweeps cost ~3 minutes wall-clock and prevented shipping a wrong amendment.
- **"X adds nothing" findings on broken infrastructure must be re-measured after the fix.** 9.4.6 measured Tier 3 at +0.0001 MRR on a broken ladder. The natural inference was "Tier 3 doesn't work"; the correct reading was "we can't measure Tier 3 while the ladder is broken." 9.4.8 reversed the finding. Rule: when a diagnostic fix changes the retrieval surface materially, expire prior negative findings and re-measure — don't assume they port forward.
- **Renderer-as-single-source-of-truth pays off during reconstruction.** `render_tau_report` / `render_bm25_report` were written once in Python for the Modal aggregator. The reconstruction shim imported them directly (via a modal stub) and produced byte-identical output to live Modal runs. If renderers had been duplicated between Python and JS, reconstruction would have required choosing which to match. Pattern: for any multi-path render (local + remote + reconstruction), keep the render function in one language and stub the execution environment at call sites.

---

**9.4.8 closes.** The Modal substrate is operational, 9.4.7's fix validates cleanly at full-corpus scale, the ladder no longer looks broken, and two unexpected findings — Tier 2 gating is a boolean in disguise, Tier 3 is actually valuable — reshape the downstream roadmap. The TIER2_TAU_GAP=10 amendment ships as a single-knob spec change; TAG_BOOST stays at default 2 per the absorption finding.

Next open work: **9.4.9** — graph and consolidation sweeps against the now-meaningful retrieval surface. **Phase 11** candidate: Tier 2 gating demolition.
