"""Regression tests for _detect_elbow + _elbow_on_slice flat-axis guard.

Field-validated against the 3 false-positives surfaced during STARmem sub-phase
9.5 (TIER2_TAU_CONFIDENCE, bm25 TAG_BOOST×SUBJECT_BOOST grid, EXPLICIT_RELATION_WEIGHT).
See docs/plans/phase-9-5-retro.md §4 surprise #3.
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

from sweep_app import _detect_elbow, _elbow_on_slice  # noqa: E402


def _mk_point(overrides, mrr):
    return {"overrides": overrides, "metrics": {"mrr": mrr}}


def test_flat_axis_is_held_at_spec():
    """Flat MRR axis must NOT produce an amendment proposal."""
    # 8 points along TIER2_TAU_CONFIDENCE, MRR identical to 4dp (9.5 τ sweep reality).
    points = [
        _mk_point({"TIER2_TAU_CONFIDENCE": v, "TIER2_TAU_GAP": 10}, 0.8057)
        for v in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
    ]
    knobs = [
        {"name": "TIER2_TAU_CONFIDENCE", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
        {"name": "TIER2_TAU_GAP", "values": [10]},
    ]
    result = _detect_elbow(points, knobs, "mrr")
    rationale = result["rationale"].lower()
    assert "held at spec" in rationale or "flat" in rationale, (
        f"Expected flat-axis rationale, got: {result['rationale']!r}"
    )


def test_genuine_elbow_still_detected():
    """Monotonic climb into plateau must still surface the elbow."""
    # 9.4.8/9.5 TIER2_TAU_GAP reality: climbs 0.73 → 0.81 across gap 0.1..10.
    gaps_and_mrrs = [
        (0.1, 0.7303),
        (0.5, 0.7450),
        (1.0, 0.7610),
        (2.0, 0.7780),
        (3.0, 0.7876),
        (5.0, 0.8000),
        (7.0, 0.8050),
        (10.0, 0.8057),
    ]
    points = [
        _mk_point({"TIER2_TAU_GAP": gap, "TIER2_TAU_CONFIDENCE": 2.0}, mrr)
        for gap, mrr in gaps_and_mrrs
    ]
    knobs = [
        {"name": "TIER2_TAU_GAP", "values": [g for g, _ in gaps_and_mrrs]},
        {"name": "TIER2_TAU_CONFIDENCE", "values": [2.0]},
    ]
    result = _detect_elbow(points, knobs, "mrr")
    # Expect an elbow somewhere in [3.0, 10.0] — the plateau shoulder.
    chosen_gap = result["overrides"]["TIER2_TAU_GAP"]
    assert chosen_gap >= 3.0, (
        f"Expected elbow at gap ≥ 3.0 on climbing axis; "
        f"got gap={chosen_gap}, rationale={result['rationale']!r}"
    )


def test_slice_returns_none_on_flat_axis():
    """Unit test on _elbow_on_slice directly — the guard's primary entry point."""
    points = [
        _mk_point({"X": v}, 0.5000) for v in [1, 2, 3, 4, 5]
    ]
    result = _elbow_on_slice(
        sorted_pts=sorted(points, key=lambda p: p["overrides"]["X"]),
        primary_name="X",
        accessor=lambda m: m["mrr"],
        ratio=0.1,
    )
    assert result is None, f"Expected None on flat axis; got {result!r}"
