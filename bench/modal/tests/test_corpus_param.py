"""Phase 12 Task 5: --corpus parameter wiring tests.

Don't dispatch real Modal; import sweep_app and exercise the pure
helpers (render_by_task_type) plus main()'s validation / kwarg
threading via the stubbed @app.function decorator pattern.
"""
from unittest.mock import MagicMock, patch

import pytest

import sweep_app
from sweep_app import render_by_task_type

# --- main() validation + threading ---------------------------------------


def test_main_rejects_unknown_corpus():
    """--corpus foo must raise, not silently default to locomo."""
    with pytest.raises(ValueError, match="must be one of"):
        sweep_app.main(mode="run-point", corpus="foo")


def test_main_accepts_locomo_and_longmemeval_s():
    """Both canonical corpus names must pass validation and thread through."""
    with patch.object(sweep_app, "run_point") as mock_rp:
        mock_rp.remote.return_value = '{"metrics": {}, "latencyMs": 0, "runCount": 0, "wallMs": 0, "envSnapshot": {}}'
        sweep_app.main(mode="run-point", corpus="locomo")
        sweep_app.main(mode="run-point", corpus="longmemeval-s")
        assert mock_rp.remote.call_count == 2
        assert mock_rp.remote.call_args_list[0].kwargs.get("corpus") == "locomo"
        assert mock_rp.remote.call_args_list[1].kwargs.get("corpus") == "longmemeval-s"


def test_run_baselines_threads_corpus():
    """run-baselines mode passes corpus through to run_baselines.remote()."""
    with patch.object(sweep_app, "run_baselines") as mock_rb:
        mock_rb.remote.return_value = {"report": "", "result_json": "{}", "run_dir": "/tmp"}
        sweep_app.main(mode="run-baselines", corpus="longmemeval-s")
        assert mock_rb.remote.call_args.kwargs.get("corpus") == "longmemeval-s"


def test_run_baselines_threads_stratified_sample():
    """--stratified-sample + --stratify-seed reach run_baselines.remote()."""
    with patch.object(sweep_app, "run_baselines") as mock_rb:
        mock_rb.remote.return_value = {"report": "", "result_json": "{}", "run_dir": "/tmp"}
        sweep_app.main(
            mode="run-baselines",
            corpus="longmemeval-s",
            stratified_sample=50,
            stratify_seed=1234,
        )
        kwargs = mock_rb.remote.call_args.kwargs
        assert kwargs.get("stratified_sample") == 50
        assert kwargs.get("stratify_seed") == 1234


def test_warmup_longmemeval_threads_stratified_sample():
    """--stratified-sample + --stratify-seed reach run_longmemeval_warmup.remote()."""
    with patch.object(sweep_app, "run_longmemeval_warmup") as mock_wu:
        mock_wu.remote.return_value = {"warmedCount": 0, "failedCount": 0}
        sweep_app.main(
            mode="warmup-longmemeval",
            corpus="longmemeval-s",
            stratified_sample=50,
            stratify_seed=2026,
        )
        kwargs = mock_wu.remote.call_args.kwargs
        assert kwargs.get("stratified_sample") == 50
        assert kwargs.get("stratify_seed") == 2026


def test_warmup_longmemeval_threads_batch_size():
    """--batch-size reaches run_longmemeval_warmup.remote() so the regression
    check can hit cache entries written by a non-default-BS warmup dispatch.

    Phase 12 Task 6.5: the vllm_warmup pre-warming pass enumerates batches
    at BS=15 (live-evidenced sweep from 2026-04-23). The Modal-driven
    re-extraction warmup MUST be able to do the same, otherwise the cache
    key (model, messages, maxTokens) drifts and `misses` skyrockets.
    """
    with patch.object(sweep_app, "run_longmemeval_warmup") as mock_wu:
        mock_wu.remote.return_value = {"warmedCount": 0, "failedCount": 0}
        sweep_app.main(
            mode="warmup-longmemeval",
            corpus="longmemeval-s",
            batch_size=15,
        )
        kwargs = mock_wu.remote.call_args.kwargs
        assert kwargs.get("batch_size") == 15


