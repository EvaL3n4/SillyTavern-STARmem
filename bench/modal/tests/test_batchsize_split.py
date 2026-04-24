"""Unit tests for BATCH_SIZE conversation-level-split sweep (Phase 11 Task 6).

Validates grid constants, render_batchsize_report shape, and aggregation helpers
without requiring the real Modal package.
"""

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
