"""Tests for bench/modal/sweep_app.py.

These tests exercise pure-Python helpers (chunk-plan construction,
heuristic math) without requiring Modal or a network connection. They
ride on the Phase 11 pattern of mocking Modal at import time so unit
tests can import sweep_app freely.

See docs/plans/phase-11-infrastructure-hardening.md for the import-time
sandbox pattern.
"""
import sys
import types
from unittest.mock import MagicMock


# Stub modal at import time so importing sweep_app doesn't require the
# real Modal SDK. Mirror of the Phase 11 Task 6 unit-test pattern.
def _identity_decorator(*args, **kwargs):
    def _wrap(fn):
        return fn
    if len(args) == 1 and callable(args[0]) and not kwargs:
        return args[0]
    return _wrap


def _stub_modal():
    existing = sys.modules.get("modal")
    if existing is not None and hasattr(existing, "App"):
        return

    mod = types.ModuleType("modal")
    app = MagicMock()
    app.function = _identity_decorator
    app.local_entrypoint = _identity_decorator
    mod.App = lambda *a, **kw: app

    image = MagicMock()
    image.run_commands.return_value = image
    image.add_local_dir.return_value = image
    image.pip_install.return_value = image
    image.entrypoint.return_value = image
    image.env.return_value = image

    class _Image:
        @staticmethod
        def debian_slim(*a, **kw):
            return image

        @staticmethod
        def from_registry(*a, **kw):
            return image

    mod.Image = _Image

    class _Volume:
        @staticmethod
        def from_name(*a, **kw):
            return MagicMock()

    mod.Volume = _Volume

    class _Secret:
        @staticmethod
        def from_dotenv(*a, **kw):
            return MagicMock()

        @staticmethod
        def from_name(*a, **kw):
            return MagicMock()

    mod.Secret = _Secret
    mod.Function = MagicMock()
    mod.FilePatternMatcher = lambda *a, **kw: MagicMock()
    mod.__path__ = [__import__("os").path.dirname(__file__)]
    sys.modules["modal"] = mod


_stub_modal()

import pytest

from sweep_app import _compute_chunk_plan


