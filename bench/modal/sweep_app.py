import modal
import json
from modal import FilePatternMatcher

app = modal.App("starmem-bench")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .run_commands(
        "apt-get update && apt-get install -y curl ca-certificates git",
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    .pip_install("wandb>=0.17", "weave>=0.51")
    .add_local_dir(
        "/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem",
        "/repo",
        # Exclude ephemeral + churning paths from the image build hash.
        # docs/bench/runs/ is actively written by fireworks-warmup.log etc.
        # during Fireworks jobs; if add_local_dir hashes a file that's
        # simultaneously being modified, Modal aborts with
        # "file was modified during build process". .gitignore is NOT
        # respected by Modal — must use FilePatternMatcher (a plain list
        # passed to ignore= errors with 'expected str, bytes or os.PathLike
        # object, not tuple' because Modal tuple-unpacks the sequence
        # internally).
        # bench/.cache is also excluded since _install_volume_symlink
        # replaces it with a Volume symlink at runtime anyway.
        #
        # Do NOT exclude .git/: bench/runner.js calls `git rev-parse HEAD`
        # at runtime to stamp envSnapshot.gitSha for reproducibility, and
        # without .git the whole baseline run errors out. The JS side has
        # a defensive fallback now, but shipping .git in the image keeps
        # artifact metadata accurate. .git is only ~few MB for this repo.
        ignore=FilePatternMatcher(
            "docs/bench/runs/**",
            "bench/.cache/**",
            "**/*.log",
            "node_modules/**",
            ".jest-cache/**",
        ),
    )
)

volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)

# Inject .env.bench into the container at function runtime.
# The extraction cache is keyed by (model, messages, maxTokens), so
# STARMEM_BENCH_LLM_MODEL must match what the cache was generated with
# — otherwise every lookup misses and the runner falls through to
# rule-based extraction, producing systematically fewer episodic facts.
# .env.bench is read from the host's cwd (repo root) at `modal run` time.
env_secret = modal.Secret.from_dotenv(filename=".env.bench")

# W&B observability — Phase 12+ instrumentation.
# Created once via: modal secret create wandb-secret WANDB_API_KEY=<key>
# Project: "STARmem". Entity inherits from the API key's default workspace.
# Attached only to orchestrators (run_baselines, run_sweep) — the per-cell
# point functions stay un-instrumented to avoid 4 (baselines) + 25 (batchsize)
# noisy runs flooding the dashboard. Aggregate-level only for week 1.
wandb_secret = modal.Secret.from_name("wandb-secret")
WANDB_PROJECT = "STARmem"


def _wandb_init(*, job_type: str, group: str, config: dict, tags: list):
    """Initialize a W&B run inside a Modal container.

    Returns the run object, or None if wandb is unavailable / WANDB_DISABLED
    is set. Caller is responsible for run.finish() — wrap in try/finally so
    Modal's ephemeral container teardown doesn't mark the run as crashed.

    Defensive: never let a logging failure kill a benchmark. Catches
    everything and falls through to None.
    """
    import os

    if os.environ.get("WANDB_DISABLED") == "1":
        return None
    try:
        import wandb
    except ImportError:
        return None
    try:
        return wandb.init(
            project=WANDB_PROJECT,
            job_type=job_type,
            group=group,
            config=config,
            tags=tags,
            reinit=True,
        )
    except Exception as exc:  # noqa: BLE001 — never crash bench on logging
        print(f"[wandb] init failed, continuing without logging: {exc}")
        return None


def _install_volume_symlink(link_path: str, target_path: str) -> None:
    """Install link_path -> target_path, evicting a real file/dir if one was
    copied in by add_local_dir. (Modal's add_local_dir ignores .gitignore by
    default, so bench/.cache/* gets copied into every container as a real
    directory. Without eviction, writes to link_path land on the container's
    ephemeral filesystem instead of the Volume, and volume.commit() commits
    nothing. Caught 2026-04-23 on Phase 12 Task 6 warmup smoke: 110 live
    Nano-GPT calls wrote 110 cache files, all ephemeral, cacheFilesDelta=0.)

    Idempotent: a correct pre-existing symlink is left alone. A real file
    or directory at link_path is removed first, then the symlink installs.
    """
    import os
    import shutil

    if os.path.islink(link_path):
        # Already a symlink — trust it. If it points somewhere wrong,
        # the caller will notice via write failures or missing reads.
        return
    if os.path.isdir(link_path):
        shutil.rmtree(link_path)
    elif os.path.exists(link_path):
        os.remove(link_path)
    os.symlink(target_path, link_path)


def stratified_longmemeval_indices(
    corpus_path: str,
    n: int,
    seed: int,
) -> list[int]:
    """Pick N stratified indices from the LongMemEval-S corpus.

    Groups items by `question_type` (6 canonical task types; see
    `bench/corpora/longmemeval.js::metadata.taskTypes`), seeds a PRNG,
    shuffles each group independently, and round-robins picks across
    groups until N is reached. Deterministic: same (corpus_path, n,
    seed) always returns the same list.

    Rationale (Phase 12 Task 6, 2026-04-23):
    The original plan assumed LoCoMo's extraction-cost model would
    transfer to LongMemEval-S. It didn't — per-item batches are 3×
    larger and per-item wall is 30×. Full-corpus warmup extrapolates to
    ~$16.50 per partition. Stratified n=50 preserves the per-task-type
    mismatch-detection signal at ~$1.65 and lets later partitions
    (different extractor, different BATCH_SIZE) stay iterable. See
    `docs/plans/phase-12-task-6-extraction-cost-decision.md`.

    Args:
        corpus_path: Absolute path to longmemeval_s_cleaned.json on the
            Volume (e.g. `/data/longmemeval_s_cleaned.json`).
        n: Total number of items to pick. Must satisfy 1 ≤ n ≤ len(corpus).
        seed: PRNG seed. Same seed = same indices = same cache keys.

    Returns:
        Sorted list of N integer indices into the corpus. Sorted to keep
        fan-out ordering stable and log lines easier to eyeball — the
        stratification logic already ran against the unsorted shuffles.
    """
    import json
    import random as _random

    if n < 1:
        raise ValueError(f"stratified n must be >= 1, got {n!r}")

    with open(corpus_path, "r") as f:
        corpus = json.load(f)

    if n > len(corpus):
        raise ValueError(
            f"stratified n={n} exceeds corpus size {len(corpus)}. "
            f"Use --corpus-size for non-stratified full-corpus runs."
        )

    # Group original indices by question_type. item["question_type"] is
    # present on every LongMemEval-S record per the canonical schema
    # (see bench/corpora/longmemeval.js:55); missing values would be a
    # corpus integrity bug, not a case to silently paper over.
    by_type: dict[str, list[int]] = {}
    for i, item in enumerate(corpus):
        qt = item.get("question_type")
        if qt is None:
            raise ValueError(
                f"corpus item at idx={i} missing question_type; cannot stratify. "
                f"Corpus file is likely corrupted or stale."
            )
        by_type.setdefault(qt, []).append(i)

    # Deterministic shuffle per type using a per-type derived seed so a
    # change in type-dict iteration order (unlikely on Py3.7+, but
    # theoretically) doesn't shift results.
    for qt, indices in by_type.items():
        r = _random.Random(f"{seed}|{qt}")
        r.shuffle(indices)

    # Round-robin pick across task types (canonical order, per adapter
    # metadata). Evens the per-type count: at n=50 / 6 types we get
    # 9, 9, 8, 8, 8, 8 picks. Any integer split works.
    type_order = sorted(by_type.keys())  # alphabetical for determinism
    picked: list[int] = []
    cursors = {qt: 0 for qt in type_order}
    while len(picked) < n:
        progress = False
        for qt in type_order:
            if len(picked) >= n:
                break
            c = cursors[qt]
            if c < len(by_type[qt]):
                picked.append(by_type[qt][c])
                cursors[qt] = c + 1
                progress = True
        if not progress:
            # Shouldn't happen given the n ≤ len(corpus) check, but guard
            # against any off-by-one in future edits.
            break

    return sorted(picked)


