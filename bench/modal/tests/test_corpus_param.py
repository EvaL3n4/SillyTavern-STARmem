"""Phase 12 Task 5: --corpus parameter wiring tests.

Don't dispatch real Modal; import sweep_app and exercise the pure
helpers (render_by_task_type) plus main()'s validation / kwarg
threading via the stubbed @app.function decorator pattern.
"""
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Stub the real `modal` package. sweep_app.py imports modal at top level
# and calls modal.App(...), modal.Image.debian_slim(...) at import time;
# unit tests don't need the real package because we only exercise pure
# helpers + main()'s dispatch logic. We use a real ModuleType with
# selectively-stubbed attributes (not a bare MagicMock) so pytest's
# sys.modules introspection — which probes for attributes like
# pytest_plugins — doesn't fire on phantom attributes and trip a
# UsageError. Matches the pattern from test_baselines_mode.py.
if "modal" not in sys.modules or not hasattr(sys.modules["modal"], "App"):
    _modal = types.ModuleType("modal")

    def _identity_decorator(*args, **kwargs):
        def _wrap(fn):
            return fn
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]
        return _wrap

    _app = MagicMock()
    _app.function = _identity_decorator
    _app.local_entrypoint = _identity_decorator
    _modal.App = lambda *a, **kw: _app

    _image = MagicMock()
    _image.run_commands.return_value = _image
    _image.add_local_dir.return_value = _image

    class _Image:
        @staticmethod
        def debian_slim(*a, **kw):
            return _image

    _modal.Image = _Image

    class _Volume:
        @staticmethod
        def from_name(*a, **kw):
            return MagicMock()

    _modal.Volume = _Volume

    class _Secret:
        @staticmethod
        def from_dotenv(*a, **kw):
            return MagicMock()

    _modal.Secret = _Secret

    sys.modules["modal"] = _modal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

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