def test_warmup_longmemeval_batch_size_default_zero_omits_override():
    """No --batch-size flag = batch_size=0 = no override (use spec default).

    Backward compatibility: existing `--mode warmup-longmemeval` callers
    without the new flag must keep producing the live-pipeline-default
    cache shape.
    """
    with patch.object(sweep_app, "run_longmemeval_warmup") as mock_wu:
        mock_wu.remote.return_value = {"warmedCount": 0, "failedCount": 0}
        sweep_app.main(
            mode="warmup-longmemeval",
            corpus="longmemeval-s",
        )
        kwargs = mock_wu.remote.call_args.kwargs
        assert kwargs.get("batch_size") == 0


def test_run_longmemeval_warmup_point_sets_batch_size_env():
    """When run_longmemeval_warmup_point is called with batch_size>0, it
    sets STARMEM_BATCH_SIZE on the subprocess env so the JS warmup point
    applies the runtime constant override before enumerating batches.
    Default (batch_size=0) leaves the env var unset so the live pipeline's
    spec-default BATCH_SIZE is used.
    """
    import os as _os
    import subprocess as _subprocess

    captured_envs = []

    class _StubProc:
        returncode = 0
        stdout = '{"itemIdx": 0, "factCount": 0, "turnsProcessed": 0, "consolidationStats": {}, "wallMs": 0}'
        stderr = ""

        def communicate(self, timeout=None):
            return (self.stdout, self.stderr)

        def wait(self, timeout=None):
            return self.returncode

    def _capture_popen(*args, **kwargs):
        captured_envs.append(dict(kwargs.get("env") or _os.environ))
        return _StubProc()

    # The Modal stubs in conftest.py replace @app.function decorators with
    # an identity decorator, so run_longmemeval_warmup_point is callable as
    # a plain function. Stub the heavy lifting (subprocess.Popen, the
    # symlink installer, volume.commit) and inspect the captured env.
    with patch.object(_subprocess, "Popen", side_effect=_capture_popen), \
         patch.object(sweep_app, "_install_volume_symlink", lambda *a, **k: None), \
         patch.object(sweep_app, "volume", MagicMock()), \
         patch.object(_os, "makedirs", lambda *a, **k: None), \
         patch.object(_os.path, "exists", lambda *a, **k: True):

        # batch_size=15 → env carries STARMEM_BATCH_SIZE=15
        sweep_app.run_longmemeval_warmup_point(
            item_idx=0,
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
            warmup_concurrency=1,
            batch_size=15,
        )
        assert len(captured_envs) >= 1
        assert captured_envs[-1].get("STARMEM_BATCH_SIZE") == "15", (
            "STARMEM_BATCH_SIZE should be set on subprocess env when "
            "batch_size override is provided"
        )

        # batch_size=0 (default) → env does NOT carry STARMEM_BATCH_SIZE
        sweep_app.run_longmemeval_warmup_point(
            item_idx=0,
            extractor_model="",
            warmup_concurrency=1,
            batch_size=0,
        )
        assert "STARMEM_BATCH_SIZE" not in captured_envs[-1], (
            "STARMEM_BATCH_SIZE must NOT be set when batch_size=0 — "
            "absence is the signal to use the live pipeline's spec default"
        )


def test_run_longmemeval_warmup_threads_batch_size_to_starmap():
    """The orchestrator threads batch_size through the starmap tuple so
    each container sees its own batch_size override. Threading explicitly
    instead of relying on env-inheritance follows the same pattern that
    fixed warmup_concurrency on 2026-04-23 (Modal containers don't
    inherit driver-process env vars).
    """
    captured_starmap_args = []

    class _MockStarmapResult:
        def __init__(self, args_list):
            captured_starmap_args.extend(args_list)

        def __iter__(self):
            return iter([])

    def _capture_starmap(args_iter):
        return _MockStarmapResult(list(args_iter))

    mock_point = MagicMock()
    mock_point.starmap = _capture_starmap

    with patch.object(sweep_app, "run_longmemeval_warmup_point", mock_point), \
         patch.object(sweep_app, "volume", MagicMock()), \
         patch("os.makedirs", lambda *a, **k: None), \
         patch("os.path.exists", lambda *a, **k: True), \
         patch("os.listdir", lambda *a, **k: []), \
         patch("builtins.open", MagicMock()):

        sweep_app.run_longmemeval_warmup(
            corpus_size=2,
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
            warmup_concurrency=1,
            batch_size=15,
        )

        assert len(captured_starmap_args) == 2, (
            f"expected 2 starmap tuples, got {len(captured_starmap_args)}"
        )
        for tup in captured_starmap_args:
            # Tuple shape: (item_idx, extractor_model, warmup_concurrency, batch_size)
            assert len(tup) == 4, (
                f"starmap tuple must be 4-ary (was 3 before this commit); "
                f"got {len(tup)}: {tup}"
            )
            assert tup[3] == 15, (
                f"batch_size (4th element) should be 15 in every tuple; got {tup[3]}"
            )