@app.function(image=image, volumes={"/data": volume}, timeout=600, memory=4096)
def hello():
    import os
    import subprocess
    corpus_exists = os.path.exists("/data/locomo10.json")
    cache_exists = os.path.exists("/data/extractions")
    return {
        "nodeVersion": subprocess.run(
            ["node", "--version"],
            cwd="/repo",
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip(),
        "corpusOnVolume": corpus_exists,
        "cacheOnVolume": cache_exists,
    }

@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=3000,   # was 1800: bumped 1500→1800 on 2026-04-26 was still
                    # under-spec. Re-dispatch with stderr streaming
                    # confirmed the work was progressing steadily, not
                    # wedged — just slow. Plan estimate (line 2725) was
                    # ~2000s warm-cache seeding per cell; 3000s gives
                    # 50% margin for tail items.
    memory=4096,
)
def run_point(overrides_json: str, corpus: str = "locomo", extractor_model: str = "") -> str:
    """Run a single sweep point.

    Args:
        overrides_json: JSON string of Record<string, number> overrides.
        corpus: Benchmark corpus to run against. 'locomo' or 'longmemeval-s'.
        extractor_model: Optional model override. When empty (default), inherits
            STARMEM_BENCH_LLM_MODEL from env_secret. When set (via
            --extractor-model on the CLI), overrides the env-secret default.
            The cache key is sha256(model + messages + maxTokens), so this
            MUST match the model used to populate the warm cache or every
            consolidate() call falls through to live extraction. Mirrors the
            same pattern as run_baseline_point (Phase 12 Task 6 / 6.5).

    Returns:
        JSON string with { overrides, metrics, latencyMs, runCount, wallMs }.
    """
    import os
    import subprocess

    # Symlink Volume cache to where the repo expects it.
    # NOTE: add_local_dir may or may not have copied bench/.cache/ into
    # /repo (depends on gitignore handling). If it did, the existing
    # guards prevent overwriting. If it didn't, we create the symlinks.
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(cache_link, "/data/extractions")
    if corpus == "longmemeval-s":
        longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
        _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")

    # Diagnostic: collect filesystem state before running Node.
    diag = {
        "repo_cache_contents": sorted(os.listdir(repo_cache)) if os.path.isdir(repo_cache) else None,
        "corpus_link_target": os.readlink(corpus_link) if os.path.islink(corpus_link) else "not-a-symlink",
        "corpus_link_size": os.path.getsize(corpus_link) if os.path.exists(corpus_link) else 0,
        "cache_link_target": os.readlink(cache_link) if os.path.islink(cache_link) else "not-a-symlink",
        "cache_link_isdir": os.path.isdir(cache_link),
        "modal_point_js_exists": os.path.exists("/repo/bench/sweeps/_modal-point.js"),
        "runner_js_exists": os.path.exists("/repo/bench/runner.js"),
        "node_modules_exists": os.path.exists("/repo/node_modules"),
    }

    env = os.environ.copy()
    env["STARMEM_OVERRIDES"] = overrides_json
    env["STARMEM_BENCH_CORPUS"] = corpus
    # Model override — when empty (default), inherit STARMEM_BENCH_LLM_MODEL
    # from env_secret. When set (via --extractor-model on the CLI), override
    # so cache keys are deterministic per-model. Cache is keyed on the
    # (model, messages, maxTokens) triple via extractionCache._cacheKey, so
    # a Phase 12 Task 7 sweep against the Qwen-warmed cache MUST pass
    # `--extractor-model "Qwen/Qwen3.6-35B-A3B-FP8"` or every consolidate()
    # call falls through to live extraction. See run_baseline_point and
    # docs/plans/phase-12-task-6-5-retro.md for the cache-key alignment trap.
    if extractor_model:
        env["STARMEM_BENCH_LLM_MODEL"] = extractor_model

    # Stream stderr live to this container's stdout so Modal's log shows
    # progress as the Node subprocess runs. capture_output=True buffers
    # everything until exit — on a SIGKILL (FunctionTimeoutError) the
    # buffered stderr is lost, leaving "empty logs" with no signal of
    # whether the work was progressing or wedged. Pattern matches
    # run_longmemeval_warmup_point and run_baseline_point (applied
    # 2026-04-23 across the sibling fan-out functions; missed here).
    # See devops/persist-serverless-compute-results — "Live subprocess
    # logging: stream, don't capture".
    #
    # stdout stays captured (Python reads it for the JSON payload).
    # stderr is merged into *this* process's stdout, which Modal
    # captures as function log output. Node side already routes harness
    # logs to stderr (bench/sweeps/_modal-point.js mirrors the warmup
    # convention); _modal-point.js's stdout is the metrics JSON payload.
    import sys
    proc = subprocess.Popen(
        ["node", "bench/sweeps/_modal-point.js"],
        cwd="/repo",
        stdout=subprocess.PIPE,
        stderr=sys.stdout,   # live to Modal's log stream
        text=True,
        env=env,
    )
    stdout_str, _ = proc.communicate()
    returncode = proc.returncode

    if returncode != 0:
        import json as _json
        # Commit volume even on error — partial cache writes from live
        # extractions are still valuable (survive to next run) even if
        # this point crashed before the Node subprocess completed
        # metrics computation. Guard against commit failures so an
        # error return isn't masked by a commit exception.
        try:
            volume.commit()
        except Exception:
            pass
        return _json.dumps({
            "error": "node subprocess failed",
            "returncode": returncode,
            # stderr was streamed live to Modal's log (merged into
            # parent stdout); nothing captured on the Python side.
            # Refer to Modal's function log for the full stderr trace.
            "stderr_note": "streamed live to Modal function log",
            "stdout_tail": stdout_str[-2000:] if stdout_str else "",
            "diagnostics": diag,
        }, indent=2)
    # 9.5 (2026-04-22): commit volume per-point so live extractions
    # written to /data/extractions survive container timeouts.
    # Previously commit only happened at run_sweep exit, which meant
    # a run_point timeout (e.g. 600s cap on BATCH_SIZE round with
    # ~500 live Nano-GPT calls @ ~1.3s/call) discarded every cached
    # extraction. Fix: per-point commit so a re-run picks up the
    # warm partial cache from the timed-out run. Minimal cost —
    # commit is fast when there are no pending writes.
    volume.commit()
    return stdout_str.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1200,   # Phase 13: per-chunk worst-case ~83 items × ~3.6s/item
                    # = ~300s wall + 4× headroom. Comfortably under the
                    # old run_point 3000s; chunked dispatch makes timeouts
                    # a non-issue. Tune downward if Phase 14 sweeps show
                    # stable per-chunk wall < 200s on this corpus.
    memory=4096,
)
def run_point_chunk(
    overrides_json: str,
    corpus: str,
    extractor_model: str,
    item_indices_json: str,
) -> str:
    """Run a single (overrides × item-chunk) sweep cell on a corpus slice.

    Phase 13 item-fan-out entry point. Mirrors run_point exactly except:
      - threads STARMEM_ITEM_INDICES env var to the Node subprocess
      - invokes bench/sweeps/_modal-chunk.js (which slices the corpus)
        instead of _modal-point.js (which runs the full corpus)
      - per-chunk timeout=1200s instead of run_point's 3000s

    Cell-level metrics aggregation happens in run_sweep, not here. This
    function emits per-chunk runs[] + advisory metrics; run_sweep groups
    by cell_idx, concatenates runs[], and recomputes metrics once per
    cell via the existing computeMetrics path.

    Args:
        overrides_json: JSON string of Record<string, number> overrides.
        corpus: 'locomo' or 'longmemeval-s'. Note: Phase 13 chunking
            heuristic (items // 80) means LoCoMo always runs as 1 chunk
            covering all 10 items, identical to the old run_point shape.
            LongMemEval-S full corpus = 6 chunks of ~83 items.
        extractor_model: Optional model override (see run_point docstring
            for cache-key alignment requirements).
        item_indices_json: JSON array of integer item indices into the
            corpus (e.g. "[0, 1, 2, ..., 82]"). Required — there is no
            "full corpus" sentinel; full-corpus runs go through run_point
            via run_sweep's chunks=1 path.

    Returns:
        JSON string with { overrides, itemIndices, runs, metrics,
        latencyMs, runCount, wallMs, aggStats }. The runs[] field is the
        raw HarnessRun array; cell-level recompute downstream concatenates
        across chunks.
    """
    import os
    import subprocess

    # Symlink Volume cache to where the repo expects it.
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(cache_link, "/data/extractions")
    if corpus == "longmemeval-s":
        longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
        _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")

    diag = {
        "repo_cache_contents": sorted(os.listdir(repo_cache)) if os.path.isdir(repo_cache) else None,
        "corpus_link_target": os.readlink(corpus_link) if os.path.islink(corpus_link) else "not-a-symlink",
        "corpus_link_size": os.path.getsize(corpus_link) if os.path.exists(corpus_link) else 0,
        "cache_link_target": os.readlink(cache_link) if os.path.islink(cache_link) else "not-a-symlink",
        "cache_link_isdir": os.path.isdir(cache_link),
        "modal_chunk_js_exists": os.path.exists("/repo/bench/sweeps/_modal-chunk.js"),
        "runner_js_exists": os.path.exists("/repo/bench/runner.js"),
        "node_modules_exists": os.path.exists("/repo/node_modules"),
    }

    env = os.environ.copy()
    env["STARMEM_OVERRIDES"] = overrides_json
    env["STARMEM_BENCH_CORPUS"] = corpus
    env["STARMEM_ITEM_INDICES"] = item_indices_json   # Phase 13: chunk slice
    if extractor_model:
        env["STARMEM_BENCH_LLM_MODEL"] = extractor_model

    # Stream stderr live to Modal's log stream — same Popen pattern as
    # run_point (post-2026-04-26 fix). Per-chunk wall-clock is short
    # enough (~300s) that buffering wouldn't be catastrophic, but
    # consistency with run_point + free progress visibility wins.
    import sys
    proc = subprocess.Popen(
        ["node", "bench/sweeps/_modal-chunk.js"],
        cwd="/repo",
        stdout=subprocess.PIPE,
        stderr=sys.stdout,
        text=True,
        env=env,
    )
    stdout_str, _ = proc.communicate()
    returncode = proc.returncode

    if returncode != 0:
        import json as _json
        try:
            volume.commit()
        except Exception:
            pass
        return _json.dumps({
            "error": "node subprocess failed",
            "returncode": returncode,
            "stderr_note": "streamed live to Modal function log",
            "stdout_tail": (stdout_str or "")[-2000:],
            "diagnostics": diag,
            "overrides_echo": overrides_json,
            "item_indices_echo": item_indices_json,
        })

    # Per-chunk volume.commit() — durability for cache writes from any
    # live extraction fall-through that happened in this chunk. Mirror
    # of run_point's pattern.
    try:
        volume.commit()
    except Exception:
        pass

    return stdout_str.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,
    memory=4096,
)
def run_baseline_point(
    retriever_id: str,
    corpus: str = "locomo",
    extractor_model: str = "",
    sample_indices_json: str = "",
) -> str:
    """Run one baseline retriever over the full corpus.

    Args:
        retriever_id: one of BASELINE_IDS ("ladder", "bm25only", "recency", "random").
        corpus: Benchmark corpus to run against. 'locomo' or 'longmemeval-s'.
        extractor_model: Optional model override. When empty (default), inherits
            STARMEM_BENCH_LLM_MODEL from env_secret. Must match the model used
            during warmup or the cache-keyed (model, messages, maxTokens) hash
            misses 100% and falls through to live extraction.
        sample_indices_json: Optional JSON-stringified array of integer indices.
            When non-empty, the Node baseline-point filters the corpus to
            exactly these items before running the harness. Pass the same
            indices that warmup used (see `stratified_longmemeval_indices`)
            for cache-hit alignment.

    Returns:
        JSON string with { retrieverId, metrics, latencyMs, runCount, wallMs, envSnapshot }.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(cache_link, "/data/extractions")
    if corpus == "longmemeval-s":
        longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
        _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")

    env = os.environ.copy()
    env["STARMEM_RETRIEVER_ID"] = retriever_id
    env["STARMEM_BENCH_CORPUS"] = corpus
    if extractor_model:
        env["STARMEM_BENCH_LLM_MODEL"] = extractor_model
    if sample_indices_json:
        env["STARMEM_SAMPLE_INDICES_JSON"] = sample_indices_json

    result = subprocess.run(
        ["node", "bench/baselines/_modal-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        import json as _json
        return _json.dumps({
            "error": "node subprocess failed",
            "retrieverId": retriever_id,
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
def run_batchsize_point(conv_idx: int, batch_size: int, corpus: str = "locomo") -> str:
    """Run one (conversation, BATCH_SIZE) cell.

    Args:
        conv_idx: 0-indexed conversation slot in LoCoMo-10.
        batch_size: BATCH_SIZE override to apply.
        corpus: Benchmark corpus to run against. 'locomo' or 'longmemeval-s'.

    Returns:
        JSON string with { convIdx, batchSize, metrics, consolidationStats,
        latencyMs, wallMs }.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(cache_link, "/data/extractions")
    if corpus == "longmemeval-s":
        longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
        _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")

    env = os.environ.copy()
    env["STARMEM_CONV_IDX"] = str(conv_idx)
    env["STARMEM_BATCH_SIZE"] = str(batch_size)
    env["STARMEM_BENCH_CORPUS"] = corpus

    result = subprocess.run(
        ["node", "bench/sweeps/_modal-batchsize-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        import json as _json
        # Commit volume even on error — partial cache writes from live
        # extractions are still valuable (survive to next run). Matches
        # run_baseline_point's 9.5 fix (2026-04-22). Previously this
        # function had NO commit on any path, so a run_batchsize sweep
        # that timed out discarded every cached extraction.
        try:
            volume.commit()
        except Exception:
            pass
        return _json.dumps({
            "error": "node subprocess failed",
            "convIdx": conv_idx,
            "batchSize": batch_size,
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
        }, indent=2)
    # Per-point commit so live extractions written to /data/extractions
    # survive container timeouts / OOMs. Matches run_baseline_point's
    # 9.5 pattern (commit is fast when there are no pending writes).
    volume.commit()
    return result.stdout.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,   # matches run_baseline_point's budget. 600s wasn't
                    # enough: LongMemEval-S items post-flatten-to-single-
                    # session (Decision 8) concatenate ~30-40 sessions
                    # into 400-800 turns, which at BATCH_SIZE batching
                    # produces 50-200+ extraction calls @ ~1.3s each.
                    # Item 0 hit the old 600s cold on Phase 12 Task 6's
                    # first smoke (2026-04-23) — bump matches the
                    # Phase 11 Task 6 pattern.
    memory=4096,
)
def run_longmemeval_warmup_point(
    item_idx: int,
    extractor_model: str = "",
    warmup_concurrency: int = 10,
    batch_size: int = 0,
) -> str:
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
    longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")
    _install_volume_symlink(cache_link, "/data/extractions")

    env = os.environ.copy()
    env["STARMEM_BENCH_CORPUS"] = "longmemeval-s"
    env["STARMEM_WARMUP_ITEM_IDX"] = str(item_idx)
    # REQUIRED: seedConversation's _resolveExtractor() gates live extraction
    # on this env var. Without it, warmup runs the rule-based extractor
    # and never populates the LLM cache. env_secret also supplies
    # STARMEM_BENCH_LLM_URL / STARMEM_BENCH_API_KEY / STARMEM_BENCH_LLM_MODEL
    # (matches what run_baseline_point relies on for live-extraction runs).
    env["STARMEM_BENCH_LIVE_EXTRACTOR"] = "1"
    # Model override — when empty (default), inherit STARMEM_BENCH_LLM_MODEL
    # from env_secret. When set (via --extractor-model on the CLI), override
    # so cache keys are deterministic per-model. Cache is keyed on the
    # (model, messages, maxTokens) triple via extractionCache._cacheKey,
    # so switching models partitions the cache rather than corrupting it.
    if extractor_model:
        env["STARMEM_BENCH_LLM_MODEL"] = extractor_model
    # K parallel extraction calls per item. Default 10 matches Fireworks
    # serverless's 10-concurrent-request cap. Nano-GPT tolerates higher
    # (we successfully ran K=16 on LongMemEval-S prior to the Fireworks
    # pivot). Override via --warmup-concurrency on the CLI; the Python
    # orchestrator passes it through here explicitly rather than relying
    # on env-var inheritance, because Modal containers don't inherit
    # driver-process env vars by default (caught 2026-04-23 Fireworks
    # smoke: prefix-style `STARMEM_WARMUP_CONCURRENCY=10 modal run` was
    # silently ignored, K defaulted to 16, Fireworks returned 429 on 94
    # of 106 batches).
    env["STARMEM_WARMUP_CONCURRENCY"] = str(warmup_concurrency)

    # BATCH_SIZE override — when batch_size > 0, propagate to the JS warmup
    # point as STARMEM_BATCH_SIZE. The JS side calls
    # setConstantOverrides({BATCH_SIZE: <int>}) before reading
    # CONSOLIDATION.BATCH_SIZE at the line-118 destructure, so the warmup
    # enumerator and the existing-pipeline cache-lookup path both see the
    # same value. Crucial for cache-key alignment: the Phase 12 Task 6.5
    # vLLM pre-warming dispatch enumerated at BS=15, and the live read
    # path keys cache lookups on the same (model, messages, maxTokens)
    # triple — so this re-extraction warmup MUST run at BS=15 too, or
    # `misses` jumps from 0 to ~100% (caught 2026-04-25 on the first
    # regression-check attempt). batch_size=0 is the explicit "use spec
    # default" signal and leaves the env var unset.
    if batch_size > 0:
        env["STARMEM_BATCH_SIZE"] = str(batch_size)

    # Start a background thread that commits the Volume every 60s while
    # the subprocess runs. Without this, a FunctionTimeoutError SIGKILLs
    # the container before the post-run volume.commit() can fire, and
    # every extraction cache entry written during the live run is lost
    # to the ether. (Learned the hard way on 2026-04-23: one 28-minute
    # run produced zero cache files on the Volume.)
    #
    # Matches the pattern flagged as pending at line 1561 ("periodic
    # volume.commit() so SIGKILL loses ≤1 min"). Per
    # sweep-cache-invalidation-audit: Option A (per-item commit) covers
    # clean exits; this adds the in-flight durability Option A alone
    # can't provide.
    import threading
    stop_commits = threading.Event()

    def _periodic_commit():
        while not stop_commits.wait(60):
            try:
                volume.commit()
            except Exception as e:  # noqa: BLE001
                # Best-effort; don't kill the subprocess over a
                # transient commit failure. Surface to Modal logs.
                print(f"[warmup periodic-commit] commit failed: {e}", flush=True)

    commit_thread = threading.Thread(target=_periodic_commit, daemon=True)
    commit_thread.start()

    # Stream stderr live to this container's stdout so Modal's live log
    # shows progress. capture_output=True buffers everything until exit,
    # which for a 28-min item means zero visibility plus total loss on
    # SIGKILL. Popen + line-iterate instead.
    #
    # stdout stays captured (Python reads it for the JSON payload).
    # stderr is merged into *this* process's stdout, which Modal
    # captures as function log output.
    import sys
    proc = subprocess.Popen(
        ["node", "bench/harness/_modal-warmup-point.js"],
        cwd="/repo",
        stdout=subprocess.PIPE,
        stderr=sys.stdout,   # live to Modal's log stream
        text=True,
        env=env,
    )
    stdout_str, _ = proc.communicate()
    returncode = proc.returncode

    # Halt the periodic committer and do a final commit covering any
    # writes between the last tick and now.
    stop_commits.set()
    commit_thread.join(timeout=5)
    try:
        volume.commit()
    except Exception as e:  # noqa: BLE001
        print(f"[warmup final-commit] commit failed: {e}", flush=True)

    if returncode != 0:
        import json as _json
        return _json.dumps({
            "error": "warmup subprocess failed",
            "itemIdx": item_idx,
            "returncode": returncode,
            # stderr was streamed live to Modal's log (merged into
            # parent stdout); nothing captured on the Python side.
            # Refer to Modal's function log for the full stderr trace.
            "stderr_note": "streamed live to Modal function log",
            "stdout_tail": stdout_str[-2000:] if stdout_str else "",
        }, indent=2)
    return stdout_str.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,
    memory=4096,
)
def run_longmemeval_warmup(
    corpus_size: int = 500,
    extractor_model: str = "",
    stratified_sample: int = 0,
    stratify_seed: int = 2026,
    warmup_concurrency: int = 10,
    batch_size: int = 0,
) -> dict:
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
        corpus_size: number of LongMemEval-S items to warm when
            stratified_sample is 0. Default 500 = full corpus
            post-flatten (Decision 8). Ignored when stratified_sample
            > 0.
        extractor_model: Optional model override (see run_baseline_point).
        stratified_sample: When > 0, pick N items via
            `stratified_longmemeval_indices` instead of `range(corpus_size)`.
            Preserves per-task-type signal at a fraction of the cost
            (Phase 12 Task 6 cost-decision, 2026-04-23).
        stratify_seed: PRNG seed for stratification. Same seed = same
            items = same cache keys between warmup and baselines.

    Returns:
        Summary dict with { warmedCount, failedCount, wallMs,
                            totalFactCount, cacheFilesBefore,
                            cacheFilesAfter, cacheFilesDelta,
                            sampledIndices, stratified, stratifySeed,
                            failures: [...] }.
    """
    import json
    import os
    import time

    cache_dir = "/data/extractions"
    os.makedirs(cache_dir, exist_ok=True)

    # Reload BEFORE the corpus existence check — the file is usually
    # uploaded via `modal volume put` just before this dispatch, and
    # without reload() the container sees a stale snapshot from its
    # cold-start and reports the file missing even when it's on the
    # Volume. (Fresh trap caught 2026-04-23 on Phase 12 Task 6 smoke.)
    volume.reload()

    # Preflight: LongMemEval-S corpus file must live on the Volume before
    # fan-out. We do NOT self-seed via urllib inside the orchestrator —
    # the file is ~265MB and Modal's Volume commit API rejects anything
    # over 16MB ("exceeds maximum supported by API"). The CLI's
    # `modal volume put` handles large files via multipart upload; the
    # commit-from-container path does not. Surface a clear error that
    # points at the upload_cache.py instructions instead of hanging on
    # a doomed commit() call.
    corpus_vol_path = "/data/longmemeval_s_cleaned.json"
    if not os.path.exists(corpus_vol_path):
        return {
            "error": "corpus missing on Volume",
            "corpusPath": corpus_vol_path,
            "fix": (
                "Run from repo root on the host:\n"
                "  # 1. Populate local cache (~265MB, one-off HF fetch)\n"
                "  node -e \"import('./bench/corpora/longmemeval.js')"
                ".then(m => m.loadLongMemEvalS({}).then(x => console.log('cached', x.length, 'items')))\"\n"
                "  # 2. Upload to Volume (CLI uses multipart; API path rejects >16MB)\n"
                "  modal volume put starmem-bench-data"
                " bench/.cache/longmemeval_s_cleaned.json /longmemeval_s_cleaned.json\n"
                "Then re-run: modal run bench/modal/sweep_app.py --mode warmup-longmemeval --corpus-size 1"
            ),
        }

    cache_files_before = len(os.listdir(cache_dir))

    # Resolve the item indices to dispatch. Stratified sampling wins over
    # corpus_size when both are set; corpus_size becomes a no-op
    # parameter (documented in the docstring) to avoid a silent override.
    if stratified_sample > 0:
        sampled_indices = stratified_longmemeval_indices(
            corpus_path=corpus_vol_path,
            n=stratified_sample,
            seed=stratify_seed,
        )
        stratified = True
    else:
        sampled_indices = list(range(corpus_size))
        stratified = False

    # Reify the indices on the Volume as a named artifact. Baselines
    # will read this same file so warmup and baselines operate on
    # exactly the same items. File is tiny (<4KB for n=500) so
    # committing is effectively free. Naming scheme partitions cleanly
    # on (n, seed): two runs with different seeds never collide.
    indices_filename = (
        f"sampled_items_n{stratified_sample}_seed{stratify_seed}.json"
        if stratified
        else f"sampled_items_full{corpus_size}.json"
    )
    indices_path = f"/data/{indices_filename}"
    with open(indices_path, "w") as f:
        json.dump({
            "n": len(sampled_indices),
            "seed": stratify_seed,
            "stratified": stratified,
            "indices": sampled_indices,
        }, f, indent=2)
    volume.commit()  # durable before fan-out reads it

    t0 = time.time()
    # starmap passes each tuple as (item_idx, extractor_model,
    # warmup_concurrency, batch_size). Threading batch_size through the
    # tuple keeps it explicit per-cell instead of relying on container env
    # inheritance (which Modal does NOT provide — same trap that bit
    # warmup_concurrency on 2026-04-23 Fireworks smoke). batch_size=0
    # means "no override, inherit live spec default."
    results_raw = list(run_longmemeval_warmup_point.starmap(
        ((i, extractor_model, warmup_concurrency, batch_size) for i in sampled_indices)
    ))

    warmed = []
    failed = []
    all_failed_items = []  # per-item allFailed=true: subprocess exited 0 but every batch rejected
    total_fact_count = 0
    total_failed_batches = 0
    total_batches = 0
    first_item_errors = []  # firstError from each all-failed item, for fast triage
    models_seen = set()
    urls_seen = set()
    # Collect firstError across ALL items with any failures, not just
    # allFailed ones. A partial-failure item (e.g. 94/106 rate-limited
    # on a Fireworks K=16 vs K=10 cap mismatch) is the exact case the
    # operator needs visibility on — the item isn't flagged allFailed
    # because some batches got through, but the cache is structurally
    # wrong for baselines. Caught 2026-04-23 on Fireworks Llama 3.3 70B
    # smoke: failures=94/106 on item 0 produced `firstItemErrors: []`
    # in the summary because allFailed was false. Fix: aggregate any
    # firstError seen, flag as partialFailure too.
    partial_failed_items = []  # items where failures > 0 but not all
    first_batch_errors = []  # firstError samples across any failing item
    for raw in results_raw:
        parsed = json.loads(raw)
        if "error" in parsed:
            failed.append(parsed)
        else:
            warmed.append(parsed)
            total_fact_count += parsed.get("factCount", 0) or 0
            total_failed_batches += parsed.get("failureCount", 0) or 0
            total_batches += parsed.get("batchCount", 0) or 0
            if parsed.get("modelResolved"):
                models_seen.add(parsed["modelResolved"])
            if parsed.get("urlHost"):
                urls_seen.add(parsed["urlHost"])
            failure_count = parsed.get("failureCount", 0) or 0
            batch_count = parsed.get("batchCount", 0) or 0
            if parsed.get("allFailed"):
                all_failed_items.append(parsed["itemIdx"])
            elif failure_count > 0:
                partial_failed_items.append({
                    "itemIdx": parsed["itemIdx"],
                    "failures": failure_count,
                    "batches": batch_count,
                })
            # Sample firstError across any failing item (all or partial),
            # cap at 3 samples to keep the summary legible.
            if failure_count > 0 and parsed.get("firstError") and len(first_batch_errors) < 3:
                first_batch_errors.append({
                    "itemIdx": parsed["itemIdx"],
                    "failures": failure_count,
                    "batches": batch_count,
                    "firstError": parsed["firstError"],
                })
            # Keep the original allFailed-only channel for backward compat.
            if parsed.get("allFailed") and parsed.get("firstError") and len(first_item_errors) < 3:
                first_item_errors.append({
                    "itemIdx": parsed["itemIdx"],
                    "firstError": parsed["firstError"],
                })

    volume.reload()  # pick up the fan-out's commits
    cache_files_after = len(os.listdir(cache_dir))

    # Items where every batch failed are de-facto failed, regardless of the
    # subprocess exit code. Surface this explicitly so a zero cacheFilesDelta
    # with zero failedCount never happens again (caught 2026-04-23 smoke #2).
    effective_warmed = [w for w in warmed if not w.get("allFailed")]

    return {
        "warmedCount": len(effective_warmed),
        "allFailedCount": len(all_failed_items),
        "failedCount": len(failed),
        "totalFactCount": total_fact_count,
        "totalFailedBatches": total_failed_batches,
        "totalBatches": total_batches,
        "modelsSeen": sorted(models_seen),
        "urlsSeen": sorted(urls_seen),
        "cacheFilesBefore": cache_files_before,
        "cacheFilesAfter": cache_files_after,
        "cacheFilesDelta": cache_files_after - cache_files_before,
        "wallMs": int((time.time() - t0) * 1000),
        "failures": failed[:10],  # cap for log legibility on Modal's output tail
        "allFailedItems": all_failed_items[:20],
        "firstItemErrors": first_item_errors,
        # Partial-failure visibility — items where some batches succeeded
        # and some failed (rate-limits, transient 5xx, single-batch
        # timeouts). Surfaces the exact triage info operators need when
        # `allFailed` is false but the cache still has holes.
        "partialFailedItems": partial_failed_items[:20],
        "partialFailedCount": len(partial_failed_items),
        "firstBatchErrors": first_batch_errors,
        "warmupConcurrency": warmup_concurrency,
        # Stratified-sample provenance — downstream baselines read this
        # same indices file so the two runs stay aligned.
        "stratified": stratified,
        "stratifySeed": stratify_seed if stratified else None,
        "sampledIndicesPath": indices_path,
        "sampledCount": len(sampled_indices),
    }


BASELINE_IDS = ["ladder", "bm25only", "recency", "random"]
BATCHSIZE_VALUES = [3, 5, 7, 10, 15]
BATCHSIZE_CONV_INDICES = [0, 1, 2, 3, 4]


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret, wandb_secret],
    timeout=1800,
    memory=4096,
)
def run_baselines(
    corpus: str = "locomo",
    extractor_model: str = "",
    stratified_sample: int = 0,
    stratify_seed: int = 2026,
) -> dict:
    """Fan out baseline retrievers to parallel containers.

    Args:
        corpus: Benchmark corpus to run against. 'locomo' or 'longmemeval-s'.
        extractor_model: Optional model override passed to each run_baseline_point.
            Must match the model used during any prior warmup run — cache keys
            are model-partitioned, so mismatched model strings hit 0% cache.
        stratified_sample: When > 0 and corpus == 'longmemeval-s', pass the
            same (n, seed) stratified indices that warmup used, so baselines
            evaluate exactly the items that were warmed. Mismatched
            (warmup_n, baseline_n) / (warmup_seed, baseline_seed) means
            100% cache miss on the un-warmed items.
        stratify_seed: PRNG seed — must equal the warmup's stratify_seed.

    Returns:
        Dict with keys:
            - report (str): rendered Markdown comparison table.
            - result_json (str): JSON-serialized payload (all 4 baselines' metrics).
            - run_dir (str): path inside the Modal Volume.
    """
    import json
    import os
    from datetime import datetime

    # Resolve the stratified-sample indices once here in the orchestrator
    # so all 4 retrievers see the same items. Reading from the Volume's
    # sampled_items_*.json would be the strictly-aligned approach, but
    # re-computing is cheap (<1ms for n=500), idempotent for the same
    # (corpus_path, n, seed), and avoids coupling baselines to a warmup
    # having run first. If the user runs baselines without prior warmup
    # and with stratified_sample>0, live extraction pays per item but
    # the indices are still deterministic.
    sample_indices_json = ""
    if corpus == "longmemeval-s" and stratified_sample > 0:
        corpus_vol_path = "/data/longmemeval_s_cleaned.json"
        if not os.path.exists(corpus_vol_path):
            return {
                "error": "corpus missing on Volume",
                "corpusPath": corpus_vol_path,
                "fix": "See run_longmemeval_warmup() error for upload steps.",
            }
        indices = stratified_longmemeval_indices(
            corpus_path=corpus_vol_path,
            n=stratified_sample,
            seed=stratify_seed,
        )
        sample_indices_json = json.dumps(indices)

    point_results = list(run_baseline_point.starmap(
        [(rid, corpus, extractor_model, sample_indices_json) for rid in BASELINE_IDS]
    ))
    points = [json.loads(pr) for pr in point_results]

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    # Partition run_dir on stratified (n, seed) so back-to-back runs at
    # different sample sizes don't overwrite each other's artifacts.
    stem_suffix = (
        f"-s{stratified_sample}-seed{stratify_seed}"
        if sample_indices_json
        else ""
    )
    run_dir = f"/data/runs/{ts}-baselines{stem_suffix}"
    os.makedirs(run_dir, exist_ok=True)

    result_payload = {
        "name": "baselines",
        "timestamp": ts,
        "corpus": corpus,
        "stratified": bool(sample_indices_json),
        "stratifiedSample": stratified_sample if sample_indices_json else None,
        "stratifySeed": stratify_seed if sample_indices_json else None,
        "sampledCount": (
            len(json.loads(sample_indices_json)) if sample_indices_json else None
        ),
        "points": points,
    }
    result_json_str = json.dumps(result_payload, indent=2)
    with open(f"{run_dir}/result.json", "w") as f:
        f.write(result_json_str)

    report = render_baselines_report(result_payload)
    with open(f"{run_dir}/report.md", "w") as f:
        f.write(report)

    volume.commit()

    # W&B logging — per-retriever summary + artifact upload.
    # Metrics are logged as a wandb.Table so the dashboard renders the
    # 4-retriever comparison as a sortable table out of the box. Each
    # retriever also gets a flat scalar log (retriever/<id>/<metric>)
    # so the run summary panel surfaces them without a query.
    wb_run = _wandb_init(
        job_type="baselines",
        group=corpus,
        config={
            "corpus": corpus,
            "extractor_model": extractor_model or None,
            "stratified_sample": stratified_sample or None,
            "stratify_seed": stratify_seed if stratified_sample else None,
            "retrievers": BASELINE_IDS,
        },
        tags=["phase-12", "baselines", corpus],
    )
    if wb_run is not None:
        try:
            import wandb

            table = wandb.Table(
                columns=["retriever", "mrr", "coverage", "n", "n_scored", "latency_ms_avg", "status"]
            )
            n_failed = 0
            for pt in points:
                rid = pt.get("retrieverId", "?")
                if "metrics" not in pt:
                    n_failed += 1
                    table.add_data(rid, None, None, None, None, None, "ERROR")
                    wandb.log({f"retriever/{rid}/status": "error"})
                    continue
                m = pt.get("metrics") or {}
                lat = pt.get("latencyMs") or {}
                lat_avg = lat.get("avg") if isinstance(lat, dict) else lat
                if not isinstance(lat_avg, (int, float)):
                    lat_avg = None
                table.add_data(
                    rid,
                    m.get("mrr"),
                    m.get("coverage"),
                    m.get("n"),
                    m.get("n_scored"),
                    lat_avg,
                    "ok",
                )
                # Flat scalars per retriever for summary panel + sweeps later
                wandb.log({
                    f"retriever/{rid}/mrr": m.get("mrr"),
                    f"retriever/{rid}/coverage": m.get("coverage"),
                    f"retriever/{rid}/n": m.get("n"),
                    f"retriever/{rid}/latency_ms_avg": lat_avg,
                })
            wandb.log({"baselines/comparison": table})
            wandb.summary["n_retrievers"] = len(points)
            wandb.summary["n_failed"] = n_failed

            artifact = wandb.Artifact(
                name=f"baselines-{corpus}{stem_suffix}",
                type="bench-result",
                metadata={
                    "corpus": corpus,
                    "timestamp": ts,
                    "retrievers": BASELINE_IDS,
                },
            )
            artifact.add_file(f"{run_dir}/result.json")
            artifact.add_file(f"{run_dir}/report.md")
            wb_run.log_artifact(artifact)
        except Exception as exc:  # noqa: BLE001
            print(f"[wandb] logging failed mid-run: {exc}")
        finally:
            wb_run.finish()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


def render_baselines_report(payload):
    """Render the four-retriever comparison as Markdown.

    Columns: retriever, MRR, Coverage, R@5, R@10, latency.
    Coverage comes from Task 4; if unavailable, emit '—'.

    Defensive: when a point has no 'metrics' key (i.e. the upstream
    run_baseline_point hit the error path and returned {"error": ...}),
    render an ERROR row with the stderr tail and skip it from invariant
    calculations. The structural invariant check requires both ladder
    and bm25only to have completed successfully; if either failed, the
    check is reported as N/A with the failing retriever called out.
    """
    lines = []
    lines.append(f"# Baselines comparison — {payload['timestamp']}")
    lines.append("")

    # Surface failed points first so they're impossible to miss.
    failed = [p for p in payload["points"] if "error" in p or "metrics" not in p]
    if failed:
        lines.append("## ⚠️  Failed retrievers")
        lines.append("")
        for pt in failed:
            rid = pt.get("retrieverId", "?")
            err = pt.get("error", "no metrics returned")
            rc = pt.get("returncode", "?")
            stderr_tail = (pt.get("stderr") or "")[-1000:]
            lines.append(f"### `{rid}` — {err} (returncode={rc})")
            lines.append("")
            if stderr_tail:
                lines.append("```")
                lines.append(stderr_tail.strip())
                lines.append("```")
                lines.append("")

    lines.append("| Retriever | MRR | Coverage | R@5 | R@10 | Latency (ms) |")
    lines.append("|---|---|---|---|---|---|")
    for pt in payload["points"]:
        rid = pt.get("retrieverId", "?")
        if "metrics" not in pt:
            lines.append(f"| `{rid}` | ERROR | — | — | — | — |")
            continue
        m = pt.get("metrics", {})
        mrr_v = m.get("mrr", float("nan"))
        cov = m.get("coverage", None)
        r5 = m.get("recallAtK", {}).get("5", float("nan"))
        r10 = m.get("recallAtK", {}).get("10", float("nan"))
        lat = pt.get("latencyMs", float("nan"))
        cov_cell = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        # Latency may be a dict ({avg, p50, p95, ...}) or a float depending on
        # which Node code path produced it. Coerce to a float for the cell.
        lat_val = lat.get("avg") if isinstance(lat, dict) else lat
        if not isinstance(lat_val, (int, float)):
            lat_val = float("nan")
        lines.append(
            f"| `{rid}` | {mrr_v:.4f} | {cov_cell} | {r5:.4f} | {r10:.4f} | {lat_val:.1f} |"
        )
    lines.append("")
    # Structural invariant — only computable when both points succeeded.
    ladder = next((p for p in payload["points"] if p.get("retrieverId") == "ladder"), None)
    bm25 = next((p for p in payload["points"] if p.get("retrieverId") == "bm25only"), None)
    if ladder and bm25 and "metrics" in ladder and "metrics" in bm25:
        delta = ladder["metrics"]["mrr"] - bm25["metrics"]["mrr"]
        verdict = "PASS" if delta >= -0.02 else "FAIL"
        lines.append(f"**Structural invariant (ladder ≥ bm25only − 0.02):** ladder_mrr − bm25only_mrr = {delta:+.4f} → **{verdict}**")
    else:
        missing = []
        if not ladder or "metrics" not in (ladder or {}):
            missing.append("ladder")
        if not bm25 or "metrics" not in (bm25 or {}):
            missing.append("bm25only")
        lines.append(f"**Structural invariant:** N/A — missing successful run for {', '.join(missing)}")
    report = "\n".join(lines)
    # Append per-task-type slice if any point carries it
    for pt in payload["points"]:
        if pt.get("metrics", {}).get("byTaskType"):
            report = _append_task_type_slice(report, pt["metrics"])
            break
    return report


ABS_DELTA_FLOOR = 0.005
"""Below this absolute Δmetric/Δknob on every point, the axis is considered
flat and no elbow is proposed. Field-validated against STARmem 9.5 false
positives — see docs/plans/phase-11-infrastructure-hardening.md Task 1."""


def _detect_elbow(points, knobs, primary_metric):
    """Python port of _driver.js detectElbow.

    Args:
        points: list of dicts with 'overrides' and 'metrics'.
        knobs: list of {name, values} dicts.
        primary_metric: string key into METRIC_ACCESSORS.

    Returns:
        dict with 'overrides' and 'rationale'.

    Phase 11 Task 1: zero-axis-Δ guard. When the primary axis has no
    meaningful variation (maxΔ/Δknob < ABS_DELTA_FLOOR across the whole
    point set), return spec defaults with a "held at spec" rationale
    instead of the sort-first-corner artifact. Field-validated against
    3 false positives in 9.5 (TIER2_TAU_CONFIDENCE, bm25 TAG×SUBJECT
    grid, relw axis).
    """
    ELBOW_RATIO = 0.1

    def accessor(m):
        # NOTE: JSON parses integer-looking keys as strings, so recallAtK/
        # precisionAtK come back keyed by "1", "3", "5", "10" — not ints.
        # All lookups in this module must use string keys.
        if primary_metric == "recallAt5":
            return m["recallAtK"]["5"]
        if primary_metric == "recallAt10":
            return m["recallAtK"]["10"]
        if primary_metric == "precisionAt3":
            return m["precisionAtK"]["3"]
        if primary_metric == "precisionAt5":
            return m["precisionAtK"]["5"]
        return m["mrr"]

    primary_knob = knobs[0]
    secondary_knobs = knobs[1:]

    elbows = []

    if not secondary_knobs:
        sorted_pts = sorted(points, key=lambda p: p["overrides"][primary_knob["name"]])
        elbow = _elbow_on_slice(sorted_pts, primary_knob["name"], accessor, ELBOW_RATIO)
        if elbow:
            elbows.append(elbow)
    else:
        groups = {}
        for p in points:
            key = ",".join(f"{k['name']}={p['overrides'][k['name']]}" for k in secondary_knobs)
            groups.setdefault(key, []).append(p)
        for group in groups.values():
            sorted_pts = sorted(group, key=lambda p: p["overrides"][primary_knob["name"]])
            elbow = _elbow_on_slice(sorted_pts, primary_knob["name"], accessor, ELBOW_RATIO)
            if elbow:
                elbows.append(elbow)

    if not elbows:
        # No slice surfaced an elbow. Two sub-cases distinguished by the
        # axis-wide maxΔ/Δknob:
        #   (1) Axis is flat (maxΔ < ABS_DELTA_FLOOR) — honest answer is
        #       "held at spec defaults, knob flat on this corpus."
        #   (2) Real data but no elbow shape — keep the pre-Phase-11
        #       fallback to highest-metric for backward compatibility.
        # Default overrides = first value of every knob. Convention
        # verified at Phase 11 plan-time for tau/bm25/hops/relw: each
        # SWEEP_CONFIGS entry lists the spec default first in `values`.
        default_overrides = {k["name"]: k["values"][0] for k in knobs}
        sorted_all = sorted(points, key=lambda p: p["overrides"][primary_knob["name"]])
        all_metrics = [accessor(p["metrics"]) for p in sorted_all]
        all_values = [p["overrides"][primary_knob["name"]] for p in sorted_all]
        all_deltas = []
        for i in range(len(all_metrics) - 1):
            dk = all_values[i + 1] - all_values[i]
            all_deltas.append(0 if dk == 0 else (all_metrics[i + 1] - all_metrics[i]) / dk)
        axis_max_delta = max((abs(d) for d in all_deltas), default=0.0)
        best = max(points, key=lambda p: accessor(p["metrics"]))
        best_metric = accessor(best["metrics"])
        if axis_max_delta < ABS_DELTA_FLOOR:
            return {
                "overrides": default_overrides,
                "rationale": (
                    f"Axis flat (maxΔ/Δknob = {axis_max_delta:.6f} ≤ {ABS_DELTA_FLOOR}); "
                    f"held at spec on {primary_knob['name']}. Highest observed "
                    f"{primary_metric} = {best_metric:.4f}."
                ),
            }
        return {
            "overrides": best["overrides"],
            "rationale": f"No clear elbow detected; fallback to highest {primary_metric} = {best_metric:.4f}.",
        }

    chosen = max(elbows, key=lambda e: e["metric"])
    return {
        "overrides": chosen["overrides"],
        "rationale": chosen["rationale"],
    }


def _elbow_on_slice(sorted_pts, primary_name, accessor, ratio):
    if len(sorted_pts) < 2:
        return None

    metrics = [accessor(p["metrics"]) for p in sorted_pts]
    primary_values = [p["overrides"][primary_name] for p in sorted_pts]

    deltas = []
    for i in range(len(metrics) - 1):
        delta_knob = primary_values[i + 1] - primary_values[i]
        deltas.append(0 if delta_knob == 0 else (metrics[i + 1] - metrics[i]) / delta_knob)

    max_delta = max(abs(d) for d in deltas)

    # Zero-axis-Δ guard (Phase 11 Task 1). If the axis has no meaningful
    # variation, the sort-first corner is not an elbow — it's an artifact
    # of the ratio=0.1×max_delta threshold collapsing to ~1e-12. Return
    # None so _detect_elbow's "no elbows found" branch surfaces a
    # flat-axis rationale instead of a false amendment.
    if max_delta < ABS_DELTA_FLOOR:
        return None

    threshold = ratio * max_delta + 1e-12

    for i, d in enumerate(deltas):
        if abs(d) <= threshold:
            return {
                "overrides": sorted_pts[i]["overrides"],
                "metric": metrics[i],
                "rationale": (
                    f"Elbow at {primary_name}={primary_values[i]} (metric={metrics[i]:.4f}). "
                    f"Δmetric/Δknob dropped to {abs(d):.6f} "
                    f"≤ {ratio}×maxΔ={threshold:.6f}. "
                    f"Chosen as the highest-metric elbow across secondary-knob slices."
                ),
            }
    return None


def _should_amend(baseline_metrics, candidate_metrics, min_mrr_delta=0.02, max_coverage_drop=0.05):
    """Python mirror of bench/render/amendment-rule.js::shouldAmend.

    Returns dict with keys {amend: bool, reason: str, mrr_delta: float, coverage_delta: float}.
    Catches subset-selection bias: MRR may climb because coverage falls (smaller answerable
    query subset), not because retrieval improved. Gate: ΔMRR ≥ 0.02 AND Δcoverage ≥ −5pp.
    """
    import math
    mrr_delta = candidate_metrics.get("mrr", float("nan")) - baseline_metrics.get("mrr", float("nan"))
    cov_delta = candidate_metrics.get("coverage", float("nan")) - baseline_metrics.get("coverage", float("nan"))

    if math.isnan(mrr_delta) or math.isnan(cov_delta):
        return {
            "amend": False,
            "reason": "Cannot amend: NaN in baseline or candidate metrics.",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    if mrr_delta < min_mrr_delta:
        return {
            "amend": False,
            "reason": f"ΔMRR = {mrr_delta:+.4f} < {min_mrr_delta} (below amendment threshold).",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    if cov_delta < -max_coverage_drop:
        return {
            "amend": False,
            "reason": f"ΔMRR = {mrr_delta:+.4f} ≥ {min_mrr_delta}, but coverage drops {-cov_delta * 100:.1f}pp > {max_coverage_drop * 100:.0f}pp allowed (subset-selection bias suspected).",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    return {
        "amend": True,
        "reason": f"ΔMRR = {mrr_delta:+.4f} ≥ {min_mrr_delta} and Δcoverage = {cov_delta * 100:+.1f}pp ≥ −{max_coverage_drop * 100:.0f}pp.",
        "mrr_delta": mrr_delta,
        "coverage_delta": cov_delta,
    }


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


def _append_task_type_slice(report: str, metrics: dict) -> str:
    """Append per-task-type slice and abstention count to a report when present."""
    if not metrics:
        return report
    by_tt = metrics.get("byTaskType")
    abstention = metrics.get("abstentionCount", 0)
    if not by_tt and abstention == 0:
        return report
    lines = [report.rstrip()]
    if by_tt:
        lines.append("")
        lines.append(render_by_task_type(by_tt, headline="### Per-task-type slice"))
    if abstention > 0:
        lines.append(f"\n**Abstention QAs excluded from scoring:** {abstention}")
    return "\n".join(lines) + "\n"


def render_tau_report(result, corpus_len, qa_count):
    """Port of tau.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "recallAt5"

    header = "| TIER2_TAU_CONFIDENCE | TIER2_TAU_GAP | recallAt5 | precisionAt3 | mrr | coverage | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tc = p["overrides"]["TIER2_TAU_CONFIDENCE"]
        tg = p["overrides"]["TIER2_TAU_GAP"]
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        cov = p["metrics"].get("coverage")
        cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tc} | {tg} | {r5} | {p3} | {mrr} | {cov_s} | {p50} | {p95} |")

    # Heatmap
    tau_gap_values = sorted({p["overrides"]["TIER2_TAU_GAP"] for p in result["points"]})
    tau_conf_values = sorted({p["overrides"]["TIER2_TAU_CONFIDENCE"] for p in result["points"]})
    gap_header = "               " + "".join(f"{v:.2f}".rjust(5) + "  " for v in tau_gap_values).rstrip()
    heatmap_rows = []
    for tc in tau_conf_values:
        cells = []
        for tg in tau_gap_values:
            point = next(
                (p for p in result["points"]
                 if p["overrides"]["TIER2_TAU_CONFIDENCE"] == tc and p["overrides"]["TIER2_TAU_GAP"] == tg),
                None,
            )
            val = f"{point['metrics']['recallAtK']['5']:.2f}" if point else "N/A"
            cells.append(val.rjust(5))
        heatmap_rows.append(f"  {str(tc).ljust(4)}   {'  '.join(cells)}")

    # Spec amendment
    current_tau_conf = 2.0
    current_tau_gap = 0.5
    e_conf = result["elbow"]["overrides"]["TIER2_TAU_CONFIDENCE"]
    e_gap = result["elbow"]["overrides"]["TIER2_TAU_GAP"]
    conf_deviation = abs(e_conf - current_tau_conf) / current_tau_conf
    gap_deviation = abs(e_gap - current_tau_gap) / current_tau_gap
    needs_amendment = conf_deviation > 0.5 or gap_deviation > 0.5

    if needs_amendment:
        amendment_section = (
            f"**Proposed amendment:**\n\n"
            f"- TIER2_TAU_CONFIDENCE: {current_tau_conf} → {e_conf}\n"
            f"- TIER2_TAU_GAP: {current_tau_gap} → {e_gap}\n\n"
            f"Rationale: elbow is >50% away from current spec values ({conf_deviation*100:.0f}% / {gap_deviation*100:.0f}% deviation)."
        )
    else:
        amendment_section = "No amendment needed — elbow within 50% of current spec."

    # Amendment verdict (Phase 11 Task 4)
    baseline_pt = result["points"][0] if result["points"] else None
    candidate_pt = None
    if baseline_pt and result["elbow"].get("overrides"):
        candidate_pt = next(
            (p for p in result["points"]
             if all(p["overrides"].get(k) == v for k, v in result["elbow"]["overrides"].items())),
            None,
        )
    if baseline_pt and candidate_pt and candidate_pt is not baseline_pt:
        verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
        amendment_verdict_block = (
            f"\n### Amendment verdict\n\n"
            f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
        )
    else:
        amendment_verdict_block = "\n### Amendment verdict\n\nNo distinct candidate point found — held at spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    rows_joined = "\n".join(rows)
    heatmap_rows_joined = "\n".join(heatmap_rows)

    report = f"""# τ sweep — {today}

|**Corpus:** {corpus_len} conversations, {qa_count} QA items
|**Primary metric:** {primary_metric}

## Points

{header}
{separator}
{rows_joined}

## Heatmap (primary = {primary_metric})

               TIER2_TAU_GAP
{gap_header}
TIER2_TAU_CONFIDENCE
{heatmap_rows_joined}

## Elbow

**Recommended overrides:** `{json.dumps(result['elbow']['overrides'])}`
**Rationale:** {result['elbow']['rationale']}

## Spec amendment proposal

{amendment_section}{amendment_verdict_block}

## Environment snapshot

{env_block}
"""
    return report


