# Phase 12 Task 6.5 Retro — Modal vLLM Warmup

**Substrate swap:** Fireworks Batch (dead-ended) → Modal vLLM offline batch
(`Qwen/Qwen3.6-35B-A3B-FP8`, single H100). Byte-compat invariants preserved
end-to-end; Task 6 regression check landed `misses=0` on all 3 sampled items
after a one-day pre-flight gap and recovery surfaced.

## Decisions held / revised

1. **Model: Qwen/Qwen3.6-35B-A3B-FP8.** Held. The 3B-active MoE on H100 hit
   `sustainedOutTokPerS = 2,731` aggregate (Task 5 result), squarely in the
   plan median band of 1.5K–3K. Quality spot-check on 4 of 5 smoke
   extractions returned coherent, real-world entity facts (pets, podcast
   habits, lesson plans, biology); the 5th was a fox/chicken/grain logic
   puzzle that the model correctly judged as a hypothetical with no
   extractable world-claims (content-cause, not engine-cause — confirmed by
   shuffle test). No fallback to BS=10 needed.

2. **Single H100, no `.map` fan-out.** Held. One `@app.function`, one
   `LLM(...).chat(messages_list)`. No engineering surface added vs. fan-out
   designs.

3. **Cache transport: existing `starmem-bench-data` Volume mounted at
   `/data`.** Held. Write-IS-ingest path preserved.

4. **Enumerator subcommand on `fireworks-warmup.js`.** Held. Reused
   `parseArgv` command-routing without disturbing the legacy submit/poll
   path.

5. **Custom_id invariant: parallel-array zip.** Held. `perPromptFailures: 0`
   across 16,677 dispatches confirms the contract is intact.

6. **Reasoning suppression: `chat_template_kwargs={"enable_thinking": False}`.**
   Held. The fallback `--reasoning-parser qwen3` was never needed; the
   `_strip_reasoning` belt-and-suspenders post-strip never observed a leak.
   Clean primary-path coverage.

7. **`language_model_only=True`.** Held but ambiguous in observed effect.
   Engine logs reported `running in text-only mode` and
   `All limits of multimodal modalities supported by the model are set to
   0`, which is the desired behavior. Whether the kwarg or vLLM's own
   text-only auto-detection drove that, the outcome is correct. Kept for
   defensive clarity.

