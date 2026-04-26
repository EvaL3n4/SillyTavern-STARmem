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