def render_bm25_report(result, corpus_len, qa_count, tags_stats):
    """Port of bm25.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "mrr"

    tags_rate_pct = f"{tags_stats['rate'] * 100:.1f}"
    tags_line = f"**Tags populated rate:** {tags_rate_pct}% of {tags_stats['n']} episodic entries have non-empty tags."
    tags_interpretation = (
        "(If <5%, TAG_BOOST axis is meaningless on this corpus; treat tag-axis results as structural, not signal.)"
        if tags_stats["rate"] < 0.05 else ""
    )

    header = "| TAG_BOOST | SUBJECT_BOOST | recallAt5 | precisionAt3 | mrr | coverage | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tb = p["overrides"]["TAG_BOOST"]
        sb = p["overrides"]["SUBJECT_BOOST"]
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        cov = p["metrics"].get("coverage")
        cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tb} | {sb} | {r5} | {p3} | {mrr} | {cov_s} | {p50} | {p95} |")

    # Heatmap
    subject_values = sorted({p["overrides"]["SUBJECT_BOOST"] for p in result["points"]})
    tag_values = sorted({p["overrides"]["TAG_BOOST"] for p in result["points"]})
    subj_header = "               " + "".join(f"{str(v).rjust(5)}  " for v in subject_values).rstrip()
    heatmap_rows = []
    for tb in tag_values:
        cells = []
        for sb in subject_values:
            point = next(
                (p for p in result["points"]
                 if p["overrides"]["TAG_BOOST"] == tb and p["overrides"]["SUBJECT_BOOST"] == sb),
                None,
            )
            val = f"{point['metrics']['mrr']:.2f}" if point else "N/A"
            cells.append(val.rjust(5))
        heatmap_rows.append(f"  {str(tb).ljust(4)}   {'  '.join(cells)}")

    # Flatness check
    all_primary = [p["metrics"]["mrr"] for p in result["points"]]
    max_primary = max(all_primary)
    min_primary = min(all_primary)
    is_flat = (max_primary - min_primary) < 0.01

    e_tag = result["elbow"]["overrides"]["TAG_BOOST"]
    e_sub = result["elbow"]["overrides"]["SUBJECT_BOOST"]

    if is_flat:
        interpretation_branch = (
            f"### Branch C — flat heatmap (max - min of primary metric < 0.01 across all 16 cells)\n"
            f"Rule-based extractor can't exercise tag/subject asymmetry on this corpus. Defer to sub-phase 9.5 for meaningful numbers. Tags populated rate of {tags_rate_pct}% confirms the mechanism."
        )
    elif e_sub > e_tag:
        interpretation_branch = (
            f"### Branch A — subject > tag (elbow has SUBJECT_BOOST > TAG_BOOST)\n"
            f"As-expected: subject matches dominate in well-formed retrievals.\n"
            f"Consider accepting SUBJECT_BOOST={e_sub} as a spec amendment if >50% from current default."
        )
    else:
        interpretation_branch = (
            f"### Branch B — tag > subject (elbow has TAG_BOOST > SUBJECT_BOOST)\n"
            f"Investigate: suggests entries have bogus tags or subject-extraction is weak. Do NOT amend spec without root-cause inspection."
        )

    current_tag_boost = 2
    current_subject_boost = 2
    tag_deviation = abs(e_tag - current_tag_boost) / current_tag_boost
    subj_deviation = abs(e_sub - current_subject_boost) / current_subject_boost
    needs_amendment = tag_deviation > 0.5 or subj_deviation > 0.5

    if needs_amendment:
        amendment_section = (
            f"**Proposed amendment:**\n\n"
            f"- TAG_BOOST: {current_tag_boost} → {e_tag}\n"
            f"- SUBJECT_BOOST: {current_subject_boost} → {e_sub}\n\n"
            f"Rationale: elbow is >50% away from current spec values ({tag_deviation*100:.0f}% / {subj_deviation*100:.0f}% deviation)."
        )
    else:
        amendment_section = "No amendment needed — elbow within 50% of current spec."

    # Amendment verdict (Phase 11 Task 4)
    baseline_pt = result["points"][0] if result["points"] else None
    candidate_pt = None
    if baseline_pt and result["elbow"].get("overrides"):
        candidate_pt = next(
            (p for p in result["points"]
             if all(p["overrides"].get(k) == v for k, v in result["elbow"]["overrides"].items())),
            None,
        )
    if baseline_pt and candidate_pt and candidate_pt is not baseline_pt:
        verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
        amendment_verdict_block = (
            f"\n### Amendment verdict\n\n"
            f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
        )
    else:
        amendment_verdict_block = "\n### Amendment verdict\n\nNo distinct candidate point found — held at spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    rows_joined = "\n".join(rows)
    heatmap_rows_joined = "\n".join(heatmap_rows)

    report = f"""# BM25 boost sweep — {today}

