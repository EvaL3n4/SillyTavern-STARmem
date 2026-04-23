"""Regression tests for baselines mode dispatch and report renderer.

Validates BASELINE_IDS canonical list, render_baselines_report table shape,
and structural invariant PASS/FAIL logic.
"""
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

# Stub the real `modal` package. sweep_app.py imports modal at top level
# and calls modal.App(...), modal.Image.debian_slim(...) at import time;
# unit tests don't need the real package because we only exercise pure
# helpers. We use a real ModuleType with selectively-stubbed attributes
# (not a bare MagicMock) so pytest's sys.modules introspection — which
# probes for attributes like pytest_plugins — doesn't fire on phantom
# attributes and trip a UsageError.
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

# Allow `from sweep_app import ...` when run via `pytest bench/modal/tests/`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sweep_app import BASELINE_IDS, render_baselines_report


def test_baseline_ids_canonical():
    assert BASELINE_IDS == ["ladder", "bm25only", "recency", "random"]


def test_render_baselines_report_shape():
    payload = {
        "name": "baselines",
        "timestamp": "2026-04-23T00-00-00Z",
        "points": [
            {"retrieverId": "ladder",   "metrics": {"mrr": 0.8057, "coverage": 0.64, "recallAtK": {"5": 0.61, "10": 0.70}}, "latencyMs": 12.3},
            {"retrieverId": "bm25only", "metrics": {"mrr": 0.6898, "coverage": 0.62, "recallAtK": {"5": 0.55, "10": 0.65}}, "latencyMs": 8.1},
            {"retrieverId": "recency",  "metrics": {"mrr": 0.1200, "coverage": 0.62, "recallAtK": {"5": 0.10, "10": 0.15}}, "latencyMs": 3.5},
            {"retrieverId": "random",   "metrics": {"mrr": 0.0500, "coverage": 0.62, "recallAtK": {"5": 0.04, "10": 0.08}}, "latencyMs": 2.0},
        ],
    }
    report = render_baselines_report(payload)
    assert "# Baselines comparison" in report
    assert "ladder" in report and "bm25only" in report
    assert "0.8057" in report
    assert "PASS" in report  # 0.8057 - 0.6898 >= -0.02


def test_structural_invariant_fails_when_ladder_worse():
    payload = {
        "name": "baselines",
        "timestamp": "x",
        "points": [
            {"retrieverId": "ladder",   "metrics": {"mrr": 0.50, "coverage": 0.60, "recallAtK": {"5": 0.3, "10": 0.4}}, "latencyMs": 10.0},
            {"retrieverId": "bm25only", "metrics": {"mrr": 0.80, "coverage": 0.60, "recallAtK": {"5": 0.5, "10": 0.6}}, "latencyMs": 8.0},
        ],
    }
    report = render_baselines_report(payload)
    assert "FAIL" in report
