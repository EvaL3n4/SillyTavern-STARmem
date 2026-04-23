"""Unit tests for BATCH_SIZE conversation-level-split sweep (Phase 11 Task 6).

Validates grid constants, render_batchsize_report shape, and aggregation helpers
without requiring the real Modal package.
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

from sweep_app import (
    BATCHSIZE_VALUES,
    BATCHSIZE_CONV_INDICES,
    render_batchsize_report,
)


def test_grid_is_5x5():
    assert len(BATCHSIZE_VALUES) == 5
    assert len(BATCHSIZE_CONV_INDICES) == 5
    assert 10 in BATCHSIZE_VALUES, "Spec default BATCH_SIZE=10 must be in grid"


def test_render_batchsize_shape():
    payload = {
        "name": "batchsize",
        "timestamp": "2026-04-24T00-00-00Z",
        "convs_sampled": [0, 1, 2, 3, 4],
        "points": [
            {
                "overrides": {"BATCH_SIZE": bs},
                "metrics": {
                    "n": 500,
                    "n_scored": 320,
                    "n_skipped": 180,
                    "coverage": 0.64,
                    "mrr": 0.80,
                    "updateRate": 0.02,
                },
            }
            for bs in BATCHSIZE_VALUES
        ],
        "elbow": {"overrides": {"BATCH_SIZE": 10}, "rationale": "spec default held"},
    }
    report = render_batchsize_report(payload)
    assert "# BATCH_SIZE sweep" in report
    for bs in BATCHSIZE_VALUES:
        assert f"| {bs} |" in report, f"BATCH_SIZE row {bs} missing from report"
    assert "Update rate" in report