**Corpus:** {corpus_len} conversations, {qa_count} QA items
**Primary metric:** {primary_metric}
{tags_line}
{tags_interpretation}

## Per-pair metrics table

{header}
{separator}
{rows_joined}

## Heatmap (primary = {primary_metric})

              SUBJECT_BOOST
{subj_header}
TAG_BOOST
{heatmap_rows_joined}

## Elbow

**Recommended overrides:** `{json.dumps(result['elbow']['overrides'])}`
**Rationale:** {result['elbow']['rationale']}

## Interpretation

{interpretation_branch}

## v2.1 tokenizer refactor note

If the elbow suggests fractional values would help (any "would like X.5"
indication from Phase 3's retro), a v2.1 refactor is warranted at
`src/retrieval/bm25.js:62-63`:

```js
// Current (integer-only):
...repeat(subjectTokens, RETRIEVAL.SUBJECT_BOOST),
...repeat(tagTokens, RETRIEVAL.TAG_BOOST),

// Proposed (fractional-capable): per-token weight multiplier into the
// BM25 scoring matrix instead of token replication. Requires bm25.js
// interface change; downstream effect on tier2-bm25.js scoring path.
```

Not in scope for Phase 9 — note only.

## Spec amendment proposal

{amendment_section}{amendment_verdict_block}

## envSnapshot

{env_block}
"""
    return report


def render_single_axis_report(result, corpus_len, qa_count, corpus="locomo"):
    """Generic single-knob sweep renderer.

    Used by the 9.5 `hops` and `relw` sweeps, both of which vary a single
    graph-tier knob with TIER2_TAU_GAP=10 pinned in every grid point. Emits
    a compact table (axis value → primary metric + secondary metrics) plus
    a per-row ΔMRR column vs the sweep's own baseline (point with the
    smallest primary-knob value). No heatmap — single axis.

    Phase 12 Task 7 reuses for `lambda1_tripwire` on LongMemEval-S — `corpus`
    parameterizes the corpus label so the report says LongMemEval-S not LoCoMo.
    """
    import json
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    points = result["points"]
    if not points:
        return f"# {result['name']} sweep — {today}\n\nNo points returned.\n"

    # Identify the swept knob (exclude inlined baseOverrides like TIER2_TAU_GAP)
    overrides0 = points[0]["overrides"]
    # The swept knob is the one with distinct values across points; baseOverrides
    # are identical across all points.
    swept_knob = None
    for k in overrides0:
        distinct = {p["overrides"].get(k) for p in points}
        if len(distinct) > 1:
            swept_knob = k
            break
    if swept_knob is None:
        # Degenerate (1-point grid) — fall back to first non-baseOverride key
        swept_knob = next(iter(overrides0))

    sorted_pts = sorted(points, key=lambda p: p["overrides"][swept_knob])
    baseline_mrr = sorted_pts[0]["metrics"]["mrr"]

    header = f"| {swept_knob} | n_scored | recallAt5 | mrr | coverage | ΔMRR vs min | p50 | p95 |"
    sep = "|---|---|---|---|---|---|---|---|---|"
    rows = []
    for p in sorted_pts:
        v = p["overrides"][swept_knob]
        n_scored = p["metrics"].get("n_scored", "-")
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        mrr = p["metrics"]["mrr"]
        cov = p["metrics"].get("coverage")
        cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        delta = mrr - baseline_mrr
        mrr_s = f"{mrr:.4f}"
        delta_s = f"{delta:+.4f}"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {v} | {n_scored} | {r5} | {mrr_s} | {cov_s} | {delta_s} | {p50} | {p95} |")

    elbow = result.get("elbow", {})
    elbow_overrides = elbow.get("overrides", {})
    elbow_rationale = elbow.get("rationale", "—")
    base_overrides = {k: v for k, v in overrides0.items() if k != swept_knob}
    base_block = (
        f"**Base overrides (inlined into every point):** `{json.dumps(base_overrides)}`\n"
        if base_overrides else ""
    )

    # Amendment verdict (Phase 11 Task 4)
    baseline_pt = sorted_pts[0] if sorted_pts else None
    candidate_pt = None
    if baseline_pt and elbow_overrides:
        candidate_pt = next(
            (p for p in points
             if all(p["overrides"].get(k) == v for k, v in elbow_overrides.items())),
            None,
        )
    if baseline_pt and candidate_pt and candidate_pt is not baseline_pt:
        verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
        amendment_verdict_block = (
            f"\n### Amendment verdict\n\n"
            f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
        )
    else:
        amendment_verdict_block = "\n### Amendment verdict\n\nNo distinct candidate point found — held at spec."

    report = f"""# {result["name"]} sweep — {today}