8. **Per-cell timeout `14400` (4h).** Revised in flight to remain valid:
   `max_model_len` was bumped 8192 → 32768 → 40960 (see surprise #2 below)
   after smoke crashed on an 8193-token prompt. The 4h ceiling never came
   close to firing — full dispatch landed at 3,280.85s (54.7 min), well
   inside.

9. **Cost envelope: ~$3–$5.** Held tighter than expected: actual **$4.50**
   total for the 16,677-batch dispatch, plus ~$1–$2 spread across two
   smokes (one DeepGEMM-tuning re-throw, one max_model_len-fix re-throw)
   and image rebuilds. Cumulative ~**$5.50–$6.50**, inside budget.

10. **BATCH_SIZE=15 override.** Held — but this is the lesson-bearing one.
    See Surprise #1 below.

## Cost envelope — actual vs forecast

| Item | Forecast | Actual | Note |
|---|---|---|---|
| Task 4 smoke (5-item) | $0.30 | ~$1–$2 | First smoke crashed (DeepGEMM not available); two more smokes for tuning + cache-warm verification |
| Task 5 dispatch | $1.50–$3.00 | **$4.50** | 16,682 batches at `sustainedOutTokPerS = 2,731`, wall 3,280.85s × $4.94/hr |
| Task 6 regression | $0.20 | ~$0.30 | corpus-size=3, two attempts (first attempt blocked by cache-key misalignment, second clean) |
| **Total** | **$2.00–$3.50** | **~$6** | Inside the $30 free credit with $24+ headroom |

Compared to the dead-ended Fireworks Batch plan ($56 forecast for the same
work), the substrate swap shipped at roughly **one-tenth the cost** with way
more engine control. The BS=15 enumerator override alone (vs. BS=5) saved
another ~$6 on top.

## Surprises

1. **Cache-key alignment requires both model AND BATCH_SIZE flags.** The
   plan's original Task 6 incantation passed `--corpus-size 3
   --warmup-concurrency 1` only. The cache key is
   `sha256(model + JSON(messages) + maxTokens)`. The live read path
   defaulted to `model=google/gemma-4-26b-a4b-it` and `BATCH_SIZE=5`,
   neither of which matched the warmed cache (`Qwen3.6-35B-A3B-FP8`,
   `BATCH_SIZE=15`). `misses=0` was mathematically impossible without
   changes. Caught on the first regression-check attempt by spotting
   `model=google/gemma-4-26b-a4b-it` in the live-extraction startup log.
   Fix: commit `51a677e` plumbed `--batch-size` through three layers
   (`main()` → orchestrator starmap tuple → point function via
   `STARMEM_BATCH_SIZE` env var → JS `setConstantOverrides`) and the
   regression check's incantation now includes both `--extractor-model
   "Qwen/Qwen3.6-35B-A3B-FP8"` and `--batch-size 15`. Cost of the gap:
   one wasted regression-check attempt (~$0.10), one ~30-LOC patch + 13
   tests, ~30 min controller wall-clock. Lesson encoded in the
   `batch-api-cache-warmup` skill patch and in plan-preflight-audit:
   **whenever a warmup pre-fills a cache, every override that goes into
   the cache key on the write side must also go into the cache key on the
   read side.** Greppable invariant — the cache-key derivation is one
   function (`_cacheKey`) and reads it lists exactly the inputs that must
   be aligned.

2. **`max_model_len=8192` was sized against a bad estimate.** Plan
   Decision 7's "extraction prompts ~1.2K input tokens" was lifted from
   LoCoMo numbers; LongMemEval-S items are ~3× denser per turn, so
   BS=15-grouped batches hit 8193 tokens on the very first oversized
   prompt and aborted the entire dispatch (vLLM validates whole-batch
   before generation). Fixed in two passes: 8192 → 32768 (commit
   `5bf654c`), then 32768 → 40960 once `wc -L /tmp/full-warmup.jsonl`
   showed worst-case prompt at ~26K tokens. Same class of bug as the
   "~10,800 batches" stale-estimate caught in pre-flight; this one slipped
   through. Lesson: **any literal in `vllm_warmup.py` sized against
   extraction-prompt shape needs a LongMemEval-S sanity check, not a
   LoCoMo-derived estimate.** Pre-flight grep against the actual enumerator
   output (`wc -L /tmp/full-warmup.jsonl` for char→token estimate) is ~5
   seconds and would have caught it.

3. **vLLM image plumbing was three traps deep.** None of these were in
   the plan because none are in Modal's `vllm_throughput` example template
   — they only surface on this specific image + Python + nightly + FP8
   combination:
   - **DeepGEMM not bundled in vLLM nightly wheel.** First crash. Initial
     fix was the `VLLM_USE_DEEP_GEMM=0` env var (CUTLASS fallback,
     ~10–20% slower). Pivoted to `vllm/vllm-openai:nightly` Docker base
     image which ships DeepGEMM + FlashInfer + EP kernels pre-built.
   - **`add_python="3.11"` shadows the image's vllm-bearing Python.**
     Modal's `add_python` installs a *fresh* Python alongside whatever's
     in the image and uses that as runtime; vLLM is in the image's own
     Python, so the new 3.11 can't see it. `ModuleNotFoundError: vllm`.
     Fix: drop `add_python`, let Modal use the image's default Python.
   - **vllm/vllm-openai image has no `python` symlink, only `python3`.**
     Modal's image probe runs `python --version` to detect the version,
     fails with `ConflictError("unable to determine the version of
     Python")`. Fix: `setup_dockerfile_commands(["RUN ln -sf $(command
     -v python3) /usr/local/bin/python"])` runs as a Dockerfile RUN step
     before Modal's probe.
   - **MoE auto-selected TRITON despite DeepGEMM available.** First clean
     smoke logged `Using TRITON Fp8 MoE backend`. For an A3B model the
     MoE is dominant compute, so leaving it on TRITON forfeits most of
     the DeepGEMM win. Fix: explicit `moe_backend="deep_gemm"` kwarg.
   - **DeepGEMM JIT-cache volume mount path was wrong.** Mounted
     `/root/.cache/deepgemm`; vLLM actually puts JIT artifacts at
     `${VLLM_CACHE_ROOT}/deep_gemm` = `~/.cache/vllm/deep_gemm`. The
     wrong-path mount was capturing nothing. Fix: mount `/root/.cache/vllm`
     whole — captures DeepGEMM cache + torch.compile artifacts + CUDA
     graph captures together.
   All five fixes folded into commits `39e7a5d`, `24e198c`, `979da88`,
   `3ca0292`, `a50987d`. Lesson is broad enough to live in the modal
   skill — see the patch.

4. **The `::main` walkback.** Recovered context after Azure cut a turn
   carried a wrong claim into the plan-fix commit (`e7749a0`): I framed
   `modal run path.py::main` as "deprecated" in Modal 1.x. It's not — PR
   #2814 made `::function` *auto-inferable* when there's exactly one
   `@app.local_entrypoint()`, not invalid. The repo's bare-path convention
   was still the right thing to enforce, but for consistency reasons, not
   validity. Commit message overstates; not worth amending. Lesson
   encoded into the modal skill: cite the actual PR number when claiming
   a syntax change, and verify by running both forms before declaring one
   "deprecated."

5. **Smoke timings on N=5 are noise, not signal.** Two smokes produced
   `sustainedOutTokPerS = 239` and `122` on different MoE backends. Tempting
   to conclude DeepGEMM is slower than TRITON — but at 5 prompts the
   measurement is dominated by FlashInfer GDN JIT compile + CUDA graph
   shape capture + first-shape kernel warmup. The real signal landed on
   Task 5: 2,731 tok/s aggregate over 16,677 prompts. Lesson: **don't
   tune steady-state knobs from smoke timing data; use smoke for crashes,
   quality, and cache-write contract — let throughput numbers come from
   the full dispatch.**

6. **Empty `entries: []` was content-cause, not engine-cause.** First
   smoke had 1 of 5 cache files with `entries: []`. Tempting to call
   first-prompt artifact (FP8 first-shape kernel? prefix-cache cold path?)
   and dispatch tuning. Two cheap discriminators settled it: (a) the prompt
   was a fox/chicken/grain logic puzzle — Qwen3.6 correctly judging "no
   real-world facts to extract from a hypothetical scenario," and (b) the
   shuffle test (move the empty-result customId to a non-first position
   and re-dispatch) returned `length: 0` again. Two independent positions
   for the same prompt → engine-fault is ruled out. Lesson: **N=1
   anomalies on smoke data deserve the shuffle test before the engine
   gets the blame.** Encoded as a triage pattern in the modal skill.

## Notes for Phase 12 Task 7 (λ₁ tripwire)

- **Cache key shape** for all baselines/sweeps that reuse this warm cache:
  `(model="Qwen/Qwen3.6-35B-A3B-FP8", BATCH_SIZE=15, EXTRACT_MAX_TOKENS=2048)`.
- **Required env/CLI overrides** on the regression-side dispatcher:
  - `--extractor-model "Qwen/Qwen3.6-35B-A3B-FP8"`
  - `--batch-size 15`
  - `EXTRACT_MAX_TOKENS=2048` already matches spec default; no override
    needed unless we touch consts.
- **Corpus coverage:** LongMemEval-S full (500 items, 16,682 batches at
  BS=15) + LoCoMo full (5 items, ~25 batches) — enumerator was run with
  `--corpora longmemeval-s` only on the production dispatch since the
  LoCoMo bundle had already been warmed in earlier phases. Phase 12 Task 7
  needs LongMemEval-S baselines specifically; LoCoMo regression baselines
  reuse the existing cache.
- **Regression-check passes at `misses=0`** on 3 sampled items. The
  byte-compat write contract is intact end-to-end. Phase 12 Task 7 (λ₁
  tripwire) can dispatch against the warm cache without further verification.
- **Follow-up TODO (non-blocking):** plumb `hits/misses/failureCount` from
  the JS warmup-point JSON payload up into the Python orchestrator's
  summary dict (~30 LOC + 1 test). Today the regression-check verification
  required deriving `misses=0` from `cacheFilesDelta=0 + wallMs` shape +
  a Modal app-logs grep. Works, but a future maintainer shouldn't have to
  reconstruct it. Filed in the `a0c3bea` commit message.

## Lessons / skill patches

- **`batch-api-cache-warmup`** — added Modal vLLM offline batch as a third
  established warmup substrate alongside Fireworks Batch and
  parallel-live-HTTP. Documented the substrate-swap pattern's load-bearing
  invariant (cache key is a pure function of LLM inputs) and the
  cache-key alignment trap on the regression-check side: **every override
  on the write side must be threaded through to the read side, or
  `misses=0` is mathematically impossible.**
- **`modal/SKILL.md`** — already has extensive vLLM offline-batch coverage
  from the planning desk (sections 16 and 17, written 2026-04-25).
  Patched in the post-execution lessons: image plumbing traps not in
  Modal's template (DeepGEMM bundling, `add_python` shadow, `python3` →
  `python` symlink, MoE explicit-backend, JIT cache mount path), the
  smoke-timings-are-noise lesson, and the content-vs-engine triage rubric
  for N=1 empty-result anomalies (shuffle test).
- **`subagent-driven-development`** — no patch needed. The verbatim-source
  controller-takeover rule applied cleanly when Task 7 (this retro)
  came up; Task 6's regression-check fix (Option 2 patch) was small enough
  that controller takeover beat a fresh subagent dispatch.

## Phase status

Phase 12 Task 6.5 (Modal vLLM warmup): **closed**. Phase 12 Task 7 (λ₁
tripwire on LongMemEval-S): **unblocked**. Cache is warm, byte-compat
verified, override flags documented.