# --- render_by_task_type -------------------------------------------------


def test_render_by_task_type_empty_returns_placeholder():
    """Empty byTaskType dict shows informational message."""
    out = render_by_task_type({})
    assert "No per-task-type slice available" in out


def test_render_by_task_type_canonical_order():
    """LongMemEval 6 types in canonical order, single-session-user first."""
    data = {
        "multi-session":             {"mrr": 0.5, "coverage": 0.6, "n_scored": 50, "n_skipped": 10},
        "single-session-user":       {"mrr": 0.9, "coverage": 0.95, "n_scored": 100, "n_skipped": 5},
    }
    out = render_by_task_type(data)
    lines = out.strip().split("\n")
    # Header row + separator row + 2 data rows = 4 lines
    assert len(lines) == 4
    assert "single-session-user" in lines[2]
    assert "multi-session" in lines[3]


# --- Phase 12 Task 7: extractor_model + lambda1_tripwire wiring ----------


def _default_ok_chunk_payload():
    """Phase 13: minimal ok payload from a chunk run. Capture-style starmap
    tests need to return this for each arg so the cell aggregator doesn't
    treat every cell as 'no_chunks_returned' and abort with all-fail
    RuntimeError. Tests that ONLY care about starmap input shape can use
    a capture function that returns these for every arg."""
    import json as _json
    return _json.dumps({
        "overrides": {"PLACEHOLDER": 1},
        "itemIndices": [0],
        "runs": [],
        "metrics": {},
        "latencyMs": {"p50": 0, "p95": 0},
        "runCount": 0,
        "wallMs": 0,
        "aggStats": None,
    })


def _stub_recompute_subprocess():
    """Phase 13: run_sweep subprocess.run()'s the _recompute-metrics.js
    helper per cell. Stub it to return a deterministic minimal payload
    so capture-style tests don't need a real Node binary."""
    import json as _json
    import subprocess as _subprocess

    class _StubResult:
        returncode = 0
        stdout = _json.dumps({
            "metrics": {
                "mrr": 0.0,
                "coverage": 0.0,
                "n_scored": 0,
                "n_skipped": 0,
                "recallAtK": {"1": 0.0, "3": 0.0, "5": 0.0, "10": 0.0},
                "precisionAtK": {"1": 0.0, "3": 0.0, "5": 0.0, "10": 0.0},
            },
            "aggStats": None,
        })
        stderr = ""

    return patch.object(_subprocess, "run", lambda *a, **k: _StubResult())


def _patched_run_sweep_env():
    """Common context-managers for run_sweep tests — stubs file I/O and
    the symlink installer so the test stays in pure-helper territory.

    Phase 13: also stubs the _recompute-metrics.js subprocess.run call
    so capture-style tests don't need Node available.
    """
    return [
        patch.object(sweep_app, "_install_volume_symlink", lambda *a, **k: None),
        patch.object(sweep_app, "_detect_elbow", lambda *a, **k: {}),
        patch.object(sweep_app, "volume", MagicMock()),
        patch("os.makedirs", lambda *a, **k: None),
        patch("builtins.open", MagicMock()),
        _stub_recompute_subprocess(),
    ]


def _enter_all(ctxs):
    """Manually enter a list of context managers (patch.object returns
    them) so the body of the test can use them all without nested `with`.
    """
    return [c.__enter__() for c in ctxs]


def _exit_all(ctxs):
    for c in ctxs:
        c.__exit__(None, None, None)