**Corpus:** {"LongMemEval-S" if corpus == "longmemeval-s" else "LoCoMo"}-{corpus_len} ({qa_count} QA items, live extraction)
**Swept:** {swept_knob}
{base_block}
## Results

{header}
{sep}
{chr(10).join(rows)}

## Elbow

**Recommended:** `{json.dumps(elbow_overrides)}`
**Rationale:** {elbow_rationale}{amendment_verdict_block}
"""
    return report


# 9.5: single-axis graph-tier sweeps need TIER2_TAU_GAP=10 inlined into
# every grid point so queries actually reach Tier 3 (without it, Tier 2
# gating short-circuits and the knob is inert by construction). Phase 12
# Task 7 adds lambda1_tripwire, which additionally needs BATCH_SIZE=15
# inlined for cache-key alignment with the Modal vLLM warmed cache (see
# docs/plans/phase-12-task-6-5-retro.md). Centralized as a table so the
# next single-axis sweep doesn't have to touch run_sweep's body.
#
# Both keys ARE swept (BATCH_SIZE in _SWEPT_CONSOLIDATION_KEYS, TIER2_TAU_GAP
# in _SWEPT_RETRIEVAL_KEYS) so setConstantOverrides accepts them — the
# inlining route through STARMEM_OVERRIDES → bench/runner.js's
# setConstantOverrides(overrides) is the same path that the swept knob
# itself rides.
_SWEEP_BASE_OVERRIDES = {
    "hops": {"TIER2_TAU_GAP": 10},
    "relw": {"TIER2_TAU_GAP": 10},
    # lambda1_tripwire: BATCH_SIZE=15 + WORKING_BUFFER_THRESHOLD=15 must
    # ride together. Runtime drains min(BATCH_SIZE, buffer.length) per
    # consolidate fire — when threshold (default 10) < BATCH_SIZE (15),
    # consolidate always slices 10-turn chunks, but the warmed cache is
    # keyed on 15-turn chunks → 100% cache miss → live fallback → 400.
    # Phase 12 Task 7 cache-key alignment fix; see Task 6.5 retro.
    "lambda1_tripwire": {"TIER2_TAU_GAP": 10, "BATCH_SIZE": 15, "WORKING_BUFFER_THRESHOLD": 15},
}


SWEEP_CONFIGS = {
    "tau": {
        # 9.5: restored to the Phase 9 Task 4 full grid (48 points) so the
        # renderer's heatmap is populated. 9.4.8 had trimmed this to a
        # 4-knob validation config after amending gap=10; 9.5 re-sweeps
        # under live extraction to detect whether the gap=10 plateau holds
        # or the elbow shifts on Gemma-extracted facts.
        "knobs": [
            {"name": "TIER2_TAU_CONFIDENCE", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
            {"name": "TIER2_TAU_GAP",        "values": [0.1, 0.3, 0.5, 1.0, 3.0, 10.0]},
        ],
        "primary_metric": "recallAt5",
        "renderer": render_tau_report,
    },
    "bm25": {
        # 9.5: restored from 9.4.8's 2-knob validation config to the full
        # 4×4 grid so render_bm25_report emits a heatmap.
        "knobs": [
            {"name": "TAG_BOOST",     "values": [1, 2, 3, 4]},
            {"name": "SUBJECT_BOOST", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_bm25_report,
    },
    "hops": {
        # 9.5: TIER3_MAX_HOPS sweep (Phase 9 left this knob uncovered).
        # Every point runs with TIER2_TAU_GAP=10 baseOverride so queries
        # reach Tier 3 (same invariant as GRAPH_ROUNDS). Inline the
        # baseOverride into each grid point because run_sweep doesn't
        # honor a config["base_overrides"] key — it hands `grid` directly
        # to run_point.map.
        "knobs": [
            {"name": "TIER3_MAX_HOPS", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_single_axis_report,
    },
    "relw": {
        # 9.5: EXPLICIT_RELATION_WEIGHT sweep (Phase 9 left this knob
        # uncovered). Same gap=10 inlining as hops.
        "knobs": [
            {"name": "EXPLICIT_RELATION_WEIGHT", "values": [0.5, 1.0, 1.5, 2.0, 3.0]},
        ],
        "primary_metric": "mrr",
        "renderer": render_single_axis_report,
    },
    "lambda1_tripwire": {
        # Phase 12 Task 7: LongMemEval-S tripwire for Tier 3 edge-weight knob.
        # Phase 9.5 three-time reproduced λ₁ as INERT on LoCoMo single-session.
        # Tripwire asks whether multi-session corpus surfaces signal.
        # Spec default TIER3_LAMBDA_1 = 1.0 (constants.js); grid brackets it.
        # Base overrides (inlined per-point via _SWEEP_BASE_OVERRIDES):
        #   - TIER2_TAU_GAP=10 — same Tier 3 reachability invariant as hops/relw
        #   - BATCH_SIZE=15 — cache-key alignment with Modal vLLM warmed cache
        #     (Phase 12 Task 6.5: warmed at BS=15, must be read at BS=15).
        "knobs": [
            {"name": "TIER3_LAMBDA_1", "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
        ],
        "primary_metric": "mrr",
        "renderer": render_single_axis_report,
    },
}


# 9.4.9 — graph sweep coordinate descent.
# Mirrors bench/sweeps/graph.js:254-269. Each round pins previous
# rounds' winners as baseOverrides and sweeps one knob. Winner =
# point with highest MRR in the round. TIER3_SEEDS_K round is new
# in 9.4.9 (was pinned at spec default 3 pre-9.4.8).
GRAPH_ROUNDS = [
    {"name": "lambda_1",     "knob": "TIER3_LAMBDA_1",      "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
    {"name": "lambda_2",     "knob": "TIER3_LAMBDA_2",      "values": [0.1, 0.2, 0.3, 0.4, 0.5]},
    {"name": "beam",         "knob": "TIER3_BEAM_WIDTH",    "values": [3, 5, 8, 10]},
    {"name": "seeds_k",      "knob": "TIER3_SEEDS_K",       "values": [1, 3, 5, 7]},
    {"name": "edge_cap",     "knob": "EDGE_CAP_PER_ENTRY",  "values": [10, 15, 20, 30, 50]},
    {"name": "cooccurrence", "knob": "COOCCURRENCE_WEIGHT", "values": [0.25, 0.5, 0.75, 1.0]},
]

# Every point in every graph round runs with TIER2_TAU_GAP=10
# (9.4.8 amendment). Without this baseOverride, Tier 2 shortcut fires
# for most queries and graph knobs don't affect retrieval because
# queries never reach Tier 3.
GRAPH_BASE_OVERRIDES = {"TIER2_TAU_GAP": 10}


def render_graph_report_stub(payload):
    """9.4.9 — full graph sweep renderer.

    Replaces the minimal stub from Task 2. Ports bench/sweeps/graph.js's
    renderReport() structure, with one intentional deviation: the JS
    reference used a synthesized Tier-2-only baseline row (via a
    TIER2_TAU_CONFIDENCE=0.01 forced-exit probe) because 9.4.6 measured
    the ladder as structurally broken and needed a non-Tier-3 reference
    point. Post-9.4.8 the baseline is TIER2_TAU_GAP=10 alone
    (MRR 0.8077 from baseline.json), so the Python renderer compares
    against that directly — no separate baseline probe required.

    Name kept as `_stub` for backward compat with existing call sites;
    rename to `render_graph_report` is a trivial follow-up.
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    rounds = payload["rounds"]
    base = payload["base_overrides"]
    composite = payload["composite_elbow"]["overrides"]

    # Gap=10-alone baseline MRR (from docs/bench/baseline.json measured at
    # commit 10f7372, validation sweep confirmed at cb30323).
    BASELINE_GAP10_MRR = 0.8077
    # Post-9.4.8 baseline coverage: gap=10 produces n_scored=1277 on
    # LoCoMo-10, = 64.3%. This is DIFFERENT from baseline.json's
    # "~71% of QAs" which was measured pre-amendment at gap=0.5.
    # The coverage warning fires on deviations >5pp from this.
    BASELINE_COVERAGE_PCT = 64.3
    AMENDMENT_THRESHOLD = 0.02  # per plan decision 5
    COVERAGE_FLOOR_DELTA_PCT = 5.0

    # Per-round sections
    round_sections = []
    for idx, r in enumerate(rounds):
        knob = r["knob"]
        # Build base-overrides string reflecting previous rounds' winners.
        prev_overrides = dict(base)
        for prev_idx in range(idx):
            prev = rounds[prev_idx]
            prev_overrides[prev["knob"]] = prev["winner"]["value"]

        header = f"| {knob} | n_scored | recallAt5 | precisionAt3 | mrr | coverage | p50 | p95 | ΔMRR vs gap=10 |"
        separator = "|---|---|---|---|---|---|---|---|---|---|"
        rows = []
        has_coverage_drop = False
        for p in r["points"]:
            v = p["overrides"][knob]
            m = p["metrics"]
            n_scored = m.get("n_scored", "—")
            r5 = f"{m['recallAtK']['5']:.4f}"
            p3 = f"{m['precisionAtK']['3']:.4f}"
            mrr = m["mrr"]
            mrr_str = f"{mrr:.4f}"
            cov = m.get("coverage")
            cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
            lift = mrr - BASELINE_GAP10_MRR
            lift_str = f"{lift:+.4f}"
            p50 = f"{p['latencyMs']['p50']:.2f}"
            p95 = f"{p['latencyMs']['p95']:.2f}"
            # Coverage: flag if deviation > COVERAGE_FLOOR_DELTA_PCT from
            # post-9.4.8 baseline. Below BASELINE - 5pp means the knob
            # traded coverage for precision, and the MRR is computed
            # over a smaller, possibly-easier subset.
            coverage_pct = (cov * 100) if isinstance(cov, (int, float)) else None
            n_scored_cell = f"{n_scored}"
            if coverage_pct is not None and abs(coverage_pct - BASELINE_COVERAGE_PCT) > COVERAGE_FLOOR_DELTA_PCT:
                n_scored_cell = f"⚠️ {n_scored}"
                has_coverage_drop = True
            # Bold the winner row
            is_winner = v == r["winner"]["value"]
            v_cell = f"**{v}**" if is_winner else str(v)
            rows.append(
                f"| {v_cell} | {n_scored_cell} | {r5} | {p3} | "
                f"{mrr_str} | {cov_s} | {p50} | {p95} | {lift_str} |"
            )
        rows_joined = "\n".join(rows)

        winner_mrr = r["winner"]["mrr"]
        round_lift = winner_mrr - BASELINE_GAP10_MRR
        amend_flag = " **(clears amendment threshold)**" if round_lift >= AMENDMENT_THRESHOLD else ""

        coverage_warning = ""
        if has_coverage_drop:
            coverage_warning = (
                "\n\n> **⚠️ Coverage warning:** at least one point in this round deviates "
                f">{COVERAGE_FLOOR_DELTA_PCT}pp from post-9.4.8 baseline coverage "
                f"(~{BASELINE_COVERAGE_PCT:.0f}%). MRR gains may reflect subset-selection bias — "
                "the knob traded coverage for per-query precision. Verify against recall@5 on "
                "the full corpus before amending."
            )

        prev_overrides_json = json.dumps(prev_overrides)

        round_sections.append(
            f"## Round — {knob}\n\n"
            f"**Base overrides:** `{prev_overrides_json}`\n\n"
            f"{header}\n{separator}\n{rows_joined}\n\n"
            f"**Winner:** `{knob} = {r['winner']['value']}` "
            f"(mrr={winner_mrr:.4f}, ΔMRR vs gap=10 = {round_lift:+.4f})"
            f"{amend_flag}"
            f"{coverage_warning}"
        )

    rounds_joined = "\n\n".join(round_sections)

    # Composite elbow: all winners stacked.
    composite_mrr = rounds[-1]["winner"]["mrr"] if rounds else None
    composite_lift = (composite_mrr - BASELINE_GAP10_MRR) if composite_mrr is not None else 0.0
    composite_verdict = (
        f"clears amendment threshold ({AMENDMENT_THRESHOLD:.2f})"
        if composite_lift >= AMENDMENT_THRESHOLD
        else f"below amendment threshold ({AMENDMENT_THRESHOLD:.2f}) — composite is noise-level"
    )

    # Per-knob spec defaults for the amendment proposal section.
    # Source: src/core/constants.js, pre-9.4.9 defaults.
    spec_defaults = {
        "TIER3_LAMBDA_1": 1.0,
        "TIER3_LAMBDA_2": 0.3,
        "TIER3_BEAM_WIDTH": 5,
        "TIER3_SEEDS_K": 3,
        "EDGE_CAP_PER_ENTRY": 20,
        "COOCCURRENCE_WEIGHT": 0.5,
    }
    baseline_metrics = {"mrr": BASELINE_GAP10_MRR, "coverage": BASELINE_COVERAGE_PCT / 100}
    amendment_lines = []
    for r in rounds:
        knob = r["knob"]
        spec = spec_defaults.get(knob)
        measured = r["winner"]["value"]
        if spec is None:
            continue

        winner_point = next(
            (p for p in r["points"] if p["overrides"][knob] == measured),
            None,
        )
        if winner_point:
            verdict = _should_amend(baseline_metrics, winner_point["metrics"])
        else:
            verdict = {"amend": False, "reason": "Winner point not found in round."}

        if verdict["amend"]:
            amendment_lines.append(
                f"- **`{knob}`**: spec default `{spec}` → measured `{measured}` "
                f"({verdict['reason']}) — AMEND"
            )
        else:
            amendment_lines.append(
                f"- `{knob}`: spec default `{spec}` → measured `{measured}` "
                f"({verdict['reason']}) — **HOLD**"
            )
    amendment_section = "\n".join(amendment_lines) if amendment_lines else "No amendments proposed."

    composite_json = json.dumps(composite, indent=2)
    base_overrides_json = json.dumps(base)

    report = f"""# Graph sweep — {today}

**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items
**Primary metric:** mrr
**Baseline:** `TIER2_TAU_GAP=10` alone (MRR {BASELINE_GAP10_MRR:.4f}, docs/bench/baseline.json::headlineMetrics.ladder post-9.4.8)
**Base overrides on every point:** `{base_overrides_json}`
**Rounds:** {len(rounds)} coordinate-descent; each round's winner pins into the next.

{rounds_joined}

## Composite elbow

All round winners stacked as a single override set:

```json
{composite_json}
```

**Composite ΔMRR vs gap=10 baseline:** {composite_lift:+.4f} — {composite_verdict}.

## Spec amendment proposal

Per-round amendments (amendment threshold = ΔMRR ≥ {AMENDMENT_THRESHOLD:.2f}):

{amendment_section}

Each AMEND knob ships as a separate commit per plan decision 5 —
src/core/constants.js default + docs/specs/2026-04-20-starmem-v2-design.md
§5.1 tuning callout + docs/bench/baseline.json::tuned entry update.

## Notes

- The baseline is gap=10 alone (not spec-default gap=0.5). Graph knobs
  are only meaningful when Tier 2 gating is disabled, and 9.4.8 showed
  that's the current production default. ΔMRR measurements here are
  therefore on top of 9.4.8's +0.0625 MRR amendment.
- Winner rows are **bolded** in each round's table. The elbow is the
  MRR-best point in the round, not necessarily the middle of the range.
"""
    return report


