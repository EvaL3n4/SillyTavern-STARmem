"""Phase 12 Task 5: --corpus parameter wiring tests.

Don't dispatch real Modal; import sweep_app and exercise the pure
helpers (render_by_task_type) plus main()'s validation / kwarg
threading via the stubbed @app.function decorator pattern.
"""
from unittest.mock import patch

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