def test_run_sweep_threads_extractor_model_to_starmap():
    """run_sweep forwards extractor_model into the run_point.starmap tuple
    so every container's run_point receives the override and sets
    STARMEM_BENCH_LLM_MODEL on its node subprocess.

    Phase 12 Task 7: without this, a sweep against the Modal vLLM
    Qwen-warmed cache falls back to env_secret's gemma model and misses
    100% — same cache-key-alignment trap that bit Task 6 (commit 51a677e).
    """
    captured_starmap_args = []

    def _capture_starmap(args_iter):
        args_list = list(args_iter)
        captured_starmap_args.extend(args_list)
        # Phase 13: return one ok-chunk payload per arg so the cell
        # aggregator gets a non-empty per-cell chunk list and the test
        # doesn't trip the all-fail RuntimeError before its assertions run.
        return [_default_ok_chunk_payload() for _ in args_list]

    mock_run_point_chunk = MagicMock()
    mock_run_point_chunk.starmap = _capture_starmap

    ctxs = [patch.object(sweep_app, "run_point_chunk", mock_run_point_chunk)] + _patched_run_sweep_env()
    _enter_all(ctxs)
    try:
        # lambda1_tripwire is the production target, but any sweep_name in
        # the generic dispatch path exercises the same starmap shape.
        sweep_app.run_sweep(
            sweep_name="lambda1_tripwire",
            synthetic=False,
            corpus="longmemeval-s",
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
        )
    finally:
        _exit_all(ctxs)

    # Phase 13: 5 grid points × 6 chunks (heuristic for 500-item corpus) = 30
    assert len(captured_starmap_args) == 30, (
        f"expected 5 cells × 6 chunks = 30 starmap tuples for lambda1_tripwire grid, got {len(captured_starmap_args)}"
    )
    for tup in captured_starmap_args:
        # Phase 13 tuple shape: (overrides_json, corpus, extractor_model, item_indices_json)
        assert len(tup) == 4, (
            f"starmap tuple must be 4-ary (Phase 13 added item_indices_json); got {len(tup)}: {tup}"
        )
        assert tup[1] == "longmemeval-s"
        assert tup[2] == "Qwen/Qwen3.6-35B-A3B-FP8", (
            f"extractor_model (3rd element) must be threaded into every starmap tuple; got {tup[2]!r}"
        )
        # Item indices must parse as a non-empty JSON array
        import json as _json
        indices = _json.loads(tup[3])
        assert isinstance(indices, list) and len(indices) > 0


def test_run_sweep_extractor_model_default_empty_string():
    """Default extractor_model='' threads through unchanged (env_secret wins).

    Backward-compat: existing run-sweep callers (tau, bm25, hops, relw)
    that don't pass --extractor-model continue to inherit the .env.bench
    STARMEM_BENCH_LLM_MODEL setting in each container.
    """
    captured_starmap_args = []

    def _capture_starmap(args_iter):
        args_list = list(args_iter)
        captured_starmap_args.extend(args_list)
        # Phase 13: return one ok-chunk payload per arg so the cell
        # aggregator gets a non-empty per-cell chunk list and the test
        # doesn't trip the all-fail RuntimeError before its assertions run.
        return [_default_ok_chunk_payload() for _ in args_list]

    mock_run_point_chunk = MagicMock()
    mock_run_point_chunk.starmap = _capture_starmap

    ctxs = [patch.object(sweep_app, "run_point_chunk", mock_run_point_chunk)] + _patched_run_sweep_env()
    _enter_all(ctxs)
    try:
        sweep_app.run_sweep(
            sweep_name="hops",
            synthetic=False,
            corpus="locomo",
        )
    finally:
        _exit_all(ctxs)

    assert len(captured_starmap_args) >= 1
    for tup in captured_starmap_args:
        # Phase 13 tuple shape: (overrides_json, corpus, extractor_model, item_indices_json)
        assert tup[2] == "", (
            f"extractor_model defaults to '' (sentinel for env_secret inheritance); got {tup[2]!r}"
        )