def run_graph_sweep(synthetic: bool = False) -> dict:
    """Run the 6-round graph coordinate descent.

    Each round sweeps one knob via run_point.map() (parallel across
    containers within the round), picks the MRR-best point as the
    winner, and pins that value in accumulated_overrides for the
    next round. Synthetic mode shrinks each round's grid to 2 points
    for smoke testing; corpus stays full LoCoMo-10 regardless.

    Called from run_sweep when sweep_name='graph'. Returns the same
    {report, result_json, run_dir} shape as the generic sweep path.
    """
    import os
    from datetime import datetime, timezone

    rounds_out = []
    accumulated_overrides = dict(GRAPH_BASE_OVERRIDES)
    last_points = []

    for round_def in GRAPH_ROUNDS:
        knob_name = round_def["knob"]
        values = round_def["values"][:2] if synthetic else round_def["values"]

        # Build grid: one point per value, all pinned with accumulated_overrides
        grid = [
            {**accumulated_overrides, knob_name: v}
            for v in values
        ]
        overrides_jsons = [json.dumps(p) for p in grid]
        point_results = list(run_point.map(overrides_jsons))
        points = [json.loads(pr) for pr in point_results]
        last_points = points

        # Winner = highest MRR in this round
        winner = max(points, key=lambda p: p["metrics"]["mrr"])
        winning_value = winner["overrides"][knob_name]
        winning_mrr = winner["metrics"]["mrr"]

        rounds_out.append({
            "name": round_def["name"],
            "knob": knob_name,
            "values": values,
            "points": points,
            "winner": {"value": winning_value, "mrr": winning_mrr},
        })

        # Pin for next round
        accumulated_overrides[knob_name] = winning_value

    # Persistence — mirrors run_sweep pattern (9.4.8 f5baae5)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-graph"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": "graph",
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": 10,
        "qa_count": last_points[0]["runCount"] if last_points else 0,
        "base_overrides": GRAPH_BASE_OVERRIDES,
        "rounds": rounds_out,
        "composite_elbow": {
            "overrides": accumulated_overrides,
            "rationale": "Coordinate descent winners across 6 rounds, each round's MRR-best value pinned into the next round's baseOverrides.",
        },
    }
    result_json_str = json.dumps(payload, indent=2)
    report = render_graph_report_stub(payload)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)
    volume.commit()

    # W&B logging — graph coordinate descent. Each round is logged as its
    # own step_metric so the dashboard renders six separate line charts
    # (one per knob) instead of collapsing them onto a shared x-axis.
    # Per-round winners land in wandb.summary; full points land as a
    # wandb.Table for cross-round inspection. Artifact upload mirrors
    # the batchsize sweep pattern (9.4.9-Phase-11-Task-7 precedent).
    wb_run = _wandb_init(
        job_type="graph-sweep",
        group="retrieval",
        config={
            "sweep": "graph",
            "synthetic": synthetic,
            "rounds": [r["knob"] for r in rounds_out],
            "base_overrides": GRAPH_BASE_OVERRIDES,
        },
        tags=["phase-12", "sweep", "graph", "coordinate-descent"],
    )
    if wb_run is not None:
        try:
            import wandb

            # One step_metric per round, so each knob gets its own x-axis.
            # Round scalars are namespaced under round/<knob>/ so the
            # dashboard auto-groups the six line charts.
            for r in rounds_out:
                knob = r["knob"]
                wandb.define_metric(knob)
                wandb.define_metric(f"round/{knob}/*", step_metric=knob)

            # Cross-round comparison table. One row per point across all
            # rounds. knob column lets you filter in the UI.
            table = wandb.Table(
                columns=[
                    "round", "knob", "value",
                    "mrr", "coverage", "n", "n_scored", "n_skipped",
                    "is_winner",
                ]
            )

            n_failed = 0
            for r in rounds_out:
                knob = r["knob"]
                winner_value = r["winner"]["value"]
                for pt in r["points"]:
                    value = pt["overrides"].get(knob)
                    m = pt.get("metrics") or {}
                    mrr = m.get("mrr")
                    if mrr is None:
                        n_failed += 1

                    # Per-round step log — drives the round/<knob>/ line charts.
                    wandb.log({
                        knob: value,
                        f"round/{knob}/mrr": mrr,
                        f"round/{knob}/coverage": m.get("coverage"),
                        f"round/{knob}/n_scored": m.get("n_scored"),
                    })

                    table.add_data(
                        r["name"],
                        knob,
                        value,
                        mrr,
                        m.get("coverage"),
                        m.get("n"),
                        m.get("n_scored"),
                        m.get("n_skipped"),
                        value == winner_value,
                    )

                # Per-round winner summary.
                wandb.summary[f"winner/{knob}/value"] = winner_value
                wandb.summary[f"winner/{knob}/mrr"] = r["winner"]["mrr"]

            wandb.log({"graph/points": table})

            # Composite elbow = stack of all round winners.
            wandb.summary["composite/overrides"] = json.dumps(
                payload["composite_elbow"]["overrides"]
            )
            wandb.summary["composite/rationale"] = payload["composite_elbow"]["rationale"]
            wandb.summary["n_rounds"] = len(rounds_out)
            wandb.summary["n_failed"] = n_failed

            artifact = wandb.Artifact(
                name=f"graph-sweep-{ts}",
                type="bench-sweep",
                metadata={
                    "sweep": "graph",
                    "timestamp": ts,
                    "synthetic": synthetic,
                    "rounds": [r["knob"] for r in rounds_out],
                    "base_overrides": GRAPH_BASE_OVERRIDES,
                    "composite_overrides": payload["composite_elbow"]["overrides"],
                },
            )
            artifact.add_file(os.path.join(run_dir, "result.json"))
            artifact.add_file(os.path.join(run_dir, "report.md"))
            wb_run.log_artifact(artifact)
        except Exception as exc:  # noqa: BLE001
            print(f"[wandb] logging failed mid-run: {exc}")
        finally:
            wb_run.finish()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


# 9.4.9 — consolidation sweep.
# Two independent single-axis rounds. Each is interpreted standalone
# because the knobs affect orthogonal parts of the pipeline (dedup
# Jaccard gates merge decisions; batch_size gates per-call drain
# cardinality). No coordinate descent across rounds.
#
# Branch C pre-registered: 9.4.6 retro found rule-based seeder
# under-stresses dedup (updateRate 4.4% → 0.7% across thresholds,
# retrieval MRR flat to 4 decimals). If 9.4.9 reproduces flatness
# (MRR range <0.005 across all points in a round), the round is
# flagged flat and tuning defers to 9.5 live extraction.
CONSOLIDATION_ROUNDS = [
    {"name": "dedup",       "knob": "DEDUP_JACCARD_THRESHOLD", "values": [0.5, 0.6, 0.7, 0.8, 0.9]},
    # 9.5 (2026-04-22): BATCH_SIZE round dropped again — Branch D fired
    # twice. First attempt at run_point timeout=600s hit FunctionTimeoutError
    # after ~470 live Nano-GPT calls; raised to 1500s, hit it again after
    # ~1200+ calls. One run_point (one BATCH_SIZE grid value) materializes
    # ~94 conversations × live batched extraction at ~1.3s/call, which
    # exceeds reasonable per-point container budgets. The 9.4.9 retro
    # budget estimate ("~20% miss rate") was wrong by ~10× — changing
    # BATCH_SIZE invalidates 100% of the extraction cache for that seed
    # pass, not 20%.
    #
    # Deferred to Phase 11 for budget-aware redesign: mid-subprocess
    # periodic volume.commit() (threading, commit every 60s so SIGKILL
    # loses ≤1 min), or split by conversation count so each Modal call
    # is bounded, or use a cheaper model for the stress test.
    # Per sweep-cache-invalidation-audit's Branch D: "Do not chase a
    # timing-out sweep."
    # {"name": "batch_size", "knob": "BATCH_SIZE", "values": [8, 16, 24, 32, 48]},
]

# Threshold for Branch C "flat surface" detection. Matches the ΔMRR
# noise floor measured on LoCoMo in 9.4.6. Rounds with MRR range
# below this threshold defer tuning to 9.5.
CONSOLIDATION_FLAT_MRR_THRESHOLD = 0.005


def render_consolidation_report_stub(payload):
    """9.4.9 — full consolidation sweep renderer.

    Replaces the Task 3 stub. Per-round tables surface aggStats counters
    (added/updated/drained/updateRate/dedupHitRate) alongside retrieval
    metrics. Per-round recommendation follows the Phase 6 retro band
    rule (target updateRate ∈ [0.2, 0.4], closest to 0.3).

    Hardened amendment criteria (9.4.9 Task 5b preflight — coverage bias
    finding on graph sweep):
      - ΔMRR ≥ 0.02 absolute vs spec default, AND
      - Coverage (n_scored / n_total) stays within 5 percentage points
        of the baseline coverage (~71% on post-9.4.7 LoCoMo)

    Without the coverage floor, a knob that narrows retrieval to only
    the easy subset would produce headline MRR gains that don't reflect
    real improvement — same shape as the seeds_k=1 coverage-bias finding
    in the graph sweep.

    Branch C fires when MRR range < CONSOLIDATION_FLAT_MRR_THRESHOLD
    across a round's points — per the 9.4.6 finding that rule-based
    seeder under-stresses dedup. Flat rounds defer to 9.5.

    Name kept as `_stub` for backward compat.
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    rounds = payload["rounds"]

    # Baseline MRR for ΔMRR comparisons (gap=10 alone, consistent with
    # the graph renderer). Consolidation runs offline — knobs affect
    # storage, not retrieval directly — but we still compare against
    # the same retrieval baseline.
    BASELINE_GAP10_MRR = 0.8077
    BASELINE_COVERAGE_PCT = 64.3  # post-9.4.8 baseline — see graph renderer for rationale
    AMENDMENT_THRESHOLD = 0.02
    COVERAGE_FLOOR_DELTA_PCT = 5.0  # coverage must stay within 5pp of baseline

    round_sections = []
    for r in rounds:
        knob = r["knob"]
        header = (
            f"| {knob} | added | updated | drained | updateRate | dedupHitRate | "
            f"n_scored | recallAt5 | mrr | coverage | ΔMRR vs gap=10 | p50 | p95 |"
        )
        separator = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
        rows = []
        has_coverage_drop = False
        for p in r["points"]:
            v = p["overrides"][knob]
            agg = p.get("aggStats") or {}
            added = agg.get("added", "—")
            updated = agg.get("updated", "—")
            drained = agg.get("drained", "—")
            ur_raw = agg.get("updateRate")
            dhr_raw = agg.get("dedupHitRate")
            ur = f"{ur_raw:.4f}" if ur_raw is not None else "—"
            dhr = f"{dhr_raw:.4f}" if dhr_raw is not None else "—"
            m = p["metrics"]
            n_scored = m.get("n_scored", "—")
            r5 = f"{m['recallAtK']['5']:.4f}"
            mrr = m["mrr"]
            mrr_str = f"{mrr:.4f}"
            cov = m.get("coverage")
            cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
            lift = mrr - BASELINE_GAP10_MRR
            lift_str = f"{lift:+.4f}"
            p50 = f"{p['latencyMs']['p50']:.2f}"
            p95 = f"{p['latencyMs']['p95']:.2f}"

            coverage_pct = (cov * 100) if isinstance(cov, (int, float)) else None
            n_scored_cell = f"{n_scored}"
            if coverage_pct is not None and abs(coverage_pct - BASELINE_COVERAGE_PCT) > COVERAGE_FLOOR_DELTA_PCT:
                n_scored_cell = f"⚠️ {n_scored}"
                has_coverage_drop = True

            # Bold the winner / band-rule-best row
            is_winner = (not r["elbow"]["flat"]) and v == r["elbow"]["value"]
            v_cell = f"**{v}**" if is_winner else str(v)

            rows.append(
                f"| {v_cell} | {added} | {updated} | {drained} | {ur} | {dhr} | "
                f"{n_scored_cell} | {r5} | {mrr_str} | {cov_s} | {lift_str} | {p50} | {p95} |"
            )
        rows_joined = "\n".join(rows)

        # Branch + band-rule recommendation
        if r["elbow"]["flat"]:
            recommendation = (
                f"**Branch C fires** — MRR range {r['mrr_range']:.4f} "
                f"< {CONSOLIDATION_FLAT_MRR_THRESHOLD}. Knob inert on this "
                f"corpus with rule-based extractor. Defer tuning to "
                f"sub-phase 9.5 (live extraction regenerates cache on "
                f"demand and should exercise realistic dedup pressure)."
            )
        else:
            # Find best point by band rule: prefer updateRate ∈ [0.2, 0.4]
            # closest to 0.3, tie-break by highest MRR.
            def band_distance(p):
                ur = (p.get("aggStats") or {}).get("updateRate")
                return abs(ur - 0.3) if ur is not None else float("inf")
            best_band = min(r["points"], key=band_distance)
            best_ur = (best_band.get("aggStats") or {}).get("updateRate")
            best_mrr = best_band["metrics"]["mrr"]
            best_val = best_band["overrides"][knob]
            mrr_best = max(r["points"], key=lambda p: p["metrics"]["mrr"])

            # Hardened amendment check via _should_amend (Phase 11 Task 4)
            winner_point = next(
                (p for p in r["points"] if p["overrides"][knob] == r["elbow"]["value"]),
                None,
            )
            baseline_metrics = {"mrr": BASELINE_GAP10_MRR, "coverage": BASELINE_COVERAGE_PCT / 100}
            if winner_point:
                verdict = _should_amend(baseline_metrics, winner_point["metrics"])
            else:
                verdict = {"amend": False, "reason": "Winner point not found in round."}

            best_ur_str = f"{best_ur:.4f}" if best_ur is not None else "n/a"
            recommendation = (
                f"**Band-rule best:** `{knob} = {best_val}` "
                f"(updateRate={best_ur_str}, closest to target 0.3; MRR={best_mrr:.4f})\n\n"
                f"**MRR-best:** `{knob} = {mrr_best['overrides'][knob]}` "
                f"(MRR={mrr_best['metrics']['mrr']:.4f})\n\n"
                f"**Amendment verdict:** {'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
            )

        coverage_warning = ""
        if has_coverage_drop:
            coverage_warning = (
                "\n\n> **⚠️ Coverage warning:** at least one point in this round "
                f"deviates >{COVERAGE_FLOOR_DELTA_PCT}pp from baseline coverage "
                f"(~{BASELINE_COVERAGE_PCT:.0f}%). Consolidation knobs shouldn't "
                "affect retrieval coverage — investigate whether the override "
                "is interacting with the ladder unexpectedly."
            )

        round_sections.append(
            f"## Round — {knob}\n\n**Swept knob:** `{knob}`\n\n"
            f"{header}\n{separator}\n{rows_joined}\n\n{recommendation}{coverage_warning}"
        )

    rounds_joined = "\n\n".join(round_sections)

    report = f"""# Consolidation sweep — {today}

