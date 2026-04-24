"""Regression tests for _detect_elbow + _elbow_on_slice flat-axis guard.

Field-validated against the 3 false-positives surfaced during STARmem sub-phase
9.5 (TIER2_TAU_CONFIDENCE, bm25 TAG_BOOST×SUBJECT_BOOST grid, EXPLICIT_RELATION_WEIGHT).
See docs/plans/phase-9-5-retro.md §4 surprise #3.
"""

from sweep_app import _detect_elbow, _elbow_on_slice


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