def test_run_sweep_lambda1_tripwire_inlines_batch_size_and_tau_gap():
    """lambda1_tripwire inlines BOTH TIER2_TAU_GAP=10 AND BATCH_SIZE=15
    into every grid point's overrides JSON.

    BATCH_SIZE=15 is the cache-key alignment fix from Phase 12 Task 6.5
    retro: the Modal vLLM cache was warmed at BS=15, so the read path
    must enumerate at BS=15 too. TIER2_TAU_GAP=10 is the Tier 3
    reachability invariant inherited from hops/relw.
    """
    captured_starmap_args = []

    def _capture_starmap(args_iter):
        args_list = list(args_iter)
        captured_starmap_args.extend(args_list)
        # Phase 13: return one ok-chunk payload per arg so the cell
        # aggregator gets a non-empty per-cell chunk list and the test
        # doesn't trip the all-fail RuntimeError before its assertions run.
        return [_default_ok_chunk_payload() for _ in args_list]

    mock_run_point_chunk = MagicMock()
    mock_run_point_chunk.starmap = _capture_starmap

    ctxs = [patch.object(sweep_app, "run_point_chunk", mock_run_point_chunk)] + _patched_run_sweep_env()
    _enter_all(ctxs)
    try:
        sweep_app.run_sweep(
            sweep_name="lambda1_tripwire",
            synthetic=False,
            corpus="longmemeval-s",
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
        )
    finally:
        _exit_all(ctxs)

    import json as _json
    for tup in captured_starmap_args:
        overrides = _json.loads(tup[0])
        assert overrides.get("TIER2_TAU_GAP") == 10, (
            f"every lambda1_tripwire point must inline TIER2_TAU_GAP=10; got {overrides!r}"
        )
        assert overrides.get("BATCH_SIZE") == 15, (
            f"every lambda1_tripwire point must inline BATCH_SIZE=15 for "
            f"cache-key alignment with the Modal vLLM warmed cache; got {overrides!r}"
        )
        assert "TIER3_LAMBDA_1" in overrides, (
            f"every lambda1_tripwire point must carry the swept TIER3_LAMBDA_1 value; got {overrides!r}"
        )


def test_run_sweep_hops_unchanged_after_table_refactor():
    """The _SWEEP_BASE_OVERRIDES table refactor must not regress the
    pre-existing hops/relw inlining (TIER2_TAU_GAP=10 only, no BATCH_SIZE).
    """
    captured_starmap_args = []

    def _capture_starmap(args_iter):
        args_list = list(args_iter)
        captured_starmap_args.extend(args_list)
        # Phase 13: return one ok-chunk payload per arg so the cell
        # aggregator gets a non-empty per-cell chunk list and the test
        # doesn't trip the all-fail RuntimeError before its assertions run.
        return [_default_ok_chunk_payload() for _ in args_list]

    mock_run_point_chunk = MagicMock()
    mock_run_point_chunk.starmap = _capture_starmap

    ctxs = [patch.object(sweep_app, "run_point_chunk", mock_run_point_chunk)] + _patched_run_sweep_env()
    _enter_all(ctxs)
    try:
        sweep_app.run_sweep(sweep_name="hops", synthetic=False, corpus="locomo")
    finally:
        _exit_all(ctxs)

    import json as _json
    for tup in captured_starmap_args:
        overrides = _json.loads(tup[0])
        assert overrides.get("TIER2_TAU_GAP") == 10
        assert "BATCH_SIZE" not in overrides, (
            f"hops must NOT inline BATCH_SIZE (only lambda1_tripwire does); got {overrides!r}"
        )


def test_main_run_sweep_threads_extractor_model():
    """`modal run ... --mode run-sweep --extractor-model M` reaches
    run_sweep.remote(extractor_model=M)."""
    with patch.object(sweep_app, "run_sweep") as mock_rs:
        mock_rs.remote.return_value = {"report": "", "result_json": "{}", "run_dir": "/tmp"}
        sweep_app.main(
            mode="run-sweep",
            sweep_name="lambda1_tripwire",
            corpus="longmemeval-s",
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
        )
        kwargs = mock_rs.remote.call_args.kwargs
        assert kwargs.get("corpus") == "longmemeval-s"
        assert kwargs.get("extractor_model") == "Qwen/Qwen3.6-35B-A3B-FP8"


def test_main_run_point_threads_extractor_model():
    """`modal run ... --mode run-point --extractor-model M` reaches
    run_point.remote(extractor_model=M)."""
    with patch.object(sweep_app, "run_point") as mock_rp:
        mock_rp.remote.return_value = '{"metrics": {}, "latencyMs": 0, "runCount": 0, "wallMs": 0}'
        sweep_app.main(
            mode="run-point",
            corpus="longmemeval-s",
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
        )
        kwargs = mock_rp.remote.call_args.kwargs
        assert kwargs.get("extractor_model") == "Qwen/Qwen3.6-35B-A3B-FP8"