**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items
**Primary metric:** mrr (retrieval) + updateRate (consolidation-internal band rule)
**Baseline:** `TIER2_TAU_GAP=10` alone (MRR {BASELINE_GAP10_MRR:.4f}, coverage ~{BASELINE_COVERAGE_PCT:.0f}%)
**Rounds:** {len(rounds)} independent single-axis sweeps

**Amendment criteria (9.4.9 hardened):** ΔMRR ≥ {AMENDMENT_THRESHOLD:.2f} AND coverage stays within {COVERAGE_FLOOR_DELTA_PCT:.0f}pp of baseline. Either condition failing defers the amendment.

{rounds_joined}

## Notes

- Branch C is pre-registered per 9.4.6 consolidation retro finding: rule-based
  seeder may under-stress dedup/consolidation machinery. Rounds with MRR range
  <{CONSOLIDATION_FLAT_MRR_THRESHOLD} across all points flag as flat. Under
  9.5 live extraction the finding reproduced (fourth-time): Gemma 4 26B A4B
  doesn't produce enough near-duplicates on LoCoMo to stress dedup either.
  Interpretation: dedup flatness is corpus-structural (LoCoMo's fact
  distribution), not extractor-dependent.
- BATCH_SIZE round deferred to Phase 11 — Branch D fired twice on 9.5
  attempts (600s and 1500s per-point timeouts). One run_point needs
  ~94 conversations × batched live extraction, which doesn't fit in
  reasonable container budgets. Budget-aware redesign pending (periodic
  mid-subprocess commits, conversation-level splitting, or cheaper
  stress-test model).
- Band rule reminder: updateRate < 0.1 = too strict (dedup rarely fires),
  updateRate > 0.5 = too lax (over-merges distinct facts). Target [0.2, 0.4]
  closest to 0.3.
