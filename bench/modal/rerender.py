"""One-shot: re-render 9.5 sweep artifacts using Task 4 renderers.

Back-fills `coverage = n_scored / n` into per-point metrics when only
`n_scored` and `n` are present (pre-Task-4 cached JSON), then invokes
the matching renderer.

Usage:
    python bench/modal/rerender.py <sweep_name> <result.json path> [output.md path]

Example:
    python bench/modal/rerender.py tau \
        docs/bench/runs/2026-04-22T19-06-35Z-tau.json \
        docs/bench/sweeps/2026-04-22-tau-live.md

sweep_name ∈ {tau, bm25, hops, relw, graph, consolidation}
"""

import sys
import types
from pathlib import Path

# Stub the real `modal` package. sweep_app.py imports modal at top level
# and calls modal.App(...), modal.Image.debian_slim(...) at import time;
# this script doesn't need the real package because we only exercise pure
# helpers. We use a real ModuleType with selectively-stubbed attributes
# (not a bare MagicMock) so any sys.modules introspection doesn't fire on
# phantom attributes.
if "modal" not in sys.modules or not hasattr(sys.modules["modal"], "App"):
    _modal = types.ModuleType("modal")

    def _identity_decorator(*args, **kwargs):
        def _wrap(fn):
            return fn
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]
        return _wrap

    from unittest.mock import MagicMock

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

# Path insertion so `from sweep_app import ...` resolves
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sweep_app import (
    render_tau_report,
    render_bm25_report,
    render_graph_report_stub,
    render_consolidation_report_stub,
    render_single_axis_report,
)


def _backfill_coverage(payload):
    """Back-fill coverage into each point's metrics where possible.

    Older per-point JSONs (9.5 pre-Task-4) have n_scored + n but no coverage.
    """
    # tau / bm25 / hops / relw: points under result.points
    for pt in payload.get("result", {}).get("points", []):
        m = pt.get("metrics", {})
        if "coverage" not in m and "n_scored" in m and "n" in m and m["n"] > 0:
            m["coverage"] = m["n_scored"] / m["n"]
    # graph / consolidation: points nested under rounds
    for rnd in payload.get("rounds", []):
        for pt in rnd.get("points", []):
            m = pt.get("metrics", {})
            if "coverage" not in m and "n_scored" in m and "n" in m and m["n"] > 0:
                m["coverage"] = m["n_scored"] / m["n"]


def main():
    if len(sys.argv) < 3:
        print("Usage: rerender.py <sweep_name> <result.json> [output.md]", file=sys.stderr)
        sys.exit(2)

    sweep_name, input_path = sys.argv[1], sys.argv[2]
    output_path = sys.argv[3] if len(sys.argv) >= 4 else None

    with open(input_path) as f:
        payload = json.load(f)

    _backfill_coverage(payload)

    corpus_len = payload.get("corpus_len", payload.get("corpusStats", {}).get("corpus_len", 0))
    qa_count = payload.get("qa_count", payload.get("corpusStats", {}).get("qa_count", 0))
    tags_stats = payload.get("tags_stats")

    if sweep_name == "tau":
        out = render_tau_report(payload["result"], corpus_len, qa_count)
    elif sweep_name == "bm25":
        out = render_bm25_report(payload["result"], corpus_len, qa_count, tags_stats)
    elif sweep_name in ("hops", "relw"):
        out = render_single_axis_report(payload["result"], corpus_len, qa_count)
    elif sweep_name == "graph":
        out = render_graph_report_stub(payload)
    elif sweep_name == "consolidation":
        out = render_consolidation_report_stub(payload)
    else:
        print(f"Unknown sweep_name: {sweep_name!r}", file=sys.stderr)
        sys.exit(2)

    if output_path:
        Path(output_path).write_text(out)
        print(f"Wrote {output_path}", file=sys.stderr)
    else:
        print(out)


if __name__ == "__main__":
    import json
    main()