def test_run_point_sets_llm_model_env_when_extractor_model_passed():
    """run_point sets STARMEM_BENCH_LLM_MODEL on the node subprocess env
    when extractor_model is provided. Mirrors run_baseline_point's pattern.
    """
    import os as _os
    import subprocess as _subprocess

    captured_envs = []

    # Phase 12 Task 7 (commit ee1d563): run_point now uses subprocess.Popen
    # (live stderr streaming) instead of subprocess.run. Stub the Popen
    # surface that run_point actually consumes: __init__ captures the env,
    # communicate() returns (stdout, stderr) tuple, returncode attribute
    # is read after.
    class _StubProc:
        def __init__(self, *args, **kwargs):
            captured_envs.append(dict(kwargs.get("env") or _os.environ))
            self.returncode = 0
            self._stdout = '{"overrides": {}, "metrics": {}, "latencyMs": 0, "runCount": 0, "wallMs": 0, "aggStats": null}'

        def communicate(self):
            return (self._stdout, "")

    with patch.object(_subprocess, "Popen", _StubProc), \
         patch.object(sweep_app, "_install_volume_symlink", lambda *a, **k: None), \
         patch.object(sweep_app, "volume", MagicMock()), \
         patch.object(_os, "makedirs", lambda *a, **k: None), \
         patch.object(_os.path, "exists", lambda *a, **k: True), \
         patch.object(_os.path, "isdir", lambda *a, **k: True), \
         patch.object(_os.path, "islink", lambda *a, **k: False), \
         patch.object(_os.path, "getsize", lambda *a, **k: 0), \
         patch.object(_os, "listdir", lambda *a, **k: []):

        sweep_app.run_point(
            overrides_json='{"TIER3_LAMBDA_1": 1.0}',
            corpus="longmemeval-s",
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
        )
        assert captured_envs[-1].get("STARMEM_BENCH_LLM_MODEL") == "Qwen/Qwen3.6-35B-A3B-FP8"
        assert captured_envs[-1].get("STARMEM_BENCH_CORPUS") == "longmemeval-s"

        # Default extractor_model='' must NOT set the env var (env_secret wins)
        captured_envs.clear()
        sweep_app.run_point(
            overrides_json='{"TIER3_LAMBDA_1": 1.0}',
            corpus="locomo",
        )
        # Env was os.environ.copy() — the var may exist from the host shell.
        # The contract is: when extractor_model is empty, run_point MUST NOT
        # write its own value. Distinguish by checking the value matches the
        # original env, not our test sentinel.
        assert captured_envs[-1].get("STARMEM_BENCH_LLM_MODEL") != "Qwen/Qwen3.6-35B-A3B-FP8"


def test_render_single_axis_report_uses_corpus_label():
    """Phase 12 Task 7: when corpus='longmemeval-s', the report header says
    'LongMemEval-S-N', not 'LoCoMo-N'. Default 'locomo' preserves existing
    hops/relw behavior.
    """
    fake_result = {
        "name": "lambda1_tripwire",
        "points": [
            {
                "overrides": {"TIER3_LAMBDA_1": 1.0, "TIER2_TAU_GAP": 10, "BATCH_SIZE": 15},
                "metrics": {"mrr": 0.5, "recallAtK": {"5": 0.6}, "coverage": 0.7, "n_scored": 100},
                "latencyMs": {"p50": 1.0, "p95": 2.0},
            },
        ],
        "elbow": {"overrides": {"TIER3_LAMBDA_1": 1.0}, "rationale": "spec default"},
    }
    out_long = sweep_app.render_single_axis_report(fake_result, 500, 500, corpus="longmemeval-s")
    assert "LongMemEval-S-500" in out_long, f"corpus label missing/wrong: {out_long[:300]}"
    assert "LoCoMo" not in out_long.split("##")[0]  # not in the corpus block

    out_locomo = sweep_app.render_single_axis_report(fake_result, 10, 1986)
    assert "LoCoMo-10" in out_locomo, f"default corpus label regressed: {out_locomo[:300]}"


# --- Phase 12 Task 7 follow-up: error-payload partitioning ---------------


