"""Phase 12 Task 6: stratified_longmemeval_indices() tests.

Validates the deterministic stratified sampler that picks N items from
the LongMemEval-S corpus balanced across the 6 question_type task types.
See docs/plans/phase-12-task-6-extraction-cost-decision.md.
"""
import json
import sys
import tempfile
import types
from collections import Counter
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Stub the real `modal` package. sweep_app.py imports modal at top level
# and calls modal.App(...), modal.Image.debian_slim(...) at import time;
# see test_corpus_param.py for the same pattern. We use a real
# ModuleType with selectively-stubbed attributes (not a bare MagicMock)
# so pytest's sys.modules introspection doesn't trip on phantom attrs.
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

from sweep_app import stratified_longmemeval_indices


# --- Fixtures -----------------------------------------------------------

TASK_TYPES = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "temporal-reasoning",
    "knowledge-update",
    "multi-session",
]


def _synthetic_corpus(per_type_count: int = 100) -> list:
    """6 task types × per_type_count items each = 600 items default."""
    corpus = []
    for qt in TASK_TYPES:
        for j in range(per_type_count):
            corpus.append({
                "question_id": f"{qt}-{j}",
                "question_type": qt,
                "question": f"Q{j}",
                "answer": f"A{j}",
            })
    return corpus


def _write_corpus_to_tmp(corpus: list, tmp_path) -> str:
    p = tmp_path / "longmemeval_s_cleaned.json"
    p.write_text(json.dumps(corpus))
    return str(p)


# --- Determinism --------------------------------------------------------

def test_same_seed_same_indices(tmp_path):
    """Same (corpus, n, seed) always produces identical indices."""
    corpus = _synthetic_corpus()
    path = _write_corpus_to_tmp(corpus, tmp_path)

    a = stratified_longmemeval_indices(path, n=50, seed=2026)
    b = stratified_longmemeval_indices(path, n=50, seed=2026)
    assert a == b


def test_different_seeds_different_indices(tmp_path):
    """Seeds produce distinct shufflings (with overwhelming probability)."""
    corpus = _synthetic_corpus()
    path = _write_corpus_to_tmp(corpus, tmp_path)

    a = stratified_longmemeval_indices(path, n=50, seed=2026)
    b = stratified_longmemeval_indices(path, n=50, seed=9999)
    assert a != b


def test_returned_list_is_sorted(tmp_path):
    """Return value sorted ascending for stable fan-out ordering."""
    corpus = _synthetic_corpus()
    path = _write_corpus_to_tmp(corpus, tmp_path)

    picked = stratified_longmemeval_indices(path, n=50, seed=2026)
    assert picked == sorted(picked)


# --- Balance -----------------------------------------------------------

def test_even_split_across_types_at_n50(tmp_path):
    """n=50 across 6 balanced types: each type gets 8 or 9 picks."""
    corpus = _synthetic_corpus()
    path = _write_corpus_to_tmp(corpus, tmp_path)

    picked = stratified_longmemeval_indices(path, n=50, seed=2026)
    types_picked = Counter(corpus[i]["question_type"] for i in picked)

    assert len(picked) == 50
    assert set(types_picked.keys()) == set(TASK_TYPES)
    for qt, count in types_picked.items():
        assert count in (8, 9), f"{qt}: expected 8 or 9 picks, got {count}"


def test_exact_divisor_gives_perfect_balance(tmp_path):
    """n=60 across 6 types: exactly 10 picks per type."""
    corpus = _synthetic_corpus()
    path = _write_corpus_to_tmp(corpus, tmp_path)

    picked = stratified_longmemeval_indices(path, n=60, seed=2026)
    types_picked = Counter(corpus[i]["question_type"] for i in picked)
    assert all(count == 10 for count in types_picked.values())


def test_full_corpus_returns_all_indices(tmp_path):
    """n == len(corpus): returns every index, sorted."""
    corpus = _synthetic_corpus(per_type_count=10)  # 60 items total
    path = _write_corpus_to_tmp(corpus, tmp_path)

    picked = stratified_longmemeval_indices(path, n=60, seed=2026)
    assert picked == list(range(60))


# --- Boundary and error cases ------------------------------------------

def test_n_too_large_raises(tmp_path):
    """n > len(corpus) raises ValueError with a helpful message."""
    corpus = _synthetic_corpus(per_type_count=10)  # 60 items
    path = _write_corpus_to_tmp(corpus, tmp_path)

    with pytest.raises(ValueError, match="exceeds corpus size"):
        stratified_longmemeval_indices(path, n=61, seed=2026)


def test_n_zero_raises(tmp_path):
    """n < 1 rejected; we don't emit an empty list silently."""
    corpus = _synthetic_corpus()
    path = _write_corpus_to_tmp(corpus, tmp_path)

    with pytest.raises(ValueError, match="must be >= 1"):
        stratified_longmemeval_indices(path, n=0, seed=2026)


def test_missing_question_type_raises(tmp_path):
    """Corrupt corpus (missing question_type) fails loudly, not silently."""
    corpus = _synthetic_corpus(per_type_count=5)
    corpus[7].pop("question_type")
    path = _write_corpus_to_tmp(corpus, tmp_path)

    with pytest.raises(ValueError, match="missing question_type"):
        stratified_longmemeval_indices(path, n=10, seed=2026)


def test_unbalanced_corpus_takes_available(tmp_path):
    """One type under-represented: picks what's available, spills to others."""
    corpus = []
    # Only 2 items of first type; 100 each of the rest.
    for j in range(2):
        corpus.append({"question_id": f"a-{j}", "question_type": TASK_TYPES[0]})
    for qt in TASK_TYPES[1:]:
        for j in range(100):
            corpus.append({"question_id": f"{qt}-{j}", "question_type": qt})
    path = _write_corpus_to_tmp(corpus, tmp_path)

    picked = stratified_longmemeval_indices(path, n=50, seed=2026)
    types_picked = Counter(corpus[i]["question_type"] for i in picked)

    assert len(picked) == 50
    # Under-represented type exhausts at 2 picks.
    assert types_picked[TASK_TYPES[0]] == 2
    # The remaining 48 picks distribute across the other 5 types.
    assert sum(v for k, v in types_picked.items() if k != TASK_TYPES[0]) == 48
