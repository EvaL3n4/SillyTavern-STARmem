"""Regression tests for baselines mode dispatch and report renderer.

Validates BASELINE_IDS canonical list, render_baselines_report table shape,
and structural invariant PASS/FAIL logic.
"""

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