class TestChunkPlan:
    """Verify chunk-plan construction for representative inputs.

    Covers:
      - LoCoMo (10 items) → 1 chunk per cell, no fan-out overhead
      - LongMemEval-S full (500 items) → 6 chunks per cell at ~83 items
      - Stratified subsample (e.g. 100 items) → 1 chunk per cell
      - --chunks override paths
      - Edge cases: 1 item, exact multiple of chunk_size
    """

    def test_locomo_default_one_chunk(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=10, chunks_override=0,
        )
        assert n_chunks == 1
        assert chunk_size == 10
        assert len(plan) == 5   # 5 cells × 1 chunk
        # Every cell's single chunk covers all 10 items
        for cell_idx, chunk_idx, indices in plan:
            assert chunk_idx == 0
            assert indices == list(range(10))

    def test_longmemeval_s_full_six_chunks(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=500, chunks_override=0,
        )
        assert n_chunks == 6
        assert chunk_size == 84   # ceil(500/6)
        assert len(plan) == 5 * 6   # 30 chunk-cells total
        # First chunk of cell 0 covers 0..83; last chunk of cell 0 covers 420..499
        cell_0_chunks = [(ci, indices) for (cell, ci, indices) in plan if cell == 0]
        cell_0_chunks.sort(key=lambda t: t[0])
        assert cell_0_chunks[0][1][0] == 0
        assert cell_0_chunks[-1][1][-1] == 499
        # Every chunk has size <= chunk_size
        for _ci, indices in cell_0_chunks:
            assert len(indices) <= chunk_size
        # Coverage: union of all indices in cell 0 = full range
        union = set()
        for _ci, indices in cell_0_chunks:
            union.update(indices)
        assert union == set(range(500))

    def test_chunks_override_one_disables_fan_out(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=500, chunks_override=1,
        )
        assert n_chunks == 1
        assert chunk_size == 500
        assert len(plan) == 5

    def test_chunks_override_ten(self):
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=500, chunks_override=10,
        )
        assert n_chunks == 10
        assert chunk_size == 50
        assert len(plan) == 50   # 5 cells × 10 chunks

    def test_stratified_subsample_one_chunk(self):
        # A stratified 100-item subsample stays as 1 chunk per cell
        # since 100 // 80 = 1.
        n_chunks, _chunk_size, plan = _compute_chunk_plan(
            grid_size=5, corpus_size=100, chunks_override=0,
        )
        assert n_chunks == 1
        assert len(plan) == 5

    def test_corpus_exact_multiple_of_chunk_size(self):
        # 80 items, default heuristic = 80 // 80 = 1. No remainder issue.
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=1, corpus_size=80, chunks_override=0,
        )
        assert n_chunks == 1
        assert chunk_size == 80
        assert len(plan) == 1
        assert plan[0][2] == list(range(80))

    def test_empty_chunk_skipped(self):
        # 5 items split into 10 chunks: chunks 0..4 have 1 item each;
        # chunks 5..9 are empty and must be skipped.
        n_chunks, chunk_size, plan = _compute_chunk_plan(
            grid_size=1, corpus_size=5, chunks_override=10,
        )
        assert n_chunks == 10
        assert chunk_size == 1
        # Only 5 non-empty chunks survive
        assert len(plan) == 5
        # Each surviving chunk covers exactly one item
        for cell_idx, chunk_idx, indices in plan:
            assert len(indices) == 1
            assert indices[0] == chunk_idx

    def test_single_item_corpus(self):
        n_chunks, _chunk_size, plan = _compute_chunk_plan(
            grid_size=1, corpus_size=1, chunks_override=0,
        )
        assert n_chunks == 1
        assert len(plan) == 1
        assert plan[0][2] == [0]

    def test_total_coverage_per_cell(self):
        # Property test: for any (grid_size, corpus_size, chunks),
        # the union of indices for any cell equals range(corpus_size).
        for corpus_size in [10, 50, 80, 100, 250, 500, 999]:
            for chunks in [0, 1, 3, 7, 13]:
                _n, _cs, plan = _compute_chunk_plan(
                    grid_size=2, corpus_size=corpus_size, chunks_override=chunks,
                )
                cell_0_union = set()
                cell_1_union = set()
                for cell_idx, _ci, indices in plan:
                    if cell_idx == 0:
                        cell_0_union.update(indices)
                    else:
                        cell_1_union.update(indices)
                expected = set(range(corpus_size))
                assert cell_0_union == expected, (
                    f"corpus={corpus_size} chunks={chunks} cell_0 missing: "
                    f"{expected - cell_0_union}"
                )
                assert cell_1_union == expected


def test_cell_record_includes_chunkWalls(monkeypatch):
    """Cell record schema must include chunkWalls: List[int] per Phase 14 Task 1."""
    from sweep_app import _build_cell_record

    # Mock the Node subprocess so the test doesn't need /repo or node installed.
    def _fake_subprocess_run(*args, **kwargs):
        class _FakeProc:
            stdout = '{"metrics": {"mrr": 0.5, "coverage": 0.8, "n": 10, "n_scored": 8, "n_skipped": 2}, "aggStats": {"mean": 0.5}}\n'
        return _FakeProc()
    monkeypatch.setattr("subprocess.run", _fake_subprocess_run)

    # Arrange: synthesise three chunk results with distinct wallMs values
    cell_chunks = [
        (0, {"overrides": {"X": 1}, "runs": [], "wallMs": 1500}),
        (1, {"overrides": {"X": 1}, "runs": [], "wallMs": 2300}),
        (2, {"overrides": {"X": 1}, "runs": [], "wallMs": 1800}),
    ]

    # Act
    record = _build_cell_record(cell_chunks, n_chunks=3)

    # Assert: chunkWalls present and in chunk-index dispatch order
    assert "chunkWalls" in record, "chunkWalls field missing from cell record"
    assert record["chunkWalls"] == [1500, 2300, 1800], (
        f"chunkWalls dispatch order mismatch: {record['chunkWalls']}"
    )

    # Assert: wallMs preserved for backward compat (cell wall = max chunk wall)
    assert record["wallMs"] == 2300, (
        f"wallMs backward-compat mismatch: expected 2300, got {record['wallMs']}"
    )

    # Assert: other expected fields present
    assert record["overrides"] == {"X": 1}
    assert record["chunksRun"] == 3
    assert record["totalChunks"] == 3
    assert record["runCount"] == 0  # no runs in synthetic chunks
    assert "metrics" in record
    assert "latencyMs" in record
