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
    # 8 points along a synthetic FAKE_KNOB_A axis, MRR identical to 4dp.
    # Phase 14 Task 2: Constants renamed from TIER2_TAU_CONFIDENCE/_GAP to
    # FAKE_KNOB_A/B since those constants were demolished — _detect_elbow
    # doesn't validate names, so the test fixture works with any string.
    # Original narrative: this models the 9.5 TIER2_TAU_CONFIDENCE sweep
    # reality (identical MRR to 4dp across 8 points).
    points = [
        _mk_point({"FAKE_KNOB_A": v, "FAKE_KNOB_B": 10}, 0.8057)
        for v in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]
    ]
    knobs = [
        {"name": "FAKE_KNOB_A", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
        {"name": "FAKE_KNOB_B", "values": [10]},
    ]
    result = _detect_elbow(points, knobs, "mrr")
    rationale = result["rationale"].lower()
    assert "held at spec" in rationale or "flat" in rationale, (
        f"Expected flat-axis rationale, got: {result['rationale']!r}"
    )


def test_genuine_elbow_still_detected():
    """Monotonic climb into plateau must still surface the elbow."""
    # Phase 14 Task 2 rename: TIER2_TAU_GAP → FAKE_KNOB_B for the synthetic
    # fixture. Original narrative: 9.4.8/9.5 TIER2_TAU_GAP reality climbed
    # 0.73 → 0.81 across gap 0.1..10.
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
        _mk_point({"FAKE_KNOB_B": gap, "FAKE_KNOB_A": 2.0}, mrr)
        for gap, mrr in gaps_and_mrrs
    ]
    knobs = [
        {"name": "FAKE_KNOB_B", "values": [g for g, _ in gaps_and_mrrs]},
        {"name": "FAKE_KNOB_A", "values": [2.0]},
    ]
    result = _detect_elbow(points, knobs, "mrr")
    # Expect an elbow somewhere in [3.0, 10.0] — the plateau shoulder.
    chosen_gap = result["overrides"]["FAKE_KNOB_B"]
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