def test_run_sweep_partitions_error_payloads_and_raises_on_total_failure(capsys):
    """When every run_point returns an error payload (subprocess crash),
    run_sweep must surface stderr loudly and raise RuntimeError instead of
    crashing with `KeyError: 'overrides'` 50 lines deep in _detect_elbow.

    Field-validated 2026-04-26: a real lambda1_tripwire dispatch hit
    `KeyError: 'overrides'` because at least one point's node subprocess
    failed; the original code blindly forwarded error-shape dicts into
    _detect_elbow and the renderer.
    """
    error_payload = {
        "error": "node subprocess failed",
        "returncode": 1,
        "stderr": "Error: spec violation in retrieval ladder\n  at line 42",
        "stdout_tail": "",
        "diagnostics": {"corpus_link_target": "/data/longmemeval_s_cleaned.json"},
    }

    mock_run_point_chunk = MagicMock()
    # Phase 13: every chunk fails → every cell becomes a chunk_failure
    # error_point. With 5 cells × 6 chunks = 30 dispatches, we return 30
    # identical error payloads.
    mock_run_point_chunk.starmap = lambda args_iter: [
        __import__("json").dumps(error_payload) for _ in args_iter
    ]

    ctxs = [patch.object(sweep_app, "run_point_chunk", mock_run_point_chunk)] + _patched_run_sweep_env()
    _enter_all(ctxs)
    try:
        with pytest.raises(RuntimeError, match="all 5 cells failed"):
            sweep_app.run_sweep(
                sweep_name="lambda1_tripwire",
                synthetic=False,
                corpus="longmemeval-s",
                extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
            )
    finally:
        _exit_all(ctxs)

    captured = capsys.readouterr()
    assert "5 of 5 cells failed" in captured.err
    assert "node subprocess failed" in captured.err
    assert "spec violation in retrieval ladder" in captured.err, (
        "stderr from failing node subprocess must be surfaced — operator "
        "needs the actual error message, not a confusing KeyError"
    )


def test_run_sweep_partial_failure_continues_with_ok_subset(capsys):
    """When only SOME points fail, run_sweep proceeds with the successful
    subset (rendering, elbow detection) but persists the error_points
    field on the result so the artifact stays honest.
    """
    ok_payload = {
        "overrides": {"TIER3_LAMBDA_1": 1.0, "TIER2_TAU_GAP": 10, "BATCH_SIZE": 15},
        "itemIndices": [0, 1, 2],
        "runs": [],   # empty runs[]; the recompute helper handles n=0
        "metrics": {"mrr": 0.5, "recallAtK": {"5": 0.6}, "coverage": 0.7, "n_scored": 100},
        "latencyMs": {"p50": 1.0, "p95": 2.0},
        "runCount": 100,
        "wallMs": 1000,
        "aggStats": None,
    }
    error_payload = {
        "error": "node subprocess failed",
        "returncode": 1,
        "stderr": "transient OOM",
        "stdout_tail": "",
        "diagnostics": {},
    }

    import json as _json
    # Phase 13: 5 cells × 6 chunks = 30 dispatches.
    # We taint the LAST cell entirely (chunks 24-29 = 6 errors) so 4 cells
    # succeed and 1 cell becomes a chunk_failure error_point.
    sequence = [_json.dumps(ok_payload)] * 24 + [_json.dumps(error_payload)] * 6

    mock_run_point_chunk = MagicMock()
    mock_run_point_chunk.starmap = lambda _args: sequence

    # Phase 13: run_sweep also subprocess.run()'s the _recompute-metrics.js
    # helper per cell. Stub it to return a deterministic recompute payload.
    import subprocess as _subprocess

    class _StubRecomputeResult:
        returncode = 0
        stdout = _json.dumps({
            "metrics": {"mrr": 0.5, "coverage": 0.7, "n_scored": 0},
            "aggStats": None,
        })
        stderr = ""

    def _stub_subprocess_run(*a, **k):
        return _StubRecomputeResult()

    ctxs = [
        patch.object(sweep_app, "run_point_chunk", mock_run_point_chunk),
        patch.object(_subprocess, "run", _stub_subprocess_run),
    ] + _patched_run_sweep_env()
    _enter_all(ctxs)
    try:
        # Should not raise — partial failure is allowed.
        sweep_app.run_sweep(
            sweep_name="lambda1_tripwire",
            synthetic=False,
            corpus="longmemeval-s",
            extractor_model="Qwen/Qwen3.6-35B-A3B-FP8",
        )
    finally:
        _exit_all(ctxs)

    captured = capsys.readouterr()
    assert "1 of 5 cells failed" in captured.err, (
        "operator must see partial-failure summary in stderr"
    )