"""
    return report


def run_consolidation_batchsize_sweep() -> dict:
    """Conversation-level-split BATCH_SIZE sweep (Phase 11 Task 6).

    Called from run_sweep when sweep_name='batchsize' — inherits the
    parent's @app.function context (volume mount, timeout, memory).
    Do NOT decorate this function: run_sweep already owns the container.
    This matches the run_graph_sweep / run_consolidation_sweep pattern.

    25 cells (5 values × 5 convs) fanned out to parallel containers,
    then aggregated into one MetricsResult per BATCH_SIZE value.

    Returns:
        Dict with keys { report, result_json, run_dir }.
    """
    import json
    import math
    import os
    from datetime import datetime

    pairs = [(ci, bs) for bs in BATCHSIZE_VALUES for ci in BATCHSIZE_CONV_INDICES]

    cell_results = list(run_batchsize_point.map(
        [p[0] for p in pairs],
        [p[1] for p in pairs],
    ))
    cells = [json.loads(cr) for cr in cell_results]

    by_bs = {}
    for cell in cells:
        bs = cell.get("batchSize")
        by_bs.setdefault(bs, []).append(cell)

    def _is_nan(x):
        try:
            return math.isnan(x)
        except (TypeError, ValueError):
            return x is None

    points = []
    for bs in BATCHSIZE_VALUES:
        cells_for_bs = by_bs.get(bs, [])
        if not cells_for_bs:
            continue
        total_n = sum(c.get("metrics", {}).get("n", 0) for c in cells_for_bs)
        total_n_scored = sum(c.get("metrics", {}).get("n_scored", 0) for c in cells_for_bs)
        total_n_skipped = sum(c.get("metrics", {}).get("n_skipped", 0) for c in cells_for_bs)

        # Weighted MRR: sum(mrr * n_scored) / sum(n_scored), skipping NaN.
        mrr_num = 0.0
        mrr_den = 0
        for c in cells_for_bs:
            m = c.get("metrics", {})
            if m.get("n_scored", 0) > 0 and not _is_nan(m.get("mrr")):
                mrr_num += m["mrr"] * m["n_scored"]
                mrr_den += m["n_scored"]
        mrr_agg = (mrr_num / mrr_den) if mrr_den > 0 else float("nan")

        # Aggregate updateRate from consolidationStats
        total_updated = sum(
            (c.get("consolidationStats") or {}).get("updated", 0)
            for c in cells_for_bs
        )
        total_added = sum(
            (c.get("consolidationStats") or {}).get("added", 0)
            for c in cells_for_bs
        )
        update_rate = (
            total_updated / (total_updated + total_added)
            if (total_updated + total_added) > 0
            else 0.0
        )

        points.append({
            "overrides": {"BATCH_SIZE": bs},
            "metrics": {
                "n": total_n,
                "n_scored": total_n_scored,
                "n_skipped": total_n_skipped,
                "coverage": (total_n_scored / total_n) if total_n > 0 else float("nan"),
                "mrr": mrr_agg,
                "updateRate": update_rate,
            },
            "cells": cells_for_bs,
        })

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-batchsize"
    os.makedirs(run_dir, exist_ok=True)

    knobs = [{"name": "BATCH_SIZE", "values": BATCHSIZE_VALUES}]
    elbow = _detect_elbow(points, knobs, "mrr") if len(points) >= 2 else None

    result_payload = {
        "name": "batchsize",
        "timestamp": ts,
        "points": points,
        "elbow": elbow,
        "convs_sampled": BATCHSIZE_CONV_INDICES,
    }
    result_json_str = json.dumps(result_payload, indent=2)
    with open(f"{run_dir}/result.json", "w") as f:
        f.write(result_json_str)

    report = render_batchsize_report(result_payload)
    with open(f"{run_dir}/report.md", "w") as f:
        f.write(report)

    volume.commit()

    # W&B logging — BATCH_SIZE is the x-axis here. Log per-value scalars
    # against define_metric so the dashboard auto-builds line charts.
    wb_run = _wandb_init(
        job_type="batchsize-sweep",
        group="consolidation",
        config={
            "sweep": "batchsize",
            "values": BATCHSIZE_VALUES,
            "convs_sampled": BATCHSIZE_CONV_INDICES,
        },
        tags=["phase-11", "sweep", "batchsize"],
    )
    if wb_run is not None:
        try:
            import wandb

            wandb.define_metric("BATCH_SIZE")
            wandb.define_metric("sweep/*", step_metric="BATCH_SIZE")

            table = wandb.Table(
                columns=["BATCH_SIZE", "mrr", "coverage", "update_rate", "n", "n_scored"]
            )
            for pt in points:
                bs = pt["overrides"]["BATCH_SIZE"]
                m = pt["metrics"]
                wandb.log({
                    "BATCH_SIZE": bs,
                    "sweep/mrr": m.get("mrr"),
                    "sweep/coverage": m.get("coverage"),
                    "sweep/update_rate": m.get("updateRate"),
                    "sweep/n": m.get("n"),
                })
                table.add_data(
                    bs,
                    m.get("mrr"),
                    m.get("coverage"),
                    m.get("updateRate"),
                    m.get("n"),
                    m.get("n_scored"),
                )
            wandb.log({"sweep/table": table})

            if elbow:
                wandb.summary["elbow/BATCH_SIZE"] = (elbow.get("overrides") or {}).get("BATCH_SIZE")
                wandb.summary["elbow/rationale"] = elbow.get("rationale")

            artifact = wandb.Artifact(
                name=f"batchsize-sweep-{ts}",
                type="bench-sweep",
                metadata={
                    "sweep": "batchsize",
                    "timestamp": ts,
                    "values": BATCHSIZE_VALUES,
                    "convs_sampled": BATCHSIZE_CONV_INDICES,
                    "elbow": elbow,
                },
            )
            artifact.add_file(f"{run_dir}/result.json")
            artifact.add_file(f"{run_dir}/report.md")
            wb_run.log_artifact(artifact)
        except Exception as exc:  # noqa: BLE001
            print(f"[wandb] logging failed mid-run: {exc}")
        finally:
            wb_run.finish()

    return {"report": report, "result_json": result_json_str, "run_dir": run_dir}


def render_batchsize_report(payload):
    lines = []
    lines.append(f"# BATCH_SIZE sweep — {payload['timestamp']}")
    lines.append("")
    lines.append(f"**Convs sampled:** indices {payload['convs_sampled']}")
    lines.append("")
    lines.append("| BATCH_SIZE | MRR | Coverage | Update rate | n (QA) |")
    lines.append("|---|---|---|---|---|")
    for pt in payload["points"]:
        bs = pt["overrides"]["BATCH_SIZE"]
        m = pt["metrics"]
        lines.append(
            f"| {bs} | {m['mrr']:.4f} | {m['coverage']:.4f} | {m.get('updateRate', 0):.4f} | {m['n']} |"
        )
    lines.append("")
    # Amendment verdict (Task 4 rule)
    if len(payload["points"]) >= 2:
        baseline_pt = next(
            (p for p in payload["points"] if p["overrides"]["BATCH_SIZE"] == 10),
            payload["points"][0],
        )
        if payload.get("elbow", {}).get("overrides"):
            chosen_bs = payload["elbow"]["overrides"].get("BATCH_SIZE")
            candidate_pt = next(
                (p for p in payload["points"] if p["overrides"]["BATCH_SIZE"] == chosen_bs),
                None,
            )
            if candidate_pt and candidate_pt is not baseline_pt:
                verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
                lines.append("### Amendment verdict")
                lines.append("")
                lines.append(f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}")
                lines.append("")
    lines.append(f"**Elbow rationale:** {payload.get('elbow', {}).get('rationale', '—') if payload.get('elbow') else '—'}")
    return "\n".join(lines)


def run_consolidation_sweep(synthetic: bool = False) -> dict:
    """Run two independent consolidation knob sweeps.

    Each round is a single-axis parallel fan-out via run_point.map().
    Pre-registered Branch C flags rounds with MRR range below the
    CONSOLIDATION_FLAT_MRR_THRESHOLD as "flat" and defers tuning to
    9.5 live extraction. Non-flat rounds land an elbow at the
    MRR-best point.

    Called from run_sweep when sweep_name='consolidation'. Returns
    the standard {report, result_json, run_dir} shape.
    """
    import os
    from datetime import datetime, timezone

    rounds_out = []
    last_points = []

    for round_def in CONSOLIDATION_ROUNDS:
        knob_name = round_def["knob"]
        values = round_def["values"][:2] if synthetic else round_def["values"]
        grid = [{knob_name: v} for v in values]
        overrides_jsons = [json.dumps(p) for p in grid]
        point_results = list(run_point.map(overrides_jsons))
        points = [json.loads(pr) for pr in point_results]
        last_points = points

        # Branch C detection: MRR range below noise floor
        mrr_values = [p["metrics"]["mrr"] for p in points]
        mrr_range = max(mrr_values) - min(mrr_values)
        is_flat = mrr_range < CONSOLIDATION_FLAT_MRR_THRESHOLD

        if is_flat:
            elbow = {"value": None, "mrr": max(mrr_values), "flat": True}
        else:
            winner = max(points, key=lambda p: p["metrics"]["mrr"])
            elbow = {
                "value": winner["overrides"][knob_name],
                "mrr": winner["metrics"]["mrr"],
                "flat": False,
            }

        rounds_out.append({
            "name": round_def["name"],
            "knob": knob_name,
            "values": values,
            "points": points,
            "elbow": elbow,
            "mrr_range": mrr_range,
        })

    # Persistence — mirrors graph + tau/bm25 pattern
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-consolidation"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": "consolidation",
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": 10,
        "qa_count": last_points[0]["runCount"] if last_points else 0,
        "rounds": rounds_out,
    }
    result_json_str = json.dumps(payload, indent=2)
    report = render_consolidation_report_stub(payload)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)
    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


def _cartesian_product(knobs):
    """Generate cartesian product of knob value arrays."""
    if not knobs:
        return [{}]
    first, *rest = knobs
    rest_product = _cartesian_product(rest)
    result = []
    for value in first["values"]:
        for point in rest_product:
            result.append({first["name"]: value, **point})
    return result


@app.function(image=image, volumes={"/data": volume}, secrets=[env_secret, wandb_secret], timeout=10800, memory=4096)
def run_sweep(sweep_name: str, synthetic: bool = False, corpus: str = "locomo", extractor_model: str = "") -> dict:
    """Run a full parameter sweep in parallel via Modal.

    Args:
        sweep_name: 'tau', 'bm25', 'hops', 'relw', 'lambda1_tripwire',
            'graph', or 'consolidation'.
        synthetic: If True, use a tiny 2-point grid for smoke testing.
            The corpus is always full; `synthetic` only shrinks
            the knob grid, not the data.
        corpus: Benchmark corpus to run against. 'locomo' or 'longmemeval-s'.
        extractor_model: Optional model override forwarded to every run_point.
            When empty, each run_point inherits STARMEM_BENCH_LLM_MODEL from
            env_secret. Phase 12 Task 7 sweeps against the Modal vLLM
            warmed cache require '--extractor-model "Qwen/Qwen3.6-35B-A3B-FP8"'
            for cache-key alignment (see docs/plans/phase-12-task-6-5-retro.md).

    Returns:
        Dict with keys:
            - report (str): rendered Markdown for the sweep.
            - result_json (str): JSON-serialized raw payload (schema v1)
              with sweep_name, timestamp, points, elbow, corpus stats.
            - run_dir (str): path inside the Modal Volume where both
              `result.json` and `report.md` were persisted.

    Dispatch: 'graph' and 'consolidation' (9.4.9) use specialized
    multi-round runners; 'tau' and 'bm25' use the generic grid path
    below.
    """
    import os
    import subprocess
    import json
    from datetime import datetime

    # 9.4.9 dispatch — multi-round sweeps run in specialized helpers
    # that manage their own persistence + rendering.
    #
    # Phase 12 Task 5: the three sub-orchestrators below are LoCoMo-only
    # in v12 (they drive graph/consolidation/batchsize knob sweeps, all
    # scoped to the regression-control corpus). LongMemEval-S corpus
    # support for them is deferred; Phase 12's LongMemEval sweeps
    # (lambda1_tripwire, etc.) go through the generic grid path below,
    # which IS corpus-aware.
    if sweep_name in ("batchsize", "graph", "consolidation") and corpus != "locomo":
        raise ValueError(
            f"--sweep-name {sweep_name!r} is LoCoMo-only in Phase 12. "
            f"Got --corpus {corpus!r}. LongMemEval-S support for these sub-orchestrators "
            f"is deferred to a later phase; use a generic sweep entry (e.g. lambda1_tripwire) "
            f"for LongMemEval corpus sweeps."
        )
    if sweep_name == "batchsize":
        return run_consolidation_batchsize_sweep()
    if sweep_name == "graph":
        return run_graph_sweep(synthetic)
    if sweep_name == "consolidation":
        return run_consolidation_sweep(synthetic)

    config = SWEEP_CONFIGS[sweep_name]
    knobs = config["knobs"]
    primary_metric = config["primary_metric"]
    renderer = config["renderer"]

    # Symlink cache
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    _install_volume_symlink(corpus_link, "/data/locomo10.json")
    _install_volume_symlink(cache_link, "/data/extractions")
    if corpus == "longmemeval-s":
        longmemeval_link = os.path.join(repo_cache, "longmemeval_s_cleaned.json")
        _install_volume_symlink(longmemeval_link, "/data/longmemeval_s_cleaned.json")

    if synthetic:
        # Tiny 2-point grid for smoke testing. Both points must populate
        # EVERY knob the renderer reads — otherwise render_tau_report's
        # p["overrides"]["TIER2_TAU_GAP"] (and equivalents) will KeyError.
        # Use spec defaults for one knob, a deviation for the other, so
        # the elbow detector has two distinguishable points per axis.
        if sweep_name == "tau":
            grid = [
                {"TIER2_TAU_CONFIDENCE": 2.0, "TIER2_TAU_GAP": 0.5},  # spec defaults
                {"TIER2_TAU_CONFIDENCE": 0.5, "TIER2_TAU_GAP": 0.5},  # low-confidence variant
            ]
        elif sweep_name == "bm25":
            grid = [
                {"TAG_BOOST": 2, "SUBJECT_BOOST": 2},  # spec defaults
                {"TAG_BOOST": 3, "SUBJECT_BOOST": 2},  # +tag variant
            ]
        elif sweep_name == "hops":
            grid = [
                {"TIER3_MAX_HOPS": 2, "TIER2_TAU_GAP": 10},  # spec default + gap=10
                {"TIER3_MAX_HOPS": 3, "TIER2_TAU_GAP": 10},  # +1 hop variant
            ]
        elif sweep_name == "relw":
            grid = [
                {"EXPLICIT_RELATION_WEIGHT": 1.0, "TIER2_TAU_GAP": 10},  # spec default + gap=10
                {"EXPLICIT_RELATION_WEIGHT": 2.0, "TIER2_TAU_GAP": 10},  # +1.0 variant
            ]
        elif sweep_name == "lambda1_tripwire":
            # Phase 12 Task 7 smoke: 2-point grid with spec default + one
            # deviation, both inlined with BATCH_SIZE=15 + TIER2_TAU_GAP=10
            # so smoke shares cache keys with the production lambda1_tripwire
            # dispatch (and with the BS=15 warm cache).
            grid = [
                {"TIER3_LAMBDA_1": 1.0, "TIER2_TAU_GAP": 10, "BATCH_SIZE": 15},  # spec default
                {"TIER3_LAMBDA_1": 0.5, "TIER2_TAU_GAP": 10, "BATCH_SIZE": 15},  # low variant
            ]
        else:
            raise ValueError(f"Unknown synthetic sweep_name: {sweep_name!r}")
    else:
        grid = _cartesian_product(knobs)
        # 9.5: single-axis graph-tier sweeps need TIER2_TAU_GAP=10 inlined
        # into every grid point so queries actually reach Tier 3 (without
        # it, Tier 2 gating short-circuits and the knob is inert by
        # construction). Same invariant as GRAPH_BASE_OVERRIDES; run_sweep
        # doesn't honor a config["base_overrides"] key today, so we inline
        # via the _SWEEP_BASE_OVERRIDES table (Phase 12 Task 7 also adds
        # BATCH_SIZE=15 for the lambda1_tripwire entry — cache-key
        # alignment with the Modal vLLM warmed cache).
        base_overrides = _SWEEP_BASE_OVERRIDES.get(sweep_name, {})
        for point in grid:
            for k, v in base_overrides.items():
                point.setdefault(k, v)

    # Fan out to parallel containers
    overrides_jsons = [json.dumps(point) for point in grid]
    point_results = list(run_point.starmap(
        [(oj, corpus, extractor_model) for oj in overrides_jsons]
    ))

    points = [json.loads(pr) for pr in point_results]

    # Partition successes vs error payloads BEFORE _detect_elbow / renderer
    # touch them — both index `p["overrides"]` and crash with KeyError on
    # error shape `{error, returncode, stderr, stdout_tail, diagnostics}`,
    # swallowing the actual node subprocess failure. Surface the errors
    # loudly so the operator sees what crashed instead of a confusing
    # `KeyError: 'overrides'` 50 lines deep in the sweep pipeline.
    error_points = [p for p in points if "error" in p and "overrides" not in p]
    ok_points = [p for p in points if "overrides" in p]

    if error_points:
        import sys as _sys
        print(
            f"\n[run_sweep] {len(error_points)} of {len(points)} points failed:",
            file=_sys.stderr,
        )
        for i, ep in enumerate(error_points):
            stderr_tail = (ep.get("stderr") or "").splitlines()[-20:]
            print(
                f"  [{i}] error={ep.get('error')!r} returncode={ep.get('returncode')}\n"
                f"      stderr (last 20 lines):\n        " + "\n        ".join(stderr_tail) + "\n"
                f"      diagnostics={ep.get('diagnostics')!r}",
                file=_sys.stderr,
            )
        # Hard-fail when ALL points errored — rendering an empty sweep is
        # never the right outcome and the operator needs to fix the
        # subprocess-level failure first.
        if not ok_points:
            raise RuntimeError(
                f"run_sweep: all {len(points)} points failed in node subprocess. "
                f"First error: {error_points[0].get('error')!r}, "
                f"returncode={error_points[0].get('returncode')}. "
                f"See stderr above for per-point detail."
            )
        # Partial failure is allowed but flagged; the elbow + renderer run
        # over only the successful subset, but the persisted payload keeps
        # the error_points so the artifact is honest.

    elbow = _detect_elbow(ok_points, knobs, primary_metric)

    result = {
        "name": sweep_name,
        "points": ok_points,
        "elbow": elbow,
    }
    if error_points:
        result["error_points"] = error_points

    # Compute corpus stats (Modal containers already ran the full corpus)
    corpus_len = 500 if corpus == "longmemeval-s" else 10
    qa_count = ok_points[0]["runCount"] if ok_points else 0

    if sweep_name == "bm25":
        # Tags populated rate: compute from one seeded conversation via a small
        # helper subprocess. The Modal container has `/repo` and volume mount,
        # so we shell out to a Node one-liner.
        tags_probe = subprocess.run(
            ["node", "-e", f"""
                const {{ getAdapter }} = await import('./bench/corpora/index.js');
                const {{ seedConversation }} = await import('./bench/harness/seeder.js');
                const {{ loadState }} = await import('./src/core/state.js');
                const adapter = getAdapter('{corpus}');
                const corpus = await adapter.loadConversations({{ offline: true, maxConversations: 1 }});
                const seed = await seedConversation(corpus[0], {{ chatIdPrefix: 'tags-probe', keepBackend: true }});
                const state = await loadState(seed.chatId);
                const ep = Object.values(state.entries).filter(e => e.scope === 'episodic');
                const withTags = ep.filter(e => Array.isArray(e.tags) && e.tags.length > 0).length;
                console.log(JSON.stringify({{ n: ep.length, withTags, rate: ep.length > 0 ? withTags / ep.length : 0 }}));
            """.strip()],
            cwd="/repo",
            capture_output=True,
            text=True,
            check=True,
        )
        tags_data = json.loads(tags_probe.stdout.strip().split("\n")[-1])
        tags_stats = {"rate": tags_data["rate"], "n": tags_data["n"]}
    else:
        tags_stats = None

    # Renderer dispatch — render_bm25_report wants tags_stats; render_single_axis_report
    # wants corpus (Phase 12 Task 7) for the corpus label; render_tau_report uses neither.
    if tags_stats:
        report = renderer(result, corpus_len, qa_count, tags_stats)
    elif renderer is render_single_axis_report:
        report = renderer(result, corpus_len, qa_count, corpus=corpus)
    else:
        report = renderer(result, corpus_len, qa_count)

    # Append per-task-type slice if any point carries it
    for p in points:
        if p.get("metrics", {}).get("byTaskType"):
            report = _append_task_type_slice(report, p["metrics"])
            break

    # Persist raw + rendered outputs to the Modal Volume so nothing is lost
    # if the calling session drops before the markdown is received. Schema
    # version lets the reconstruction shim read older runs if we ever change
    # the payload shape.
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-{sweep_name}"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": sweep_name,
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": corpus_len,
        "qa_count": qa_count,
        "tags_stats": tags_stats,
        "result": result,
    }
    result_json_str = json.dumps(payload, indent=2)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)

    # commit() makes writes visible to subsequent containers and to
    # `modal volume ls / get` on the host.
    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


@app.local_entrypoint()
def main(
    mode: str = "hello",
    overrides_json: str = "{}",
    sweep_name: str = "tau",
    synthetic: bool = False,
    local_out: str = "",
    corpus: str = "locomo",
    corpus_size: int = 500,   # NEW: --corpus-size N for warmup-longmemeval mode
    extractor_model: str = "",   # NEW: --extractor-model override for warmup/baselines
    stratified_sample: int = 0,   # NEW: --stratified-sample N for LongMemEval-S subset
    stratify_seed: int = 2026,   # NEW: --stratify-seed N for determinism across runs
    warmup_concurrency: int = 10,   # NEW: --warmup-concurrency K (Fireworks-safe default)
    batch_size: int = 0,   # NEW: --batch-size N override for warmup-longmemeval (0 = spec default)
):
    """Dispatch entrypoint for Modal bench functions.

    Usage:
        modal run bench/modal/sweep_app.py
            → runs hello() and prints nodeVersion + volume mount check

        modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{}'
            → runs run_point() with empty overrides

        modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{"TIER2_TAU_CONFIDENCE": 0.5}'
            → runs run_point() with one override

        modal run bench/modal/sweep_app.py --mode run-point \\
                --overrides-json '{"TIER2_TAU_GAP": 10}' --local-out docs/bench/runs
            → run_point() with override + mirrors {ts}-point.json to host dir
              (stem convention matches run-sweep)

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name batchsize
            → 25-cell (5 BATCH_SIZE × 5 convs) split sweep, ~3min parallel

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau --synthetic
            → runs run_sweep() with synthetic corpus (2 points)

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau \\
                --local-out docs/bench/runs
            → also mirrors report.md + result.json to the host dir
              (independent of the Modal Volume copy at /data/runs/<ts>-<sweep>/)

        modal run bench/modal/sweep_app.py --mode run-baselines --local-out docs/bench/baselines
            → fans out 4 baseline retrievers to parallel Modal containers,
              writes {ts}-baselines.{md,json} to host dir

    --corpus CORPUS:
        Benchmark corpus to run against. One of:
          - locomo           (default; LoCoMo-10, 1986 QA items)
          - longmemeval-s    (LongMemEval-S, 500 items, ~115K tok haystacks)
        Passed through to the Node runner via STARMEM_BENCH_CORPUS env var.

    --corpus-size N:
        Only relevant to --mode warmup-longmemeval. Number of LongMemEval-S
        items to warm. Default 500 = full corpus. Use lower values for
        smoke runs: 1 to validate the pipe, 10 to validate parallelism.

    --extractor-model MODEL:
        Override the extractor model for --mode warmup-longmemeval and
        --mode run-baselines. When empty (default), inherits
        STARMEM_BENCH_LLM_MODEL from the env_secret. Example:
        `--extractor-model openai/gpt-oss-20b` for a 4× throughput swap
        over Gemma 4 26B A4B. CRITICAL: the model string is part of the
        extraction-cache key. A warmup run with model X followed by a
        baselines run with model Y hits 0% cache and burns live tokens.
        Always run warmup and baselines with the same --extractor-model.

    --stratified-sample N:
        Only relevant to --corpus longmemeval-s. When > 0, pick N items
        via deterministic per-task-type stratified sampling instead of
        running the full 500-item corpus. Picks are balanced across the
        6 LongMemEval task types (single-session-*, temporal-reasoning,
        knowledge-update, multi-session) via round-robin on seeded
        per-type shuffles. Use for cost-controlled per-task-type
        mismatch detection. Takes precedence over --corpus-size when
        both are set. Rationale:
        docs/plans/phase-12-task-6-extraction-cost-decision.md.

    --stratify-seed N:
        PRNG seed for --stratified-sample. Default 2026. Same seed +
        same N = same item indices = same cache keys; warmup and
        baselines MUST use the same seed to share the cache.
    """
    if corpus not in {"locomo", "longmemeval-s"}:
        raise ValueError(f"--corpus must be one of: locomo, longmemeval-s. Got: {corpus!r}")

    if mode == "hello":
        print(json.dumps(hello.remote(), indent=2))
    elif mode == "run-point":
        result_str = run_point.remote(overrides_json, corpus=corpus, extractor_model=extractor_model)
        print(result_str)
        if local_out:
            from datetime import datetime as _dt
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            # Stem mirrors run-sweep's convention: ISO-ish timestamp + 'point'.
            stem = _dt.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ") + "-point"
            (out / f"{stem}.json").write_text(result_str)
            print(
                f"<!-- mirrored to host: {out / stem}.json -->",
                file=__import__("sys").stderr,
            )
    elif mode == "run-baselines":
        baselines_out = run_baselines.remote(
            corpus=corpus,
            extractor_model=extractor_model,
            stratified_sample=stratified_sample,
            stratify_seed=stratify_seed,
        )
        report = baselines_out["report"]
        result_json_str = baselines_out["result_json"]
        run_dir = baselines_out["run_dir"]
        print(report)
        print(f"\n<!-- saved to Modal Volume: {run_dir} -->", file=__import__("sys").stderr)
        if local_out:
            import os as _os
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            stem = _os.path.basename(run_dir)
            (out / f"{stem}.md").write_text(report)
            (out / f"{stem}.json").write_text(result_json_str)
            print(f"<!-- mirrored to host: {out / stem}.{{md,json}} -->", file=__import__("sys").stderr)
    elif mode == "run-sweep":
        sweep_out = run_sweep.remote(sweep_name, synthetic, corpus=corpus, extractor_model=extractor_model)
        report = sweep_out["report"]
        result_json_str = sweep_out["result_json"]
        run_dir = sweep_out["run_dir"]
        print(report)
        print(f"\n<!-- saved to Modal Volume: {run_dir} -->", file=__import__("sys").stderr)
        if local_out:
            import os as _os
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            stem = _os.path.basename(run_dir)  # e.g. 2026-04-22T15-23-45Z-tau
            (out / f"{stem}.md").write_text(report)
            (out / f"{stem}.json").write_text(result_json_str)
            print(f"<!-- mirrored to host: {out / stem}.{{md,json}} -->", file=__import__("sys").stderr)
    elif mode == "warmup-longmemeval":
        result = run_longmemeval_warmup.remote(
            corpus_size=corpus_size,
            extractor_model=extractor_model,
            stratified_sample=stratified_sample,
            stratify_seed=stratify_seed,
            warmup_concurrency=warmup_concurrency,
            batch_size=batch_size,
        )
        print(json.dumps(result, indent=2))
    else:
        print(f"Unknown mode: {mode!r}. Expected 'hello', 'run-point', 'run-baselines', 'run-sweep', or 'warmup-longmemeval'.")
